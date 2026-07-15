import assert from "node:assert/strict";
import test from "node:test";

import { ChannelState, ConnectionState, VoxRtcServerClient } from "../src/index.js";

class FakeChannel {
  sent: Array<{ event: string; payload: Record<string, unknown> }> = [];
  state = ChannelState.IDLE;
  joinCalls = 0;
  joinError: { message: string } | null = null;
  stateHandlers = new Set<(state: ChannelState) => void>();
  messageHandlers = new Set<(event: string, payload: Record<string, unknown>) => void>();

  join() {
    this.joinCalls += 1;
    this.setState(ChannelState.JOINED);
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
    callback(this.state);
    return () => this.stateHandlers.delete(callback);
  }

  setState(state: ChannelState) {
    this.state = state;
    for (const handler of this.stateHandlers) handler(state);
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
  let receivedOptions: Record<string, unknown> | null = null;
  const client = new VoxRtcServerClient({
    httpBase: "https://vox.example.com",
    fetch,
    apiKey: "secret",
    joinTimeoutMs: 12_345,
    socketFactory: (_endpoint, params, options) => {
      receivedParams = params;
      receivedOptions = options;
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
  assert.deepEqual(receivedOptions, {
    connectionTimeout: 10_000,
    joinTimeout: 12_345,
    maxReconnectDelay: 30_000,
  });
});

test("streaming response commands share one generation id", async () => {
  const fakeSocket = new FakeSocket();
  const client = new VoxRtcServerClient({
    httpBase: "https://vox.example.com",
    fetch,
    socketFactory: () => fakeSocket as never,
  });
  const session = await client.attachSession("rtc_123");

  session.startResponse();
  session.appendResponseText("Hello");
  session.commitResponse();

  const [start, delta, commit] = fakeSocket.channel.sent;
  const generationId = start?.payload.generation_id;
  assert.equal(typeof generationId, "string");
  assert.ok(String(generationId).length > 0);
  assert.equal(delta?.payload.generation_id, generationId);
  assert.equal(commit?.payload.generation_id, generationId);
});

test("attachSession accepts an already joined channel without joining it again", async () => {
  const fakeSocket = new FakeSocket();
  fakeSocket.channel.state = ChannelState.JOINED;
  const client = new VoxRtcServerClient({
    httpBase: "https://vox.example.com",
    fetch,
    socketFactory: () => fakeSocket as never,
  });

  await client.attachSession("rtc_123");

  assert.equal(fakeSocket.channel.joinCalls, 0);
  assert.equal(fakeSocket.channel.stateHandlers.size, 0);
});

test("attachSession includes the PondSocket decline reason", async () => {
  const fakeSocket = new FakeSocket();
  fakeSocket.channel.join = () => {
    fakeSocket.channel.joinCalls += 1;
    fakeSocket.channel.joinError = { message: "unknown or expired RTC session" };
    fakeSocket.channel.setState(ChannelState.DECLINED);
  };
  const client = new VoxRtcServerClient({
    httpBase: "https://vox.example.com",
    fetch,
    socketFactory: () => fakeSocket as never,
  });

  await assert.rejects(
    client.attachSession("rtc_123"),
    /DECLINED: unknown or expired RTC session/,
  );
  assert.equal(fakeSocket.channel.stateHandlers.size, 0);
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
    sessionId: "rtc_123",
    channelName: "/rtc/rtc_123",
  }]);
});

test("named event hooks map common Vox events", async () => {
  const fakeSocket = new FakeSocket();
  const client = new VoxRtcServerClient({
    httpBase: "https://vox.example.com",
    fetch,
    socketFactory: () => fakeSocket as never,
  });

  const session = await client.attachSession("rtc_123");
  const transcripts: unknown[] = [];
  const turns: unknown[] = [];
  const responses: unknown[] = [];
  const browserEvents: unknown[] = [];
  const closes: unknown[] = [];

  const unsubscribeTranscript = session.onTranscript((event) => transcripts.push(event));
  const unsubscribeTurn = session.onTurnStateChanged((event) => turns.push(event));
  const unsubscribeDone = session.onResponseDone((event) => responses.push(event));
  const unsubscribeBrowser = session.onBrowserEvent((event) => browserEvents.push(event));
  const unsubscribeClose = session.onClose((event) => closes.push(event));

  fakeSocket.channel.emit("conversation.item.input_audio_transcription.completed", {
    transcript: "hello world",
    language: "en",
    start_ms: 10,
    end_ms: 20,
    eou_probability: 0.7,
    topics: ["hello"],
    session_id: "rtc_123",
  });
  fakeSocket.channel.emit("turn.state_changed", {
    state: "speaking",
    previous_state: "idle",
    session_id: "rtc_123",
  });
  fakeSocket.channel.emit("response.done", {
    response_id: "resp_1",
    session_id: "rtc_123",
  });
  fakeSocket.channel.emit("browser.event", {
    event: "ui.select",
    payload: { id: "choice-a" },
    session_id: "rtc_123",
  });
  fakeSocket.channel.emit("rtc.client.disconnected", {
    reason: "data_channel_closed",
    connection_state: "connected",
    ice_connection_state: "completed",
    data_channel_state: "closed",
    session_id: "rtc_123",
  });

  unsubscribeTranscript();
  unsubscribeTurn();
  unsubscribeDone();
  unsubscribeBrowser();
  unsubscribeClose();

  assert.deepEqual(transcripts, [{
    sessionId: "rtc_123",
    channelName: "/rtc/rtc_123",
    data: {
      transcript: "hello world",
      language: "en",
      start_ms: 10,
      end_ms: 20,
      eou_probability: 0.7,
      topics: ["hello"],
      session_id: "rtc_123",
    },
    transcript: "hello world",
    language: "en",
    startMs: 10,
    endMs: 20,
    eouProbability: 0.7,
    topics: ["hello"],
  }]);
  assert.deepEqual(turns, [{
    sessionId: "rtc_123",
    channelName: "/rtc/rtc_123",
    data: {
      state: "speaking",
      previous_state: "idle",
      session_id: "rtc_123",
    },
    state: "speaking",
    previousState: "idle",
  }]);
  assert.deepEqual(responses, [{
    sessionId: "rtc_123",
    channelName: "/rtc/rtc_123",
    data: {
      response_id: "resp_1",
      session_id: "rtc_123",
    },
    responseId: "resp_1",
  }]);
  assert.deepEqual(browserEvents, [{
    sessionId: "rtc_123",
    channelName: "/rtc/rtc_123",
    data: {
      event: "ui.select",
      payload: { id: "choice-a" },
      session_id: "rtc_123",
    },
    event: "ui.select",
    payload: { id: "choice-a" },
  }]);
  assert.deepEqual(closes, [{
    sessionId: "rtc_123",
    channelName: "/rtc/rtc_123",
    data: {
      reason: "data_channel_closed",
      connection_state: "connected",
      ice_connection_state: "completed",
      data_channel_state: "closed",
      session_id: "rtc_123",
    },
    reason: "data_channel_closed",
    connectionState: "connected",
    iceConnectionState: "completed",
    dataChannelState: "closed",
  }]);
});

async function attachedSession() {
  const fakeSocket = new FakeSocket();
  const client = new VoxRtcServerClient({
    httpBase: "https://vox.example.com",
    fetch,
    socketFactory: () => fakeSocket as never,
  });
  const session = await client.attachSession("rtc_123");
  return { fakeSocket, session };
}

test("onSpeechStarted maps the speech_started event", async () => {
  const { fakeSocket, session } = await attachedSession();
  const events: unknown[] = [];
  const off = session.onSpeechStarted((event) => events.push(event));

  fakeSocket.channel.emit("input_audio_buffer.speech_started", {
    timestamp_ms: 1234,
    session_id: "rtc_123",
  });
  off();

  assert.deepEqual(events, [{
    sessionId: "rtc_123",
    channelName: "/rtc/rtc_123",
    data: { timestamp_ms: 1234, session_id: "rtc_123" },
    timestampMs: 1234,
  }]);
});

test("onSpeechStopped maps the speech_stopped event", async () => {
  const { fakeSocket, session } = await attachedSession();
  const events: unknown[] = [];
  const off = session.onSpeechStopped((event) => events.push(event));

  fakeSocket.channel.emit("input_audio_buffer.speech_stopped", {
    timestamp_ms: 5678,
    session_id: "rtc_123",
  });
  off();

  assert.deepEqual(events, [{
    sessionId: "rtc_123",
    channelName: "/rtc/rtc_123",
    data: { timestamp_ms: 5678, session_id: "rtc_123" },
    timestampMs: 5678,
  }]);
});

test("onTranscriptDelta maps the transcription delta event", async () => {
  const { fakeSocket, session } = await attachedSession();
  const events: unknown[] = [];
  const off = session.onTranscriptDelta((event) => events.push(event));

  fakeSocket.channel.emit("conversation.item.input_audio_transcription.delta", {
    delta: "hel",
    start_ms: 10,
    end_ms: 20,
    session_id: "rtc_123",
  });
  off();

  assert.deepEqual(events, [{
    sessionId: "rtc_123",
    channelName: "/rtc/rtc_123",
    data: { delta: "hel", start_ms: 10, end_ms: 20, session_id: "rtc_123" },
    delta: "hel",
    startMs: 10,
    endMs: 20,
  }]);
});

test("onTurnEouPredicted maps the eou prediction event", async () => {
  const { fakeSocket, session } = await attachedSession();
  const events: unknown[] = [];
  const off = session.onTurnEouPredicted((event) => events.push(event));

  fakeSocket.channel.emit("turn.eou.predicted", {
    probability: 0.9,
    threshold: 0.5,
    delay_ms: 120,
    start_ms: 10,
    end_ms: 20,
    decision: "end",
    action: "commit",
    turn_detector: "livekit",
    session_id: "rtc_123",
  });
  off();

  assert.deepEqual(events, [{
    sessionId: "rtc_123",
    channelName: "/rtc/rtc_123",
    data: {
      probability: 0.9,
      threshold: 0.5,
      delay_ms: 120,
      start_ms: 10,
      end_ms: 20,
      decision: "end",
      action: "commit",
      turn_detector: "livekit",
      session_id: "rtc_123",
    },
    probability: 0.9,
    threshold: 0.5,
    delayMs: 120,
    startMs: 10,
    endMs: 20,
    decision: "end",
    action: "commit",
    turnDetector: "livekit",
  }]);
});
