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
    ..Default::default()
}).await?;
```

Pass the API key in `VoxRtcServerClientOptions` or set `VOX_API_KEY`.
