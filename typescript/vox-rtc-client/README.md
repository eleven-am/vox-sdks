# `@eleven-am/vox-rtc-client`

Browser WebRTC client for Vox conversations. It captures microphone audio,
plays assistant audio, performs full-trickle ICE, and receives Vox control
events through one application-owned signaling endpoint.

## Install

```bash
npm install @eleven-am/vox-rtc-client
```

## Connect

```ts
import { VoxRtcBrowserClient } from "@eleven-am/vox-rtc-client";

const client = new VoxRtcBrowserClient({
  signalingEndpoint: "/api/vox/rtc",
  audioElement: document.querySelector("audio")!,
  audioConstraints: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
  audioDucking: true,
});

client.on("state", (state) => {
  console.log(state.status, state.peerConnectionState, state.iceConnectionState);
});

client.on("signalingMessage", (event) => {
  if (event.type === "conversation.item.input_audio_transcription.completed") {
    console.log("user said", event.data.transcript);
  }
});

client.onClientEvent((event) => {
  console.log("server event", event.event, event.payload);
});

await client.connect();
```

`signalingEndpoint` must be a same-origin path. Direct Vox URLs, direct session
bootstraps, route collections, and EventSource control bridges are not supported.

## Signaling and media

The client opens one WebSocket to the application gateway. It sends the SDP
offer, each local ICE candidate, and explicit end-of-candidates as they become
available. Vox's answer and candidates arrive over the same socket. Candidates
that arrive before the matching answer are buffered and applied in order.

After negotiation, media flows directly between the browser and Vox. The
application gateway does not relay audio.

Use a real ICE restart when the network path changes:

```ts
await client.restartIce();
```

Only one negotiation may run at a time. A failed restart closes the signaling
session and media rather than leaving a partially controlled call alive.

## Application events

Server-to-browser events sent by the server session's `sendClientEvent` arrive
over the WebRTC data channel:

```ts
client.onClientEvent(({ event, payload }) => {
  console.log(event, payload);
});
```

Browser-to-server events use the same data channel and arrive on the server as
`browser.event`:

```ts
client.sendEvent({ event: "ui.select", payload: { id: "choice-a" } });
```

## Error handling

Vox session `error` frames arrive over the gateway signaling socket and are
surfaced as typed session errors:

```ts
import { isFatalVoxError, isVoxErrorCode } from "@eleven-am/vox-rtc-client";

client.onSessionError((error) => {
  if (isFatalVoxError(error)) {
    endCallUi(error.message ?? "Call session error");
    return;
  }
  console.warn("recoverable Vox error", error.code, error.generationId);
});
```

Each conversation `error` frame carries `message`, `code`, `recoverable`, and
`generationId`. `code` values are the stable contract set exported as
`VOX_ERROR_CODES` (check membership with `isVoxErrorCode`). Old Vox servers
omit `code` and `recoverable`; the SDK normalizes an empty `code` to
`undefined` and treats missing `recoverable` as `true`.

A WebRTC signaling failure (`rtc.signaling_error`, which Vox sends as
`{ message, generation }`) is different: it is terminal — Vox closes the session
immediately after emitting it. It surfaces through the same `onSessionError`
channel with `recoverable: false` and no `code` or `generationId`, so
`isFatalVoxError` is always `true` for it.

Only a fatal error (`recoverable === false`, which includes
`code === "session_failed"`) or an actual transport/connection failure (the
`error` event, an unexpected gateway close, or a failed `connect()`) should end
the call UI. Recoverable errors are per-command failures: the session stays
healthy, so handle them in place — for example, stop pumping the generation
named by `generationId` after a `response_stale_generation` error — and keep
the call running.

Browser-native data-channel events correlated to a response
(`response.created`, `response.done`, `response.cancelled`,
`response.audio.clear`, `interruption.detected`,
`interruption.false_positive`) expose `generationId` on the envelope when the
server supplies one:

```ts
client.onClientEvent(({ event, generationId }) => {
  if (event === "response.cancelled" && generationId) {
    abortGeneration(generationId);
  }
});
```

## Audio ducking

Audio ducking changes playback volume while Vox decides whether detected speech
is a real interruption. Vox remains authoritative for VAD, interruption, and
response cancellation.

```ts
const client = new VoxRtcBrowserClient({
  signalingEndpoint: "/api/vox/rtc",
  audioElement,
  audioDucking: {
    duckVolume: 0.2,
    releaseDelayMs: 350,
  },
});
```

Ducking follows the authoritative Vox speech and interruption events that the
gateway already forwards, so applications do not need another SSE or WebSocket
connection. Vox owns the interruption decision; ducking only adjusts local
playback volume while that decision is pending.

## Private data

Session objects exposed to application code contain only the session ID, ICE
servers, and expiry metadata. The Vox API key, internal hostname, and socket
endpoint stay on the gateway and never reach the browser.
