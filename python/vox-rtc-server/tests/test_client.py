from __future__ import annotations

import asyncio
import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from vox_rtc_server import (
    ERROR_CODE_RESPONSE_REJECTED_TURN_STATE,
    ERROR_CODE_SESSION_FAILED,
    ChannelState,
    ClientEventEnvelope,
    ConnectionState,
    ResponseOptions,
    SessionConfig,
    SpeechContext,
    SpeechContextSoundSpan,
    SpeechContextSpan,
    VoxRtcServerClient,
)

SPEECH_CONTEXT_FIXTURE = json.loads(
    (
        Path(__file__).resolve().parents[3]
        / "fixtures"
        / "speech-context-v2.json"
    ).read_text(encoding="utf-8")
)


@dataclass(slots=True)
class FakeServerMessage:
    event: str
    payload: dict[str, Any]


class FakeChannel:
    def __init__(self) -> None:
        self.sent: list[tuple[str, dict[str, Any]]] = []
        self.state_handlers: list[Callable[[Any], None]] = []
        self.message_handlers: list[Callable[[FakeServerMessage], None]] = []
        self.message_event_handlers: dict[
            str, list[Callable[[FakeServerMessage], None]]
        ] = {}
        self.join_state: ChannelState = ChannelState.JOINED

    def join(self) -> None:
        for handler in list(self.state_handlers):
            handler(self.join_state)

    def leave(self) -> None:
        return None

    def send_message(
        self, event: str, payload: Mapping[str, Any] | None = None
    ) -> None:
        self.sent.append((event, dict(payload or {})))

    def on_message(
        self, callback: Callable[[FakeServerMessage], None]
    ) -> Callable[[], None]:
        self.message_handlers.append(callback)
        return lambda: self.message_handlers.remove(callback)

    def on_message_event(
        self, event_name: str, callback: Callable[[FakeServerMessage], None]
    ) -> Callable[[], None]:
        handlers = self.message_event_handlers.setdefault(event_name, [])
        handlers.append(callback)
        return lambda: handlers.remove(callback)

    def on_channel_state_change(
        self, callback: Callable[[Any], None]
    ) -> Callable[[], None]:
        self.state_handlers.append(callback)
        return lambda: self.state_handlers.remove(callback)

    def emit(self, event: str, payload: dict[str, Any]) -> None:
        message = FakeServerMessage(event=event, payload=payload)
        for handler in list(self.message_handlers):
            handler(message)
        for handler in list(self.message_event_handlers.get(event, [])):
            handler(message)


class FakeSocket:
    def __init__(self) -> None:
        self.state = ConnectionState.DISCONNECTED
        self.channel = FakeChannel()
        self.connection_handlers: list[Callable[[Any], None]] = []
        self.error_handlers: list[Callable[[BaseException], None]] = []

    async def connect(self) -> None:
        self.state = ConnectionState.CONNECTED
        for handler in list(self.connection_handlers):
            handler(self.state)

    async def disconnect(self) -> None:
        self.state = ConnectionState.DISCONNECTED
        for handler in list(self.connection_handlers):
            handler(self.state)

    def get_state(self) -> ConnectionState:
        return self.state

    def create_channel(
        self, name: str, params: Mapping[str, Any] | None = None
    ) -> FakeChannel:
        assert name == "/rtc/rtc_123"
        return self.channel

    def on_connection_change(
        self, callback: Callable[[Any], None]
    ) -> Callable[[], None]:
        self.connection_handlers.append(callback)
        return lambda: self.connection_handlers.remove(callback)

    def on_error(self, callback: Callable[[BaseException], None]) -> Callable[[], None]:
        self.error_handlers.append(callback)
        return lambda: self.error_handlers.remove(callback)


class FakeHTTPResponse:
    def __init__(self, status: int, payload: dict[str, Any]) -> None:
        self.status = status
        self._body = json.dumps(payload).encode("utf-8")

    def __enter__(self) -> FakeHTTPResponse:
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        return None

    def read(self) -> bytes:
        return self._body


def test_create_session_parses_the_rtc_bootstrap_response(monkeypatch: Any) -> None:
    monkeypatch.setenv("VOX_API_KEY", "secret")

    def fake_urlopen(request: Any, timeout: float | None = None) -> FakeHTTPResponse:
        assert request.full_url == "https://vox.example.com/v1/rtc/sessions"
        assert request.method == "POST"
        assert timeout == 15.0
        assert json.loads(request.data.decode("utf-8")) == {}
        assert request.get_header("Authorization") == "Bearer secret"
        return FakeHTTPResponse(
            200,
            {
                "session_id": "rtc_123",
                "expires_at": "2026-01-01T00:00:00Z",
                "attach_ttl_seconds": 120,
                "ice_servers": [{"urls": ["stun:turn.example.com:3478"]}],
            },
        )

    client = VoxRtcServerClient(
        http_base="https://vox.example.com/",
        urlopen_impl=fake_urlopen,
        socket_factory=lambda *args: FakeSocket(),
    )

    bootstrap = asyncio.run(client.create_session())

    assert bootstrap.session_id == "rtc_123"
    assert bootstrap.attach_ttl_seconds == 120
    assert client.http_base == "https://vox.example.com"
    assert client.socket_base == "https://vox.example.com/v1/socket"


def test_attach_session_joins_and_sends_expected_control_messages() -> None:
    fake_socket = FakeSocket()
    captured_params: dict[str, Any] = {}
    client = VoxRtcServerClient(
        http_base="https://vox.example.com",
        api_key="secret",
        socket_factory=lambda _endpoint, params, *_args: captured_params.update(params)
        or fake_socket,
    )

    session = asyncio.run(client.attach_session("rtc_123", join_timeout=2.5))
    assert session._join_timeout == 2.5
    session.configure(
        SessionConfig(
            stt_model="stt",
            tts_model="tts",
            voice="voice",
            turn_profile="browser_default",
            vad_backend="silero",
            turn_detector="livekit",
            speech_context=True,
        )
    )
    session.send_text_response("Hello")
    session.send_client_event(
        ClientEventEnvelope(
            event="render.url",
            payload={"url": "https://example.com"},
        )
    )

    assert [event for event, _payload in fake_socket.channel.sent] == [
        "session.update",
        "response.replace_text",
        "client.event",
    ]
    assert fake_socket.channel.sent[0][1] == {
        "session": {
            "stt_model": "stt",
            "tts_model": "tts",
            "voice": "voice",
            "turn_profile": "browser_default",
            "vad_backend": "silero",
            "turn_detector": "livekit",
            "speech_context": True,
        }
    }
    assert fake_socket.channel.sent[1][1] == {"text": "Hello"}
    assert captured_params == {"api_key": "secret"}


def test_streaming_response_commands_share_one_generation_id() -> None:
    fake_socket = FakeSocket()
    client = VoxRtcServerClient(
        http_base="https://vox.example.com",
        socket_factory=lambda *args: fake_socket,
    )
    session = asyncio.run(client.attach_session("rtc_123"))

    session.start_response()
    session.append_response_text("Hello")
    session.commit_response()

    generation_id = fake_socket.channel.sent[0][1]["generation_id"]
    assert isinstance(generation_id, str)
    assert generation_id
    assert fake_socket.channel.sent[1][1]["generation_id"] == generation_id
    assert fake_socket.channel.sent[2][1]["generation_id"] == generation_id


def test_attach_session_reports_declined_channel_state() -> None:
    fake_socket = FakeSocket()
    fake_socket.channel.join_state = ChannelState.DECLINED
    client = VoxRtcServerClient(
        http_base="https://vox.example.com",
        socket_factory=lambda *args: fake_socket,
    )

    try:
        asyncio.run(client.attach_session("rtc_123"))
    except RuntimeError as exc:
        assert str(exc) == "RTC channel join failed for /rtc/rtc_123: DECLINED"
    else:
        raise AssertionError("expected attach_session to fail")


def test_on_event_maps_socket_messages_into_wire_events() -> None:
    fake_socket = FakeSocket()
    client = VoxRtcServerClient(
        http_base="https://vox.example.com",
        socket_factory=lambda *args: fake_socket,
    )

    session = asyncio.run(client.attach_session("rtc_123"))
    received: list[tuple[str, dict[str, Any], str, str]] = []
    unsubscribe = session.on_event(
        lambda event: received.append(
            (event.type, event.data, event.session_id, event.channel_name)
        )
    )

    fake_socket.channel.emit(
        "turn.state_changed",
        {"state": "speaking", "session_id": "rtc_123"},
    )
    unsubscribe()

    assert received == [
        (
            "turn.state_changed",
            {"state": "speaking", "session_id": "rtc_123"},
            "rtc_123",
            "/rtc/rtc_123",
        )
    ]


def test_named_event_hooks_map_common_vox_events() -> None:
    fake_socket = FakeSocket()
    client = VoxRtcServerClient(
        http_base="https://vox.example.com",
        socket_factory=lambda *args: fake_socket,
    )

    session = asyncio.run(client.attach_session("rtc_123"))
    transcripts: list[Any] = []
    turns: list[Any] = []
    responses: list[Any] = []
    browser_events: list[Any] = []
    closes: list[Any] = []

    unsub_transcript = session.on_transcript(transcripts.append)
    unsub_turn = session.on_turn_state_changed(turns.append)
    unsub_done = session.on_response_done(responses.append)
    unsub_browser = session.on_browser_event(browser_events.append)
    unsub_close = session.on_close(closes.append)

    fake_socket.channel.emit(
        "conversation.item.input_audio_transcription.completed",
        {
            "transcript": "hello world",
            "language": "en",
            "start_ms": 10,
            "end_ms": 20,
            "eou_probability": 0.7,
            "topics": ["hello"],
            "speech_context": SPEECH_CONTEXT_FIXTURE,
            "session_id": "rtc_123",
        },
    )
    fake_socket.channel.emit(
        "turn.state_changed",
        {"state": "speaking", "previous_state": "idle", "session_id": "rtc_123"},
    )
    fake_socket.channel.emit(
        "response.done",
        {"response_id": "resp_1", "session_id": "rtc_123"},
    )
    fake_socket.channel.emit(
        "browser.event",
        {
            "event": "ui.select",
            "payload": {"id": "choice-a"},
            "session_id": "rtc_123",
        },
    )
    fake_socket.channel.emit(
        "rtc.client.disconnected",
        {
            "reason": "data_channel_closed",
            "connection_state": "connected",
            "ice_connection_state": "completed",
            "data_channel_state": "closed",
            "session_id": "rtc_123",
        },
    )

    unsub_transcript()
    unsub_turn()
    unsub_done()
    unsub_browser()
    unsub_close()

    assert len(transcripts) == 1
    assert transcripts[0].transcript == "hello world"
    assert transcripts[0].language == "en"
    assert transcripts[0].start_ms == 10
    assert transcripts[0].end_ms == 20
    assert transcripts[0].eou_probability == 0.7
    assert transcripts[0].topics == ["hello"]
    assert transcripts[0].speech_context == SpeechContext(
        schema_version=2,
        status="complete",
        emotions=[SpeechContextSpan("surprised", 0, 2500)],
        vocal=[SpeechContextSpan("laughter", 7000, 10500)],
        sounds=[
            SpeechContextSoundSpan("fireworks", 3360, 4320, 0.42),
            SpeechContextSoundSpan("inside, small room", 3840, 5280, 0.31),
        ],
    )
    assert transcripts[0].session_id == "rtc_123"
    assert transcripts[0].channel_name == "/rtc/rtc_123"

    assert len(turns) == 1
    assert turns[0].state == "speaking"
    assert turns[0].previous_state == "idle"

    assert len(responses) == 1
    assert responses[0].response_id == "resp_1"

    assert len(browser_events) == 1
    assert browser_events[0].event == "ui.select"
    assert browser_events[0].payload == {"id": "choice-a"}

    assert len(closes) == 1
    assert closes[0].reason == "data_channel_closed"
    assert closes[0].connection_state == "connected"
    assert closes[0].ice_connection_state == "completed"
    assert closes[0].data_channel_state == "closed"


def test_on_speech_started_maps_typed_fields() -> None:
    fake_socket = FakeSocket()
    client = VoxRtcServerClient(
        http_base="https://vox.example.com",
        socket_factory=lambda *args: fake_socket,
    )

    session = asyncio.run(client.attach_session("rtc_123"))
    events: list[Any] = []
    unsubscribe = session.on_speech_started(events.append)

    fake_socket.channel.emit(
        "input_audio_buffer.speech_started",
        {"timestamp_ms": 1234, "session_id": "rtc_123"},
    )
    unsubscribe()

    assert len(events) == 1
    assert events[0].timestamp_ms == 1234
    assert events[0].session_id == "rtc_123"
    assert events[0].channel_name == "/rtc/rtc_123"


def test_on_speech_stopped_maps_typed_fields() -> None:
    fake_socket = FakeSocket()
    client = VoxRtcServerClient(
        http_base="https://vox.example.com",
        socket_factory=lambda *args: fake_socket,
    )

    session = asyncio.run(client.attach_session("rtc_123"))
    events: list[Any] = []
    unsubscribe = session.on_speech_stopped(events.append)

    fake_socket.channel.emit(
        "input_audio_buffer.speech_stopped",
        {"timestamp_ms": 5678, "session_id": "rtc_123"},
    )
    unsubscribe()

    assert len(events) == 1
    assert events[0].timestamp_ms == 5678
    assert events[0].channel_name == "/rtc/rtc_123"


def test_on_transcript_delta_maps_typed_fields() -> None:
    fake_socket = FakeSocket()
    client = VoxRtcServerClient(
        http_base="https://vox.example.com",
        socket_factory=lambda *args: fake_socket,
    )

    session = asyncio.run(client.attach_session("rtc_123"))
    events: list[Any] = []
    unsubscribe = session.on_transcript_delta(events.append)

    fake_socket.channel.emit(
        "conversation.item.input_audio_transcription.delta",
        {"delta": "hel", "start_ms": 10, "end_ms": 20, "session_id": "rtc_123"},
    )
    unsubscribe()

    assert len(events) == 1
    assert events[0].delta == "hel"
    assert events[0].start_ms == 10
    assert events[0].end_ms == 20
    assert events[0].session_id == "rtc_123"


def test_on_turn_eou_predicted_maps_typed_fields() -> None:
    fake_socket = FakeSocket()
    client = VoxRtcServerClient(
        http_base="https://vox.example.com",
        socket_factory=lambda *args: fake_socket,
    )

    session = asyncio.run(client.attach_session("rtc_123"))
    events: list[Any] = []
    unsubscribe = session.on_turn_eou_predicted(events.append)

    fake_socket.channel.emit(
        "turn.eou.predicted",
        {
            "probability": 0.82,
            "threshold": 0.5,
            "delay_ms": 240,
            "start_ms": 100,
            "end_ms": 900,
            "decision": "end_of_turn",
            "action": "commit",
            "turn_detector": "livekit",
            "session_id": "rtc_123",
        },
    )
    unsubscribe()

    assert len(events) == 1
    event = events[0]
    assert event.probability == 0.82
    assert event.threshold == 0.5
    assert event.delay_ms == 240
    assert event.start_ms == 100
    assert event.end_ms == 900
    assert event.decision == "end_of_turn"
    assert event.action == "commit"
    assert event.turn_detector == "livekit"
    assert event.channel_name == "/rtc/rtc_123"


def test_on_connection_change_forwards_socket_state() -> None:
    fake_socket = FakeSocket()
    client = VoxRtcServerClient(
        http_base="https://vox.example.com",
        socket_factory=lambda *args: fake_socket,
    )

    states: list[ConnectionState] = []
    client.on_connection_change(states.append)

    asyncio.run(client.connect())

    assert ConnectionState.CONNECTED in states
    assert client.connection_state == ConnectionState.CONNECTED


def _attach(fake_socket: FakeSocket) -> Any:
    client = VoxRtcServerClient(
        http_base="https://vox.example.com",
        socket_factory=lambda *args: fake_socket,
    )
    return client.attach_session("rtc_123")


def test_on_error_parses_typed_error_fields() -> None:
    fake_socket = FakeSocket()
    session = asyncio.run(_attach(fake_socket))
    errors: list[Any] = []
    unsubscribe = session.on_error(errors.append)

    fake_socket.channel.emit(
        "error",
        {
            "message": "session broke",
            "code": ERROR_CODE_SESSION_FAILED,
            "recoverable": False,
            "generation_id": "gen-42",
            "session_id": "rtc_123",
        },
    )
    unsubscribe()

    assert len(errors) == 1
    assert errors[0].message == "session broke"
    assert errors[0].code == "session_failed"
    assert errors[0].recoverable is False
    assert errors[0].generation_id == "gen-42"


def test_on_error_defaults_missing_recoverable_to_true() -> None:
    fake_socket = FakeSocket()
    session = asyncio.run(_attach(fake_socket))
    errors: list[Any] = []
    unsubscribe = session.on_error(errors.append)

    fake_socket.channel.emit(
        "error",
        {"message": "old server error", "session_id": "rtc_123"},
    )
    unsubscribe()

    assert len(errors) == 1
    assert errors[0].code is None
    assert errors[0].recoverable is True
    assert errors[0].generation_id is None


def test_response_options_generation_id_threads_outbound_payloads() -> None:
    fake_socket = FakeSocket()
    session = asyncio.run(_attach(fake_socket))

    session.start_response(ResponseOptions(generation_id="gen-42"))
    session.append_response_text("Hello", ResponseOptions(generation_id="gen-42"))
    session.commit_response(ResponseOptions(generation_id="gen-42"))
    session.cancel_response(ResponseOptions(generation_id="gen-42"))
    session.replace_response_text("Bye", ResponseOptions(generation_id="gen-43"))

    sent = fake_socket.channel.sent
    assert [event for event, _payload in sent] == [
        "response.start",
        "response.delta",
        "response.commit",
        "response.cancel",
        "response.replace_text",
    ]
    assert sent[0][1] == {"generation_id": "gen-42"}
    assert sent[1][1] == {"generation_id": "gen-42", "delta": "Hello"}
    assert sent[2][1] == {"generation_id": "gen-42"}
    assert sent[3][1] == {"generation_id": "gen-42"}
    assert sent[4][1] == {"generation_id": "gen-43", "text": "Bye"}


def test_explicit_generation_id_is_threaded_to_later_commands() -> None:
    fake_socket = FakeSocket()
    session = asyncio.run(_attach(fake_socket))

    session.start_response(ResponseOptions(generation_id="gen-42"))
    session.append_response_text("Hello")
    session.commit_response()

    sent = fake_socket.channel.sent
    assert sent[1][1]["generation_id"] == "gen-42"
    assert sent[2][1]["generation_id"] == "gen-42"


def test_response_lifecycle_events_expose_generation_id() -> None:
    fake_socket = FakeSocket()
    session = asyncio.run(_attach(fake_socket))
    responses: list[Any] = []
    interruptions: list[Any] = []
    unsub_done = session.on_response_done(responses.append)
    unsub_interruption = session.on_interruption_detected(interruptions.append)

    fake_socket.channel.emit(
        "response.done",
        {"response_id": "resp_1", "generation_id": "gen-42", "session_id": "rtc_123"},
    )
    fake_socket.channel.emit(
        "interruption.detected",
        {
            "response_id": "resp_1",
            "generation_id": "gen-42",
            "vad_active_ms": 120,
            "session_id": "rtc_123",
        },
    )
    unsub_done()
    unsub_interruption()

    assert len(responses) == 1
    assert responses[0].response_id == "resp_1"
    assert responses[0].generation_id == "gen-42"
    assert len(interruptions) == 1
    assert interruptions[0].generation_id == "gen-42"
    assert interruptions[0].vad_active_ms == 120


def test_start_response_and_wait_resolves_on_correlated_created() -> None:
    fake_socket = FakeSocket()

    async def scenario() -> Any:
        session = await _attach(fake_socket)
        task = asyncio.ensure_future(session.start_response_and_wait())
        await asyncio.sleep(0)
        generation_id = fake_socket.channel.sent[0][1]["generation_id"]
        fake_socket.channel.emit(
            "response.created",
            {
                "response_id": "resp_other",
                "generation_id": "gen-other",
                "session_id": "rtc_123",
            },
        )
        fake_socket.channel.emit(
            "response.created",
            {
                "response_id": "resp_1",
                "generation_id": generation_id,
                "session_id": "rtc_123",
            },
        )
        return await task, generation_id

    ack, generation_id = asyncio.run(scenario())

    assert ack.accepted is True
    assert ack.generation_id == generation_id
    assert ack.response_id == "resp_1"
    assert ack.error is None
    assert fake_socket.channel.sent[0][0] == "response.start"


def test_start_response_and_wait_returns_correlated_typed_rejection() -> None:
    fake_socket = FakeSocket()

    async def scenario() -> Any:
        session = await _attach(fake_socket)
        task = asyncio.ensure_future(
            session.start_response_and_wait(ResponseOptions(generation_id="gen-42"))
        )
        await asyncio.sleep(0)
        fake_socket.channel.emit(
            "error",
            {
                "message": "not now",
                "code": ERROR_CODE_RESPONSE_REJECTED_TURN_STATE,
                "recoverable": True,
                "generation_id": "gen-42",
                "session_id": "rtc_123",
            },
        )
        return await task

    ack = asyncio.run(scenario())

    assert ack.accepted is False
    assert ack.generation_id == "gen-42"
    assert ack.response_id is None
    assert ack.error is not None
    assert ack.error.code == "response_rejected_turn_state"
    assert ack.error.recoverable is True
    assert ack.error.generation_id == "gen-42"
    assert fake_socket.channel.sent[0][1]["generation_id"] == "gen-42"


def test_start_response_and_wait_times_out_without_ack() -> None:
    fake_socket = FakeSocket()

    async def scenario() -> None:
        session = await _attach(fake_socket)
        await session.start_response_and_wait(timeout=0.01)

    with pytest.raises(TimeoutError):
        asyncio.run(scenario())

    assert fake_socket.channel.sent[0][0] == "response.start"
    assert fake_socket.channel.message_event_handlers.get("response.created") == []
    assert fake_socket.channel.message_event_handlers.get("error") == []


def test_on_session_attached_exposes_provider() -> None:
    fake_socket = FakeSocket()
    session = asyncio.run(_attach(fake_socket))
    events: list[Any] = []
    unsubscribe = session.on_session_attached(events.append)

    fake_socket.channel.emit(
        "rtc.session.attached",
        {"session_id": "rtc_123", "provider": "pondsocket"},
    )
    unsubscribe()

    assert len(events) == 1
    assert events[0].provider == "pondsocket"
    assert events[0].session_id == "rtc_123"
    assert events[0].channel_name == "/rtc/rtc_123"


def test_on_transcript_maps_entities_and_words() -> None:
    fake_socket = FakeSocket()
    session = asyncio.run(_attach(fake_socket))
    transcripts: list[Any] = []
    unsubscribe = session.on_transcript(transcripts.append)

    fake_socket.channel.emit(
        "conversation.item.input_audio_transcription.completed",
        {
            "transcript": "call Alice at noon",
            "language": "en",
            "entities": [
                {"type": "PERSON", "text": "Alice", "start_char": 5, "end_char": 10},
            ],
            "words": [
                {"word": "call", "start_ms": 0, "end_ms": 200, "confidence": 0.98},
                {"word": "Alice", "start_ms": 200, "end_ms": 500},
            ],
            "session_id": "rtc_123",
        },
    )
    unsubscribe()

    assert len(transcripts) == 1
    entities = transcripts[0].entities
    assert entities is not None
    assert len(entities) == 1
    assert entities[0].type == "PERSON"
    assert entities[0].text == "Alice"
    assert entities[0].start_char == 5
    assert entities[0].end_char == 10
    words = transcripts[0].words
    assert words is not None
    assert [word.word for word in words] == ["call", "Alice"]
    assert words[0].start_ms == 0
    assert words[0].end_ms == 200
    assert words[0].confidence == 0.98
    assert words[1].confidence is None


def test_on_transcript_without_entities_or_words_leaves_them_none() -> None:
    fake_socket = FakeSocket()
    session = asyncio.run(_attach(fake_socket))
    transcripts: list[Any] = []
    unsubscribe = session.on_transcript(transcripts.append)

    fake_socket.channel.emit(
        "conversation.item.input_audio_transcription.completed",
        {"transcript": "hello", "session_id": "rtc_123"},
    )
    unsubscribe()

    assert len(transcripts) == 1
    assert transcripts[0].entities is None
    assert transcripts[0].words is None


def test_on_transcript_preserves_text_but_rejects_malformed_speech_context() -> None:
    fake_socket = FakeSocket()
    session = asyncio.run(_attach(fake_socket))
    transcripts: list[Any] = []
    unsubscribe = session.on_transcript(transcripts.append)

    fake_socket.channel.emit(
        "conversation.item.input_audio_transcription.completed",
        {
            "transcript": "still delivered",
            "speech_context": {
                "schema_version": 2,
                "status": "complete",
                "emotions": [],
                "vocal": [],
                "sounds": [
                    {
                        "label": "fireworks",
                        "start_ms": 0,
                        "end_ms": 960,
                        "score": 1.1,
                    }
                ],
            },
            "session_id": "rtc_123",
        },
    )
    unsubscribe()

    assert transcripts[0].transcript == "still delivered"
    assert transcripts[0].speech_context is None


def test_interruption_events_expose_reason() -> None:
    fake_socket = FakeSocket()
    session = asyncio.run(_attach(fake_socket))
    detected: list[Any] = []
    false_positives: list[Any] = []
    unsub_detected = session.on_interruption_detected(detected.append)
    unsub_false = session.on_interruption_false_positive(false_positives.append)

    fake_socket.channel.emit(
        "interruption.detected",
        {
            "response_id": "resp_1",
            "vad_active_ms": 300,
            "reason": "supported_final_transcript",
            "session_id": "rtc_123",
        },
    )
    fake_socket.channel.emit(
        "interruption.false_positive",
        {
            "response_id": "resp_1",
            "vad_active_ms": 120,
            "reason": "self_echo_transcript",
            "session_id": "rtc_123",
        },
    )
    unsub_detected()
    unsub_false()

    assert len(detected) == 1
    assert detected[0].reason == "supported_final_transcript"
    assert len(false_positives) == 1
    assert false_positives[0].reason == "self_echo_transcript"


def test_on_signaling_error_parses_server_wire_fields() -> None:
    fake_socket = FakeSocket()
    session = asyncio.run(_attach(fake_socket))
    errors: list[Any] = []
    unsubscribe = session.on_signaling_error(errors.append)

    fake_socket.channel.emit(
        "rtc.signaling_error",
        {
            "message": "setLocalDescription failed",
            "generation": 3,
            "session_id": "rtc_123",
        },
    )
    unsubscribe()

    assert len(errors) == 1
    assert errors[0].message == "setLocalDescription failed"
    assert errors[0].generation == 3
    assert errors[0].session_id == "rtc_123"
    assert errors[0].channel_name == "/rtc/rtc_123"
    assert not hasattr(errors[0], "recoverable")
    assert not hasattr(errors[0], "code")


def test_on_signaling_error_tolerates_missing_generation() -> None:
    fake_socket = FakeSocket()
    session = asyncio.run(_attach(fake_socket))
    errors: list[Any] = []
    unsubscribe = session.on_signaling_error(errors.append)

    fake_socket.channel.emit(
        "rtc.signaling_error",
        {"message": "RTC signaling failed", "session_id": "rtc_123"},
    )
    unsubscribe()

    assert len(errors) == 1
    assert errors[0].message == "RTC signaling failed"
    assert errors[0].generation is None


def test_send_text_response_delegates_to_replace_text() -> None:
    fake_socket = FakeSocket()
    session = asyncio.run(_attach(fake_socket))

    session.send_text_response("Hello", ResponseOptions(generation_id="gen-9"))

    sent = fake_socket.channel.sent
    assert [event for event, _payload in sent] == ["response.replace_text"]
    assert sent[0][1] == {"generation_id": "gen-9", "text": "Hello"}


def test_connection_state_tolerates_unknown_socket_state() -> None:
    class WeirdSocket(FakeSocket):
        def get_state(self) -> Any:
            return "reconnecting"

    fake_socket = WeirdSocket()
    client = VoxRtcServerClient(
        http_base="https://vox.example.com",
        socket_factory=lambda *args: fake_socket,
    )

    asyncio.run(client.attach_session("rtc_123"))

    assert client.connection_state == ConnectionState.DISCONNECTED
