# `vox-rtc-server`

Server-side Python SDK for Vox-hosted WebRTC sessions.

This package is for backend applications that need to:

- create RTC sessions over HTTP
- attach to `/v1/socket`
- join `/rtc/{session_id}`
- send `session.update`, `response.*`, and server-to-browser `client.event`
- observe RTC control events

It is intentionally narrow. It is not the general STT/TTS/text SDK.

## Install

```bash
pip install vox-rtc-server pondsocket-client
```

The SDK uses the PondSocket Python client for the control-plane socket.
Until `pondsocket-client` is published, install it from your local checkout or git ref.
Authentication can be passed explicitly with `api_key=...` or through `VOX_API_KEY`.

## Example

```python
import asyncio
import os

from vox_rtc_server import (
    ClientEventEnvelope,
    SessionConfig,
    VoxRtcServerClient,
)


async def main() -> None:
    client = VoxRtcServerClient(
        http_base="https://vox.example.com",
        api_key=os.environ.get("VOX_API_KEY"),
    )

    bootstrap, session = await client.create_controlled_session()
    print("session:", bootstrap.session_id)

    session.on_transcript(lambda event: print("user said:", event.transcript))
    session.on_browser_event(lambda event: print("browser event:", event.event, event.payload))
    session.on_close(lambda event: print("browser disconnected:", event.reason))

    session.configure(
        SessionConfig(
            stt_model="parakeet-stt-onnx:tdt-0.6b-v3",
            tts_model="kokoro-tts-onnx:v1.0",
            voice="af_heart",
            turn_profile="browser_default",
            vad_backend="silero",
            turn_detector="livekit",
        )
    )

    session.send_text_response("Hello from Python.")
    session.send_client_event(
        ClientEventEnvelope(
            event="render.url",
            payload={"url": "https://example.com"},
        )
    )


asyncio.run(main())
```

`send_client_event` is server to browser. Browser-originated app events arrive through `on_browser_event`.
