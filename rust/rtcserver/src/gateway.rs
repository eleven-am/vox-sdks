use crate::{
    ControlledSession, VoxRtcControlSession, VoxRtcServerClient, VoxRtcServerClientOptions,
    WireEvent,
};
use axum::{
    Router,
    extract::{
        State, WebSocketUpgrade,
        ws::{CloseFrame, Message, WebSocket},
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Map, Value, json};
use std::{
    future::Future,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tokio::sync::{Notify, mpsc, watch};

const DEFAULT_PATH: &str = "/api/vox/rtc";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub type GatewayHookFuture = Pin<Box<dyn Future<Output = std::result::Result<(), String>> + Send>>;
pub type SessionCreatedHook = Arc<dyn Fn(GatewaySessionContext) -> GatewayHookFuture + Send + Sync>;
pub type SessionClosedHook = Arc<dyn Fn(GatewayClosedContext) -> GatewayHookFuture + Send + Sync>;
pub type GatewayErrorHook = Arc<dyn Fn(String) + Send + Sync>;

#[derive(Clone)]
pub struct GatewaySessionContext {
    pub headers: HeaderMap,
    pub session: VoxRtcControlSession,
}

#[derive(Clone)]
pub struct GatewayClosedContext {
    pub headers: HeaderMap,
    pub session: VoxRtcControlSession,
    pub reason: String,
}

pub struct GatewayOptions {
    pub vox_http_base: String,
    pub api_key: Option<String>,
    pub path: String,
    pub on_session_created: Option<SessionCreatedHook>,
    pub on_session_closed: Option<SessionClosedHook>,
    pub on_error: Option<GatewayErrorHook>,
}

impl GatewayOptions {
    pub fn new(vox_http_base: impl Into<String>) -> Self {
        Self {
            vox_http_base: vox_http_base.into(),
            api_key: None,
            path: DEFAULT_PATH.to_owned(),
            on_session_created: None,
            on_session_closed: None,
            on_error: None,
        }
    }
}

#[derive(Clone)]
pub struct VoxRtcGateway {
    state: Arc<GatewayState>,
}

struct GatewayState {
    client: VoxRtcServerClient,
    options: GatewayOptions,
    shutting_down: AtomicBool,
    shutdown: watch::Sender<Option<String>>,
    active: AtomicUsize,
    drained: Notify,
}

struct ActiveGuard(Arc<GatewayState>);

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        if self.0.active.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0.drained.notify_waiters();
        }
    }
}

#[derive(Debug)]
struct ClientMessage {
    id: String,
    kind: String,
    data: Map<String, Value>,
}

#[derive(Debug)]
struct CommandError {
    message: String,
    typed: bool,
}

impl CommandError {
    fn plain(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            typed: false,
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            typed: true,
        }
    }
}

impl VoxRtcGateway {
    pub fn new(options: GatewayOptions) -> crate::Result<Self> {
        let mut client_options = VoxRtcServerClientOptions::new(&options.vox_http_base);
        client_options.api_key = options.api_key.clone();
        let client = VoxRtcServerClient::with_options(client_options)?;
        Ok(Self::with_client(options, client))
    }

    pub fn with_client(options: GatewayOptions, client: VoxRtcServerClient) -> Self {
        let (shutdown, _) = watch::channel(None);
        Self {
            state: Arc::new(GatewayState {
                client,
                options,
                shutting_down: AtomicBool::new(false),
                shutdown,
                active: AtomicUsize::new(0),
                drained: Notify::new(),
            }),
        }
    }

    pub fn router(&self) -> Router {
        let path = normalize_path(&self.state.options.path);
        Router::new()
            .route(&path, get(upgrade))
            .with_state(self.state.clone())
    }

    pub async fn close(&self, reason: impl Into<String>) {
        if !self.state.shutting_down.swap(true, Ordering::AcqRel) {
            let _ = self.state.shutdown.send(Some(reason.into()));
        }
        loop {
            let notified = self.state.drained.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.state.active.load(Ordering::Acquire) == 0 {
                break;
            }
            notified.await;
        }
        self.state.client.disconnect().await;
    }
}

async fn upgrade(
    State(state): State<Arc<GatewayState>>,
    headers: HeaderMap,
    socket: WebSocketUpgrade,
) -> Response {
    if state.shutting_down.load(Ordering::Acquire) {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "RTC gateway is shutting down",
        )
            .into_response();
    }
    socket
        .on_upgrade(move |socket| serve(socket, headers, state))
        .into_response()
}

async fn serve(socket: WebSocket, headers: HeaderMap, state: Arc<GatewayState>) {
    state.active.fetch_add(1, Ordering::AcqRel);
    let _active = ActiveGuard(state.clone());
    let controlled = match state.client.create_controlled_session().await {
        Ok(value) => value,
        Err(error) => {
            report(&state, error.to_string());
            return;
        }
    };
    let context = GatewaySessionContext {
        headers: headers.clone(),
        session: controlled.session.clone(),
    };
    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    let _listener = controlled.session.on_event(move |event| {
        let _ = event_tx.send(event);
    });
    let mut shutdown = state.shutdown.subscribe();
    let (mut sender, mut receiver) = socket.split();
    let shutdown_reason = { shutdown.borrow().clone() };
    if let Some(reason) = shutdown_reason {
        cleanup(&state, &headers, &controlled.session, false, &reason).await;
        let _ = sender
            .send(Message::Close(Some(CloseFrame {
                code: 1001,
                reason: reason.into(),
            })))
            .await;
        return;
    }
    if let Some(hook) = &state.options.on_session_created
        && let Err(error) = hook(context.clone()).await
    {
        report(&state, error.clone());
        let gateway_error = CommandError::plain(error);
        let _ = send_error(&mut sender, None, &gateway_error).await;
        cleanup(
            &state,
            &headers,
            &controlled.session,
            false,
            "session_created_hook_failed",
        )
        .await;
        let _ = sender
            .send(Message::Close(Some(CloseFrame {
                code: 1011,
                reason: "RTC gateway setup failed".into(),
            })))
            .await;
        return;
    }

    if send_json(
        &mut sender,
        None,
        "gateway.ready",
        bootstrap_json(&controlled),
    )
    .await
    .is_err()
    {
        cleanup(
            &state,
            &headers,
            &controlled.session,
            false,
            "gateway_ready_failed",
        )
        .await;
        return;
    }
    let mut pending_offer_id: Option<String> = None;
    let mut generated_offer = false;
    let mut rtc_close_requested = false;
    let mut reason = "browser_disconnected".to_owned();

    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_ok()
                    && let Some(value) = shutdown.borrow().clone()
                {
                    reason = value;
                    break;
                }
            }
            message = receiver.next() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        match parse_message(text.as_str()) {
                            Ok(message) => {
                                if let Err(error) = handle_message(
                                    &controlled.session,
                                    &message,
                                    &mut pending_offer_id,
                                    &mut generated_offer,
                                    &mut rtc_close_requested,
                                ).await {
                                    if pending_offer_id.as_deref() == Some(message.id.as_str()) {
                                        pending_offer_id = None;
                                    }
                                    if send_error(&mut sender, Some(&message.id), &error).await.is_err() {
                                        break;
                                    }
                                }
                            }
                            Err(error) => {
                                if send_error(&mut sender, None, &error).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => {
                        let error = CommandError::plain("RTC gateway accepts text JSON only");
                        if send_error(&mut sender, None, &error).await.is_err() {
                            break;
                        }
                    }
                }
            }
            event = event_rx.recv() => {
                let Some(event) = event else { break; };
                let correlates = event.r#type == "rtc.answer" || event.r#type == "rtc.signaling_error";
                let request_id = if correlates { pending_offer_id.take() } else { None };
                let closed_reason = if event.r#type == "rtc.session.closed" {
                    event_reason(&event)
                } else {
                    None
                };
                if send_json(&mut sender, request_id.as_deref(), &event.r#type, Value::Object(event.data)).await.is_err() {
                    break;
                }
                if event.r#type == "rtc.session.closed" {
                    rtc_close_requested = true;
                    reason = closed_reason.unwrap_or_else(|| "session_closed".to_owned());
                    let _ = sender.send(Message::Close(Some(CloseFrame { code: 1000, reason: reason.clone().into() }))).await;
                    break;
                }
            }
        }
    }
    cleanup(
        &state,
        &headers,
        &controlled.session,
        rtc_close_requested,
        &reason,
    )
    .await;
}

async fn handle_message(
    session: &VoxRtcControlSession,
    message: &ClientMessage,
    pending_offer_id: &mut Option<String>,
    generated_offer: &mut bool,
    rtc_close_requested: &mut bool,
) -> std::result::Result<(), CommandError> {
    match message.kind.as_str() {
        "rtc.offer" => {
            if pending_offer_id.is_some() {
                return Err(CommandError::plain("An RTC offer is already pending"));
            }
            let generation = generation(&message.data, "rtc.offer", false)?;
            let offer = offer(message.data.get("offer"))?;
            *pending_offer_id = Some(message.id.clone());
            session
                .send_offer(
                    offer,
                    message.data.get("restart") == Some(&Value::Bool(true)),
                    generation,
                )
                .await
                .map_err(|error| CommandError::plain(error.to_string()))?;
            *generated_offer = generation.is_some();
            Ok(())
        }
        "rtc.ice_candidate" => {
            let generation = generation(&message.data, "rtc.ice_candidate", *generated_offer)?;
            let candidate = candidate(message.data.get("candidate"))?;
            session
                .send_ice_candidate(candidate, generation)
                .await
                .map_err(|error| CommandError::plain(error.to_string()))
        }
        "rtc.close" => {
            *rtc_close_requested = true;
            let reason = message
                .data
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("client_closed");
            session
                .close_rtc(reason)
                .await
                .map_err(|error| CommandError::plain(error.to_string()))
        }
        value => Err(CommandError::plain(format!(
            "Unsupported RTC gateway message type: {value}"
        ))),
    }
}

async fn cleanup(
    state: &Arc<GatewayState>,
    headers: &HeaderMap,
    session: &VoxRtcControlSession,
    rtc_close_requested: bool,
    reason: &str,
) {
    if !rtc_close_requested && let Err(error) = session.close_rtc(reason).await {
        report(state, error.to_string());
    }
    if let Err(error) = session.close().await {
        report(state, error.to_string());
    }
    if let Some(hook) = &state.options.on_session_closed
        && let Err(error) = hook(GatewayClosedContext {
            headers: headers.clone(),
            session: session.clone(),
            reason: reason.to_owned(),
        })
        .await
    {
        report(state, error);
    }
}

fn parse_message(text: &str) -> std::result::Result<ClientMessage, CommandError> {
    let value: Value = serde_json::from_str(text)
        .map_err(|_| CommandError::plain("RTC gateway message must be valid JSON"))?;
    let object = value
        .as_object()
        .ok_or_else(|| CommandError::plain("RTC gateway message must be an object"))?;
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let kind = object
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let data = object.get("data").and_then(Value::as_object);
    match (id, kind, data) {
        (Some(id), Some(kind), Some(data)) => Ok(ClientMessage {
            id: id.to_owned(),
            kind: kind.to_owned(),
            data: data.clone(),
        }),
        _ => Err(CommandError::plain(
            "RTC gateway message requires id, type, and object data",
        )),
    }
}

fn generation(
    data: &Map<String, Value>,
    command: &str,
    required: bool,
) -> std::result::Result<Option<u64>, CommandError> {
    let Some(value) = data.get("generation") else {
        if required {
            return Err(CommandError::invalid(format!(
                "{command} requires generation for a generated RTC negotiation"
            )));
        }
        return Ok(None);
    };
    let value = value
        .as_u64()
        .filter(|value| *value > 0 && *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| {
            CommandError::invalid(format!(
                "{command} generation must be a positive safe integer"
            ))
        })?;
    Ok(Some(value))
}

fn offer(value: Option<&Value>) -> std::result::Result<Value, CommandError> {
    let object = value
        .and_then(Value::as_object)
        .ok_or_else(|| CommandError::plain("rtc.offer requires a non-empty SDP offer"))?;
    if object.get("type").and_then(Value::as_str) != Some("offer")
        || object
            .get("sdp")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .is_empty()
    {
        return Err(CommandError::plain(
            "rtc.offer requires a non-empty SDP offer",
        ));
    }
    Ok(json!({ "type": "offer", "sdp": object["sdp"] }))
}

fn candidate(value: Option<&Value>) -> std::result::Result<Option<Value>, CommandError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let object = value.as_object().ok_or_else(|| {
        CommandError::plain("rtc.ice_candidate requires a candidate object or null")
    })?;
    let text = object
        .get("candidate")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            CommandError::plain("rtc.ice_candidate requires a candidate object or null")
        })?;
    Ok(Some(json!({
        "candidate": text,
        "sdpMid": object.get("sdpMid").cloned().unwrap_or(Value::Null),
        "sdpMLineIndex": object.get("sdpMLineIndex").cloned().unwrap_or(Value::Null),
        "usernameFragment": object.get("usernameFragment").cloned().unwrap_or(Value::Null),
    })))
}

fn bootstrap_json(controlled: &ControlledSession) -> Value {
    json!({
        "session": {
            "sessionId": controlled.bootstrap.session_id,
            "expiresAt": controlled.bootstrap.expires_at,
            "attachTtlSeconds": controlled.bootstrap.attach_ttl_seconds,
            "iceServers": controlled.bootstrap.ice_servers,
        }
    })
}

fn event_reason(event: &WireEvent) -> Option<String> {
    event
        .data
        .get("reason")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

async fn send_error<S>(
    sender: &mut S,
    id: Option<&str>,
    error: &CommandError,
) -> std::result::Result<(), ()>
where
    S: futures_util::Sink<Message> + Unpin,
{
    let mut data = json!({ "message": error.message });
    if error.typed {
        data["code"] = Value::String("command_invalid".to_owned());
    }
    send_json(sender, id, "gateway.error", data).await
}

async fn send_json<S>(
    sender: &mut S,
    id: Option<&str>,
    kind: &str,
    data: Value,
) -> std::result::Result<(), ()>
where
    S: futures_util::Sink<Message> + Unpin,
{
    let mut payload = json!({ "type": kind, "data": data });
    if let Some(id) = id {
        payload["id"] = Value::String(id.to_owned());
    }
    sender
        .send(Message::Text(payload.to_string().into()))
        .await
        .map_err(|_| ())
}

fn normalize_path(path: &str) -> String {
    let trimmed = path.trim().trim_matches('/');
    if trimmed.is_empty() {
        "/".to_owned()
    } else {
        format!("/{trimmed}")
    }
}

fn report(state: &GatewayState, error: String) {
    if let Some(hook) = &state.options.on_error {
        hook(error);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_generated_offer_and_candidate_generations_verbatim() {
        let offer = parse_message(
            r#"{"id":"offer-1","type":"rtc.offer","data":{"offer":{"type":"offer","sdp":"sdp"},"generation":1}}"#,
        )
        .expect("valid offer");
        assert_eq!(
            generation(&offer.data, "rtc.offer", false).unwrap(),
            Some(1)
        );

        let candidate_message = parse_message(
            r#"{"id":"candidate-1","type":"rtc.ice_candidate","data":{"candidate":null,"generation":2}}"#,
        )
        .expect("valid candidate");
        assert_eq!(
            generation(&candidate_message.data, "rtc.ice_candidate", true).unwrap(),
            Some(2)
        );
        assert_eq!(
            candidate(candidate_message.data.get("candidate")).unwrap(),
            None
        );
    }

    #[test]
    fn generated_negotiation_requires_candidate_generation() {
        let data = Map::from_iter([("candidate".to_owned(), Value::Null)]);
        let error = generation(&data, "rtc.ice_candidate", true).unwrap_err();
        assert!(error.typed);
        assert_eq!(
            error.message,
            "rtc.ice_candidate requires generation for a generated RTC negotiation"
        );
    }

    #[test]
    fn rejects_malformed_generation_but_preserves_legacy_mode() {
        let legacy = Map::new();
        assert_eq!(generation(&legacy, "rtc.offer", false).unwrap(), None);

        for value in [
            json!(0),
            json!(1.5),
            json!("2"),
            json!(9007199254740992_u64),
        ] {
            let data = Map::from_iter([("generation".to_owned(), value)]);
            let error = generation(&data, "rtc.offer", false).unwrap_err();
            assert!(error.typed);
            assert!(error.message.contains("positive safe integer"));
        }
    }

    #[test]
    fn validates_offer_and_candidate_shape() {
        assert_eq!(
            offer(Some(&json!({"type": "offer", "sdp": "abc"}))).unwrap(),
            json!({"type": "offer", "sdp": "abc"})
        );
        assert!(offer(Some(&json!({"type": "answer", "sdp": "abc"}))).is_err());
        assert!(candidate(Some(&json!({"candidate": 3}))).is_err());
        assert_eq!(
            candidate(Some(&json!({
                "candidate": "candidate:one",
                "sdpMid": "audio",
                "sdpMLineIndex": 0
            })))
            .unwrap()
            .unwrap()["sdpMLineIndex"],
            json!(0)
        );
    }

    #[tokio::test]
    async fn shutdown_waiter_cannot_miss_the_final_active_session() {
        let options = GatewayOptions::new("http://vox.test");
        let client = VoxRtcServerClient::new("http://vox.test").unwrap();
        let gateway = VoxRtcGateway::with_client(options, client);
        gateway.state.active.store(1, Ordering::Release);
        let guard = ActiveGuard(gateway.state.clone());
        let closing = tokio::spawn({
            let gateway = gateway.clone();
            async move { gateway.close("test_shutdown").await }
        });

        tokio::task::yield_now().await;
        drop(guard);
        tokio::time::timeout(std::time::Duration::from_secs(1), closing)
            .await
            .expect("gateway close completed")
            .expect("close task succeeded");
    }
}
