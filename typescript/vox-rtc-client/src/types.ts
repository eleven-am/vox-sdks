import type { VoxRtcSessionError } from "./errors.js";

export interface VoxRtcBrowserSessionBootstrap {
  sessionId: string;
  iceServers: RTCIceServer[];
  expiresAt?: string;
  attachTtlSeconds?: number;
}

export interface VoxRtcBrowserClientOptions {
  signalingEndpoint: string;
  signalingTimeoutMs?: number;
  webSocketFactory?: WebSocketFactory;
  peerConnectionFactory?: PeerConnectionFactory;
  getUserMedia?: GetUserMedia;
  audioElement?: HTMLAudioElement;
  audioConstraints?: boolean | MediaTrackConstraints;
  autoPlayRemoteAudio?: boolean;
  iceTransportPolicy?: RTCIceTransportPolicy;
  dataChannelLabel?: string;
  audioDucking?: boolean | VoxRtcAudioDuckingOptions;
}

export interface VoxRtcBrowserConnectOptions {
  audioConstraints?: boolean | MediaTrackConstraints;
}

export interface VoxRtcClientEventEnvelope {
  event: string;
  payload?: unknown;
  generationId?: string;
}

export type VoxRtcAudioDuckingMode = "vox" | "local" | "hybrid";

export interface VoxRtcAudioDuckingOptions {
  enabled?: boolean;
  mode?: VoxRtcAudioDuckingMode;
  threshold?: number;
  duckVolume?: number;
  sustainedVolume?: number;
  sustainedAfterMs?: number;
  localHoldMs?: number;
  releaseDelayMs?: number;
  pollIntervalMs?: number;
}

export type VoxRtcControlEventLike = string | {
  type?: unknown;
  event?: unknown;
  data?: unknown;
  payload?: unknown;
  [key: string]: unknown;
};

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
  sessionError: VoxRtcSessionError;
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
  signalingMessage: VoxRtcSignalingEvent;
}

export interface VoxRtcSignalingEvent {
  id?: string;
  type: string;
  data: Record<string, unknown>;
}

export type VoxRtcBrowserEventName = keyof VoxRtcBrowserEvents;
export type VoxRtcBrowserHandler<T extends VoxRtcBrowserEventName> = (payload: VoxRtcBrowserEvents[T]) => void;
export type Unsubscribe = () => void;

export type PeerConnectionFactory = (configuration: RTCConfiguration) => RTCPeerConnection;
export type GetUserMedia = (constraints: MediaStreamConstraints) => Promise<MediaStream>;
export type WebSocketFactory = (url: string) => WebSocketLike;

export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
