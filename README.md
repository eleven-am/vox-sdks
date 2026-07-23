# Vox RTC SDKs

SDKs for applications that create and control Vox-hosted WebRTC conversations.
They are intentionally separate from Vox's ordinary transcription and synthesis
APIs.

## Transport

The TypeScript, Python, Go, and Rust server SDKs create an RTC session over HTTP
and control it over PondSocket. The Elixir server SDK uses Vox's native gRPC RTC
service instead. Browser applications open one same-origin WebSocket to the
application gateway; the application keeps Vox credentials and its internal
Vox endpoint on the server.

The gateway proxies signaling and control only. Microphone and assistant audio
continue to flow directly between the browser and Vox over the negotiated
WebRTC ICE path. The application server never relays PCM.

## Packages

- `typescript/vox-rtc-client`: browser media and same-origin gateway signaling
- `typescript/vox-rtc-server`: PondSocket control and the application gateway
- `python/vox-rtc-server`: PondSocket control
- `go/rtcserver`: PondSocket control
- `rust/rtcserver`: PondSocket control
- `elixir/vox_rtc_server`: native gRPC control

See `typescript/examples/express-rtc-proxy` for a complete browser gateway
example.

## Speech context

The five server SDKs expose final-turn speech context as native language types,
not unstructured maps. Schema v2 contains timestamped speaker `emotions` and
`vocal` events plus scored environmental `sounds`. All implementations validate
the same canonical fixture at `fixtures/speech-context-v2.json`; malformed or
unsupported enrichment is omitted without dropping the transcript itself.

## Security boundary

Browser code receives public ICE configuration only. It never receives the
Vox API key, Vox hostname, internal PondSocket endpoint, or any Vox-issued
transport credential. Each WebSocket connection to the gateway owns exactly
one server-created session; frames on a connection can only ever address that
connection's session. Gateway lifecycle hooks receive the original incoming
request and complete server-side session; applications may inspect that
request (for example to enforce an Origin allowlist) or ignore it.

## Versioning

Each package is versioned independently.

- Go module tags use the module prefix, for example `go/rtcserver/v0.1.7`.
- TypeScript tags use `typescript/vox-rtc-client/vX.Y.Z` and
  `typescript/vox-rtc-server/vX.Y.Z`.
- Python and Rust versions live in their package manifests.
- Elixir releases use the `elixir/vox_rtc_server/vX.Y.Z` tag prefix and Hex
  package version.
