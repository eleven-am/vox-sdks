# Vox SDKs

Server-side SDKs for controlling Vox-hosted WebRTC sessions.

Current scope:

- Create RTC sessions over HTTP
- Attach to Vox RTC control channels over PondSocket on `/v1/socket`
- Send `session.update`, `response.*`, and `client.event` messages
- Receive RTC control events such as transcripts, turn state, interruption events, and response lifecycle events

This repository is intentionally narrow. It is for apps that manage Vox-hosted WebRTC calls. It is not the general STT/TTS/text SDK surface.

When Vox is configured with `VOX_API_KEY`, these SDKs authenticate the RTC session bootstrap over HTTP and the `/v1/socket` control connection automatically.

Packages:

- `typescript/vox-rtc-server`
- `typescript/vox-rtc-client`
- `go/rtcserver`
- `python/vox-rtc-server`
- `rust/rtcserver`

The server SDKs control RTC sessions from trusted backends. The browser client SDK joins the media path from frontend applications without holding a Vox API key.

Examples:

- `typescript/examples/express-rtc-proxy` serves a browser WebRTC test page and uses the TypeScript SDK from a tiny Express backend.

## Versioning

Each package is versioned independently.

- Go module tags should use the module subdirectory prefix, for example:
  - `go/rtcserver/v0.1.5`
- TypeScript package versions live in:
  - `typescript/vox-rtc-server/package.json`
- Python package versions live in:
  - `python/vox-rtc-server/pyproject.toml`
- Rust crate versions live in:
  - `rust/rtcserver/Cargo.toml`
