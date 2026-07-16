from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Callable, Mapping
from typing import Any
from urllib.request import Request, urlopen

from .session import VoxRtcControlSession
from .types import (
    ConnectionState,
    RTCIceServer,
    SessionBootstrap,
    SocketClientFactory,
    SocketClientLike,
    Unsubscribe,
)


def _normalize_base(base: str) -> str:
    return base.rstrip("/")


def _default_socket_base(http_base: str) -> str:
    return f"{_normalize_base(http_base)}/v1/socket"


def _to_bootstrap(data: Mapping[str, Any]) -> SessionBootstrap:
    ice_servers = [
        RTCIceServer(
            urls=entry.get("urls", []),
            username=entry.get("username"),
            credential=entry.get("credential"),
        )
        for entry in data.get("ice_servers", [])
        if isinstance(entry, Mapping)
    ]
    return SessionBootstrap(
        session_id=str(data["session_id"]),
        expires_at=str(data["expires_at"]),
        attach_ttl_seconds=int(data.get("attach_ttl_seconds", 0)),
        ice_servers=ice_servers,
    )


def _state_value(state: Any) -> str:
    return str(getattr(state, "value", state))


def _default_socket_factory(
    endpoint: str,
    params: Mapping[str, Any],
    connection_timeout: float,
    max_reconnect_delay: float,
) -> SocketClientLike:
    try:
        from pondsocket_client import ClientOptions, PondClient
    except ImportError as exc:
        raise ImportError(
            "pondsocket-client is required for the default Vox RTC socket transport"
        ) from exc

    options = ClientOptions(
        connection_timeout=connection_timeout,
        max_reconnect_delay=max_reconnect_delay,
    )
    return PondClient(endpoint, dict(params), options)


class VoxRtcServerClient:
    __slots__ = (
        "_connection_timeout",
        "_http_base",
        "_api_key",
        "_join_timeout",
        "_max_reconnect_delay",
        "_request_timeout",
        "_socket",
        "_socket_base",
        "_socket_factory",
        "_socket_params",
        "_urlopen",
    )

    def __init__(
        self,
        *,
        http_base: str,
        api_key: str | None = None,
        socket_base: str | None = None,
        socket_params: Mapping[str, Any] | None = None,
        connection_timeout: float = 10.0,
        max_reconnect_delay: float = 30.0,
        request_timeout: float = 15.0,
        join_timeout: float = 10.0,
        socket_factory: SocketClientFactory | None = None,
        urlopen_impl: Any = urlopen,
    ) -> None:
        self._http_base = _normalize_base(http_base)
        resolved_api_key = (
            api_key if api_key is not None else os.environ.get("VOX_API_KEY", "")
        ).strip()
        self._api_key = resolved_api_key or None
        self._socket_base = (
            _normalize_base(socket_base)
            if socket_base
            else _default_socket_base(http_base)
        )
        merged_socket_params = dict(socket_params or {})
        if self._api_key:
            merged_socket_params["api_key"] = self._api_key
        self._socket_params = merged_socket_params
        self._connection_timeout = connection_timeout
        self._max_reconnect_delay = max_reconnect_delay
        self._request_timeout = request_timeout
        self._join_timeout = join_timeout
        self._socket_factory = socket_factory or _default_socket_factory
        self._socket: SocketClientLike | None = None
        self._urlopen = urlopen_impl

    @property
    def http_base(self) -> str:
        return self._http_base

    @property
    def socket_base(self) -> str:
        return self._socket_base

    @property
    def connection_state(self) -> ConnectionState:
        if self._socket is None:
            return ConnectionState.DISCONNECTED
        raw = _state_value(self._socket.get_state())
        try:
            return ConnectionState(raw)
        except ValueError:
            return ConnectionState.DISCONNECTED

    def on_connection_change(
        self, callback: Callable[[ConnectionState], None]
    ) -> Unsubscribe:
        def forward(state: Any) -> None:
            raw = _state_value(state)
            try:
                resolved = ConnectionState(raw)
            except ValueError:
                resolved = ConnectionState.DISCONNECTED
            callback(resolved)

        return self._ensure_socket().on_connection_change(forward)

    def on_error(self, callback: Callable[[BaseException], None]) -> Unsubscribe:
        return self._ensure_socket().on_error(callback)

    async def connect(self) -> None:
        socket = self._ensure_socket()
        if _state_value(socket.get_state()) == ConnectionState.CONNECTED.value:
            return
        await socket.connect()

    async def disconnect(self) -> None:
        socket = self._socket
        if socket is None:
            return
        await socket.disconnect()
        self._socket = None

    async def create_session(self) -> SessionBootstrap:
        return await asyncio.to_thread(self._create_session_blocking)

    async def attach_session(
        self,
        session_id: str,
        *,
        join_timeout: float | None = None,
    ) -> VoxRtcControlSession:
        await self.connect()
        socket = self._ensure_socket()
        channel = socket.create_channel(f"/rtc/{session_id}", {})
        session = VoxRtcControlSession(
            channel,
            session_id,
            join_timeout=self._join_timeout if join_timeout is None else join_timeout,
        )
        await session.join()
        return session

    async def create_controlled_session(
        self,
        *,
        join_timeout: float | None = None,
    ) -> tuple[SessionBootstrap, VoxRtcControlSession]:
        bootstrap = await self.create_session()
        session = await self.attach_session(
            bootstrap.session_id,
            join_timeout=join_timeout,
        )
        return bootstrap, session

    def _ensure_socket(self) -> SocketClientLike:
        if self._socket is None:
            self._socket = self._socket_factory(
                self._socket_base,
                self._socket_params,
                self._connection_timeout,
                self._max_reconnect_delay,
            )
        return self._socket

    def _create_session_blocking(self) -> SessionBootstrap:
        request = Request(
            f"{self._http_base}/v1/rtc/sessions",
            data=json.dumps({}).encode("utf-8"),
            headers={"content-type": "application/json"},
            method="POST",
        )
        if self._api_key:
            request.add_header("authorization", f"Bearer {self._api_key}")
        with self._urlopen(request, timeout=self._request_timeout) as response:
            status = (
                int(response.status)
                if hasattr(response, "status")
                else int(response.getcode())
            )
            body = response.read().decode("utf-8")
        if status < 200 or status >= 300:
            raise RuntimeError(
                f"Failed to create Vox RTC session: {status} {body.strip()}"
            )
        return _to_bootstrap(json.loads(body))
