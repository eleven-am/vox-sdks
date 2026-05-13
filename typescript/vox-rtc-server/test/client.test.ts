import assert from "node:assert/strict";
import test from "node:test";

import { ChannelState, ConnectionState, VoxRtcServerClient } from "../src/index.js";

class FakeChannel {
  sent: Array<{ event: string; payload: Record<string, unknown> }> = [];
  stateHandlers = new Set<(state: ChannelState) => void>();
  messageHandlers = new Set<(event: string, payload: Record<string, unknown>) => void>();

  join() {
    for (const handler of this.stateHandlers) handler(ChannelState.JOINED);
  }

  leave() {}

  sendMessage(event: string, payload: Record<string, unknown>) {
    this.sent.push({ event, payload });
  }

  onMessage(callback: (event: string, payload: Record<string, unknown>) => void) {
    this.messageHandlers.add(callback);
    return () => this.messageHandlers.delete(callback);
  }

  onChannelStateChange(callback: (state: ChannelState) => void) {
    this.stateHandlers.add(callback);
    return () => this.stateHandlers.delete(callback);
  }

  emit(event: string, payload: Record<string, unknown>) {
    for (const handler of this.messageHandlers) handler(event, payload);
  }
}

class FakeSocket {
  state = ConnectionState.DISCONNECTED;
  channel = new FakeChannel();
  stateHandlers = new Set<(state: ConnectionState) => void>();
  errorHandlers = new Set<(error: Error) => void>();

  connect() {
    this.state = ConnectionState.CONNECTED;
    for (const handler of this.stateHandlers) handler(this.state);
  }

  disconnect() {
    this.state = ConnectionState.DISCONNECTED;
    for (const handler of this.stateHandlers) handler(this.state);
  }

  getState() {
    return this.state;
  }

  createChannel(name: string) {
    assert.equal(name, "/rtc/rtc_123");
    return this.channel;
  }

  onConnectionChange(callback: (state: ConnectionState) => void) {
    this.stateHandlers.add(callback);
    return () => this.stateHandlers.delete(callback);
  }

  onError(callback: (error: Error) => void) {
    this.errorHandlers.add(callback);
    return () => this.errorHandlers.delete(callback);
  }
}

test("createSession parses the RTC bootstrap response", async () => {
  const previous = process.env.VOX_API_KEY;
  process.env.VOX_API_KEY = "secret";
  try {
    const client = new VoxRtcServerClient({
      httpBase: "https://vox.example.com/",
      fetch: async (_input, init) => {
        assert.equal((init?.headers as Record<string, string>).authorization, "Bearer secret");
        return new Response(JSON.stringify({
          session_id: "rtc_123",
          client_token: "tok_123",
          expires_at: "2026-01-01T00:00:00Z",
          join_token_ttl_seconds: 120,
          ice_servers: [{ urls: ["stun:turn.example.com:3478"] }],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }) as Response;
      },
      socketFactory: () => new FakeSocket() as never,
    });

    const bootstrap = await client.createSession();
    assert.equal(bootstrap.sessionId, "rtc_123");
    assert.equal(bootstrap.clientToken, "tok_123");
    assert.equal(bootstrap.joinTokenTtlSeconds, 120);
    assert.equal(client.httpBase, "https://vox.example.com");
    assert.equal(client.socketBase, "https://vox.example.com/v1/socket");
  } finally {
    if (previous === undefined) {
      delete process.env.VOX_API_KEY;
    } else {
      process.env.VOX_API_KEY = previous;
    }
  }
});

test("attachSession joins the RTC channel and sends the expected control messages", async () => {
  const fakeSocket = new FakeSocket();
  let receivedParams: Record<string, unknown> | null = null;
  const client = new VoxRtcServerClient({
    httpBase: "https://vox.example.com",
    fetch,
    apiKey: "secret",
    socketFactory: (_endpoint, params) => {
      receivedParams = params;
      return fakeSocket as never;
    },
  });

  const session = await client.attachSession("rtc_123");
  session.configure({
    sttModel: "stt",
    ttsModel: "tts",
    voice: "voice",
    turnProfile: "browser_default",
    vadBackend: "silero",
    turnDetector: "livekit",
  });
  session.sendTextResponse("Hello");
  session.sendClientEvent({ event: "render.url", payload: { url: "https://example.com" } });

  assert.deepEqual(fakeSocket.channel.sent.map((item) => item.event), [
    "session.update",
    "response.replace_text",
    "client.event",
  ]);
  assert.deepEqual(fakeSocket.channel.sent[0]?.payload, {
    session: {
      stt_model: "stt",
      tts_model: "tts",
      voice: "voice",
      turn_profile: "browser_default",
      vad_backend: "silero",
      turn_detector: "livekit",
    },
  });
  assert.deepEqual(fakeSocket.channel.sent[1]?.payload, { text: "Hello" });
  assert.deepEqual(receivedParams, { api_key: "secret" });
});

test("onEvent maps PondSocket messages into Vox wire events", async () => {
  const fakeSocket = new FakeSocket();
  const client = new VoxRtcServerClient({
    httpBase: "https://vox.example.com",
    fetch,
    socketFactory: () => fakeSocket as never,
  });

  const session = await client.attachSession("rtc_123");
  const received: Array<{ type: string; data: Record<string, unknown> }> = [];
  const off = session.onEvent((event) => received.push(event));

  fakeSocket.channel.emit("turn.state_changed", { state: "speaking", session_id: "rtc_123" });
  off();

  assert.deepEqual(received, [{
    type: "turn.state_changed",
    data: { state: "speaking", session_id: "rtc_123" },
  }]);
});
