from __future__ import annotations

import asyncio
import uuid
from collections.abc import Callable, Mapping
from dataclasses import replace
from typing import Any

from .types import (
    BrowserEvent,
    ChannelState,
    ClientEventEnvelope,
    CloseEvent,
    ErrorEvent,
    InterruptionEvent,
    ResponseEvent,
    ResponseOptions,
    SessionAttachedEvent,
    SessionConfig,
    SessionCreatedEvent,
    SignalingErrorEvent,
    SocketChannelLike,
    SpeechContext,
    SpeechContextSoundSpan,
    SpeechContextSpan,
    SpeechContextTrack,
    SpeechEvent,
    StartAck,
    TranscriptDeltaEvent,
    TranscriptEntity,
    TranscriptEvent,
    TranscriptWord,
    TurnEouPredictedEvent,
    TurnStateEvent,
    Unsubscribe,
    WireEvent,
    state_value,
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
EVT_SIGNALING_ERROR = "rtc.signaling_error"
EVT_TURN_EOU_PREDICTED = "turn.eou.predicted"
EVT_TURN_STATE_CHANGED = "turn.state_changed"


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
    return (
        value
        if isinstance(value, (int, float)) and not isinstance(value, bool)
        else None
    )


def _optional_str_list(value: Any) -> list[str] | None:
    if not isinstance(value, list):
        return None
    if not all(isinstance(item, str) for item in value):
        return None
    return list(value)


def _optional_bool(value: Any, default: bool) -> bool:
    return value if isinstance(value, bool) else default


def _required_int(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _optional_int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _parse_entities(value: Any) -> list[TranscriptEntity] | None:
    if not isinstance(value, list):
        return None
    entities = [
        TranscriptEntity(
            type=_required_str(item.get("type")),
            text=_required_str(item.get("text")),
            start_char=_required_int(item.get("start_char")),
            end_char=_required_int(item.get("end_char")),
        )
        for item in value
        if isinstance(item, Mapping)
    ]
    return entities or None


def _parse_words(value: Any) -> list[TranscriptWord] | None:
    if not isinstance(value, list):
        return None
    words = [
        TranscriptWord(
            word=_required_str(item.get("word")),
            start_ms=_optional_number(item.get("start_ms")) or 0,
            end_ms=_optional_number(item.get("end_ms")) or 0,
            confidence=_optional_number(item.get("confidence")),
        )
        for item in value
        if isinstance(item, Mapping)
    ]
    return words or None


def _parse_speech_context_span(value: Any) -> SpeechContextSpan | None:
    if not isinstance(value, Mapping):
        return None
    label = value.get("label")
    start_ms = value.get("start_ms")
    end_ms = value.get("end_ms")
    if (
        not isinstance(label, str)
        or not label
        or isinstance(start_ms, bool)
        or not isinstance(start_ms, int)
        or start_ms < 0
        or isinstance(end_ms, bool)
        or not isinstance(end_ms, int)
        or end_ms <= start_ms
    ):
        return None
    return SpeechContextSpan(label=label, start_ms=start_ms, end_ms=end_ms)


def _parse_speech_context_spans(value: Any) -> list[SpeechContextSpan] | None:
    if not isinstance(value, list):
        return None
    spans = [_parse_speech_context_span(item) for item in value]
    return [span for span in spans if span is not None] if all(spans) else None


def _parse_speech_context_sound_span(
    value: Any,
) -> SpeechContextSoundSpan | None:
    span = _parse_speech_context_span(value)
    if span is None or not isinstance(value, Mapping):
        return None
    score = value.get("score")
    if (
        isinstance(score, bool)
        or not isinstance(score, (int, float))
        or not 0 <= score <= 1
    ):
        return None
    return SpeechContextSoundSpan(
        label=span.label,
        start_ms=span.start_ms,
        end_ms=span.end_ms,
        score=float(score),
    )


def _parse_speech_context_sound_spans(
    value: Any,
) -> list[SpeechContextSoundSpan] | None:
    if not isinstance(value, list):
        return None
    spans = [_parse_speech_context_sound_span(item) for item in value]
    return [span for span in spans if span is not None] if all(spans) else None


def _parse_speech_context_tracks(
    value: Any,
) -> list[SpeechContextTrack] | None:
    if (
        not isinstance(value, list)
        or not all(
            isinstance(item, str) and item in {"speaker", "sounds"}
            for item in value
        )
        or len(set(value)) != len(value)
    ):
        return None
    return list(value)


def _parse_speech_context(value: Any) -> SpeechContext | None:
    if not isinstance(value, Mapping) or value.get("schema_version") != 2:
        return None
    status = value.get("status")
    if status not in {"complete", "partial", "failed"}:
        return None
    emotions = _parse_speech_context_spans(value.get("emotions"))
    vocal = _parse_speech_context_spans(value.get("vocal"))
    sounds = _parse_speech_context_sound_spans(value.get("sounds"))
    unavailable = _parse_speech_context_tracks(value.get("unavailable"))

    if status == "complete":
        if (
            emotions is None
            or vocal is None
            or sounds is None
            or "unavailable" in value
        ):
            return None
        return SpeechContext(
            schema_version=2,
            status="complete",
            emotions=emotions,
            vocal=vocal,
            sounds=sounds,
        )
    if unavailable is None:
        return None
    if status == "failed":
        if set(unavailable) != {"speaker", "sounds"}:
            return None
    elif len(unavailable) != 1:
        return None
    if (
        ("speaker" in unavailable and (emotions is not None or vocal is not None))
        or ("speaker" not in unavailable and (emotions is None or vocal is None))
        or ("sounds" in unavailable and sounds is not None)
        or ("sounds" not in unavailable and sounds is None)
    ):
        return None
    return SpeechContext(
        schema_version=2,
        status=status,
        emotions=emotions,
        vocal=vocal,
        sounds=sounds,
        unavailable=unavailable,
    )


def _response_options_payload(options: ResponseOptions | None) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    if options is not None:
        if options.allow_interruptions is not None:
            payload["allow_interruptions"] = options.allow_interruptions
        if options.generation_id is not None:
            payload["generation_id"] = options.generation_id
    return payload


class VoxRtcControlSession:
    __slots__ = (
        "_channel",
        "_channel_name",
        "_join_timeout",
        "_response_generation_counter",
        "_response_generation_id",
        "_session_id",
    )

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
        self._response_generation_counter = 0
        self._response_generation_id: str | None = None

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
            value = state_value(state)
            if value == ChannelState.JOINED.value and not done.done():
                done.set_result(None)
            elif (
                value in (ChannelState.DECLINED.value, ChannelState.CLOSED.value)
                and not done.done()
            ):
                done.set_exception(
                    RuntimeError(
                        f"RTC channel join failed for {self._channel_name}: {value}"
                    )
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

    def on(
        self, event_name: str, handler: Callable[[dict[str, Any]], None]
    ) -> Unsubscribe:
        def callback(message: Any) -> None:
            handler(_payload_dict(getattr(message, "payload", None)))

        return self._channel.on_message_event(event_name, callback)

    def _common(self, payload: dict[str, Any]) -> dict[str, Any]:
        return {
            "session_id": _required_str(payload.get("session_id"), self._session_id),
            "channel_name": self._channel_name,
            "data": payload,
        }

    def on_session_attached(
        self,
        handler: Callable[[SessionAttachedEvent], None],
    ) -> Unsubscribe:
        return self.on(
            EVT_RTC_SESSION_ATTACHED,
            lambda payload: handler(
                SessionAttachedEvent(
                    **self._common(payload),
                    provider=_optional_str(payload.get("provider")),
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
                    **self._common(payload),
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
                    **self._common(payload),
                    transcript=_required_str(payload.get("transcript")),
                    language=_optional_str(payload.get("language")),
                    start_ms=_optional_number(payload.get("start_ms")),
                    end_ms=_optional_number(payload.get("end_ms")),
                    eou_probability=_optional_number(payload.get("eou_probability")),
                    topics=_optional_str_list(payload.get("topics")),
                    entities=_parse_entities(payload.get("entities")),
                    words=_parse_words(payload.get("words")),
                    speech_context=_parse_speech_context(
                        payload.get("speech_context")
                    ),
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
                    **self._common(payload),
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
                    **self._common(payload),
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
                    **self._common(payload),
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
                    **self._common(payload),
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
                    **self._common(payload),
                    response_id=_optional_str(payload.get("response_id")),
                    generation_id=_optional_str(payload.get("generation_id")),
                )
            )

        return self.on(event_name, emit)

    def on_response_created(
        self, handler: Callable[[ResponseEvent], None]
    ) -> Unsubscribe:
        return self._on_response_event(EVT_RESPONSE_CREATED, handler)

    def on_response_committed(
        self, handler: Callable[[ResponseEvent], None]
    ) -> Unsubscribe:
        return self._on_response_event(EVT_RESPONSE_COMMITTED, handler)

    def on_response_done(self, handler: Callable[[ResponseEvent], None]) -> Unsubscribe:
        return self._on_response_event(EVT_RESPONSE_DONE, handler)

    def on_response_cancelled(
        self, handler: Callable[[ResponseEvent], None]
    ) -> Unsubscribe:
        return self._on_response_event(EVT_RESPONSE_CANCELLED, handler)

    def on_response_audio_clear(
        self, handler: Callable[[ResponseEvent], None]
    ) -> Unsubscribe:
        return self._on_response_event(EVT_RESPONSE_AUDIO_CLEAR, handler)

    def _on_interruption_event(
        self,
        event_name: str,
        handler: Callable[[InterruptionEvent], None],
    ) -> Unsubscribe:
        def emit(payload: dict[str, Any]) -> None:
            handler(
                InterruptionEvent(
                    **self._common(payload),
                    response_id=_optional_str(payload.get("response_id")),
                    generation_id=_optional_str(payload.get("generation_id")),
                    vad_active_ms=_optional_number(payload.get("vad_active_ms")),
                    partial_transcript=_optional_str(payload.get("partial_transcript")),
                    reason=_optional_str(payload.get("reason")),
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
                    **self._common(payload),
                    event=_required_str(payload.get("event")),
                    payload=payload.get("payload"),
                )
            )

        return self.on(EVT_BROWSER_EVENT, emit)

    def on_close(self, handler: Callable[[CloseEvent], None]) -> Unsubscribe:
        def emit(payload: dict[str, Any]) -> None:
            handler(
                CloseEvent(
                    **self._common(payload),
                    reason=_required_str(payload.get("reason"), "unknown"),
                    connection_state=_optional_str(payload.get("connection_state")),
                    ice_connection_state=_optional_str(
                        payload.get("ice_connection_state")
                    ),
                    data_channel_state=_optional_str(payload.get("data_channel_state")),
                )
            )

        return self.on(EVT_CLOSE, emit)

    def on_error(self, handler: Callable[[ErrorEvent], None]) -> Unsubscribe:
        def emit(payload: dict[str, Any]) -> None:
            handler(
                ErrorEvent(
                    **self._common(payload),
                    message=_optional_str(payload.get("message")),
                    code=_optional_str(payload.get("code")),
                    recoverable=_optional_bool(payload.get("recoverable"), True),
                    generation_id=_optional_str(payload.get("generation_id")),
                )
            )

        return self.on(EVT_ERROR, emit)

    def on_signaling_error(
        self, handler: Callable[[SignalingErrorEvent], None]
    ) -> Unsubscribe:
        def emit(payload: dict[str, Any]) -> None:
            handler(
                SignalingErrorEvent(
                    **self._common(payload),
                    message=_optional_str(payload.get("message")),
                    generation=_optional_int(payload.get("generation")),
                )
            )

        return self.on(EVT_SIGNALING_ERROR, emit)

    def send_control(
        self, event: str, payload: Mapping[str, Any] | None = None
    ) -> None:
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
        if config.speech_context is not None:
            session["speech_context"] = config.speech_context
        self.send_control("session.update", {"session": session})

    def start_response(self, options: ResponseOptions | None = None) -> None:
        if options is not None and options.generation_id is not None:
            self._response_generation_id = options.generation_id
        else:
            self._response_generation_id = self._next_response_generation_id()
        payload = _response_options_payload(options)
        payload["generation_id"] = self._response_generation_id
        self.send_control("response.start", payload)

    async def start_response_and_wait(
        self,
        options: ResponseOptions | None = None,
        *,
        timeout: float = 5.0,
    ) -> StartAck:
        if options is not None and options.generation_id is not None:
            generation_id = options.generation_id
            start_options = options
        else:
            generation_id = self._next_response_generation_id()
            start_options = replace(
                options if options is not None else ResponseOptions(),
                generation_id=generation_id,
            )

        loop = asyncio.get_running_loop()
        done: asyncio.Future[StartAck] = loop.create_future()

        def handle_created(event: ResponseEvent) -> None:
            if event.generation_id == generation_id and not done.done():
                done.set_result(
                    StartAck(
                        accepted=True,
                        generation_id=generation_id,
                        response_id=event.response_id,
                    )
                )

        def handle_error(event: ErrorEvent) -> None:
            if event.generation_id == generation_id and not done.done():
                done.set_result(
                    StartAck(
                        accepted=False,
                        generation_id=generation_id,
                        error=event,
                    )
                )

        unsubscribe_created = self.on_response_created(handle_created)
        unsubscribe_error = self.on_error(handle_error)
        try:
            self.start_response(start_options)
            return await asyncio.wait_for(done, timeout=timeout)
        finally:
            unsubscribe_created()
            unsubscribe_error()

    def append_response_text(
        self,
        delta: str,
        options: ResponseOptions | None = None,
    ) -> None:
        payload = _response_options_payload(options)
        payload["delta"] = delta
        self._add_response_generation(payload)
        self.send_control("response.delta", payload)

    def commit_response(self, options: ResponseOptions | None = None) -> None:
        payload = _response_options_payload(options)
        self._add_response_generation(payload)
        self.send_control("response.commit", payload)

    def cancel_response(self, options: ResponseOptions | None = None) -> None:
        payload = _response_options_payload(options)
        self._add_response_generation(payload)
        self.send_control("response.cancel", payload)
        self._response_generation_id = None

    def replace_response_text(
        self,
        text: str,
        options: ResponseOptions | None = None,
    ) -> None:
        self._response_generation_id = None
        payload = _response_options_payload(options)
        payload["text"] = text
        self.send_control("response.replace_text", payload)

    def send_text_response(
        self,
        text: str,
        options: ResponseOptions | None = None,
    ) -> None:
        self.replace_response_text(text, options)

    def send_client_event(self, envelope: ClientEventEnvelope) -> None:
        self.send_control(
            "client.event",
            {"event": envelope.event, "payload": envelope.payload},
        )

    def _next_response_generation_id(self) -> str:
        self._response_generation_counter += 1
        return f"generation_{self._response_generation_counter}_{uuid.uuid4().hex}"

    def _add_response_generation(self, payload: dict[str, Any]) -> None:
        if "generation_id" in payload:
            return
        if self._response_generation_id is not None:
            payload["generation_id"] = self._response_generation_id
