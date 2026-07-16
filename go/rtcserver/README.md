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
	log.Printf("user said: %s", event.Transcript)
})
session.Configure(rtcserver.SessionConfig{
	STTModel: "parakeet-stt:tdt-0.6b-v3",
	TTSModel: "kokoro-tts:v1.0",
	Voice: "af_heart",
	TurnProfile: "browser_default",
})
log.Printf("session: %s", bootstrap.SessionID)
```
