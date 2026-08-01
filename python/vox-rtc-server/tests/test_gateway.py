from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from vox_rtc_server import RTCIceServer, SessionBootstrap, VoxRtcGateway, WireEvent


class FakeSession:
    def __init__(self) -> None:
        self.session_id = "rtc_gateway"
        self.handlers: set[Any] = set()
        self.sent: list[tuple[str, dict[str, Any]]] = []
        self.close_calls = 0

    def on_event(self, handler: Any) -> Any:
        self.handlers.add(handler)
        return lambda: self.handlers.discard(handler)

    def send_offer(
        self,
        offer: dict[str, Any],
        *,
        restart: bool = False,
        generation: int | None = None,
    ) -> None:
        self.sent.append(
            (
                "rtc.offer",
                {"offer": offer, "restart": restart, "generation": generation},
            )
        )

    def send_ice_candidate(
        self,
        candidate: dict[str, Any] | None,
        *,
        generation: int | None = None,
    ) -> None:
        self.sent.append(
            ("rtc.ice_candidate", {"candidate": candidate, "generation": generation})
        )

    def close_rtc(self, reason: str) -> None:
        self.sent.append(("rtc.close", {"reason": reason}))

    def close(self) -> None:
        self.close_calls += 1

    def emit(self, event_type: str, data: dict[str, Any]) -> None:
        event = WireEvent(
            type=event_type,
            data=data,
            session_id=self.session_id,
            channel_name=f"/rtc/{self.session_id}",
        )
        for handler in list(self.handlers):
            handler(event)


class FakeClient:
    def __init__(self, session: FakeSession) -> None:
        self.session = session
        self.disconnect_calls = 0

    async def create_controlled_session(self) -> tuple[SessionBootstrap, Any]:
        return (
            SessionBootstrap(
                session_id=self.session.session_id,
                expires_at="2026-08-01T12:00:00Z",
                attach_ttl_seconds=120,
                ice_servers=[RTCIceServer(urls=["stun:turn.test:3478"])],
            ),
            self.session,
        )

    async def disconnect(self) -> None:
        self.disconnect_calls += 1


class DelayedFakeClient(FakeClient):
    def __init__(self, session: FakeSession) -> None:
        super().__init__(session)
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def create_controlled_session(self) -> tuple[SessionBootstrap, Any]:
        self.started.set()
        await self.release.wait()
        return await super().create_controlled_session()


async def receive_message(queue: asyncio.Queue[dict[str, Any]]) -> dict[str, Any]:
    while True:
        message = await asyncio.wait_for(queue.get(), 1)
        if message["type"] == "websocket.send":
            return json.loads(message["text"])


@pytest.mark.asyncio
async def test_gateway_forwards_generation_and_correlates_answer() -> None:
    session = FakeSession()
    client = FakeClient(session)
    incoming: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    outgoing: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    gateway = VoxRtcGateway(
        http_base="http://vox.internal",
        api_key="must-not-leak",
        client=client,  # type: ignore[arg-type]
    )
    task = asyncio.create_task(
        gateway(
            {"type": "websocket", "path": "/api/vox/rtc", "headers": []},
            incoming.get,
            outgoing.put,
        )
    )
    await incoming.put({"type": "websocket.connect"})
    assert (await outgoing.get())["type"] == "websocket.accept"
    ready = await receive_message(outgoing)
    assert ready["type"] == "gateway.ready"
    assert ready["data"]["session"]["sessionId"] == "rtc_gateway"
    assert "must-not-leak" not in json.dumps(ready)

    await incoming.put(
        {
            "type": "websocket.receive",
            "text": json.dumps(
                {
                    "id": "offer-1",
                    "type": "rtc.offer",
                    "data": {
                        "offer": {"type": "offer", "sdp": "offer-sdp"},
                        "generation": 1,
                    },
                }
            ),
        }
    )
    await incoming.put(
        {
            "type": "websocket.receive",
            "text": json.dumps(
                {
                    "id": "candidate-1",
                    "type": "rtc.ice_candidate",
                    "data": {
                        "candidate": {
                            "candidate": "candidate:first",
                            "sdpMid": "audio",
                            "sdpMLineIndex": 0,
                        },
                        "generation": 1,
                    },
                }
            ),
        }
    )
    await incoming.put(
        {
            "type": "websocket.receive",
            "text": json.dumps(
                {
                    "id": "candidate-complete",
                    "type": "rtc.ice_candidate",
                    "data": {"candidate": None, "generation": 1},
                }
            ),
        }
    )
    while len(session.sent) < 3:
        await asyncio.sleep(0)
    assert session.sent[0][1]["generation"] == 1
    assert session.sent[1][1]["generation"] == 1
    assert session.sent[1][1]["candidate"]["sdpMLineIndex"] == 0
    assert session.sent[2][1] == {"candidate": None, "generation": 1}

    session.emit(
        "rtc.answer",
        {
            "answer": {"type": "answer", "sdp": "answer-sdp"},
            "generation": 1,
        },
    )
    answer = await receive_message(outgoing)
    assert answer["id"] == "offer-1"
    assert answer["data"]["generation"] == 1

    await incoming.put({"type": "websocket.disconnect", "code": 1000})
    await task
    assert session.close_calls == 1
    assert session.sent[-1][0] == "rtc.close"


@pytest.mark.asyncio
async def test_generated_negotiation_rejects_missing_candidate_generation() -> None:
    session = FakeSession()
    incoming: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    outgoing: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    gateway = VoxRtcGateway(
        http_base="http://vox.internal",
        client=FakeClient(session),  # type: ignore[arg-type]
    )
    task = asyncio.create_task(
        gateway(
            {"type": "websocket", "path": "/api/vox/rtc"},
            incoming.get,
            outgoing.put,
        )
    )
    await incoming.put({"type": "websocket.connect"})
    await outgoing.get()
    await receive_message(outgoing)
    await incoming.put(
        {
            "type": "websocket.receive",
            "text": json.dumps(
                {
                    "id": "offer",
                    "type": "rtc.offer",
                    "data": {
                        "offer": {"type": "offer", "sdp": "sdp"},
                        "generation": 2,
                    },
                }
            ),
        }
    )
    while not session.sent:
        await asyncio.sleep(0)
    await incoming.put(
        {
            "type": "websocket.receive",
            "text": json.dumps(
                {
                    "id": "candidate",
                    "type": "rtc.ice_candidate",
                    "data": {"candidate": None},
                }
            ),
        }
    )
    error = await receive_message(outgoing)
    assert error == {
        "id": "candidate",
        "type": "gateway.error",
        "data": {
            "message": (
                "rtc.ice_candidate requires generation for a generated "
                "RTC negotiation"
            ),
            "code": "command_invalid",
        },
    }
    assert len(session.sent) == 1
    await incoming.put({"type": "websocket.disconnect"})
    await task


@pytest.mark.asyncio
async def test_gateway_shutdown_wakes_socket_and_closes_once() -> None:
    session = FakeSession()
    client = FakeClient(session)
    incoming: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    outgoing: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    gateway = VoxRtcGateway(
        http_base="http://vox.internal",
        client=client,  # type: ignore[arg-type]
    )
    task = asyncio.create_task(
        gateway(
            {"type": "websocket", "path": "/api/vox/rtc"},
            incoming.get,
            outgoing.put,
        )
    )
    await incoming.put({"type": "websocket.connect"})
    await outgoing.get()
    await receive_message(outgoing)

    await gateway.close("test_shutdown")
    await asyncio.wait_for(task, 1)
    assert session.close_calls == 1
    assert session.sent[-1] == ("rtc.close", {"reason": "test_shutdown"})
    assert client.disconnect_calls == 1


@pytest.mark.asyncio
async def test_shutdown_during_session_creation_closes_eventual_session_once() -> None:
    session = FakeSession()
    client = DelayedFakeClient(session)
    incoming: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    outgoing: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    gateway = VoxRtcGateway(
        http_base="http://vox.internal",
        client=client,  # type: ignore[arg-type]
    )
    task = asyncio.create_task(
        gateway(
            {"type": "websocket", "path": "/api/vox/rtc"},
            incoming.get,
            outgoing.put,
        )
    )
    await incoming.put({"type": "websocket.connect"})
    await outgoing.get()
    await client.started.wait()
    await gateway.close("test_shutdown")
    client.release.set()
    await asyncio.wait_for(task, 1)

    assert session.close_calls == 1
    assert session.sent == [("rtc.close", {"reason": "test_shutdown"})]
