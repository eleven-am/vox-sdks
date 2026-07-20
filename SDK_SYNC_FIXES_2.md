# Vox RTC SDK fixes, round 2 — shared spec

Source: five-SDK simplification audit (2026-07-20), verified against vox main
(source of truth for the wire contract) and adjudicated by the owner. Each SDK
implements its section following its existing conventions. Ordering within each
SDK: correctness first, contract completeness second, deletions third.

Two owner decisions drive the cross-cutting changes:

1. Browser audio ducking keeps ONLY the server-signaled `vox` mode. The local
   mic-energy analyser and the `hybrid` mode are deleted.
2. The gateway `capability` handshake is deleted from the gateway protocol.
   Rationale: both gateways create exactly one session per WebSocket connection
   at connect time and deliver the capability on that same socket; anyone who
   can send frames already holds it, and it does not prevent cross-site
   WebSocket hijacking (a hostile page's connection receives its own valid
   capability). Gateway messages become `{id, type, data}`. An Origin
   allowlist on the gateway is the legitimate protection and is noted as a
   possible future addition; it is NOT part of this round.

Adjudication note: `rtc.session.attached` IS emitted over PondSocket (it is
emitted transport-agnostically in `RtcRuntime.start`, operations/rtc_runtime.py).
No SDK deletes its attached handler.

## Cross-SDK items (all four PondSocket server SDKs)

- **Typed signaling-error surface.** The control channel carries
  `rtc.signaling_error` (`message`, `code`, `recoverable`, `generation_id`).
  Add a typed handler for it in each server SDK, following each SDK's existing
  typed-handler pattern, with one test each.
- **Transcript completeness.** `transcript.completed` typed events add
  `entities` (list of {type, text, start_char, end_char}) and `words`
  (list of {word, start_ms, end_ms, confidence?}) where missing. Raw data
  passthrough is unchanged.
- **Interruption reason.** `interruption.detected` and
  `interruption.false_positive` typed events add the `reason` string where
  missing (server sends documented slugs).

## TypeScript (`typescript/vox-rtc-client`, `typescript/vox-rtc-server`)

Correctness:
1. `rtc.signaling_error` received by the browser client must surface via
   `onSessionError`, not fall into the generic message stream (client.ts ~479
   only promotes `type === "error"` today). Test it.
2. Reconnection (round-1 item 2, still open): determine whether
   pondsocket-client 0.0.39 auto-rejoins channels after a socket reconnect
   (read the dependency source). If it does, rely on it, wire
   `onConnectionChange` for post-connect observability, and pin with a test.
   If it does not, add the explicit disclaimer the round-1 spec required
   (code-level doc on connect) stating re-join is not provided and why.
3. Structured join-decline: preserve `code`/`status`/`details` from the join
   error (session.ts ~234 currently keeps only `message`).

Protocol (owner decision 2):
4. Delete the capability handshake end to end: gateway stops minting
   (`randomBytes` capability, gateway.ts ~279), removes it from the ready
   payload and from message parsing (`{id, type, data}` required fields only),
   deletes `capabilityMatches`/timing-safe compare; client signaling stops
   reading and echoing it. Update the express example and any example HTML.
   Delete `assertNoPrivateFields`/`FORBIDDEN_GATEWAY_KEYS` (signaling.ts ~9-18,
   ~79-91) — it guards a co-designed payload in this same repo.

Deletions (owner decision 1):
5. Audio ducking: keep only mode `vox` (`#handleAudioDuckingControlEvent`
   path). Delete the analyser/RMS machinery, the `local` and `hybrid` modes,
   and the knobs that only they consumed. CORRECTED 2026-07-20: the original
   enumeration here wrongly listed duckVolume/sustainedVolume/
   sustainedAfterMs/releaseDelayMs, which the vox path consumes — the
   criterion ("knobs only the deleted modes consumed") is authoritative, and
   the implementation correctly kept those four while deleting threshold/
   localHoldMs/pollIntervalMs. Superseded in part by round 3: the sustained
   tier (sustainedVolume/sustainedAfterMs) is deleted there for being
   half-implemented. Delete their tests; update README.
6. `configure()` double-mapping (session.ts ~486): collapse to one mapping
   table + spread.
7. `sendTextResponse` `cancelFirst:false` branch (session.ts ~608): no caller;
   delete the branch (option stays if the signature is public API — then it
   errors or is removed per semver judgment; prefer removal, this is 0.x).
8. `handleControlEvent` (client.ts ~420): make private.

Completeness (cross-SDK items above) plus:
9. Duplicated single facts across the two packages (`VOX_ERROR_CODES`,
   envelope/candidate/description/bootstrap types): add a repo-level test that
   imports both and asserts the error-code lists are identical, so drift fails
   a build instead of shipping.

## Python (`python/vox-rtc-server`)

Correctness / green bar:
1. Add `ruff` to the dev dependency group — the round-1 green bar
   (`uv run ruff check .`) cannot run on a clean checkout today.

Deletions:
2. `RtcSessionDescription` + `RtcIceCandidate` (types.py ~39-51) and their
   exports: provably unconsumed, wrong layer (signaling is browser-owned).
3. `send_text_response(cancel_first=False)` dead branch (session.py ~604).
4. `pytest-asyncio` dev dep: unused (tests use `asyncio.run`).
5. `_join_error` shape-probing (session.py ~104): collapse to the single path
   the real pond channel produces.
6. `_state_value` duplicate (client.py ~47 / session.py ~52): one owner.

Simplification:
7. Extract a `_common(payload)` builder for the repeated
   session_id/channel_name/data boilerplate across the typed `on_*` closures.
   Keep per-event typed extraction as-is.

Completeness (cross-SDK items above) plus:
8. `SessionAttachedEvent` adds `provider`.

## Go (`go/rtcserver`)

Correctness:
1. Join-decline reason must work in production. `rawSocketChannel` does not
   implement `joinErrorReporter`; only the test fake does, so real deployments
   always get an empty reason while the test stays green. Capture the decline
   payload from the surfaced pond ChannelEvent in `rawSocketChannel` and
   report it; the test must exercise the production type's path (fix the fake
   to match reality or test through the real adapter). Do not keep a test that
   pins behavior production cannot deliver.
2. `mapChannelState`: use the exported `pondsocket.Declined` constant
   (socket.go ~96) instead of casting the SDK's own "DECLINED" literal.
3. Forward `ConnectionTimeout` into pond client options where supported
   (currently used only SDK-side).

Protocol (owner decision 2):
4. Delete the capability handshake from the gateway (`randomCapability`,
   session field, parse requirement, checks — gateway.go ~64, ~173-179,
   ~204-216, ~233-251, ~440-453) and its tests/examples. Messages are
   `{id, type, data}`.

Completeness: cross-SDK items above (OnSignalingError, transcript
entities/words, interruption reason).

## Rust (`rust/rtcserver`)

Correctness:
1. Reconnect supervisor shutdown path (socket.rs ~109-142): the detached task
   holds a `PondClient` clone and never terminates — client and socket survive
   `disconnect()` and last-handle drop for process lifetime. Break the loop
   when `active` flips false and/or store the JoinHandle and abort on Drop.
   Add a test that the supervisor terminates.

Deletions:
2. `RtcSessionDescription` + `RtcIceCandidate` (types.rs ~70-82): dead.
3. `RawSocketClient::params()` + backing field (socket.rs ~103, ~19):
   `#[allow(dead_code)]`, never read.
4. `socket_params()` accessor + field on the client (client.rs ~197, ~41):
   test the wire-observable behavior instead; drop field + accessor.
5. `base_session_id` payload-preference branch (session.rs ~663): the server
   never puts session_id in these payloads; keep only the fallback.

Do NOT delete `on_session_attached` (adjudication note above — it is live).

Completeness: cross-SDK items above.

Versioning: 0.3.0 stays (crates.io versions do not go backward). The
divergence is bookkeeping, not API; future sync releases either keep Rust on
its own line or move the others to the same minor — owner's call at next
release, no action this round.

## Elixir (`elixir/vox_rtc_server`)

Correctness:
1. Re-vendor `priv/proto/vox.proto` from vox main (the server reserved field 4
   `stable_speaking_min_ms` in `ConversationTurnPolicy`), regenerate the
   vendored `vox.pb.ex`, and remove the field from the public
   `VoxRtcServer.TurnPolicy` struct (types.ex ~58). A knob the server silently
   drops must not be advertised.
2. `track_response_completion` (session.ex ~458): clear the ambient
   `response_generation_id` on terminal `error` events (e.g.
   `response_failed`), not only on done/cancelled. Test: after a failed
   response, a bare `append_response_text` with default options mints/uses a
   fresh generation rather than re-stamping the dead one.
3. `browser_events` (client.ex ~56): stop defaulting to `false` (which encodes
   presence and actively disables forwarding). Omit the field unless the
   caller sets it, so the server default applies.

Deletions:
4. `VoxRtcServer` facade delegates (vox_rtc_server.ex ~12-20): unreferenced;
   keep the module + moduledoc, drop the three delegates.
5. Client redundant teardown: drop `terminate/2`'s close loop; the owner
   monitor already closes sessions on Client death (test-pinned). Keep the
   synchronous graceful path in `handle_call(:close)` with its
   "client_closed" reason.
6. `generation_id` dual uniqueness (session.ex ~404): `unique_integer`
   alone; drop the per-session counter.

SDK_SYNC round-1 items do not apply (gRPC transport); no reconnection
machinery is added.

## Green bars

- TypeScript: each package's `npm test` (or the repo's test runner) clean.
- Python: `uv run pytest && uv run ruff check . && uv run mypy` clean.
- Go: `go build ./... && go vet ./... && go test ./...` clean.
- Rust: `cargo build && cargo test` clean (plus `cargo clippy` if the repo
  already uses it).
- Elixir: `mix compile --warnings-as-errors && mix test` clean.

No commits in this round until verification passes and the owner reviews.
