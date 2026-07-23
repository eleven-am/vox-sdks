# Vox RTC Server for Elixir

`vox_rtc_server` lets a trusted Elixir service create and control Vox-hosted
WebRTC conversations over Vox's native gRPC API.

Vox remains responsible for WebRTC media, VAD, end-of-utterance detection,
turn state, interruption handling, STT, TTS, and audio playout. The SDK owns
only the gRPC connection and one ordered bidirectional control stream per RTC
session.

This package does not use PondSocket and does not implement application-user
authentication. Your application keeps its existing Plug, Phoenix, session,
cookie, or JWT boundary. The `api_key` option is only the trusted credential
used by the application server when calling Vox.

## Installation

Add the package to `mix.exs`:

```elixir
def deps do
  [
    {:vox_rtc_server, "~> 0.2.2"}
  ]
end
```

## Supervision

Start one client for each Vox deployment:

```elixir
children = [
  {VoxRtcServer.Client,
   name: MyApp.Vox,
   target: "dns://vox-service.vox.svc.cluster.local:9090",
   api_key: System.fetch_env!("VOX_API_KEY")}
]

Supervisor.start_link(children, strategy: :one_for_one)
```

The target is the gRPC endpoint, not Vox's HTTP port. Omit `api_key` only when
the Vox deployment does not require API authentication. Supply gRPC connection
options through `connect_options`, including a `GRPC.Credential` for TLS. The
SDK uses gRPC's Mint adapter by default; pass an explicit `:adapter` only when
your application deliberately uses another supported transport.

## Controlled RTC session

Create a session from trusted server code:

```elixir
alias VoxRtcServer.{Client, Session, SessionConfig}

{:ok, bootstrap, session} =
  Client.create_controlled_session(MyApp.Vox)

:ok =
  Session.configure(session, %SessionConfig{
    stt_model: "parakeet-stt:tdt-0.6b-v3",
    tts_model: "kokoro-tts:v1.0",
    voice: "af_heart",
    turn_profile: "browser_default",
    speech_context: true
  })
```

`bootstrap` contains the session id, expiry, attach TTL, and public ICE server
configuration. Return only the fields your browser signaling route needs. Do
not return the Vox API key or gRPC endpoint to the browser.

The caller is subscribed automatically. Incoming events arrive as ordinary
Elixir messages:

```elixir
receive do
  {:vox_rtc, ^session, %VoxRtcServer.Event{type: :transcript_completed} = event} ->
    transcript = event.payload.transcript
    speech_context = event.payload.speech_context
end
```

Speech context is opt-in and final-only. The value is Vox's versioned prosody
and audio-event result decoded from `google.protobuf.Struct` into
`VoxRtcServer.SpeechContext`.

Schema v2 exposes timestamped `emotions` and `vocal` speaker spans plus
environmental `sounds`. Sound spans also contain a model `score` from 0 to 1:

```elixir
case event.payload.speech_context do
  %VoxRtcServer.SpeechContext{} = context ->
    Enum.each(context.emotions || [], fn span ->
      IO.inspect({:emotion, span.label, span.start_ms, span.end_ms})
    end)

    Enum.each(context.sounds || [], fn sound ->
      IO.inspect({:sound, sound.label, sound.score})
    end)

  nil ->
    :ok
end
```

A `:partial` result identifies the unavailable `:speaker` or `:sounds` track;
a `:failed` result identifies both. Unsupported or malformed context is
decoded as `nil` without dropping the transcript event.

An application can explicitly manage subscriptions:

```elixir
:ok = Session.subscribe(session, self())
:ok = Session.unsubscribe(session, self())
```

## Full-trickle signaling

Forward the browser's offer and ICE candidates as they arrive. Candidate
completion is an explicit `:complete` message; the SDK does not implement
half-trickle or wait for ICE gathering to finish.

```elixir
alias VoxRtcServer.{IceCandidate, Session, SessionDescription}

:ok =
  Session.send_offer(
    session,
    %SessionDescription{type: "offer", sdp: browser_offer_sdp}
  )

:ok =
  Session.send_ice_candidate(session, %IceCandidate{
    candidate: candidate,
    sdp_mid: sdp_mid,
    sdp_m_line_index: sdp_m_line_index,
    username_fragment: username_fragment
  })

:ok = Session.send_ice_candidate(session, :complete)
```

Vox answers through `:answer`, `:ice_candidate`, and
`:ice_candidates_complete` events. Your application forwards those signaling
messages to its browser connection. Media then flows directly between the
browser and Vox; it does not pass through the Elixir application.

## Streaming a response

Text can be appended incrementally as an LLM generates it:

```elixir
alias VoxRtcServer.{ResponseOptions, Session}

options = %ResponseOptions{allow_interruptions: true}

case Session.start_response_and_wait(session, options, 5_000) do
  {:ok, ack} ->
    response = %ResponseOptions{
      allow_interruptions: true,
      generation_id: ack.generation_id
    }

    :ok = Session.append_response_text(session, "The first generated phrase", response)
    :ok = Session.append_response_text(session, " and the next phrase.", response)
    :ok = Session.commit_response(session, response)

  {:error, %VoxRtcServer.ErrorEvent{} = error} ->
    Logger.warning("Vox rejected response start", code: error.code)
end
```

`start_response_and_wait/3` generates a `generation_id` when one is not
provided, sends `response.start`, and waits for the matching
`response.created` acknowledgement. A correlated rejection, acknowledgement
timeout, or control-stream failure returns `{:error, %VoxRtcServer.ErrorEvent{}}`.
An event from a stale generation cannot resolve the wait.

The session automatically carries the active generation through subsequent
delta, commit, and cancel commands, so passing the returned id explicitly is
optional. Passing it explicitly is useful when application work is concurrent
because Vox can reject stale work without affecting the current response.

`Session.start_response/2` remains available for fire-and-forget control. Use
`cancel_response/2` to cancel an active response and
`replace_response_text/3` when the complete text must replace the current
buffer.

## Typed errors

Signaling and conversation failures arrive as `:error` events whose payload is
`%VoxRtcServer.ErrorEvent{}`. It contains `message`, stable `code`,
`recoverable`, and an optional `generation_id`. Known server error codes are
available through `VoxRtcServer.ErrorEvent.known_codes/0` and
`known_code?/1`.

Only a non-recoverable error or closed control stream should end the call.
Recoverable errors belong to the command or response generation named by the
event and do not invalidate the RTC session.

## Lifecycle

The session process:

- sends `attach` as the first control-stream message;
- serializes all signaling and response writes on that stream;
- monitors its owning client and subscribers;
- cancels failed streams;
- closes its stream when the owner or caller closes;
- never restarts a completed session.

Call `Session.close/2` when an application call ends and `Client.close/1` during
an intentional client shutdown. Supervision shutdown also closes owned
sessions and the gRPC channel.

## Contract source

Generated protobuf and gRPC modules live under `lib/generated`. They are
generated from `priv/proto/vox.proto`, copied from Vox's canonical
`proto/vox.proto`. The public SDK wraps those generated modules so application
code does not have to construct control-stream envelopes directly.
