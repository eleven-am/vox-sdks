import type {
  EventSourceFactory,
  EventSourceLike,
  GetUserMedia,
  PeerConnectionFactory,
  Unsubscribe,
  VoxRtcBrowserClientOptions,
  VoxRtcBrowserConnectOptions,
  VoxRtcBrowserEventName,
  VoxRtcBrowserEvents,
  VoxRtcBrowserHandler,
  VoxRtcBrowserSessionBootstrap,
  VoxRtcBrowserState,
  VoxRtcAudioDuckingOptions,
  VoxRtcAudioDuckingMode,
  VoxRtcControlEventLike,
  VoxRtcClientEventEnvelope,
  VoxRtcOfferResponse,
} from "./types.js";

type ListenerMap = {
  [K in VoxRtcBrowserEventName]?: Set<VoxRtcBrowserHandler<K>>;
};

type NormalizedAudioDuckingConfig = {
  mode: VoxRtcAudioDuckingMode;
  threshold: number;
  duckVolume: number;
  sustainedVolume: number;
  sustainedAfterMs: number;
  localHoldMs: number;
  releaseDelayMs: number;
  pollIntervalMs: number;
};

type AudioContextConstructor = typeof AudioContext;

const DEFAULT_AUDIO_DUCKING_CONFIG: NormalizedAudioDuckingConfig = {
  mode: "vox",
  threshold: 0.035,
  duckVolume: 0.2,
  sustainedVolume: 0.05,
  sustainedAfterMs: 700,
  localHoldMs: 500,
  releaseDelayMs: 350,
  pollIntervalMs: 50,
};

const DUCKING_VOX_START_EVENTS = new Set([
  "input_audio_buffer.speech_started",
  "interruption.detected",
]);

const DUCKING_VOX_STOP_EVENTS = new Set([
  "input_audio_buffer.speech_stopped",
  "interruption.false_positive",
  "response.audio.clear",
  "response.cancelled",
  "response.done",
]);

function normalizeBase(base: string): string {
  return base.replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(data: Record<string, unknown>, camelKey: string, snakeKey: string): string {
  const value = data[camelKey] ?? data[snakeKey];
  if (typeof value !== "string" || !value) {
    throw new Error(`Missing required RTC bootstrap field: ${camelKey}`);
  }
  return value;
}

function normalizeBootstrap(data: unknown): VoxRtcBrowserSessionBootstrap {
  if (!isRecord(data)) {
    throw new Error("RTC session bootstrap must be an object");
  }
  const iceServers = data.iceServers ?? data.ice_servers;
  if (!Array.isArray(iceServers)) {
    throw new Error("RTC session bootstrap must include iceServers");
  }
  return {
    sessionId: requiredString(data, "sessionId", "session_id"),
    clientToken: requiredString(data, "clientToken", "client_token"),
    iceServers: iceServers as RTCIceServer[],
    voxHttpBase: typeof data.voxHttpBase === "string" ? data.voxHttpBase : undefined,
    expiresAt: typeof data.expiresAt === "string"
      ? data.expiresAt
      : typeof data.expires_at === "string"
        ? data.expires_at
        : undefined,
    joinTokenTtlSeconds: typeof data.joinTokenTtlSeconds === "number"
      ? data.joinTokenTtlSeconds
      : typeof data.join_token_ttl_seconds === "number"
        ? data.join_token_ttl_seconds
        : undefined,
  };
}

function normalizeOfferResponse(data: unknown): VoxRtcOfferResponse {
  if (!isRecord(data)) {
    throw new Error("RTC offer response must be an object");
  }
  return {
    sessionId: requiredString(data, "sessionId", "session_id"),
    mediaToken: requiredString(data, "mediaToken", "media_token"),
    type: requiredString(data, "type", "type") as RTCSdpType,
    sdp: requiredString(data, "sdp", "sdp"),
    eventsUrl: requiredString(data, "eventsUrl", "events_url"),
  };
}

function defaultPeerConnectionFactory(configuration: RTCConfiguration): RTCPeerConnection {
  return new RTCPeerConnection(configuration);
}

function defaultEventSourceFactory(url: string): EventSourceLike {
  return new EventSource(url);
}

function defaultGetUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("navigator.mediaDevices.getUserMedia is unavailable");
  }
  return navigator.mediaDevices.getUserMedia(constraints);
}

function defaultFetch(...args: Parameters<typeof fetch>): ReturnType<typeof fetch> {
  return globalThis.fetch(...args);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function normalizeAudioDuckingConfig(
  value: boolean | VoxRtcAudioDuckingOptions | undefined,
): NormalizedAudioDuckingConfig | null {
  if (!value) {
    return null;
  }
  if (value === true) {
    return { ...DEFAULT_AUDIO_DUCKING_CONFIG };
  }
  if (value.enabled === false) {
    return null;
  }
  const mode = value.mode === "local" || value.mode === "hybrid" ? value.mode : "vox";
  return {
    mode,
    threshold: clampNumber(value.threshold, DEFAULT_AUDIO_DUCKING_CONFIG.threshold, 0, 1),
    duckVolume: clampNumber(value.duckVolume, DEFAULT_AUDIO_DUCKING_CONFIG.duckVolume, 0, 1),
    sustainedVolume: clampNumber(
      value.sustainedVolume,
      DEFAULT_AUDIO_DUCKING_CONFIG.sustainedVolume,
      0,
      1,
    ),
    sustainedAfterMs: clampNumber(
      value.sustainedAfterMs,
      DEFAULT_AUDIO_DUCKING_CONFIG.sustainedAfterMs,
      0,
      60_000,
    ),
    localHoldMs: clampNumber(
      value.localHoldMs,
      DEFAULT_AUDIO_DUCKING_CONFIG.localHoldMs,
      0,
      60_000,
    ),
    releaseDelayMs: clampNumber(
      value.releaseDelayMs,
      DEFAULT_AUDIO_DUCKING_CONFIG.releaseDelayMs,
      0,
      60_000,
    ),
    pollIntervalMs: clampNumber(
      value.pollIntervalMs,
      DEFAULT_AUDIO_DUCKING_CONFIG.pollIntervalMs,
      16,
      1_000,
    ),
  };
}

function getAudioContextConstructor(): AudioContextConstructor | undefined {
  return (
    globalThis as typeof globalThis & {
      webkitAudioContext?: AudioContextConstructor;
    }
  ).AudioContext ?? (
    globalThis as typeof globalThis & {
      webkitAudioContext?: AudioContextConstructor;
    }
  ).webkitAudioContext;
}

function nowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function eventTypeFromControlEvent(event: VoxRtcControlEventLike): string {
  if (typeof event === "string") {
    return event;
  }
  if (isRecord(event)) {
    if (typeof event.type === "string") {
      return event.type;
    }
    if (typeof event.event === "string") {
      return event.event;
    }
  }
  return "";
}

function payloadFromControlEvent(event: VoxRtcControlEventLike): Record<string, unknown> {
  if (!isRecord(event)) {
    return {};
  }
  if (isRecord(event.data)) {
    return event.data;
  }
  if (isRecord(event.payload)) {
    return event.payload;
  }
  return event;
}

function parseDataMessage(data: unknown): VoxRtcClientEventEnvelope | { raw: unknown } {
  if (typeof data !== "string") {
    return { raw: data };
  }
  try {
    const parsed = JSON.parse(data);
    if (isRecord(parsed) && typeof parsed.event === "string") {
      return {
        event: parsed.event,
        payload: Object.prototype.hasOwnProperty.call(parsed, "payload") ? parsed.payload : null,
      };
    }
    return { raw: parsed };
  } catch {
    return { raw: data };
  }
}

function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) {
    track.onended = null;
    track.onmute = null;
    track.onunmute = null;
    track.stop();
  }
}

export class VoxRtcBrowserClient {
  readonly #fetch: typeof fetch;
  readonly #peerConnectionFactory: PeerConnectionFactory;
  readonly #eventSourceFactory: EventSourceFactory;
  readonly #getUserMedia: GetUserMedia;
  readonly #sessionProvider?: VoxRtcBrowserSessionBootstrap | (() => Promise<VoxRtcBrowserSessionBootstrap>);
  readonly #sessionEndpoint?: string;
  readonly #configuredHttpBase?: string;
  readonly #audioElement?: HTMLAudioElement;
  readonly #defaultAudioConstraints: boolean | MediaTrackConstraints;
  readonly #autoPlayRemoteAudio: boolean;
  readonly #iceTransportPolicy?: RTCIceTransportPolicy;
  readonly #dataChannelLabel: string;
  readonly #audioDuckingConfig: NormalizedAudioDuckingConfig | null;
  readonly #listeners: ListenerMap = {};

  #status: VoxRtcBrowserState["status"] = "idle";
  #session: VoxRtcBrowserSessionBootstrap | null = null;
  #httpBase: string | null = null;
  #mediaToken: string | null = null;
  #peerConnection: RTCPeerConnection | null = null;
  #dataChannel: RTCDataChannel | null = null;
  #eventSource: EventSourceLike | null = null;
  #eventSourceCleanups: Unsubscribe[] = [];
  #localStream: MediaStream | null = null;
  #remoteStream: MediaStream | null = null;
  #pendingCandidates: Array<RTCIceCandidateInit | null> = [];
  #audioDuckingContext: AudioContext | null = null;
  #audioDuckingSource: MediaStreamAudioSourceNode | null = null;
  #audioDuckingAnalyser: AnalyserNode | null = null;
  #audioDuckingBuffer: Uint8Array<ArrayBuffer> | null = null;
  #audioDuckingTimer: ReturnType<typeof setInterval> | null = null;
  #audioDuckingReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  #audioDuckingBaseVolume: number | null = null;
  #audioDuckingStartedAt: number | null = null;
  #audioDuckingLocalActive = false;
  #audioDuckingLocalStartedAt: number | null = null;
  #audioDuckingLocalLastVoiceAt: number | null = null;
  #audioDuckingLocalSuppressed = false;
  #audioDuckingVoxActive = false;

  constructor(options: VoxRtcBrowserClientOptions = {}) {
    this.#fetch = options.fetch ?? defaultFetch;
    this.#peerConnectionFactory = options.peerConnectionFactory ?? defaultPeerConnectionFactory;
    this.#eventSourceFactory = options.eventSourceFactory ?? defaultEventSourceFactory;
    this.#getUserMedia = options.getUserMedia ?? defaultGetUserMedia;
    this.#sessionProvider = options.session;
    this.#sessionEndpoint = options.sessionEndpoint;
    this.#configuredHttpBase = options.httpBase ? normalizeBase(options.httpBase) : undefined;
    this.#audioElement = options.audioElement;
    this.#defaultAudioConstraints = options.audioConstraints ?? true;
    this.#autoPlayRemoteAudio = options.autoPlayRemoteAudio ?? true;
    this.#iceTransportPolicy = options.iceTransportPolicy;
    this.#dataChannelLabel = options.dataChannelLabel ?? "vox-events";
    this.#audioDuckingConfig = normalizeAudioDuckingConfig(options.audioDucking);
  }

  get state(): VoxRtcBrowserState {
    return {
      status: this.#status,
      sessionId: this.#session?.sessionId ?? null,
      peerConnectionState: this.#peerConnection?.connectionState ?? "idle",
      iceConnectionState: this.#peerConnection?.iceConnectionState ?? "idle",
      dataChannelState: this.#dataChannel?.readyState ?? "idle",
    };
  }

  get session(): VoxRtcBrowserSessionBootstrap | null {
    return this.#session;
  }

  get localStream(): MediaStream | null {
    return this.#localStream;
  }

  get remoteStream(): MediaStream | null {
    return this.#remoteStream;
  }

  on<T extends VoxRtcBrowserEventName>(eventName: T, handler: VoxRtcBrowserHandler<T>): Unsubscribe {
    const listeners = this.#listeners[eventName] ?? new Set();
    listeners.add(handler);
    this.#listeners[eventName] = listeners as ListenerMap[T];
    return () => {
      listeners.delete(handler);
    };
  }

  onClientEvent(handler: (event: VoxRtcClientEventEnvelope) => void): Unsubscribe {
    return this.on("clientEvent", handler);
  }

  async connect(options: VoxRtcBrowserConnectOptions = {}): Promise<VoxRtcBrowserSessionBootstrap> {
    if (this.#status === "connected" || this.#status === "connecting") {
      throw new Error(`Vox RTC client is already ${this.#status}`);
    }
    this.#setStatus("connecting");
    try {
      const session = await this.#resolveSession(options.session);
      this.#session = session;
      this.#httpBase = normalizeBase(session.voxHttpBase ?? this.#configuredHttpBase ?? "");
      if (!this.#httpBase) {
        throw new Error("Vox HTTP base is required. Pass httpBase or include voxHttpBase in the session bootstrap.");
      }
      this.#emit("session", session);

      const pc = this.#peerConnectionFactory({
        iceServers: session.iceServers,
        iceTransportPolicy: this.#iceTransportPolicy,
      });
      this.#peerConnection = pc;
      this.#bindPeerConnection(pc);
      this.#bindDataChannel(pc.createDataChannel(this.#dataChannelLabel, { ordered: true }));

      const audioConstraints = options.audioConstraints ?? this.#defaultAudioConstraints;
      if (audioConstraints !== false) {
        const localStream = await this.#getUserMedia({ audio: audioConstraints });
        this.#localStream = localStream;
        for (const track of localStream.getAudioTracks()) {
          pc.addTrack(track, localStream);
        }
        this.#startLocalAudioDucking(localStream);
        this.#emit("localStream", localStream);
      }

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (!pc.localDescription?.sdp) {
        throw new Error("Local SDP offer is missing after setLocalDescription");
      }

      const answer = await this.#postVoxJson(
        `/v1/rtc/sessions/${session.sessionId}/offer`,
        { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
        session.clientToken,
      );
      const normalizedAnswer = normalizeOfferResponse(answer);
      this.#mediaToken = normalizedAnswer.mediaToken;
      await pc.setRemoteDescription({ type: normalizedAnswer.type, sdp: normalizedAnswer.sdp });
      await this.#flushCandidates();
      this.#attachEvents(normalizedAnswer.eventsUrl);
      this.#setStatus("connected");
      return session;
    } catch (error) {
      this.#emit("error", error instanceof Error ? error : new Error(String(error)));
      await this.disconnect();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.#status === "closed" || this.#status === "idle") {
      this.#cleanup();
      this.#setStatus("closed");
      return;
    }
    this.#setStatus("disconnecting");
    this.#cleanup();
    this.#setStatus("closed");
  }

  async replaceMicrophone(audioConstraints: boolean | MediaTrackConstraints = this.#defaultAudioConstraints): Promise<MediaStream> {
    if (!this.#peerConnection) {
      throw new Error("Cannot replace microphone before connect()");
    }
    if (audioConstraints === false) {
      throw new Error("replaceMicrophone requires audio constraints");
    }
    const nextStream = await this.#getUserMedia({ audio: audioConstraints });
    const nextTrack = nextStream.getAudioTracks()[0];
    if (!nextTrack) {
      nextStream.getTracks().forEach((track) => track.stop());
      throw new Error("No audio track returned by getUserMedia");
    }
    const sender = this.#peerConnection.getSenders().find((item) => item.track?.kind === "audio");
    if (sender) {
      await sender.replaceTrack(nextTrack);
    } else {
      this.#peerConnection.addTrack(nextTrack, nextStream);
    }
    this.#localStream?.getTracks().forEach((track) => track.stop());
    this.#localStream = nextStream;
    this.#stopAudioDucking({ restoreVolume: true });
    this.#startLocalAudioDucking(nextStream);
    this.#emit("localStream", nextStream);
    return nextStream;
  }

  sendEvent(envelope: VoxRtcClientEventEnvelope): void {
    if (!this.#dataChannel || this.#dataChannel.readyState !== "open") {
      throw new Error("Vox RTC data channel is not open");
    }
    if (!envelope.event.trim()) {
      throw new Error("Client event requires a non-empty event name");
    }
    this.#dataChannel.send(JSON.stringify({
      event: envelope.event,
      payload: Object.prototype.hasOwnProperty.call(envelope, "payload") ? envelope.payload : null,
    }));
  }

  handleControlEvent(event: VoxRtcControlEventLike): void {
    this.#handleAudioDuckingControlEvent(event);
  }

  async #resolveSession(override?: VoxRtcBrowserSessionBootstrap): Promise<VoxRtcBrowserSessionBootstrap> {
    if (override) {
      return normalizeBootstrap(override);
    }
    if (typeof this.#sessionProvider === "function") {
      return normalizeBootstrap(await this.#sessionProvider());
    }
    if (this.#sessionProvider) {
      return normalizeBootstrap(this.#sessionProvider);
    }
    if (this.#sessionEndpoint) {
      const response = await this.#fetch(this.#sessionEndpoint, { method: "POST" });
      if (!response.ok) {
        throw new Error(`Failed to create RTC session: ${response.status} ${await response.text()}`);
      }
      return normalizeBootstrap(await response.json());
    }
    throw new Error("No RTC session source configured. Pass session, session provider, or sessionEndpoint.");
  }

  #bindPeerConnection(pc: RTCPeerConnection): void {
    pc.ontrack = (event) => {
      this.#remoteStream = event.streams[0] ?? this.#remoteStream;
      if (this.#remoteStream && this.#audioElement) {
        this.#audioElement.srcObject = this.#remoteStream;
        if (this.#autoPlayRemoteAudio) {
          this.#audioElement.play().catch(() => {});
        }
      }
      if (this.#remoteStream) {
        this.#emit("remoteStream", this.#remoteStream);
      }
      this.#emit("remoteTrack", event);
    };
    pc.ondatachannel = (event) => this.#bindDataChannel(event.channel);
    pc.onicecandidate = (event) => {
      const candidate = event.candidate ? event.candidate.toJSON() : null;
      this.#emit("localIceCandidate", candidate);
      if (!this.#mediaToken) {
        this.#pendingCandidates.push(candidate);
        return;
      }
      this.#postCandidate(candidate).catch((error) => this.#emit("error", error));
    };
    pc.onconnectionstatechange = () => this.#emitState();
    pc.oniceconnectionstatechange = () => this.#emitState();
  }

  #bindDataChannel(channel: RTCDataChannel): void {
    this.#dataChannel = channel;
    this.#emitState();
    channel.onopen = () => {
      this.#emitState();
      this.#emit("dataChannelOpen", channel);
    };
    channel.onclose = () => {
      this.#emitState();
      this.#emit("dataChannelClose", channel);
    };
    channel.onerror = (event) => {
      this.#emit("dataChannelError", event);
    };
    channel.onmessage = (event) => {
      const message = parseDataMessage(event.data);
      this.#emit("dataMessage", message);
      if ("event" in message) {
        this.#emit("clientEvent", message);
      }
    };
  }

  #attachEvents(eventsUrl: string): void {
    if (!this.#httpBase) {
      throw new Error("Cannot attach RTC events without Vox HTTP base");
    }
    this.#closeEventSource();
    const url = eventsUrl.startsWith("http") ? eventsUrl : `${this.#httpBase}${eventsUrl}`;
    const eventSource = this.#eventSourceFactory(url);
    this.#eventSource = eventSource;

    eventSource.onmessage = (event) => {
      this.#emit("sseMessage", JSON.parse(event.data) as Record<string, unknown>);
    };
    const addEventSourceListener = (type: string, listener: (event: MessageEvent<string>) => void) => {
      eventSource.addEventListener(type, listener);
      this.#eventSourceCleanups.push(() => eventSource.removeEventListener?.(type, listener));
    };

    addEventSourceListener("rtc.ice_candidate", (event) => {
      const payload = JSON.parse(event.data) as { candidate?: RTCIceCandidateInit | null };
      const candidate = payload.candidate ?? null;
      this.#emit("serverIceCandidate", candidate);
      this.#peerConnection?.addIceCandidate(candidate).catch((error) => this.#emit("error", error));
    });
    addEventSourceListener("rtc.connection_state", (event) => {
      this.#emit("serverConnectionState", JSON.parse(event.data) as Record<string, unknown>);
    });
    addEventSourceListener("rtc.ice_connection_state", (event) => {
      this.#emit("serverIceConnectionState", JSON.parse(event.data) as Record<string, unknown>);
    });
  }

  async #flushCandidates(): Promise<void> {
    const candidates = this.#pendingCandidates;
    this.#pendingCandidates = [];
    for (const candidate of candidates) {
      await this.#postCandidate(candidate);
    }
  }

  async #postCandidate(candidate: RTCIceCandidateInit | null): Promise<void> {
    if (!this.#session || !this.#mediaToken) {
      this.#pendingCandidates.push(candidate);
      return;
    }
    await this.#postVoxJson(
      `/v1/rtc/sessions/${this.#session.sessionId}/candidates`,
      { candidate },
      this.#mediaToken,
    );
  }

  async #postVoxJson(path: string, body: unknown, token: string): Promise<unknown> {
    if (!this.#httpBase) {
      throw new Error("Vox HTTP base is not configured");
    }
    const response = await this.#fetch(`${this.#httpBase}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Vox request failed: ${response.status} ${await response.text()}`);
    }
    if (response.status === 204) {
      return {};
    }
    return response.json();
  }

  #closeEventSource(): void {
    const eventSource = this.#eventSource;
    this.#eventSource = null;
    for (const cleanup of this.#eventSourceCleanups.splice(0)) {
      cleanup();
    }
    if (eventSource) {
      eventSource.onmessage = null;
      eventSource.close();
    }
  }

  #startLocalAudioDucking(stream: MediaStream): void {
    if (!this.#audioDuckingConfig || !this.#audioElement || !this.#usesLocalAudioDucking()) {
      return;
    }
    this.#stopAudioDucking({ restoreVolume: true });
    const AudioContextClass = getAudioContextConstructor();
    if (!AudioContextClass) {
      this.#emit("error", new Error("Audio ducking requires AudioContext support"));
      return;
    }
    try {
      const context = new AudioContextClass();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.2;
      source.connect(analyser);
      this.#audioDuckingContext = context;
      this.#audioDuckingSource = source;
      this.#audioDuckingAnalyser = analyser;
      this.#audioDuckingBuffer = new Uint8Array(analyser.fftSize);
      if (context.state === "suspended") {
        context.resume().catch(() => {});
      }
      this.#audioDuckingTimer = setInterval(
        () => this.#updateAudioDucking(),
        this.#audioDuckingConfig.pollIntervalMs,
      );
    } catch (error) {
      this.#stopAudioDucking({ restoreVolume: true });
      this.#emit("error", error instanceof Error ? error : new Error(String(error)));
    }
  }

  #stopAudioDucking({ restoreVolume }: { restoreVolume: boolean }): void {
    if (this.#audioDuckingTimer !== null) {
      clearInterval(this.#audioDuckingTimer);
      this.#audioDuckingTimer = null;
    }
    if (this.#audioDuckingReleaseTimer !== null) {
      clearTimeout(this.#audioDuckingReleaseTimer);
      this.#audioDuckingReleaseTimer = null;
    }
    try {
      this.#audioDuckingSource?.disconnect();
    } catch {}
    try {
      this.#audioDuckingAnalyser?.disconnect();
    } catch {}
    this.#audioDuckingContext?.close().catch(() => {});
    this.#audioDuckingContext = null;
    this.#audioDuckingSource = null;
    this.#audioDuckingAnalyser = null;
    this.#audioDuckingBuffer = null;
    if (restoreVolume) {
      this.#restoreDuckedVolume();
    } else {
      this.#resetAudioDuckingState();
    }
  }

  #updateAudioDucking(): void {
    const config = this.#audioDuckingConfig;
    const analyser = this.#audioDuckingAnalyser;
    const buffer = this.#audioDuckingBuffer;
    const audioElement = this.#audioElement;
    if (!config || !analyser || !buffer || !audioElement) {
      return;
    }

    analyser.getByteTimeDomainData(buffer);
    let sum = 0;
    for (const value of buffer) {
      const centered = (value - 128) / 128;
      sum += centered * centered;
    }
    const rms = Math.sqrt(sum / buffer.length);
    const time = nowMs();

    if (rms >= config.threshold) {
      if (this.#audioDuckingLocalSuppressed && !this.#audioDuckingVoxActive) {
        return;
      }
      if (!this.#audioDuckingLocalActive) {
        this.#audioDuckingLocalActive = true;
        this.#audioDuckingLocalStartedAt = time;
      }
      this.#audioDuckingLocalLastVoiceAt = time;
      this.#beginAudioDucking();
      if (
        config.mode === "hybrid"
        && !this.#audioDuckingVoxActive
        && this.#audioDuckingLocalStartedAt !== null
        && time - this.#audioDuckingLocalStartedAt >= config.localHoldMs
      ) {
        this.#audioDuckingLocalActive = false;
        this.#audioDuckingLocalSuppressed = true;
        this.#requestAudioDuckingRelease();
      }
      return;
    }

    this.#audioDuckingLocalSuppressed = false;
    if (this.#audioDuckingLocalActive && this.#audioDuckingLocalLastVoiceAt !== null) {
      if (time - this.#audioDuckingLocalLastVoiceAt >= config.releaseDelayMs) {
        this.#audioDuckingLocalActive = false;
        this.#audioDuckingLocalStartedAt = null;
        this.#audioDuckingLocalLastVoiceAt = null;
        this.#requestAudioDuckingRelease();
      }
    }
  }

  #handleAudioDuckingControlEvent(event: VoxRtcControlEventLike): void {
    const config = this.#audioDuckingConfig;
    if (!config || !this.#audioElement || !this.#usesVoxAudioDucking()) {
      return;
    }

    const type = eventTypeFromControlEvent(event);
    const payload = payloadFromControlEvent(event);
    if (DUCKING_VOX_START_EVENTS.has(type)) {
      this.#audioDuckingVoxActive = true;
      this.#audioDuckingLocalSuppressed = false;
      this.#beginAudioDucking();
      return;
    }
    if (DUCKING_VOX_STOP_EVENTS.has(type)) {
      this.#audioDuckingVoxActive = false;
      this.#requestAudioDuckingRelease();
      return;
    }
    if (type === "turn.state_changed") {
      const state = typeof payload.state === "string" ? payload.state : "";
      if (state === "listening" || state === "interrupted") {
        this.#audioDuckingVoxActive = true;
        this.#beginAudioDucking();
      } else if (state === "idle" || state === "thinking" || state === "speaking") {
        this.#audioDuckingVoxActive = false;
        this.#requestAudioDuckingRelease();
      }
    }
  }

  #usesLocalAudioDucking(): boolean {
    return this.#audioDuckingConfig?.mode === "local" || this.#audioDuckingConfig?.mode === "hybrid";
  }

  #usesVoxAudioDucking(): boolean {
    return this.#audioDuckingConfig?.mode === "vox" || this.#audioDuckingConfig?.mode === "hybrid";
  }

  #beginAudioDucking(): void {
    if (!this.#audioElement || !this.#audioDuckingConfig) {
      return;
    }
    if (this.#audioDuckingReleaseTimer !== null) {
      clearTimeout(this.#audioDuckingReleaseTimer);
      this.#audioDuckingReleaseTimer = null;
    }
    if (this.#audioDuckingStartedAt === null) {
      this.#audioDuckingStartedAt = nowMs();
      this.#audioDuckingBaseVolume = this.#audioElement.volume;
    }
    const sustained = nowMs() - this.#audioDuckingStartedAt >= this.#audioDuckingConfig.sustainedAfterMs;
    this.#setDuckedVolume(sustained ? this.#audioDuckingConfig.sustainedVolume : this.#audioDuckingConfig.duckVolume);
  }

  #requestAudioDuckingRelease(): void {
    if (this.#audioDuckingLocalActive || this.#audioDuckingVoxActive) {
      return;
    }
    const delay = this.#audioDuckingConfig?.releaseDelayMs ?? 0;
    if (this.#audioDuckingReleaseTimer !== null) {
      clearTimeout(this.#audioDuckingReleaseTimer);
    }
    if (delay <= 0) {
      this.#restoreDuckedVolume();
      return;
    }
    this.#audioDuckingReleaseTimer = setTimeout(() => {
      this.#audioDuckingReleaseTimer = null;
      if (!this.#audioDuckingLocalActive && !this.#audioDuckingVoxActive) {
        this.#restoreDuckedVolume();
      }
    }, delay);
  }

  #setDuckedVolume(targetVolume: number): void {
    if (!this.#audioElement) {
      return;
    }
    const baseVolume = this.#audioDuckingBaseVolume ?? this.#audioElement.volume;
    this.#audioElement.volume = Math.min(baseVolume, targetVolume);
  }

  #restoreDuckedVolume(): void {
    if (this.#audioElement && this.#audioDuckingBaseVolume !== null) {
      this.#audioElement.volume = this.#audioDuckingBaseVolume;
    }
    this.#resetAudioDuckingState();
  }

  #resetAudioDuckingState(): void {
    this.#audioDuckingBaseVolume = null;
    this.#audioDuckingStartedAt = null;
    this.#audioDuckingLocalActive = false;
    this.#audioDuckingLocalStartedAt = null;
    this.#audioDuckingLocalLastVoiceAt = null;
    this.#audioDuckingLocalSuppressed = false;
    this.#audioDuckingVoxActive = false;
  }

  #cleanup(): void {
    this.#stopAudioDucking({ restoreVolume: true });
    this.#closeEventSource();

    const dataChannel = this.#dataChannel;
    this.#dataChannel = null;
    if (dataChannel) {
      dataChannel.onopen = null;
      dataChannel.onclose = null;
      dataChannel.onerror = null;
      dataChannel.onmessage = null;
      if (dataChannel.readyState !== "closed") {
        dataChannel.close();
      }
    }

    const peerConnection = this.#peerConnection;
    this.#peerConnection = null;
    if (peerConnection) {
      peerConnection.ontrack = null;
      peerConnection.ondatachannel = null;
      peerConnection.onicecandidate = null;
      peerConnection.onconnectionstatechange = null;
      peerConnection.oniceconnectionstatechange = null;
      for (const sender of peerConnection.getSenders()) {
        try {
          peerConnection.removeTrack(sender);
        } catch {}
      }
      for (const transceiver of peerConnection.getTransceivers?.() ?? []) {
        try {
          transceiver.stop();
        } catch {}
      }
    }

    stopStream(this.#localStream);
    this.#localStream = null;
    stopStream(this.#remoteStream);
    this.#remoteStream = null;
    peerConnection?.close();

    this.#session = null;
    this.#httpBase = null;
    this.#mediaToken = null;
    this.#pendingCandidates = [];
    if (this.#audioElement) {
      this.#audioElement.pause();
      this.#audioElement.srcObject = null;
      this.#audioElement.removeAttribute("src");
      this.#audioElement.load();
    }
  }

  #setStatus(status: VoxRtcBrowserState["status"]): void {
    this.#status = status;
    this.#emitState();
  }

  #emitState(): void {
    this.#emit("state", this.state);
  }

  #emit<T extends VoxRtcBrowserEventName>(eventName: T, payload: VoxRtcBrowserEvents[T]): void {
    const listeners = this.#listeners[eventName];
    if (!listeners) {
      return;
    }
    for (const listener of [...listeners]) {
      listener(payload);
    }
  }
}
