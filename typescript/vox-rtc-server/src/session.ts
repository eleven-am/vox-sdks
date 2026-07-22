import { ChannelState } from "@eleven-am/pondsocket-client";
import { randomUUID } from "node:crypto";

import type {
  SocketChannelLike,
  Unsubscribe,
  VoxRtcBrowserEvent,
  VoxRtcCloseEvent,
  VoxRtcClientEventEnvelope,
  VoxRtcErrorEvent,
  VoxRtcInterruptionEvent,
  VoxRtcIceCandidate,
  VoxRtcOfferOptions,
  VoxRtcResponseEvent,
  VoxRtcResponseOptions,
  VoxRtcSessionAttachedEvent,
  VoxRtcSessionConfig,
  VoxRtcSessionCreatedEvent,
  VoxRtcSessionDescription,
  VoxRtcSignalingErrorEvent,
  VoxRtcSpeechEvent,
  VoxRtcStartResponseResult,
  VoxRtcStartResponseWaitOptions,
  VoxRtcTranscriptDeltaEvent,
  VoxRtcTranscriptEntity,
  VoxRtcTranscriptEvent,
  VoxRtcTranscriptWord,
  VoxRtcTurnEouPredictedEvent,
  VoxRtcTurnStateEvent,
  VoxRtcWireEvent,
} from "./types.js";
import { VOX_START_ACK_TIMEOUT_CODE } from "./types.js";

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
const EVT_RTC_ANSWER = "rtc.answer";
const EVT_RTC_ICE_CANDIDATE = "rtc.ice_candidate";
const EVT_RTC_SESSION_CLOSED = "rtc.session.closed";
const EVT_RTC_SIGNALING_ERROR = "rtc.signaling_error";
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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalEntities(value: unknown): VoxRtcTranscriptEntity[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entities: VoxRtcTranscriptEntity[] = [];
  for (const item of value) {
    if (!isObjectRecord(item)) continue;
    entities.push({
      type: requiredString(item.type, ""),
      text: requiredString(item.text, ""),
      startChar: optionalNumber(item.start_char),
      endChar: optionalNumber(item.end_char),
    });
  }
  return entities;
}

function optionalWords(value: unknown): VoxRtcTranscriptWord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const words: VoxRtcTranscriptWord[] = [];
  for (const item of value) {
    if (!isObjectRecord(item)) continue;
    words.push({
      word: requiredString(item.word, ""),
      startMs: optionalNumber(item.start_ms),
      endMs: optionalNumber(item.end_ms),
      confidence: optionalNumber(item.confidence),
    });
  }
  return words;
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
    generationId: optionalString(payload.generation_id),
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
    reason: optionalString(payload.reason),
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

const SESSION_CONFIG_KEY_MAP: Record<string, string> = {
  sttModel: "stt_model",
  ttsModel: "tts_model",
  voice: "voice",
  turnProfile: "turn_profile",
  vadBackend: "vad_backend",
  turnDetector: "turn_detector",
  speechContext: "speech_context",
};

export class VoxRtcChannelJoinError extends Error {
  readonly code?: string;
  readonly status?: number;
  readonly details?: unknown;

  constructor(
    message: string,
    fields: { code?: string; status?: number; details?: unknown },
  ) {
    super(message);
    this.name = "VoxRtcChannelJoinError";
    this.code = fields.code;
    this.status = fields.status;
    this.details = fields.details;
  }
}

export class VoxRtcControlSession {
  readonly #channel: SocketChannelLike;
  readonly #sessionId: string;
  readonly #channelName: string;
  readonly #joinTimeoutMs: number;
  #responseGenerationCounter = 0;
  #responseGenerationId: string | null = null;

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
      let timer: ReturnType<typeof setTimeout> | undefined;
      let offState: Unsubscribe = () => {};
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        offState();
        fn();
      };

      const unsubscribe = this.#channel.onChannelStateChange((state) => {
        if (state === ChannelState.JOINED) {
          finish(resolve);
        } else if (state === ChannelState.DECLINED || state === ChannelState.CLOSED) {
          const joinError = this.#channel.joinError ?? null;
          const reason = joinError?.message;
          const suffix = reason ? `: ${reason}` : "";
          finish(() => reject(new VoxRtcChannelJoinError(
            `RTC channel join failed for ${this.#channelName}: ${state}${suffix}`,
            {
              code: joinError?.code,
              status: joinError?.status,
              details: joinError?.details,
            },
          )));
        }
      });
      offState = unsubscribe;
      if (done) {
        offState();
        return;
      }

      timer = setTimeout(() => {
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

  onAnswer(handler: (answer: VoxRtcSessionDescription) => void): Unsubscribe {
    return this.on(EVT_RTC_ANSWER, (payload) => {
      const answer = payload.answer;
      if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
        return;
      }
      const record = answer as Record<string, unknown>;
      if (record.type === "answer" && typeof record.sdp === "string") {
        handler({ type: "answer", sdp: record.sdp });
      }
    });
  }

  onIceCandidate(handler: (candidate: VoxRtcIceCandidate | null) => void): Unsubscribe {
    return this.on(EVT_RTC_ICE_CANDIDATE, (payload) => {
      const value = payload.candidate;
      if (value === null || value === undefined) {
        handler(null);
        return;
      }
      if (typeof value !== "object" || Array.isArray(value)) {
        return;
      }
      const candidate = value as Record<string, unknown>;
      if (typeof candidate.candidate !== "string") {
        return;
      }
      handler({
        candidate: candidate.candidate,
        sdpMid: typeof candidate.sdpMid === "string" ? candidate.sdpMid : null,
        sdpMLineIndex: typeof candidate.sdpMLineIndex === "number"
          ? candidate.sdpMLineIndex
          : null,
        usernameFragment: typeof candidate.usernameFragment === "string"
          ? candidate.usernameFragment
          : null,
      });
    });
  }

  onSessionClosed(handler: (event: VoxRtcCloseEvent) => void): Unsubscribe {
    return this.on(EVT_RTC_SESSION_CLOSED, (payload) => {
      handler(closeEvent(payload, this.#sessionId, this.#channelName));
    });
  }

  onSignalingError(handler: (event: VoxRtcSignalingErrorEvent) => void): Unsubscribe {
    return this.on(EVT_RTC_SIGNALING_ERROR, (payload) => {
      handler({
        ...baseEvent(payload, this.#sessionId, this.#channelName),
        message: optionalString(payload.message),
        generation: optionalNumber(payload.generation),
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
        entities: optionalEntities(payload.entities),
        words: optionalWords(payload.words),
        speechContext: isObjectRecord(payload.speech_context)
          ? payload.speech_context
          : undefined,
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
        recoverable: typeof payload.recoverable === "boolean" ? payload.recoverable : true,
        generationId: optionalString(payload.generation_id),
      });
    });
  }

  sendControl(type: string, payload: Record<string, unknown> = {}): void {
    this.#channel.sendMessage(type, payload);
  }

  sendOffer(offer: VoxRtcSessionDescription, options?: VoxRtcOfferOptions): void {
    if (offer.type !== "offer" || !offer.sdp.trim()) {
      throw new Error("RTC offer requires a non-empty SDP offer");
    }
    this.sendControl("rtc.offer", {
      offer: { type: offer.type, sdp: offer.sdp },
      restart: options?.restart === true,
      ...(options?.generation !== undefined
        ? { generation: options.generation }
        : {}),
    });
  }

  sendIceCandidate(candidate: VoxRtcIceCandidate | null): void {
    this.sendControl("rtc.ice_candidate", {
      candidate: candidate === null
        ? null
        : {
            candidate: candidate.candidate,
            sdpMid: candidate.sdpMid ?? null,
            sdpMLineIndex: candidate.sdpMLineIndex ?? null,
            usernameFragment: candidate.usernameFragment ?? null,
          },
    });
  }

  closeRtc(reason = "client_closed"): void {
    this.sendControl("rtc.close", { reason });
  }

  configure(config: VoxRtcSessionConfig): void {
    const session: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      if (value === undefined) continue;
      session[SESSION_CONFIG_KEY_MAP[key] ?? key] = value;
    }
    this.sendControl("session.update", { session });
  }

  startResponse(options?: VoxRtcResponseOptions): void {
    this.#responseGenerationId = options?.generationId ?? this.#nextGenerationId();
    this.sendControl(
      "response.start",
      withAllowInterruptions(
        { generation_id: this.#responseGenerationId },
        options,
      ),
    );
  }

  startResponseAndWait(options?: VoxRtcStartResponseWaitOptions): Promise<VoxRtcStartResponseResult> {
    const generationId = options?.generationId ?? this.#nextGenerationId();
    const timeoutMs = options?.timeoutMs ?? 10_000;
    return new Promise((resolve) => {
      let done = false;
      const finish = (result: VoxRtcStartResponseResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        offCreated();
        offError();
        resolve(result);
      };

      const offCreated = this.onResponseCreated((event) => {
        if (event.generationId === generationId) {
          finish({ accepted: true, responseId: event.responseId, generationId });
        }
      });

      const offError = this.onError((event) => {
        if (event.generationId === generationId) {
          finish({
            accepted: false,
            error: {
              code: event.code,
              recoverable: event.recoverable,
              message: event.message,
            },
          });
        }
      });

      const timer = setTimeout(() => {
        finish({
          accepted: false,
          error: {
            code: VOX_START_ACK_TIMEOUT_CODE,
            recoverable: true,
            message: `Timed out waiting for response.created ack for ${generationId}`,
          },
        });
      }, timeoutMs);

      this.startResponse({ ...options, generationId });
    });
  }

  appendResponseText(delta: string, options?: VoxRtcResponseOptions): void {
    this.sendControl(
      "response.delta",
      withAllowInterruptions(
        this.#withResponseGeneration({ delta }, options?.generationId),
        options,
      ),
    );
  }

  commitResponse(options?: VoxRtcResponseOptions): void {
    this.sendControl(
      "response.commit",
      this.#withResponseGeneration({}, options?.generationId),
    );
  }

  cancelResponse(options?: VoxRtcResponseOptions): void {
    this.sendControl(
      "response.cancel",
      this.#withResponseGeneration({}, options?.generationId),
    );
    if (options?.generationId === undefined || options.generationId === this.#responseGenerationId) {
      this.#responseGenerationId = null;
    }
  }

  replaceResponseText(text: string, options?: VoxRtcResponseOptions): void {
    this.#responseGenerationId = options?.generationId ?? null;
    this.sendControl(
      "response.replace_text",
      withAllowInterruptions(
        this.#withResponseGeneration({ text }, options?.generationId),
        options,
      ),
    );
  }

  sendTextResponse(text: string, options?: VoxRtcResponseOptions): void {
    this.replaceResponseText(text, options);
  }

  sendClientEvent(envelope: VoxRtcClientEventEnvelope): void {
    this.sendControl("client.event", {
      event: envelope.event,
      payload: envelope.payload ?? null,
    });
  }

  #withResponseGeneration(
    payload: Record<string, unknown>,
    generationId?: string,
  ): Record<string, unknown> {
    const id = generationId ?? this.#responseGenerationId;
    if (id === null || id === undefined) {
      return payload;
    }
    return { ...payload, generation_id: id };
  }

  #nextGenerationId(): string {
    this.#responseGenerationCounter += 1;
    return [
      "generation",
      this.#responseGenerationCounter.toString(36),
      randomUUID(),
    ].join("_");
  }
}
