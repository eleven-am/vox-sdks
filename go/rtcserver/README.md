# `github.com/eleven-am/vox-sdks/go/rtcserver`

Trusted Go SDK for Vox-hosted WebRTC conversations. It creates sessions over
HTTP and controls them over PondSocket.

## Browser signaling gateway

Mount one same-origin WebSocket handler in the application server. The browser
never receives the Vox URL, API key, or an attach token. Authentication and
application session ownership stay in the application hook.

```go
gateway := rtcserver.NewGateway(rtcserver.GatewayOptions{
	VoxHTTPBase: "http://vox-service.vox.svc.cluster.local:11435",
	APIKey:      os.Getenv("VOX_API_KEY"),
	Path:        "/api/vox/rtc",
	OnSessionCreated: func(ctx rtcserver.GatewaySessionContext) error {
		// Validate ctx.Request with the application's existing auth system.
		// Configure and retain ctx.Session as the complete control object.
		ctx.Session.Configure(rtcserver.SessionConfig{
			STTModel:    "parakeet-stt:tdt-0.6b-v3",
			TTSModel:    "kokoro-tts:v1.0",
			Voice:       "af_heart",
			TurnProfile: "browser_default",
		})
		return nil
	},
})

http.Handle("/api/vox/rtc", gateway)
defer gateway.Close("application_shutdown")
```

The browser uses the matching TypeScript client:

```ts
const client = new VoxRtcBrowserClient({
  signalingEndpoint: "/api/vox/rtc",
  audioElement,
});
await client.connect();
```

## PondSocket session

```go
client := rtcserver.NewClient(rtcserver.ClientOptions{
	HTTPBase: "http://vox-service.vox.svc.cluster.local:11435",
	APIKey: os.Getenv("VOX_API_KEY"),
})
bootstrap, session, err := client.CreateControlledSession(context.Background())
if err != nil { log.Fatal(err) }

session.OnTranscript(func(event rtcserver.TranscriptEvent) {
	log.Printf("user said: %s context=%v", event.Transcript, event.SpeechContext)
})
speechContext := true
session.Configure(rtcserver.SessionConfig{
	STTModel: "parakeet-stt:tdt-0.6b-v3",
	TTSModel: "kokoro-tts:v1.0",
	Voice: "af_heart",
	TurnProfile: "browser_default",
	SpeechContext: &speechContext,
})
log.Printf("session: %s", bootstrap.SessionID)
```

## Response generations and start acknowledgement

Response senders accept an optional caller-chosen generation ID through
`ResponseOptions.GenerationID` (sent on the wire as `generation_id`). When
omitted, `StartResponse` generates one and threads it through
`AppendResponseText`, `CommitResponse`, and `CancelResponse`. Response
lifecycle events (`response.created`, `response.committed`, `response.done`,
`response.cancelled`, `response.audio.clear`, `interruption.*`) expose the
correlated `GenerationID` when the server knows it.

Instead of fire-and-forget, gate delta pumping on the start acknowledgement:

```go
ack, err := session.StartResponseAndWait(ctx, nil)
if err != nil { return err }
if !ack.Accepted {
	log.Printf("start rejected: %s (%s)", ack.Error.Code, ack.Error.Message)
	return nil
}
session.AppendResponseText("Hello.", &rtcserver.ResponseOptions{GenerationID: ack.GenerationID})
session.CommitResponse()
```

`StartResponseAndWait` resolves with the correlated `response.created`
(`Accepted: true`, plus `ResponseID`) or the correlated typed `error`
(`Accepted: false`, plus `Error`), and fails only when `ctx` expires first.

## Error handling

`OnError` delivers typed errors with a stable `Code`, a `Recoverable` flag,
and an optional `GenerationID` scoping the failure to one response generation.
Only `Recoverable == false` (or the transport connection closing) should end
the call. Every other error — including all `ErrorCodeResponseRejected*`,
`ErrorCodeResponseStaleGeneration`, `ErrorCodeResponseAlreadyActive`,
`ErrorCodeResponseFailed`, and `ErrorCodeCommandInvalid` — is a per-command
failure: handle it and keep the session running. Old Vox servers omit `code`
and `recoverable`; the SDK defaults `Recoverable` to `true` in that case, so
treat those errors as recoverable unless the connection itself closed.

```go
session.OnError(func(event rtcserver.ErrorEvent) {
	if !event.Recoverable {
		session.Close()
		return
	}
	if event.GenerationID != "" {
		log.Printf("generation %s failed: %s", event.GenerationID, event.Code)
	}
})
```

`OnSignalingError` delivers the control channel's `rtc.signaling_error`
(`Message`, optional `Generation`). It reports a failure in the WebRTC
signaling handshake itself. The event is terminal: the server closes the
session immediately after emitting it, so end the call.

```go
session.OnSignalingError(func(event rtcserver.SignalingErrorEvent) {
	log.Printf("RTC signaling failed: %s", event.Message)
	session.Close()
})
```

## Transcript details

`OnTranscript` exposes the recognised `Entities`
(`Type`, `Text`, `StartChar`, `EndChar`) and word timings `Words`
(`Word`, `StartMS`, `EndMS`, optional `Confidence`) alongside the transcript
text. Both interruption callbacks (`OnInterruptionDetected`,
`OnInterruptionFalsePositive`) carry the server's `Reason` slug.

`SpeechContext` is populated only on final transcript events when the session
configuration explicitly enables it. Schema v2 exposes typed `Emotions` and
`Vocal` speaker spans plus environmental `Sounds`; every sound has a `Score`
from 0 to 1.

```go
session.OnTranscript(func(event rtcserver.TranscriptEvent) {
	if event.SpeechContext == nil {
		return
	}
	for _, emotion := range event.SpeechContext.Emotions {
		log.Printf("emotion=%s start=%d end=%d", emotion.Label, emotion.StartMS, emotion.EndMS)
	}
	for _, sound := range event.SpeechContext.Sounds {
		log.Printf("sound=%s score=%.3f", sound.Label, sound.Score)
	}
	if event.SpeechContext.Status != rtcserver.SpeechContextComplete {
		log.Printf("unavailable=%v", event.SpeechContext.Unavailable)
	}
})
```

`SpeechContextPartial` identifies the unavailable
`SpeechContextSpeaker` or `SpeechContextSounds` track;
`SpeechContextFailed` identifies both. Unsupported or malformed context is
decoded as `nil` without dropping the transcript event. The pointer session
configuration preserves the difference between omitted and explicitly
disabled.
