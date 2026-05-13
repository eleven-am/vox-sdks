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
  audioElement: audio
});

client.on("state", (state) => {
  console.log(state.status, state.peerConnectionState, state.dataChannelState);
});

client.on("dataMessage", (message) => {
  console.log("backend event", message);
});

await client.connect();

client.sendEvent({
  event: "render.url",
  payload: { url: "https://example.com" }
});
```

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
