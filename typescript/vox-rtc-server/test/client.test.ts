import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ChannelState,
  ConnectionState,
  isVoxErrorCode,
  VOX_ERROR_CODES,
  VOX_START_ACK_TIMEOUT_CODE,
  VoxRtcChannelJoinError,
  VoxRtcServerClient,
} from "../src/index.js";

const speechContextFixture = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/speech-context-v2.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

class FakeChannel {
  sent: Array<{ event: string; payload: Record<string, unknown> }> = [];
  state = ChannelState.IDLE;
  joinCalls = 0;
  joinError: { code?: string; message?: string; status?: number; details?: unknown } | null = null;
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
          expires_at: "2026-01-01T00:00:00Z",
          attach_ttl_seconds: 120,
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
    assert.equal(bootstrap.attachTtlSeconds, 120);
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
    speechContext: true,
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
      speech_context: true,
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

test("attachSession preserves the structured PondSocket decline payload", async () => {
  const fakeSocket = new FakeSocket();
  fakeSocket.channel.join = () => {
    fakeSocket.channel.joinCalls += 1;
    fakeSocket.channel.joinError = {
      code: "unauthorized",
      message: "unknown or expired RTC session",
      status: 403,
      details: { reason: "expired" },
    };
    fakeSocket.channel.setState(ChannelState.DECLINED);
  };
  const client = new VoxRtcServerClient({
    httpBase: "https://vox.example.com",
    fetch,
    socketFactory: () => fakeSocket as never,
  });

  const error = await client.attachSession("rtc_123").then(
    () => {
      throw new Error("join should have been declined");
    },
    (reason: unknown) => reason,
  );

  assert.ok(error instanceof VoxRtcChannelJoinError);
  assert.equal(error.code, "unauthorized");
  assert.equal(error.status, 403);
  assert.deepEqual(error.details, { reason: "expired" });
  assert.match(error.message, /DECLINED: unknown or expired RTC session/);
});

test("onConnectionChange delegates connection-state subscriptions to the socket", async () => {
  const fakeSocket = new FakeSocket();
  const client = new VoxRtcServerClient({
    httpBase: "https://vox.example.com",
    fetch,
    socketFactory: () => fakeSocket as never,
  });
  await client.attachSession("rtc_123");

  const states: ConnectionState[] = [];
  const off = client.onConnectionChange((state) => states.push(state));
  fakeSocket.disconnect();
  fakeSocket.connect();
  off();

  assert.deepEqual(states, [
    ConnectionState.DISCONNECTED,
    ConnectionState.CONNECTED,
  ]);
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
    speech_context: speechContextFixture,
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
      speech_context: speechContextFixture,
      session_id: "rtc_123",
    },
    transcript: "hello world",
    language: "en",
    startMs: 10,
    endMs: 20,
    eouProbability: 0.7,
    topics: ["hello"],
    entities: undefined,
    words: undefined,
    speechContext: {
      schemaVersion: 2,
      status: "complete",
      emotions: [{ label: "surprised", startMs: 0, endMs: 2500 }],
      vocal: [{ label: "laughter", startMs: 7000, endMs: 10500 }],
      sounds: [
        { label: "fireworks", startMs: 3360, endMs: 4320, score: 0.42 },
        { label: "inside, small room", startMs: 3840, endMs: 5280, score: 0.31 },
      ],
    },
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
    generationId: undefined,
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

test("onError parses typed errors with code, recoverable, and generation id", async () => {
  const { fakeSocket, session } = await attachedSession();
  const events: unknown[] = [];
  const off = session.onError((event) => events.push(event));

  fakeSocket.channel.emit("error", {
    message: "session broke",
    code: "session_failed",
    recoverable: false,
    generation_id: "gen-9",
    session_id: "rtc_123",
  });
  off();

  assert.deepEqual(events, [{
    sessionId: "rtc_123",
    channelName: "/rtc/rtc_123",
    data: {
      message: "session broke",
      code: "session_failed",
      recoverable: false,
      generation_id: "gen-9",
      session_id: "rtc_123",
    },
    message: "session broke",
    code: "session_failed",
    recoverable: false,
    generationId: "gen-9",
  }]);
});

test("onError defaults missing recoverable to true for old servers", async () => {
  const { fakeSocket, session } = await attachedSession();
  const events: Array<{ code?: string; recoverable: boolean; generationId?: string }> = [];
  const off = session.onError((event) => events.push(event));

  fakeSocket.channel.emit("error", {
    message: "legacy failure",
    session_id: "rtc_123",
  });
  off();

  assert.equal(events.length, 1);
  assert.equal(events[0]?.recoverable, true);
  assert.equal(events[0]?.code, undefined);
  assert.equal(events[0]?.generationId, undefined);
});

test("onSignalingError surfaces the terminal rtc.signaling_error frame vox sends", async () => {
  const { fakeSocket, session } = await attachedSession();
  const events: unknown[] = [];
  const off = session.onSignalingError((event) => events.push(event));

  fakeSocket.channel.emit("rtc.signaling_error", {
    message: "failed to apply local description",
    generation: 2,
    session_id: "rtc_123",
  });
  off();

  assert.deepEqual(events, [{
    sessionId: "rtc_123",
    channelName: "/rtc/rtc_123",
    data: {
      message: "failed to apply local description",
      generation: 2,
      session_id: "rtc_123",
    },
    message: "failed to apply local description",
    generation: 2,
  }]);
});

test("onTranscript maps entities and words when the server supplies them", async () => {
  const { fakeSocket, session } = await attachedSession();
  const events: unknown[] = [];
  const off = session.onTranscript((event) => events.push(event));

  fakeSocket.channel.emit("conversation.item.input_audio_transcription.completed", {
    transcript: "call alice at noon",
    entities: [
      { type: "person", text: "alice", start_char: 5, end_char: 10 },
      { type: "time", text: "noon", start_char: 14, end_char: 18 },
    ],
    words: [
      { word: "call", start_ms: 0, end_ms: 100, confidence: 0.9 },
      { word: "alice", start_ms: 100, end_ms: 250 },
    ],
    session_id: "rtc_123",
  });
  off();

  const [event] = events as Array<{ entities?: unknown; words?: unknown }>;
  assert.deepEqual(event?.entities, [
    { type: "person", text: "alice", startChar: 5, endChar: 10 },
    { type: "time", text: "noon", startChar: 14, endChar: 18 },
  ]);
  assert.deepEqual(event?.words, [
    { word: "call", startMs: 0, endMs: 100, confidence: 0.9 },
    { word: "alice", startMs: 100, endMs: 250, confidence: undefined },
  ]);
});

test("onTranscript preserves the transcript but rejects malformed speech context", async () => {
  const { fakeSocket, session } = await attachedSession();
  const events: Array<{ transcript: string; speechContext?: unknown }> = [];
  const off = session.onTranscript((event) => events.push(event));

  fakeSocket.channel.emit("conversation.item.input_audio_transcription.completed", {
    transcript: "still delivered",
    speech_context: {
      schema_version: 2,
      status: "complete",
      emotions: [],
      vocal: [],
      sounds: [{ label: "fireworks", start_ms: 0, end_ms: 960, score: 1.1 }],
    },
    session_id: "rtc_123",
  });
  off();

  assert.equal(events[0]?.transcript, "still delivered");
  assert.equal(events[0]?.speechContext, undefined);
});

test("interruption events map the confirmation/rejection reason", async () => {
  const { fakeSocket, session } = await attachedSession();
  const detected: unknown[] = [];
  const rejected: unknown[] = [];
  const offDetected = session.onInterruptionDetected((event) => detected.push(event));
  const offRejected = session.onInterruptionFalsePositive((event) => rejected.push(event));

  fakeSocket.channel.emit("interruption.detected", {
    response_id: "resp_1",
    generation_id: "gen-7",
    vad_active_ms: 300,
    partial_transcript: "wait",
    reason: "stable_partial",
    session_id: "rtc_123",
  });
  fakeSocket.channel.emit("interruption.false_positive", {
    response_id: "resp_1",
    generation_id: "gen-7",
    vad_active_ms: 120,
    reason: "self_echo_transcript",
    session_id: "rtc_123",
  });
  offDetected();
  offRejected();

  assert.equal((detected[0] as { reason?: string }).reason, "stable_partial");
  assert.equal((rejected[0] as { reason?: string }).reason, "self_echo_transcript");
});

test("known error codes are exported and recognized", () => {
  assert.deepEqual([...VOX_ERROR_CODES], [
    "response_rejected_turn_state",
    "response_rejected_user_speech",
    "response_stale_generation",
    "response_already_active",
    "response_failed",
    "command_invalid",
    "session_failed",
  ]);
  assert.equal(isVoxErrorCode("response_stale_generation"), true);
  assert.equal(isVoxErrorCode("start_ack_timeout"), false);
  assert.equal(isVoxErrorCode(42), false);
});

test("response commands thread an explicit generation id", async () => {
  const { fakeSocket, session } = await attachedSession();

  session.startResponse({ generationId: "gen-1" });
  session.appendResponseText("Hello", { generationId: "gen-1" });
  session.commitResponse({ generationId: "gen-1" });
  session.cancelResponse({ generationId: "gen-1" });
  session.replaceResponseText("Replacement", { generationId: "gen-2" });

  assert.deepEqual(fakeSocket.channel.sent, [
    { event: "response.start", payload: { generation_id: "gen-1" } },
    { event: "response.delta", payload: { delta: "Hello", generation_id: "gen-1" } },
    { event: "response.commit", payload: { generation_id: "gen-1" } },
    { event: "response.cancel", payload: { generation_id: "gen-1" } },
    { event: "response.replace_text", payload: { text: "Replacement", generation_id: "gen-2" } },
  ]);
});

test("sendTextResponse replaces the active response text with one command", async () => {
  const { fakeSocket, session } = await attachedSession();

  session.sendTextResponse("Hi", { generationId: "gen-3" });

  assert.deepEqual(fakeSocket.channel.sent, [
    { event: "response.replace_text", payload: { text: "Hi", generation_id: "gen-3" } },
  ]);
});

test("response lifecycle events expose the generation id when present", async () => {
  const { fakeSocket, session } = await attachedSession();
  const created: unknown[] = [];
  const cleared: unknown[] = [];
  const interruptions: unknown[] = [];
  const offCreated = session.onResponseCreated((event) => created.push(event));
  const offClear = session.onResponseAudioClear((event) => cleared.push(event));
  const offInterruption = session.onInterruptionDetected((event) => interruptions.push(event));

  fakeSocket.channel.emit("response.created", {
    response_id: "resp_1",
    generation_id: "gen-7",
    session_id: "rtc_123",
  });
  fakeSocket.channel.emit("response.audio.clear", {
    response_id: "resp_1",
    generation_id: "gen-7",
    session_id: "rtc_123",
  });
  fakeSocket.channel.emit("interruption.detected", {
    response_id: "resp_1",
    generation_id: "gen-7",
    vad_active_ms: 300,
    partial_transcript: "wait",
    session_id: "rtc_123",
  });

  offCreated();
  offClear();
  offInterruption();

  assert.deepEqual(created, [{
    sessionId: "rtc_123",
    channelName: "/rtc/rtc_123",
    data: { response_id: "resp_1", generation_id: "gen-7", session_id: "rtc_123" },
    responseId: "resp_1",
    generationId: "gen-7",
  }]);
  assert.deepEqual(cleared, [{
    sessionId: "rtc_123",
    channelName: "/rtc/rtc_123",
    data: { response_id: "resp_1", generation_id: "gen-7", session_id: "rtc_123" },
    responseId: "resp_1",
    generationId: "gen-7",
  }]);
  assert.deepEqual(interruptions, [{
    sessionId: "rtc_123",
    channelName: "/rtc/rtc_123",
    data: {
      response_id: "resp_1",
      generation_id: "gen-7",
      vad_active_ms: 300,
      partial_transcript: "wait",
      session_id: "rtc_123",
    },
    responseId: "resp_1",
    generationId: "gen-7",
    vadActiveMs: 300,
    partialTranscript: "wait",
    reason: undefined,
  }]);
});

test("startResponseAndWait resolves on the correlated response.created ack", async () => {
  const { fakeSocket, session } = await attachedSession();

  const pending = session.startResponseAndWait({ generationId: "gen-ack" });
  fakeSocket.channel.emit("response.created", {
    response_id: "resp_other",
    generation_id: "gen-other",
    session_id: "rtc_123",
  });
  fakeSocket.channel.emit("response.created", {
    response_id: "resp_9",
    generation_id: "gen-ack",
    session_id: "rtc_123",
  });

  const result = await pending;
  assert.deepEqual(result, {
    accepted: true,
    responseId: "resp_9",
    generationId: "gen-ack",
  });
  assert.deepEqual(fakeSocket.channel.sent, [
    { event: "response.start", payload: { generation_id: "gen-ack" } },
  ]);
});

test("startResponseAndWait generates a generation id when absent", async () => {
  const { fakeSocket, session } = await attachedSession();

  const pending = session.startResponseAndWait();
  const generationId = fakeSocket.channel.sent[0]?.payload.generation_id;
  assert.equal(typeof generationId, "string");
  assert.ok(String(generationId).length > 0);
  fakeSocket.channel.emit("response.created", {
    response_id: "resp_1",
    generation_id: generationId,
    session_id: "rtc_123",
  });

  const result = await pending;
  assert.deepEqual(result, {
    accepted: true,
    responseId: "resp_1",
    generationId,
  });
});

test("startResponseAndWait resolves on the correlated typed error", async () => {
  const { fakeSocket, session } = await attachedSession();

  const pending = session.startResponseAndWait({ generationId: "gen-rejected" });
  fakeSocket.channel.emit("error", {
    message: "turn state cannot accept a response",
    code: "response_rejected_turn_state",
    recoverable: true,
    generation_id: "gen-rejected",
    session_id: "rtc_123",
  });

  const result = await pending;
  assert.deepEqual(result, {
    accepted: false,
    error: {
      code: "response_rejected_turn_state",
      recoverable: true,
      message: "turn state cannot accept a response",
    },
  });
});

test("startResponseAndWait ignores uncorrelated errors and resolves on timeout", async () => {
  const { fakeSocket, session } = await attachedSession();

  const pending = session.startResponseAndWait({ generationId: "gen-timeout", timeoutMs: 20 });
  fakeSocket.channel.emit("error", {
    message: "some other failure",
    code: "command_invalid",
    recoverable: true,
    generation_id: "gen-unrelated",
    session_id: "rtc_123",
  });

  const result = await pending;
  assert.deepEqual(result, {
    accepted: false,
    error: {
      code: VOX_START_ACK_TIMEOUT_CODE,
      recoverable: true,
      message: "Timed out waiting for response.created ack for gen-timeout",
    },
  });
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
