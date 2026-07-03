import { ChannelState } from "@eleven-am/pondsocket-client";

import type {
  SocketChannelLike,
  Unsubscribe,
  VoxRtcBrowserEvent,
  VoxRtcCloseEvent,
  VoxRtcClientEventEnvelope,
  VoxRtcErrorEvent,
  VoxRtcInterruptionEvent,
  VoxRtcResponseEvent,
  VoxRtcResponseOptions,
  VoxRtcSessionAttachedEvent,
  VoxRtcSessionConfig,
  VoxRtcSessionCreatedEvent,
  VoxRtcSpeechEvent,
  VoxRtcTranscriptDeltaEvent,
  VoxRtcTranscriptEvent,
  VoxRtcTurnEouPredictedEvent,
  VoxRtcTurnStateEvent,
  VoxRtcWireEvent,
} from "./types.js";

const EVT_CLOSE = "rtc.client.disconnected";
const EVT_BROWSER_EVENT = "browser.event";
const EVT_ERROR = "error";
const EVT_INTERRUPTION_DETECTED = "interruption.detected";
const EVT_INTERRUPTION_FALSE_POSITIVE = "interruption.false_positive";
const EVT_RESPONSE_AUDIO_CLEAR = "response.audio.clear";
const EVT_RESPONSE_CANCELLED = "response.cancelled";
const EVT_RESPONSE_COMMITTED = "response.committed";
const EVT_RESPONSE_CREATED = "response.created";
const EVT_RESPONSE_DONE = "response.done";
const EVT_RTC_SESSION_ATTACHED = "rtc.session.attached";
const EVT_SESSION_CREATED = "session.created";
const EVT_SPEECH_STARTED = "input_audio_buffer.speech_started";
const EVT_SPEECH_STOPPED = "input_audio_buffer.speech_stopped";
const EVT_TRANSCRIPT_COMPLETED = "conversation.item.input_audio_transcription.completed";
const EVT_TRANSCRIPT_DELTA = "conversation.item.input_audio_transcription.delta";
const EVT_TURN_EOU_PREDICTED = "turn.eou.predicted";
const EVT_TURN_STATE_CHANGED = "turn.state_changed";

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

function payloadRecord(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return { payload: payload ?? null };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requiredString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length === value.length ? strings : undefined;
}

function baseEvent(
  payload: Record<string, unknown>,
  sessionId: string,
  channelName: string,
): { sessionId: string; channelName: string; data: Record<string, unknown> } {
  return {
    sessionId: requiredString(payload.session_id, sessionId),
    channelName,
    data: payload,
  };
}

function responseEvent(
  payload: Record<string, unknown>,
  sessionId: string,
  channelName: string,
): VoxRtcResponseEvent {
  return {
    ...baseEvent(payload, sessionId, channelName),
    responseId: optionalString(payload.response_id),
  };
}

function interruptionEvent(
  payload: Record<string, unknown>,
  sessionId: string,
  channelName: string,
): VoxRtcInterruptionEvent {
  return {
    ...responseEvent(payload, sessionId, channelName),
    vadActiveMs: optionalNumber(payload.vad_active_ms),
    partialTranscript: payload.partial_transcript === null
      ? null
      : optionalString(payload.partial_transcript),
  };
}

function speechEvent(
  payload: Record<string, unknown>,
  sessionId: string,
  channelName: string,
): VoxRtcSpeechEvent {
  return {
    ...baseEvent(payload, sessionId, channelName),
    timestampMs: optionalNumber(payload.timestamp_ms),
  };
}

function transcriptDeltaEvent(
  payload: Record<string, unknown>,
  sessionId: string,
  channelName: string,
): VoxRtcTranscriptDeltaEvent {
  return {
    ...baseEvent(payload, sessionId, channelName),
    delta: requiredString(payload.delta, ""),
    startMs: optionalNumber(payload.start_ms),
    endMs: optionalNumber(payload.end_ms),
  };
}

function turnEouPredictedEvent(
  payload: Record<string, unknown>,
  sessionId: string,
  channelName: string,
): VoxRtcTurnEouPredictedEvent {
  return {
    ...baseEvent(payload, sessionId, channelName),
    probability: optionalNumber(payload.probability),
    threshold: optionalNumber(payload.threshold),
    delayMs: optionalNumber(payload.delay_ms),
    startMs: optionalNumber(payload.start_ms),
    endMs: optionalNumber(payload.end_ms),
    decision: optionalString(payload.decision),
    action: optionalString(payload.action),
    turnDetector: optionalString(payload.turn_detector),
  };
}

function closeEvent(
  payload: Record<string, unknown>,
  sessionId: string,
  channelName: string,
): VoxRtcCloseEvent {
  return {
    ...baseEvent(payload, sessionId, channelName),
    reason: requiredString(payload.reason, "unknown"),
    connectionState: optionalString(payload.connection_state),
    iceConnectionState: optionalString(payload.ice_connection_state),
    dataChannelState: optionalString(payload.data_channel_state),
  };
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
        handler(payloadRecord(payload));
      }
    });
  }

  onSessionAttached(handler: (event: VoxRtcSessionAttachedEvent) => void): Unsubscribe {
    return this.on(EVT_RTC_SESSION_ATTACHED, (payload) => {
      handler(baseEvent(payload, this.#sessionId, this.#channelName));
    });
  }

  onSessionCreated(handler: (event: VoxRtcSessionCreatedEvent) => void): Unsubscribe {
    return this.on(EVT_SESSION_CREATED, (payload) => {
      const session = payload.session && typeof payload.session === "object" && !Array.isArray(payload.session)
        ? payload.session as Record<string, unknown>
        : undefined;
      handler({
        ...baseEvent(payload, this.#sessionId, this.#channelName),
        session,
      });
    });
  }

  onTranscript(handler: (event: VoxRtcTranscriptEvent) => void): Unsubscribe {
    return this.on(EVT_TRANSCRIPT_COMPLETED, (payload) => {
      handler({
        ...baseEvent(payload, this.#sessionId, this.#channelName),
        transcript: requiredString(payload.transcript, ""),
        language: optionalString(payload.language),
        startMs: optionalNumber(payload.start_ms),
        endMs: optionalNumber(payload.end_ms),
        eouProbability: optionalNumber(payload.eou_probability),
        topics: optionalStringArray(payload.topics),
      });
    });
  }

  onTurnStateChanged(handler: (event: VoxRtcTurnStateEvent) => void): Unsubscribe {
    return this.on(EVT_TURN_STATE_CHANGED, (payload) => {
      handler({
        ...baseEvent(payload, this.#sessionId, this.#channelName),
        state: requiredString(payload.state, "unknown"),
        previousState: optionalString(payload.previous_state),
      });
    });
  }

  onSpeechStarted(handler: (event: VoxRtcSpeechEvent) => void): Unsubscribe {
    return this.on(EVT_SPEECH_STARTED, (payload) => {
      handler(speechEvent(payload, this.#sessionId, this.#channelName));
    });
  }

  onSpeechStopped(handler: (event: VoxRtcSpeechEvent) => void): Unsubscribe {
    return this.on(EVT_SPEECH_STOPPED, (payload) => {
      handler(speechEvent(payload, this.#sessionId, this.#channelName));
    });
  }

  onTranscriptDelta(handler: (event: VoxRtcTranscriptDeltaEvent) => void): Unsubscribe {
    return this.on(EVT_TRANSCRIPT_DELTA, (payload) => {
      handler(transcriptDeltaEvent(payload, this.#sessionId, this.#channelName));
    });
  }

  onTurnEouPredicted(handler: (event: VoxRtcTurnEouPredictedEvent) => void): Unsubscribe {
    return this.on(EVT_TURN_EOU_PREDICTED, (payload) => {
      handler(turnEouPredictedEvent(payload, this.#sessionId, this.#channelName));
    });
  }

  onResponseCreated(handler: (event: VoxRtcResponseEvent) => void): Unsubscribe {
    return this.on(EVT_RESPONSE_CREATED, (payload) => {
      handler(responseEvent(payload, this.#sessionId, this.#channelName));
    });
  }

  onResponseCommitted(handler: (event: VoxRtcResponseEvent) => void): Unsubscribe {
    return this.on(EVT_RESPONSE_COMMITTED, (payload) => {
      handler(responseEvent(payload, this.#sessionId, this.#channelName));
    });
  }

  onResponseDone(handler: (event: VoxRtcResponseEvent) => void): Unsubscribe {
    return this.on(EVT_RESPONSE_DONE, (payload) => {
      handler(responseEvent(payload, this.#sessionId, this.#channelName));
    });
  }

  onResponseCancelled(handler: (event: VoxRtcResponseEvent) => void): Unsubscribe {
    return this.on(EVT_RESPONSE_CANCELLED, (payload) => {
      handler(responseEvent(payload, this.#sessionId, this.#channelName));
    });
  }

  onResponseAudioClear(handler: (event: VoxRtcResponseEvent) => void): Unsubscribe {
    return this.on(EVT_RESPONSE_AUDIO_CLEAR, (payload) => {
      handler(responseEvent(payload, this.#sessionId, this.#channelName));
    });
  }

  onInterruptionDetected(handler: (event: VoxRtcInterruptionEvent) => void): Unsubscribe {
    return this.on(EVT_INTERRUPTION_DETECTED, (payload) => {
      handler(interruptionEvent(payload, this.#sessionId, this.#channelName));
    });
  }

  onInterruptionFalsePositive(handler: (event: VoxRtcInterruptionEvent) => void): Unsubscribe {
    return this.on(EVT_INTERRUPTION_FALSE_POSITIVE, (payload) => {
      handler(interruptionEvent(payload, this.#sessionId, this.#channelName));
    });
  }

  onBrowserEvent(handler: (event: VoxRtcBrowserEvent) => void): Unsubscribe {
    return this.on(EVT_BROWSER_EVENT, (payload) => {
      handler({
        ...baseEvent(payload, this.#sessionId, this.#channelName),
        event: requiredString(payload.event, ""),
        payload: payload.payload ?? null,
      });
    });
  }

  onClose(handler: (event: VoxRtcCloseEvent) => void): Unsubscribe {
    return this.on(EVT_CLOSE, (payload) => {
      handler(closeEvent(payload, this.#sessionId, this.#channelName));
    });
  }

  onError(handler: (event: VoxRtcErrorEvent) => void): Unsubscribe {
    return this.on(EVT_ERROR, (payload) => {
      handler({
        ...baseEvent(payload, this.#sessionId, this.#channelName),
        message: optionalString(payload.message),
        code: optionalString(payload.code),
      });
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
