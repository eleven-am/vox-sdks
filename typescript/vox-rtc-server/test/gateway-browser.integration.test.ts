import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import { WebSocket } from "ws";

import { VoxRtcBrowserClient } from "../../vox-rtc-client/src/client.js";
import { createVoxRtcGatewayWithClientFactory } from "../src/gateway.js";

type WireEvent = {
  type: string;
  data: Record<string, unknown>;
  sessionId: string;
  channelName: string;
};

class ProtocolEnforcingSession {
  readonly sessionId = "rtc_protocol";
  readonly handlers = new Set<(event: WireEvent) => void>();
  readonly candidateGenerations: number[] = [];
  violations: string[] = [];
  offerGeneration: number | undefined;

  onEvent(handler: (event: WireEvent) => void) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  sendOffer(
    _offer: unknown,
    options?: { generation?: number },
  ) {
    this.offerGeneration = options?.generation;
    queueMicrotask(() => this.emit("rtc.answer", {
      answer: { type: "answer", sdp: "answer-sdp" },
      ...(this.offerGeneration === undefined
        ? {}
        : { generation: this.offerGeneration }),
    }));
  }

  sendIceCandidate(
    _candidate: unknown,
    options?: { generation?: number },
  ) {
    if (this.offerGeneration !== undefined && options?.generation === undefined) {
      this.violations.push(
        "command_invalid: RTC candidate generation required for generated negotiation",
      );
      return;
    }
    if (options?.generation !== undefined) {
      this.candidateGenerations.push(options.generation);
    }
  }

  closeRtc() {}
  close() {}

  private emit(type: string, data: Record<string, unknown>) {
    for (const handler of this.handlers) {
      handler({
        type,
        data,
        sessionId: this.sessionId,
        channelName: `/rtc/${this.sessionId}`,
      });
    }
  }
}

class MockDataChannel {
  readyState: RTCDataChannelState = "connecting";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  send() {}
  close() {
    this.readyState = "closed";
    this.onclose?.();
  }
}

class MockPeerConnection {
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  readonly dataChannel = new MockDataChannel();

  createDataChannel() {
    return this.dataChannel as unknown as RTCDataChannel;
  }
  getSenders() { return []; }
  getTransceivers() { return []; }
  addTrack() {}
  removeTrack() {}
  restartIce() {}
  async createOffer() {
    return { type: "offer" as RTCSdpType, sdp: "offer-sdp" };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description;
    this.onicecandidate?.({
      candidate: {
        toJSON: () => ({
          candidate: "candidate:browser",
          sdpMid: "0",
          sdpMLineIndex: 0,
        }),
      },
    } as RTCPeerConnectionIceEvent);
    this.onicecandidate?.({ candidate: null } as RTCPeerConnectionIceEvent);
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description;
    queueMicrotask(() => {
      this.connectionState = "connected";
      this.iceConnectionState = "connected";
      this.oniceconnectionstatechange?.();
      this.onconnectionstatechange?.();
    });
  }
  async addIceCandidate() {}
  close() {
    this.connectionState = "closed";
  }
}

class NodeWebSocketAdapter {
  readonly socket: WebSocket;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on("open", () => this.onopen?.({} as Event));
    this.socket.on("message", (data) =>
      this.onmessage?.({ data: data.toString() } as MessageEvent<string>));
    this.socket.on("error", () => this.onerror?.({} as Event));
    this.socket.on("close", (code, reason) =>
      this.onclose?.({ code, reason: reason.toString() } as CloseEvent));
  }

  get readyState() { return this.socket.readyState; }
  send(data: string) { this.socket.send(data); }
  close(code?: number, reason?: string) { this.socket.close(code, reason); }
}

test("browser client negotiates through the gateway with generation-aware Vox signaling", async () => {
  const session = new ProtocolEnforcingSession();
  const gateway = createVoxRtcGatewayWithClientFactory(
    { voxHttpBase: "http://vox.protocol.test" },
    () => ({
      async createControlledSession() {
        return {
          bootstrap: {
            sessionId: session.sessionId,
            expiresAt: "2026-08-01T00:00:00Z",
            attachTtlSeconds: 120,
            iceServers: [],
          },
          session,
        };
      },
      disconnect() {},
    }) as never,
  );
  const server = createServer();
  const detach = gateway.attach(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const client = new VoxRtcBrowserClient({
    signalingEndpoint: "/api/vox/rtc",
    audioConstraints: false,
    peerConnectionFactory: () => new MockPeerConnection() as unknown as RTCPeerConnection,
    webSocketFactory: (path) =>
      new NodeWebSocketAdapter(`ws://127.0.0.1:${address.port}${path}`),
  });

  try {
    await client.connect({ audioConstraints: false });
    assert.equal(client.state.status, "connected");
    assert.equal(session.offerGeneration, 1);
    assert.deepEqual(session.candidateGenerations, [1, 1]);
    assert.deepEqual(session.violations, []);
  } finally {
    await client.disconnect();
    await gateway.close("test_complete");
    detach();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
