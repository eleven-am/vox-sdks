import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { VoxRtcBrowserClient } from "@eleven-am/vox-rtc-client";

import "./styles.css";

const defaultText = "Hello. This response is being sent through the Express server using the TypeScript server SDK. The browser media path is running through the browser SDK. Interrupt me to verify the full path.";
const defaultClientEvent = JSON.stringify({
  event: "render.url",
  payload: {
    url: "https://example.com",
    label: "Example link",
  },
}, null, 2);

function now() {
  return new Date().toISOString();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  if (response.status === 204) {
    return null;
  }
  return response.json();
}

function parseClientEvent(value) {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Client event must be a JSON object");
  }
  if (typeof parsed.event !== "string" || !parsed.event.trim()) {
    throw new Error("Client event requires a non-empty event string");
  }
  return {
    event: parsed.event.trim(),
    payload: Object.prototype.hasOwnProperty.call(parsed, "payload") ? parsed.payload : null,
  };
}

function Status({ label, value }) {
  return (
    <div className="status">
      <span>{label}</span>
      <strong>{value || "idle"}</strong>
    </div>
  );
}

function App() {
  const audioRef = useRef(null);
  const clientRef = useRef(null);
  const controlEventsRef = useRef(null);
  const unsubscribersRef = useRef([]);
  const [config, setConfig] = useState({
    sttModel: "parakeet-stt-onnx:tdt-0.6b-v3",
    ttsModel: "kokoro-tts-onnx:v1.0",
    voice: "af_heart",
    turnProfile: "browser_default",
  });
  const [sessionId, setSessionId] = useState(null);
  const [state, setState] = useState({
    status: "idle",
    peerConnectionState: "idle",
    iceConnectionState: "idle",
    dataChannelState: "idle",
  });
  const [turnState, setTurnState] = useState("idle");
  const [playbackState, setPlaybackState] = useState("idle");
  const [interruptions, setInterruptions] = useState(0);
  const [falsePositives, setFalsePositives] = useState(0);
  const [echoEnabled, setEchoEnabled] = useState(true);
  const [echoCount, setEchoCount] = useState(0);
  const [lastTranscript, setLastTranscript] = useState("none");
  const [finalAfterStopMs, setFinalAfterStopMs] = useState(null);
  const [echoLatencyMs, setEchoLatencyMs] = useState(null);
  const [responseAcceptMs, setResponseAcceptMs] = useState(null);
  const [responseDoneMs, setResponseDoneMs] = useState(null);
  const [assistantText, setAssistantText] = useState(defaultText);
  const [clientEventText, setClientEventText] = useState(defaultClientEvent);
  const [logs, setLogs] = useState([]);
  const [timeline, setTimeline] = useState([]);
  const [dataEvents, setDataEvents] = useState([]);

  const connected = state.status === "connected";

  const addLog = useCallback((type, payload = {}) => {
    setLogs((items) => [...items.slice(-160), { at: now(), type, payload }]);
  }, []);

  const addTimeline = useCallback((type, payload = {}) => {
    setTimeline((items) => [{ at: new Date().toLocaleTimeString(), type, payload }, ...items].slice(0, 80));
  }, []);

  const addDataEvent = useCallback((direction, payload) => {
    setDataEvents((items) => [...items.slice(-80), { at: now(), direction, payload }]);
  }, []);

  const closeControlEvents = useCallback(() => {
    controlEventsRef.current?.close();
    controlEventsRef.current = null;
  }, []);

  const openControlEvents = useCallback((nextSessionId) => {
    closeControlEvents();
    const source = new EventSource(`/api/rtc/session/${nextSessionId}/events`);
    controlEventsRef.current = source;
    source.onmessage = (message) => {
      const event = JSON.parse(message.data);
      clientRef.current?.handleControlEvent(event);
      addLog("control.event", event);
      addTimeline(event.type, event.data || {});
      if (event.type === "client.event") {
        addDataEvent("backend<-browser", {
          event: event.data?.event,
          payload: Object.prototype.hasOwnProperty.call(event.data || {}, "payload") ? event.data.payload : null,
        });
      }
      if (event.type === "conversation.item.input_audio_transcription.completed") {
        setLastTranscript(event.data?.transcript || "none");
      }
      if (event.type === "local.echo.sent") {
        setEchoCount(event.data?.count || 0);
        setEchoLatencyMs(event.data?.ms_since_transcript_received ?? null);
        setPlaybackState("echo sent");
      }
      if (event.type === "local.echo.state") {
        setEchoEnabled(event.data?.enabled !== false);
      }
      if (event.type === "local.timing.transcript_received") {
        setFinalAfterStopMs(event.data?.ms_since_speech_stopped ?? null);
      }
      if (event.type === "local.timing.response_created") {
        setResponseAcceptMs(event.data?.ms_since_transcript_received ?? null);
      }
      if (event.type === "local.timing.response_done") {
        setResponseDoneMs(event.data?.ms_since_transcript_received ?? null);
      }
      if (event.type === "session.created") setTurnState("listening");
      if (event.type === "response.created") setPlaybackState("starting");
      if (event.type === "response.done") setPlaybackState("done");
      if (event.type === "response.cancelled") setPlaybackState("cancelled");
      if (event.type === "response.audio.clear") {
        audioRef.current?.pause();
        setPlaybackState("cleared");
      }
      if (event.type === "interruption.detected") {
        setInterruptions((value) => value + 1);
      }
      if (event.type === "interruption.false_positive") {
        setFalsePositives((value) => value + 1);
      }
      if (event.type === "turn.state_changed") {
        setTurnState(event.data?.state || "idle");
      }
    };
    source.onerror = () => addLog("control.events.error");
  }, [addDataEvent, addLog, addTimeline, closeControlEvents]);

  const cleanupClient = useCallback(async () => {
    closeControlEvents();
    for (const unsubscribe of unsubscribersRef.current) {
      unsubscribe();
    }
    unsubscribersRef.current = [];
    const client = clientRef.current;
    clientRef.current = null;
    if (client) {
      await client.disconnect();
    }
  }, [closeControlEvents]);

  const connect = useCallback(async () => {
    setState((value) => ({ ...value, status: "connecting" }));
    setEchoCount(0);
    setLastTranscript("none");
    setFinalAfterStopMs(null);
    setEchoLatencyMs(null);
    setResponseAcceptMs(null);
    setResponseDoneMs(null);
    const client = new VoxRtcBrowserClient({
      audioElement: audioRef.current,
      audioDucking: {
        mode: "vox",
        duckVolume: 0.2,
        sustainedVolume: 0.05,
      },
      audioConstraints: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 48000 },
      },
      session: async () => api("/api/rtc/session", {
        method: "POST",
        body: JSON.stringify({ ...config, echoTranscripts: echoEnabled }),
      }),
    });
    clientRef.current = client;
    unsubscribersRef.current = [
      client.on("session", (session) => {
        setSessionId(session.sessionId);
        addLog("session", session);
        addTimeline("session", { state: session.sessionId });
        openControlEvents(session.sessionId);
      }),
      client.on("state", setState),
      client.on("dataChannelOpen", () => {
        addLog("datachannel.open");
        addTimeline("datachannel.open");
      }),
      client.on("dataChannelClose", () => {
        addLog("datachannel.close");
        addTimeline("datachannel.close");
      }),
      client.on("dataMessage", (message) => {
        addLog("datachannel.message", message);
        addDataEvent("browser<-backend", message);
      }),
      client.on("localIceCandidate", (candidate) => addLog("local.ice_candidate", candidate)),
      client.on("serverIceCandidate", (candidate) => addLog("sse.ice", candidate)),
      client.on("serverConnectionState", (payload) => addLog("sse.connection", payload)),
      client.on("serverIceConnectionState", (payload) => addLog("sse.ice_connection", payload)),
      client.on("error", (error) => addLog("client.error", { message: error.message })),
    ];
    await client.connect();
  }, [addDataEvent, addLog, addTimeline, config, echoEnabled, openControlEvents]);

  const disconnect = useCallback(async () => {
    const oldSessionId = sessionId;
    await cleanupClient();
    if (oldSessionId) {
      await api(`/api/rtc/session/${oldSessionId}`, { method: "DELETE" }).catch(() => {});
    }
    setSessionId(null);
    setTurnState("idle");
    setPlaybackState("idle");
    setEchoCount(0);
    setLastTranscript("none");
    setFinalAfterStopMs(null);
    setEchoLatencyMs(null);
    setResponseAcceptMs(null);
    setResponseDoneMs(null);
    setState({
      status: "closed",
      peerConnectionState: "idle",
      iceConnectionState: "idle",
      dataChannelState: "idle",
    });
  }, [cleanupClient, sessionId]);

  const sendResponse = useCallback(async () => {
    if (!sessionId) return;
    await api(`/api/rtc/session/${sessionId}/respond`, {
      method: "POST",
      body: JSON.stringify({
        text: assistantText,
        allowInterruptions: true,
      }),
    });
  }, [assistantText, sessionId]);

  const cancelResponse = useCallback(async () => {
    if (!sessionId) return;
    await api(`/api/rtc/session/${sessionId}/cancel`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }, [sessionId]);

  const updateEchoEnabled = useCallback(async (enabled) => {
    setEchoEnabled(enabled);
    if (!sessionId) return;
    try {
      await api(`/api/rtc/session/${sessionId}/echo`, {
        method: "POST",
        body: JSON.stringify({ enabled }),
      });
    } catch (error) {
      setEchoEnabled(!enabled);
      throw error;
    }
  }, [sessionId]);

  const sendServerControlEvent = useCallback(async () => {
    if (!sessionId) return;
    const envelope = parseClientEvent(clientEventText);
    await api(`/api/rtc/session/${sessionId}/client-event`, {
      method: "POST",
      body: JSON.stringify(envelope),
    });
    addLog("control.client_event.sent", envelope);
  }, [addLog, clientEventText, sessionId]);

  const sendDataChannelEvent = useCallback(() => {
    const envelope = parseClientEvent(clientEventText);
    clientRef.current?.sendEvent(envelope);
    addDataEvent("browser->backend", envelope);
    addLog("datachannel.sent", envelope);
  }, [addDataEvent, addLog, clientEventText]);

  useEffect(() => () => {
    cleanupClient().catch(() => {});
  }, [cleanupClient]);

  return (
    <main>
      <h1>Vox RTC React Proxy Demo</h1>

      <section className="grid">
        <label>
          STT model
          <input value={config.sttModel} onChange={(event) => setConfig({ ...config, sttModel: event.target.value })} />
        </label>
        <label>
          TTS model
          <input value={config.ttsModel} onChange={(event) => setConfig({ ...config, ttsModel: event.target.value })} />
        </label>
        <label>
          Voice
          <input value={config.voice} onChange={(event) => setConfig({ ...config, voice: event.target.value })} />
        </label>
        <label>
          Turn profile
          <select value={config.turnProfile} onChange={(event) => setConfig({ ...config, turnProfile: event.target.value })}>
            <option value="default">default</option>
            <option value="browser_default">browser_default</option>
            <option value="headset">headset</option>
            <option value="speakerphone">speakerphone</option>
            <option value="noisy_room">noisy_room</option>
          </select>
        </label>
      </section>

      <section className="status-grid">
        <Status label="Client" value={state.status} />
        <Status label="Peer" value={state.peerConnectionState} />
        <Status label="ICE" value={state.iceConnectionState} />
        <Status label="Data channel" value={state.dataChannelState} />
        <Status label="Playback" value={playbackState} />
        <Status label="Turn" value={turnState} />
        <Status label="Interruptions" value={String(interruptions)} />
        <Status label="False positives" value={String(falsePositives)} />
        <Status label="Echo" value={echoEnabled ? "on" : "off"} />
        <Status label="Echoes" value={String(echoCount)} />
        <Status label="Final after stop" value={finalAfterStopMs === null ? "n/a" : `${finalAfterStopMs}ms`} />
        <Status label="Echo send" value={echoLatencyMs === null ? "n/a" : `${echoLatencyMs}ms`} />
        <Status label="Response accept" value={responseAcceptMs === null ? "n/a" : `${responseAcceptMs}ms`} />
        <Status label="Response done" value={responseDoneMs === null ? "n/a" : `${responseDoneMs}ms`} />
        <Status label="Session" value={sessionId || "none"} />
      </section>

      <section>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={echoEnabled}
            onChange={(event) => updateEchoEnabled(event.target.checked).catch((error) => addLog("error", { message: error.message }))}
          />
          <span>Server echo final transcripts</span>
        </label>
        <p className="hint">Last final transcript: {lastTranscript}</p>
        <div className="actions">
          <button disabled={connected || state.status === "connecting"} onClick={() => connect().catch((error) => addLog("error", { message: error.message }))}>Connect</button>
          <button disabled={!sessionId} onClick={() => disconnect().catch((error) => addLog("error", { message: error.message }))}>Disconnect</button>
        </div>
        <p className="hint">React imports the browser SDK. Express keeps the API key and the server-side control session.</p>
        <audio ref={audioRef} autoPlay playsInline controls />
      </section>

      <section>
        <label>
          Assistant text
          <textarea value={assistantText} onChange={(event) => setAssistantText(event.target.value)} />
        </label>
        <div className="actions">
          <button disabled={!sessionId} onClick={() => sendResponse().catch((error) => addLog("error", { message: error.message }))}>Send response</button>
          <button disabled={!sessionId} onClick={() => cancelResponse().catch((error) => addLog("error", { message: error.message }))}>Cancel response</button>
        </div>
      </section>

      <section>
        <label>
          Client event JSON
          <textarea value={clientEventText} onChange={(event) => setClientEventText(event.target.value)} />
        </label>
        <div className="actions">
          <button disabled={!sessionId} onClick={() => sendServerControlEvent().catch((error) => addLog("error", { message: error.message }))}>Send via server control</button>
          <button disabled={state.dataChannelState !== "open"} onClick={() => {
            try {
              sendDataChannelEvent();
            } catch (error) {
              addLog("client_event.error", { message: error.message });
            }
          }}>Send via data channel</button>
        </div>
        <pre>{dataEvents.map((item) => `[${item.at}] ${item.direction} ${JSON.stringify(item.payload)}`).join("\n")}</pre>
      </section>

      <section>
        <div className="timeline">
          {timeline.map((item, index) => (
            <div key={`${item.at}-${index}`}>
              <span>{item.at}</span>
              <strong>{item.type}{item.payload?.state ? ` ${item.payload.state}` : item.payload?.response_id ? ` ${item.payload.response_id}` : ""}</strong>
            </div>
          ))}
        </div>
      </section>

      <section>
        <pre>{logs.map((item) => `[${item.at}] ${item.type} ${JSON.stringify(item.payload)}`).join("\n")}</pre>
      </section>
    </main>
  );
}

const rootElement = document.querySelector("#root");
globalThis.__voxRtcDemoRoot ??= createRoot(rootElement);
globalThis.__voxRtcDemoRoot.render(<App />);
