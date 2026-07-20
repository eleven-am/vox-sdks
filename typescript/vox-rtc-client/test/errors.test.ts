import assert from "node:assert/strict";
import test from "node:test";

import {
  VOX_ERROR_CODES,
  isFatalVoxError,
  isVoxErrorCode,
  parseVoxSessionError,
  parseVoxSignalingError,
  voxGenerationId,
} from "../src/errors.js";

test("parseVoxSessionError maps typed error frames to camelCase fields", () => {
  assert.deepEqual(
    parseVoxSessionError({
      message: "stale generation",
      code: "response_stale_generation",
      recoverable: true,
      generation_id: "gen-42",
    }),
    {
      message: "stale generation",
      code: "response_stale_generation",
      recoverable: true,
      generationId: "gen-42",
    },
  );
});

test("parseVoxSessionError defaults missing recoverable to true for old servers", () => {
  const error = parseVoxSessionError({ message: "legacy failure" });
  assert.equal(error.recoverable, true);
  assert.equal(error.code, undefined);
  assert.equal(error.generationId, undefined);
});

test("parseVoxSessionError normalizes empty strings to undefined", () => {
  const error = parseVoxSessionError({
    message: "",
    code: "",
    recoverable: false,
    generation_id: "",
  });
  assert.equal(error.message, undefined);
  assert.equal(error.code, undefined);
  assert.equal(error.generationId, undefined);
  assert.equal(error.recoverable, false);
});

test("parseVoxSessionError treats non-object frames as recoverable empty errors", () => {
  assert.deepEqual(parseVoxSessionError(null), {
    message: undefined,
    code: undefined,
    recoverable: true,
    generationId: undefined,
  });
  assert.equal(parseVoxSessionError("boom").recoverable, true);
});

test("parseVoxSignalingError maps the terminal signaling frame vox actually sends", () => {
  assert.deepEqual(
    parseVoxSignalingError({
      message: "failed to apply local description",
      generation: 2,
    }),
    {
      message: "failed to apply local description",
      code: undefined,
      recoverable: false,
      generationId: undefined,
    },
  );
});

test("parseVoxSignalingError is terminal regardless of the frame contents", () => {
  assert.equal(isFatalVoxError(parseVoxSignalingError({ message: "boom" })), true);
  assert.equal(parseVoxSignalingError(null).recoverable, false);
  assert.equal(
    parseVoxSignalingError({ recoverable: true, code: "session_failed" }).recoverable,
    false,
  );
});

test("isVoxErrorCode matches the stable contract code set", () => {
  for (const code of VOX_ERROR_CODES) {
    assert.equal(isVoxErrorCode(code), true);
  }
  assert.equal(isVoxErrorCode("session_failed"), true);
  assert.equal(isVoxErrorCode("not_a_code"), false);
  assert.equal(isVoxErrorCode(""), false);
  assert.equal(isVoxErrorCode(undefined), false);
});

test("isFatalVoxError classification table", () => {
  const table: Array<[unknown, boolean]> = [
    [{ code: "session_failed", recoverable: false }, true],
    [{ code: "session_failed" }, true],
    [{ recoverable: false }, true],
    [{ code: "response_stale_generation", recoverable: true, generation_id: "gen-1" }, false],
    [{ code: "response_rejected_turn_state", recoverable: true }, false],
    [{ message: "legacy failure" }, false],
    [{ code: "" }, false],
    [null, false],
  ];
  for (const [frame, fatal] of table) {
    assert.equal(isFatalVoxError(frame), fatal, JSON.stringify(frame));
  }
});

test("isFatalVoxError accepts already-parsed session errors", () => {
  assert.equal(isFatalVoxError(parseVoxSessionError({ code: "session_failed" })), true);
  assert.equal(
    isFatalVoxError(parseVoxSessionError({ code: "response_failed", recoverable: true })),
    false,
  );
});

test("voxGenerationId extracts non-empty generation ids from payloads", () => {
  assert.equal(voxGenerationId({ generation_id: "gen-7" }), "gen-7");
  assert.equal(voxGenerationId({ generationId: "gen-8" }), "gen-8");
  assert.equal(voxGenerationId({ generation_id: "" }), undefined);
  assert.equal(voxGenerationId({}), undefined);
  assert.equal(voxGenerationId(null), undefined);
  assert.equal(voxGenerationId("gen-9"), undefined);
});
