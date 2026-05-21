package rtcserver

import pondsocket "github.com/eleven-am/pondsocket/go/pondsocket-client"

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
}

func newRawSocketClient(endpoint string, params map[string]interface{}) (*rawSocketClient, error) {
	client, err := pondsocket.NewPondClient(endpoint, params)
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
	return &rawSocketChannel{
		channel: c.client.CreateChannel(name, pondsocket.JoinParams(params)),
	}
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
	return c.channel.OnChannelStateChange(func(state pondsocket.ChannelState) {
		callback(mapChannelState(state))
	})
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
	default:
		return channelState(state)
	}
}
