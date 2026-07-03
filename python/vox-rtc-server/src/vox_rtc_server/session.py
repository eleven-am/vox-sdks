from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping
from typing import Any

from .types import (
    BrowserEvent,
    ChannelState,
    ClientEventEnvelope,
    CloseEvent,
    ErrorEvent,
    InterruptionEvent,
    ResponseOptions,
    ResponseEvent,
    SessionConfig,
    SessionAttachedEvent,
    SessionCreatedEvent,
    SocketChannelLike,
    SpeechEvent,
    TranscriptDeltaEvent,
    TranscriptEvent,
    TurnEouPredictedEvent,
    TurnStateEvent,
    Unsubscribe,
    WireEvent,
)

EVT_CLOSE = "rtc.client.disconnected"
EVT_BROWSER_EVENT = "browser.event"
EVT_ERROR = "error"
EVT_INTERRUPTION_DETECTED = "interruption.detected"
EVT_INTERRUPTION_FALSE_POSITIVE = "interruption.false_positive"
EVT_RESPONSE_AUDIO_CLEAR = "response.audio.clear"
EVT_RESPONSE_CANCELLED = "response.cancelled"
EVT_RESPONSE_COMMITTED = "response.committed"
EVT_RESPONSE_CREATED = "response.created"
EVT_RESPONSE_DONE = "response.done"
EVT_RTC_SESSION_ATTACHED = "rtc.session.attached"
EVT_SESSION_CREATED = "session.created"
EVT_SPEECH_STARTED = "input_audio_buffer.speech_started"
EVT_SPEECH_STOPPED = "input_audio_buffer.speech_stopped"
EVT_TRANSCRIPT_COMPLETED = "conversation.item.input_audio_transcription.completed"
EVT_TRANSCRIPT_DELTA = "conversation.item.input_audio_transcription.delta"
EVT_TURN_EOU_PREDICTED = "turn.eou.predicted"
EVT_TURN_STATE_CHANGED = "turn.state_changed"


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


def _optional_str(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _required_str(value: Any, fallback: str = "") -> str:
    return value if isinstance(value, str) and value else fallback


def _optional_number(value: Any) -> int | float | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _optional_str_list(value: Any) -> list[str] | None:
    if not isinstance(value, list):
        return None
    if not all(isinstance(item, str) for item in value):
        return None
    return list(value)


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
                    session_id=self._session_id,
                    channel_name=self._channel_name,
                )
            )

        return self._channel.on_message(callback)

    def on(self, event_name: str, handler: Callable[[dict[str, Any]], None]) -> Unsubscribe:
        def callback(message: Any) -> None:
            handler(_payload_dict(getattr(message, "payload", None)))

        return self._channel.on_message_event(event_name, callback)

    def on_session_attached(
        self,
        handler: Callable[[SessionAttachedEvent], None],
    ) -> Unsubscribe:
        return self.on(
            EVT_RTC_SESSION_ATTACHED,
            lambda payload: handler(
                SessionAttachedEvent(
                    session_id=_required_str(payload.get("session_id"), self._session_id),
                    channel_name=self._channel_name,
                    data=payload,
                )
            ),
        )

    def on_session_created(
        self,
        handler: Callable[[SessionCreatedEvent], None],
    ) -> Unsubscribe:
        def emit(payload: dict[str, Any]) -> None:
            session = payload.get("session")
            handler(
                SessionCreatedEvent(
                    session_id=_required_str(payload.get("session_id"), self._session_id),
                    channel_name=self._channel_name,
                    data=payload,
                    session=dict(session) if isinstance(session, Mapping) else None,
                )
            )

        return self.on(EVT_SESSION_CREATED, emit)

    def on_transcript(
        self,
        handler: Callable[[TranscriptEvent], None],
    ) -> Unsubscribe:
        def emit(payload: dict[str, Any]) -> None:
            handler(
                TranscriptEvent(
                    session_id=_required_str(payload.get("session_id"), self._session_id),
                    channel_name=self._channel_name,
                    data=payload,
                    transcript=_required_str(payload.get("transcript")),
                    language=_optional_str(payload.get("language")),
                    start_ms=_optional_number(payload.get("start_ms")),
                    end_ms=_optional_number(payload.get("end_ms")),
                    eou_probability=_optional_number(payload.get("eou_probability")),
                    topics=_optional_str_list(payload.get("topics")),
                )
            )

        return self.on(EVT_TRANSCRIPT_COMPLETED, emit)

    def on_turn_state_changed(
        self,
        handler: Callable[[TurnStateEvent], None],
    ) -> Unsubscribe:
        def emit(payload: dict[str, Any]) -> None:
            handler(
                TurnStateEvent(
                    session_id=_required_str(payload.get("session_id"), self._session_id),
                    channel_name=self._channel_name,
                    data=payload,
                    state=_required_str(payload.get("state"), "unknown"),
                    previous_state=_optional_str(payload.get("previous_state")),
                )
            )

        return self.on(EVT_TURN_STATE_CHANGED, emit)

    def _on_speech_event(
        self,
        event_name: str,
        handler: Callable[[SpeechEvent], None],
    ) -> Unsubscribe:
        def emit(payload: dict[str, Any]) -> None:
            handler(
                SpeechEvent(
                    session_id=_required_str(payload.get("session_id"), self._session_id),
                    channel_name=self._channel_name,
                    data=payload,
                    timestamp_ms=_optional_number(payload.get("timestamp_ms")),
                )
            )

        return self.on(event_name, emit)

    def on_speech_started(self, handler: Callable[[SpeechEvent], None]) -> Unsubscribe:
        return self._on_speech_event(EVT_SPEECH_STARTED, handler)

    def on_speech_stopped(self, handler: Callable[[SpeechEvent], None]) -> Unsubscribe:
        return self._on_speech_event(EVT_SPEECH_STOPPED, handler)

    def on_transcript_delta(
        self,
        handler: Callable[[TranscriptDeltaEvent], None],
    ) -> Unsubscribe:
        def emit(payload: dict[str, Any]) -> None:
            handler(
                TranscriptDeltaEvent(
                    session_id=_required_str(payload.get("session_id"), self._session_id),
                    channel_name=self._channel_name,
                    data=payload,
                    delta=_required_str(payload.get("delta")),
                    start_ms=_optional_number(payload.get("start_ms")),
                    end_ms=_optional_number(payload.get("end_ms")),
                )
            )

        return self.on(EVT_TRANSCRIPT_DELTA, emit)

    def on_turn_eou_predicted(
        self,
        handler: Callable[[TurnEouPredictedEvent], None],
    ) -> Unsubscribe:
        def emit(payload: dict[str, Any]) -> None:
            handler(
                TurnEouPredictedEvent(
                    session_id=_required_str(payload.get("session_id"), self._session_id),
                    channel_name=self._channel_name,
                    data=payload,
                    probability=_optional_number(payload.get("probability")),
                    threshold=_optional_number(payload.get("threshold")),
                    delay_ms=_optional_number(payload.get("delay_ms")),
                    start_ms=_optional_number(payload.get("start_ms")),
                    end_ms=_optional_number(payload.get("end_ms")),
                    decision=_optional_str(payload.get("decision")),
                    action=_optional_str(payload.get("action")),
                    turn_detector=_optional_str(payload.get("turn_detector")),
                )
            )

        return self.on(EVT_TURN_EOU_PREDICTED, emit)

    def _on_response_event(
        self,
        event_name: str,
        handler: Callable[[ResponseEvent], None],
    ) -> Unsubscribe:
        def emit(payload: dict[str, Any]) -> None:
            handler(
                ResponseEvent(
                    session_id=_required_str(payload.get("session_id"), self._session_id),
                    channel_name=self._channel_name,
                    data=payload,
                    response_id=_optional_str(payload.get("response_id")),
                )
            )

        return self.on(event_name, emit)

    def on_response_created(self, handler: Callable[[ResponseEvent], None]) -> Unsubscribe:
        return self._on_response_event(EVT_RESPONSE_CREATED, handler)

    def on_response_committed(self, handler: Callable[[ResponseEvent], None]) -> Unsubscribe:
        return self._on_response_event(EVT_RESPONSE_COMMITTED, handler)

    def on_response_done(self, handler: Callable[[ResponseEvent], None]) -> Unsubscribe:
        return self._on_response_event(EVT_RESPONSE_DONE, handler)

    def on_response_cancelled(self, handler: Callable[[ResponseEvent], None]) -> Unsubscribe:
        return self._on_response_event(EVT_RESPONSE_CANCELLED, handler)

    def on_response_audio_clear(self, handler: Callable[[ResponseEvent], None]) -> Unsubscribe:
        return self._on_response_event(EVT_RESPONSE_AUDIO_CLEAR, handler)

    def _on_interruption_event(
        self,
        event_name: str,
        handler: Callable[[InterruptionEvent], None],
    ) -> Unsubscribe:
        def emit(payload: dict[str, Any]) -> None:
            handler(
                InterruptionEvent(
                    session_id=_required_str(payload.get("session_id"), self._session_id),
                    channel_name=self._channel_name,
                    data=payload,
                    response_id=_optional_str(payload.get("response_id")),
                    vad_active_ms=_optional_number(payload.get("vad_active_ms")),
                    partial_transcript=_optional_str(payload.get("partial_transcript")),
                )
            )

        return self.on(event_name, emit)

    def on_interruption_detected(
        self,
        handler: Callable[[InterruptionEvent], None],
    ) -> Unsubscribe:
        return self._on_interruption_event(EVT_INTERRUPTION_DETECTED, handler)

    def on_interruption_false_positive(
        self,
        handler: Callable[[InterruptionEvent], None],
    ) -> Unsubscribe:
        return self._on_interruption_event(EVT_INTERRUPTION_FALSE_POSITIVE, handler)

    def on_browser_event(
        self,
        handler: Callable[[BrowserEvent], None],
    ) -> Unsubscribe:
        def emit(payload: dict[str, Any]) -> None:
            handler(
                BrowserEvent(
                    session_id=_required_str(payload.get("session_id"), self._session_id),
                    channel_name=self._channel_name,
                    data=payload,
                    event=_required_str(payload.get("event")),
                    payload=payload.get("payload"),
                )
            )

        return self.on(EVT_BROWSER_EVENT, emit)

    def on_close(self, handler: Callable[[CloseEvent], None]) -> Unsubscribe:
        def emit(payload: dict[str, Any]) -> None:
            handler(
                CloseEvent(
                    session_id=_required_str(payload.get("session_id"), self._session_id),
                    channel_name=self._channel_name,
                    data=payload,
                    reason=_required_str(payload.get("reason"), "unknown"),
                    connection_state=_optional_str(payload.get("connection_state")),
                    ice_connection_state=_optional_str(payload.get("ice_connection_state")),
                    data_channel_state=_optional_str(payload.get("data_channel_state")),
                )
            )

        return self.on(EVT_CLOSE, emit)

    def on_error(self, handler: Callable[[ErrorEvent], None]) -> Unsubscribe:
        def emit(payload: dict[str, Any]) -> None:
            handler(
                ErrorEvent(
                    session_id=_required_str(payload.get("session_id"), self._session_id),
                    channel_name=self._channel_name,
                    data=payload,
                    message=_optional_str(payload.get("message")),
                    code=_optional_str(payload.get("code")),
                )
            )

        return self.on(EVT_ERROR, emit)

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
