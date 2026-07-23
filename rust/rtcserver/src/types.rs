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
pub const EVENT_RTC_SIGNALING_ERROR: &str = "rtc.signaling_error";
pub const EVENT_SESSION_CREATED: &str = "session.created";
pub const EVENT_TRANSCRIPT_COMPLETED: &str =
    "conversation.item.input_audio_transcription.completed";
pub const EVENT_TURN_STATE_CHANGED: &str = "turn.state_changed";
pub const EVENT_SPEECH_STARTED: &str = "input_audio_buffer.speech_started";
pub const EVENT_SPEECH_STOPPED: &str = "input_audio_buffer.speech_stopped";
pub const EVENT_TRANSCRIPT_DELTA: &str = "conversation.item.input_audio_transcription.delta";
pub const EVENT_TURN_EOU_PREDICTED: &str = "turn.eou.predicted";

pub const ERROR_CODE_RESPONSE_REJECTED_TURN_STATE: &str = "response_rejected_turn_state";
pub const ERROR_CODE_RESPONSE_REJECTED_USER_SPEECH: &str = "response_rejected_user_speech";
pub const ERROR_CODE_RESPONSE_STALE_GENERATION: &str = "response_stale_generation";
pub const ERROR_CODE_RESPONSE_ALREADY_ACTIVE: &str = "response_already_active";
pub const ERROR_CODE_RESPONSE_FAILED: &str = "response_failed";
pub const ERROR_CODE_COMMAND_INVALID: &str = "command_invalid";
pub const ERROR_CODE_SESSION_FAILED: &str = "session_failed";

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
    pub expires_at: String,
    #[serde(default)]
    pub attach_ttl_seconds: u64,
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
    pub speech_context: Option<bool>,
    pub extra: EventData,
}

#[derive(Debug, Clone, Default)]
pub struct ResponseOptions {
    pub allow_interruptions: Option<bool>,
    pub generation_id: Option<String>,
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
    pub entities: Vec<TranscriptEntity>,
    pub words: Vec<TranscriptWord>,
    pub speech_context: Option<SpeechContext>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptEntity {
    pub r#type: String,
    pub text: String,
    pub start_char: u64,
    pub end_char: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptWord {
    pub word: String,
    pub start_ms: f64,
    pub end_ms: f64,
    pub confidence: Option<f64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpeechContextStatus {
    Complete,
    Partial,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpeechContextTrack {
    Speaker,
    Sounds,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SpeechContextSpan {
    pub label: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpeechContextSoundSpan {
    #[serde(flatten)]
    pub span: SpeechContextSpan,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpeechContext {
    pub schema_version: u8,
    pub status: SpeechContextStatus,
    #[serde(default)]
    pub emotions: Option<Vec<SpeechContextSpan>>,
    #[serde(default)]
    pub vocal: Option<Vec<SpeechContextSpan>>,
    #[serde(default)]
    pub sounds: Option<Vec<SpeechContextSoundSpan>>,
    #[serde(default)]
    pub unavailable: Option<Vec<SpeechContextTrack>>,
}

impl SpeechContext {
    pub(crate) fn is_valid(&self) -> bool {
        if self.schema_version != 2
            || !self
                .emotions
                .iter()
                .flatten()
                .all(|span| !span.label.is_empty() && span.end_ms > span.start_ms)
            || !self
                .vocal
                .iter()
                .flatten()
                .all(|span| !span.label.is_empty() && span.end_ms > span.start_ms)
            || !self.sounds.iter().flatten().all(|sound| {
                !sound.span.label.is_empty()
                    && sound.span.end_ms > sound.span.start_ms
                    && sound.score.is_finite()
                    && (0.0..=1.0).contains(&sound.score)
            })
        {
            return false;
        }
        let unavailable = self.unavailable.as_deref().unwrap_or_default();
        let unique = unavailable
            .iter()
            .enumerate()
            .all(|(index, track)| !unavailable[..index].contains(track));
        if !unique {
            return false;
        }
        let speaker_unavailable = unavailable.contains(&SpeechContextTrack::Speaker);
        let sounds_unavailable = unavailable.contains(&SpeechContextTrack::Sounds);
        match self.status {
            SpeechContextStatus::Complete => {
                self.emotions.is_some()
                    && self.vocal.is_some()
                    && self.sounds.is_some()
                    && self.unavailable.is_none()
            }
            SpeechContextStatus::Partial => {
                unavailable.len() == 1
                    && speaker_unavailable == self.emotions.is_none()
                    && speaker_unavailable == self.vocal.is_none()
                    && sounds_unavailable == self.sounds.is_none()
            }
            SpeechContextStatus::Failed => {
                unavailable.len() == 2
                    && speaker_unavailable
                    && sounds_unavailable
                    && self.emotions.is_none()
                    && self.vocal.is_none()
                    && self.sounds.is_none()
            }
        }
    }
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
    pub generation_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct InterruptionEvent {
    pub response: ResponseEvent,
    pub vad_active_ms: Option<f64>,
    pub partial_transcript: Option<String>,
    pub reason: Option<String>,
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
    pub recoverable: bool,
    pub generation_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SignalingErrorEvent {
    pub session_id: String,
    pub channel_name: String,
    pub data: EventData,
    pub message: Option<String>,
    pub generation: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct StartAck {
    pub accepted: bool,
    pub generation_id: String,
    pub response_id: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub recoverable: bool,
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

pub(crate) fn optional_i64(data: &EventData, key: &str) -> Option<i64> {
    data.get(key).and_then(Value::as_i64)
}

pub(crate) fn optional_nonempty_string(data: &EventData, key: &str) -> Option<String> {
    optional_string(data, key).filter(|s| !s.is_empty())
}

pub(crate) fn recoverable_flag(data: &EventData) -> bool {
    data.get("recoverable").and_then(Value::as_bool).unwrap_or(true)
}

pub(crate) fn optional_string_vec(data: &EventData, key: &str) -> Option<Vec<String>> {
    data.get(key).and_then(Value::as_array).and_then(|items| {
        items
            .iter()
            .map(|item| item.as_str().map(ToOwned::to_owned))
            .collect()
    })
}

pub(crate) fn transcript_entities(data: &EventData) -> Vec<TranscriptEntity> {
    data.get("entities")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(transcript_entity).collect())
        .unwrap_or_default()
}

fn transcript_entity(value: &Value) -> Option<TranscriptEntity> {
    let object = value.as_object()?;
    Some(TranscriptEntity {
        r#type: optional_string(object, "type").unwrap_or_default(),
        text: optional_string(object, "text").unwrap_or_default(),
        start_char: object.get("start_char").and_then(Value::as_u64).unwrap_or(0),
        end_char: object.get("end_char").and_then(Value::as_u64).unwrap_or(0),
    })
}

pub(crate) fn transcript_words(data: &EventData) -> Vec<TranscriptWord> {
    data.get("words")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(transcript_word).collect())
        .unwrap_or_default()
}

fn transcript_word(value: &Value) -> Option<TranscriptWord> {
    let object = value.as_object()?;
    Some(TranscriptWord {
        word: optional_string(object, "word").unwrap_or_default(),
        start_ms: optional_number(object, "start_ms").unwrap_or(0.0),
        end_ms: optional_number(object, "end_ms").unwrap_or(0.0),
        confidence: optional_number(object, "confidence"),
    })
}
