package rtcserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
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

type fakeSocket struct {
	connected     bool
	channel       *fakeChannel
	connHandlers  []func(bool)
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

	if len(fake.channel.sent) != 6 {
		t.Fatalf("unexpected message count: %d", len(fake.channel.sent))
	}
	if fake.channel.sent[0].event != "session.update" {
		t.Fatalf("unexpected first event: %s", fake.channel.sent[0].event)
	}
	if fake.channel.sent[5].event != "client.event" {
		t.Fatalf("unexpected final event: %s", fake.channel.sent[5].event)
	}
}
