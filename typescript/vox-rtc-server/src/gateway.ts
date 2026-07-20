import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer } from "ws";
import type { RawData } from "ws";

import { VoxRtcServerClient } from "./client.js";
import type { VoxRtcControlSession } from "./session.js";
import type {
  Unsubscribe,
  VoxRtcIceCandidate,
  VoxRtcSessionDescription,
  VoxRtcWireEvent,
} from "./types.js";

export interface VoxRtcGatewaySessionContext {
  request: IncomingMessage;
  session: VoxRtcControlSession;
}

export interface VoxRtcGatewayClosedContext
  extends VoxRtcGatewaySessionContext {
  reason: string;
}

export interface VoxRtcGatewayOptions {
  voxHttpBase: string;
  apiKey?: string;
  path?: string;
  onSessionCreated?: (
    context: VoxRtcGatewaySessionContext,
  ) => void | Promise<void>;
  onSessionClosed?: (
    context: VoxRtcGatewayClosedContext,
  ) => void | Promise<void>;
  onError?: (error: Error) => void;
}

interface GatewayControlClient {
  createControlledSession(): Promise<{
    bootstrap: {
      sessionId: string;
      expiresAt: string;
      attachTtlSeconds: number;
      iceServers: Array<{
        urls: string | string[];
        username?: string;
        credential?: string;
      }>;
    };
    session: VoxRtcControlSession;
  }>;
  disconnect(): void;
}

type GatewayClientFactory = (options: {
  httpBase: string;
  apiKey?: string;
}) => GatewayControlClient;

interface GatewayClientMessage {
  id: string;
  type: string;
  data: Record<string, unknown>;
}

interface ActiveGatewaySession {
  ws: WebSocket;
  context: VoxRtcGatewaySessionContext;
  unsubscribe: Unsubscribe;
  pendingOfferId: string | null;
  rtcCloseRequested: boolean;
  closePromise: Promise<void> | null;
  setupPending: boolean;
  pendingCloseReason: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePath(path: string): string {
  const normalized = `/${path}`.replace(/\/+/g, "/").replace(/\/$/, "");
  return normalized || "/";
}

function requestPath(request: IncomingMessage): string {
  return (
    new URL(request.url ?? "/", "http://vox-gateway.local").pathname.replace(
      /\/$/,
      "",
    ) || "/"
  );
}

function parseClientMessage(raw: RawData): GatewayClientMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    throw new Error("RTC gateway message must be valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new Error("RTC gateway message must be an object");
  }
  const id = typeof parsed.id === "string" ? parsed.id.trim() : "";
  const type = typeof parsed.type === "string" ? parsed.type.trim() : "";
  if (!id || !type || !isRecord(parsed.data)) {
    throw new Error("RTC gateway message requires id, type, and object data");
  }
  return { id, type, data: parsed.data };
}

function sessionDescription(value: unknown): VoxRtcSessionDescription {
  if (
    !isRecord(value) ||
    value.type !== "offer" ||
    typeof value.sdp !== "string" ||
    !value.sdp.trim()
  ) {
    throw new Error("rtc.offer requires a non-empty SDP offer");
  }
  return { type: "offer", sdp: value.sdp };
}

function iceCandidate(value: unknown): VoxRtcIceCandidate | null {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.candidate !== "string") {
    throw new Error("rtc.ice_candidate requires a candidate object or null");
  }
  return {
    candidate: value.candidate,
    sdpMid: typeof value.sdpMid === "string" ? value.sdpMid : null,
    sdpMLineIndex:
      typeof value.sdpMLineIndex === "number" ? value.sdpMLineIndex : null,
    usernameFragment:
      typeof value.usernameFragment === "string"
        ? value.usernameFragment
        : null,
  };
}

function optionalGeneration(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 1
    ? Number(value)
    : undefined;
}

export interface VoxRtcGateway {
  attach(server: HttpServer): () => void;
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<boolean>;
  close(reason?: string): Promise<void>;
}

class DefaultVoxRtcGateway implements VoxRtcGateway {
  readonly #options: VoxRtcGatewayOptions;
  readonly #client: GatewayControlClient;
  readonly #path: string;
  readonly #webSocketServer = new WebSocketServer({ noServer: true });
  readonly #active = new Set<ActiveGatewaySession>();
  readonly #opening = new Set<Promise<void>>();
  #shutdownReason: string | null = null;
  #closePromise: Promise<void> | null = null;

  constructor(options: VoxRtcGatewayOptions, client: GatewayControlClient) {
    this.#options = options;
    this.#client = client;
    this.#path = normalizePath(options.path ?? "/api/vox/rtc");
  }

  attach(server: HttpServer): () => void {
    const listener = (
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
    ) => {
      void this.handleUpgrade(request, socket, head).catch((error) => {
        this.#reportError(error);
        if (!socket.destroyed) socket.destroy();
      });
    };
    server.on("upgrade", listener);
    return () => server.off("upgrade", listener);
  }

  async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<boolean> {
    if (requestPath(request) !== this.#path) {
      return false;
    }
    if (this.#shutdownReason !== null) {
      this.#rejectUpgrade(socket, 503, "Service Unavailable");
      return true;
    }

    this.#webSocketServer.handleUpgrade(request, socket, head, (ws) => {
      const opening = this.#open(ws, request);
      this.#opening.add(opening);
      void opening.then(
        () => this.#opening.delete(opening),
        (error) => {
          this.#opening.delete(opening);
          this.#reportError(error);
        },
      );
    });
    return true;
  }

  async close(reason = "gateway_shutdown"): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#shutdownReason = reason;
    this.#closePromise = (async () => {
      const closeActive = async () => {
        const activeSessions = [...this.#active];
        await Promise.all(
          activeSessions.map((active) => this.#requestClose(active, reason)),
        );
        for (const active of activeSessions) {
          if (
            active.ws.readyState === WebSocket.OPEN ||
            active.ws.readyState === WebSocket.CONNECTING
          ) {
            active.ws.close(1001, reason);
          }
        }
      };

      await closeActive();
      await Promise.allSettled([...this.#opening]);
      await closeActive();
      this.#client.disconnect();
    })();
    return this.#closePromise;
  }

  async #open(ws: WebSocket, request: IncomingMessage): Promise<void> {
    let session: VoxRtcControlSession | null = null;
    let active: ActiveGatewaySession | null = null;
    let browserClosed =
      ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED;
    ws.once("close", () => {
      browserClosed = true;
      if (active) void this.#requestClose(active, "browser_disconnected");
    });
    ws.on("error", (error) => this.#reportError(error));
    try {
      const controlled = await this.#client.createControlledSession();
      session = controlled.session;
      const context = {
        request,
        session,
      };
      active = {
        ws,
        context,
        unsubscribe: () => {},
        pendingOfferId: null,
        rtcCloseRequested: false,
        closePromise: null,
        setupPending: true,
        pendingCloseReason: null,
      };
      this.#active.add(active);
      const terminalReason =
        this.#shutdownReason ??
        (browserClosed ||
        ws.readyState === WebSocket.CLOSING ||
        ws.readyState === WebSocket.CLOSED
          ? "browser_disconnected"
          : null);
      if (terminalReason !== null) {
        active.setupPending = false;
        await this.#close(active, terminalReason);
        if (
          ws.readyState === WebSocket.OPEN ||
          ws.readyState === WebSocket.CONNECTING
        ) {
          ws.close(1001, terminalReason);
        }
        return;
      }
      const current = active;
      current.unsubscribe = session.onEvent((event) =>
        this.#forwardEvent(current, event),
      );
      ws.on("message", (raw) => void this.#handleMessage(current, raw));

      try {
        await this.#options.onSessionCreated?.(context);
      } catch (error) {
        active.setupPending = false;
        active.pendingCloseReason = null;
        this.#send(active, "gateway.error", {
          message: error instanceof Error ? error.message : String(error),
        });
        await this.#close(active, "session_created_hook_failed");
        ws.close(1011, "Session setup failed");
        return;
      }

      active.setupPending = false;
      const deferredCloseReason =
        this.#shutdownReason ??
        active.pendingCloseReason ??
        (browserClosed ||
        ws.readyState === WebSocket.CLOSING ||
        ws.readyState === WebSocket.CLOSED
          ? "browser_disconnected"
          : null);
      if (deferredCloseReason !== null) {
        await this.#close(active, deferredCloseReason);
        if (
          ws.readyState === WebSocket.OPEN ||
          ws.readyState === WebSocket.CONNECTING
        ) {
          ws.close(1001, deferredCloseReason);
        }
        return;
      }

      this.#send(active, "gateway.ready", {
        session: {
          sessionId: controlled.bootstrap.sessionId,
          expiresAt: controlled.bootstrap.expiresAt,
          attachTtlSeconds: controlled.bootstrap.attachTtlSeconds,
          iceServers: controlled.bootstrap.iceServers,
        },
      });
    } catch (error) {
      if (active) {
        active.setupPending = false;
        await this.#close(active, "gateway_setup_failed");
      } else {
        session?.close();
      }
      this.#reportError(error);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1011, "RTC gateway setup failed");
      }
    }
  }

  async #handleMessage(
    active: ActiveGatewaySession,
    raw: RawData,
  ): Promise<void> {
    let requestId: string | undefined;
    try {
      const message = parseClientMessage(raw);
      requestId = message.id;

      if (message.type === "rtc.offer") {
        if (active.pendingOfferId !== null) {
          throw new Error("An RTC offer is already pending");
        }
        const generation = optionalGeneration(message.data.generation);
        const offer = sessionDescription(message.data.offer);
        active.pendingOfferId = message.id;
        active.context.session.sendOffer(offer, {
          restart: message.data.restart === true,
          ...(generation !== undefined ? { generation } : {}),
        });
        return;
      }
      if (message.type === "rtc.ice_candidate") {
        active.context.session.sendIceCandidate(
          iceCandidate(message.data.candidate),
        );
        return;
      }
      if (message.type === "rtc.close") {
        active.rtcCloseRequested = true;
        active.context.session.closeRtc(
          typeof message.data.reason === "string"
            ? message.data.reason
            : "client_closed",
        );
        return;
      }
      throw new Error(`Unsupported RTC gateway message type: ${message.type}`);
    } catch (error) {
      if (requestId && active.pendingOfferId === requestId) {
        active.pendingOfferId = null;
      }
      this.#send(
        active,
        "gateway.error",
        {
          message: error instanceof Error ? error.message : String(error),
        },
        requestId,
      );
    }
  }

  #forwardEvent(active: ActiveGatewaySession, event: VoxRtcWireEvent): void {
    const correlates =
      event.type === "rtc.answer" || event.type === "rtc.signaling_error";
    const requestId = correlates
      ? (active.pendingOfferId ?? undefined)
      : undefined;
    if (correlates) {
      active.pendingOfferId = null;
    }
    this.#send(active, event.type, event.data ?? {}, requestId);
    if (event.type === "rtc.session.closed") {
      active.rtcCloseRequested = true;
      const reason = String(event.data.reason ?? "session_closed");
      void this.#requestClose(active, reason).finally(() => {
        if (
          active.ws.readyState === WebSocket.OPEN ||
          active.ws.readyState === WebSocket.CONNECTING
        ) {
          active.ws.close(1000, reason);
        }
      });
    }
  }

  #requestClose(active: ActiveGatewaySession, reason: string): Promise<void> {
    if (active.setupPending) {
      active.pendingCloseReason ??= reason;
      return Promise.resolve();
    }
    return this.#close(active, reason);
  }

  #close(active: ActiveGatewaySession, reason: string): Promise<void> {
    if (active.closePromise) return active.closePromise;
    active.closePromise = (async () => {
      try {
        try {
          active.unsubscribe();
        } catch (error) {
          this.#reportError(error);
        }
        if (!active.rtcCloseRequested) {
          active.rtcCloseRequested = true;
          try {
            active.context.session.closeRtc(reason);
          } catch (error) {
            this.#reportError(error);
          }
        }
        try {
          active.context.session.close();
        } catch (error) {
          this.#reportError(error);
        }
        try {
          await this.#options.onSessionClosed?.({ ...active.context, reason });
        } catch (error) {
          this.#reportError(error);
        }
      } finally {
        this.#active.delete(active);
      }
    })();
    return active.closePromise;
  }

  #send(
    active: ActiveGatewaySession,
    type: string,
    data: Record<string, unknown>,
    id?: string,
  ): void {
    if (active.ws.readyState !== WebSocket.OPEN) return;
    active.ws.send(JSON.stringify({ ...(id ? { id } : {}), type, data }));
  }

  #rejectUpgrade(socket: Duplex, status: number, reason: string): void {
    if (socket.destroyed) return;
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
    socket.destroy();
  }

  #reportError(error: unknown): void {
    try {
      this.#options.onError?.(
        error instanceof Error ? error : new Error(String(error)),
      );
    } catch {
      // Error reporting must not interrupt session cleanup.
    }
  }
}

const defaultGatewayClientFactory: GatewayClientFactory = (options) =>
  new VoxRtcServerClient(options);

/** @internal */
export function createVoxRtcGatewayWithClientFactory(
  options: VoxRtcGatewayOptions,
  createClient: GatewayClientFactory,
): VoxRtcGateway {
  const client = createClient({
    httpBase: options.voxHttpBase,
    apiKey: options.apiKey,
  });
  return new DefaultVoxRtcGateway(options, client);
}

export function createVoxRtcGateway(
  options: VoxRtcGatewayOptions,
): VoxRtcGateway {
  return createVoxRtcGatewayWithClientFactory(
    options,
    defaultGatewayClientFactory,
  );
}
