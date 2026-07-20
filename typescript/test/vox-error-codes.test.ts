import assert from "node:assert/strict";
import test from "node:test";

import { VOX_ERROR_CODES as CLIENT_CODES } from "../vox-rtc-client/src/errors.js";
import { VOX_ERROR_CODES as SERVER_CODES } from "../vox-rtc-server/src/types.js";

test("VOX_ERROR_CODES stays identical across the client and server packages", () => {
  assert.deepEqual([...CLIENT_CODES], [...SERVER_CODES]);
});
