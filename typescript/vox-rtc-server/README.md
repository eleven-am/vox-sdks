# `@eleven-am/vox-rtc-server`

Server-side TypeScript SDK for Vox-hosted WebRTC sessions.

This package is for backend applications that need to:

- create RTC sessions over HTTP
- attach to `/v1/socket`
- join `/rtc/{session_id}`
- configure the session
- send responses and app events
- observe RTC control events

It is not the SDK for plain STT/TTS or generic non-RTC Vox APIs.

## Install

```bash
npm install @eleven-am/vox-rtc-server
```

Authentication:

- pass `apiKey` explicitly, or
- set `VOX_API_KEY` in the environment

## Example

```ts
import { VoxRtcServerClient } from "@eleven-am/vox-rtc-server";

const client = new VoxRtcServerClient({
  httpBase: "https://vox.example.com",
  apiKey: process.env.VOX_API_KEY
});

await client.connect();

const bootstrap = await client.createSession();
const rtc = await client.attachSession(bootstrap.sessionId);

rtc.onEvent((event) => {
  console.log(event.type, event.data);
});

rtc.configure({
  sttModel: "parakeet-stt-onnx:tdt-0.6b-v3",
  ttsModel: "kokoro-tts-onnx:v1.0",
  voice: "af_heart",
  turnProfile: "browser_default",
  vadBackend: "silero",
  turnDetector: "livekit"
});

rtc.sendTextResponse("Hello from the backend.");
```
