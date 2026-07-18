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
    expires_at: str
    attach_ttl_seconds: int
    ice_servers: list[RTCIceServer] = field(default_factory=list)


@dataclass(slots=True)
class RtcSessionDescription:
    type: str
    sdp: str


@dataclass(slots=True)
class RtcIceCandidate:
    candidate: str
    sdp_mid: str | None = None
    sdp_m_line_index: int | None = None
    username_fragment: str | None = None


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
    generation_id: str | None = None


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


@dataclass(slots=True)
class SessionAttachedEvent:
    session_id: str
    channel_name: str
    data: dict[str, Any]


@dataclass(slots=True)
class SessionCreatedEvent:
    session_id: str
    channel_name: str
    data: dict[str, Any]
    session: dict[str, Any] | None = None


@dataclass(slots=True)
class TranscriptEvent:
    session_id: str
    channel_name: str
    data: dict[str, Any]
    transcript: str
    language: str | None = None
    start_ms: int | float | None = None
    end_ms: int | float | None = None
    eou_probability: int | float | None = None
    topics: list[str] | None = None


@dataclass(slots=True)
class TurnStateEvent:
    session_id: str
    channel_name: str
    data: dict[str, Any]
    state: str
    previous_state: str | None = None


@dataclass(slots=True)
class SpeechEvent:
    session_id: str
    channel_name: str
    data: dict[str, Any]
    timestamp_ms: int | float | None = None


@dataclass(slots=True)
class TranscriptDeltaEvent:
    session_id: str
    channel_name: str
    data: dict[str, Any]
    delta: str
    start_ms: int | float | None = None
    end_ms: int | float | None = None


@dataclass(slots=True)
class TurnEouPredictedEvent:
    session_id: str
    channel_name: str
    data: dict[str, Any]
    probability: int | float | None = None
    threshold: int | float | None = None
    delay_ms: int | float | None = None
    start_ms: int | float | None = None
    end_ms: int | float | None = None
    decision: str | None = None
    action: str | None = None
    turn_detector: str | None = None


@dataclass(slots=True)
class ResponseEvent:
    session_id: str
    channel_name: str
    data: dict[str, Any]
    response_id: str | None = None
    generation_id: str | None = None


@dataclass(slots=True)
class InterruptionEvent(ResponseEvent):
    vad_active_ms: int | float | None = None
    partial_transcript: str | None = None


@dataclass(slots=True)
class BrowserEvent:
    session_id: str
    channel_name: str
    data: dict[str, Any]
    event: str
    payload: Any = None


@dataclass(slots=True)
class CloseEvent:
    session_id: str
    channel_name: str
    data: dict[str, Any]
    reason: str
    connection_state: str | None = None
    ice_connection_state: str | None = None
    data_channel_state: str | None = None


@dataclass(slots=True)
class ErrorEvent:
    session_id: str
    channel_name: str
    data: dict[str, Any]
    message: str | None = None
    code: str | None = None
    recoverable: bool = True
    generation_id: str | None = None


ERROR_CODE_RESPONSE_REJECTED_TURN_STATE = "response_rejected_turn_state"
ERROR_CODE_RESPONSE_REJECTED_USER_SPEECH = "response_rejected_user_speech"
ERROR_CODE_RESPONSE_STALE_GENERATION = "response_stale_generation"
ERROR_CODE_RESPONSE_ALREADY_ACTIVE = "response_already_active"
ERROR_CODE_RESPONSE_FAILED = "response_failed"
ERROR_CODE_COMMAND_INVALID = "command_invalid"
ERROR_CODE_SESSION_FAILED = "session_failed"


@dataclass(slots=True)
class StartAck:
    accepted: bool
    generation_id: str
    response_id: str | None = None
    error: ErrorEvent | None = None


Unsubscribe: TypeAlias = Callable[[], None]


class ServerMessageLike(Protocol):
    @property
    def event(self) -> str: ...

    @property
    def payload(self) -> Any: ...


class SocketChannelLike(Protocol):
    def join(self) -> None: ...

    def leave(self) -> None: ...

    def send_message(
        self, event: str, payload: dict[str, Any] | None = None
    ) -> None: ...

    def on_message(
        self, callback: Callable[[ServerMessageLike], None]
    ) -> Unsubscribe: ...

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
        self, name: str, params: dict[str, Any] | None = None
    ) -> SocketChannelLike: ...

    def on_connection_change(self, callback: Callable[[Any], None]) -> Unsubscribe: ...

    def on_error(self, callback: Callable[[BaseException], None]) -> Unsubscribe: ...


SocketClientFactory: TypeAlias = Callable[
    [str, Mapping[str, Any], float, float],
    SocketClientLike,
]
