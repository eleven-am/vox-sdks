import assert from "node:assert/strict";
import test from "node:test";

import { VoxRtcBrowserClient } from "../src/client.js";
import type { EventSourceLike, VoxRtcBrowserSessionBootstrap } from "../src/types.js";

class MockMediaStream {
  readonly #tracks = [{ kind: "audio", stop: () => { this.stopped = true; } }];
  stopped = false;

  getAudioTracks() {
    return this.#tracks;
  }

  getTracks() {
    return this.#tracks;
  }
}

class MockDataChannel {
  readyState: RTCDataChannelState = "connecting";
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  label = "vox-events";

  send(message: string) {
    this.sent.push(message);
  }

  close() {
    this.readyState = "closed";
    this.onclose?.();
  }

  open() {
    this.readyState = "open";
    this.onopen?.();
  }
}

class MockPeerConnection {
  static instances: MockPeerConnection[] = [];

  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  dataChannel = new MockDataChannel();
  candidates: Array<RTCIceCandidateInit | null> = [];
  closed = false;
  senders: Array<{ track: { kind: string }, replaceTrack: (track: unknown) => Promise<void> }> = [];

  constructor(readonly configuration: RTCConfiguration) {
    MockPeerConnection.instances.push(this);
  }

  createDataChannel() {
    return this.dataChannel as unknown as RTCDataChannel;
  }

  addTrack(track: { kind: string }) {
    this.senders.push({ track, replaceTrack: async () => {} });
  }

  getSenders() {
    return this.senders;
  }

  async createOffer() {
    return { type: "offer" as RTCSdpType, sdp: "offer-sdp" };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description;
    this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: "candidate:1" }) } } as RTCPeerConnectionIceEvent);
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description;
  }

  async addIceCandidate(candidate: RTCIceCandidateInit | null) {
    this.candidates.push(candidate);
  }

  close() {
    this.closed = true;
  }
}

class MockEventSource implements EventSourceLike {
  static instances: MockEventSource[] = [];

  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
  closed = false;

  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data: unknown) {
    const event = { data: JSON.stringify(data) } as MessageEvent<string>;
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

const bootstrap: VoxRtcBrowserSessionBootstrap = {
  sessionId: "rtc_test",
  clientToken: "client_token",
  voxHttpBase: "https://vox.example.com",
  iceServers: [{ urls: "stun:example.com" }],
};

test("connect creates media session from sessionEndpoint", async () => {
  MockPeerConnection.instances = [];
  MockEventSource.instances = [];
  const requests: Array<{ url: string, init?: RequestInit }> = [];

  const client = new VoxRtcBrowserClient({
    sessionEndpoint: "/api/rtc/session",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url) === "/api/rtc/session") {
        return jsonResponse(bootstrap);
      }
      if (String(url).endsWith("/offer")) {
        return jsonResponse({
          session_id: "rtc_test",
          media_token: "media_token",
          type: "answer",
          sdp: "answer-sdp",
          events_url: "/events",
        });
      }
      if (String(url).endsWith("/candidates")) {
        return jsonResponse({});
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    getUserMedia: async () => new MockMediaStream() as unknown as MediaStream,
    peerConnectionFactory: (config) => new MockPeerConnection(config) as unknown as RTCPeerConnection,
    eventSourceFactory: (url) => new MockEventSource(url),
  });

  const states: string[] = [];
  client.on("state", (state) => states.push(state.status));

  const session = await client.connect();

  assert.equal(session.sessionId, "rtc_test");
  assert.equal(MockPeerConnection.instances[0].configuration.iceServers?.[0]?.urls, "stun:example.com");
  assert.equal(MockEventSource.instances[0].url, "https://vox.example.com/events");
  assert.equal(requests.some((request) => request.url === "/api/rtc/session"), true);
  assert.equal(requests.some((request) => request.url === "https://vox.example.com/v1/rtc/sessions/rtc_test/offer"), true);
  assert.equal(requests.some((request) => request.url === "https://vox.example.com/v1/rtc/sessions/rtc_test/candidates"), true);
  assert.equal(states.includes("connected"), true);
});

test("sendEvent writes app envelope to data channel", async () => {
  MockPeerConnection.instances = [];
  const client = new VoxRtcBrowserClient({
    session: bootstrap,
    fetch: async (url) => {
      if (String(url).endsWith("/offer")) {
        return jsonResponse({
          session_id: "rtc_test",
          media_token: "media_token",
          type: "answer",
          sdp: "answer-sdp",
          events_url: "/events",
        });
      }
      return jsonResponse({});
    },
    getUserMedia: async () => new MockMediaStream() as unknown as MediaStream,
    peerConnectionFactory: (config) => new MockPeerConnection(config) as unknown as RTCPeerConnection,
    eventSourceFactory: (url) => new MockEventSource(url),
  });

  await client.connect();
  const pc = MockPeerConnection.instances[0];
  pc.dataChannel.open();

  client.sendEvent({ event: "render.url", payload: { url: "https://example.com" } });

  assert.deepEqual(JSON.parse(pc.dataChannel.sent[0]), {
    event: "render.url",
    payload: { url: "https://example.com" },
  });
});

test("disconnect tears down browser resources", async () => {
  MockPeerConnection.instances = [];
  MockEventSource.instances = [];
  const mediaStream = new MockMediaStream();
  const client = new VoxRtcBrowserClient({
    session: bootstrap,
    fetch: async (url) => {
      if (String(url).endsWith("/offer")) {
        return jsonResponse({
          session_id: "rtc_test",
          media_token: "media_token",
          type: "answer",
          sdp: "answer-sdp",
          events_url: "/events",
        });
      }
      return jsonResponse({});
    },
    getUserMedia: async () => mediaStream as unknown as MediaStream,
    peerConnectionFactory: (config) => new MockPeerConnection(config) as unknown as RTCPeerConnection,
    eventSourceFactory: (url) => new MockEventSource(url),
  });

  await client.connect();
  await client.disconnect();

  assert.equal(MockPeerConnection.instances[0].closed, true);
  assert.equal(MockEventSource.instances[0].closed, true);
  assert.equal(mediaStream.stopped, true);
  assert.equal(client.state.status, "closed");
});
