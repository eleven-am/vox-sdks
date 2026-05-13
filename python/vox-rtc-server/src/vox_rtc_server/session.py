from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping
from typing import Any

from .types import (
    ChannelState,
    ClientEventEnvelope,
    ResponseOptions,
    SessionConfig,
    SocketChannelLike,
    Unsubscribe,
    WireEvent,
)


def _state_value(state: Any) -> str:
    return str(getattr(state, "value", state))


def _payload_dict(payload: Any) -> dict[str, Any]:
    if payload is None:
        return {}
    if isinstance(payload, dict):
        return dict(payload)
    if isinstance(payload, Mapping):
        return dict(payload)
    return {"payload": payload}


def _response_options_payload(options: ResponseOptions | None) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    if options is not None and options.allow_interruptions is not None:
        payload["allow_interruptions"] = options.allow_interruptions
    return payload


class VoxRtcControlSession:
    __slots__ = ("_channel", "_channel_name", "_join_timeout", "_session_id")

    def __init__(
        self,
        channel: SocketChannelLike,
        session_id: str,
        *,
        join_timeout: float = 10.0,
    ) -> None:
        self._channel = channel
        self._session_id = session_id
        self._channel_name = f"/rtc/{session_id}"
        self._join_timeout = join_timeout

    @property
    def session_id(self) -> str:
        return self._session_id

    @property
    def channel_name(self) -> str:
        return self._channel_name

    async def join(self) -> None:
        loop = asyncio.get_running_loop()
        done: asyncio.Future[None] = loop.create_future()

        def handle_state(state: Any) -> None:
            value = _state_value(state)
            if value == ChannelState.JOINED.value and not done.done():
                done.set_result(None)
            elif value in (ChannelState.DECLINED.value, ChannelState.CLOSED.value) and not done.done():
                done.set_exception(
                    RuntimeError(f"RTC channel join failed for {self._channel_name}: {value}")
                )

        unsubscribe = self._channel.on_channel_state_change(handle_state)
        try:
            self._channel.join()
            await asyncio.wait_for(done, timeout=self._join_timeout)
        finally:
            unsubscribe()

    def close(self) -> None:
        self._channel.leave()

    def on_event(self, handler: Callable[[WireEvent], None]) -> Unsubscribe:
        def callback(message: Any) -> None:
            handler(
                WireEvent(
                    type=str(getattr(message, "event", "")),
                    data=_payload_dict(getattr(message, "payload", None)),
                )
            )

        return self._channel.on_message(callback)

    def on(self, event_name: str, handler: Callable[[dict[str, Any]], None]) -> Unsubscribe:
        def callback(message: Any) -> None:
            handler(_payload_dict(getattr(message, "payload", None)))

        return self._channel.on_message_event(event_name, callback)

    def send_control(self, event: str, payload: Mapping[str, Any] | None = None) -> None:
        self._channel.send_message(event, dict(payload or {}))

    def configure(self, config: SessionConfig) -> None:
        session: dict[str, Any] = dict(config.extra)
        if config.stt_model is not None:
            session["stt_model"] = config.stt_model
        if config.tts_model is not None:
            session["tts_model"] = config.tts_model
        if config.voice is not None:
            session["voice"] = config.voice
        if config.turn_profile is not None:
            session["turn_profile"] = config.turn_profile
        if config.vad_backend is not None:
            session["vad_backend"] = config.vad_backend
        if config.turn_detector is not None:
            session["turn_detector"] = config.turn_detector
        self.send_control("session.update", {"session": session})

    def start_response(self, options: ResponseOptions | None = None) -> None:
        self.send_control("response.start", _response_options_payload(options))

    def append_response_text(
        self,
        delta: str,
        options: ResponseOptions | None = None,
    ) -> None:
        payload = _response_options_payload(options)
        payload["delta"] = delta
        self.send_control("response.delta", payload)

    def commit_response(self) -> None:
        self.send_control("response.commit")

    def cancel_response(self) -> None:
        self.send_control("response.cancel")

    def replace_response_text(
        self,
        text: str,
        options: ResponseOptions | None = None,
    ) -> None:
        payload = _response_options_payload(options)
        payload["text"] = text
        self.send_control("response.replace_text", payload)

    def send_text_response(
        self,
        text: str,
        options: ResponseOptions | None = None,
        *,
        cancel_first: bool = True,
    ) -> None:
        if cancel_first:
            self.replace_response_text(text, options)
            return
        self.start_response(options)
        self.append_response_text(text, options)
        self.commit_response()

    def send_client_event(self, envelope: ClientEventEnvelope) -> None:
        self.send_control(
            "client.event",
            {"event": envelope.event, "payload": envelope.payload},
        )
