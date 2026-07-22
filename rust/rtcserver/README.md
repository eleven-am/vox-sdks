# `vox-rtc-server`

Trusted Rust SDK for Vox-hosted WebRTC conversations. It creates sessions over
HTTP and controls them over PondSocket.

## PondSocket session

```rust
use vox_rtc_server::{SessionConfig, VoxRtcServerClient};

let client = VoxRtcServerClient::new("http://vox-service.vox.svc.cluster.local:11435")?;
let controlled = client.create_controlled_session().await?;
controlled.session.configure(SessionConfig {
    stt_model: Some("parakeet-stt:tdt-0.6b-v3".into()),
    tts_model: Some("kokoro-tts:v1.0".into()),
    voice: Some("af_heart".into()),
    turn_profile: Some("browser_default".into()),
    speech_context: Some(true),
    ..Default::default()
}).await?;
```

Pass the API key in `VoxRtcServerClientOptions` or set `VOX_API_KEY`.

Speech context is opt-in and final-only. When enabled,
`TranscriptEvent.speech_context` contains Vox's versioned prosody and dynamic
audio-event object; otherwise it is `None`.

## Responses and generation correlation

Response senders accept an optional caller-chosen generation id via
`ResponseOptions.generation_id`; it is emitted as `generation_id` on
`response.start`, `response.delta`, `response.commit`, and `response.cancel`.
When omitted, the session generates one on `start_response` and threads it
through the follow-up commands automatically. Lifecycle events
(`response.created|committed|done|cancelled`, `response.audio.clear`,
`interruption.*`) expose the correlated `generation_id` when known.

Use `start_response_and_wait` to gate delta pumping on the start
acknowledgement instead of fire-and-forget:

```rust
use std::time::Duration;

let ack = controlled
    .session
    .start_response_and_wait(None, Duration::from_secs(5))
    .await?;
if ack.accepted {
    controlled.session.append_response_text("Hello.", None).await?;
    controlled.session.commit_response(None).await?;
}
```

`response.created` with the matching `generation_id` resolves the ack as
accepted; a typed `error` with the same `generation_id` resolves it as a
rejection carrying `error_code`, `error_message`, and `recoverable`.

## Error handling

`error` events are typed: `code` is a stable slug (see the
`ERROR_CODE_*` constants), `recoverable` says whether the session remains
usable, and `generation_id` scopes the failure to one response generation
when present.

Only `recoverable == false` (or the transport itself closing) is
call-ending — close and recreate the session. Every recoverable error is a
per-command failure: abort the affected generation if `generation_id`
matches, otherwise log and continue. Old Vox servers omit `code` and
`recoverable`; the SDK defaults a missing `recoverable` to `true`, so treat
those errors as recoverable unless the transport closed.

`rtc.signaling_error` is a separate WebRTC signaling failure surfaced by
`on_signaling_error`. It is terminal: Vox emits `message` and an optional
numeric `generation`, then closes the session. There is no `recoverable`
field — treat it as call-ending and recreate the session.
