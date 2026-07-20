use crate::error::{Result, VoxRtcError};
use crate::socket::RawSocketChannel;
use crate::types::*;
use serde_json::Value;
use std::ops::ControlFlow;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast::error::RecvError;
use uuid::Uuid;
use tokio::task::JoinHandle;
use tokio::time::{Duration, timeout};

#[derive(Clone)]
pub struct VoxRtcControlSession {
    channel: RawSocketChannel,
    session_id: String,
    channel_name: String,
    join_timeout: Duration,
    response_generation: Arc<Mutex<ResponseGeneration>>,
}

#[derive(Default)]
struct ResponseGeneration {
    counter: u64,
    id: Option<String>,
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
            response_generation: Arc::new(Mutex::new(ResponseGeneration::default())),
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
        let channel = self.channel.clone();
        timeout(self.join_timeout, async move {
            loop {
                let state = *states.borrow_and_update();
                match state {
                    ChannelState::Joined => return Ok(()),
                    ChannelState::Closed | ChannelState::Declined => {
                        let reason = join_decline_reason(channel.decline_reason().await);
                        return Err(VoxRtcError::JoinFailed {
                            channel: channel_name,
                            state: format!("{state:?}"),
                            reason,
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
                loop {
                    match next_message(messages.recv().await) {
                        ControlFlow::Break(()) => break,
                        ControlFlow::Continue(None) => continue,
                        ControlFlow::Continue(Some((event, payload))) => handler(WireEvent {
                            r#type: event,
                            data: payload,
                            session_id: session_id.clone(),
                            channel_name: channel_name.clone(),
                        }),
                    }
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
                loop {
                    match next_message(messages.recv().await) {
                        ControlFlow::Break(()) => break,
                        ControlFlow::Continue(None) => continue,
                        ControlFlow::Continue(Some((event, payload))) => {
                            if event == event_name {
                                handler(payload);
                            }
                        }
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
                session_id: session_id.clone(),
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
                session_id: session_id.clone(),
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
                session_id: session_id.clone(),
                channel_name: channel_name.clone(),
                transcript: required_string(&payload, "transcript", ""),
                language: optional_string(&payload, "language"),
                start_ms: optional_number(&payload, "start_ms"),
                end_ms: optional_number(&payload, "end_ms"),
                eou_probability: optional_number(&payload, "eou_probability"),
                topics: optional_string_vec(&payload, "topics"),
                entities: transcript_entities(&payload),
                words: transcript_words(&payload),
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
                session_id: session_id.clone(),
                channel_name: channel_name.clone(),
                state: required_string(&payload, "state", "unknown"),
                previous_state: optional_string(&payload, "previous_state"),
                data: payload,
            });
        })
    }

    pub fn on_speech_started<F>(&self, handler: F) -> Listener
    where
        F: Fn(SpeechStartedEvent) + Send + Sync + 'static,
    {
        let session_id = self.session_id.clone();
        let channel_name = self.channel_name.clone();
        self.on(EVENT_SPEECH_STARTED, move |payload| {
            handler(SpeechStartedEvent {
                session_id: session_id.clone(),
                channel_name: channel_name.clone(),
                timestamp_ms: optional_number(&payload, "timestamp_ms"),
                data: payload,
            });
        })
    }

    pub fn on_speech_stopped<F>(&self, handler: F) -> Listener
    where
        F: Fn(SpeechStoppedEvent) + Send + Sync + 'static,
    {
        let session_id = self.session_id.clone();
        let channel_name = self.channel_name.clone();
        self.on(EVENT_SPEECH_STOPPED, move |payload| {
            handler(SpeechStoppedEvent {
                session_id: session_id.clone(),
                channel_name: channel_name.clone(),
                timestamp_ms: optional_number(&payload, "timestamp_ms"),
                data: payload,
            });
        })
    }

    pub fn on_transcript_delta<F>(&self, handler: F) -> Listener
    where
        F: Fn(TranscriptDeltaEvent) + Send + Sync + 'static,
    {
        let session_id = self.session_id.clone();
        let channel_name = self.channel_name.clone();
        self.on(EVENT_TRANSCRIPT_DELTA, move |payload| {
            handler(TranscriptDeltaEvent {
                session_id: session_id.clone(),
                channel_name: channel_name.clone(),
                delta: required_string(&payload, "delta", ""),
                start_ms: optional_number(&payload, "start_ms"),
                end_ms: optional_number(&payload, "end_ms"),
                data: payload,
            });
        })
    }

    pub fn on_turn_eou_predicted<F>(&self, handler: F) -> Listener
    where
        F: Fn(TurnEouPredictedEvent) + Send + Sync + 'static,
    {
        let session_id = self.session_id.clone();
        let channel_name = self.channel_name.clone();
        self.on(EVENT_TURN_EOU_PREDICTED, move |payload| {
            handler(TurnEouPredictedEvent {
                session_id: session_id.clone(),
                channel_name: channel_name.clone(),
                probability: optional_number(&payload, "probability"),
                threshold: optional_number(&payload, "threshold"),
                delay_ms: optional_number(&payload, "delay_ms"),
                start_ms: optional_number(&payload, "start_ms"),
                end_ms: optional_number(&payload, "end_ms"),
                decision: optional_string(&payload, "decision"),
                action: optional_string(&payload, "action"),
                turn_detector: optional_string(&payload, "turn_detector"),
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
                reason: optional_nonempty_string(&payload, "reason"),
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
                session_id: session_id.clone(),
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
                session_id: session_id.clone(),
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
                session_id: session_id.clone(),
                channel_name: channel_name.clone(),
                message: optional_string(&payload, "message"),
                code: optional_nonempty_string(&payload, "code"),
                recoverable: recoverable_flag(&payload),
                generation_id: optional_nonempty_string(&payload, "generation_id"),
                data: payload,
            });
        })
    }

    pub fn on_signaling_error<F>(&self, handler: F) -> Listener
    where
        F: Fn(SignalingErrorEvent) + Send + Sync + 'static,
    {
        let session_id = self.session_id.clone();
        let channel_name = self.channel_name.clone();
        self.on(EVENT_RTC_SIGNALING_ERROR, move |payload| {
            handler(SignalingErrorEvent {
                session_id: session_id.clone(),
                channel_name: channel_name.clone(),
                message: optional_string(&payload, "message"),
                generation: optional_i64(&payload, "generation"),
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
        let (_, payload) = self.start_payload(options);
        self.send_control("response.start", payload).await
    }

    pub async fn start_response_and_wait(
        &self,
        options: Option<ResponseOptions>,
        wait_timeout: Duration,
    ) -> Result<StartAck> {
        let (generation_id, payload) = self.start_payload(options);
        let mut messages = self.channel.subscribe_messages();
        self.send_control("response.start", payload).await?;
        timeout(wait_timeout, async move {
            loop {
                match next_message(messages.recv().await) {
                    ControlFlow::Break(()) => return Err(VoxRtcError::ChannelClosed),
                    ControlFlow::Continue(None) => continue,
                    ControlFlow::Continue(Some((event, data))) => {
                        if optional_nonempty_string(&data, "generation_id").as_deref()
                            != Some(generation_id.as_str())
                        {
                            continue;
                        }
                        if event == EVENT_RESPONSE_CREATED {
                            return Ok(StartAck {
                                accepted: true,
                                generation_id: generation_id.clone(),
                                response_id: optional_string(&data, "response_id"),
                                error_code: None,
                                error_message: None,
                                recoverable: true,
                            });
                        }
                        if event == EVENT_ERROR {
                            return Ok(StartAck {
                                accepted: false,
                                generation_id: generation_id.clone(),
                                response_id: optional_string(&data, "response_id"),
                                error_code: optional_nonempty_string(&data, "code"),
                                error_message: optional_string(&data, "message"),
                                recoverable: recoverable_flag(&data),
                            });
                        }
                    }
                }
            }
        })
        .await
        .map_err(|_| VoxRtcError::Timeout("response.start acknowledgement"))?
    }

    pub async fn append_response_text(
        &self,
        delta: impl Into<String>,
        options: Option<ResponseOptions>,
    ) -> Result<()> {
        let explicit = explicit_generation(&options);
        let mut payload = response_options_payload(options);
        payload.insert("delta".to_owned(), Value::String(delta.into()));
        self.thread_generation(&mut payload, explicit);
        self.send_control("response.delta", payload).await
    }

    pub async fn commit_response(&self, options: Option<ResponseOptions>) -> Result<()> {
        let explicit = explicit_generation(&options);
        let mut payload = EventData::new();
        self.thread_generation(&mut payload, explicit);
        self.send_control("response.commit", payload).await
    }

    pub async fn cancel_response(&self, options: Option<ResponseOptions>) -> Result<()> {
        let explicit = explicit_generation(&options);
        let mut payload = EventData::new();
        self.thread_generation(&mut payload, explicit);
        self.clear_response_generation();
        self.send_control("response.cancel", payload).await
    }

    pub async fn replace_response_text(
        &self,
        text: impl Into<String>,
        options: Option<ResponseOptions>,
    ) -> Result<()> {
        self.clear_response_generation();
        let explicit = explicit_generation(&options);
        let mut payload = response_options_payload(options);
        payload.insert("text".to_owned(), Value::String(text.into()));
        if let Some(generation_id) = explicit {
            payload.insert("generation_id".to_owned(), Value::String(generation_id));
        }
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
        self.append_response_text(text, options.clone()).await?;
        self.commit_response(options).await
    }

    pub async fn send_client_event(&self, envelope: ClientEventEnvelope) -> Result<()> {
        let mut payload = EventData::new();
        payload.insert("event".to_owned(), Value::String(envelope.event));
        payload.insert("payload".to_owned(), envelope.payload);
        self.send_control(EVENT_CLIENT_EVENT, payload).await
    }

    fn start_payload(&self, options: Option<ResponseOptions>) -> (String, EventData) {
        let explicit = explicit_generation(&options);
        let mut payload = response_options_payload(options);
        let generation_id = match explicit {
            Some(id) => self.set_response_generation(id),
            None => self.next_response_generation(),
        };
        payload.insert(
            "generation_id".to_owned(),
            Value::String(generation_id.clone()),
        );
        (generation_id, payload)
    }

    fn next_response_generation(&self) -> String {
        let mut state = self
            .response_generation
            .lock()
            .expect("response generation mutex poisoned");
        state.counter += 1;
        let generation_id = format!("generation_{}_{}", state.counter, Uuid::new_v4());
        state.id = Some(generation_id.clone());
        generation_id
    }

    fn set_response_generation(&self, generation_id: String) -> String {
        let mut state = self
            .response_generation
            .lock()
            .expect("response generation mutex poisoned");
        state.counter += 1;
        state.id = Some(generation_id.clone());
        generation_id
    }

    fn thread_generation(&self, payload: &mut EventData, explicit: Option<String>) {
        match explicit {
            Some(generation_id) => {
                payload.insert("generation_id".to_owned(), Value::String(generation_id));
            }
            None => self.add_response_generation(payload),
        }
    }

    fn add_response_generation(&self, payload: &mut EventData) {
        let state = self
            .response_generation
            .lock()
            .expect("response generation mutex poisoned");
        if let Some(generation_id) = &state.id {
            payload.insert(
                "generation_id".to_owned(),
                Value::String(generation_id.clone()),
            );
        }
    }

    fn clear_response_generation(&self) {
        self.response_generation
            .lock()
            .expect("response generation mutex poisoned")
            .id = None;
    }
}

fn next_message(
    result: std::result::Result<(String, EventData), RecvError>,
) -> ControlFlow<(), Option<(String, EventData)>> {
    match result {
        Ok(message) => ControlFlow::Continue(Some(message)),
        Err(RecvError::Lagged(_)) => ControlFlow::Continue(None),
        Err(RecvError::Closed) => ControlFlow::Break(()),
    }
}

fn join_decline_reason(reason: Option<EventData>) -> Option<String> {
    let reason = reason?;
    for key in ["message", "reason", "error"] {
        if let Some(value) = reason.get(key).and_then(Value::as_str)
            && !value.is_empty()
        {
            return Some(value.to_owned());
        }
    }
    if reason.is_empty() {
        None
    } else {
        Some(Value::Object(reason).to_string())
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

fn explicit_generation(options: &Option<ResponseOptions>) -> Option<String> {
    options
        .as_ref()
        .and_then(|options| options.generation_id.clone())
        .filter(|id| !id.is_empty())
}

fn response_event(payload: EventData, session_id: &str, channel_name: &str) -> ResponseEvent {
    ResponseEvent {
        session_id: session_id.to_owned(),
        channel_name: channel_name.to_owned(),
        response_id: optional_string(&payload, "response_id"),
        generation_id: optional_nonempty_string(&payload, "generation_id"),
        data: payload,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::socket::test_channel;
    use serde_json::json;
    use tokio::sync::broadcast;
    use tokio::sync::mpsc;

    async fn session() -> (VoxRtcControlSession, broadcast::Sender<(String, EventData)>) {
        let (channel, sender) = test_channel().await;
        let session =
            VoxRtcControlSession::new(channel, "sess-1".to_owned(), Duration::from_secs(1));
        (session, sender)
    }

    fn payload(value: Value) -> EventData {
        value.as_object().cloned().expect("object payload")
    }

    #[test]
    fn join_decline_reason_prefers_structured_message_fields() {
        assert_eq!(
            join_decline_reason(Some(payload(json!({ "message": "expired" })))),
            Some("expired".to_owned())
        );
        assert_eq!(
            join_decline_reason(Some(payload(json!({ "reason": "missing" })))),
            Some("missing".to_owned())
        );
        assert_eq!(
            join_decline_reason(Some(payload(json!({ "channel": "/rtc/abc" })))),
            Some(r#"{"channel":"/rtc/abc"}"#.to_owned())
        );
        assert_eq!(join_decline_reason(Some(EventData::new())), None);
        assert_eq!(join_decline_reason(None), None);
    }

    async fn recv<T>(rx: &mut mpsc::UnboundedReceiver<T>) -> T {
        timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("handler fired within timeout")
            .expect("handler produced an event")
    }

    #[test]
    fn next_message_classifies_lag_close_and_ok() {
        assert!(matches!(
            next_message(Ok(("e".to_owned(), EventData::new()))),
            ControlFlow::Continue(Some(_))
        ));
        assert!(matches!(
            next_message(Err(RecvError::Lagged(7))),
            ControlFlow::Continue(None)
        ));
        assert!(matches!(
            next_message(Err(RecvError::Closed)),
            ControlFlow::Break(())
        ));
    }

    #[tokio::test]
    async fn response_commands_share_one_generation_id() {
        let (session, _) = session().await;
        let generation_id = session.next_response_generation();
        let mut delta = payload(json!({ "delta": "hello" }));
        session.add_response_generation(&mut delta);
        let mut commit = EventData::new();
        session.add_response_generation(&mut commit);

        assert_eq!(
            delta.get("generation_id"),
            Some(&Value::String(generation_id.clone()))
        );
        assert_eq!(
            commit.get("generation_id"),
            Some(&Value::String(generation_id))
        );
    }

    #[tokio::test]
    async fn on_error_parses_typed_fields() {
        let (session, sender) = session().await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let _listener = session.on_error(move |event| {
            tx.send(event).unwrap();
        });
        sender
            .send((
                EVENT_ERROR.to_owned(),
                payload(json!({
                    "message": "cannot start now",
                    "code": ERROR_CODE_SESSION_FAILED,
                    "recoverable": false,
                    "generation_id": "gen-9"
                })),
            ))
            .unwrap();
        let event = recv(&mut rx).await;
        assert_eq!(event.message.as_deref(), Some("cannot start now"));
        assert_eq!(event.code.as_deref(), Some(ERROR_CODE_SESSION_FAILED));
        assert!(!event.recoverable);
        assert_eq!(event.generation_id.as_deref(), Some("gen-9"));
    }

    #[tokio::test]
    async fn on_error_defaults_missing_recoverable_to_true() {
        let (session, sender) = session().await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let _listener = session.on_error(move |event| {
            tx.send(event).unwrap();
        });
        sender
            .send((
                EVENT_ERROR.to_owned(),
                payload(json!({ "message": "legacy server", "code": "" })),
            ))
            .unwrap();
        let event = recv(&mut rx).await;
        assert!(event.recoverable);
        assert_eq!(event.code, None);
        assert_eq!(event.generation_id, None);
    }

    #[tokio::test]
    async fn start_payload_uses_explicit_generation_id() {
        let (session, _) = session().await;
        let options = ResponseOptions {
            allow_interruptions: Some(false),
            generation_id: Some("gen-7".to_owned()),
        };
        let (generation_id, start) = session.start_payload(Some(options));
        assert_eq!(generation_id, "gen-7");
        assert_eq!(
            start.get("generation_id"),
            Some(&Value::String("gen-7".to_owned()))
        );
        assert_eq!(start.get("allow_interruptions"), Some(&Value::Bool(false)));

        let mut commit = EventData::new();
        session.thread_generation(&mut commit, None);
        assert_eq!(
            commit.get("generation_id"),
            Some(&Value::String("gen-7".to_owned()))
        );
    }

    #[tokio::test]
    async fn start_payload_generates_generation_id_when_absent() {
        let (session, _) = session().await;
        let (generation_id, start) = session.start_payload(None);
        assert!(generation_id.starts_with("generation_1_"));
        assert!(generation_id.len() > "generation_1_".len());
        assert_eq!(
            start.get("generation_id"),
            Some(&Value::String(generation_id))
        );
    }

    #[tokio::test]
    async fn explicit_generation_id_overrides_tracked_one() {
        let (session, _) = session().await;
        let tracked = session.next_response_generation();
        let mut delta = payload(json!({ "delta": "hi" }));
        session.thread_generation(&mut delta, Some("gen-42".to_owned()));
        assert_eq!(
            delta.get("generation_id"),
            Some(&Value::String("gen-42".to_owned()))
        );
        assert_ne!(tracked, "gen-42");
    }

    #[tokio::test]
    async fn response_events_expose_generation_id() {
        let (session, sender) = session().await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let _listener = session.on_response_created(move |event| {
            tx.send(event).unwrap();
        });
        sender
            .send((
                EVENT_RESPONSE_CREATED.to_owned(),
                payload(json!({ "response_id": "resp-1", "generation_id": "gen-1" })),
            ))
            .unwrap();
        let event = recv(&mut rx).await;
        assert_eq!(event.response_id.as_deref(), Some("resp-1"));
        assert_eq!(event.generation_id.as_deref(), Some("gen-1"));
    }

    #[tokio::test]
    async fn audio_clear_and_interruption_expose_generation_id() {
        let (session, sender) = session().await;
        let (clear_tx, mut clear_rx) = mpsc::unbounded_channel();
        let _clear = session.on_response_audio_clear(move |event| {
            clear_tx.send(event).unwrap();
        });
        let (int_tx, mut int_rx) = mpsc::unbounded_channel();
        let _interruption = session.on_interruption_detected(move |event| {
            int_tx.send(event).unwrap();
        });
        sender
            .send((
                EVENT_RESPONSE_AUDIO_CLEAR.to_owned(),
                payload(json!({ "response_id": "resp-2", "generation_id": "gen-2" })),
            ))
            .unwrap();
        sender
            .send((
                EVENT_INTERRUPTION_DETECTED.to_owned(),
                payload(json!({
                    "response_id": "resp-2",
                    "generation_id": "gen-2",
                    "vad_active_ms": 250
                })),
            ))
            .unwrap();
        let clear = recv(&mut clear_rx).await;
        assert_eq!(clear.generation_id.as_deref(), Some("gen-2"));
        let interruption = recv(&mut int_rx).await;
        assert_eq!(interruption.response.generation_id.as_deref(), Some("gen-2"));
        assert_eq!(interruption.vad_active_ms, Some(250.0));
    }

    #[tokio::test]
    async fn on_signaling_error_parses_message_and_generation() {
        let (session, sender) = session().await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let _listener = session.on_signaling_error(move |event| {
            tx.send(event).unwrap();
        });
        sender
            .send((
                EVENT_RTC_SIGNALING_ERROR.to_owned(),
                payload(json!({
                    "message": "setLocalDescription failed",
                    "generation": 3
                })),
            ))
            .unwrap();
        let event = recv(&mut rx).await;
        assert_eq!(event.message.as_deref(), Some("setLocalDescription failed"));
        assert_eq!(event.generation, Some(3));
    }

    #[tokio::test]
    async fn on_signaling_error_leaves_generation_none_when_absent() {
        let (session, sender) = session().await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let _listener = session.on_signaling_error(move |event| {
            tx.send(event).unwrap();
        });
        sender
            .send((
                EVENT_RTC_SIGNALING_ERROR.to_owned(),
                payload(json!({ "message": "RTC signaling failed" })),
            ))
            .unwrap();
        let event = recv(&mut rx).await;
        assert_eq!(event.message.as_deref(), Some("RTC signaling failed"));
        assert_eq!(event.generation, None);
    }

    #[tokio::test]
    async fn on_transcript_exposes_entities_and_words() {
        let (session, sender) = session().await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let _listener = session.on_transcript(move |event| {
            tx.send(event).unwrap();
        });
        sender
            .send((
                EVENT_TRANSCRIPT_COMPLETED.to_owned(),
                payload(json!({
                    "transcript": "call Ada",
                    "entities": [
                        { "type": "PRODUCT", "text": "Ada", "start_char": 5, "end_char": 8 }
                    ],
                    "words": [
                        { "word": "call", "start_ms": 0, "end_ms": 300 },
                        { "word": "Ada", "start_ms": 300, "end_ms": 600, "confidence": 0.91 }
                    ]
                })),
            ))
            .unwrap();
        let event = recv(&mut rx).await;
        assert_eq!(
            event.entities,
            vec![TranscriptEntity {
                r#type: "PRODUCT".to_owned(),
                text: "Ada".to_owned(),
                start_char: 5,
                end_char: 8,
            }]
        );
        assert_eq!(event.words.len(), 2);
        assert_eq!(event.words[0].word, "call");
        assert_eq!(event.words[0].start_ms, 0.0);
        assert_eq!(event.words[0].confidence, None);
        assert_eq!(event.words[1].confidence, Some(0.91));
    }

    #[tokio::test]
    async fn on_transcript_defaults_entities_and_words_to_empty() {
        let (session, sender) = session().await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let _listener = session.on_transcript(move |event| {
            tx.send(event).unwrap();
        });
        sender
            .send((
                EVENT_TRANSCRIPT_COMPLETED.to_owned(),
                payload(json!({ "transcript": "hello" })),
            ))
            .unwrap();
        let event = recv(&mut rx).await;
        assert!(event.entities.is_empty());
        assert!(event.words.is_empty());
    }

    #[tokio::test]
    async fn interruption_events_expose_reason() {
        let (session, sender) = session().await;
        let (det_tx, mut det_rx) = mpsc::unbounded_channel();
        let _detected = session.on_interruption_detected(move |event| {
            det_tx.send(event).unwrap();
        });
        let (fp_tx, mut fp_rx) = mpsc::unbounded_channel();
        let _false_positive = session.on_interruption_false_positive(move |event| {
            fp_tx.send(event).unwrap();
        });
        sender
            .send((
                EVENT_INTERRUPTION_DETECTED.to_owned(),
                payload(json!({
                    "response_id": "resp-3",
                    "generation_id": "gen-3",
                    "reason": "speech_overlap"
                })),
            ))
            .unwrap();
        sender
            .send((
                EVENT_INTERRUPTION_FALSE_POSITIVE.to_owned(),
                payload(json!({ "response_id": "resp-3", "reason": "backchannel" })),
            ))
            .unwrap();
        let detected = recv(&mut det_rx).await;
        assert_eq!(detected.reason.as_deref(), Some("speech_overlap"));
        let false_positive = recv(&mut fp_rx).await;
        assert_eq!(false_positive.reason.as_deref(), Some("backchannel"));
    }

    #[tokio::test]
    async fn start_response_and_wait_resolves_on_matching_created() {
        let (session, sender) = session().await;
        let options = ResponseOptions {
            generation_id: Some("gen-ack".to_owned()),
            ..Default::default()
        };
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            sender
                .send((
                    EVENT_RESPONSE_CREATED.to_owned(),
                    payload(json!({ "response_id": "resp-other", "generation_id": "gen-other" })),
                ))
                .unwrap();
            sender
                .send((
                    EVENT_RESPONSE_CREATED.to_owned(),
                    payload(json!({ "response_id": "resp-9", "generation_id": "gen-ack" })),
                ))
                .unwrap();
        });
        let ack = session
            .start_response_and_wait(Some(options), Duration::from_secs(2))
            .await
            .expect("ack within timeout");
        assert!(ack.accepted);
        assert_eq!(ack.generation_id, "gen-ack");
        assert_eq!(ack.response_id.as_deref(), Some("resp-9"));
        assert!(ack.recoverable);
        assert_eq!(ack.error_code, None);
    }

    #[tokio::test]
    async fn start_response_and_wait_surfaces_typed_rejection() {
        let (session, sender) = session().await;
        let options = ResponseOptions {
            generation_id: Some("gen-rejected".to_owned()),
            ..Default::default()
        };
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            sender
                .send((
                    EVENT_ERROR.to_owned(),
                    payload(json!({
                        "message": "busy",
                        "code": ERROR_CODE_RESPONSE_ALREADY_ACTIVE,
                        "recoverable": true,
                        "generation_id": "gen-rejected"
                    })),
                ))
                .unwrap();
        });
        let ack = session
            .start_response_and_wait(Some(options), Duration::from_secs(2))
            .await
            .expect("rejection within timeout");
        assert!(!ack.accepted);
        assert_eq!(ack.generation_id, "gen-rejected");
        assert_eq!(
            ack.error_code.as_deref(),
            Some(ERROR_CODE_RESPONSE_ALREADY_ACTIVE)
        );
        assert_eq!(ack.error_message.as_deref(), Some("busy"));
        assert!(ack.recoverable);
    }

    #[tokio::test]
    async fn start_response_and_wait_times_out_without_ack() {
        let (session, _sender) = session().await;
        let error = session
            .start_response_and_wait(None, Duration::from_millis(100))
            .await
            .expect_err("no ack must time out");
        assert!(matches!(error, VoxRtcError::Timeout(_)));
    }

    #[tokio::test]
    async fn on_speech_started_fires_with_timestamp() {
        let (session, sender) = session().await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let _listener = session.on_speech_started(move |event| {
            tx.send(event).unwrap();
        });
        sender
            .send((
                EVENT_SPEECH_STARTED.to_owned(),
                payload(json!({ "session_id": "sess-1", "timestamp_ms": 1234 })),
            ))
            .unwrap();
        let event = recv(&mut rx).await;
        assert_eq!(event.session_id, "sess-1");
        assert_eq!(event.channel_name, "/rtc/sess-1");
        assert_eq!(event.timestamp_ms, Some(1234.0));
    }

    #[tokio::test]
    async fn on_speech_stopped_fires_with_timestamp() {
        let (session, sender) = session().await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let _listener = session.on_speech_stopped(move |event| {
            tx.send(event).unwrap();
        });
        sender
            .send((
                EVENT_SPEECH_STOPPED.to_owned(),
                payload(json!({ "timestamp_ms": 5678 })),
            ))
            .unwrap();
        let event = recv(&mut rx).await;
        assert_eq!(event.timestamp_ms, Some(5678.0));
    }

    #[tokio::test]
    async fn on_transcript_delta_fires_with_fields() {
        let (session, sender) = session().await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let _listener = session.on_transcript_delta(move |event| {
            tx.send(event).unwrap();
        });
        sender
            .send((
                EVENT_TRANSCRIPT_DELTA.to_owned(),
                payload(json!({ "delta": "hel", "start_ms": 10, "end_ms": 20 })),
            ))
            .unwrap();
        let event = recv(&mut rx).await;
        assert_eq!(event.delta, "hel");
        assert_eq!(event.start_ms, Some(10.0));
        assert_eq!(event.end_ms, Some(20.0));
    }

    #[tokio::test]
    async fn on_turn_eou_predicted_fires_with_fields() {
        let (session, sender) = session().await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let _listener = session.on_turn_eou_predicted(move |event| {
            tx.send(event).unwrap();
        });
        sender
            .send((
                EVENT_TURN_EOU_PREDICTED.to_owned(),
                payload(json!({
                    "probability": 0.82,
                    "threshold": 0.5,
                    "delay_ms": 120,
                    "start_ms": 0,
                    "end_ms": 300,
                    "decision": "end",
                    "action": "commit",
                    "turn_detector": "smart"
                })),
            ))
            .unwrap();
        let event = recv(&mut rx).await;
        assert_eq!(event.probability, Some(0.82));
        assert_eq!(event.threshold, Some(0.5));
        assert_eq!(event.delay_ms, Some(120.0));
        assert_eq!(event.start_ms, Some(0.0));
        assert_eq!(event.end_ms, Some(300.0));
        assert_eq!(event.decision.as_deref(), Some("end"));
        assert_eq!(event.action.as_deref(), Some("commit"));
        assert_eq!(event.turn_detector.as_deref(), Some("smart"));
    }

    #[tokio::test]
    async fn handler_survives_a_lagged_broadcast() {
        let (session, sender) = session().await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let _listener = session.on_speech_started(move |event| {
            tx.send(event.timestamp_ms).unwrap();
        });

        for index in 0..2100u32 {
            let _ = sender.send((
                EVENT_SPEECH_STARTED.to_owned(),
                payload(json!({ "timestamp_ms": index })),
            ));
        }
        let _ = sender.send((
            EVENT_SPEECH_STARTED.to_owned(),
            payload(json!({ "timestamp_ms": 9999 })),
        ));

        let mut saw_final = false;
        while let Ok(Some(value)) = timeout(Duration::from_secs(1), rx.recv()).await {
            if value == Some(9999.0) {
                saw_final = true;
                break;
            }
        }
        assert!(
            saw_final,
            "loop must keep delivering events after a broadcast lag"
        );
    }
}
