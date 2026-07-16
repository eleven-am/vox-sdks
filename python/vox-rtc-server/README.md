# `vox-rtc-server`

Trusted Python SDK for Vox-hosted WebRTC conversations. It creates sessions over
HTTP and controls them over PondSocket.

## Install

```bash
pip install vox-rtc-server
```

Pass `api_key=...` or set `VOX_API_KEY`.

## PondSocket session

```python
import asyncio
import os

from vox_rtc_server import ClientEventEnvelope, SessionConfig, VoxRtcServerClient


async def main() -> None:
    client = VoxRtcServerClient(
        http_base="http://vox-service.vox.svc.cluster.local:11435",
        api_key=os.environ.get("VOX_API_KEY"),
    )
    bootstrap, session = await client.create_controlled_session()
    session.on_transcript(lambda event: print("user said:", event.transcript))
    session.on_browser_event(lambda event: print(event.event, event.payload))
    session.configure(SessionConfig(
        stt_model="parakeet-stt:tdt-0.6b-v3",
        tts_model="kokoro-tts:v1.0",
        voice="af_heart",
        turn_profile="browser_default",
    ))
    session.send_text_response("Hello from Python.")
    session.send_client_event(ClientEventEnvelope(event="render.ready", payload=True))
    print("session:", bootstrap.session_id)


asyncio.run(main())
```
