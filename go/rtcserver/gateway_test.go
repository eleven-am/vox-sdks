package rtcserver

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type fakeGatewayClient struct {
	channel      *fakeChannel
	disconnected bool
}

func (f *fakeGatewayClient) CreateControlledSession(context.Context, ...SessionOptions) (*SessionBootstrap, *ControlSession, error) {
	return &SessionBootstrap{
		SessionID:        "rtc_gateway",
		ExpiresAt:        "2026-01-01T00:00:00Z",
		AttachTTLSeconds: 120,
		ICEServers:       []RTCIceServer{{URLs: []string{"stun:turn.example.com:3478"}}},
	}, newControlSession(f.channel, "rtc_gateway", time.Second), nil
}

func (f *fakeGatewayClient) Disconnect() error {
	f.disconnected = true
	return nil
}

func TestGatewayForwardsTrickleSignalingAndRunsLifecycleHooks(t *testing.T) {
	channel := &fakeChannel{}
	client := &fakeGatewayClient{channel: channel}
	var hookMu sync.Mutex
	created := 0
	closed := 0
	gateway := newGatewayWithClient(GatewayOptions{
		Path: "/api/rtc",
		OnSessionCreated: func(context GatewaySessionContext) error {
			hookMu.Lock()
			defer hookMu.Unlock()
			created++
			if context.Request.URL.Query().Get("videoId") != "video-1" {
				t.Fatalf("hook did not receive the original request")
			}
			if context.Session.SessionID() != "rtc_gateway" {
				t.Fatalf("hook did not receive the control session")
			}
			return nil
		},
		OnSessionClosed: func(context GatewayClosedContext) error {
			hookMu.Lock()
			defer hookMu.Unlock()
			closed++
			return nil
		},
	}, client)
	server := httptest.NewServer(gateway)
	defer server.Close()
	defer gateway.Close("test_shutdown")

	connection, _, err := websocket.DefaultDialer.Dial(
		"ws"+strings.TrimPrefix(server.URL, "http")+"/api/rtc?videoId=video-1",
		nil,
	)
	if err != nil {
		t.Fatalf("dial gateway: %v", err)
	}

	ready := readGatewayMessage(t, connection)
	if ready["type"] != "gateway.ready" {
		t.Fatalf("unexpected ready event: %#v", ready)
	}
	data := ready["data"].(map[string]interface{})
	if _, ok := data["capability"]; ok {
		t.Fatalf("gateway.ready still carries a capability: %#v", data)
	}
	encoded, _ := json.Marshal(ready)
	if strings.Contains(string(encoded), "voxHttpBase") || strings.Contains(string(encoded), "apiKey") {
		t.Fatalf("gateway leaked private Vox configuration: %s", encoded)
	}

	writeGatewayMessage(t, connection, map[string]interface{}{
		"id": "offer-1", "type": "rtc.offer",
		"data": map[string]interface{}{
			"generation": float64(1),
			"offer":      map[string]interface{}{"type": "offer", "sdp": "v=0\r\n"},
		},
	})
	waitForSentEvent(t, channel, "rtc.offer")
	forwardedGeneration := sentEventPayload(t, channel, "rtc.offer")["generation"]
	if forwardedGeneration != float64(1) {
		t.Fatalf("offer command did not forward the browser generation to vox: %#v", forwardedGeneration)
	}
	channel.emit("rtc.answer", map[string]interface{}{
		"answer":     map[string]interface{}{"type": "answer", "sdp": "v=0\r\n"},
		"generation": forwardedGeneration,
	})
	answer := readGatewayMessage(t, connection)
	if answer["id"] != "offer-1" || answer["type"] != "rtc.answer" {
		t.Fatalf("offer response was not correlated: %#v", answer)
	}

	channel.emit("rtc.ice_candidate", map[string]interface{}{"candidate": nil, "generation": forwardedGeneration})
	candidate := readGatewayMessage(t, connection)
	if candidate["type"] != "rtc.ice_candidate" {
		t.Fatalf("unexpected candidate event: %#v", candidate)
	}
	if candidate["data"].(map[string]interface{})["generation"] != float64(1) {
		t.Fatalf("candidate did not forward vox's negotiation generation verbatim: %#v", candidate)
	}

	if err := connection.Close(); err != nil {
		t.Fatalf("close browser socket: %v", err)
	}
	waitFor(t, func() bool {
		hookMu.Lock()
		defer hookMu.Unlock()
		return closed == 1
	}, "close hook")
	hookMu.Lock()
	defer hookMu.Unlock()
	if created != 1 || closed != 1 {
		t.Fatalf("unexpected lifecycle counts: created=%d closed=%d", created, closed)
	}
}

func TestGatewayRejectsFailedSessionHookWithoutSendingReady(t *testing.T) {
	client := &fakeGatewayClient{channel: &fakeChannel{}}
	gateway := newGatewayWithClient(GatewayOptions{
		OnSessionCreated: func(GatewaySessionContext) error {
			return context.Canceled
		},
	}, client)
	server := httptest.NewServer(gateway)
	defer server.Close()
	defer gateway.Close("test_shutdown")

	connection, _, err := websocket.DefaultDialer.Dial(
		"ws"+strings.TrimPrefix(server.URL, "http")+defaultGatewayPath,
		nil,
	)
	if err != nil {
		t.Fatalf("dial gateway: %v", err)
	}
	defer connection.Close()
	message := readGatewayMessage(t, connection)
	if message["type"] != "gateway.error" {
		t.Fatalf("failed hook should emit gateway.error, got %#v", message)
	}
}

func TestGatewayLeavesOfferPendingOnUnrelatedConversationError(t *testing.T) {
	channel, connection, cleanup := dialGateway(t, GatewayOptions{Path: "/api/rtc"})
	defer cleanup()

	ready := readGatewayMessage(t, connection)
	if ready["type"] != "gateway.ready" {
		t.Fatalf("unexpected ready event: %#v", ready)
	}

	writeGatewayMessage(t, connection, map[string]interface{}{
		"id": "offer-1", "type": "rtc.offer",
		"data": map[string]interface{}{
			"generation": float64(1),
			"offer":      map[string]interface{}{"type": "offer", "sdp": "v=0\r\n"},
		},
	})
	waitForSentEvent(t, channel, "rtc.offer")

	channel.emit("error", map[string]interface{}{
		"message": "response stale generation",
		"code":    ErrorCodeResponseStaleGeneration,
	})
	errored := readGatewayMessage(t, connection)
	if errored["type"] != "error" {
		t.Fatalf("expected conversation error forwarded, got %#v", errored)
	}
	if _, correlated := errored["id"]; correlated {
		t.Fatalf("conversation error must forward uncorrelated to the pending offer: %#v", errored)
	}

	channel.emit("rtc.answer", map[string]interface{}{
		"answer": map[string]interface{}{"type": "answer", "sdp": "v=0\r\n"},
	})
	answer := readGatewayMessage(t, connection)
	if answer["id"] != "offer-1" || answer["type"] != "rtc.answer" {
		t.Fatalf("unrelated error cleared the pending offer: %#v", answer)
	}
}

func TestGatewayRejectsPendingOfferOnSignalingError(t *testing.T) {
	channel, connection, cleanup := dialGateway(t, GatewayOptions{Path: "/api/rtc"})
	defer cleanup()

	ready := readGatewayMessage(t, connection)
	if ready["type"] != "gateway.ready" {
		t.Fatalf("unexpected ready event: %#v", ready)
	}

	writeGatewayMessage(t, connection, map[string]interface{}{
		"id": "offer-1", "type": "rtc.offer",
		"data": map[string]interface{}{
			"generation": float64(1),
			"offer":      map[string]interface{}{"type": "offer", "sdp": "v=0\r\n"},
		},
	})
	waitForSentEvent(t, channel, "rtc.offer")

	channel.emit("rtc.signaling_error", map[string]interface{}{
		"message":    "setLocalDescription failed",
		"code":       "signaling_failed",
		"generation": float64(1),
	})
	signaling := readGatewayMessage(t, connection)
	if signaling["type"] != "rtc.signaling_error" || signaling["id"] != "offer-1" {
		t.Fatalf("signaling error did not reject the pending offer: %#v", signaling)
	}
}

func TestGatewaySubscribesBeforeSessionCreatedHook(t *testing.T) {
	channel := &fakeChannel{}
	client := &fakeGatewayClient{channel: channel}
	gateway := newGatewayWithClient(GatewayOptions{
		Path: "/api/rtc",
		OnSessionCreated: func(GatewaySessionContext) error {
			channel.emit("turn.state_changed", map[string]interface{}{"state": "listening"})
			return nil
		},
	}, client)
	server := httptest.NewServer(gateway)
	defer server.Close()
	defer gateway.Close("test_shutdown")

	connection, _, err := websocket.DefaultDialer.Dial(
		"ws"+strings.TrimPrefix(server.URL, "http")+"/api/rtc",
		nil,
	)
	if err != nil {
		t.Fatalf("dial gateway: %v", err)
	}
	defer connection.Close()

	event := readGatewayMessage(t, connection)
	if event["type"] != "turn.state_changed" {
		t.Fatalf("event emitted while the hook ran did not reach the browser: %#v", event)
	}
	ready := readGatewayMessage(t, connection)
	if ready["type"] != "gateway.ready" {
		t.Fatalf("expected gateway.ready after the hook event: %#v", ready)
	}
}

func TestGatewaySkipsRegistrationWhenHookClosesSession(t *testing.T) {
	channel := &fakeChannel{}
	client := &fakeGatewayClient{channel: channel}
	gateway := newGatewayWithClient(GatewayOptions{
		Path: "/api/rtc",
		OnSessionCreated: func(GatewaySessionContext) error {
			channel.emit("rtc.session.closed", map[string]interface{}{"reason": "peer_gone"})
			return nil
		},
	}, client)
	server := httptest.NewServer(gateway)
	defer server.Close()
	defer gateway.Close("test_shutdown")

	connection, _, err := websocket.DefaultDialer.Dial(
		"ws"+strings.TrimPrefix(server.URL, "http")+"/api/rtc",
		nil,
	)
	if err != nil {
		t.Fatalf("dial gateway: %v", err)
	}
	defer connection.Close()

	closedEvent := readGatewayMessage(t, connection)
	if closedEvent["type"] != "rtc.session.closed" {
		t.Fatalf("terminal event was not forwarded to the browser: %#v", closedEvent)
	}
	waitFor(t, func() bool {
		return gatewayActiveCount(gateway) == 0
	}, "hook-closed session removed from the active registry")
}

func gatewayActiveCount(gateway *Gateway) int {
	gateway.mu.Lock()
	defer gateway.mu.Unlock()
	return len(gateway.active)
}

func dialGateway(t *testing.T, options GatewayOptions) (*fakeChannel, *websocket.Conn, func()) {
	t.Helper()
	if strings.TrimSpace(options.Path) == "" {
		options.Path = "/api/rtc"
	}
	channel := &fakeChannel{}
	client := &fakeGatewayClient{channel: channel}
	gateway := newGatewayWithClient(options, client)
	server := httptest.NewServer(gateway)
	connection, _, err := websocket.DefaultDialer.Dial(
		"ws"+strings.TrimPrefix(server.URL, "http")+options.Path,
		nil,
	)
	if err != nil {
		server.Close()
		t.Fatalf("dial gateway: %v", err)
	}
	cleanup := func() {
		_ = connection.Close()
		_ = gateway.Close("test_shutdown")
		server.Close()
	}
	return channel, connection, cleanup
}

func readGatewayMessage(t *testing.T, connection *websocket.Conn) map[string]interface{} {
	t.Helper()
	if err := connection.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	var message map[string]interface{}
	if err := connection.ReadJSON(&message); err != nil {
		t.Fatalf("read gateway message: %v", err)
	}
	return message
}

func writeGatewayMessage(t *testing.T, connection *websocket.Conn, message map[string]interface{}) {
	t.Helper()
	if err := connection.WriteJSON(message); err != nil {
		t.Fatalf("write gateway message: %v", err)
	}
}

func waitForSentEvent(t *testing.T, channel *fakeChannel, event string) {
	t.Helper()
	waitFor(t, func() bool {
		for _, sent := range channel.sentMessages() {
			if sent.event == event {
				return true
			}
		}
		return false
	}, event)
}

func sentEventPayload(t *testing.T, channel *fakeChannel, event string) map[string]interface{} {
	t.Helper()
	for _, sent := range channel.sentMessages() {
		if sent.event == event {
			return sent.payload
		}
	}
	t.Fatalf("no %s command was forwarded to vox", event)
	return nil
}

func waitFor(t *testing.T, condition func() bool, description string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", description)
}
