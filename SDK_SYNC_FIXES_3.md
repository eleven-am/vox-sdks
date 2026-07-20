# Vox RTC SDK fixes, round 3 — verified external-review findings

Source: external review of the round-2 tree, every finding verified against
source before acceptance (2026-07-20). Seven findings confirmed; one proposed
fix (a scheduler trim reservation) rejected with named reasons — see the vox
SIMPLIFICATION.md record. This round BLOCKS SDK publication and vox v0.2.111.

Touched here: TypeScript, Go, Rust, and vox itself. Python and Elixir are
untouched this round.

## The generation contract (cross-repo, one fact one owner)

Verified defect: vox emits ICE candidates with no negotiation generation
(`local_candidate_events`, src/vox/server/rtc_ice.py), while both gateways
stamp their OWN current counter onto forwarded candidates. A candidate queued
by the pre-restart peer that arrives after an ICE restart gets relabelled as
the new generation, defeating the browser's stale-candidate filter. The
gateway counters are a mirror of a fact vox owns the truth of.

The corrected contract — the browser owns the counter, vox echoes it,
gateways forward verbatim:

- Browser → gateway `rtc.offer` data: `{offer: {type, sdp}, restart?: bool,
  generation: number}` (the browser's existing negotiation counter).
- Gateway → vox: the `rtc.offer` command payload carries `generation` through
  unchanged.
- Vox: stores the latest offer's generation on the RTC session; stamps
  `generation` on every subsequent `rtc.answer`, `rtc.ice_candidate`, and
  `rtc.signaling_error` it emits for that session, until the next offer.
  Absent generation on an inbound offer → no stamping (tolerant).
- Gateways: DELETE their own negotiation counters and stamping; forward
  vox's `generation` verbatim on answer/candidate/error events.
- Browser client: filtering logic unchanged (compares against its own
  current counter) — it now filters against a truthful label.

gRPC asymmetry, recorded: the gRPC RTC control path has no browser gateway
consumer, so generation echo is implemented on the PondSocket/JSON path only.
The proto is not extended this round.

## Offer-error correlation (TS + Go gateways)

Verified defect: while an offer is pending, both gateways attach the pending
offer id to ANY `error` event and clear the pending offer — but `error` is
the CONVERSATION error wire type; vox emits genuine signaling failures as
`rtc.signaling_error` (verified at the setLocalDescription failure path,
src/vox/server/rtc_signaling.py). So an unrelated conversation error (e.g.
response_stale_generation during a restart) falsely rejects the browser's
offer, while a real signaling failure is never correlated.

Fix in both gateways: correlate the pending offer to `rtc.answer` and
`rtc.signaling_error` only. Conversation `error` events forward to the
browser uncorrelated, and do not clear the pending offer. Tests: an
unrelated `error` during a pending offer does not reject it; a
`rtc.signaling_error` does.

## TypeScript

1. Generation contract (client + gateway sides, above), including deleting
   the gateway's counter and stamp.
2. Offer-error correlation (above).
3. Ducking sustained tier — OWNER DECIDED 2026-07-20: deleted. Verified
   defect: `sustainedAfterMs` has no timer; the duck→sustained transition
   fires only if another ducking event arrives after the threshold, so the
   tier half-works at best. Delete `sustainedVolume` + `sustainedAfterMs`
   (types, implementation, docs, tests); keep `duckVolume` +
   `releaseDelayMs`, which the vox path genuinely consumes. (Alternative
   considered and declined: adding a transition timer — an embellishment
   nobody asked for.)

## Go

1. Generation contract (gateway side, above), including deleting the
   gateway's counter and stamp.
2. Offer-error correlation (above).
3. Verified defect: `serveConnection` invokes the `OnSessionCreated` hook
   BEFORE subscribing `control.OnEvent(session.forwardEvent)`, so events
   emitted while the hook runs (configure errors, closure, response events)
   are lost to the browser; TS subscribes first. Fix: subscribe before the
   hook; unsubscribe on hook failure (preserve the rollback behavior). Test:
   an event emitted during the hook reaches the browser socket.

## Rust

1. Verified regression from round 2: `ensure_supervisor` treats any `Some`
   slot as an active supervisor, but a finished `JoinHandle` stays in the
   slot after `disconnect()` — so `disconnect()` → `connect()` leaves every
   later connection drop unsupervised (no reconnection). Fix: replace
   finished handles (check `is_finished()`), keeping single-spawn for a live
   one. Test: disconnect → connect → verify a supervisor is live again
   (handle present and not finished; or drop the connection and observe
   reconnection behavior through the fake).

## vox (implemented in the vox repo, recorded here for the contract)

1. Generation echo (server side of the contract above).
2. PDEATHSIG gap: workers load their model in `main()` BEFORE `worker_main`
   installs the parent-death signal — a parent crash during a minutes-long
   load orphans a GPU process. Fix: install at each worker's entry point
   (nemo_worker, voxtral_tts_worker) before loading; after installing, exit
   if `os.getppid() == 1` (parent died before the signal was armed — the
   signal only fires on future deaths).
3. Trim `trimmed=True` stamp: only when the entry is still the same object
   AND `ref_count == 0`, so a mid-trim acquire's flag reset is never
   overwritten (was: one skipped idle-trim cycle). The trim concurrency
   contract ("trim may run concurrently with request paths; implementations
   must be safe under it") is recorded as an adapter contract in
   SIMPLIFICATION.md. The reviewer's proposed scheduler-owned trim
   reservation remains REJECTED: in-process trim racing a request is
   synchronize-latency, not corruption; worker trims serialize behind the
   WorkerHost request lock; a reservation would block new requests behind a
   30s trim.

## Green bars

Unchanged from round 2 per SDK; vox: full suite + ruff + scheduler/worker
subsets x3. No commits until verification passes and the owner reviews.

## Round-3 follow-up — verified external-review findings (2026-07-20)

Five findings against the round-3 tree, each verified in source before
acceptance. The first two are clean-install/runtime blockers in vox.

1. vox: `negotiation_generation` is stored AFTER `exchange_server_rtc_offer`
   returns, but the exchange itself starts candidate gathering — so
   first-offer candidates enqueue unstamped and restart candidates enqueue
   with the previous generation, and the browser correctly discards genuine
   candidates. Fix: store the generation after restart cleanup but BEFORE
   the exchange; test an event emitted from inside the exchange.
2. vox: the worker orphan guard `getppid() == 1` kills every legitimate
   worker in the shipped container — the entrypoint `exec`s vox, making vox
   PID 1, so worker children legitimately report PPID 1. Fix: WorkerHost
   passes its own PID via env (`VOX_WORKER_PARENT_PID`); the child, after
   arming PDEATHSIG, exits only when `getppid()` differs from that expected
   PID. (This supersedes the ppid==1 shortcut, which was a spec
   simplification error — the reviewer's original "verify expected parent
   PID" was correct.)
3. Rust: immediate disconnect→connect race — a supervisor that observed
   `active=false` but is not yet `is_finished` survives `ensure_supervisor`'s
   check and then exits, leaving no supervisor. Fix: `disconnect()` takes
   the handle out of the slot and aborts it, so post-disconnect the slot is
   empty and connect always spawns fresh. Test immediate disconnect/connect
   without waiting for termination.
4. Go: subscribe-before-hook (correct) opened a registration hole — a
   terminal event during `OnSessionCreated` closes the session, then the
   registration block unconditionally inserts the closed session into
   `active` (leaked entry, silent no-op sends). Fix: registration checks
   the session's closed state atomically and skips insert; regression test
   with a hook-time `rtc.session.closed`.
5. All four PondSocket SDKs: the typed signaling-error event was specced
   from the PROTO instead of the WIRE (a round-2 spec error, corrected
   here). Vox actually emits `{message, generation: number}` and then
   closes the session — the event is terminal. The SDKs parse fabricated
   `code`/`generation_id`(string)/`recoverable`-default-TRUE fields, telling
   callers a terminal failure is recoverable. Fix in TS/Python/Go/Rust:
   the signaling-error event type is `{message, generation?: number}` (per
   language conventions), no code, no recoverable, documented terminal;
   tests use server-shaped payloads only. The round-2 "cross-SDK items"
   signaling-error field list is superseded by this.
