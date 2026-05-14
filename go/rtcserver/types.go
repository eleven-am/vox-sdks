package rtcserver

type RTCIceServer struct {
	URLs       interface{} `json:"urls"`
	Username   string      `json:"username,omitempty"`
	Credential string      `json:"credential,omitempty"`
}

type SessionBootstrap struct {
	SessionID           string         `json:"session_id"`
	ClientToken         string         `json:"client_token"`
	ExpiresAt           string         `json:"expires_at"`
	JoinTokenTTLSeconds int            `json:"join_token_ttl_seconds"`
	ICEServers          []RTCIceServer `json:"ice_servers"`
}

type SessionConfig struct {
	STTModel     string                 `json:"-"`
	TTSModel     string                 `json:"-"`
	Voice        string                 `json:"-"`
	TurnProfile  string                 `json:"-"`
	VADBackend   string                 `json:"-"`
	TurnDetector string                 `json:"-"`
	Extra        map[string]interface{} `json:"-"`
}

type ResponseOptions struct {
	AllowInterruptions *bool
}

type ClientEvent struct {
	Event   string
	Payload interface{}
}

type WireEvent struct {
	Type        string
	Data        map[string]interface{}
	SessionID   string
	ChannelName string
}
