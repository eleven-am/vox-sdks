package rtcserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	pondsocket "github.com/eleven-am/pondsocket/go/pondsocket-client"
	"github.com/gorilla/websocket"
)

type fakeChannel struct {
	mu            sync.Mutex
	sent          []sentMessage
	stateHandlers []func(channelState)
	msgHandlers   []func(string, map[string]interface{})
}

type sentMessage struct {
	event   string
	payload map[string]interface{}
}

func (f *fakeChannel) Join() {
	for _, handler := range f.stateHandlers {
		handler(channelStateJoined)
	}
}

func (f *fakeChannel) Leave() {}

func (f *fakeChannel) SendMessage(event string, payload map[string]interface{}) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, sentMessage{event: event, payload: payload})
}

func (f *fakeChannel) OnMessage(callback func(event string, payload map[string]interface{})) func() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.msgHandlers = append(f.msgHandlers, callback)
	return func() {}
}

func (f *fakeChannel) OnChannelStateChange(callback func(state channelState)) func() {
	f.stateHandlers = append(f.stateHandlers, callback)
	return func() {}
}

func (f *fakeChannel) emit(event string, payload map[string]interface{}) {
	f.mu.Lock()
	handlers := append([]func(string, map[string]interface{}){}, f.msgHandlers...)
	f.mu.Unlock()
	for _, handler := range handlers {
		handler(event, payload)
	}
}

func (f *fakeChannel) sentMessages() []sentMessage {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]sentMessage(nil), f.sent...)
}

type fakeSocket struct {
	connected    bool
	channel      *fakeChannel
	connHandlers []func(bool)
}

func (f *fakeSocket) Connect() error {
	f.connected = true
	for _, handler := range f.connHandlers {
		handler(true)
	}
	return nil
}

func (f *fakeSocket) Disconnect() error {
	f.connected = false
	for _, handler := range f.connHandlers {
		handler(false)
	}
	return nil
}

func (f *fakeSocket) GetState() bool { return f.connected }

func (f *fakeSocket) CreateChannel(name string, params map[string]interface{}) socketChannel {
	if name != "/rtc/rtc_123" {
		panic("unexpected channel: " + name)
	}
	return f.channel
}

func (f *fakeSocket) OnConnectionChange(callback func(connected bool)) func() {
	f.connHandlers = append(f.connHandlers, callback)
	return func() {}
}

func TestCreateSession(t *testing.T) {
	t.Setenv("VOX_API_KEY", "secret")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/rtc/sessions" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer secret" {
			t.Fatalf("unexpected authorization header: %q", got)
		}
		_ = json.NewEncoder(w).Encode(SessionBootstrap{
			SessionID:        "rtc_123",
			ExpiresAt:        "2026-01-01T00:00:00Z",
			AttachTTLSeconds: 120,
			ICEServers:       []RTCIceServer{{URLs: []string{"stun:turn.example.com:3478"}}},
		})
	}))
	defer server.Close()

	client := NewClient(ClientOptions{HTTPBase: server.URL})
	bootstrap, err := client.CreateSession(context.Background())
	if err != nil {
		t.Fatalf("CreateSession returned error: %v", err)
	}
	if bootstrap.SessionID != "rtc_123" {
		t.Fatalf("unexpected session id: %s", bootstrap.SessionID)
	}
}

func TestAttachSessionAndSendMessages(t *testing.T) {
	fake := &fakeSocket{channel: &fakeChannel{}}
	client := NewClient(ClientOptions{
		HTTPBase:          "https://vox.example.com",
		APIKey:            "secret",
		ConnectionTimeout: 500 * time.Millisecond,
		JoinTimeout:       750 * time.Millisecond,
	})
	client.socketFactory = func(endpoint string, params map[string]interface{}, reconnectInterval time.Duration) (socketClient, error) {
		if params["api_key"] != "secret" {
			t.Fatalf("unexpected socket api_key: %#v", params["api_key"])
		}
		if reconnectInterval != 0 {
			t.Fatalf("unexpected reconnect interval: %s", reconnectInterval)
		}
		return fake, nil
	}

	session, err := client.AttachSession(
		context.Background(),
		"rtc_123",
		SessionOptions{JoinTimeout: 250 * time.Millisecond},
	)
	if err != nil {
		t.Fatalf("AttachSession returned error: %v", err)
	}
	if session.joinTimeout != 250*time.Millisecond {
		t.Fatalf("unexpected join timeout: %s", session.joinTimeout)
	}

	speechContext := true
	session.Configure(SessionConfig{
		STTModel:      "stt",
		TTSModel:      "tts",
		Voice:         "voice",
		TurnProfile:   "browser_default",
		VADBackend:    "silero",
		TurnDetector:  "livekit",
		SpeechContext: &speechContext,
	})
	session.SendTextResponse("hello", nil, true)
	session.SendClientEvent(ClientEvent{Event: "render.url", Payload: map[string]interface{}{"url": "https://example.com"}})

	if len(fake.channel.sent) != 3 {
		t.Fatalf("unexpected message count: %d", len(fake.channel.sent))
	}
	if fake.channel.sent[0].event != "session.update" {
		t.Fatalf("unexpected first event: %s", fake.channel.sent[0].event)
	}
	sessionPayload, ok := fake.channel.sent[0].payload["session"].(map[string]interface{})
	if !ok || sessionPayload["speech_context"] != true {
		t.Fatalf("unexpected session payload: %#v", fake.channel.sent[0].payload)
	}
	if fake.channel.sent[1].event != "response.replace_text" {
		t.Fatalf("unexpected response event: %s", fake.channel.sent[1].event)
	}
	if fake.channel.sent[2].event != "client.event" {
		t.Fatalf("unexpected final event: %s", fake.channel.sent[2].event)
	}
	if fake.channel.sent[1].payload["text"] != "hello" {
		t.Fatalf("unexpected response text: %v", fake.channel.sent[1].payload["text"])
	}
}

func TestStreamingResponseCommandsShareGenerationID(t *testing.T) {
	fake := &fakeSocket{channel: &fakeChannel{}}
	client := NewClient(ClientOptions{HTTPBase: "https://vox.example.com"})
	client.socketFactory = func(string, map[string]interface{}, time.Duration) (socketClient, error) {
		return fake, nil
	}

	session, err := client.AttachSession(context.Background(), "rtc_123")
	if err != nil {
		t.Fatalf("AttachSession returned error: %v", err)
	}
	session.StartResponse(nil)
	session.AppendResponseText("hello", nil)
	session.CommitResponse()

	generationID, ok := fake.channel.sent[0].payload["generation_id"].(string)
	if !ok || generationID == "" {
		t.Fatalf("missing generation id: %#v", fake.channel.sent[0].payload)
	}
	for _, message := range fake.channel.sent[1:] {
		if message.payload["generation_id"] != generationID {
			t.Fatalf("generation id changed: %#v", message.payload)
		}
	}
}

func TestAttachSessionForwardsMaxReconnectDelay(t *testing.T) {
	fake := &fakeSocket{channel: &fakeChannel{}}
	client := NewClient(ClientOptions{
		HTTPBase:          "https://vox.example.com",
		MaxReconnectDelay: 1500 * time.Millisecond,
	})
	client.socketFactory = func(endpoint string, params map[string]interface{}, reconnectInterval time.Duration) (socketClient, error) {
		if reconnectInterval != 1500*time.Millisecond {
			t.Fatalf("unexpected reconnect interval: %s", reconnectInterval)
		}
		return fake, nil
	}

	if _, err := client.AttachSession(context.Background(), "rtc_123"); err != nil {
		t.Fatalf("AttachSession returned error: %v", err)
	}
}

func TestAttachSessionReportsJoinDeclineReason(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade pond connection: %v", err)
			return
		}
		defer connection.Close()
		var join struct {
			Action      string `json:"action"`
			ChannelName string `json:"channelName"`
		}
		if err := connection.ReadJSON(&join); err != nil {
			t.Errorf("read join message: %v", err)
			return
		}
		if join.Action != string(pondsocket.JoinChannel) {
			t.Errorf("expected JOIN_CHANNEL, got %q", join.Action)
			return
		}
		decline := map[string]interface{}{
			"action":      string(pondsocket.System),
			"event":       string(pondsocket.EventNotFound),
			"channelName": join.ChannelName,
			"payload":     map[string]interface{}{"code": 404, "message": "unknown or expired RTC session"},
		}
		if err := connection.WriteJSON(decline); err != nil {
			t.Errorf("write decline frame: %v", err)
			return
		}
		for {
			if _, _, err := connection.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer server.Close()

	client := NewClient(ClientOptions{
		HTTPBase:          "https://vox.example.com",
		SocketBase:        "ws" + strings.TrimPrefix(server.URL, "http"),
		ConnectionTimeout: 2 * time.Second,
		JoinTimeout:       2 * time.Second,
	})
	defer client.Disconnect()

	_, err := client.AttachSession(context.Background(), "rtc_123")
	if err == nil {
		t.Fatal("expected AttachSession to fail")
	}
	if got := err.Error(); got != "RTC channel join failed for /rtc/rtc_123: DECLINED: unknown or expired RTC session" {
		t.Fatalf("unexpected error: %s", got)
	}
}

func TestOnEventIncludesSessionMetadata(t *testing.T) {
	fake := &fakeSocket{channel: &fakeChannel{}}
	client := NewClient(ClientOptions{
		HTTPBase:          "https://vox.example.com",
		ConnectionTimeout: 500 * time.Millisecond,
	})
	client.socketFactory = func(endpoint string, params map[string]interface{}, _ time.Duration) (socketClient, error) {
		return fake, nil
	}

	session, err := client.AttachSession(context.Background(), "rtc_123")
	if err != nil {
		t.Fatalf("AttachSession returned error: %v", err)
	}

	var received WireEvent
	unsubscribe := session.OnEvent(func(event WireEvent) {
		received = event
	})
	fake.channel.emit("turn.state_changed", map[string]interface{}{
		"state":      "speaking",
		"session_id": "rtc_123",
	})
	unsubscribe()

	if received.Type != "turn.state_changed" {
		t.Fatalf("unexpected event type: %s", received.Type)
	}
	if received.SessionID != "rtc_123" {
		t.Fatalf("unexpected session id: %s", received.SessionID)
	}
	if received.ChannelName != "/rtc/rtc_123" {
		t.Fatalf("unexpected channel name: %s", received.ChannelName)
	}
	if received.Data["state"] != "speaking" {
		t.Fatalf("unexpected event data: %#v", received.Data)
	}
}

func TestNamedEventHooks(t *testing.T) {
	fake := &fakeSocket{channel: &fakeChannel{}}
	client := NewClient(ClientOptions{
		HTTPBase:          "https://vox.example.com",
		ConnectionTimeout: 500 * time.Millisecond,
	})
	client.socketFactory = func(endpoint string, params map[string]interface{}, _ time.Duration) (socketClient, error) {
		return fake, nil
	}

	session, err := client.AttachSession(context.Background(), "rtc_123")
	if err != nil {
		t.Fatalf("AttachSession returned error: %v", err)
	}

	var transcript TranscriptEvent
	var turn TurnStateEvent
	var response ResponseEvent
	var browserEvent BrowserEvent
	var closeEvent CloseEvent

	session.OnTranscript(func(event TranscriptEvent) {
		transcript = event
	})
	session.OnTurnStateChanged(func(event TurnStateEvent) {
		turn = event
	})
	session.OnResponseDone(func(event ResponseEvent) {
		response = event
	})
	session.OnBrowserEvent(func(event BrowserEvent) {
		browserEvent = event
	})
	session.OnClose(func(event CloseEvent) {
		closeEvent = event
	})

	fake.channel.emit(EventTranscriptCompleted, map[string]interface{}{
		"transcript":      "hello world",
		"language":        "en",
		"start_ms":        10,
		"end_ms":          20,
		"eou_probability": 0.7,
		"topics":          []interface{}{"hello"},
		"speech_context":  map[string]interface{}{"schema_version": 1, "status": "complete"},
		"session_id":      "rtc_123",
	})
	fake.channel.emit(EventTurnStateChanged, map[string]interface{}{
		"state":          "speaking",
		"previous_state": "idle",
		"session_id":     "rtc_123",
	})
	fake.channel.emit(EventResponseDone, map[string]interface{}{
		"response_id": "resp_1",
		"session_id":  "rtc_123",
	})
	fake.channel.emit(EventBrowserEvent, map[string]interface{}{
		"event":      "ui.select",
		"payload":    map[string]interface{}{"id": "choice-a"},
		"session_id": "rtc_123",
	})
	fake.channel.emit(EventRTCClientDisconnected, map[string]interface{}{
		"reason":               "data_channel_closed",
		"connection_state":     "connected",
		"ice_connection_state": "completed",
		"data_channel_state":   "closed",
		"session_id":           "rtc_123",
	})

	if transcript.Transcript != "hello world" || transcript.Language != "en" {
		t.Fatalf("unexpected transcript event: %#v", transcript)
	}
	if transcript.SessionID != "rtc_123" || transcript.ChannelName != "/rtc/rtc_123" {
		t.Fatalf("unexpected transcript metadata: %#v", transcript)
	}
	if len(transcript.Topics) != 1 || transcript.Topics[0] != "hello" {
		t.Fatalf("unexpected topics: %#v", transcript.Topics)
	}
	if transcript.SpeechContext["status"] != "complete" {
		t.Fatalf("unexpected speech context: %#v", transcript.SpeechContext)
	}
	if turn.State != "speaking" || turn.PreviousState != "idle" {
		t.Fatalf("unexpected turn event: %#v", turn)
	}
	if response.ResponseID != "resp_1" {
		t.Fatalf("unexpected response event: %#v", response)
	}
	if browserEvent.Event != "ui.select" {
		t.Fatalf("unexpected browser event: %#v", browserEvent)
	}
	if closeEvent.Reason != "data_channel_closed" || closeEvent.DataChannelState != "closed" {
		t.Fatalf("unexpected close event: %#v", closeEvent)
	}
}

func newAttachedSession(t *testing.T) (*fakeSocket, *ControlSession) {
	t.Helper()
	fake := &fakeSocket{channel: &fakeChannel{}}
	client := NewClient(ClientOptions{
		HTTPBase:          "https://vox.example.com",
		ConnectionTimeout: 500 * time.Millisecond,
	})
	client.socketFactory = func(endpoint string, params map[string]interface{}, _ time.Duration) (socketClient, error) {
		return fake, nil
	}
	session, err := client.AttachSession(context.Background(), "rtc_123")
	if err != nil {
		t.Fatalf("AttachSession returned error: %v", err)
	}
	return fake, session
}

func TestOnSpeechStarted(t *testing.T) {
	fake, session := newAttachedSession(t)

	var event SpeechStartedEvent
	session.OnSpeechStarted(func(e SpeechStartedEvent) {
		event = e
	})
	fake.channel.emit(EventSpeechStarted, map[string]interface{}{
		"timestamp_ms": 1234.0,
		"session_id":   "rtc_123",
	})

	if event.TimestampMS != 1234 {
		t.Fatalf("unexpected timestamp: %v", event.TimestampMS)
	}
	if event.SessionID != "rtc_123" || event.ChannelName != "/rtc/rtc_123" {
		t.Fatalf("unexpected metadata: %#v", event)
	}
}

func TestOnSpeechStopped(t *testing.T) {
	fake, session := newAttachedSession(t)

	var event SpeechStoppedEvent
	session.OnSpeechStopped(func(e SpeechStoppedEvent) {
		event = e
	})
	fake.channel.emit(EventSpeechStopped, map[string]interface{}{
		"timestamp_ms": 5678.0,
		"session_id":   "rtc_123",
	})

	if event.TimestampMS != 5678 {
		t.Fatalf("unexpected timestamp: %v", event.TimestampMS)
	}
	if event.SessionID != "rtc_123" || event.ChannelName != "/rtc/rtc_123" {
		t.Fatalf("unexpected metadata: %#v", event)
	}
}

func TestOnTranscriptDelta(t *testing.T) {
	fake, session := newAttachedSession(t)

	var event TranscriptDeltaEvent
	session.OnTranscriptDelta(func(e TranscriptDeltaEvent) {
		event = e
	})
	fake.channel.emit(EventTranscriptDelta, map[string]interface{}{
		"delta":      "hel",
		"start_ms":   100.0,
		"end_ms":     200.0,
		"session_id": "rtc_123",
	})

	if event.Delta != "hel" || event.StartMS != 100 || event.EndMS != 200 {
		t.Fatalf("unexpected transcript delta event: %#v", event)
	}
	if event.SessionID != "rtc_123" || event.ChannelName != "/rtc/rtc_123" {
		t.Fatalf("unexpected metadata: %#v", event)
	}
}

func TestOnTurnEouPredicted(t *testing.T) {
	fake, session := newAttachedSession(t)

	var event TurnEouPredictedEvent
	session.OnTurnEouPredicted(func(e TurnEouPredictedEvent) {
		event = e
	})
	fake.channel.emit(EventTurnEouPredicted, map[string]interface{}{
		"probability":   0.92,
		"threshold":     0.5,
		"delay_ms":      320.0,
		"start_ms":      10.0,
		"end_ms":        50.0,
		"decision":      "end",
		"action":        "commit",
		"turn_detector": "livekit",
		"session_id":    "rtc_123",
	})

	if event.Probability != 0.92 || event.Threshold != 0.5 || event.DelayMS != 320 {
		t.Fatalf("unexpected eou numbers: %#v", event)
	}
	if event.StartMS != 10 || event.EndMS != 50 {
		t.Fatalf("unexpected eou window: %#v", event)
	}
	if event.Decision != "end" || event.Action != "commit" || event.TurnDetector != "livekit" {
		t.Fatalf("unexpected eou strings: %#v", event)
	}
	if event.SessionID != "rtc_123" || event.ChannelName != "/rtc/rtc_123" {
		t.Fatalf("unexpected metadata: %#v", event)
	}
}

func TestOnConnectionChangeObservesReconnection(t *testing.T) {
	fake := &fakeSocket{channel: &fakeChannel{}}
	client := NewClient(ClientOptions{
		HTTPBase:          "https://vox.example.com",
		ConnectionTimeout: 500 * time.Millisecond,
	})
	client.socketFactory = func(endpoint string, params map[string]interface{}, _ time.Duration) (socketClient, error) {
		return fake, nil
	}

	var states []bool
	unsub, err := client.OnConnectionChange(func(connected bool) {
		states = append(states, connected)
	})
	if err != nil {
		t.Fatalf("OnConnectionChange returned error: %v", err)
	}
	defer unsub()

	fake.Connect()
	fake.Disconnect()
	fake.Connect()

	if len(states) != 3 || states[0] != true || states[1] != false || states[2] != true {
		t.Fatalf("unexpected connection states: %#v", states)
	}
}

func TestOnErrorParsesTypedFields(t *testing.T) {
	fake, session := newAttachedSession(t)

	var event ErrorEvent
	session.OnError(func(e ErrorEvent) {
		event = e
	})
	fake.channel.emit(EventError, map[string]interface{}{
		"message":       "turn state cannot accept a response",
		"code":          ErrorCodeResponseRejectedTurnState,
		"recoverable":   true,
		"generation_id": "gen-42",
		"session_id":    "rtc_123",
	})

	if event.Code != ErrorCodeResponseRejectedTurnState {
		t.Fatalf("unexpected code: %q", event.Code)
	}
	if !event.Recoverable {
		t.Fatalf("expected recoverable error: %#v", event)
	}
	if event.GenerationID != "gen-42" {
		t.Fatalf("unexpected generation id: %q", event.GenerationID)
	}
	if event.Message != "turn state cannot accept a response" {
		t.Fatalf("unexpected message: %q", event.Message)
	}
}

func TestOnErrorFatalCode(t *testing.T) {
	fake, session := newAttachedSession(t)

	var event ErrorEvent
	session.OnError(func(e ErrorEvent) {
		event = e
	})
	fake.channel.emit(EventError, map[string]interface{}{
		"message":     "session crashed",
		"code":        ErrorCodeSessionFailed,
		"recoverable": false,
		"session_id":  "rtc_123",
	})

	if event.Code != ErrorCodeSessionFailed {
		t.Fatalf("unexpected code: %q", event.Code)
	}
	if event.Recoverable {
		t.Fatalf("expected fatal error: %#v", event)
	}
	if event.GenerationID != "" {
		t.Fatalf("unexpected generation id: %q", event.GenerationID)
	}
}

func TestOnErrorMissingRecoverableDefaultsTrue(t *testing.T) {
	fake, session := newAttachedSession(t)

	var event ErrorEvent
	session.OnError(func(e ErrorEvent) {
		event = e
	})
	fake.channel.emit(EventError, map[string]interface{}{
		"message":    "legacy failure",
		"session_id": "rtc_123",
	})

	if !event.Recoverable {
		t.Fatalf("expected missing recoverable to default true: %#v", event)
	}
	if event.Code != "" {
		t.Fatalf("unexpected code: %q", event.Code)
	}
}

func TestResponseOptionsGenerationIDThreadsOutboundPayloads(t *testing.T) {
	fake, session := newAttachedSession(t)

	options := &ResponseOptions{GenerationID: "gen-42"}
	session.StartResponse(options)
	session.AppendResponseText("hello", options)
	session.CommitResponse()
	session.CancelResponse()

	sent := fake.channel.sentMessages()
	if len(sent) != 4 {
		t.Fatalf("unexpected message count: %d", len(sent))
	}
	expected := []string{"response.start", "response.delta", "response.commit", "response.cancel"}
	for i, message := range sent {
		if message.event != expected[i] {
			t.Fatalf("unexpected event %d: %s", i, message.event)
		}
		if message.payload["generation_id"] != "gen-42" {
			t.Fatalf("missing generation id on %s: %#v", message.event, message.payload)
		}
	}
}

func TestCommitAndCancelAcceptExplicitGenerationID(t *testing.T) {
	fake, session := newAttachedSession(t)

	session.CommitResponse(&ResponseOptions{GenerationID: "gen-a"})
	session.CancelResponse(&ResponseOptions{GenerationID: "gen-b"})

	sent := fake.channel.sentMessages()
	if sent[0].payload["generation_id"] != "gen-a" {
		t.Fatalf("unexpected commit payload: %#v", sent[0].payload)
	}
	if sent[1].payload["generation_id"] != "gen-b" {
		t.Fatalf("unexpected cancel payload: %#v", sent[1].payload)
	}
}

func TestResponseLifecycleEventsExposeGenerationID(t *testing.T) {
	fake, session := newAttachedSession(t)

	var created ResponseEvent
	var cleared ResponseEvent
	var interruption InterruptionEvent
	session.OnResponseCreated(func(e ResponseEvent) {
		created = e
	})
	session.OnResponseAudioClear(func(e ResponseEvent) {
		cleared = e
	})
	session.OnInterruptionDetected(func(e InterruptionEvent) {
		interruption = e
	})

	fake.channel.emit(EventResponseCreated, map[string]interface{}{
		"response_id":   "resp_1",
		"generation_id": "gen-42",
		"session_id":    "rtc_123",
	})
	fake.channel.emit(EventResponseAudioClear, map[string]interface{}{
		"response_id":   "resp_1",
		"generation_id": "gen-42",
		"session_id":    "rtc_123",
	})
	fake.channel.emit(EventInterruptionDetected, map[string]interface{}{
		"response_id":   "resp_1",
		"generation_id": "gen-42",
		"vad_active_ms": 120.0,
		"session_id":    "rtc_123",
	})

	if created.ResponseID != "resp_1" || created.GenerationID != "gen-42" {
		t.Fatalf("unexpected created event: %#v", created)
	}
	if cleared.GenerationID != "gen-42" {
		t.Fatalf("unexpected audio clear event: %#v", cleared)
	}
	if interruption.GenerationID != "gen-42" || interruption.VADActiveMS != 120 {
		t.Fatalf("unexpected interruption event: %#v", interruption)
	}
}

func TestOnTranscriptIncludesEntitiesAndWords(t *testing.T) {
	fake, session := newAttachedSession(t)

	var event TranscriptEvent
	session.OnTranscript(func(e TranscriptEvent) {
		event = e
	})
	fake.channel.emit(EventTranscriptCompleted, map[string]interface{}{
		"transcript": "call Ada tomorrow",
		"language":   "en",
		"session_id": "rtc_123",
		"entities": []interface{}{
			map[string]interface{}{"type": "PERSON", "text": "Ada", "start_char": 5.0, "end_char": 8.0},
		},
		"words": []interface{}{
			map[string]interface{}{"word": "call", "start_ms": 0.0, "end_ms": 100.0, "confidence": 0.92},
			map[string]interface{}{"word": "Ada", "start_ms": 100.0, "end_ms": 200.0},
		},
	})

	if len(event.Entities) != 1 {
		t.Fatalf("unexpected entities: %#v", event.Entities)
	}
	entity := event.Entities[0]
	if entity.Type != "PERSON" || entity.Text != "Ada" || entity.StartChar != 5 || entity.EndChar != 8 {
		t.Fatalf("unexpected entity: %#v", entity)
	}
	if len(event.Words) != 2 {
		t.Fatalf("unexpected words: %#v", event.Words)
	}
	if event.Words[0].Word != "call" || event.Words[0].StartMS != 0 || event.Words[0].EndMS != 100 {
		t.Fatalf("unexpected first word: %#v", event.Words[0])
	}
	if event.Words[0].Confidence == nil || *event.Words[0].Confidence != 0.92 {
		t.Fatalf("expected first word confidence 0.92: %#v", event.Words[0].Confidence)
	}
	if event.Words[1].Confidence != nil {
		t.Fatalf("expected omitted confidence to stay nil: %#v", event.Words[1].Confidence)
	}
}

func TestOnInterruptionIncludesReason(t *testing.T) {
	fake, session := newAttachedSession(t)

	var detected InterruptionEvent
	var falsePositive InterruptionEvent
	session.OnInterruptionDetected(func(e InterruptionEvent) {
		detected = e
	})
	session.OnInterruptionFalsePositive(func(e InterruptionEvent) {
		falsePositive = e
	})

	fake.channel.emit(EventInterruptionDetected, map[string]interface{}{
		"response_id": "resp_1",
		"reason":      "user_speech_confirmed",
		"session_id":  "rtc_123",
	})
	fake.channel.emit(EventInterruptionFalsePositive, map[string]interface{}{
		"response_id": "resp_1",
		"reason":      "self_echo",
		"session_id":  "rtc_123",
	})

	if detected.Reason != "user_speech_confirmed" {
		t.Fatalf("unexpected detected reason: %q", detected.Reason)
	}
	if falsePositive.Reason != "self_echo" {
		t.Fatalf("unexpected false-positive reason: %q", falsePositive.Reason)
	}
}

func TestOnSignalingError(t *testing.T) {
	fake, session := newAttachedSession(t)

	var event SignalingErrorEvent
	session.OnSignalingError(func(e SignalingErrorEvent) {
		event = e
	})
	fake.channel.emit(EventRTCSignalingError, map[string]interface{}{
		"message":    "failed to apply local description",
		"generation": float64(3),
		"session_id": "rtc_123",
	})

	if event.Message != "failed to apply local description" {
		t.Fatalf("unexpected message: %q", event.Message)
	}
	if event.Generation == nil || *event.Generation != 3 {
		t.Fatalf("expected echoed negotiation generation 3: %#v", event.Generation)
	}
	if event.SessionID != "rtc_123" || event.ChannelName != "/rtc/rtc_123" {
		t.Fatalf("unexpected metadata: %#v", event)
	}
}

func TestOnSignalingErrorWithoutGeneration(t *testing.T) {
	fake, session := newAttachedSession(t)

	var event SignalingErrorEvent
	session.OnSignalingError(func(e SignalingErrorEvent) {
		event = e
	})
	fake.channel.emit(EventRTCSignalingError, map[string]interface{}{
		"message": "failed to set remote description",
	})

	if event.Message != "failed to set remote description" {
		t.Fatalf("unexpected message: %q", event.Message)
	}
	if event.Generation != nil {
		t.Fatalf("expected absent generation to stay nil: %#v", event.Generation)
	}
}

func awaitStartPayload(t *testing.T, fake *fakeSocket) map[string]interface{} {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		for _, message := range fake.channel.sentMessages() {
			if message.event == "response.start" {
				return message.payload
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("response.start was never sent")
	return nil
}

func TestStartResponseAndWaitAccepted(t *testing.T) {
	fake, session := newAttachedSession(t)

	type result struct {
		ack StartAck
		err error
	}
	results := make(chan result, 1)
	go func() {
		ack, err := session.StartResponseAndWait(context.Background(), nil)
		results <- result{ack: ack, err: err}
	}()

	payload := awaitStartPayload(t, fake)
	generationID, ok := payload["generation_id"].(string)
	if !ok || generationID == "" {
		t.Fatalf("missing generation id on response.start: %#v", payload)
	}
	fake.channel.emit(EventResponseCreated, map[string]interface{}{
		"response_id":   "resp_9",
		"generation_id": "gen-other",
		"session_id":    "rtc_123",
	})
	fake.channel.emit(EventResponseCreated, map[string]interface{}{
		"response_id":   "resp_1",
		"generation_id": generationID,
		"session_id":    "rtc_123",
	})

	outcome := <-results
	if outcome.err != nil {
		t.Fatalf("StartResponseAndWait returned error: %v", outcome.err)
	}
	if !outcome.ack.Accepted {
		t.Fatalf("expected accepted ack: %#v", outcome.ack)
	}
	if outcome.ack.ResponseID != "resp_1" || outcome.ack.GenerationID != generationID {
		t.Fatalf("unexpected ack: %#v", outcome.ack)
	}
	if outcome.ack.Error != nil {
		t.Fatalf("unexpected ack error: %#v", outcome.ack.Error)
	}
}

func TestStartResponseAndWaitTypedRejection(t *testing.T) {
	fake, session := newAttachedSession(t)

	type result struct {
		ack StartAck
		err error
	}
	results := make(chan result, 1)
	go func() {
		ack, err := session.StartResponseAndWait(
			context.Background(),
			&ResponseOptions{GenerationID: "gen-42"},
		)
		results <- result{ack: ack, err: err}
	}()

	payload := awaitStartPayload(t, fake)
	if payload["generation_id"] != "gen-42" {
		t.Fatalf("unexpected start payload: %#v", payload)
	}
	fake.channel.emit(EventError, map[string]interface{}{
		"message":       "user is speaking",
		"code":          ErrorCodeResponseRejectedUserSpeech,
		"recoverable":   true,
		"generation_id": "gen-42",
		"session_id":    "rtc_123",
	})

	outcome := <-results
	if outcome.err != nil {
		t.Fatalf("StartResponseAndWait returned error: %v", outcome.err)
	}
	if outcome.ack.Accepted {
		t.Fatalf("expected rejection: %#v", outcome.ack)
	}
	if outcome.ack.GenerationID != "gen-42" {
		t.Fatalf("unexpected generation id: %q", outcome.ack.GenerationID)
	}
	if outcome.ack.Error == nil || outcome.ack.Error.Code != ErrorCodeResponseRejectedUserSpeech {
		t.Fatalf("unexpected ack error: %#v", outcome.ack.Error)
	}
	if !outcome.ack.Error.Recoverable {
		t.Fatalf("expected recoverable rejection: %#v", outcome.ack.Error)
	}
}

func TestStartResponseAndWaitContextTimeout(t *testing.T) {
	fake, session := newAttachedSession(t)

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	ack, err := session.StartResponseAndWait(ctx, &ResponseOptions{GenerationID: "gen-42"})
	if err == nil {
		t.Fatal("expected timeout error")
	}
	if ack.Accepted {
		t.Fatalf("expected unaccepted ack: %#v", ack)
	}
	if ack.GenerationID != "gen-42" {
		t.Fatalf("unexpected generation id: %q", ack.GenerationID)
	}
	payload := awaitStartPayload(t, fake)
	if payload["generation_id"] != "gen-42" {
		t.Fatalf("unexpected start payload: %#v", payload)
	}
}

func TestMapChannelStateDeclined(t *testing.T) {
	if got := mapChannelState(pondsocket.Declined); got != channelStateDeclined {
		t.Fatalf("expected declined mapping, got %q", got)
	}
	if got := mapChannelState(pondsocket.Joined); got != channelStateJoined {
		t.Fatalf("expected joined mapping, got %q", got)
	}
	if got := mapChannelState(pondsocket.Closed); got != channelStateClosed {
		t.Fatalf("expected closed mapping, got %q", got)
	}
}
