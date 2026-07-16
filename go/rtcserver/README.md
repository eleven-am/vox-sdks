# `github.com/eleven-am/vox-sdks/go/rtcserver`

Trusted Go SDK for Vox-hosted WebRTC conversations. It creates sessions over
HTTP and controls them over PondSocket.

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
