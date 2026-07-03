import { ChannelState, ConnectionState } from "@eleven-am/pondsocket-client";

export { ChannelState, ConnectionState };

export interface VoxRtcSessionBootstrap {
  sessionId: string;
  clientToken: string;
  expiresAt: string;
  joinTokenTtlSeconds: number;
  iceServers: RTCIceServerLike[];
}

export interface RTCIceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface VoxRtcSessionConfig {
  sttModel?: string;
  ttsModel?: string;
  voice?: string;
  turnProfile?: string;
  vadBackend?: string;
  turnDetector?: string;
  [key: string]: unknown;
}

export interface VoxRtcClientEventEnvelope {
  event: string;
  payload?: unknown;
}

export interface VoxRtcWireEvent {
  type: string;
  data: Record<string, unknown>;
  sessionId: string;
  channelName: string;
}

export interface VoxRtcSessionAttachedEvent {
  sessionId: string;
  channelName: string;
  data: Record<string, unknown>;
}

export interface VoxRtcSessionCreatedEvent {
  sessionId: string;
  channelName: string;
  session?: Record<string, unknown>;
  data: Record<string, unknown>;
}

export interface VoxRtcTranscriptEvent {
  sessionId: string;
  channelName: string;
  transcript: string;
  language?: string;
  startMs?: number;
  endMs?: number;
  eouProbability?: number;
  topics?: string[];
  data: Record<string, unknown>;
}

export interface VoxRtcTurnStateEvent {
  sessionId: string;
  channelName: string;
  state: string;
  previousState?: string;
  data: Record<string, unknown>;
}

export interface VoxRtcSpeechEvent {
  sessionId: string;
  channelName: string;
  timestampMs?: number;
  data: Record<string, unknown>;
}

export interface VoxRtcTranscriptDeltaEvent {
  sessionId: string;
  channelName: string;
  delta: string;
  startMs?: number;
  endMs?: number;
  data: Record<string, unknown>;
}

export interface VoxRtcTurnEouPredictedEvent {
  sessionId: string;
  channelName: string;
  probability?: number;
  threshold?: number;
  delayMs?: number;
  startMs?: number;
  endMs?: number;
  decision?: string;
  action?: string;
  turnDetector?: string;
  data: Record<string, unknown>;
}

export interface VoxRtcResponseEvent {
  sessionId: string;
  channelName: string;
  responseId?: string;
  data: Record<string, unknown>;
}

export interface VoxRtcInterruptionEvent extends VoxRtcResponseEvent {
  vadActiveMs?: number;
  partialTranscript?: string | null;
}

export interface VoxRtcBrowserEvent {
  sessionId: string;
  channelName: string;
  event: string;
  payload: unknown;
  data: Record<string, unknown>;
}

export interface VoxRtcCloseEvent {
  sessionId: string;
  channelName: string;
  reason: string;
  connectionState?: string;
  iceConnectionState?: string;
  dataChannelState?: string;
  data: Record<string, unknown>;
}

export interface VoxRtcErrorEvent {
  sessionId: string;
  channelName: string;
  message?: string;
  code?: string;
  data: Record<string, unknown>;
}

export interface VoxRtcResponseOptions {
  allowInterruptions?: boolean;
}

export type Unsubscribe = () => void;

export interface VoxRtcServerClientOptions {
  httpBase: string;
  apiKey?: string;
  socketBase?: string;
  socketParams?: Record<string, unknown>;
  fetch?: typeof fetch;
  connectionTimeoutMs?: number;
  maxReconnectDelayMs?: number;
  socketFactory?: SocketClientFactory;
}

export interface SocketClientLike {
  connect(): void;
  disconnect(): void;
  getState(): ConnectionState;
  createChannel(name: string, params?: Record<string, unknown>): SocketChannelLike;
  onConnectionChange(callback: (state: ConnectionState) => void): Unsubscribe;
  onError(callback: (error: Error) => void): Unsubscribe;
}

export interface SocketChannelLike {
  join(): void;
  leave(): void;
  sendMessage(event: string, payload: Record<string, unknown>): void;
  onMessage(callback: (event: string, payload: unknown) => void): Unsubscribe;
  onChannelStateChange(callback: (state: ChannelState) => void): Unsubscribe;
}

export interface SocketClientFactory {
  (
    endpoint: string,
    params: Record<string, unknown>,
    options: { connectionTimeout?: number; maxReconnectDelay?: number }
  ): SocketClientLike;
}
