# `@eleven-am/vox-rtc-server`

Trusted TypeScript SDK for Vox-hosted WebRTC conversations. It creates sessions
over HTTP and controls them over PondSocket, including through the browser
gateway.

It is not the SDK for ordinary transcription or synthesis requests.

## Install

```bash
npm install @eleven-am/vox-rtc-server
```

Pass `apiKey` explicitly or set `VOX_API_KEY`.

## Browser application gateway

Mount one WebSocket gateway on the application's HTTP server:

```ts
import { createServer } from "node:http";
import express from "express";
import { createVoxRtcGateway } from "@eleven-am/vox-rtc-server";

const app = express();
const server = createServer(app);

const gateway = createVoxRtcGateway({
  voxHttpBase: "http://vox-service.vox.svc.cluster.local:11435",
  apiKey: process.env.VOX_API_KEY,
  path: "/api/vox/rtc",
  onSessionCreated: async ({ request, session }) => {
    await registerCall(request, session.sessionId);
    session.configure({
      sttModel: "parakeet-stt:tdt-0.6b-v3",
      ttsModel: "kokoro-tts:v1.0",
      voice: "af_heart",
      turnProfile: "browser_default",
    });
    session.onTranscript((event) => console.log(event.transcript));
  },
  onSessionClosed: async ({ request, session, reason }) => {
    await releaseCall(request, session.sessionId, reason);
  },
});

const detachGateway = gateway.attach(server);
```

The browser needs only:

```ts
new VoxRtcBrowserClient({ signalingEndpoint: "/api/vox/rtc" });
```

The gateway owns its Vox client, controlled sessions, PondSocket connection,
and signaling lifecycle. `onSessionCreated` receives the original incoming
request and the complete trusted control session. Applications may inspect the
request or ignore it. If the hook throws, the gateway rolls the session back.
Closure hooks and session cleanup run exactly once.

On application shutdown:

```ts
detachGateway();
await gateway.close();
```

The browser sees only public ICE/session metadata. The gateway retains the Vox
hostname, API key, internal socket endpoint, and its opaque capability. Audio
remains direct browser-to-Vox WebRTC media.

## PondSocket control session

Applications that do not need the gateway can use the same server session
directly:

```ts
import { VoxRtcServerClient } from "@eleven-am/vox-rtc-server";

const vox = new VoxRtcServerClient({
  httpBase: "http://vox-service.vox.svc.cluster.local:11435",
  apiKey: process.env.VOX_API_KEY,
});
const { bootstrap, session } = await vox.createControlledSession();

session.onTranscript((event) => console.log("user said", event.transcript));
session.onBrowserEvent((event) => console.log(event.event, event.payload));
session.sendTextResponse("Hello from the backend.", {
  allowInterruptions: true,
});
session.sendClientEvent({
  event: "render.url",
  payload: { url: "https://example.com" },
});
```

`sendClientEvent` is server-to-browser. Browser-originated data-channel events
arrive through `onBrowserEvent`.
