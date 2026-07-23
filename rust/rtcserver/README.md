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
`TranscriptEvent.speech_context` contains a typed `SpeechContext`; otherwise it
is `None`. Schema v2 exposes timestamped `emotions` and `vocal` speaker spans
plus environmental `sounds`. Each sound also carries a score from 0 to 1.

```rust
use vox_rtc_server::SpeechContextStatus;

if let Some(context) = transcript.speech_context.as_ref() {
    for emotion in context.emotions.iter().flatten() {
        println!("emotion={} {}..{}", emotion.label, emotion.start_ms, emotion.end_ms);
    }
    for sound in context.sounds.iter().flatten() {
        println!("sound={} score={}", sound.span.label, sound.score);
    }
    if context.status != SpeechContextStatus::Complete {
        println!("unavailable={:?}", context.unavailable);
    }
}
```

A partial result identifies the unavailable `Speaker` or `Sounds` track; a
failed result identifies both. Unsupported or malformed context is decoded as
`None` without dropping the transcript event.

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
use serde_json::{Map, json};
use std::time::Duration;
use vox_rtc_server::{ResponseOptions, ResponseOutputOptions};

let ack = controlled
    .session
    .start_response_and_wait(
        Some(ResponseOptions {
            output: Some(ResponseOutputOptions {
                model: Some("qwen3-tts:0.6b-clone".into()),
                voice: Some("samantha".into()),
                language: Some("fr".into()),
                speed: Some(0.9),
                params: Some(Map::from_iter([("temperature".into(), json!(0.7))])),
            }),
            ..Default::default()
        }),
        Duration::from_secs(5),
    )
    .await?;
if ack.accepted {
    println!("effective output: {:?}", ack.output);
    controlled.session.append_response_text("Hello.", None).await?;
    controlled.session.commit_response(None).await?;
}
```

`response.created` with the matching `generation_id` resolves the ack as
accepted; a typed `error` with the same `generation_id` resolves it as a
rejection carrying `error_code`, `error_message`, and `recoverable`.
The response-scoped `output` is optional. Vox fills omitted fields from the
session configuration and echoes the immutable effective selection in the
acknowledgement and `ResponseEvent`.

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
