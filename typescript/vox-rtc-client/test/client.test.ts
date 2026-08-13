import assert from "node:assert/strict";
import test from "node:test";

import { VoxRtcBrowserClient } from "../src/client.js";
import { isFatalVoxError } from "../src/errors.js";
import type { VoxRtcSessionError } from "../src/errors.js";
import type { VoxRtcClientEventEnvelope, WebSocketLike } from "../src/types.js";

const READY_SESSION = {
  sessionId: "rtc_private",
  iceServers: [{ urls: ["stun:turn.example.test:3478"] }],
  expiresAt: "2026-07-16T12:00:00Z",
  attachTtlSeconds: 120,
};

class MockMediaStream {
  readonly #tracks = [
    {
      kind: "audio",
      stop: () => {
        this.stopped = true;
      },
    },
  ];
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
  muted = false;
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
  restartCalls = 0;
  offerOptions: Array<RTCOfferOptions | undefined> = [];
  offerCount = 0;
  senders: Array<{
    track: { kind: string };
    replaceTrack: (track: unknown) => Promise<void>;
  }> = [];

  constructor(
    readonly configuration: RTCConfiguration,
    readonly autoConnect = true,
  ) {
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
  getTransceivers() {
    return [];
  }
  removeTrack(sender: { track: { kind: string } }) {
    this.senders = this.senders.filter((item) => item !== sender);
  }
  restartIce() {
    this.restartCalls += 1;
  }
  async createOffer(options?: RTCOfferOptions) {
    this.offerOptions.push(options);
    this.offerCount += 1;
    return { type: "offer" as RTCSdpType, sdp: `offer-sdp-${this.offerCount}` };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description;
    this.onicecandidate?.({
      candidate: {
        toJSON: () => ({
          candidate: "candidate:browser",
          sdpMid: "0",
          sdpMLineIndex: 0,
          usernameFragment: "browser-ufrag",
        }),
      },
    } as RTCPeerConnectionIceEvent);
    this.onicecandidate?.({ candidate: null } as RTCPeerConnectionIceEvent);
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description;
    if (this.autoConnect) {
      queueMicrotask(() => this.setConnectionState("connected", "connected"));
    }
  }
  async addIceCandidate(candidate: RTCIceCandidateInit | null) {
    this.candidates.push(candidate);
  }
  close() {
    this.closed = true;
  }
  setConnectionState(
    connectionState: RTCPeerConnectionState,
    iceConnectionState: RTCIceConnectionState = this.iceConnectionState,
  ) {
    this.connectionState = connectionState;
    this.iceConnectionState = iceConnectionState;
    this.oniceconnectionstatechange?.();
    this.onconnectionstatechange?.();
  }
}

type ClientMessage = {
  id: string;
  type: string;
  data: Record<string, unknown>;
};

class MockWebSocket implements WebSocketLike {
  static instances: MockWebSocket[] = [];
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  sent: ClientMessage[] = [];
  onSend?: (message: ClientMessage) => void;

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }
  open(readyData: Record<string, unknown> = {}) {
    this.readyState = 1;
    this.onopen?.({} as Event);
    this.server("gateway.ready", {
      session: READY_SESSION,
      ...readyData,
    });
  }
  send(data: string) {
    const message = JSON.parse(data) as ClientMessage;
    this.sent.push(message);
    this.onSend?.(message);
  }
  server(type: string, data: Record<string, unknown>, id?: string) {
    this.onmessage?.({
      data: JSON.stringify({ ...(id ? { id } : {}), type, data }),
    } as MessageEvent<string>);
  }
  fail() {
    this.onerror?.({} as Event);
  }
  close(code = 1000, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

function delay(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function itemAt<T>(items: readonly T[], index: number, label: string): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`Missing ${label} at index ${index}`);
  }
  return item;
}

function createHarness(
  options: {
    readyData?: Record<string, unknown>;
    onSocket?: (socket: MockWebSocket) => void;
    client?: Partial<ConstructorParameters<typeof VoxRtcBrowserClient>[0]>;
    autoConnect?: boolean;
  } = {},
) {
  MockPeerConnection.instances = [];
  MockWebSocket.instances = [];
  const stream = new MockMediaStream();
  const sockets: MockWebSocket[] = [];
  const client = new VoxRtcBrowserClient({
    signalingEndpoint: "/api/vox/rtc",
    signalingTimeoutMs: 250,
    peerConnectionFactory: (configuration) =>
      new MockPeerConnection(
        configuration,
        options.autoConnect ?? true,
      ) as unknown as RTCPeerConnection,
    getUserMedia: async () => stream as unknown as MediaStream,
    webSocketFactory: (url) => {
      const socket = new MockWebSocket(url);
      sockets.push(socket);
      options.onSocket?.(socket);
      queueMicrotask(() => socket.open(options.readyData));
      return socket;
    },
    ...options.client,
  });
  return { client, sockets, stream };
}

function assertPeerReleased(pc: MockPeerConnection): void {
  assert.equal(pc.closed, true);
  assert.equal(pc.ontrack, null);
  assert.equal(pc.ondatachannel, null);
  assert.equal(pc.onicecandidate, null);
  assert.equal(pc.onconnectionstatechange, null);
  assert.equal(pc.oniceconnectionstatechange, null);
  assert.equal(pc.dataChannel.onopen, null);
  assert.equal(pc.dataChannel.onclose, null);
  assert.equal(pc.dataChannel.onerror, null);
  assert.equal(pc.dataChannel.onmessage, null);
}

function assertSignalingReleased(socket: MockWebSocket): void {
  assert.equal(socket.onopen, null);
  assert.equal(socket.onmessage, null);
  assert.equal(socket.onerror, null);
  assert.equal(socket.onclose, null);
}

function answerOffers(
  socket: MockWebSocket,
  beforeAnswer?: (message: ClientMessage) => void,
): void {
  socket.onSend = (message) => {
    if (message.type !== "rtc.offer") return;
    beforeAnswer?.(message);
    queueMicrotask(() => {
      socket.server(
        "rtc.answer",
        {
          session_id: READY_SESSION.sessionId,
          answer: { type: "answer", sdp: "answer-sdp" },
        },
        message.id,
      );
    });
  };
}

test("connect uses one same-origin WebSocket and performs full trickle in order", async () => {
  const { client, sockets } = createHarness({
    onSocket: (socket) =>
      answerOffers(socket, (message) => {
        socket.server("rtc.ice_candidate", {
          generation: message.data.generation,
          candidate: {
            candidate: "candidate:server",
            sdpMid: "0",
            sdpMLineIndex: 0,
            usernameFragment: "server-ufrag",
          },
        });
        socket.server("rtc.ice_candidate", {
          candidate: null,
          generation: message.data.generation,
        });
      }),
  });

  const session = await client.connect();
  const socket = itemAt(sockets, 0, "gateway socket");
  const pc = itemAt(MockPeerConnection.instances, 0, "peer connection");
  assert.equal(socket.url, "/api/vox/rtc");
  assert.deepEqual(session, READY_SESSION);
  assert.deepEqual(
    socket.sent.map((message) => message.type),
    ["rtc.offer", "rtc.ice_candidate", "rtc.ice_candidate"],
  );
  assert.deepEqual(
    socket.sent.map((message) => message.data.generation),
    [1, 1, 1],
  );
  assert.equal(
    (
      itemAt(socket.sent, 1, "local ICE candidate").data
        .candidate as RTCIceCandidateInit
    ).sdpMLineIndex,
    0,
  );
  assert.equal(
    itemAt(socket.sent, 2, "end-of-candidates").data.candidate,
    null,
  );
  assert.equal(pc.remoteDescription?.sdp, "answer-sdp");
  assert.deepEqual(pc.candidates, [
    {
      candidate: "candidate:server",
      sdpMid: "0",
      sdpMLineIndex: 0,
      usernameFragment: "server-ufrag",
    },
    null,
  ]);
  assert.equal(JSON.stringify(session).includes("capability"), false);
  await client.disconnect();
});

test("connect remains pending after SDP until the peer connection is connected", async () => {
  const { client } = createHarness({
    onSocket: answerOffers,
    autoConnect: false,
  });
  let settled = false;
  const connecting = client.connect();
  void connecting.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  await delay();
  const pc = itemAt(MockPeerConnection.instances, 0, "peer connection");
  assert.equal(pc.remoteDescription?.sdp, "answer-sdp");
  assert.equal(pc.connectionState, "new");
  assert.equal(client.state.status, "connecting");
  assert.equal(settled, false);

  pc.setConnectionState("connected", "connected");
  await connecting;
  assert.equal(client.state.status, "connected");
  await client.disconnect();
});

test("peer failure before media connection rejects connect and releases resources", async () => {
  const { client, sockets, stream } = createHarness({
    onSocket: answerOffers,
    autoConnect: false,
  });
  const connecting = client.connect();
  const rejected = assert.rejects(connecting, /RTC media connection failed/);
  await delay();
  const pc = itemAt(MockPeerConnection.instances, 0, "peer connection");

  pc.setConnectionState("failed", "failed");
  await rejected;

  assert.equal(client.state.status, "closed");
  assert.equal(stream.stopped, true);
  const socket = itemAt(sockets, 0, "gateway socket");
  assert.equal(socket.readyState, 3);
  assertSignalingReleased(socket);
  assertPeerReleased(pc);
});

test("peer close before media connection rejects connect and releases resources", async () => {
  const { client, sockets, stream } = createHarness({
    onSocket: answerOffers,
    autoConnect: false,
  });
  const connecting = client.connect();
  const rejected = assert.rejects(connecting, /RTC media connection closed/);
  await delay();
  const pc = itemAt(MockPeerConnection.instances, 0, "peer connection");

  pc.setConnectionState("closed", "closed");
  await rejected;

  assert.equal(client.state.status, "closed");
  assert.equal(stream.stopped, true);
  assertSignalingReleased(itemAt(sockets, 0, "gateway socket"));
  assertPeerReleased(pc);
});

test("media connection timeout rejects connect and releases resources", async () => {
  const { client, sockets, stream } = createHarness({
    onSocket: answerOffers,
    autoConnect: false,
    client: { mediaConnectionTimeoutMs: 10 },
  });

  await assert.rejects(client.connect(), /RTC media connection timed out after 10ms/);

  const pc = itemAt(MockPeerConnection.instances, 0, "peer connection");
  assert.equal(client.state.status, "closed");
  assert.equal(stream.stopped, true);
  const socket = itemAt(sockets, 0, "gateway socket");
  assert.equal(socket.readyState, 3);
  assertSignalingReleased(socket);
  assertPeerReleased(pc);
});

test("signaling close while media connection is pending rejects without hanging", async () => {
  const { client, sockets, stream } = createHarness({
    onSocket: answerOffers,
    autoConnect: false,
  });
  const connecting = client.connect();
  const rejected = assert.rejects(connecting, /RTC gateway closed unexpectedly: server_failed/);
  await delay();
  const pc = itemAt(MockPeerConnection.instances, 0, "peer connection");

  const socket = itemAt(sockets, 0, "gateway socket");
  socket.close(1011, "server_failed");
  await rejected;

  assert.equal(client.state.status, "closed");
  assert.equal(stream.stopped, true);
  assertSignalingReleased(socket);
  assertPeerReleased(pc);
});

test("disconnect while media connection is pending cancels connect and releases resources", async () => {
  const { client, sockets, stream } = createHarness({
    onSocket: answerOffers,
    autoConnect: false,
  });
  const connecting = client.connect();
  const rejected = assert.rejects(connecting, /RTC media connection attempt was cancelled/);
  await delay();
  const pc = itemAt(MockPeerConnection.instances, 0, "peer connection");

  await client.disconnect();
  await rejected;

  assert.equal(client.state.status, "closed");
  assert.equal(stream.stopped, true);
  assertSignalingReleased(itemAt(sockets, 0, "gateway socket"));
  assertPeerReleased(pc);
});

test("connected peer failure is terminal instead of leaving stale connected status", async () => {
  const { client, sockets, stream } = createHarness({ onSocket: answerOffers });
  const errors: string[] = [];
  client.on("error", (error) => errors.push(error.message));
  await client.connect();
  const pc = itemAt(MockPeerConnection.instances, 0, "peer connection");

  pc.setConnectionState("failed", "failed");

  assert.equal(client.state.status, "closed");
  assert.equal(stream.stopped, true);
  assert.deepEqual(errors, ["RTC media connection failed"]);
  assertSignalingReleased(itemAt(sockets, 0, "gateway socket"));
  assertPeerReleased(pc);
});

test("gateway events queued before ready are replayed after session setup", async () => {
  const { client, sockets } = createHarness({
    onSocket: (socket) => {
      answerOffers(socket);
      queueMicrotask(() =>
        socket.server("turn.state_changed", { state: "listening" }),
      );
    },
  });
  const events: string[] = [];
  client.on("signalingMessage", (event) => events.push(event.type));
  await client.connect();
  assert.ok(events.includes("turn.state_changed"));
  assert.equal(sockets.length, 1);
  await client.disconnect();
});

test("signaling endpoint rejects cross-origin URLs", () => {
  assert.throws(
    () =>
      new VoxRtcBrowserClient({
        signalingEndpoint: "https://vox.example.com/rtc",
      }),
    /same-origin path/,
  );
});

test("browser-originated signaling events are observable but are not reflected as client events", async () => {
  const { client, sockets } = createHarness({ onSocket: answerOffers });
  const clientEvents: unknown[] = [];
  const signalingEvents: string[] = [];
  client.onClientEvent((event) => clientEvents.push(event));
  client.on("signalingMessage", (event) => signalingEvents.push(event.type));
  await client.connect();
  itemAt(sockets, 0, "gateway socket").server("browser.event", {
    event: "app.notice",
    payload: { ok: true },
  });
  assert.deepEqual(clientEvents, []);
  assert.deepEqual(signalingEvents, ["browser.event"]);
  await client.disconnect();
});

test("onClientEvent receives server-originated application events from the data channel", async () => {
  const { client } = createHarness({ onSocket: answerOffers });
  const events: unknown[] = [];
  client.onClientEvent((event) => events.push(event));
  await client.connect();
  const channel = itemAt(
    MockPeerConnection.instances,
    0,
    "peer connection",
  ).dataChannel;
  channel.onmessage?.({
    data: JSON.stringify({ event: "app.notice", payload: { ok: true } }),
  } as MessageEvent<string>);
  assert.deepEqual(events, [{ event: "app.notice", payload: { ok: true } }]);
  await client.disconnect();
});

test("remote audio reaches the browser only through the peer connection track", async () => {
  const audio = new MockAudioElement();
  const { client, sockets } = createHarness({
    onSocket: answerOffers,
    client: { audioElement: audio as unknown as HTMLAudioElement },
  });
  const remote = new MockMediaStream();
  const remoteEvents: unknown[] = [];
  client.on("remoteStream", (stream) => remoteEvents.push(stream));

  await client.connect();
  const socket = itemAt(sockets, 0, "gateway socket");
  const pc = itemAt(MockPeerConnection.instances, 0, "peer connection");
  const signalingCount = socket.sent.length;
  pc.ontrack?.({
    streams: [remote as unknown as MediaStream],
  } as RTCTrackEvent);

  assert.equal(audio.srcObject, remote);
  assert.deepEqual(remoteEvents, [remote]);
  assert.equal(socket.sent.length, signalingCount);
  await client.disconnect();
});

test("restartIce performs a second full-trickle negotiation and buffers candidates until its answer", async () => {
  const { client, sockets } = createHarness({ onSocket: answerOffers });
  await client.connect();
  const socket = itemAt(sockets, 0, "gateway socket");
  const pc = itemAt(MockPeerConnection.instances, 0, "peer connection");
  socket.sent = [];
  pc.candidates = [];
  socket.onSend = (message) => {
    if (message.type !== "rtc.offer") return;
    socket.server("rtc.ice_candidate", {
      generation: 1,
      candidate: {
        candidate: "candidate:stale-server",
        sdpMid: "0",
        sdpMLineIndex: 0,
        usernameFragment: "stale-ufrag",
      },
    });
    socket.server("rtc.ice_candidate", {
      generation: message.data.generation,
      candidate: {
        candidate: "candidate:restart-server",
        sdpMid: "0",
        sdpMLineIndex: 0,
        usernameFragment: "restart-ufrag",
      },
    });
    assert.deepEqual(pc.candidates, []);
    queueMicrotask(() => {
      socket.server(
        "rtc.answer",
        {
          session_id: READY_SESSION.sessionId,
          answer: { type: "answer", sdp: "restart-answer-sdp" },
        },
        message.id,
      );
    });
  };

  await client.restartIce();

  assert.equal(pc.restartCalls, 1);
  assert.deepEqual(pc.offerOptions, [undefined, { iceRestart: true }]);
  assert.deepEqual(
    socket.sent.map((message) => message.type),
    ["rtc.offer", "rtc.ice_candidate", "rtc.ice_candidate"],
  );
  assert.equal(itemAt(socket.sent, 0, "restart offer").data.restart, true);
  assert.deepEqual(
    socket.sent.map((message) => message.data.generation),
    [2, 2, 2],
  );
  assert.equal(pc.remoteDescription?.sdp, "restart-answer-sdp");
  assert.deepEqual(pc.candidates, [
    {
      candidate: "candidate:restart-server",
      sdpMid: "0",
      sdpMLineIndex: 0,
      usernameFragment: "restart-ufrag",
    },
  ]);
  await client.disconnect();
});

test("sendEvent writes browser-originated events to the WebRTC data channel", async () => {
  const { client } = createHarness({ onSocket: answerOffers });
  await client.connect();
  const channel = itemAt(
    MockPeerConnection.instances,
    0,
    "peer connection",
  ).dataChannel;
  channel.open();
  client.sendEvent({ event: "app.selection", payload: { id: 7 } });
  assert.deepEqual(JSON.parse(itemAt(channel.sent, 0, "data-channel event")), {
    event: "app.selection",
    payload: { id: 7 },
  });
  await client.disconnect();
});

function createDuckingHarness(releaseDelayMs = 0) {
  const audio = new MockAudioElement();
  const harness = createHarness({
    onSocket: answerOffers,
    client: {
      audioElement: audio as unknown as HTMLAudioElement,
      audioDucking: { duckVolume: 0.2, releaseDelayMs },
    },
  });
  return { ...harness, audio };
}

function assertPlaybackIntact(audio: MockAudioElement): void {
  assert.equal(audio.paused, false);
  assert.equal(audio.loaded, false);
  assert.deepEqual(audio.removedAttributes, []);
}

test("Vox speech events drive audio ducking over the gateway", async () => {
  const { client, sockets, audio } = createDuckingHarness();
  await client.connect();
  const socket = itemAt(sockets, 0, "gateway socket");
  socket.server("input_audio_buffer.speech_started", {});
  assert.equal(audio.volume, 0.2);
  socket.server("interruption.false_positive", {});
  await delay();
  assert.equal(audio.volume, 0.8);
  await client.disconnect();
});

test("candidate playout suspension mutes data-channel audio until the matching resume", async () => {
  const audio = new MockAudioElement();
  const { client } = createHarness({
    onSocket: answerOffers,
    client: { audioElement: audio as unknown as HTMLAudioElement },
  });
  await client.connect();
  const pc = itemAt(MockPeerConnection.instances, 0, "peer connection");

  pc.dataChannel.onmessage?.({
    data: JSON.stringify({
      event: "response.audio.suspend",
      payload: { response_id: "resp_1", candidate_id: 17 },
    }),
  } as MessageEvent);
  assert.equal(audio.muted, true);

  pc.dataChannel.onmessage?.({
    data: JSON.stringify({
      event: "response.audio.resume",
      payload: { response_id: "resp_1", candidate_id: 16 },
    }),
  } as MessageEvent);
  assert.equal(audio.muted, true);

  pc.dataChannel.onmessage?.({
    data: JSON.stringify({
      event: "response.audio.resume",
      payload: { response_id: "resp_1", candidate_id: 17 },
    }),
  } as MessageEvent);
  assert.equal(audio.muted, false);
  assertPlaybackIntact(audio);
  await client.disconnect();
});

test("candidate playout suspension restores a preexisting user mute", async () => {
  const audio = new MockAudioElement();
  audio.muted = true;
  const { client } = createHarness({
    onSocket: answerOffers,
    client: { audioElement: audio as unknown as HTMLAudioElement },
  });
  await client.connect();
  const pc = itemAt(MockPeerConnection.instances, 0, "peer connection");

  pc.dataChannel.onmessage?.({
    data: JSON.stringify({ event: "response.audio.suspend", payload: { candidate_id: 4 } }),
  } as MessageEvent);
  pc.dataChannel.onmessage?.({
    data: JSON.stringify({ event: "response.audio.resume", payload: { candidate_id: 4 } }),
  } as MessageEvent);

  assert.equal(audio.muted, true);
  await client.disconnect();
});

test("disconnect releases an unresolved candidate playout suspension", async () => {
  const audio = new MockAudioElement();
  const { client } = createHarness({
    onSocket: answerOffers,
    client: { audioElement: audio as unknown as HTMLAudioElement },
  });
  await client.connect();
  const pc = itemAt(MockPeerConnection.instances, 0, "peer connection");

  pc.dataChannel.onmessage?.({
    data: JSON.stringify({ event: "response.audio.suspend", payload: { candidate_id: 9 } }),
  } as MessageEvent);
  assert.equal(audio.muted, true);

  await client.disconnect();

  assert.equal(audio.muted, false);
});

test("speech onset ducks a full turn-state round trip before the held state lands", async () => {
  const { client, sockets, audio } = createDuckingHarness();
  await client.connect();
  const socket = itemAt(sockets, 0, "gateway socket");
  socket.server("turn.state_changed", { state: "speaking", previous_state: "thinking" });
  assert.equal(audio.volume, 0.8);

  socket.server("input_audio_buffer.speech_started", { timestamp_ms: 900 });
  assert.equal(audio.volume, 0.2);

  socket.server("turn.state_changed", { state: "paused", previous_state: "speaking" });
  assert.equal(audio.volume, 0.2);
  assertPlaybackIntact(audio);
  await client.disconnect();
});

test("a held turn state ducks playback on its own and releases when Vox resumes speaking", async () => {
  const { client, sockets, audio } = createDuckingHarness();
  await client.connect();
  const socket = itemAt(sockets, 0, "gateway socket");
  socket.server("turn.state_changed", { state: "paused", previous_state: "speaking" });
  assert.equal(audio.volume, 0.2);
  assertPlaybackIntact(audio);

  socket.server("turn.state_changed", { state: "speaking", previous_state: "paused" });
  await delay();
  assert.equal(audio.volume, 0.8);
  assertPlaybackIntact(audio);
  await client.disconnect();
});

test("a held output stays ducked through the speech_stopped that precedes the final transcript", async () => {
  const { client, sockets, audio } = createDuckingHarness();
  await client.connect();
  const socket = itemAt(sockets, 0, "gateway socket");
  socket.server("turn.state_changed", { state: "speaking", previous_state: "thinking" });
  socket.server("input_audio_buffer.speech_started", { timestamp_ms: 900 });
  socket.server("turn.state_changed", { state: "paused", previous_state: "speaking" });
  assert.equal(audio.volume, 0.2);

  socket.server("input_audio_buffer.speech_stopped", { timestamp_ms: 1180 });
  await delay();
  assert.equal(audio.volume, 0.2);
  assertPlaybackIntact(audio);

  socket.server("turn.state_changed", { state: "speaking", previous_state: "paused" });
  await delay();
  assert.equal(audio.volume, 0.8);
  assertPlaybackIntact(audio);
  await client.disconnect();
});

test("a duck raised by a false interruption candidate releases without discarding audio", async () => {
  const { client, sockets, audio } = createDuckingHarness(20);
  await client.connect();
  const socket = itemAt(sockets, 0, "gateway socket");
  socket.server("turn.state_changed", { state: "speaking", previous_state: "thinking" });
  socket.server("input_audio_buffer.speech_started", { timestamp_ms: 900 });
  socket.server("turn.state_changed", { state: "paused", previous_state: "speaking" });
  assert.equal(audio.volume, 0.2);

  socket.server("interruption.false_positive", { reason: "backchannel" });
  socket.server("input_audio_buffer.speech_stopped", { timestamp_ms: 1120 });
  socket.server("turn.state_changed", { state: "speaking", previous_state: "paused" });
  assert.equal(audio.volume, 0.2);
  assertPlaybackIntact(audio);

  await delay(60);
  assert.equal(audio.volume, 0.8);
  assertPlaybackIntact(audio);

  socket.server("input_audio_buffer.speech_started", { timestamp_ms: 2400 });
  assert.equal(audio.volume, 0.2);
  socket.server("interruption.false_positive", { reason: "backchannel" });
  await delay(60);
  assert.equal(audio.volume, 0.8);
  assertPlaybackIntact(audio);
  await client.disconnect();
});

test("unexpected gateway close tears down media and reports closed state", async () => {
  const { client, sockets, stream } = createHarness({ onSocket: answerOffers });
  const errors: string[] = [];
  client.on("error", (error) => errors.push(error.message));
  await client.connect();
  const pc = itemAt(MockPeerConnection.instances, 0, "peer connection");
  itemAt(sockets, 0, "gateway socket").close(1011, "server_failed");
  assert.equal(client.state.status, "closed");
  assert.equal(pc.closed, true);
  assert.equal(stream.stopped, true);
  assert.ok(errors.some((message) => message.includes("server_failed")));
});

test("a WebSocket failure during connect emits one generic error", async () => {
  const { client, sockets } = createHarness();
  const errors: string[] = [];
  client.on("error", (error) => errors.push(error.message));
  const connecting = client.connect();
  itemAt(sockets, 0, "gateway socket").fail();
  await assert.rejects(connecting, /RTC gateway WebSocket failed/);
  assert.deepEqual(errors, ["RTC gateway WebSocket failed"]);
  assert.equal(client.state.status, "closed");
});

test("signaling error frames surface as typed session errors", async () => {
  const { client, sockets } = createHarness({ onSocket: answerOffers });
  const errors: VoxRtcSessionError[] = [];
  const transportErrors: string[] = [];
  client.onSessionError((error) => errors.push(error));
  client.on("error", (error) => transportErrors.push(error.message));
  await client.connect();
  const socket = itemAt(sockets, 0, "gateway socket");
  socket.server("error", {
    message: "stale generation",
    code: "response_stale_generation",
    recoverable: true,
    generation_id: "gen-42",
  });
  socket.server("error", {
    message: "session died",
    code: "session_failed",
    recoverable: false,
  });
  socket.server("error", { message: "legacy failure", code: "" });
  assert.deepEqual(errors, [
    {
      message: "stale generation",
      code: "response_stale_generation",
      recoverable: true,
      generationId: "gen-42",
    },
    {
      message: "session died",
      code: "session_failed",
      recoverable: false,
      generationId: undefined,
    },
    {
      message: "legacy failure",
      code: undefined,
      recoverable: true,
      generationId: undefined,
    },
  ]);
  assert.deepEqual(errors.map(isFatalVoxError), [false, true, false]);
  assert.deepEqual(transportErrors, []);
  assert.equal(client.state.status, "connected");
  await client.disconnect();
});

test("an application signaling listener failure does not become a gateway protocol failure", async () => {
  const { client, sockets } = createHarness({ onSocket: answerOffers });
  const transportErrors: string[] = [];
  client.on("error", (error) => transportErrors.push(error.message));
  client.on("signalingMessage", () => {
    throw new Error("application listener failed");
  });
  await client.connect();
  const socket = itemAt(sockets, 0, "gateway socket");
  assert.throws(
    () => socket.server("turn.state_changed", { state: "listening" }),
    /application listener failed/,
  );
  assert.deepEqual(transportErrors, []);
  assert.equal(socket.readyState, 1);
  assert.equal(client.state.status, "connected");
  await client.disconnect();
});

test("rtc.signaling_error frames surface as terminal session errors", async () => {
  const { client, sockets } = createHarness({ onSocket: answerOffers });
  const errors: VoxRtcSessionError[] = [];
  client.onSessionError((error) => errors.push(error));
  await client.connect();
  const socket = itemAt(sockets, 0, "gateway socket");
  socket.server("rtc.signaling_error", {
    message: "failed to apply local description",
    generation: 2,
  });
  assert.deepEqual(errors, [
    {
      message: "failed to apply local description",
      code: undefined,
      recoverable: false,
      generationId: undefined,
    },
  ]);
  assert.deepEqual(errors.map(isFatalVoxError), [true]);
  await client.disconnect();
});

test("a signaling error correlated to the pending offer fails the negotiation", async () => {
  const { client } = createHarness({
    onSocket: (socket) => {
      socket.onSend = (message) => {
        if (message.type !== "rtc.offer") return;
        queueMicrotask(() => {
          socket.server(
            "rtc.signaling_error",
            {
              message: "failed to apply local description",
              code: "session_failed",
              recoverable: false,
            },
            message.id,
          );
        });
      };
    },
  });
  await assert.rejects(
    client.connect(),
    /failed to apply local description/,
  );
  assert.equal(client.state.status, "closed");
});

test("a conversation error during a pending offer does not fail the negotiation", async () => {
  const { client } = createHarness({
    onSocket: (socket) => {
      socket.onSend = (message) => {
        if (message.type !== "rtc.offer") return;
        socket.server("error", {
          message: "stale generation",
          code: "response_stale_generation",
        });
        queueMicrotask(() => {
          socket.server(
            "rtc.answer",
            {
              session_id: READY_SESSION.sessionId,
              answer: { type: "answer", sdp: "answer-sdp" },
            },
            message.id,
          );
        });
      };
    },
  });
  const sessionErrors: VoxRtcSessionError[] = [];
  const transportErrors: string[] = [];
  client.onSessionError((error) => sessionErrors.push(error));
  client.on("error", (error) => transportErrors.push(error.message));
  const session = await client.connect();
  assert.equal(session.sessionId, READY_SESSION.sessionId);
  assert.equal(client.state.status, "connected");
  assert.deepEqual(sessionErrors, [
    {
      message: "stale generation",
      code: "response_stale_generation",
      recoverable: true,
      generationId: undefined,
    },
  ]);
  assert.deepEqual(transportErrors, []);
  await client.disconnect();
});

test("data-channel response and interruption events expose generationId", async () => {
  const { client } = createHarness({ onSocket: answerOffers });
  const events: VoxRtcClientEventEnvelope[] = [];
  client.onClientEvent((event) => events.push(event));
  await client.connect();
  const channel = itemAt(
    MockPeerConnection.instances,
    0,
    "peer connection",
  ).dataChannel;
  const deliver = (event: string, payload: Record<string, unknown>) => {
    channel.onmessage?.({
      data: JSON.stringify({ event, payload }),
    } as MessageEvent<string>);
  };
  deliver("response.created", { response_id: "resp-1", generation_id: "gen-1" });
  deliver("response.done", { generation_id: "gen-1" });
  deliver("response.cancelled", { generation_id: "gen-2" });
  deliver("response.audio.clear", { generation_id: "gen-2" });
  deliver("interruption.detected", { generation_id: "gen-2", vad_active_ms: 120 });
  deliver("interruption.false_positive", { generation_id: "gen-3" });
  deliver("response.created", { response_id: "resp-legacy" });
  deliver("turn.state_changed", { state: "listening" });
  assert.deepEqual(
    events.map((event) => [event.event, event.generationId]),
    [
      ["response.created", "gen-1"],
      ["response.done", "gen-1"],
      ["response.cancelled", "gen-2"],
      ["response.audio.clear", "gen-2"],
      ["interruption.detected", "gen-2"],
      ["interruption.false_positive", "gen-3"],
      ["response.created", undefined],
      ["turn.state_changed", undefined],
    ],
  );
  await client.disconnect();
});

test("repeated connect and disconnect creates one clean gateway session per cycle", async () => {
  const { client, sockets } = createHarness({ onSocket: answerOffers });
  await client.connect();
  await client.disconnect();
  await client.connect();
  await client.disconnect();
  assert.equal(sockets.length, 2);
  for (const socket of sockets) {
    assert.equal(
      socket.sent.filter((message) => message.type === "rtc.close").length,
      1,
    );
    assert.equal(socket.readyState, 3);
  }
});
