use crate::error::{Result, VoxRtcError};
use crate::types::{ChannelState, ConnectionState, EventData, SocketEnvelope, object_to_map};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{RwLock, broadcast, mpsc, watch};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use url::Url;
use uuid::Uuid;

#[derive(Clone)]
pub(crate) struct RawSocketClient {
    endpoint: String,
    params: EventData,
    state_tx: watch::Sender<ConnectionState>,
    send_tx: Arc<RwLock<Option<mpsc::Sender<SocketEnvelope>>>>,
    channels: Arc<RwLock<HashMap<String, RawSocketChannel>>>,
}

#[derive(Clone)]
pub(crate) struct RawSocketChannel {
    inner: Arc<RawSocketChannelInner>,
}

struct RawSocketChannelInner {
    name: String,
    params: EventData,
    send_tx: Arc<RwLock<Option<mpsc::Sender<SocketEnvelope>>>>,
    state_tx: watch::Sender<ChannelState>,
    message_tx: broadcast::Sender<(String, EventData)>,
}

impl RawSocketClient {
    pub(crate) fn new(endpoint: &str, params: EventData) -> Result<Self> {
        let url = socket_url(endpoint, &params)?;
        let (state_tx, _) = watch::channel(ConnectionState::Disconnected);
        Ok(Self {
            endpoint: url,
            params,
            state_tx,
            send_tx: Arc::new(RwLock::new(None)),
            channels: Arc::new(RwLock::new(HashMap::new())),
        })
    }

    pub(crate) fn state(&self) -> ConnectionState {
        *self.state_tx.borrow()
    }

    pub(crate) fn subscribe_state(&self) -> watch::Receiver<ConnectionState> {
        self.state_tx.subscribe()
    }

    pub(crate) async fn connect(&self) -> Result<()> {
        if self.state() == ConnectionState::Connected {
            return Ok(());
        }

        let _ = self.state_tx.send(ConnectionState::Connecting);
        let (stream, _) = connect_async(&self.endpoint).await?;
        let (mut writer, mut reader) = stream.split();
        let (tx, mut rx) = mpsc::channel::<SocketEnvelope>(1024);
        *self.send_tx.write().await = Some(tx);

        let state_tx = self.state_tx.clone();
        let send_tx = self.send_tx.clone();
        let channels = self.channels.clone();

        tokio::spawn(async move {
            while let Some(env) = rx.recv().await {
                let Ok(text) = serde_json::to_string(&env) else {
                    continue;
                };
                if writer.send(Message::Text(text.into())).await.is_err() {
                    break;
                }
            }
        });

        tokio::spawn(async move {
            while let Some(next) = reader.next().await {
                let Ok(message) = next else {
                    break;
                };
                let Ok(text) = message.into_text() else {
                    continue;
                };
                for line in text.trim().lines().filter(|line| !line.trim().is_empty()) {
                    let Ok(env) = serde_json::from_str::<SocketEnvelope>(line) else {
                        continue;
                    };
                    if env.action == "CONNECT" && env.event == "CONNECTION" {
                        let _ = state_tx.send(ConnectionState::Connected);
                        continue;
                    }
                    let channel = channels.read().await.get(&env.channel_name).cloned();
                    if let Some(channel) = channel {
                        channel.handle_envelope(env);
                    }
                }
            }
            *send_tx.write().await = None;
            let _ = state_tx.send(ConnectionState::Disconnected);
        });

        Ok(())
    }

    pub(crate) async fn disconnect(&self) {
        *self.send_tx.write().await = None;
        let _ = self.state_tx.send(ConnectionState::Disconnected);
    }

    pub(crate) async fn create_channel(
        &self,
        name: impl Into<String>,
        params: EventData,
    ) -> RawSocketChannel {
        let name = name.into();
        let mut channels = self.channels.write().await;
        if let Some(channel) = channels.get(&name) {
            return channel.clone();
        }
        let channel = RawSocketChannel::new(name.clone(), params, self.send_tx.clone());
        channels.insert(name, channel.clone());
        channel
    }

    #[allow(dead_code)]
    pub(crate) fn params(&self) -> &EventData {
        &self.params
    }
}

impl RawSocketChannel {
    fn new(
        name: String,
        params: EventData,
        send_tx: Arc<RwLock<Option<mpsc::Sender<SocketEnvelope>>>>,
    ) -> Self {
        let (state_tx, _) = watch::channel(ChannelState::Idle);
        let (message_tx, _) = broadcast::channel(1024);
        Self {
            inner: Arc::new(RawSocketChannelInner {
                name,
                params,
                send_tx,
                state_tx,
                message_tx,
            }),
        }
    }

    pub(crate) fn name(&self) -> &str {
        &self.inner.name
    }

    pub(crate) fn subscribe_state(&self) -> watch::Receiver<ChannelState> {
        self.inner.state_tx.subscribe()
    }

    pub(crate) fn subscribe_messages(&self) -> broadcast::Receiver<(String, EventData)> {
        self.inner.message_tx.subscribe()
    }

    pub(crate) async fn join(&self) -> Result<()> {
        let _ = self.inner.state_tx.send(ChannelState::Joining);
        self.send(
            "JOIN_CHANNEL",
            "JOIN_CHANNEL",
            Value::Object(self.inner.params.clone()),
        )
        .await
    }

    pub(crate) async fn leave(&self) -> Result<()> {
        self.send(
            "LEAVE_CHANNEL",
            "LEAVE_CHANNEL",
            Value::Object(EventData::new()),
        )
        .await?;
        let _ = self.inner.state_tx.send(ChannelState::Closed);
        Ok(())
    }

    pub(crate) async fn send_message(&self, event: &str, payload: EventData) -> Result<()> {
        self.send("BROADCAST", event, Value::Object(payload)).await
    }

    async fn send(&self, action: &str, event: &str, payload: Value) -> Result<()> {
        let Some(tx) = self.inner.send_tx.read().await.clone() else {
            return Err(VoxRtcError::Disconnected);
        };
        tx.send(SocketEnvelope {
            action: action.to_owned(),
            event: event.to_owned(),
            payload,
            channel_name: self.inner.name.clone(),
            request_id: Uuid::new_v4().to_string(),
        })
        .await
        .map_err(|_| VoxRtcError::Disconnected)
    }

    fn handle_envelope(&self, env: SocketEnvelope) {
        match env.event.as_str() {
            "ACKNOWLEDGE" => {
                let _ = self.inner.state_tx.send(ChannelState::Joined);
            }
            "UNAUTHORIZED" => {
                let _ = self.inner.state_tx.send(ChannelState::Declined);
            }
            _ => {}
        }
        let _ = self
            .inner
            .message_tx
            .send((env.event, object_to_map(env.payload)));
    }
}

fn socket_url(endpoint: &str, params: &EventData) -> Result<String> {
    let mut url = Url::parse(endpoint)?;
    match url.scheme() {
        "http" => {
            let _ = url.set_scheme("ws");
        }
        "https" => {
            let _ = url.set_scheme("wss");
        }
        "ws" | "wss" => {}
        _ => {
            return Err(VoxRtcError::InvalidUrl(
                url::ParseError::RelativeUrlWithoutBase,
            ));
        }
    }
    {
        let mut query = url.query_pairs_mut();
        for (key, value) in params {
            query.append_pair(
                key,
                value
                    .as_str()
                    .map_or_else(|| value.to_string(), ToOwned::to_owned)
                    .as_str(),
            );
        }
    }
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn socket_url_maps_http_to_ws_and_adds_params() {
        let mut params = EventData::new();
        params.insert("api_key".to_owned(), json!("secret"));
        let url = socket_url("https://vox.example.com/v1/socket", &params).unwrap();
        assert_eq!(url, "wss://vox.example.com/v1/socket?api_key=secret");
    }
}
