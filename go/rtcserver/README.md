# `github.com/eleven-am/vox-sdks/go/rtcserver`

Server-side Go SDK for Vox-hosted WebRTC sessions.

This package is for backend services that need to:

- create RTC sessions over HTTP
- attach to `/v1/socket`
- join `/rtc/{session_id}`
- send `session.update`, `response.*`, and server-to-browser `client.event`
- observe RTC control events

It is intentionally narrow. It is not the general STT/TTS/text SDK.

## Example

```go
package main

import (
	"context"
	"log"
	"os"
	"time"

	"github.com/eleven-am/vox-sdks/go/rtcserver"
)

func main() {
	client := rtcserver.NewClient(rtcserver.ClientOptions{
		HTTPBase:   "https://vox.example.com",
		APIKey:     os.Getenv("VOX_API_KEY"),
		JoinTimeout: 10 * time.Second,
	})

	ctx := context.Background()

	bootstrap, session, err := client.CreateControlledSession(ctx)
	if err != nil {
		log.Fatal(err)
	}

	log.Printf("session: %s", bootstrap.SessionID)

	session.OnTranscript(func(event rtcserver.TranscriptEvent) {
		log.Printf("user said: %s", event.Transcript)
	})

	session.OnBrowserEvent(func(event rtcserver.BrowserEvent) {
		log.Printf("browser event: %s %#v", event.Event, event.Payload)
	})

	session.OnClose(func(event rtcserver.CloseEvent) {
		log.Printf("browser disconnected: %s", event.Reason)
	})

	session.Configure(rtcserver.SessionConfig{
		STTModel:     "parakeet-stt-onnx:tdt-0.6b-v3",
		TTSModel:     "kokoro-tts-onnx:v1.0",
		Voice:        "af_heart",
		TurnProfile:  "browser_default",
		VADBackend:   "silero",
		TurnDetector: "livekit",
	})

	session.SendTextResponse("Hello from Go.", nil, true)
	session.SendClientEvent(rtcserver.ClientEvent{
		Event:   "render.url",
		Payload: map[string]interface{}{"url": "https://example.com"},
	})
}
```

If `APIKey` is omitted, the client falls back to `VOX_API_KEY`.
`SendClientEvent` is server to browser. Browser-originated app events arrive through `OnBrowserEvent`.

Pass `rtcserver.SessionOptions{JoinTimeout: ...}` to `AttachSession` or
`CreateControlledSession` to override the client default for one session.
