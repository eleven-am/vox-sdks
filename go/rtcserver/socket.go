package rtcserver

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"sync"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

type channelState string

const (
	channelStateIdle     channelState = "IDLE"
	channelStateJoining  channelState = "JOINING"
	channelStateJoined   channelState = "JOINED"
	channelStateClosed   channelState = "CLOSED"
	channelStateDeclined channelState = "DECLINED"
)

type socketEnvelope struct {
	Action      string      `json:"action"`
	Event       string      `json:"event"`
	Payload     interface{} `json:"payload"`
	ChannelName string      `json:"channelName"`
	RequestID   string      `json:"requestId"`
}

type rawSocketClient struct {
	address     *url.URL
	conn        *websocket.Conn
	connMu      sync.RWMutex
	connected   bool
	stateMu     sync.RWMutex
	subMu       sync.RWMutex
	channelMu   sync.RWMutex
	nextSubID   int
	subs        map[int]func(bool)
	channels    map[string]*rawSocketChannel
}

type rawSocketChannel struct {
	client       *rawSocketClient
	name         string
	params       map[string]interface{}
	state        channelState
	stateMu      sync.RWMutex
	subMu        sync.RWMutex
	msgSubs      map[int]func(string, map[string]interface{})
	stateSubs    map[int]func(channelState)
	nextSubID    int
}

func newRawSocketClient(endpoint string, params map[string]interface{}) (*rawSocketClient, error) {
	address, err := url.Parse(endpoint)
	if err != nil {
		return nil, fmt.Errorf("invalid endpoint URL: %w", err)
	}

	switch address.Scheme {
	case "http":
		address.Scheme = "ws"
	case "https":
		address.Scheme = "wss"
	case "ws", "wss":
	default:
		return nil, fmt.Errorf("unsupported scheme: %s", address.Scheme)
	}

	q := address.Query()
	for key, value := range params {
		q.Set(key, fmt.Sprint(value))
	}
	address.RawQuery = q.Encode()

	return &rawSocketClient{
		address:  address,
		subs:     make(map[int]func(bool)),
		channels: make(map[string]*rawSocketChannel),
	}, nil
}

func (c *rawSocketClient) Connect() error {
	c.connMu.Lock()
	defer c.connMu.Unlock()
	if c.conn != nil {
		return nil
	}

	conn, _, err := websocket.DefaultDialer.Dial(c.address.String(), nil)
	if err != nil {
		return fmt.Errorf("failed to connect to %s: %w", c.address.String(), err)
	}
	c.conn = conn
	go c.readLoop(conn)
	return nil
}

func (c *rawSocketClient) Disconnect() error {
	c.connMu.Lock()
	defer c.connMu.Unlock()
	if c.conn == nil {
		return nil
	}
	err := c.conn.Close()
	c.conn = nil
	c.setConnected(false)
	return err
}

func (c *rawSocketClient) GetState() bool {
	c.stateMu.RLock()
	defer c.stateMu.RUnlock()
	return c.connected
}

func (c *rawSocketClient) CreateChannel(name string, params map[string]interface{}) socketChannel {
	c.channelMu.Lock()
	defer c.channelMu.Unlock()
	if existing, ok := c.channels[name]; ok {
		return existing
	}
	channel := &rawSocketChannel{
		client:    c,
		name:      name,
		params:    params,
		state:     channelStateIdle,
		msgSubs:   make(map[int]func(string, map[string]interface{})),
		stateSubs: make(map[int]func(channelState)),
	}
	c.channels[name] = channel
	return channel
}

func (c *rawSocketClient) OnConnectionChange(callback func(connected bool)) func() {
	c.subMu.Lock()
	id := c.nextSubID
	c.nextSubID++
	c.subs[id] = callback
	c.subMu.Unlock()
	callback(c.GetState())
	return func() {
		c.subMu.Lock()
		delete(c.subs, id)
		c.subMu.Unlock()
	}
}

func (c *rawSocketClient) setConnected(connected bool) {
	c.stateMu.Lock()
	c.connected = connected
	c.stateMu.Unlock()

	c.subMu.RLock()
	defer c.subMu.RUnlock()
	for _, callback := range c.subs {
		callback(connected)
	}
}

func (c *rawSocketClient) readLoop(conn *websocket.Conn) {
	defer func() {
		c.connMu.Lock()
		if c.conn == conn {
			c.conn = nil
		}
		c.connMu.Unlock()
		c.setConnected(false)
	}()

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		lines := strings.Split(strings.TrimSpace(string(data)), "\n")
		for _, line := range lines {
			if strings.TrimSpace(line) == "" {
				continue
			}
			var env socketEnvelope
			if err := json.Unmarshal([]byte(line), &env); err != nil {
				continue
			}
			if env.Action == "CONNECT" && env.Event == "CONNECTION" {
				c.setConnected(true)
				continue
			}
			c.channelMu.RLock()
			channel := c.channels[env.ChannelName]
			c.channelMu.RUnlock()
			if channel != nil {
				channel.handleEnvelope(env)
			}
		}
	}
}

func (c *rawSocketClient) send(env socketEnvelope) {
	c.connMu.RLock()
	conn := c.conn
	c.connMu.RUnlock()
	if conn == nil {
		return
	}
	payload, err := json.Marshal(env)
	if err != nil {
		return
	}
	_ = conn.WriteMessage(websocket.TextMessage, payload)
}

func (c *rawSocketChannel) Join() {
	c.setState(channelStateJoining)
	c.client.send(socketEnvelope{
		Action:      "JOIN_CHANNEL",
		Event:       "JOIN_CHANNEL",
		Payload:     c.params,
		ChannelName: c.name,
		RequestID:   uuid.NewString(),
	})
}

func (c *rawSocketChannel) Leave() {
	c.client.send(socketEnvelope{
		Action:      "LEAVE_CHANNEL",
		Event:       "LEAVE_CHANNEL",
		Payload:     map[string]interface{}{},
		ChannelName: c.name,
		RequestID:   uuid.NewString(),
	})
	c.setState(channelStateClosed)
}

func (c *rawSocketChannel) SendMessage(event string, payload map[string]interface{}) {
	if payload == nil {
		payload = map[string]interface{}{}
	}
	c.client.send(socketEnvelope{
		Action:      "BROADCAST",
		Event:       event,
		Payload:     payload,
		ChannelName: c.name,
		RequestID:   uuid.NewString(),
	})
}

func (c *rawSocketChannel) OnMessage(callback func(event string, payload map[string]interface{})) func() {
	c.subMu.Lock()
	id := c.nextSubID
	c.nextSubID++
	c.msgSubs[id] = callback
	c.subMu.Unlock()
	return func() {
		c.subMu.Lock()
		delete(c.msgSubs, id)
		c.subMu.Unlock()
	}
}

func (c *rawSocketChannel) OnChannelStateChange(callback func(state channelState)) func() {
	c.subMu.Lock()
	id := c.nextSubID
	c.nextSubID++
	c.stateSubs[id] = callback
	c.subMu.Unlock()
	callback(c.State())
	return func() {
		c.subMu.Lock()
		delete(c.stateSubs, id)
		c.subMu.Unlock()
	}
}

func (c *rawSocketChannel) State() channelState {
	c.stateMu.RLock()
	defer c.stateMu.RUnlock()
	return c.state
}

func (c *rawSocketChannel) setState(state channelState) {
	c.stateMu.Lock()
	c.state = state
	c.stateMu.Unlock()
	c.subMu.RLock()
	defer c.subMu.RUnlock()
	for _, callback := range c.stateSubs {
		callback(state)
	}
}

func (c *rawSocketChannel) handleEnvelope(env socketEnvelope) {
	if env.Event == "ACKNOWLEDGE" {
		c.setState(channelStateJoined)
		return
	}
	if env.Event == "UNAUTHORIZED" {
		c.setState(channelStateDeclined)
	}

	payload := map[string]interface{}{}
	if obj, ok := env.Payload.(map[string]interface{}); ok {
		payload = obj
	}

	c.subMu.RLock()
	defer c.subMu.RUnlock()
	for _, callback := range c.msgSubs {
		callback(env.Event, payload)
	}
}
