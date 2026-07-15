package rtcserver

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

type socketChannel interface {
	Join()
	Leave()
	SendMessage(event string, payload map[string]interface{})
	OnMessage(callback func(event string, payload map[string]interface{})) func()
	OnChannelStateChange(callback func(state channelState)) func()
}

type socketClient interface {
	Connect() error
	Disconnect() error
	GetState() bool
	CreateChannel(name string, params map[string]interface{}) socketChannel
	OnConnectionChange(callback func(connected bool)) func()
}

type Client struct {
	httpBase          string
	apiKey            string
	socketBase        string
	httpClient        *http.Client
	socketFactory     func(endpoint string, params map[string]interface{}, reconnectInterval time.Duration) (socketClient, error)
	connectionTimeout time.Duration
	joinTimeout       time.Duration
	maxReconnectDelay time.Duration
	socketParams      map[string]interface{}
	mu                sync.Mutex
	socket            socketClient
}

type ClientOptions struct {
	HTTPBase          string
	APIKey            string
	SocketBase        string
	HTTPClient        *http.Client
	ConnectionTimeout time.Duration
	JoinTimeout       time.Duration
	MaxReconnectDelay time.Duration
	SocketParams      map[string]interface{}
}

func NewClient(options ClientOptions) *Client {
	httpBase := strings.TrimRight(options.HTTPBase, "/")
	socketBase := options.SocketBase
	if socketBase == "" {
		socketBase = httpBase + "/v1/socket"
	}
	httpClient := options.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 15 * time.Second}
	}
	apiKey := strings.TrimSpace(options.APIKey)
	if apiKey == "" {
		apiKey = strings.TrimSpace(os.Getenv("VOX_API_KEY"))
	}
	socketParams := map[string]interface{}{}
	for key, value := range options.SocketParams {
		socketParams[key] = value
	}
	if apiKey != "" {
		socketParams["api_key"] = apiKey
	}

	return &Client{
		httpBase:          httpBase,
		apiKey:            apiKey,
		socketBase:        strings.TrimRight(socketBase, "/"),
		httpClient:        httpClient,
		connectionTimeout: valueOrDefaultDuration(options.ConnectionTimeout, 10*time.Second),
		joinTimeout:       valueOrDefaultDuration(options.JoinTimeout, 10*time.Second),
		maxReconnectDelay: options.MaxReconnectDelay,
		socketParams:      socketParams,
		socketFactory: func(endpoint string, params map[string]interface{}, reconnectInterval time.Duration) (socketClient, error) {
			return newRawSocketClient(endpoint, params, reconnectInterval)
		},
	}
}

func (c *Client) Connect(ctx context.Context) error {
	socket, err := c.ensureSocket()
	if err != nil {
		return err
	}
	if socket.GetState() {
		return nil
	}

	done := make(chan error, 1)
	unsub := socket.OnConnectionChange(func(connected bool) {
		if connected {
			select {
			case done <- nil:
			default:
			}
		}
	})
	defer unsub()

	if err := socket.Connect(); err != nil {
		return err
	}

	timeoutCtx, cancel := context.WithTimeout(ctx, c.connectionTimeout)
	defer cancel()

	select {
	case err := <-done:
		return err
	case <-timeoutCtx.Done():
		return fmt.Errorf("timed out waiting for PondSocket connection: %w", timeoutCtx.Err())
	}
}

func (c *Client) OnConnectionChange(handler func(connected bool)) (func(), error) {
	socket, err := c.ensureSocket()
	if err != nil {
		return nil, err
	}
	return socket.OnConnectionChange(handler), nil
}

func (c *Client) Disconnect() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.socket == nil {
		return nil
	}
	err := c.socket.Disconnect()
	c.socket = nil
	return err
}

func (c *Client) CreateSession(ctx context.Context) (*SessionBootstrap, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.httpBase+"/v1/rtc/sessions", bytes.NewBufferString(`{}`))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	if c.apiKey != "" {
		req.Header.Set("authorization", "Bearer "+c.apiKey)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var body bytes.Buffer
		_, _ = body.ReadFrom(resp.Body)
		return nil, fmt.Errorf("failed to create Vox RTC session: %s %s", resp.Status, strings.TrimSpace(body.String()))
	}

	var bootstrap SessionBootstrap
	if err := json.NewDecoder(resp.Body).Decode(&bootstrap); err != nil {
		return nil, err
	}
	return &bootstrap, nil
}

func (c *Client) AttachSession(ctx context.Context, sessionID string, options ...SessionOptions) (*ControlSession, error) {
	if err := c.Connect(ctx); err != nil {
		return nil, err
	}

	socket, err := c.ensureSocket()
	if err != nil {
		return nil, err
	}
	channel := socket.CreateChannel("/rtc/"+sessionID, map[string]interface{}{})
	joinTimeout := c.joinTimeout
	if len(options) > 0 {
		joinTimeout = valueOrDefaultDuration(options[0].JoinTimeout, joinTimeout)
	}
	session := newControlSession(channel, sessionID, joinTimeout)
	if err := session.Join(ctx); err != nil {
		return nil, err
	}
	return session, nil
}

func (c *Client) CreateControlledSession(ctx context.Context, options ...SessionOptions) (*SessionBootstrap, *ControlSession, error) {
	bootstrap, err := c.CreateSession(ctx)
	if err != nil {
		return nil, nil, err
	}
	session, err := c.AttachSession(ctx, bootstrap.SessionID, options...)
	if err != nil {
		return nil, nil, err
	}
	return bootstrap, session, nil
}

func (c *Client) ensureSocket() (socketClient, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.socket != nil {
		return c.socket, nil
	}
	socket, err := c.socketFactory(c.socketBase, c.socketParams, c.maxReconnectDelay)
	if err != nil {
		return nil, err
	}
	c.socket = socket
	return c.socket, nil
}

func valueOrDefaultDuration(value, fallback time.Duration) time.Duration {
	if value > 0 {
		return value
	}
	return fallback
}
