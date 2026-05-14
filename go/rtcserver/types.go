package rtcserver

const (
	EventClientEvent               = "client.event"
	EventBrowserEvent              = "browser.event"
	EventRTCClientDisconnected     = "rtc.client.disconnected"
	EventError                     = "error"
	EventInterruptionDetected      = "interruption.detected"
	EventInterruptionFalsePositive = "interruption.false_positive"
	EventResponseAudioClear        = "response.audio.clear"
	EventResponseCancelled         = "response.cancelled"
	EventResponseCommitted         = "response.committed"
	EventResponseCreated           = "response.created"
	EventResponseDone              = "response.done"
	EventRTCSessionAttached        = "rtc.session.attached"
	EventSessionCreated            = "session.created"
	EventTranscriptCompleted       = "conversation.item.input_audio_transcription.completed"
	EventTurnStateChanged          = "turn.state_changed"
)

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

type SessionAttachedEvent struct {
	SessionID   string
	ChannelName string
	Data        map[string]interface{}
}

type SessionCreatedEvent struct {
	SessionID   string
	ChannelName string
	Data        map[string]interface{}
	Session     map[string]interface{}
}

type TranscriptEvent struct {
	SessionID      string
	ChannelName    string
	Data           map[string]interface{}
	Transcript     string
	Language       string
	StartMS        float64
	EndMS          float64
	EOUProbability float64
	Topics         []string
}

type TurnStateEvent struct {
	SessionID     string
	ChannelName   string
	Data          map[string]interface{}
	State         string
	PreviousState string
}

type ResponseEvent struct {
	SessionID   string
	ChannelName string
	Data        map[string]interface{}
	ResponseID  string
}

type InterruptionEvent struct {
	ResponseEvent
	VADActiveMS       float64
	PartialTranscript string
}

type BrowserEvent struct {
	SessionID   string
	ChannelName string
	Data        map[string]interface{}
	Event       string
	Payload     interface{}
}

type CloseEvent struct {
	SessionID          string
	ChannelName        string
	Data               map[string]interface{}
	Reason             string
	ConnectionState    string
	ICEConnectionState string
	DataChannelState   string
}

type ErrorEvent struct {
	SessionID   string
	ChannelName string
	Data        map[string]interface{}
	Message     string
	Code        string
}
