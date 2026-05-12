# Vox SDKs

Server-side SDKs for controlling Vox-hosted WebRTC sessions.

Current scope:

- Create RTC sessions over HTTP
- Attach to Vox RTC control channels over PondSocket on `/v1/socket`
- Send `session.update`, `response.*`, and `client.event` messages
- Receive RTC control events such as transcripts, turn state, interruption events, and response lifecycle events

This repository is intentionally narrow. It is for apps that manage Vox-hosted WebRTC calls. It is not the general STT/TTS/text SDK surface.

Packages:

- `typescript/vox-rtc-server`
- `go/rtcserver`
- `python/vox-rtc-server`

The browser media path stays separate. These SDKs are for backend/server control of RTC sessions.

## Versioning

Each package is versioned independently.

- Go module tags should use the module subdirectory prefix, for example:
  - `go/rtcserver/v0.1.0`
- TypeScript package versions live in:
  - `typescript/vox-rtc-server/package.json`
- Python package versions live in:
  - `python/vox-rtc-server/pyproject.toml`
