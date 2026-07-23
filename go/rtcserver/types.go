package rtcserver

import "time"

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
	EventRTCSignalingError         = "rtc.signaling_error"
	EventRTCAnswer                 = "rtc.answer"
	EventRTCIceCandidate           = "rtc.ice_candidate"
	EventRTCSessionClosed          = "rtc.session.closed"
	EventSessionCreated            = "session.created"
	EventSpeechStarted             = "input_audio_buffer.speech_started"
	EventSpeechStopped             = "input_audio_buffer.speech_stopped"
	EventTranscriptCompleted       = "conversation.item.input_audio_transcription.completed"
	EventTranscriptDelta           = "conversation.item.input_audio_transcription.delta"
	EventTurnEouPredicted          = "turn.eou.predicted"
	EventTurnStateChanged          = "turn.state_changed"
)

const (
	ErrorCodeResponseRejectedTurnState  = "response_rejected_turn_state"
	ErrorCodeResponseRejectedUserSpeech = "response_rejected_user_speech"
	ErrorCodeResponseStaleGeneration    = "response_stale_generation"
	ErrorCodeResponseAlreadyActive      = "response_already_active"
	ErrorCodeResponseFailed             = "response_failed"
	ErrorCodeCommandInvalid             = "command_invalid"
	ErrorCodeSessionFailed              = "session_failed"
)

type RTCIceServer struct {
	URLs       interface{} `json:"urls"`
	Username   string      `json:"username,omitempty"`
	Credential string      `json:"credential,omitempty"`
}

type SessionBootstrap struct {
	SessionID        string         `json:"session_id"`
	ExpiresAt        string         `json:"expires_at"`
	AttachTTLSeconds int            `json:"attach_ttl_seconds"`
	ICEServers       []RTCIceServer `json:"ice_servers"`
}

type RTCSessionDescription struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
}

type RTCIceCandidate struct {
	Candidate        string  `json:"candidate"`
	SDPMid           *string `json:"sdpMid"`
	SDPMLineIndex    *uint32 `json:"sdpMLineIndex"`
	UsernameFragment *string `json:"usernameFragment"`
}

type SessionConfig struct {
	STTModel      string                 `json:"-"`
	TTSModel      string                 `json:"-"`
	Voice         string                 `json:"-"`
	TurnProfile   string                 `json:"-"`
	VADBackend    string                 `json:"-"`
	TurnDetector  string                 `json:"-"`
	SpeechContext *bool                  `json:"-"`
	Extra         map[string]interface{} `json:"-"`
}

type SessionOptions struct {
	JoinTimeout time.Duration
}

type ResponseOptions struct {
	AllowInterruptions *bool
	GenerationID       string
	Output             *ResponseOutputOptions
}

type ResponseOutputOptions struct {
	Model    string
	Voice    string
	Language string
	Speed    *float64
	Params   map[string]interface{}
}

type ResponseOutput struct {
	Model    string
	Voice    string
	Language string
	Speed    float64
	Params   map[string]interface{}
}

type StartAck struct {
	Accepted     bool
	ResponseID   string
	GenerationID string
	Output       *ResponseOutput
	Error        *ErrorEvent
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

type TranscriptEntity struct {
	Type      string
	Text      string
	StartChar int
	EndChar   int
}

type TranscriptWord struct {
	Word       string
	StartMS    float64
	EndMS      float64
	Confidence *float64
}

type SpeechContextStatus string

const (
	SpeechContextComplete SpeechContextStatus = "complete"
	SpeechContextPartial  SpeechContextStatus = "partial"
	SpeechContextFailed   SpeechContextStatus = "failed"
)

type SpeechContextTrack string

const (
	SpeechContextSpeaker SpeechContextTrack = "speaker"
	SpeechContextSounds  SpeechContextTrack = "sounds"
)

type SpeechContextSpan struct {
	Label   string `json:"label"`
	StartMS int64  `json:"start_ms"`
	EndMS   int64  `json:"end_ms"`
}

type SpeechContextSoundSpan struct {
	SpeechContextSpan
	Score float64 `json:"score"`
}

type SpeechContext struct {
	SchemaVersion int                      `json:"schema_version"`
	Status        SpeechContextStatus      `json:"status"`
	Emotions      []SpeechContextSpan      `json:"emotions,omitempty"`
	Vocal         []SpeechContextSpan      `json:"vocal,omitempty"`
	Sounds        []SpeechContextSoundSpan `json:"sounds,omitempty"`
	Unavailable   []SpeechContextTrack     `json:"unavailable,omitempty"`
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
	Entities       []TranscriptEntity
	Words          []TranscriptWord
	SpeechContext  *SpeechContext
}

type TurnStateEvent struct {
	SessionID     string
	ChannelName   string
	Data          map[string]interface{}
	State         string
	PreviousState string
}

type SpeechStartedEvent struct {
	SessionID   string
	ChannelName string
	Data        map[string]interface{}
	TimestampMS float64
}

type SpeechStoppedEvent struct {
	SessionID   string
	ChannelName string
	Data        map[string]interface{}
	TimestampMS float64
}

type TranscriptDeltaEvent struct {
	SessionID   string
	ChannelName string
	Data        map[string]interface{}
	Delta       string
	StartMS     float64
	EndMS       float64
}

type TurnEouPredictedEvent struct {
	SessionID    string
	ChannelName  string
	Data         map[string]interface{}
	Probability  float64
	Threshold    float64
	DelayMS      float64
	StartMS      float64
	EndMS        float64
	Decision     string
	Action       string
	TurnDetector string
}

type ResponseEvent struct {
	SessionID    string
	ChannelName  string
	Data         map[string]interface{}
	ResponseID   string
	GenerationID string
	Output       *ResponseOutput
}

type InterruptionEvent struct {
	ResponseEvent
	VADActiveMS       float64
	PartialTranscript string
	Reason            string
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
	SessionID    string
	ChannelName  string
	Data         map[string]interface{}
	Message      string
	Code         string
	Recoverable  bool
	GenerationID string
}

type SignalingErrorEvent struct {
	SessionID   string
	ChannelName string
	Data        map[string]interface{}
	Message     string
	Generation  *int
}
