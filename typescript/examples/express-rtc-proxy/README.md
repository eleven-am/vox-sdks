# Express Vox RTC gateway example

This example keeps Vox's API key, internal hostname, and PondSocket endpoint on
the Express server. The React browser opens one
same-origin WebSocket at `/api/vox/rtc`; after full-trickle signaling, audio
flows directly between the browser and Vox over WebRTC.

The example uses one control transport for the entire session:

```text
browser -> application WebSocket -> TypeScript gateway -> PondSocket -> Vox
browser <---------------- direct WebRTC media -----------------------> Vox
```

It does not create per-operation HTTP or SSE signaling routes.

## Run

```bash
cd typescript/vox-rtc-client
npm install
npm run build

cd ../vox-rtc-server
npm install
npm run build

cd ../examples/express-rtc-proxy
npm install
npm run build
VOX_HTTP_BASE=http://vox-service.vox.svc.cluster.local:11435 \
VOX_API_KEY=... \
npm start
```

Open `http://127.0.0.1:8788`.

Optional configuration:

- `HOST` and `PORT`
- `VOX_STT_MODEL`
- `VOX_TTS_MODEL`
- `VOX_VOICE`
- `VOX_TURN_PROFILE`
- `VOX_VAD_BACKEND`
- `VOX_TURN_DETECTOR`

The server echoes each final transcript with streaming Vox TTS so signaling,
STT, conversation events, TTS, playout, interruption, and cleanup can be tested
through one call.

## Session lifecycle

`createVoxRtcGateway` owns its Vox client, controlled sessions, PondSocket
connection, signaling, and cleanup. `onSessionCreated` receives the original
incoming request and the complete server-side control session. Applications may
inspect the request or ignore it.
