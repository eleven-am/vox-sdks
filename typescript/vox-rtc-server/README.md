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

## Generation correlation

`startResponse`, `appendResponseText`, `commitResponse`, `cancelResponse`,
`replaceResponseText`, and `sendTextResponse` accept an optional `generationId`
(sent on the wire as `generation_id`). Response lifecycle events
(`onResponseCreated`, `onResponseCommitted`, `onResponseDone`,
`onResponseCancelled`, `onResponseAudioClear`, `onInterruptionDetected`,
`onInterruptionFalsePositive`) expose `generationId` when the server knows it.

Instead of fire-and-forget, gate delta pumping on the start acknowledgement:

```ts
const result = await session.startResponseAndWait({ timeoutMs: 5_000 });
if (result.accepted) {
  session.appendResponseText("Hello.", { generationId: result.generationId });
  session.commitResponse({ generationId: result.generationId });
} else {
  console.warn("start rejected", result.error.code, result.error.message);
}
```

`startResponseAndWait` sends `response.start` with a `generationId` (generated
when not supplied) and resolves on the correlated `response.created`, on the
correlated typed `error`, or with `{ accepted: false }` and the
`start_ack_timeout` code when no ack arrives within `timeoutMs` (default
10 000 ms).

## Error handling

`onError` events carry `message`, a stable `code`, `recoverable`, and an
optional `generationId` scoping the failure to one response generation. The
known codes are exported as `VOX_ERROR_CODES` (with the `VoxErrorCode` type and
the `isVoxErrorCode` guard): `response_rejected_turn_state`,
`response_rejected_user_speech`, `response_stale_generation`,
`response_already_active`, `response_failed`, `command_invalid`, and
`session_failed`.

Only `recoverable === false` (or the transport itself closing) should be
treated as call-ending. Recoverable errors are per-command failures: handle
them, abort the affected generation when `generationId` matches, and keep the
session running. Older Vox servers omit `code` and `recoverable`; the SDK
defaults `recoverable` to `true` in that case, so a missing field never ends
the call.

```ts
session.onError((event) => {
  if (!event.recoverable) {
    endCall(event.message);
    return;
  }
  if (event.generationId) {
    abortGeneration(event.generationId);
  }
});
```
