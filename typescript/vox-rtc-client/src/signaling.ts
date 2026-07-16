import type {
  VoxRtcBrowserSessionBootstrap,
  VoxRtcSignalingEvent,
  WebSocketFactory,
  WebSocketLike,
} from "./types.js";

const OPEN = 1;
const FORBIDDEN_GATEWAY_KEYS = new Set([
  "clientToken",
  "client_token",
  "voxHttpBase",
  "vox_http_base",
  "mediaToken",
  "media_token",
  "eventsUrl",
  "events_url",
]);

interface PendingRequest {
  resolve: (description: RTCSessionDescriptionInit) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface GatewayReadyData {
  capability: string;
  session: VoxRtcBrowserSessionBootstrap;
}

export interface GatewaySignalingOptions {
  endpoint: string;
  timeoutMs?: number;
  webSocketFactory?: WebSocketFactory;
  onEvent: (event: VoxRtcSignalingEvent) => void;
  onError: (error: Error) => void;
  onClose: (reason: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function defaultWebSocketFactory(url: string): WebSocketLike {
  return new WebSocket(url);
}

function validateEndpoint(endpoint: string): string {
  if (!endpoint.startsWith("/") || endpoint.startsWith("//")) {
    throw new Error("RTC signalingEndpoint must be a same-origin path");
  }
  return endpoint;
}

function parseEvent(data: unknown): VoxRtcSignalingEvent {
  if (typeof data !== "string") {
    throw new Error("RTC gateway messages must be text JSON");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error("RTC gateway sent invalid JSON");
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.type !== "string" ||
    !isRecord(parsed.data)
  ) {
    throw new Error("RTC gateway sent an invalid event envelope");
  }
  return {
    ...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
    type: parsed.type,
    data: parsed.data,
  };
}

function assertNoPrivateFields(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertNoPrivateFields);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_GATEWAY_KEYS.has(key)) {
      throw new Error(`RTC gateway exposed forbidden private field: ${key}`);
    }
    assertNoPrivateFields(child);
  }
}

function normalizeReady(data: Record<string, unknown>): GatewayReadyData {
  assertNoPrivateFields(data);
  if (typeof data.capability !== "string" || data.capability.length < 32) {
    throw new Error("RTC gateway ready event is missing its capability");
  }
  if (!isRecord(data.session)) {
    throw new Error("RTC gateway ready event is missing its session");
  }
  const session = data.session;
  const sessionId = session.sessionId;
  const iceServers = session.iceServers;
  if (
    typeof sessionId !== "string" ||
    !sessionId ||
    !Array.isArray(iceServers)
  ) {
    throw new Error("RTC gateway ready event contains an invalid session");
  }
  return {
    capability: data.capability,
    session: {
      sessionId,
      iceServers: iceServers as RTCIceServer[],
      expiresAt:
        typeof session.expiresAt === "string" ? session.expiresAt : undefined,
      attachTtlSeconds:
        typeof session.attachTtlSeconds === "number"
          ? session.attachTtlSeconds
          : undefined,
    },
  };
}

function gatewayError(event: VoxRtcSignalingEvent): Error {
  const message =
    typeof event.data.message === "string"
      ? event.data.message
      : "RTC gateway request failed";
  return new Error(message);
}

function answerDescription(
  event: VoxRtcSignalingEvent,
): RTCSessionDescriptionInit {
  const answer = event.data.answer;
  if (
    !isRecord(answer) ||
    answer.type !== "answer" ||
    typeof answer.sdp !== "string"
  ) {
    throw new Error("RTC gateway returned an invalid answer");
  }
  return { type: "answer", sdp: answer.sdp };
}

export class GatewaySignalingClient {
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #webSocketFactory: WebSocketFactory;
  readonly #onEvent: (event: VoxRtcSignalingEvent) => void;
  readonly #onError: (error: Error) => void;
  readonly #onClose: (reason: string) => void;
  readonly #pending = new Map<string, PendingRequest>();
  #socket: WebSocketLike | null = null;
  #capability: string | null = null;
  #nextId = 0;
  #negotiationGeneration = 0;
  #closed = false;

  constructor(options: GatewaySignalingOptions) {
    this.#endpoint = validateEndpoint(options.endpoint);
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#webSocketFactory =
      options.webSocketFactory ?? defaultWebSocketFactory;
    this.#onEvent = options.onEvent;
    this.#onError = options.onError;
    this.#onClose = options.onClose;
  }

  connect(): Promise<VoxRtcBrowserSessionBootstrap> {
    if (this.#socket)
      throw new Error("RTC gateway signaling is already connected");
    const socket = this.#webSocketFactory(this.#endpoint);
    this.#socket = socket;
    const queued: VoxRtcSignalingEvent[] = [];

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        const error = new Error("RTC gateway connection timed out");
        rejectReady(error);
        socket.close(1000, "Gateway timeout");
      }, this.#timeoutMs);
      const rejectReady = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };

      socket.onmessage = (message) => {
        try {
          const event = parseEvent(message.data);
          if (!settled) {
            if (event.type === "gateway.error") {
              rejectReady(gatewayError(event));
              return;
            }
            if (event.type !== "gateway.ready") {
              queued.push(event);
              return;
            }
            const ready = normalizeReady(event.data);
            this.#capability = ready.capability;
            settled = true;
            clearTimeout(timer);
            resolve(ready.session);
            queued.forEach((item) => {
              this.#dispatch(item);
            });
            return;
          }
          this.#dispatch(event);
        } catch (error) {
          const normalized =
            error instanceof Error ? error : new Error(String(error));
          rejectReady(normalized);
          this.#onError(normalized);
          socket.close(1002, "Invalid gateway message");
        }
      };
      socket.onerror = () => {
        const error = new Error("RTC gateway WebSocket failed");
        rejectReady(error);
        this.#onError(error);
      };
      socket.onclose = (event) => {
        const reason = event.reason || `gateway_closed_${event.code}`;
        const error = new Error(`RTC gateway closed: ${reason}`);
        rejectReady(error);
        this.#rejectPending(error);
        this.#socket = null;
        if (!this.#closed) this.#onClose(reason);
      };
    });
  }

  exchangeOffer(
    offer: RTCSessionDescriptionInit,
    options: { restart?: boolean } = {},
  ): Promise<RTCSessionDescriptionInit> {
    this.#negotiationGeneration += 1;
    const generation = this.#negotiationGeneration;
    const id = this.#id("offer");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("RTC gateway offer timed out"));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#send(id, "rtc.offer", {
          offer,
          restart: options.restart === true,
          generation,
        });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  sendCandidate(candidate: RTCIceCandidateInit | null): void {
    if (this.#negotiationGeneration < 1) {
      throw new Error("RTC offer must be sent before ICE candidates");
    }
    this.#send(this.#id("candidate"), "rtc.ice_candidate", {
      candidate,
      generation: this.#negotiationGeneration,
    });
  }

  close(reason = "client_closed"): void {
    if (this.#closed) return;
    this.#closed = true;
    const socket = this.#socket;
    if (socket?.readyState === OPEN && this.#capability) {
      try {
        this.#send(this.#id("close"), "rtc.close", { reason });
      } catch {}
      socket.close(1000, reason);
    } else {
      socket?.close(1000, reason);
    }
    this.#socket = null;
    this.#rejectPending(new Error(`RTC gateway closed: ${reason}`));
  }

  #dispatch(event: VoxRtcSignalingEvent): void {
    if (
      event.type === "rtc.ice_candidate" &&
      (typeof event.data.generation !== "number" ||
        event.data.generation !== this.#negotiationGeneration)
    ) {
      return;
    }
    if (event.id) {
      const pending = this.#pending.get(event.id);
      if (
        pending &&
        (event.type === "rtc.answer" ||
          event.type === "gateway.error" ||
          event.type === "error")
      ) {
        clearTimeout(pending.timer);
        this.#pending.delete(event.id);
        if (event.type === "rtc.answer") {
          try {
            pending.resolve(answerDescription(event));
          } catch (error) {
            pending.reject(
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        } else {
          pending.reject(gatewayError(event));
        }
        return;
      }
    }
    if (event.type === "gateway.error" || event.type === "error") {
      this.#onError(gatewayError(event));
    }
    this.#onEvent(event);
  }

  #send(id: string, type: string, data: Record<string, unknown>): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== OPEN || !this.#capability) {
      throw new Error("RTC gateway signaling is not ready");
    }
    socket.send(
      JSON.stringify({ id, type, capability: this.#capability, data }),
    );
  }

  #id(prefix: string): string {
    this.#nextId += 1;
    return `${prefix}-${this.#nextId}`;
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
