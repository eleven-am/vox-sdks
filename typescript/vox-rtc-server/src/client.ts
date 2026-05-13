import { ChannelState, ConnectionState, PondClient } from "@eleven-am/pondsocket-client";

import { VoxRtcControlSession } from "./session.js";
import type {
  SocketClientFactory,
  SocketClientLike,
  Unsubscribe,
  VoxRtcServerClientOptions,
  VoxRtcSessionBootstrap,
} from "./types.js";

function normalizeBase(base: string): string {
  return base.replace(/\/+$/, "");
}

function defaultSocketBase(httpBase: string): string {
  return `${normalizeBase(httpBase)}/v1/socket`;
}

function defaultApiKey(): string | null {
  if (typeof process === "undefined" || !process.env) {
    return null;
  }
  const value = process.env.VOX_API_KEY?.trim();
  return value ? value : null;
}

function toBootstrap(data: Record<string, unknown>): VoxRtcSessionBootstrap {
  return {
    sessionId: String(data.session_id),
    clientToken: String(data.client_token),
    expiresAt: String(data.expires_at),
    joinTokenTtlSeconds: Number(data.join_token_ttl_seconds ?? 0),
    iceServers: Array.isArray(data.ice_servers) ? data.ice_servers as VoxRtcSessionBootstrap["iceServers"] : [],
  };
}

function defaultSocketFactory(
  endpoint: string,
  params: Record<string, unknown>,
  options: { connectionTimeout?: number; maxReconnectDelay?: number },
): SocketClientLike {
  return new PondClient(endpoint, params, options);
}

function defaultFetch(...args: Parameters<typeof fetch>): ReturnType<typeof fetch> {
  return globalThis.fetch(...args);
}

export class VoxRtcServerClient {
  readonly #httpBase: string;
  readonly #apiKey: string | null;
  readonly #socketBase: string;
  readonly #fetch: typeof fetch;
  readonly #socketParams: Record<string, unknown>;
  readonly #socketFactory: SocketClientFactory;
  readonly #connectionTimeoutMs: number;
  readonly #maxReconnectDelayMs: number;

  #socket: SocketClientLike | null = null;
  #socketErrorOff: Unsubscribe | null = null;

  constructor(options: VoxRtcServerClientOptions) {
    this.#httpBase = normalizeBase(options.httpBase);
    this.#apiKey = options.apiKey?.trim() || defaultApiKey();
    this.#socketBase = options.socketBase ? normalizeBase(options.socketBase) : defaultSocketBase(options.httpBase);
    this.#fetch = options.fetch ?? defaultFetch;
    this.#socketParams = options.socketParams ?? {};
    this.#socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.#connectionTimeoutMs = options.connectionTimeoutMs ?? 10_000;
    this.#maxReconnectDelayMs = options.maxReconnectDelayMs ?? 30_000;
  }

  get httpBase(): string {
    return this.#httpBase;
  }

  get socketBase(): string {
    return this.#socketBase;
  }

  get connectionState(): ConnectionState {
    return this.#socket?.getState() ?? ConnectionState.DISCONNECTED;
  }

  async connect(): Promise<void> {
    const socket = this.#ensureSocket();
    if (socket.getState() === ConnectionState.CONNECTED) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        offState();
        offError();
        fn();
      };

      const offState = socket.onConnectionChange((state) => {
        if (state === ConnectionState.CONNECTED) {
          finish(resolve);
        }
      });

      const offError = socket.onError((error) => {
        finish(() => reject(error));
      });

      const timer = setTimeout(() => {
        finish(() => reject(new Error("Timed out waiting for PondSocket connection")));
      }, this.#connectionTimeoutMs);

      if (socket.getState() !== ConnectionState.CONNECTING) {
        socket.connect();
      }
    });
  }

  disconnect(): void {
    if (this.#socketErrorOff) {
      this.#socketErrorOff();
      this.#socketErrorOff = null;
    }
    this.#socket?.disconnect();
    this.#socket = null;
  }

  async createSession(): Promise<VoxRtcSessionBootstrap> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.#apiKey) {
      headers.authorization = `Bearer ${this.#apiKey}`;
    }
    const response = await this.#fetch(`${this.#httpBase}/v1/rtc/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      throw new Error(`Failed to create Vox RTC session: ${response.status} ${await response.text()}`);
    }

    return toBootstrap(await response.json() as Record<string, unknown>);
  }

  async attachSession(sessionId: string, options?: { joinTimeoutMs?: number }): Promise<VoxRtcControlSession> {
    await this.connect();
    const socket = this.#ensureSocket();
    const channel = socket.createChannel(`/rtc/${sessionId}`, {});
    const session = new VoxRtcControlSession(channel, sessionId, options?.joinTimeoutMs ?? 10_000);

    await session.join();
    return session;
  }

  async createControlledSession(options?: { joinTimeoutMs?: number }): Promise<{
    bootstrap: VoxRtcSessionBootstrap;
    session: VoxRtcControlSession;
  }> {
    const bootstrap = await this.createSession();
    const session = await this.attachSession(bootstrap.sessionId, options);
    return { bootstrap, session };
  }

  #ensureSocket(): SocketClientLike {
    if (!this.#socket) {
      const params = { ...this.#socketParams };
      if (this.#apiKey) {
        params.api_key = this.#apiKey;
      }
      this.#socket = this.#socketFactory(this.#socketBase, params, {
        connectionTimeout: this.#connectionTimeoutMs,
        maxReconnectDelay: this.#maxReconnectDelayMs,
      });
    }
    return this.#socket;
  }
}

export { ChannelState, ConnectionState };
