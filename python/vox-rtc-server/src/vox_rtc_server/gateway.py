from __future__ import annotations

import asyncio
import inspect
import json
from collections.abc import Awaitable, Callable, Mapping, MutableMapping
from dataclasses import dataclass
from typing import Any, TypeAlias

from .client import VoxRtcServerClient
from .session import VoxRtcControlSession
from .types import ERROR_CODE_COMMAND_INVALID, SessionBootstrap, Unsubscribe, WireEvent

AsgiScope: TypeAlias = MutableMapping[str, Any]
AsgiReceive: TypeAlias = Callable[[], Awaitable[dict[str, Any]]]
AsgiSend: TypeAlias = Callable[[dict[str, Any]], Awaitable[None]]
GatewayHook: TypeAlias = Callable[["GatewaySessionContext"], Any]
GatewayClosedHook: TypeAlias = Callable[["GatewayClosedContext"], Any]


@dataclass(frozen=True, slots=True)
class GatewaySessionContext:
    scope: AsgiScope
    session: VoxRtcControlSession


@dataclass(frozen=True, slots=True)
class GatewayClosedContext(GatewaySessionContext):
    reason: str


class GatewayCommandError(ValueError):
    code = ERROR_CODE_COMMAND_INVALID


@dataclass(slots=True)
class _ActiveSession:
    context: GatewaySessionContext
    unsubscribe: Unsubscribe
    events: asyncio.Queue[WireEvent | None]
    pending_offer_id: str | None = None
    generated_offer: bool = False
    rtc_close_requested: bool = False
    closed: bool = False


def _normalize_path(path: str) -> str:
    normalized = "/" + path.strip("/")
    return normalized if normalized != "" else "/"


def _generation(
    data: Mapping[str, Any], *, command: str, required: bool
) -> int | None:
    if "generation" not in data:
        if required:
            raise GatewayCommandError(
                f"{command} requires generation for a generated RTC negotiation"
            )
        return None
    value = data["generation"]
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value < 1
        or value > 9_007_199_254_740_991
    ):
        raise GatewayCommandError(
            f"{command} generation must be a positive safe integer"
        )
    return value


def _client_message(text: str) -> tuple[str, str, dict[str, Any]]:
    try:
        value = json.loads(text)
    except json.JSONDecodeError as error:
        raise ValueError("RTC gateway message must be valid JSON") from error
    if not isinstance(value, dict):
        raise ValueError("RTC gateway message must be an object")
    message_id = value.get("id")
    event_type = value.get("type")
    data = value.get("data")
    if (
        not isinstance(message_id, str)
        or not message_id.strip()
        or not isinstance(event_type, str)
        or not event_type.strip()
        or not isinstance(data, dict)
    ):
        raise ValueError("RTC gateway message requires id, type, and object data")
    return message_id.strip(), event_type.strip(), data


def _offer(value: Any) -> dict[str, Any]:
    if (
        not isinstance(value, dict)
        or value.get("type") != "offer"
        or not isinstance(value.get("sdp"), str)
        or not value["sdp"].strip()
    ):
        raise ValueError("rtc.offer requires a non-empty SDP offer")
    return {"type": "offer", "sdp": value["sdp"]}


def _candidate(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict) or not isinstance(value.get("candidate"), str):
        raise ValueError("rtc.ice_candidate requires a candidate object or null")
    return {
        "candidate": value["candidate"],
        "sdpMid": value.get("sdpMid")
        if isinstance(value.get("sdpMid"), str)
        else None,
        "sdpMLineIndex": value.get("sdpMLineIndex")
        if isinstance(value.get("sdpMLineIndex"), int)
        and not isinstance(value.get("sdpMLineIndex"), bool)
        else None,
        "usernameFragment": value.get("usernameFragment")
        if isinstance(value.get("usernameFragment"), str)
        else None,
    }


class VoxRtcGateway:
    """ASGI WebSocket gateway for ``VoxRtcBrowserClient``.

    Mount this application at ``path`` in any ASGI server. One accepted browser
    socket owns one private controlled Vox session for its entire lifetime.
    """

    def __init__(
        self,
        *,
        http_base: str,
        api_key: str | None = None,
        path: str = "/api/vox/rtc",
        on_session_created: GatewayHook | None = None,
        on_session_closed: GatewayClosedHook | None = None,
        on_error: Callable[[BaseException], Any] | None = None,
        client: VoxRtcServerClient | None = None,
    ) -> None:
        self._path = _normalize_path(path)
        self._client = client or VoxRtcServerClient(
            http_base=http_base, api_key=api_key
        )
        self._on_session_created = on_session_created
        self._on_session_closed = on_session_closed
        self._on_error = on_error
        self._active: set[int] = set()
        self._sessions: dict[int, _ActiveSession] = {}
        self._closing = False
        self._shutdown_reason: str | None = None
        self._close_event = asyncio.Event()

    async def __call__(
        self, scope: AsgiScope, receive: AsgiReceive, send: AsgiSend
    ) -> None:
        if scope.get("type") == "lifespan":
            await self._lifespan(receive, send)
            return
        if scope.get("type") != "websocket" or scope.get("path") != self._path:
            if scope.get("type") == "websocket":
                await send({"type": "websocket.close", "code": 1008})
            return
        if self._closing:
            await send({"type": "websocket.close", "code": 1013})
            return
        await self._serve(scope, receive, send)

    async def close(self, reason: str = "gateway_shutdown") -> None:
        if self._closing:
            await self._close_event.wait()
            return
        self._closing = True
        self._shutdown_reason = reason
        sessions = list(self._sessions.values())
        for active in sessions:
            await self._close_session(active, reason)
            active.events.put_nowait(None)
        await self._client.disconnect()
        self._close_event.set()

    async def _serve(
        self, scope: AsgiScope, receive: AsgiReceive, send: AsgiSend
    ) -> None:
        first = await receive()
        if first.get("type") != "websocket.connect":
            return
        await send({"type": "websocket.accept"})
        active: _ActiveSession | None = None
        session: VoxRtcControlSession | None = None
        receive_task: asyncio.Task[dict[str, Any]] | None = None
        event_task: asyncio.Task[WireEvent | None] | None = None
        try:
            bootstrap, session = await self._client.create_controlled_session()
            if self._closing:
                session.close_rtc(self._shutdown_reason or "gateway_shutdown")
                session.close()
                session = None
                await send({"type": "websocket.close", "code": 1001})
                return
            loop = asyncio.get_running_loop()
            events: asyncio.Queue[WireEvent | None] = asyncio.Queue()

            def forward(event: WireEvent) -> None:
                loop.call_soon_threadsafe(events.put_nowait, event)

            active = _ActiveSession(
                context=GatewaySessionContext(scope=scope, session=session),
                unsubscribe=session.on_event(forward),
                events=events,
            )
            key = id(active)
            self._active.add(key)
            self._sessions[key] = active
            try:
                await self._call_hook(self._on_session_created, active.context)
            except BaseException as error:
                self._report_error(error)
                await self._send_error(send, None, error)
                await self._close_session(active, "session_created_hook_failed")
                await send({"type": "websocket.close", "code": 1011})
                return
            await self._send(send, "gateway.ready", self._bootstrap(bootstrap))

            while not active.closed:
                receive_task = asyncio.ensure_future(receive())
                event_task = asyncio.create_task(events.get())
                done, pending = await asyncio.wait(
                    {receive_task, event_task}, return_when=asyncio.FIRST_COMPLETED
                )
                for task in pending:
                    task.cancel()
                await asyncio.gather(*pending, return_exceptions=True)
                if receive_task in done:
                    message = receive_task.result()
                    if message.get("type") == "websocket.disconnect":
                        break
                    if message.get("type") != "websocket.receive":
                        continue
                    text = message.get("text")
                    if not isinstance(text, str):
                        await self._send_error(
                            send, None, ValueError("RTC gateway accepts text JSON only")
                        )
                        continue
                    await self._handle_message(active, text, send)
                elif event_task in done:
                    event = event_task.result()
                    if event is None:
                        break
                    await self._forward_event(active, event, send)
                    if event.type == "rtc.session.closed":
                        await send({"type": "websocket.close", "code": 1000})
                        break
        except BaseException as error:
            if not isinstance(error, asyncio.CancelledError):
                self._report_error(error)
                try:
                    await send({"type": "websocket.close", "code": 1011})
                except BaseException:
                    pass
            else:
                raise
        finally:
            if receive_task is not None and not receive_task.done():
                receive_task.cancel()
            if event_task is not None and not event_task.done():
                event_task.cancel()
            if active is not None:
                await self._close_session(active, "browser_disconnected")
            elif session is not None:
                try:
                    session.close_rtc("gateway_setup_failed")
                    session.close()
                except BaseException as error:
                    self._report_error(error)

    async def _handle_message(
        self, active: _ActiveSession, text: str, send: AsgiSend
    ) -> None:
        request_id: str | None = None
        try:
            request_id, event_type, data = _client_message(text)
            if event_type == "rtc.offer":
                if active.pending_offer_id is not None:
                    raise ValueError("An RTC offer is already pending")
                generation = _generation(
                    data, command="rtc.offer", required=False
                )
                active.pending_offer_id = request_id
                active.context.session.send_offer(
                    _offer(data.get("offer")),
                    restart=data.get("restart") is True,
                    generation=generation,
                )
                active.generated_offer = generation is not None
                return
            if event_type == "rtc.ice_candidate":
                generation = _generation(
                    data,
                    command="rtc.ice_candidate",
                    required=active.generated_offer,
                )
                active.context.session.send_ice_candidate(
                    _candidate(data.get("candidate")), generation=generation
                )
                return
            if event_type == "rtc.close":
                active.rtc_close_requested = True
                reason = data.get("reason")
                active.context.session.close_rtc(
                    reason if isinstance(reason, str) else "client_closed"
                )
                return
            raise ValueError(f"Unsupported RTC gateway message type: {event_type}")
        except (TypeError, ValueError) as error:
            if request_id == active.pending_offer_id:
                active.pending_offer_id = None
            await self._send_error(send, request_id, error)

    async def _forward_event(
        self, active: _ActiveSession, event: WireEvent, send: AsgiSend
    ) -> None:
        correlates = event.type in {"rtc.answer", "rtc.signaling_error"}
        request_id = active.pending_offer_id if correlates else None
        if correlates:
            active.pending_offer_id = None
        await self._send(send, event.type, event.data or {}, request_id)
        if event.type == "rtc.session.closed":
            active.rtc_close_requested = True
            reason = event.data.get("reason", "session_closed")
            await self._close_session(active, str(reason))

    async def _close_session(self, active: _ActiveSession, reason: str) -> None:
        if active.closed:
            return
        active.closed = True
        try:
            active.unsubscribe()
            if not active.rtc_close_requested:
                active.rtc_close_requested = True
                active.context.session.close_rtc(reason)
            active.context.session.close()
            await self._call_hook(
                self._on_session_closed,
                GatewayClosedContext(
                    scope=active.context.scope,
                    session=active.context.session,
                    reason=reason,
                ),
            )
        except BaseException as error:
            self._report_error(error)
        finally:
            key = id(active)
            self._active.discard(key)
            self._sessions.pop(key, None)

    async def _lifespan(self, receive: AsgiReceive, send: AsgiSend) -> None:
        while True:
            message = await receive()
            if message["type"] == "lifespan.startup":
                await send({"type": "lifespan.startup.complete"})
            elif message["type"] == "lifespan.shutdown":
                await self.close()
                await send({"type": "lifespan.shutdown.complete"})
                return

    async def _call_hook(self, hook: Callable[[Any], Any] | None, value: Any) -> None:
        if hook is None:
            return
        result = hook(value)
        if inspect.isawaitable(result):
            await result

    @staticmethod
    def _bootstrap(bootstrap: SessionBootstrap) -> dict[str, Any]:
        return {
            "session": {
                "sessionId": bootstrap.session_id,
                "expiresAt": bootstrap.expires_at,
                "attachTtlSeconds": bootstrap.attach_ttl_seconds,
                "iceServers": [
                    {
                        "urls": server.urls,
                        **(
                            {"username": server.username}
                            if server.username is not None
                            else {}
                        ),
                        **(
                            {"credential": server.credential}
                            if server.credential is not None
                            else {}
                        ),
                    }
                    for server in bootstrap.ice_servers
                ],
            }
        }

    @staticmethod
    async def _send(
        send: AsgiSend,
        event_type: str,
        data: Mapping[str, Any],
        request_id: str | None = None,
    ) -> None:
        payload = {"type": event_type, "data": dict(data)}
        if request_id:
            payload["id"] = request_id
        await send(
            {
                "type": "websocket.send",
                "text": json.dumps(payload, separators=(",", ":")),
            }
        )

    @classmethod
    async def _send_error(
        cls, send: AsgiSend, request_id: str | None, error: BaseException
    ) -> None:
        data: dict[str, Any] = {"message": str(error)}
        if isinstance(error, GatewayCommandError):
            data["code"] = error.code
        await cls._send(send, "gateway.error", data, request_id)

    def _report_error(self, error: BaseException) -> None:
        if self._on_error is None:
            return
        try:
            self._on_error(error)
        except BaseException:
            pass
