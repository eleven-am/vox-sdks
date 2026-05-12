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
}

export interface VoxRtcResponseOptions {
  allowInterruptions?: boolean;
}

export type Unsubscribe = () => void;

export interface VoxRtcServerClientOptions {
  httpBase: string;
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
