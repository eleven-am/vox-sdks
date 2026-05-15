use thiserror::Error;

#[derive(Debug, Error)]
pub enum VoxRtcError {
    #[error("invalid URL: {0}")]
    InvalidUrl(#[from] url::ParseError),

    #[error("HTTP request failed: {0}")]
    Http(#[from] reqwest::Error),

    #[error("websocket failed: {0}")]
    WebSocket(Box<tokio_tungstenite::tungstenite::Error>),

    #[error("JSON failed: {0}")]
    Json(#[from] serde_json::Error),

    #[error("timed out waiting for {0}")]
    Timeout(&'static str),

    #[error("timed out waiting for RTC channel join on {0}")]
    JoinTimeout(String),

    #[error("RTC channel join failed for {channel}: {state}")]
    JoinFailed { channel: String, state: String },

    #[error("socket is disconnected")]
    Disconnected,

    #[error("failed to create Vox RTC session: {status} {body}")]
    CreateSessionFailed {
        status: reqwest::StatusCode,
        body: String,
    },
}

pub type Result<T> = std::result::Result<T, VoxRtcError>;

impl From<tokio_tungstenite::tungstenite::Error> for VoxRtcError {
    fn from(value: tokio_tungstenite::tungstenite::Error) -> Self {
        Self::WebSocket(Box::new(value))
    }
}
