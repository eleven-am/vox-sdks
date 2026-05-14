const path = require("node:path");
const process = require("node:process");

const express = require("express");
const { VoxRtcServerClient } = require("@eleven-am/vox-rtc-server");

const PORT = Number.parseInt(process.env.PORT || "8788", 10);
const VOX_HTTP_BASE = (process.env.VOX_HTTP_BASE || "https://vox.horus.maix.ovh").replace(/\/+$/, "");
const VOX_API_KEY = process.env.VOX_API_KEY?.trim() || undefined;

if (!VOX_API_KEY) {
  throw new Error("VOX_API_KEY is required for the Express RTC proxy example");
}

const app = express();
const sdkClient = new VoxRtcServerClient({
  httpBase: VOX_HTTP_BASE,
  apiKey: VOX_API_KEY,
});

/** @type {Map<string, {
 *   session: import("@eleven-am/vox-rtc-server").VoxRtcControlSession,
 *   bootstrap: import("@eleven-am/vox-rtc-server").VoxRtcSessionBootstrap,
 *   echoEnabled: boolean,
 *   echoPrefix: string,
 *   echoCount: number,
 *   timing: {
 *     lastSpeechStoppedAt: number,
 *     lastTranscriptAt: number,
 *     lastEchoSentAt: number,
 *     lastEchoResponseId?: string,
 *   },
 *   history: Array<{type: string, data: Record<string, unknown>, sessionId?: string, channelName?: string, at: string}>,
 *   subscribers: Set<import("express").Response>,
 *   unsubscribe: () => void,
 * }>} */
const sessions = new Map();

app.use(express.json({ limit: "256kb" }));

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function rememberEvent(state, event) {
  state.history.push(event);
  if (state.history.length > 200) {
    state.history.shift();
  }
  for (const subscriber of state.subscribers) {
    writeSse(subscriber, event);
  }
}

function mustGetSession(sessionId) {
  const state = sessions.get(sessionId);
  if (!state) {
    const error = new Error(`Unknown RTC session: ${sessionId}`);
    error.statusCode = 404;
    throw error;
  }
  return state;
}

function completedTranscript(event) {
  if (event.type !== "conversation.item.input_audio_transcription.completed") {
    return "";
  }
  const transcript = event.data?.transcript;
  return typeof transcript === "string" ? transcript.trim() : "";
}

function emitLocalEvent(state, type, data = {}) {
  rememberEvent(state, {
    type,
    data,
    at: new Date().toISOString(),
  });
}

function responseId(event) {
  const id = event.data?.response_id;
  return typeof id === "string" ? id : "";
}

function observeTiming(state, event) {
  const receivedAt = Date.now();
  if (event.type === "input_audio_buffer.speech_stopped") {
    state.timing.lastSpeechStoppedAt = receivedAt;
    emitLocalEvent(state, "local.timing.speech_stopped", {});
    return;
  }

  if (event.type === "conversation.item.input_audio_transcription.completed") {
    state.timing.lastTranscriptAt = receivedAt;
    emitLocalEvent(state, "local.timing.transcript_received", {
      transcript: completedTranscript(event),
      ms_since_speech_stopped: state.timing.lastSpeechStoppedAt
        ? receivedAt - state.timing.lastSpeechStoppedAt
        : null,
    });
    return;
  }

  if (!state.timing.lastEchoSentAt) {
    return;
  }

  if (event.type === "response.created") {
    const id = responseId(event);
    state.timing.lastEchoResponseId = id || undefined;
    emitLocalEvent(state, "local.timing.response_created", {
      response_id: id,
      ms_since_echo_sent: receivedAt - state.timing.lastEchoSentAt,
      ms_since_transcript_received: state.timing.lastTranscriptAt
        ? receivedAt - state.timing.lastTranscriptAt
        : null,
    });
    return;
  }

  if (event.type === "response.committed" || event.type === "response.done" || event.type === "response.cancelled") {
    const id = responseId(event);
    if (id && state.timing.lastEchoResponseId && id !== state.timing.lastEchoResponseId) {
      return;
    }
    emitLocalEvent(state, `local.timing.${event.type.replace("response.", "response_")}`, {
      response_id: id,
      ms_since_echo_sent: receivedAt - state.timing.lastEchoSentAt,
      ms_since_transcript_received: state.timing.lastTranscriptAt
        ? receivedAt - state.timing.lastTranscriptAt
        : null,
    });
  }
}

function echoTranscript(state, event) {
  if (!state.echoEnabled) {
    return;
  }
  const transcript = completedTranscript(event);
  if (!transcript) {
    return;
  }

  const text = `${state.echoPrefix}${transcript}`;
  try {
    const sentAt = Date.now();
    state.session.sendTextResponse(text, { allowInterruptions: true });
    state.timing.lastEchoSentAt = sentAt;
    state.timing.lastEchoResponseId = undefined;
    state.echoCount += 1;
    emitLocalEvent(state, "local.echo.sent", {
      count: state.echoCount,
      transcript,
      text,
      ms_since_transcript_received: state.timing.lastTranscriptAt
        ? sentAt - state.timing.lastTranscriptAt
        : null,
    });
  } catch (error) {
    emitLocalEvent(state, "local.echo.failed", {
      transcript,
      message: error?.message || String(error),
    });
  }
}

async function closeSession(sessionId) {
  const state = sessions.get(sessionId);
  if (!state) {
    return false;
  }
  state.unsubscribe();
  state.session.close();
  for (const subscriber of state.subscribers) {
    subscriber.end();
  }
  sessions.delete(sessionId);
  return true;
}

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", voxHttpBase: VOX_HTTP_BASE });
});

app.post("/api/rtc/session", async (req, res, next) => {
  try {
    const config = req.body && typeof req.body === "object" ? req.body : {};
    const { bootstrap, session } = await sdkClient.createControlledSession();

    const state = {
      session,
      bootstrap,
      echoEnabled: config.echoTranscripts !== false,
      echoPrefix: typeof config.echoPrefix === "string" ? config.echoPrefix : "I heard: ",
      echoCount: 0,
      timing: {
        lastSpeechStoppedAt: 0,
        lastTranscriptAt: 0,
        lastEchoSentAt: 0,
        lastEchoResponseId: undefined,
      },
      history: [],
      subscribers: new Set(),
      unsubscribe: () => {},
    };

    state.unsubscribe = session.onEvent((event) => {
      const wireEvent = {
        type: event.type,
        data: event.data,
        sessionId: event.sessionId,
        channelName: event.channelName,
        at: new Date().toISOString(),
      };
      rememberEvent(state, wireEvent);
      observeTiming(state, wireEvent);
      echoTranscript(state, wireEvent);
    });

    sessions.set(bootstrap.sessionId, state);

    session.configure({
      sttModel: typeof config.sttModel === "string" ? config.sttModel : undefined,
      ttsModel: typeof config.ttsModel === "string" ? config.ttsModel : undefined,
      voice: typeof config.voice === "string" ? config.voice : undefined,
      turnProfile: typeof config.turnProfile === "string" ? config.turnProfile : undefined,
      vadBackend: "silero",
      turnDetector: "livekit",
    });

    res.status(201).json({
      ...bootstrap,
      voxHttpBase: VOX_HTTP_BASE,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/rtc/session/:sessionId/events", (req, res, next) => {
  try {
    const state = mustGetSession(req.params.sessionId);

    res.status(200);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders?.();

    writeSse(res, { type: "server.connected", data: { sessionId: req.params.sessionId }, at: new Date().toISOString() });
    for (const event of state.history) {
      writeSse(res, event);
    }

    state.subscribers.add(res);

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, 15000);

    req.on("close", () => {
      clearInterval(heartbeat);
      state.subscribers.delete(res);
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/rtc/session/:sessionId/respond", (req, res, next) => {
  try {
    const state = mustGetSession(req.params.sessionId);
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    if (!text.trim()) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    state.session.sendTextResponse(text, {
      allowInterruptions: req.body?.allowInterruptions !== false,
    });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/rtc/session/:sessionId/echo", (req, res, next) => {
  try {
    const state = mustGetSession(req.params.sessionId);
    state.echoEnabled = req.body?.enabled !== false;
    emitLocalEvent(state, "local.echo.state", { enabled: state.echoEnabled });
    res.json({ enabled: state.echoEnabled });
  } catch (error) {
    next(error);
  }
});

app.post("/api/rtc/session/:sessionId/cancel", (req, res, next) => {
  try {
    const state = mustGetSession(req.params.sessionId);
    state.session.cancelResponse();
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/rtc/session/:sessionId/client-event", (req, res, next) => {
  try {
    const state = mustGetSession(req.params.sessionId);
    const event = typeof req.body?.event === "string" ? req.body.event.trim() : "";
    if (!event) {
      res.status(400).json({ error: "event is required" });
      return;
    }
    state.session.sendClientEvent({
      event,
      payload: Object.prototype.hasOwnProperty.call(req.body || {}, "payload") ? req.body.payload : null,
    });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.delete("/api/rtc/session/:sessionId", async (req, res, next) => {
  try {
    const closed = await closeSession(req.params.sessionId);
    if (!closed) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  res.status(statusCode).json({
    error: error?.message || "Unexpected error",
  });
});

async function attachFrontend() {
  if (process.env.NODE_ENV === "production") {
    const dist = path.join(__dirname, "dist");
    app.use(express.static(dist));
    app.use((req, res, next) => {
      if (req.method === "GET" && !req.path.startsWith("/api/")) {
        res.sendFile(path.join(dist, "index.html"));
        return;
      }
      next();
    });
    return;
  }

  const { createServer } = await import("vite");
  const vite = await createServer({
    root: __dirname,
    appType: "spa",
    server: {
      middlewareMode: true,
    },
  });
  app.use(vite.middlewares);
}

let server;

attachFrontend().then(() => {
  server = app.listen(PORT, () => {
    console.log(`vox-rtc express proxy listening on http://127.0.0.1:${PORT}`);
  });
}).catch((error) => {
  console.error(error);
  process.exit(1);
});

async function shutdown() {
  server?.close();
  for (const sessionId of [...sessions.keys()]) {
    await closeSession(sessionId);
  }
  sdkClient.disconnect();
}

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});
