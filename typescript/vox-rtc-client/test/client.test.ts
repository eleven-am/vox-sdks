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

class MockAudioElement {
  volume = 0.8;
  srcObject: unknown = null;
  paused = false;
  loaded = false;
  removedAttributes: string[] = [];

  play() {
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
  }

  load() {
    this.loaded = true;
  }

  removeAttribute(name: string) {
    this.removedAttributes.push(name);
  }
}

class MockAnalyser {
  fftSize = 512;
  smoothingTimeConstant = 0;
  amplitude = 0;
  disconnected = false;

  getByteTimeDomainData(data: Uint8Array) {
    data.fill(128 + this.amplitude);
  }

  disconnect() {
    this.disconnected = true;
  }
}

class MockAudioSource {
  connectedTo: unknown = null;
  disconnected = false;

  connect(node: unknown) {
    this.connectedTo = node;
  }

  disconnect() {
    this.disconnected = true;
  }
}

class MockAudioContext {
  static instances: MockAudioContext[] = [];

  state: AudioContextState = "running";
  analyser = new MockAnalyser();
  source = new MockAudioSource();
  closed = false;

  constructor() {
    MockAudioContext.instances.push(this);
  }

  createMediaStreamSource() {
    return this.source as unknown as MediaStreamAudioSourceNode;
  }

  createAnalyser() {
    return this.analyser as unknown as AnalyserNode;
  }

  async resume() {}

  async close() {
    this.closed = true;
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

  removeTrack(sender: { track: { kind: string } }) {
    this.senders = this.senders.filter((item) => item !== sender);
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

  removeEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== listener));
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

test("onClientEvent receives server-sent client events", async () => {
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
  const received: unknown[] = [];
  client.onClientEvent((event) => received.push(event));

  pc.dataChannel.onmessage?.({
    data: JSON.stringify({
      event: "render.url",
      payload: { url: "https://example.com" },
    }),
  } as MessageEvent);

  assert.deepEqual(received, [{
    event: "render.url",
    payload: { url: "https://example.com" },
  }]);
});

test("sendEvent writes browser-originated event envelope to data channel", async () => {
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

  client.sendEvent({ event: "ui.select", payload: { id: "choice-a" } });

  assert.deepEqual(JSON.parse(pc.dataChannel.sent[0]), {
    event: "ui.select",
    payload: { id: "choice-a" },
  });
});

test("audioDucking lowers remote audio volume while microphone is active", async () => {
  MockPeerConnection.instances = [];
  MockAudioContext.instances = [];
  const previousAudioContext = (globalThis as { AudioContext?: unknown }).AudioContext;
  (globalThis as { AudioContext?: unknown }).AudioContext = MockAudioContext;
  try {
    const audioElement = new MockAudioElement();
    const client = new VoxRtcBrowserClient({
      session: bootstrap,
      audioElement: audioElement as unknown as HTMLAudioElement,
      audioDucking: {
        mode: "local",
        threshold: 0.1,
        duckVolume: 0.2,
        sustainedAfterMs: 60_000,
        releaseDelayMs: 0,
        pollIntervalMs: 16,
      },
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
    MockAudioContext.instances[0].analyser.amplitude = 64;
    await delay(25);
    assert.equal(audioElement.volume, 0.2);

    MockAudioContext.instances[0].analyser.amplitude = 0;
    await delay(25);
    assert.equal(audioElement.volume, 0.8);

    await client.disconnect();
    assert.equal(MockAudioContext.instances[0].closed, true);
    assert.equal(audioElement.volume, 0.8);
  } finally {
    if (previousAudioContext === undefined) {
      delete (globalThis as { AudioContext?: unknown }).AudioContext;
    } else {
      (globalThis as { AudioContext?: unknown }).AudioContext = previousAudioContext;
    }
  }
});

test("audioDucking defaults to Vox control events instead of microphone level", async () => {
  MockPeerConnection.instances = [];
  MockAudioContext.instances = [];
  const previousAudioContext = (globalThis as { AudioContext?: unknown }).AudioContext;
  delete (globalThis as { AudioContext?: unknown }).AudioContext;
  try {
    const audioElement = new MockAudioElement();
    const client = new VoxRtcBrowserClient({
      session: bootstrap,
      audioElement: audioElement as unknown as HTMLAudioElement,
      audioDucking: {
        duckVolume: 0.2,
        releaseDelayMs: 0,
      },
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
    assert.equal(MockAudioContext.instances.length, 0);
    assert.equal(audioElement.volume, 0.8);

    client.handleControlEvent({ type: "input_audio_buffer.speech_started" });
    assert.equal(audioElement.volume, 0.2);

    client.handleControlEvent({ type: "input_audio_buffer.speech_stopped" });
    assert.equal(audioElement.volume, 0.8);

    client.handleControlEvent({ type: "turn.state_changed", data: { state: "listening" } });
    assert.equal(audioElement.volume, 0.2);

    client.handleControlEvent({ type: "turn.state_changed", data: { state: "thinking" } });
    assert.equal(audioElement.volume, 0.8);

    await client.disconnect();
  } finally {
    if (previousAudioContext === undefined) {
      delete (globalThis as { AudioContext?: unknown }).AudioContext;
    } else {
      (globalThis as { AudioContext?: unknown }).AudioContext = previousAudioContext;
    }
  }
});

test("bindControlEventSource forwards app control events into audio ducking", () => {
  MockEventSource.instances = [];
  const audioElement = new MockAudioElement();
  const client = new VoxRtcBrowserClient({
    audioElement: audioElement as unknown as HTMLAudioElement,
    audioDucking: {
      duckVolume: 0.2,
      releaseDelayMs: 0,
    },
    eventSourceFactory: (url) => new MockEventSource(url),
  });

  const off = client.bindControlEventSource("/api/rtc/session/rtc_test/events");
  const source = MockEventSource.instances[0];

  assert.equal(source.url, "/api/rtc/session/rtc_test/events");
  source.onmessage?.({
    data: JSON.stringify({ type: "input_audio_buffer.speech_started" }),
  } as MessageEvent<string>);
  assert.equal(audioElement.volume, 0.2);

  source.onmessage?.({
    data: JSON.stringify({ type: "response.audio.clear" }),
  } as MessageEvent<string>);
  assert.equal(audioElement.volume, 0.8);

  off();
  assert.equal(source.closed, true);
  assert.equal(source.onmessage, null);
});

test("bindControlEventSource reports malformed control event JSON", () => {
  MockEventSource.instances = [];
  const client = new VoxRtcBrowserClient({
    audioDucking: true,
    eventSourceFactory: (url) => new MockEventSource(url),
  });
  const errors: string[] = [];
  client.on("error", (error) => errors.push(error.message));

  const off = client.bindControlEventSource("/events");
  MockEventSource.instances[0].onmessage?.({ data: "{" } as MessageEvent<string>);
  off();

  assert.equal(errors.length, 1);
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
  const pc = MockPeerConnection.instances[0];
  const eventSource = MockEventSource.instances[0];
  await client.disconnect();

  assert.equal(pc.closed, true);
  assert.equal(pc.onicecandidate, null);
  assert.equal(pc.ontrack, null);
  assert.equal(pc.dataChannel.onmessage, null);
  assert.equal(eventSource.closed, true);
  assert.equal(eventSource.onmessage, null);
  assert.equal(eventSource.listeners.get("rtc.ice_candidate")?.length, 0);
  assert.equal(mediaStream.stopped, true);
  assert.equal(client.state.status, "closed");
  assert.equal(client.state.sessionId, null);
});
