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
  VoxRtcClientEventEnvelope,
  VoxRtcOfferResponse,
} from "./types.js";

type ListenerMap = {
  [K in VoxRtcBrowserEventName]?: Set<VoxRtcBrowserHandler<K>>;
};

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
  readonly #listeners: ListenerMap = {};

  #status: VoxRtcBrowserState["status"] = "idle";
  #session: VoxRtcBrowserSessionBootstrap | null = null;
  #httpBase: string | null = null;
  #mediaToken: string | null = null;
  #peerConnection: RTCPeerConnection | null = null;
  #dataChannel: RTCDataChannel | null = null;
  #eventSource: EventSourceLike | null = null;
  #localStream: MediaStream | null = null;
  #remoteStream: MediaStream | null = null;
  #pendingCandidates: Array<RTCIceCandidateInit | null> = [];

  constructor(options: VoxRtcBrowserClientOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
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
      this.#emit("dataMessage", parseDataMessage(event.data));
    };
  }

  #attachEvents(eventsUrl: string): void {
    if (!this.#httpBase) {
      throw new Error("Cannot attach RTC events without Vox HTTP base");
    }
    const url = eventsUrl.startsWith("http") ? eventsUrl : `${this.#httpBase}${eventsUrl}`;
    const eventSource = this.#eventSourceFactory(url);
    this.#eventSource = eventSource;

    eventSource.onmessage = (event) => {
      this.#emit("sseMessage", JSON.parse(event.data) as Record<string, unknown>);
    };
    eventSource.addEventListener("rtc.ice_candidate", (event) => {
      const payload = JSON.parse(event.data) as { candidate?: RTCIceCandidateInit | null };
      const candidate = payload.candidate ?? null;
      this.#emit("serverIceCandidate", candidate);
      this.#peerConnection?.addIceCandidate(candidate).catch((error) => this.#emit("error", error));
    });
    eventSource.addEventListener("rtc.connection_state", (event) => {
      this.#emit("serverConnectionState", JSON.parse(event.data) as Record<string, unknown>);
    });
    eventSource.addEventListener("rtc.ice_connection_state", (event) => {
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

  #cleanup(): void {
    this.#eventSource?.close();
    this.#eventSource = null;
    if (this.#dataChannel && this.#dataChannel.readyState !== "closed") {
      this.#dataChannel.close();
    }
    this.#dataChannel = null;
    this.#peerConnection?.close();
    this.#peerConnection = null;
    this.#localStream?.getTracks().forEach((track) => track.stop());
    this.#localStream = null;
    this.#remoteStream = null;
    this.#mediaToken = null;
    this.#pendingCandidates = [];
    if (this.#audioElement) {
      this.#audioElement.pause();
      this.#audioElement.srcObject = null;
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
