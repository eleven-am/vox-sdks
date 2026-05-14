from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Protocol, TypeAlias


class ConnectionState(StrEnum):
    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"


class ChannelState(StrEnum):
    IDLE = "IDLE"
    JOINING = "JOINING"
    JOINED = "JOINED"
    STALLED = "STALLED"
    CLOSED = "CLOSED"
    DECLINED = "DECLINED"


@dataclass(slots=True)
class RTCIceServer:
    urls: str | list[str]
    username: str | None = None
    credential: str | None = None


@dataclass(slots=True)
class SessionBootstrap:
    session_id: str
    client_token: str
    expires_at: str
    join_token_ttl_seconds: int
    ice_servers: list[RTCIceServer] = field(default_factory=list)


@dataclass(slots=True)
class SessionConfig:
    stt_model: str | None = None
    tts_model: str | None = None
    voice: str | None = None
    turn_profile: str | None = None
    vad_backend: str | None = None
    turn_detector: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class ResponseOptions:
    allow_interruptions: bool | None = None


@dataclass(slots=True)
class ClientEventEnvelope:
    event: str
    payload: Any = None


@dataclass(slots=True)
class WireEvent:
    type: str
    data: dict[str, Any]
    session_id: str
    channel_name: str


Unsubscribe: TypeAlias = Callable[[], None]


class ServerMessageLike(Protocol):
    @property
    def event(self) -> str: ...

    @property
    def payload(self) -> Any: ...


class SocketChannelLike(Protocol):
    def join(self) -> None: ...

    def leave(self) -> None: ...

    def send_message(self, event: str, payload: Mapping[str, Any] | None = None) -> None: ...

    def on_message(self, callback: Callable[[ServerMessageLike], None]) -> Unsubscribe: ...

    def on_message_event(
        self, event_name: str, callback: Callable[[ServerMessageLike], None]
    ) -> Unsubscribe: ...

    def on_channel_state_change(
        self, callback: Callable[[Any], None]
    ) -> Unsubscribe: ...


class SocketClientLike(Protocol):
    async def connect(self) -> None: ...

    async def disconnect(self) -> None: ...

    def get_state(self) -> Any: ...

    def create_channel(
        self, name: str, params: Mapping[str, Any] | None = None
    ) -> SocketChannelLike: ...

    def on_connection_change(self, callback: Callable[[Any], None]) -> Unsubscribe: ...

    def on_error(self, callback: Callable[[BaseException], None]) -> Unsubscribe: ...


SocketClientFactory: TypeAlias = Callable[
    [str, Mapping[str, Any], float, float],
    SocketClientLike,
]
