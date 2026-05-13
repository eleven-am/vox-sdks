from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from vox_rtc_server import (
    ChannelState,
    ClientEventEnvelope,
    ConnectionState,
    SessionConfig,
    VoxRtcServerClient,
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
        self.message_event_handlers: dict[str, list[Callable[[FakeServerMessage], None]]] = {}

    def join(self) -> None:
        for handler in list(self.state_handlers):
            handler(ChannelState.JOINED)

    def leave(self) -> None:
        return None

    def send_message(self, event: str, payload: dict[str, Any] | None = None) -> None:
        self.sent.append((event, dict(payload or {})))

    def on_message(self, callback: Callable[[FakeServerMessage], None]) -> Callable[[], None]:
        self.message_handlers.append(callback)
        return lambda: self.message_handlers.remove(callback)

    def on_message_event(
        self, event_name: str, callback: Callable[[FakeServerMessage], None]
    ) -> Callable[[], None]:
        handlers = self.message_event_handlers.setdefault(event_name, [])
        handlers.append(callback)
        return lambda: handlers.remove(callback)

    def on_channel_state_change(self, callback: Callable[[Any], None]) -> Callable[[], None]:
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

    def create_channel(self, name: str, params: dict[str, Any] | None = None) -> FakeChannel:
        assert name == "/rtc/rtc_123"
        return self.channel

    def on_connection_change(self, callback: Callable[[Any], None]) -> Callable[[], None]:
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
                "client_token": "tok_123",
                "expires_at": "2026-01-01T00:00:00Z",
                "join_token_ttl_seconds": 120,
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
    assert bootstrap.client_token == "tok_123"
    assert bootstrap.join_token_ttl_seconds == 120
    assert client.http_base == "https://vox.example.com"
    assert client.socket_base == "https://vox.example.com/v1/socket"


def test_attach_session_joins_and_sends_expected_control_messages() -> None:
    fake_socket = FakeSocket()
    captured_params: dict[str, Any] = {}
    client = VoxRtcServerClient(
        http_base="https://vox.example.com",
        api_key="secret",
        socket_factory=lambda _endpoint, params, *_args: captured_params.update(params) or fake_socket,
    )

    session = asyncio.run(client.attach_session("rtc_123"))
    session.configure(
        SessionConfig(
            stt_model="stt",
            tts_model="tts",
            voice="voice",
            turn_profile="browser_default",
            vad_backend="silero",
            turn_detector="livekit",
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
        }
    }
    assert fake_socket.channel.sent[1][1] == {"text": "Hello"}
    assert captured_params == {"api_key": "secret"}


def test_on_event_maps_socket_messages_into_wire_events() -> None:
    fake_socket = FakeSocket()
    client = VoxRtcServerClient(
        http_base="https://vox.example.com",
        socket_factory=lambda *args: fake_socket,
    )

    session = asyncio.run(client.attach_session("rtc_123"))
    received: list[tuple[str, dict[str, Any]]] = []
    unsubscribe = session.on_event(lambda event: received.append((event.type, event.data)))

    fake_socket.channel.emit(
        "turn.state_changed",
        {"state": "speaking", "session_id": "rtc_123"},
    )
    unsubscribe()

    assert received == [
        ("turn.state_changed", {"state": "speaking", "session_id": "rtc_123"})
    ]
