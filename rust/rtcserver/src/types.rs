use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const EVENT_CLIENT_EVENT: &str = "client.event";
pub const EVENT_BROWSER_EVENT: &str = "browser.event";
pub const EVENT_RTC_CLIENT_DISCONNECTED: &str = "rtc.client.disconnected";
pub const EVENT_ERROR: &str = "error";
pub const EVENT_INTERRUPTION_DETECTED: &str = "interruption.detected";
pub const EVENT_INTERRUPTION_FALSE_POSITIVE: &str = "interruption.false_positive";
pub const EVENT_RESPONSE_AUDIO_CLEAR: &str = "response.audio.clear";
pub const EVENT_RESPONSE_CANCELLED: &str = "response.cancelled";
pub const EVENT_RESPONSE_COMMITTED: &str = "response.committed";
pub const EVENT_RESPONSE_CREATED: &str = "response.created";
pub const EVENT_RESPONSE_DONE: &str = "response.done";
pub const EVENT_RTC_SESSION_ATTACHED: &str = "rtc.session.attached";
pub const EVENT_SESSION_CREATED: &str = "session.created";
pub const EVENT_TRANSCRIPT_COMPLETED: &str =
    "conversation.item.input_audio_transcription.completed";
pub const EVENT_TURN_STATE_CHANGED: &str = "turn.state_changed";
pub const EVENT_SPEECH_STARTED: &str = "input_audio_buffer.speech_started";
pub const EVENT_SPEECH_STOPPED: &str = "input_audio_buffer.speech_stopped";
pub const EVENT_TRANSCRIPT_DELTA: &str = "conversation.item.input_audio_transcription.delta";
pub const EVENT_TURN_EOU_PREDICTED: &str = "turn.eou.predicted";

pub type EventData = Map<String, Value>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Connected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelState {
    Idle,
    Joining,
    Joined,
    Closed,
    Declined,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RtcIceServer {
    pub urls: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionBootstrap {
    pub session_id: String,
    pub client_token: String,
    pub expires_at: String,
    #[serde(default)]
    pub join_token_ttl_seconds: u64,
    #[serde(default)]
    pub ice_servers: Vec<RtcIceServer>,
}

#[derive(Debug, Clone, Default)]
pub struct SessionConfig {
    pub stt_model: Option<String>,
    pub tts_model: Option<String>,
    pub voice: Option<String>,
    pub turn_profile: Option<String>,
    pub vad_backend: Option<String>,
    pub turn_detector: Option<String>,
    pub extra: EventData,
}

#[derive(Debug, Clone, Default)]
pub struct ResponseOptions {
    pub allow_interruptions: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct ClientEventEnvelope {
    pub event: String,
    pub payload: Value,
}

#[derive(Debug, Clone)]
pub struct WireEvent {
    pub r#type: String,
    pub data: EventData,
    pub session_id: String,
    pub channel_name: String,
}

#[derive(Debug, Clone)]
pub struct SessionAttachedEvent {
    pub session_id: String,
    pub channel_name: String,
    pub data: EventData,
}

#[derive(Debug, Clone)]
pub struct SessionCreatedEvent {
    pub session_id: String,
    pub channel_name: String,
    pub data: EventData,
    pub session: Option<EventData>,
}

#[derive(Debug, Clone)]
pub struct TranscriptEvent {
    pub session_id: String,
    pub channel_name: String,
    pub data: EventData,
    pub transcript: String,
    pub language: Option<String>,
    pub start_ms: Option<f64>,
    pub end_ms: Option<f64>,
    pub eou_probability: Option<f64>,
    pub topics: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
pub struct TurnStateEvent {
    pub session_id: String,
    pub channel_name: String,
    pub data: EventData,
    pub state: String,
    pub previous_state: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SpeechStartedEvent {
    pub session_id: String,
    pub channel_name: String,
    pub data: EventData,
    pub timestamp_ms: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct SpeechStoppedEvent {
    pub session_id: String,
    pub channel_name: String,
    pub data: EventData,
    pub timestamp_ms: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct TranscriptDeltaEvent {
    pub session_id: String,
    pub channel_name: String,
    pub data: EventData,
    pub delta: String,
    pub start_ms: Option<f64>,
    pub end_ms: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct TurnEouPredictedEvent {
    pub session_id: String,
    pub channel_name: String,
    pub data: EventData,
    pub probability: Option<f64>,
    pub threshold: Option<f64>,
    pub delay_ms: Option<f64>,
    pub start_ms: Option<f64>,
    pub end_ms: Option<f64>,
    pub decision: Option<String>,
    pub action: Option<String>,
    pub turn_detector: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ResponseEvent {
    pub session_id: String,
    pub channel_name: String,
    pub data: EventData,
    pub response_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct InterruptionEvent {
    pub response: ResponseEvent,
    pub vad_active_ms: Option<f64>,
    pub partial_transcript: Option<String>,
}

#[derive(Debug, Clone)]
pub struct BrowserEvent {
    pub session_id: String,
    pub channel_name: String,
    pub data: EventData,
    pub event: String,
    pub payload: Value,
}

#[derive(Debug, Clone)]
pub struct CloseEvent {
    pub session_id: String,
    pub channel_name: String,
    pub data: EventData,
    pub reason: String,
    pub connection_state: Option<String>,
    pub ice_connection_state: Option<String>,
    pub data_channel_state: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ErrorEvent {
    pub session_id: String,
    pub channel_name: String,
    pub data: EventData,
    pub message: Option<String>,
    pub code: Option<String>,
}

pub(crate) fn optional_string(data: &EventData, key: &str) -> Option<String> {
    data.get(key).and_then(Value::as_str).map(ToOwned::to_owned)
}

pub(crate) fn required_string(data: &EventData, key: &str, fallback: &str) -> String {
    optional_string(data, key)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| fallback.to_owned())
}

pub(crate) fn optional_number(data: &EventData, key: &str) -> Option<f64> {
    data.get(key).and_then(Value::as_f64)
}

pub(crate) fn optional_string_vec(data: &EventData, key: &str) -> Option<Vec<String>> {
    data.get(key).and_then(Value::as_array).and_then(|items| {
        items
            .iter()
            .map(|item| item.as_str().map(ToOwned::to_owned))
            .collect()
    })
}
