import { ChannelState } from "@eleven-am/pondsocket-client";

import type {
  SocketChannelLike,
  Unsubscribe,
  VoxRtcClientEventEnvelope,
  VoxRtcResponseOptions,
  VoxRtcSessionConfig,
  VoxRtcWireEvent,
} from "./types.js";

function toWireEvent(
  type: string,
  payload: unknown,
  sessionId: string,
  channelName: string,
): VoxRtcWireEvent {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return { type, data: payload as Record<string, unknown>, sessionId, channelName };
  }
  return { type, data: { payload: payload ?? null }, sessionId, channelName };
}

function withAllowInterruptions(
  payload: Record<string, unknown>,
  options?: VoxRtcResponseOptions,
): Record<string, unknown> {
  if (options?.allowInterruptions === undefined) {
    return payload;
  }
  return { ...payload, allow_interruptions: options.allowInterruptions };
}

export class VoxRtcControlSession {
  readonly #channel: SocketChannelLike;
  readonly #sessionId: string;
  readonly #channelName: string;
  readonly #joinTimeoutMs: number;

  constructor(channel: SocketChannelLike, sessionId: string, joinTimeoutMs = 10_000) {
    this.#channel = channel;
    this.#sessionId = sessionId;
    this.#channelName = `/rtc/${sessionId}`;
    this.#joinTimeoutMs = joinTimeoutMs;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get channelName(): string {
    return this.#channelName;
  }

  join(): Promise<void> {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        offState();
        fn();
      };

      const offState = this.#channel.onChannelStateChange((state) => {
        if (state === ChannelState.JOINED) {
          finish(resolve);
        } else if (state === ChannelState.DECLINED || state === ChannelState.CLOSED) {
          finish(() => reject(new Error(`RTC channel join failed for ${this.#channelName}: ${state}`)));
        }
      });

      const timer = setTimeout(() => {
        finish(() => reject(new Error(`RTC channel join timed out for ${this.#channelName}`)));
      }, this.#joinTimeoutMs);

      this.#channel.join();
    });
  }

  close(): void {
    this.#channel.leave();
  }

  onEvent(handler: (event: VoxRtcWireEvent) => void): Unsubscribe {
    return this.#channel.onMessage((event, payload) => {
      handler(toWireEvent(event, payload, this.#sessionId, this.#channelName));
    });
  }

  on(eventType: string, handler: (payload: Record<string, unknown>) => void): Unsubscribe {
    return this.#channel.onMessage((event, payload) => {
      if (event === eventType) {
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
          handler(payload as Record<string, unknown>);
        } else {
          handler({ payload: payload ?? null });
        }
      }
    });
  }

  sendControl(type: string, payload: Record<string, unknown> = {}): void {
    this.#channel.sendMessage(type, payload);
  }

  configure(config: VoxRtcSessionConfig): void {
    const session: Record<string, unknown> = {};
    if (config.sttModel !== undefined) session.stt_model = config.sttModel;
    if (config.ttsModel !== undefined) session.tts_model = config.ttsModel;
    if (config.voice !== undefined) session.voice = config.voice;
    if (config.turnProfile !== undefined) session.turn_profile = config.turnProfile;
    if (config.vadBackend !== undefined) session.vad_backend = config.vadBackend;
    if (config.turnDetector !== undefined) session.turn_detector = config.turnDetector;

    for (const [key, value] of Object.entries(config)) {
      if (
        key !== "sttModel"
        && key !== "ttsModel"
        && key !== "voice"
        && key !== "turnProfile"
        && key !== "vadBackend"
        && key !== "turnDetector"
      ) {
        session[key] = value;
      }
    }

    this.sendControl("session.update", { session });
  }

  startResponse(options?: VoxRtcResponseOptions): void {
    this.sendControl("response.start", withAllowInterruptions({}, options));
  }

  appendResponseText(delta: string, options?: VoxRtcResponseOptions): void {
    this.sendControl("response.delta", withAllowInterruptions({ delta }, options));
  }

  commitResponse(): void {
    this.sendControl("response.commit");
  }

  cancelResponse(): void {
    this.sendControl("response.cancel");
  }

  replaceResponseText(text: string, options?: VoxRtcResponseOptions): void {
    this.sendControl("response.replace_text", withAllowInterruptions({ text }, options));
  }

  sendTextResponse(text: string, options?: VoxRtcResponseOptions & { cancelFirst?: boolean }): void {
    if (options?.cancelFirst !== false) {
      this.replaceResponseText(text, options);
      return;
    }
    this.startResponse(options);
    this.appendResponseText(text, options);
    this.commitResponse();
  }

  sendClientEvent(envelope: VoxRtcClientEventEnvelope): void {
    this.sendControl("client.event", {
      event: envelope.event,
      payload: envelope.payload ?? null,
    });
  }
}
