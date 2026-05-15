# vox-rtc-server

Server-side Rust SDK for controlling Vox-hosted WebRTC sessions.

This crate is for trusted backend applications. It creates Vox RTC sessions over
HTTP, joins the PondSocket control channel on `/v1/socket`, receives server-side
RTC events, and sends response/control commands.

```rust
use vox_rtc_server::{ResponseOptions, SessionConfig, VoxRtcServerClient};

#[tokio::main]
async fn main() -> vox_rtc_server::Result<()> {
    let client = VoxRtcServerClient::new("https://vox.example.com");
    let controlled = client.create_controlled_session().await?;

    controlled.session.configure(SessionConfig {
        stt_model: Some("parakeet-stt-onnx:tdt-0.6b-v3".into()),
        tts_model: Some("kokoro-tts-onnx:v1.0".into()),
        voice: Some("af_heart".into()),
        turn_profile: Some("browser_default".into()),
        ..Default::default()
    }).await?;

    let _transcripts = controlled.session.on_transcript(|event| {
        println!("user said: {}", event.transcript);
    });

    controlled.session.send_text_response(
        "Hello from Rust.",
        Some(ResponseOptions { allow_interruptions: Some(true) }),
        true,
    ).await?;

    Ok(())
}
```

If Vox requires `VOX_API_KEY`, pass it in `VoxRtcServerClientOptions` or set the
`VOX_API_KEY` environment variable. The key is used for both HTTP session
creation and the PondSocket control connection.
