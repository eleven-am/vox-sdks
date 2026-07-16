const http = require("node:http");
const path = require("node:path");
const process = require("node:process");

const express = require("express");
const { createVoxRtcGateway } = require("@eleven-am/vox-rtc-server");

const PORT = Number.parseInt(process.env.PORT || "8788", 10);
const HOST = process.env.HOST || "127.0.0.1";
const VOX_HTTP_BASE = (
  process.env.VOX_HTTP_BASE || "https://vox.horus.maix.ovh"
).replace(/\/+$/, "");
const VOX_API_KEY = process.env.VOX_API_KEY?.trim();

if (!VOX_API_KEY) {
  throw new Error(
    "VOX_API_KEY is required for the Express RTC gateway example",
  );
}

const app = express();
const server = http.createServer(app);
const transcriptSubscriptions = new Map();

const gateway = createVoxRtcGateway({
  voxHttpBase: VOX_HTTP_BASE,
  apiKey: VOX_API_KEY,
  path: "/api/vox/rtc",
  onSessionCreated: ({ request, session }) => {
    console.log("RTC session created", session.sessionId, request.url);
    session.configure({
      sttModel: process.env.VOX_STT_MODEL || "parakeet-stt:tdt-0.6b-v3",
      ttsModel: process.env.VOX_TTS_MODEL || "kokoro-tts:v1.0",
      voice: process.env.VOX_VOICE || "af_heart",
      turnProfile: process.env.VOX_TURN_PROFILE || "browser_default",
      vadBackend: process.env.VOX_VAD_BACKEND || "silero",
      turnDetector: process.env.VOX_TURN_DETECTOR || "livekit",
    });

    const unsubscribe = session.onTranscript((event) => {
      const transcript = event.transcript.trim();
      if (transcript) {
        session.sendTextResponse(`I heard: ${transcript}`, {
          allowInterruptions: true,
        });
      }
    });
    transcriptSubscriptions.set(session.sessionId, unsubscribe);
  },
  onSessionClosed: ({ session }) => {
    transcriptSubscriptions.get(session.sessionId)?.();
    transcriptSubscriptions.delete(session.sessionId);
  },
  onError: (error) => console.error("RTC gateway error", error),
});

const detachGateway = gateway.attach(server);

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});
app.use(express.static(path.join(__dirname, "dist")));
app.get("/{*splat}", (_request, response) => {
  response.sendFile(path.join(__dirname, "dist", "index.html"));
});

async function shutdown(signal) {
  console.log(`received ${signal}; closing RTC gateway`);
  detachGateway();
  await gateway.close("server_shutdown");
  await new Promise((resolve) => server.close(resolve));
}

async function main() {
  server.listen(PORT, HOST, () => {
    console.log(`Vox RTC gateway example listening on http://${HOST}:${PORT}`);
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void shutdown(signal).then(() => process.exit(0));
  });
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
