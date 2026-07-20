package rtcserver

import (
	"sync"
	"time"

	pondsocket "github.com/eleven-am/pondsocket/go/pondsocket-client"
)

type channelState string

const (
	channelStateIdle     channelState = "IDLE"
	channelStateJoining  channelState = "JOINING"
	channelStateJoined   channelState = "JOINED"
	channelStateClosed   channelState = "CLOSED"
	channelStateDeclined channelState = "DECLINED"
)

type rawSocketClient struct {
	client *pondsocket.PondClient
}

type rawSocketChannel struct {
	channel *pondsocket.Channel

	mu            sync.Mutex
	declined      bool
	joinError     string
	stateHandlers map[int]func(channelState)
	nextHandlerID int
}

func newRawSocketClient(endpoint string, params map[string]interface{}, reconnectInterval time.Duration) (*rawSocketClient, error) {
	config := pondsocket.DefaultClientConfig()
	if reconnectInterval > 0 {
		config.ReconnectInterval = reconnectInterval
	}
	client, err := pondsocket.NewPondClientWithConfig(endpoint, params, config)
	if err != nil {
		return nil, err
	}
	return &rawSocketClient{client: client}, nil
}

func (c *rawSocketClient) Connect() error {
	return c.client.Connect()
}

func (c *rawSocketClient) Disconnect() error {
	return c.client.Disconnect()
}

func (c *rawSocketClient) GetState() bool {
	return c.client.GetState()
}

func (c *rawSocketClient) CreateChannel(name string, params map[string]interface{}) socketChannel {
	channel := &rawSocketChannel{
		channel:       c.client.CreateChannel(name, pondsocket.JoinParams(params)),
		stateHandlers: map[int]func(channelState){},
	}
	channel.watchDecline()
	return channel
}

func (c *rawSocketClient) OnConnectionChange(callback func(connected bool)) func() {
	return c.client.OnConnectionChange(callback)
}

func (c *rawSocketChannel) Join() {
	c.channel.Join()
}

func (c *rawSocketChannel) Leave() {
	c.channel.Leave()
}

func (c *rawSocketChannel) SendMessage(event string, payload map[string]interface{}) {
	if payload == nil {
		payload = map[string]interface{}{}
	}
	c.channel.SendMessage(event, pondsocket.PondMessage(payload))
}

func (c *rawSocketChannel) OnMessage(callback func(event string, payload map[string]interface{})) func() {
	return c.channel.OnMessage(func(event string, payload pondsocket.PondMessage) {
		callback(event, map[string]interface{}(payload))
	})
}

func (c *rawSocketChannel) OnChannelStateChange(callback func(state channelState)) func() {
	c.mu.Lock()
	id := c.nextHandlerID
	c.nextHandlerID++
	c.stateHandlers[id] = callback
	declined := c.declined
	c.mu.Unlock()

	unsub := c.channel.OnChannelStateChange(func(state pondsocket.ChannelState) {
		mapped := mapChannelState(state)
		if mapped == channelStateDeclined {
			return
		}
		callback(mapped)
	})

	if declined {
		callback(channelStateDeclined)
	}

	return func() {
		c.mu.Lock()
		delete(c.stateHandlers, id)
		c.mu.Unlock()
		unsub()
	}
}

func (c *rawSocketChannel) JoinError() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.joinError
}

func (c *rawSocketChannel) watchDecline() {
	c.channel.OnMessage(func(event string, payload pondsocket.PondMessage) {
		if event != string(pondsocket.EventUnauthorized) && event != string(pondsocket.EventNotFound) {
			return
		}
		c.mu.Lock()
		if c.declined {
			c.mu.Unlock()
			return
		}
		c.declined = true
		c.joinError = declineReason(payload)
		handlers := make([]func(channelState), 0, len(c.stateHandlers))
		for _, handler := range c.stateHandlers {
			handlers = append(handlers, handler)
		}
		c.mu.Unlock()
		for _, handler := range handlers {
			handler(channelStateDeclined)
		}
	})
}

func declineReason(payload pondsocket.PondMessage) string {
	if message, ok := payload["message"].(string); ok {
		return message
	}
	return ""
}

func mapChannelState(state pondsocket.ChannelState) channelState {
	switch state {
	case pondsocket.Joining:
		return channelStateJoining
	case pondsocket.Joined:
		return channelStateJoined
	case pondsocket.Closed:
		return channelStateClosed
	case pondsocket.Idle:
		return channelStateIdle
	case pondsocket.Declined:
		return channelStateDeclined
	default:
		return channelState(state)
	}
}
