use crate::error::{Result, VoxRtcError};
use crate::session::VoxRtcControlSession;
use crate::socket::RawSocketClient;
use crate::types::{ConnectionState, EventData, SessionBootstrap};
use serde_json::Value;
use std::env;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct VoxRtcServerClientOptions {
    pub http_base: String,
    pub api_key: Option<String>,
    pub socket_base: Option<String>,
    pub socket_params: EventData,
    pub connection_timeout: Duration,
    pub max_reconnect_delay: Duration,
    pub request_timeout: Duration,
    pub join_timeout: Duration,
}

impl VoxRtcServerClientOptions {
    pub fn new(http_base: impl Into<String>) -> Self {
        Self {
            http_base: http_base.into(),
            api_key: None,
            socket_base: None,
            socket_params: EventData::new(),
            connection_timeout: Duration::from_secs(10),
            max_reconnect_delay: Duration::from_secs(30),
            request_timeout: Duration::from_secs(15),
            join_timeout: Duration::from_secs(10),
        }
    }
}

#[derive(Clone)]
pub struct VoxRtcServerClient {
    http_base: String,
    api_key: Option<String>,
    socket_base: String,
    socket_params: EventData,
    http: reqwest::Client,
    socket: RawSocketClient,
    connection_timeout: Duration,
    join_timeout: Duration,
}

#[derive(Clone)]
pub struct ControlledSession {
    pub bootstrap: SessionBootstrap,
    pub session: VoxRtcControlSession,
}

impl VoxRtcServerClient {
    pub fn new(http_base: impl Into<String>) -> Result<Self> {
        Self::with_options(VoxRtcServerClientOptions::new(http_base))
    }

    pub fn with_options(mut options: VoxRtcServerClientOptions) -> Result<Self> {
        let http_base = normalize_base(&options.http_base);
        let api_key = options
            .api_key
            .take()
            .or_else(|| env::var("VOX_API_KEY").ok())
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        let socket_base = options
            .socket_base
            .take()
            .map(|base| normalize_base(&base))
            .unwrap_or_else(|| default_socket_base(&http_base));
        if let Some(api_key) = &api_key {
            options
                .socket_params
                .insert("api_key".to_owned(), Value::String(api_key.clone()));
        }
        let http = reqwest::Client::builder()
            .timeout(options.request_timeout)
            .build()?;
        let socket = RawSocketClient::new(
            &socket_base,
            options.socket_params.clone(),
            options.connection_timeout,
            options.max_reconnect_delay,
        )?;
        Ok(Self {
            http_base,
            api_key,
            socket_base,
            socket_params: options.socket_params,
            http,
            socket,
            connection_timeout: options.connection_timeout,
            join_timeout: options.join_timeout,
        })
    }

    pub fn http_base(&self) -> &str {
        &self.http_base
    }

    pub fn socket_base(&self) -> &str {
        &self.socket_base
    }

    pub fn connection_state(&self) -> ConnectionState {
        self.socket.state()
    }

    pub async fn connect(&self) -> Result<()> {
        if self.socket.state() == ConnectionState::Connected {
            return Ok(());
        }
        self.socket.connect().await?;
        let mut states = self.socket.subscribe_state();
        tokio::time::timeout(self.connection_timeout, async move {
            loop {
                if *states.borrow_and_update() == ConnectionState::Connected {
                    return Ok(());
                }
                if states.changed().await.is_err() {
                    return Err(VoxRtcError::Disconnected);
                }
            }
        })
        .await
        .map_err(|_| VoxRtcError::Timeout("PondSocket connection"))?
    }

    pub async fn disconnect(&self) {
        self.socket.disconnect().await;
    }

    pub async fn create_session(&self) -> Result<SessionBootstrap> {
        let mut request = self
            .http
            .post(format!("{}/v1/rtc/sessions", self.http_base))
            .json(&serde_json::json!({}));
        if let Some(api_key) = &self.api_key {
            request = request.bearer_auth(api_key);
        }
        let response = request.send().await?;
        let status = response.status();
        let body = response.text().await?;
        if !status.is_success() {
            return Err(VoxRtcError::CreateSessionFailed { status, body });
        }
        Ok(serde_json::from_str(&body)?)
    }

    pub async fn attach_session(
        &self,
        session_id: impl Into<String>,
    ) -> Result<VoxRtcControlSession> {
        let session_id = session_id.into();
        self.connect().await?;
        let channel = self
            .socket
            .create_channel(format!("/rtc/{session_id}"), EventData::new())
            .await;
        let session = VoxRtcControlSession::new(channel, session_id, self.join_timeout);
        session.join().await?;
        Ok(session)
    }

    pub async fn create_controlled_session(&self) -> Result<ControlledSession> {
        let bootstrap = self.create_session().await?;
        let session = self.attach_session(bootstrap.session_id.clone()).await?;
        Ok(ControlledSession { bootstrap, session })
    }

    #[allow(dead_code)]
    pub fn socket_params(&self) -> &EventData {
        &self.socket_params
    }
}

fn normalize_base(base: &str) -> String {
    base.trim_end_matches('/').to_owned()
}

fn default_socket_base(http_base: &str) -> String {
    format!("{}/v1/socket", normalize_base(http_base))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_socket_base_from_http_base() {
        let client = VoxRtcServerClient::new("https://vox.example.com/").unwrap();
        assert_eq!(client.http_base(), "https://vox.example.com");
        assert_eq!(client.socket_base(), "https://vox.example.com/v1/socket");
    }

    #[test]
    fn new_returns_error_on_bad_url_instead_of_panicking() {
        match VoxRtcServerClient::new("not a url") {
            Err(VoxRtcError::InvalidUrl(_)) => {}
            Err(other) => panic!("expected InvalidUrl, got {other:?}"),
            Ok(_) => panic!("expected an error for a malformed URL"),
        }
    }

    #[test]
    fn forwards_connection_and_reconnect_timeouts() {
        let mut options = VoxRtcServerClientOptions::new("https://vox.example.com");
        options.connection_timeout = Duration::from_secs(3);
        options.max_reconnect_delay = Duration::from_secs(45);
        let client = VoxRtcServerClient::with_options(options).unwrap();
        assert_eq!(client.connection_timeout, Duration::from_secs(3));
    }

    #[test]
    fn injects_api_key_into_socket_params() {
        let mut options = VoxRtcServerClientOptions::new("https://vox.example.com");
        options.api_key = Some("secret".to_owned());
        let client = VoxRtcServerClient::with_options(options).unwrap();
        assert_eq!(
            client
                .socket_params()
                .get("api_key")
                .and_then(Value::as_str),
            Some("secret")
        );
    }
}
