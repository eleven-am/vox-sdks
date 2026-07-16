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

## Audio ducking

Audio ducking changes playback volume while Vox decides whether detected speech
is a real interruption. Vox remains authoritative for VAD, interruption, and
response cancellation.

```ts
const client = new VoxRtcBrowserClient({
  signalingEndpoint: "/api/vox/rtc",
  audioElement,
  audioDucking: {
    mode: "vox",
    duckVolume: 0.2,
    sustainedVolume: 0.05,
    sustainedAfterMs: 700,
    releaseDelayMs: 350,
  },
});
```

Modes:

- `vox`: follow authoritative Vox speech and interruption events
- `local`: react immediately to microphone level, with possible speaker leakage
- `hybrid`: react locally, then retain ducking only when Vox confirms speech

The gateway already forwards the required Vox events. Applications do not need
another SSE or WebSocket connection.

## Private data

The opaque gateway capability is held inside the SDK. Session objects exposed
to application code contain only the session ID, ICE servers, and expiry
metadata. The client rejects gateway responses containing Vox tokens, internal
URLs, or other private connection fields.
