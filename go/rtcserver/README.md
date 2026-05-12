# `github.com/eleven-am/vox-sdks/go/rtcserver`

Server-side Go SDK for Vox-hosted WebRTC sessions.

This package is for backend services that need to:

- create RTC sessions over HTTP
- attach to `/v1/socket`
- join `/rtc/{session_id}`
- send `session.update`, `response.*`, and `client.event`
- observe RTC control events

It is intentionally narrow. It is not the general STT/TTS/text SDK.

## Example

```go
package main

import (
	"context"
	"log"

	"github.com/eleven-am/vox-sdks/go/rtcserver"
)

func main() {
	client := rtcserver.NewClient(rtcserver.ClientOptions{
		HTTPBase: "https://vox.example.com",
	})

	ctx := context.Background()

	bootstrap, session, err := client.CreateControlledSession(ctx)
	if err != nil {
		log.Fatal(err)
	}

	log.Printf("session: %s", bootstrap.SessionID)

	session.OnEvent(func(event rtcserver.WireEvent) {
		log.Printf("%s %#v", event.Type, event.Data)
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
}
```
