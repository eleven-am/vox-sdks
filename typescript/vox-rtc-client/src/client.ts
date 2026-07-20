import type {
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
  VoxRtcControlEventLike,
  VoxRtcClientEventEnvelope,
  VoxRtcSignalingEvent,
  WebSocketFactory,
} from "./types.js";
import { GatewaySignalingClient } from "./signaling.js";
import { parseVoxSessionError, parseVoxSignalingError, voxGenerationId } from "./errors.js";
import type { VoxRtcSessionError } from "./errors.js";

type ListenerMap = {
  [K in VoxRtcBrowserEventName]?: Set<VoxRtcBrowserHandler<K>>;
};

type NormalizedAudioDuckingConfig = {
  duckVolume: number;
  releaseDelayMs: number;
};

const DEFAULT_AUDIO_DUCKING_CONFIG: NormalizedAudioDuckingConfig = {
  duckVolume: 0.2,
  releaseDelayMs: 350,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function defaultPeerConnectionFactory(configuration: RTCConfiguration): RTCPeerConnection {
  return new RTCPeerConnection(configuration);
}

function defaultGetUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("navigator.mediaDevices.getUserMedia is unavailable");
  }
  return navigator.mediaDevices.getUserMedia(constraints);
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
  return {
    duckVolume: clampNumber(value.duckVolume, DEFAULT_AUDIO_DUCKING_CONFIG.duckVolume, 0, 1),
    releaseDelayMs: clampNumber(
      value.releaseDelayMs,
      DEFAULT_AUDIO_DUCKING_CONFIG.releaseDelayMs,
      0,
      60_000,
    ),
  };
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
      const payload = Object.prototype.hasOwnProperty.call(parsed, "payload") ? parsed.payload : null;
      const generationId = voxGenerationId(payload);
      return {
        event: parsed.event,
        payload,
        ...(generationId !== undefined ? { generationId } : {}),
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
  readonly #signalingEndpoint: string;
  readonly #signalingTimeoutMs?: number;
  readonly #webSocketFactory?: WebSocketFactory;
  readonly #peerConnectionFactory: PeerConnectionFactory;
  readonly #getUserMedia: GetUserMedia;
  readonly #audioElement?: HTMLAudioElement;
  readonly #defaultAudioConstraints: boolean | MediaTrackConstraints;
  readonly #autoPlayRemoteAudio: boolean;
  readonly #iceTransportPolicy?: RTCIceTransportPolicy;
  readonly #dataChannelLabel: string;
  readonly #audioDuckingConfig: NormalizedAudioDuckingConfig | null;
  readonly #listeners: ListenerMap = {};

  #status: VoxRtcBrowserState["status"] = "idle";
  #session: VoxRtcBrowserSessionBootstrap | null = null;
  #signaling: GatewaySignalingClient | null = null;
  #peerConnection: RTCPeerConnection | null = null;
  #dataChannel: RTCDataChannel | null = null;
  #localStream: MediaStream | null = null;
  #remoteStream: MediaStream | null = null;
  #pendingLocalCandidates: Array<RTCIceCandidateInit | null> = [];
  #pendingServerCandidates: Array<RTCIceCandidateInit | null> = [];
  #bufferLocalCandidates = false;
  #negotiating = false;
  #awaitingRemoteDescription = false;
  #audioDuckingReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  #audioDuckingBaseVolume: number | null = null;
  #audioDuckingVoxActive = false;

  constructor(options: VoxRtcBrowserClientOptions) {
    if (!options.signalingEndpoint.startsWith("/") || options.signalingEndpoint.startsWith("//")) {
      throw new Error("RTC signalingEndpoint must be a same-origin path");
    }
    this.#signalingEndpoint = options.signalingEndpoint;
    this.#signalingTimeoutMs = options.signalingTimeoutMs;
    this.#webSocketFactory = options.webSocketFactory;
    this.#peerConnectionFactory = options.peerConnectionFactory ?? defaultPeerConnectionFactory;
    this.#getUserMedia = options.getUserMedia ?? defaultGetUserMedia;
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

  onSessionError(handler: (error: VoxRtcSessionError) => void): Unsubscribe {
    return this.on("sessionError", handler);
  }

  async connect(options: VoxRtcBrowserConnectOptions = {}): Promise<VoxRtcBrowserSessionBootstrap> {
    if (this.#status === "connected" || this.#status === "connecting") {
      throw new Error(`Vox RTC client is already ${this.#status}`);
    }
    this.#setStatus("connecting");
    try {
      const signaling = new GatewaySignalingClient({
        endpoint: this.#signalingEndpoint,
        timeoutMs: this.#signalingTimeoutMs,
        webSocketFactory: this.#webSocketFactory,
        onEvent: (event) => this.#handleSignalingEvent(event),
        onError: (error) => this.#emit("error", error),
        onClose: (reason) => this.#handleUnexpectedSignalingClose(reason),
      });
      this.#signaling = signaling;
      const session = await signaling.connect();
      this.#session = session;
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
        this.#emit("localStream", localStream);
      }

      await this.#negotiate({ restart: false });
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
    this.#signaling?.close("client_disconnected");
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
    this.#emit("localStream", nextStream);
    return nextStream;
  }

  async restartIce(): Promise<void> {
    if (this.#status !== "connected" || !this.#peerConnection || !this.#signaling) {
      throw new Error("Cannot restart ICE before connect()");
    }
    try {
      this.#peerConnection.restartIce?.();
      await this.#negotiate({ restart: true });
    } catch (error) {
      this.#emit("error", error instanceof Error ? error : new Error(String(error)));
      await this.disconnect();
      throw error;
    }
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
      if (this.#bufferLocalCandidates) {
        this.#pendingLocalCandidates.push(candidate);
        return;
      }
      this.#sendLocalCandidate(candidate);
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

  #handleSignalingEvent(event: VoxRtcSignalingEvent): void {
    this.#emit("signalingMessage", event);
    this.#handleAudioDuckingControlEvent({ type: event.type, data: event.data });

    if (event.type === "error") {
      this.#emit("sessionError", parseVoxSessionError(event.data));
    } else if (event.type === "rtc.signaling_error") {
      this.#emit("sessionError", parseVoxSignalingError(event.data));
    }

    if (event.type === "rtc.ice_candidate") {
      const candidate = this.#candidateFromSignaling(event.data);
      this.#emit("serverIceCandidate", candidate);
      const pc = this.#peerConnection;
      if (!pc?.remoteDescription || this.#awaitingRemoteDescription) {
        this.#pendingServerCandidates.push(candidate);
        return;
      }
      pc.addIceCandidate(candidate).catch((error) => this.#emit("error", error));
      return;
    }
    if (event.type === "rtc.connection_state") {
      this.#emit("serverConnectionState", event.data);
      return;
    }
    if (event.type === "rtc.ice_connection_state") {
      this.#emit("serverIceConnectionState", event.data);
      return;
    }
    if (event.type === "rtc.session.closed" && this.#status !== "closed") {
      this.#cleanup();
      this.#setStatus("closed");
    }
  }

  #candidateFromSignaling(data: Record<string, unknown>): RTCIceCandidateInit | null {
    if (!Object.prototype.hasOwnProperty.call(data, "candidate") || data.candidate === null) {
      return null;
    }
    if (!isRecord(data.candidate) || typeof data.candidate.candidate !== "string") {
      throw new Error("RTC gateway sent an invalid ICE candidate");
    }
    return {
      candidate: data.candidate.candidate,
      sdpMid: typeof data.candidate.sdpMid === "string" ? data.candidate.sdpMid : null,
      sdpMLineIndex: typeof data.candidate.sdpMLineIndex === "number"
        ? data.candidate.sdpMLineIndex
        : null,
      usernameFragment: typeof data.candidate.usernameFragment === "string"
        ? data.candidate.usernameFragment
        : null,
    };
  }

  async #flushServerCandidates(): Promise<void> {
    const pc = this.#peerConnection;
    if (!pc) return;
    const candidates = this.#pendingServerCandidates;
    this.#pendingServerCandidates = [];
    for (const candidate of candidates) {
      await pc.addIceCandidate(candidate);
    }
  }

  #sendLocalCandidate(candidate: RTCIceCandidateInit | null): void {
    try {
      this.#signaling?.sendCandidate(candidate);
    } catch (error) {
      this.#emit("error", error instanceof Error ? error : new Error(String(error)));
    }
  }

  #flushLocalCandidates(): void {
    const candidates = this.#pendingLocalCandidates;
    this.#pendingLocalCandidates = [];
    for (const candidate of candidates) {
      this.#sendLocalCandidate(candidate);
    }
  }

  async #negotiate({ restart }: { restart: boolean }): Promise<void> {
    const pc = this.#peerConnection;
    const signaling = this.#signaling;
    if (!pc || !signaling) {
      throw new Error("RTC negotiation requires an active peer and signaling session");
    }
    if (this.#negotiating) {
      throw new Error("RTC negotiation is already in progress");
    }

    this.#negotiating = true;
    this.#awaitingRemoteDescription = true;
    this.#bufferLocalCandidates = true;
    this.#pendingLocalCandidates = [];
    try {
      const offer = await pc.createOffer(restart ? { iceRestart: true } : undefined);
      await pc.setLocalDescription(offer);
      if (!pc.localDescription?.sdp) {
        throw new Error("Local SDP offer is missing after setLocalDescription");
      }
      const answerPromise = signaling.exchangeOffer(
        { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
        { restart },
      );
      this.#bufferLocalCandidates = false;
      this.#flushLocalCandidates();
      const answer = await answerPromise;
      await pc.setRemoteDescription(answer);
      this.#awaitingRemoteDescription = false;
      await this.#flushServerCandidates();
    } finally {
      this.#bufferLocalCandidates = false;
      this.#pendingLocalCandidates = [];
      this.#awaitingRemoteDescription = false;
      this.#negotiating = false;
    }
  }

  #handleUnexpectedSignalingClose(reason: string): void {
    if (this.#status === "disconnecting" || this.#status === "closed" || this.#status === "idle") {
      return;
    }
    this.#emit("error", new Error(`RTC gateway closed unexpectedly: ${reason}`));
    this.#cleanup();
    this.#setStatus("closed");
  }

  #handleAudioDuckingControlEvent(event: VoxRtcControlEventLike): void {
    const config = this.#audioDuckingConfig;
    if (!config || !this.#audioElement) {
      return;
    }

    const type = eventTypeFromControlEvent(event);
    const payload = payloadFromControlEvent(event);
    if (DUCKING_VOX_START_EVENTS.has(type)) {
      this.#audioDuckingVoxActive = true;
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

  #beginAudioDucking(): void {
    if (!this.#audioElement || !this.#audioDuckingConfig) {
      return;
    }
    if (this.#audioDuckingReleaseTimer !== null) {
      clearTimeout(this.#audioDuckingReleaseTimer);
      this.#audioDuckingReleaseTimer = null;
    }
    if (this.#audioDuckingBaseVolume === null) {
      this.#audioDuckingBaseVolume = this.#audioElement.volume;
    }
    this.#setDuckedVolume(this.#audioDuckingConfig.duckVolume);
  }

  #requestAudioDuckingRelease(): void {
    if (this.#audioDuckingVoxActive) {
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
      if (!this.#audioDuckingVoxActive) {
        this.#restoreDuckedVolume();
      }
    }, delay);
  }

  #stopAudioDucking(): void {
    if (this.#audioDuckingReleaseTimer !== null) {
      clearTimeout(this.#audioDuckingReleaseTimer);
      this.#audioDuckingReleaseTimer = null;
    }
    this.#restoreDuckedVolume();
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
    this.#audioDuckingVoxActive = false;
  }

  #cleanup(): void {
    this.#stopAudioDucking();
    const signaling = this.#signaling;
    this.#signaling = null;
    signaling?.close("client_cleanup");

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
    this.#pendingLocalCandidates = [];
    this.#pendingServerCandidates = [];
    this.#bufferLocalCandidates = false;
    this.#negotiating = false;
    this.#awaitingRemoteDescription = false;
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
