package rtcserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const defaultGatewayPath = "/api/vox/rtc"

type GatewaySessionContext struct {
	Request *http.Request
	Session *ControlSession
}

type GatewayClosedContext struct {
	GatewaySessionContext
	Reason string
}

type GatewayOptions struct {
	VoxHTTPBase      string
	APIKey           string
	Path             string
	CheckOrigin      func(*http.Request) bool
	OnSessionCreated func(GatewaySessionContext) error
	OnSessionClosed  func(GatewayClosedContext) error
	OnError          func(error)
}

type gatewayControlClient interface {
	CreateControlledSession(context.Context, ...SessionOptions) (*SessionBootstrap, *ControlSession, error)
	Disconnect() error
}

type Gateway struct {
	options  GatewayOptions
	client   gatewayControlClient
	path     string
	upgrader websocket.Upgrader

	mu             sync.Mutex
	active         map[*gatewaySession]struct{}
	shutdownReason string
	closeOnce      sync.Once
	closeDone      chan struct{}
	connections    sync.WaitGroup
}

type gatewaySession struct {
	gateway     *Gateway
	connection  *websocket.Conn
	context     GatewaySessionContext
	unsubscribe func()

	writeMu           sync.Mutex
	mu                sync.Mutex
	pendingOfferID    string
	rtcCloseRequested bool
	closed            bool
}

type gatewayClientMessage struct {
	ID   string                 `json:"id"`
	Type string                 `json:"type"`
	Data map[string]interface{} `json:"data"`
}

func NewGateway(options GatewayOptions) *Gateway {
	client := NewClient(ClientOptions{
		HTTPBase: options.VoxHTTPBase,
		APIKey:   options.APIKey,
	})
	return newGatewayWithClient(options, client)
}

func newGatewayWithClient(options GatewayOptions, client gatewayControlClient) *Gateway {
	path := strings.TrimSpace(options.Path)
	if path == "" {
		path = defaultGatewayPath
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	path = strings.TrimSuffix(path, "/")
	if path == "" {
		path = "/"
	}
	upgrader := websocket.Upgrader{}
	if options.CheckOrigin != nil {
		upgrader.CheckOrigin = options.CheckOrigin
	}
	return &Gateway{
		options:   options,
		client:    client,
		path:      path,
		upgrader:  upgrader,
		active:    make(map[*gatewaySession]struct{}),
		closeDone: make(chan struct{}),
	}
}

func (g *Gateway) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if gatewayRequestPath(request) != g.path {
		http.NotFound(writer, request)
		return
	}
	g.mu.Lock()
	shutdownReason := g.shutdownReason
	if shutdownReason == "" {
		g.connections.Add(1)
	}
	g.mu.Unlock()
	if shutdownReason != "" {
		http.Error(writer, "RTC gateway is shutting down", http.StatusServiceUnavailable)
		return
	}
	defer g.connections.Done()
	connection, err := g.upgrader.Upgrade(writer, request, nil)
	if err != nil {
		g.reportError(err)
		return
	}
	g.serveConnection(connection, request)
}

func (g *Gateway) Close(reason string) error {
	if strings.TrimSpace(reason) == "" {
		reason = "gateway_shutdown"
	}
	g.closeOnce.Do(func() {
		g.mu.Lock()
		g.shutdownReason = reason
		active := make([]*gatewaySession, 0, len(g.active))
		for session := range g.active {
			active = append(active, session)
		}
		g.mu.Unlock()
		for _, session := range active {
			session.close(reason)
		}
		g.connections.Wait()
		if err := g.client.Disconnect(); err != nil {
			g.reportError(err)
		}
		close(g.closeDone)
	})
	<-g.closeDone
	return nil
}

func (g *Gateway) serveConnection(connection *websocket.Conn, request *http.Request) {
	bootstrap, control, err := g.client.CreateControlledSession(request.Context())
	if err != nil {
		g.reportError(err)
		_ = connection.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseInternalServerErr, "RTC gateway setup failed"), noDeadline)
		_ = connection.Close()
		return
	}
	session := &gatewaySession{
		gateway:     g,
		connection:  connection,
		context:     GatewaySessionContext{Request: request, Session: control},
		unsubscribe: func() {},
	}
	session.unsubscribe = control.OnEvent(session.forwardEvent)
	if g.options.OnSessionCreated != nil {
		if err := g.options.OnSessionCreated(session.context); err != nil {
			session.send("", "gateway.error", map[string]interface{}{"message": err.Error()})
			session.close("session_created_hook_failed")
			return
		}
	}
	g.mu.Lock()
	shutdownReason := g.shutdownReason
	session.mu.Lock()
	closed := session.closed
	if !closed && shutdownReason == "" {
		g.active[session] = struct{}{}
	}
	session.mu.Unlock()
	g.mu.Unlock()
	if closed {
		return
	}
	if shutdownReason != "" {
		session.close(shutdownReason)
		return
	}
	if err := session.send("", "gateway.ready", map[string]interface{}{
		"session": map[string]interface{}{
			"sessionId":        bootstrap.SessionID,
			"expiresAt":        bootstrap.ExpiresAt,
			"attachTtlSeconds": bootstrap.AttachTTLSeconds,
			"iceServers":       bootstrap.ICEServers,
		},
	}); err != nil {
		g.reportError(err)
		session.close("gateway_ready_failed")
		return
	}

	defer session.close("browser_disconnected")
	for {
		_, raw, err := connection.ReadMessage()
		if err != nil {
			if !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				g.reportError(err)
			}
			return
		}
		if err := session.handleMessage(raw); err != nil {
			g.reportError(err)
		}
	}
}

func (s *gatewaySession) handleMessage(raw []byte) error {
	var message gatewayClientMessage
	if err := json.Unmarshal(raw, &message); err != nil {
		s.send("", "gateway.error", map[string]interface{}{"message": "RTC gateway message must be valid JSON"})
		return err
	}
	message.ID = strings.TrimSpace(message.ID)
	message.Type = strings.TrimSpace(message.Type)
	if message.ID == "" || message.Type == "" || message.Data == nil {
		err := errors.New("RTC gateway message requires id, type, and object data")
		s.send(message.ID, "gateway.error", map[string]interface{}{"message": err.Error()})
		return err
	}

	var err error
	switch message.Type {
	case "rtc.offer":
		err = s.handleOffer(message)
	case "rtc.ice_candidate":
		err = s.handleCandidate(message)
	case "rtc.close":
		s.mu.Lock()
		s.rtcCloseRequested = true
		s.mu.Unlock()
		reason, _ := message.Data["reason"].(string)
		s.context.Session.CloseRTC(reason)
	default:
		err = fmt.Errorf("unsupported RTC gateway message type: %s", message.Type)
	}
	if err != nil {
		s.mu.Lock()
		if s.pendingOfferID == message.ID {
			s.pendingOfferID = ""
		}
		s.mu.Unlock()
		s.send(message.ID, "gateway.error", map[string]interface{}{"message": err.Error()})
	}
	return err
}

func (s *gatewaySession) handleOffer(message gatewayClientMessage) error {
	offerValue, ok := message.Data["offer"].(map[string]interface{})
	if !ok {
		return errors.New("rtc.offer requires an offer object")
	}
	typeValue, _ := offerValue["type"].(string)
	sdp, _ := offerValue["sdp"].(string)
	s.mu.Lock()
	if s.pendingOfferID != "" {
		s.mu.Unlock()
		return errors.New("an RTC offer is already pending")
	}
	s.pendingOfferID = message.ID
	s.mu.Unlock()
	return s.context.Session.SendOffer(
		RTCSessionDescription{Type: typeValue, SDP: sdp},
		message.Data["restart"] == true,
		message.Data["generation"],
	)
}

func (s *gatewaySession) handleCandidate(message gatewayClientMessage) error {
	value, exists := message.Data["candidate"]
	if !exists || value == nil {
		s.context.Session.SendIceCandidate(nil)
		return nil
	}
	candidateValue, ok := value.(map[string]interface{})
	if !ok {
		return errors.New("rtc.ice_candidate requires a candidate object or null")
	}
	candidateText, ok := candidateValue["candidate"].(string)
	if !ok {
		return errors.New("rtc.ice_candidate requires a candidate string")
	}
	candidate := RTCIceCandidate{Candidate: candidateText}
	candidate.SDPMid = optionalString(candidateValue["sdpMid"])
	candidate.UsernameFragment = optionalString(candidateValue["usernameFragment"])
	if index, ok := candidateValue["sdpMLineIndex"].(float64); ok && index >= 0 {
		value := uint32(index)
		candidate.SDPMLineIndex = &value
	}
	s.context.Session.SendIceCandidate(&candidate)
	return nil
}

func (s *gatewaySession) forwardEvent(event WireEvent) {
	s.mu.Lock()
	requestID := ""
	if event.Type == EventRTCAnswer || event.Type == EventRTCSignalingError {
		requestID = s.pendingOfferID
		s.pendingOfferID = ""
	}
	s.mu.Unlock()
	data := event.Data
	if data == nil {
		data = map[string]interface{}{}
	}
	if err := s.send(requestID, event.Type, data); err != nil {
		s.gateway.reportError(err)
	}
	if event.Type == EventRTCSessionClosed {
		reason, _ := data["reason"].(string)
		s.mu.Lock()
		s.rtcCloseRequested = true
		s.mu.Unlock()
		s.close(reason)
	}
}

func (s *gatewaySession) close(reason string) {
	if strings.TrimSpace(reason) == "" {
		reason = "session_closed"
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	rtcCloseRequested := s.rtcCloseRequested
	s.rtcCloseRequested = true
	s.mu.Unlock()

	s.unsubscribe()
	if !rtcCloseRequested {
		s.context.Session.CloseRTC(reason)
	}
	s.context.Session.Close()
	if s.gateway.options.OnSessionClosed != nil {
		if err := s.gateway.options.OnSessionClosed(GatewayClosedContext{
			GatewaySessionContext: s.context,
			Reason:                reason,
		}); err != nil {
			s.gateway.reportError(err)
		}
	}
	s.writeMu.Lock()
	_ = s.connection.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, reason), noDeadline)
	_ = s.connection.Close()
	s.writeMu.Unlock()
	s.gateway.mu.Lock()
	delete(s.gateway.active, s)
	s.gateway.mu.Unlock()
}

func (s *gatewaySession) send(id, eventType string, data map[string]interface{}) error {
	s.mu.Lock()
	closed := s.closed
	s.mu.Unlock()
	if closed {
		return nil
	}
	payload := map[string]interface{}{"type": eventType, "data": data}
	if id != "" {
		payload["id"] = id
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.connection.WriteJSON(payload)
}

func (g *Gateway) reportError(err error) {
	if err == nil || g.options.OnError == nil {
		return
	}
	g.options.OnError(err)
}

func gatewayRequestPath(request *http.Request) string {
	path := strings.TrimSuffix(request.URL.Path, "/")
	if path == "" {
		return "/"
	}
	return path
}

func optionalString(value interface{}) *string {
	text, ok := value.(string)
	if !ok {
		return nil
	}
	return &text
}

var noDeadline = time.Time{}
