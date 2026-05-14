export interface VoxRtcBrowserSessionBootstrap {
  sessionId: string;
  clientToken: string;
  iceServers: RTCIceServer[];
  voxHttpBase?: string;
  expiresAt?: string;
  joinTokenTtlSeconds?: number;
}

export interface VoxRtcBrowserClientOptions {
  httpBase?: string;
  session?: VoxRtcBrowserSessionBootstrap | (() => Promise<VoxRtcBrowserSessionBootstrap>);
  sessionEndpoint?: string;
  fetch?: typeof fetch;
  peerConnectionFactory?: PeerConnectionFactory;
  eventSourceFactory?: EventSourceFactory;
  getUserMedia?: GetUserMedia;
  audioElement?: HTMLAudioElement;
  audioConstraints?: boolean | MediaTrackConstraints;
  autoPlayRemoteAudio?: boolean;
  iceTransportPolicy?: RTCIceTransportPolicy;
  dataChannelLabel?: string;
}

export interface VoxRtcBrowserConnectOptions {
  session?: VoxRtcBrowserSessionBootstrap;
  audioConstraints?: boolean | MediaTrackConstraints;
}

export interface VoxRtcClientEventEnvelope {
  event: string;
  payload?: unknown;
}

export interface VoxRtcBrowserState {
  status: "idle" | "connecting" | "connected" | "disconnecting" | "closed";
  sessionId: string | null;
  peerConnectionState: RTCPeerConnectionState | "idle";
  iceConnectionState: RTCIceConnectionState | "idle";
  dataChannelState: RTCDataChannelState | "idle";
}

export interface VoxRtcBrowserEvents {
  state: VoxRtcBrowserState;
  error: Error;
  session: VoxRtcBrowserSessionBootstrap;
  remoteStream: MediaStream;
  remoteTrack: RTCTrackEvent;
  localStream: MediaStream;
  dataChannelOpen: RTCDataChannel;
  dataChannelClose: RTCDataChannel;
  dataChannelError: Event;
  clientEvent: VoxRtcClientEventEnvelope;
  dataMessage: VoxRtcClientEventEnvelope | { raw: unknown };
  localIceCandidate: RTCIceCandidateInit | null;
  serverIceCandidate: RTCIceCandidateInit | null;
  serverConnectionState: Record<string, unknown>;
  serverIceConnectionState: Record<string, unknown>;
  sseMessage: Record<string, unknown>;
}

export type VoxRtcBrowserEventName = keyof VoxRtcBrowserEvents;
export type VoxRtcBrowserHandler<T extends VoxRtcBrowserEventName> = (payload: VoxRtcBrowserEvents[T]) => void;
export type Unsubscribe = () => void;

export type PeerConnectionFactory = (configuration: RTCConfiguration) => RTCPeerConnection;
export type EventSourceFactory = (url: string) => EventSourceLike;
export type GetUserMedia = (constraints: MediaStreamConstraints) => Promise<MediaStream>;

export interface EventSourceLike {
  onmessage: ((event: MessageEvent<string>) => void) | null;
  close(): void;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  removeEventListener?(type: string, listener: (event: MessageEvent<string>) => void): void;
}

export interface VoxRtcOfferResponse {
  sessionId: string;
  mediaToken: string;
  type: RTCSdpType;
  sdp: string;
  eventsUrl: string;
}
