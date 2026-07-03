package rtcserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	pondsocket "github.com/eleven-am/pondsocket/go/pondsocket-client"
)

type fakeChannel struct {
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
	f.sent = append(f.sent, sentMessage{event: event, payload: payload})
}

func (f *fakeChannel) OnMessage(callback func(event string, payload map[string]interface{})) func() {
	f.msgHandlers = append(f.msgHandlers, callback)
	return func() {}
}

func (f *fakeChannel) OnChannelStateChange(callback func(state channelState)) func() {
	f.stateHandlers = append(f.stateHandlers, callback)
	return func() {}
}

func (f *fakeChannel) emit(event string, payload map[string]interface{}) {
	for _, handler := range f.msgHandlers {
		handler(event, payload)
	}
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
			SessionID:           "rtc_123",
			ClientToken:         "tok_123",
			ExpiresAt:           "2026-01-01T00:00:00Z",
			JoinTokenTTLSeconds: 120,
			ICEServers:          []RTCIceServer{{URLs: []string{"stun:turn.example.com:3478"}}},
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
	})
	client.socketFactory = func(endpoint string, params map[string]interface{}) (socketClient, error) {
		if params["api_key"] != "secret" {
			t.Fatalf("unexpected socket api_key: %#v", params["api_key"])
		}
		return fake, nil
	}

	session, err := client.AttachSession(context.Background(), "rtc_123")
	if err != nil {
		t.Fatalf("AttachSession returned error: %v", err)
	}

	session.Configure(SessionConfig{
		STTModel:     "stt",
		TTSModel:     "tts",
		Voice:        "voice",
		TurnProfile:  "browser_default",
		VADBackend:   "silero",
		TurnDetector: "livekit",
	})
	session.SendTextResponse("hello", nil, true)
	session.SendClientEvent(ClientEvent{Event: "render.url", Payload: map[string]interface{}{"url": "https://example.com"}})

	if len(fake.channel.sent) != 3 {
		t.Fatalf("unexpected message count: %d", len(fake.channel.sent))
	}
	if fake.channel.sent[0].event != "session.update" {
		t.Fatalf("unexpected first event: %s", fake.channel.sent[0].event)
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

func TestOnEventIncludesSessionMetadata(t *testing.T) {
	fake := &fakeSocket{channel: &fakeChannel{}}
	client := NewClient(ClientOptions{
		HTTPBase:          "https://vox.example.com",
		ConnectionTimeout: 500 * time.Millisecond,
	})
	client.socketFactory = func(endpoint string, params map[string]interface{}) (socketClient, error) {
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
	client.socketFactory = func(endpoint string, params map[string]interface{}) (socketClient, error) {
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
	client.socketFactory = func(endpoint string, params map[string]interface{}) (socketClient, error) {
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
	client.socketFactory = func(endpoint string, params map[string]interface{}) (socketClient, error) {
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

func TestMapChannelStateDeclined(t *testing.T) {
	if got := mapChannelState(pondsocket.ChannelState("DECLINED")); got != channelStateDeclined {
		t.Fatalf("expected declined mapping, got %q", got)
	}
	if got := mapChannelState(pondsocket.Joined); got != channelStateJoined {
		t.Fatalf("expected joined mapping, got %q", got)
	}
	if got := mapChannelState(pondsocket.Closed); got != channelStateClosed {
		t.Fatalf("expected closed mapping, got %q", got)
	}
}
