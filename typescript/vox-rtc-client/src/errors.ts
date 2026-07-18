export const VOX_ERROR_CODES = Object.freeze([
  "response_rejected_turn_state",
  "response_rejected_user_speech",
  "response_stale_generation",
  "response_already_active",
  "response_failed",
  "command_invalid",
  "session_failed",
] as const);

export type VoxErrorCode = (typeof VOX_ERROR_CODES)[number];

export function isVoxErrorCode(code: unknown): code is VoxErrorCode {
  return typeof code === "string" && (VOX_ERROR_CODES as readonly string[]).includes(code);
}

export interface VoxRtcSessionError {
  message?: string;
  code?: string;
  recoverable: boolean;
  generationId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseVoxSessionError(frame: unknown): VoxRtcSessionError {
  const payload = isRecord(frame) ? frame : {};
  return {
    message: nonEmptyString(payload.message),
    code: nonEmptyString(payload.code),
    recoverable: typeof payload.recoverable === "boolean" ? payload.recoverable : true,
    generationId: nonEmptyString(payload.generation_id) ?? nonEmptyString(payload.generationId),
  };
}

export function isFatalVoxError(frame: unknown): boolean {
  const error = parseVoxSessionError(frame);
  return error.recoverable === false || error.code === "session_failed";
}

export function voxGenerationId(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  return nonEmptyString(payload.generation_id) ?? nonEmptyString(payload.generationId);
}
