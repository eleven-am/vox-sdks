use crate::error::{Result, VoxRtcError};
use crate::socket::RawSocketChannel;
use crate::types::*;
use serde_json::Value;
use tokio::task::JoinHandle;
use tokio::time::{Duration, timeout};

#[derive(Clone)]
pub struct VoxRtcControlSession {
    channel: RawSocketChannel,
    session_id: String,
    channel_name: String,
    join_timeout: Duration,
}

pub struct Listener {
    handle: JoinHandle<()>,
}

impl Drop for Listener {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

impl VoxRtcControlSession {
    pub(crate) fn new(
        channel: RawSocketChannel,
        session_id: String,
        join_timeout: Duration,
    ) -> Self {
        let channel_name = format!("/rtc/{session_id}");
        Self {
            channel,
            session_id,
            channel_name,
            join_timeout,
        }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn channel_name(&self) -> &str {
        &self.channel_name
    }

    pub async fn join(&self) -> Result<()> {
        let mut states = self.channel.subscribe_state();
        self.channel.join().await?;
        let channel_name = self.channel.name().to_owned();
        timeout(self.join_timeout, async move {
            loop {
                let state = *states.borrow_and_update();
                match state {
                    ChannelState::Joined => return Ok(()),
                    ChannelState::Closed | ChannelState::Declined => {
                        return Err(VoxRtcError::JoinFailed {
                            channel: channel_name,
                            state: format!("{state:?}"),
                        });
                    }
                    _ => {}
                }
                if states.changed().await.is_err() {
                    return Err(VoxRtcError::Disconnected);
                }
            }
        })
        .await
        .map_err(|_| VoxRtcError::JoinTimeout(self.channel_name.clone()))?
    }

    pub async fn close(&self) -> Result<()> {
        self.channel.leave().await
    }

    pub fn on_event<F>(&self, handler: F) -> Listener
    where
        F: Fn(WireEvent) + Send + Sync + 'static,
    {
        let mut messages = self.channel.subscribe_messages();
        let session_id = self.session_id.clone();
        let channel_name = self.channel_name.clone();
        Listener {
            handle: tokio::spawn(async move {
                while let Ok((event, payload)) = messages.recv().await {
                    handler(WireEvent {
                        r#type: event,
                        data: payload,
                        session_id: session_id.clone(),
                        channel_name: channel_name.clone(),
                    });
                }
            }),
        }
    }

    pub fn on<F>(&self, event_name: impl Into<String>, handler: F) -> Listener
    where
        F: Fn(EventData) + Send + Sync + 'static,
    {
        let event_name = event_name.into();
        let mut messages = self.channel.subscribe_messages();
        Listener {
            handle: tokio::spawn(async move {
                while let Ok((event, payload)) = messages.recv().await {
                    if event == event_name {
                        handler(payload);
                    }
                }
            }),
        }
    }

    pub fn on_session_attached<F>(&self, handler: F) -> Listener
    where
        F: Fn(SessionAttachedEvent) + Send + Sync + 'static,
    {
        let session_id = self.session_id.clone();
        let channel_name = self.channel_name.clone();
        self.on(EVENT_RTC_SESSION_ATTACHED, move |payload| {
            handler(SessionAttachedEvent {
                session_id: base_session_id(&payload, &session_id),
                channel_name: channel_name.clone(),
                data: payload,
            })
        })
    }

    pub fn on_session_created<F>(&self, handler: F) -> Listener
    where
        F: Fn(SessionCreatedEvent) + Send + Sync + 'static,
    {
        let session_id = self.session_id.clone();
        let channel_name = self.channel_name.clone();
        self.on(EVENT_SESSION_CREATED, move |payload| {
            let session = payload.get("session").and_then(Value::as_object).cloned();
            handler(SessionCreatedEvent {
                session_id: base_session_id(&payload, &session_id),
                channel_name: channel_name.clone(),
                data: payload,
                session,
            });
        })
    }

    pub fn on_transcript<F>(&self, handler: F) -> Listener
    where
        F: Fn(TranscriptEvent) + Send + Sync + 'static,
    {
        let session_id = self.session_id.clone();
        let channel_name = self.channel_name.clone();
        self.on(EVENT_TRANSCRIPT_COMPLETED, move |payload| {
            handler(TranscriptEvent {
                session_id: base_session_id(&payload, &session_id),
                channel_name: channel_name.clone(),
                transcript: required_string(&payload, "transcript", ""),
                language: optional_string(&payload, "language"),
                start_ms: optional_number(&payload, "start_ms"),
                end_ms: optional_number(&payload, "end_ms"),
                eou_probability: optional_number(&payload, "eou_probability"),
                topics: optional_string_vec(&payload, "topics"),
                data: payload,
            });
        })
    }

    pub fn on_turn_state_changed<F>(&self, handler: F) -> Listener
    where
        F: Fn(TurnStateEvent) + Send + Sync + 'static,
    {
        let session_id = self.session_id.clone();
        let channel_name = self.channel_name.clone();
        self.on(EVENT_TURN_STATE_CHANGED, move |payload| {
            handler(TurnStateEvent {
                session_id: base_session_id(&payload, &session_id),
                channel_name: channel_name.clone(),
                state: required_string(&payload, "state", "unknown"),
                previous_state: optional_string(&payload, "previous_state"),
                data: payload,
            });
        })
    }

    pub fn on_response_created<F>(&self, handler: F) -> Listener
    where
        F: Fn(ResponseEvent) + Send + Sync + 'static,
    {
        self.on_response_event(EVENT_RESPONSE_CREATED, handler)
    }

    pub fn on_response_committed<F>(&self, handler: F) -> Listener
    where
        F: Fn(ResponseEvent) + Send + Sync + 'static,
    {
        self.on_response_event(EVENT_RESPONSE_COMMITTED, handler)
    }

    pub fn on_response_done<F>(&self, handler: F) -> Listener
    where
        F: Fn(ResponseEvent) + Send + Sync + 'static,
    {
        self.on_response_event(EVENT_RESPONSE_DONE, handler)
    }

    pub fn on_response_cancelled<F>(&self, handler: F) -> Listener
    where
        F: Fn(ResponseEvent) + Send + Sync + 'static,
    {
        self.on_response_event(EVENT_RESPONSE_CANCELLED, handler)
    }

    pub fn on_response_audio_clear<F>(&self, handler: F) -> Listener
    where
        F: Fn(ResponseEvent) + Send + Sync + 'static,
    {
        self.on_response_event(EVENT_RESPONSE_AUDIO_CLEAR, handler)
    }

    fn on_response_event<F>(&self, event_name: &'static str, handler: F) -> Listener
    where
        F: Fn(ResponseEvent) + Send + Sync + 'static,
    {
        let session_id = self.session_id.clone();
        let channel_name = self.channel_name.clone();
        self.on(event_name, move |payload| {
            handler(response_event(payload, &session_id, &channel_name));
        })
    }

    pub fn on_interruption_detected<F>(&self, handler: F) -> Listener
    where
        F: Fn(InterruptionEvent) + Send + Sync + 'static,
    {
        self.on_interruption_event(EVENT_INTERRUPTION_DETECTED, handler)
    }

    pub fn on_interruption_false_positive<F>(&self, handler: F) -> Listener
    where
        F: Fn(InterruptionEvent) + Send + Sync + 'static,
    {
        self.on_interruption_event(EVENT_INTERRUPTION_FALSE_POSITIVE, handler)
    }

    fn on_interruption_event<F>(&self, event_name: &'static str, handler: F) -> Listener
    where
        F: Fn(InterruptionEvent) + Send + Sync + 'static,
    {
        let session_id = self.session_id.clone();
        let channel_name = self.channel_name.clone();
        self.on(event_name, move |payload| {
            handler(InterruptionEvent {
                response: response_event(payload.clone(), &session_id, &channel_name),
                vad_active_ms: optional_number(&payload, "vad_active_ms"),
                partial_transcript: optional_string(&payload, "partial_transcript"),
            });
        })
    }

    pub fn on_browser_event<F>(&self, handler: F) -> Listener
    where
        F: Fn(BrowserEvent) + Send + Sync + 'static,
    {
        let session_id = self.session_id.clone();
        let channel_name = self.channel_name.clone();
        self.on(EVENT_BROWSER_EVENT, move |payload| {
            handler(BrowserEvent {
                session_id: base_session_id(&payload, &session_id),
                channel_name: channel_name.clone(),
                event: required_string(&payload, "event", ""),
                payload: payload.get("payload").cloned().unwrap_or(Value::Null),
                data: payload,
            });
        })
    }

    pub fn on_close<F>(&self, handler: F) -> Listener
    where
        F: Fn(CloseEvent) + Send + Sync + 'static,
    {
        let session_id = self.session_id.clone();
        let channel_name = self.channel_name.clone();
        self.on(EVENT_RTC_CLIENT_DISCONNECTED, move |payload| {
            handler(CloseEvent {
                session_id: base_session_id(&payload, &session_id),
                channel_name: channel_name.clone(),
                reason: required_string(&payload, "reason", "unknown"),
                connection_state: optional_string(&payload, "connection_state"),
                ice_connection_state: optional_string(&payload, "ice_connection_state"),
                data_channel_state: optional_string(&payload, "data_channel_state"),
                data: payload,
            });
        })
    }

    pub fn on_error<F>(&self, handler: F) -> Listener
    where
        F: Fn(ErrorEvent) + Send + Sync + 'static,
    {
        let session_id = self.session_id.clone();
        let channel_name = self.channel_name.clone();
        self.on(EVENT_ERROR, move |payload| {
            handler(ErrorEvent {
                session_id: base_session_id(&payload, &session_id),
                channel_name: channel_name.clone(),
                message: optional_string(&payload, "message"),
                code: optional_string(&payload, "code"),
                data: payload,
            });
        })
    }

    pub async fn send_control(&self, event: &str, payload: EventData) -> Result<()> {
        self.channel.send_message(event, payload).await
    }

    pub async fn configure(&self, config: SessionConfig) -> Result<()> {
        let mut session = config.extra;
        insert_opt(&mut session, "stt_model", config.stt_model);
        insert_opt(&mut session, "tts_model", config.tts_model);
        insert_opt(&mut session, "voice", config.voice);
        insert_opt(&mut session, "turn_profile", config.turn_profile);
        insert_opt(&mut session, "vad_backend", config.vad_backend);
        insert_opt(&mut session, "turn_detector", config.turn_detector);

        let mut payload = EventData::new();
        payload.insert("session".to_owned(), Value::Object(session));
        self.send_control("session.update", payload).await
    }

    pub async fn start_response(&self, options: Option<ResponseOptions>) -> Result<()> {
        self.send_control("response.start", response_options_payload(options))
            .await
    }

    pub async fn append_response_text(
        &self,
        delta: impl Into<String>,
        options: Option<ResponseOptions>,
    ) -> Result<()> {
        let mut payload = response_options_payload(options);
        payload.insert("delta".to_owned(), Value::String(delta.into()));
        self.send_control("response.delta", payload).await
    }

    pub async fn commit_response(&self) -> Result<()> {
        self.send_control("response.commit", EventData::new()).await
    }

    pub async fn cancel_response(&self) -> Result<()> {
        self.send_control("response.cancel", EventData::new()).await
    }

    pub async fn replace_response_text(
        &self,
        text: impl Into<String>,
        options: Option<ResponseOptions>,
    ) -> Result<()> {
        let mut payload = response_options_payload(options);
        payload.insert("text".to_owned(), Value::String(text.into()));
        self.send_control("response.replace_text", payload).await
    }

    pub async fn send_text_response(
        &self,
        text: impl Into<String>,
        options: Option<ResponseOptions>,
        cancel_first: bool,
    ) -> Result<()> {
        let text = text.into();
        if cancel_first {
            return self.replace_response_text(text, options).await;
        }
        self.start_response(options.clone()).await?;
        self.append_response_text(text, options).await?;
        self.commit_response().await
    }

    pub async fn send_client_event(&self, envelope: ClientEventEnvelope) -> Result<()> {
        let mut payload = EventData::new();
        payload.insert("event".to_owned(), Value::String(envelope.event));
        payload.insert("payload".to_owned(), envelope.payload);
        self.send_control(EVENT_CLIENT_EVENT, payload).await
    }
}

fn insert_opt(session: &mut EventData, key: &str, value: Option<String>) {
    if let Some(value) = value {
        session.insert(key.to_owned(), Value::String(value));
    }
}

fn response_options_payload(options: Option<ResponseOptions>) -> EventData {
    let mut payload = EventData::new();
    if let Some(options) = options
        && let Some(allow) = options.allow_interruptions
    {
        payload.insert("allow_interruptions".to_owned(), Value::Bool(allow));
    }
    payload
}

fn base_session_id(payload: &EventData, fallback: &str) -> String {
    required_string(payload, "session_id", fallback)
}

fn response_event(payload: EventData, session_id: &str, channel_name: &str) -> ResponseEvent {
    ResponseEvent {
        session_id: base_session_id(&payload, session_id),
        channel_name: channel_name.to_owned(),
        response_id: optional_string(&payload, "response_id"),
        data: payload,
    }
}
