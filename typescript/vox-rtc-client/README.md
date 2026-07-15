# `@eleven-am/vox-rtc-client`

Browser-side SDK for Vox-hosted WebRTC media sessions.

This package is for frontend applications that need to:

- join a Vox RTC session with WebRTC
- capture microphone audio
- receive remote assistant audio
- handle Vox ICE candidate exchange
- send and receive app events over the Vox data channel

It does not hold a Vox API key. Create the RTC session from your backend with `@eleven-am/vox-rtc-server`, then pass the returned bootstrap to this browser client.

## Install

```bash
npm install @eleven-am/vox-rtc-client
```

## Example

```ts
import { VoxRtcBrowserClient } from "@eleven-am/vox-rtc-client";

const audio = document.querySelector("audio")!;

const client = new VoxRtcBrowserClient({
  sessionEndpoint: "/api/rtc/session",
  audioElement: audio,
  audioDucking: {
    duckVolume: 0.2,
    sustainedVolume: 0.05
  }
});

client.on("state", (state) => {
  console.log(state.status, state.peerConnectionState, state.dataChannelState);
});

client.onClientEvent((message) => {
  console.log("server event", message.event, message.payload);
});

await client.connect();

client.sendEvent({
  event: "ui.select",
  payload: { id: "choice-a" }
});
```

`onClientEvent` receives events the backend sent with `sendClientEvent`.
`sendEvent` sends browser-originated app events to the backend as `browser.event`.

## Session Sources

Use one of:

```ts
new VoxRtcBrowserClient({ sessionEndpoint: "/api/rtc/session" });
```

```ts
new VoxRtcBrowserClient({
  session: async () => {
    const response = await fetch("/api/rtc/session", { method: "POST" });
    return response.json();
  }
});
```

```ts
new VoxRtcBrowserClient({
  httpBase: "https://vox.example.com",
  session: {
    sessionId: "...",
    clientToken: "...",
    iceServers: []
  }
});
```

The first two shapes are preferred for real apps because the backend can keep `VOX_API_KEY` private.

## Audio Ducking

Pass `audioDucking: true` or an options object to lower the provided audio element while Vox decides whether to interrupt the assistant. This is client-side UX only; Vox still owns VAD, interruption detection, and response cancellation.

By default, ducking follows Vox control events. Your backend should forward the relevant Vox events to the browser, then call `client.handleControlEvent(event)`. If your backend exposes those events as a JSON server-event stream, use `bindControlEventSource`.

```ts
new VoxRtcBrowserClient({
  sessionEndpoint: "/api/rtc/session",
  audioElement: audio,
  audioDucking: {
    threshold: 0.035,
    duckVolume: 0.2,
    sustainedVolume: 0.05,
    sustainedAfterMs: 700,
    releaseDelayMs: 350
  }
});
```

```ts
// from your app's server-events/WebSocket bridge
client.handleControlEvent({
  type: "input_audio_buffer.speech_started"
});
```

```ts
const stopControlEvents = client.bindControlEventSource(
  `/api/rtc/session/${sessionId}/events`
);

// later
stopControlEvents();
```

`response.audio.clear` is treated as a ducking release signal. It does not remove
or stop Vox media by itself; pause or reset your own `<audio>` element if your app
wants visible playback controls to reflect the clear event immediately.

Supported modes:

- `vox`: duck only when your app forwards Vox control events. This avoids self-ducking from speaker leakage.
- `local`: duck immediately from local microphone level. This is fastest but can self-duck if echo cancellation leaks assistant audio into the mic.
- `hybrid`: duck immediately from local microphone level, then hold only if Vox confirms speech through forwarded control events.
