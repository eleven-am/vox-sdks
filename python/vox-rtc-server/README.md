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
    session.on_transcript(
        lambda event: print("user said:", event.transcript, event.speech_context)
    )
    session.on_browser_event(lambda event: print(event.event, event.payload))
    session.configure(SessionConfig(
        stt_model="parakeet-stt:tdt-0.6b-v3",
        tts_model="kokoro-tts:v1.0",
        voice="af_heart",
        turn_profile="browser_default",
        speech_context=True,
    ))
    session.send_text_response("Hello from Python.")
    session.send_client_event(ClientEventEnvelope(event="render.ready", payload=True))
    print("session:", bootstrap.session_id)


asyncio.run(main())
```

Speech context is opt-in and final-only. When enabled, the final
`TranscriptEvent.speech_context` is a typed `SpeechContext`; otherwise it is
`None`.

Schema v2 exposes timestamped `emotions` and `vocal` speaker spans plus
environmental `sounds`. Sound spans also carry a `score` from 0 to 1:

```python
def handle_transcript(event: TranscriptEvent) -> None:
    context = event.speech_context
    if context is None:
        return

    for span in context.emotions or []:
        print("emotion", span.label, span.start_ms, span.end_ms)
    for span in context.vocal or []:
        print("vocal event", span.label, span.start_ms, span.end_ms)
    for sound in context.sounds or []:
        print("environment", sound.label, sound.score)

    if context.status != "complete":
        print("unavailable tracks", context.unavailable)
```

A `partial` result identifies the unavailable `"speaker"` or `"sounds"`
track; a `failed` result identifies both. Unsupported or malformed context is
decoded as `None` without dropping the transcript event.

## Acknowledged response starts

`start_response` stays fire-and-forget. When you want the positive
acknowledgement before pumping deltas, use `start_response_and_wait`, which
correlates the `response.created` event (or the typed `error`) with the
`generation_id` it sent:

```python
from vox_rtc_server import ResponseOptions, ResponseOutputOptions

ack = await session.start_response_and_wait(
    ResponseOptions(
        output=ResponseOutputOptions(
            model="qwen3-tts:0.6b-clone",
            voice="samantha",
            language="fr",
            speed=0.9,
            params={"temperature": 0.7},
        )
    )
)
if ack.accepted:
    print("effective output:", ack.output)
    session.append_response_text("Hello.")
    session.commit_response()
else:
    print("start rejected:", ack.error.code if ack.error else None)
```

You can also thread your own generation id through every response command via
`ResponseOptions(generation_id="gen-42")`; response lifecycle events
(`ResponseEvent`, `InterruptionEvent`) expose the echoed `generation_id`.
The response-scoped `output` is optional. Vox fills omitted fields from the
session configuration and echoes the immutable effective selection on the
acknowledgement and `ResponseEvent`.

## Error handling

`ErrorEvent` carries `code` (stable slug), `recoverable`, and an optional
`generation_id` scoping the failure to one response generation. Known codes are
exported as `ERROR_CODE_*` constants (`response_rejected_turn_state`,
`response_rejected_user_speech`, `response_stale_generation`,
`response_already_active`, `response_failed`, `command_invalid`,
`session_failed`).

Only `recoverable is False` (or the transport itself closing) should end the
call. Recoverable errors are per-command failures: handle them and keep the
session running. Old Vox servers omit `code` and `recoverable`; the SDK then
defaults `recoverable` to `True`, so treat such errors as recoverable unless
the transport closed.

`on_signaling_error` surfaces the `rtc.signaling_error` control event (WebRTC
signaling failures such as a rejected local description) as a `SignalingErrorEvent`
carrying `message` and a numeric `generation`. This event is terminal: Vox closes
the session immediately after emitting it, so there is no `recoverable` field —
treat it as the end of the call, not a per-command error like the conversation
`error` stream.
