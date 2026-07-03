# Vox RTC SDK fixes — shared spec

All four server SDKs (go/python/rust/typescript) must implement these identically,
following each SDK's existing typed-handler / config conventions. Verified against
the Vox server (source of truth) and the existing SDK event vocabulary.

## 1. Add 4 missing inbound event handlers (all SDKs)

Vox emits these control events but the server SDKs have no typed handler (they only
reach the generic `onEvent`/`on_event` catch-all today). Add a typed handler +
event constant + typed event struct for each, matching the existing pattern (e.g.
`onTranscript` / `on_turn_state_changed`). Every typed event also carries the
existing common fields (`session_id`, `channel_name`, raw `data`).

| Handler name (follow per-lang casing) | Wire type string | Payload fields |
|---|---|---|
| `onSpeechStarted` | `input_audio_buffer.speech_started` | `timestamp_ms` (number) |
| `onSpeechStopped` | `input_audio_buffer.speech_stopped` | `timestamp_ms` (number) |
| `onTranscriptDelta` | `conversation.item.input_audio_transcription.delta` | `delta` (string), `start_ms` (number), `end_ms` (number) |
| `onTurnEouPredicted` | `turn.eou.predicted` | `probability`, `threshold`, `delay_ms`, `start_ms`, `end_ms` (numbers); `decision`, `action`, `turn_detector` (strings) |

Naming per language: TS `onSpeechStarted/onSpeechStopped/onTranscriptDelta/onTurnEouPredicted`;
Python `on_speech_started/on_speech_stopped/on_transcript_delta/on_turn_eou_predicted`;
Go `OnSpeechStarted/OnSpeechStopped/OnTranscriptDelta/OnTurnEouPredicted`;
Rust `on_speech_started/on_speech_stopped/on_transcript_delta/on_turn_eou_predicted`.
Add a test per SDK asserting each new handler fires with the right typed fields.

## 2. Reconnection (all SDKs)

The underlying PondSocket client owns socket-level reconnection with a
`maxReconnectDelay`/`max_reconnect_delay` backoff. Requirements:
- Forward the SDK's configured reconnect-delay (and connection timeout) to the pond
  client options. TS and Python already do; **Go and Rust currently do NOT** (Rust
  hardcodes a 10s connection timeout and ignores both; Go never forwards
  MaxReconnectDelay). Fix them to forward the configured values.
- Ensure the control channel is **re-joined after a socket reconnect** — a
  socket-level reconnect does not by itself restore the channel subscription. Read
  the published pond client at /Users/royossai/PycharmProjects/pondsocket to see
  whether channels auto-rejoin; if they do not, add re-join-on-reconnect in the SDK.
- Wire the pond client's connection-change / error callbacks through so reconnection
  is observable (Python/Go declare these but don't wire them).
- If full re-join-on-reconnect is not achievable without pond-client changes, say so
  explicitly rather than faking it.

## 3. Per-SDK cleanups

- **Rust**: `send_message`/`join`/`leave` must return real errors instead of always
  `Ok(())`; a `broadcast` `Lagged` must NOT terminate the handler loop (skip/continue,
  don't return Err); `new()` must not panic on a bad URL (return Result or validate);
  distinguish `NotConnected`/`ChannelClosed` in error mapping instead of collapsing.
  Add real tests (crate currently has ~2).
- **Python**: add `[tool.pytest.ini_options]` with `pythonpath = ["src"]` so
  `uv run pytest` works on a clean checkout. Bump `pondsocket-client` `==0.0.3` →
  `==0.0.5`. Guard `connection_state` against socket states outside its 3-value enum.
- **TypeScript**: bump `@eleven-am/pondsocket-client` `^0.0.36` → `^0.0.38`.
- **Go**: fix the `channelStateDeclined` mapping gap (join-declined detection must not
  rely on a raw string coincidence). Go's pondsocket-client module is unchanged
  (`v0.2.3`), no version bump.

## Green bars
- Go: `go build ./... && go vet ./... && go test ./...`
- Rust: `cargo build && cargo test && cargo clippy`
- Python: `uv run pytest && uv run ruff check . && uv run mypy` (from python/vox-rtc-server)
- TS: `npm run build && npm test` (in each of vox-rtc-server, vox-rtc-client)
