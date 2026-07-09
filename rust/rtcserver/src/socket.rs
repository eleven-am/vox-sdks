use crate::error::{Result, VoxRtcError};
use crate::types::{ChannelState, ConnectionState, EventData};
use pondsocket_client::{
    Channel as PondChannel, ClientError, ClientOptions, ConnectionState as PondConnectionState,
    PondClient,
};
use pondsocket_common::{ChannelEvent, ChannelState as PondChannelState};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::{broadcast, watch};

const INITIAL_RECONNECT_DELAY: Duration = Duration::from_millis(200);

#[derive(Clone)]
pub(crate) struct RawSocketClient {
    client: PondClient,
    params: EventData,
    state_tx: watch::Sender<ConnectionState>,
    active: Arc<AtomicBool>,
    supervisor_started: Arc<AtomicBool>,
    max_reconnect_delay: Duration,
}

#[derive(Clone)]
pub(crate) struct RawSocketChannel {
    channel: PondChannel,
    state_tx: watch::Sender<ChannelState>,
    message_tx: broadcast::Sender<(String, EventData)>,
}

impl RawSocketClient {
    pub(crate) fn new(
        endpoint: &str,
        params: EventData,
        connection_timeout: Duration,
        max_reconnect_delay: Duration,
    ) -> Result<Self> {
        let options = ClientOptions {
            connection_timeout,
            ..ClientOptions::default()
        };
        let client = PondClient::with_options(endpoint, Some(params.clone()), options)?;
        let (state_tx, _) = watch::channel(map_connection_state(client.state()));

        Ok(Self {
            client,
            params,
            state_tx,
            active: Arc::new(AtomicBool::new(false)),
            supervisor_started: Arc::new(AtomicBool::new(false)),
            max_reconnect_delay,
        })
    }

    fn ensure_supervisor(&self) {
        if self.supervisor_started.swap(true, Ordering::SeqCst) {
            return;
        }
        spawn_reconnect_supervisor(
            self.client.clone(),
            self.state_tx.clone(),
            self.active.clone(),
            self.max_reconnect_delay,
        );
    }

    pub(crate) fn state(&self) -> ConnectionState {
        map_connection_state(self.client.state())
    }

    pub(crate) fn subscribe_state(&self) -> watch::Receiver<ConnectionState> {
        self.state_tx.subscribe()
    }

    pub(crate) async fn connect(&self) -> Result<()> {
        self.active.store(true, Ordering::SeqCst);
        self.ensure_supervisor();
        self.state_tx
            .send_replace(map_connection_state(self.client.state()));
        self.client.connect().await?;
        self.state_tx
            .send_replace(map_connection_state(self.client.state()));
        Ok(())
    }

    pub(crate) async fn disconnect(&self) {
        self.active.store(false, Ordering::SeqCst);
        self.client.disconnect().await;
        self.state_tx
            .send_replace(map_connection_state(self.client.state()));
    }

    pub(crate) async fn create_channel(
        &self,
        name: impl Into<String>,
        params: EventData,
    ) -> RawSocketChannel {
        let channel = self.client.create_channel(name, Some(params)).await;
        RawSocketChannel::new(channel)
    }

    #[allow(dead_code)]
    pub(crate) fn params(&self) -> &EventData {
        &self.params
    }
}

fn spawn_reconnect_supervisor(
    client: PondClient,
    state_tx: watch::Sender<ConnectionState>,
    active: Arc<AtomicBool>,
    max_reconnect_delay: Duration,
) {
    let mut states = client.subscribe_state();
    tokio::spawn(async move {
        loop {
            if states.changed().await.is_err() {
                break;
            }
            let current = *states.borrow_and_update();
            state_tx.send_replace(map_connection_state(current));
            if current != PondConnectionState::Disconnected || !active.load(Ordering::SeqCst) {
                continue;
            }
            let mut delay = INITIAL_RECONNECT_DELAY;
            while active.load(Ordering::SeqCst)
                && client.state() == PondConnectionState::Disconnected
            {
                tokio::time::sleep(delay).await;
                if !active.load(Ordering::SeqCst) {
                    break;
                }
                if client.connect().await.is_ok() {
                    state_tx.send_replace(map_connection_state(client.state()));
                    break;
                }
                delay = next_reconnect_delay(delay, max_reconnect_delay);
            }
        }
    });
}

fn next_reconnect_delay(current: Duration, max: Duration) -> Duration {
    let doubled = current.saturating_mul(2);
    if doubled > max { max } else { doubled }
}

impl RawSocketChannel {
    fn new(channel: PondChannel) -> Self {
        let (state_tx, _) = watch::channel(map_channel_state(channel.state()));
        let (message_tx, _) = broadcast::channel(1024);

        let mut pond_states = channel.subscribe_state();
        let mirror_state_tx = state_tx.clone();
        tokio::spawn(async move {
            loop {
                mirror_state_tx.send_replace(map_channel_state(*pond_states.borrow_and_update()));
                if pond_states.changed().await.is_err() {
                    break;
                }
            }
        });

        let mut pond_events = channel.subscribe_events();
        let mirror_message_tx = message_tx.clone();
        tokio::spawn(async move {
            while let Ok(event) = pond_events.recv().await {
                if let Some((event, payload)) = map_channel_event(event) {
                    let _ = mirror_message_tx.send((event, payload));
                }
            }
        });

        Self {
            channel,
            state_tx,
            message_tx,
        }
    }

    pub(crate) fn name(&self) -> &str {
        self.channel.name()
    }

    pub(crate) fn subscribe_state(&self) -> watch::Receiver<ChannelState> {
        self.state_tx.subscribe()
    }

    pub(crate) fn subscribe_messages(&self) -> broadcast::Receiver<(String, EventData)> {
        self.message_tx.subscribe()
    }

    fn closed_error(&self) -> Option<VoxRtcError> {
        match self.channel.state() {
            PondChannelState::Closed | PondChannelState::Declined => {
                Some(VoxRtcError::ChannelClosed)
            }
            _ => None,
        }
    }

    pub(crate) async fn join(&self) -> Result<()> {
        if let Some(error) = self.closed_error() {
            return Err(error);
        }
        self.channel.join().await;
        Ok(())
    }

    pub(crate) async fn leave(&self) -> Result<()> {
        if let Some(error) = self.closed_error() {
            return Err(error);
        }
        self.channel.leave().await;
        Ok(())
    }

    pub(crate) async fn send_message(&self, event: &str, payload: EventData) -> Result<()> {
        if let Some(error) = self.closed_error() {
            return Err(error);
        }
        self.channel.send_message(event, Some(payload)).await;
        Ok(())
    }
}

fn map_connection_state(state: PondConnectionState) -> ConnectionState {
    match state {
        PondConnectionState::Connecting => ConnectionState::Connecting,
        PondConnectionState::Connected => ConnectionState::Connected,
        PondConnectionState::Disconnected => ConnectionState::Disconnected,
    }
}

fn map_channel_state(state: PondChannelState) -> ChannelState {
    match state {
        PondChannelState::Idle => ChannelState::Idle,
        PondChannelState::Joining => ChannelState::Joining,
        PondChannelState::Joined => ChannelState::Joined,
        PondChannelState::Closed => ChannelState::Closed,
        PondChannelState::Declined => ChannelState::Declined,
        PondChannelState::Stalled => ChannelState::Joining,
    }
}

fn map_channel_event(event: ChannelEvent) -> Option<(String, EventData)> {
    match event {
        ChannelEvent::Message(message) => Some((message.event, message.payload)),
        ChannelEvent::Presence(_) => None,
    }
}

impl From<ClientError> for VoxRtcError {
    fn from(value: ClientError) -> Self {
        match value {
            ClientError::Url(err) => Self::InvalidUrl(err),
            ClientError::Serialization(err) => Self::Json(err),
            ClientError::WebSocket(err) => Self::PondSocketClient(err.to_string()),
            ClientError::NotConnected => Self::NotConnected,
            ClientError::ChannelClosed => Self::ChannelClosed,
            other => Self::PondSocketClient(other.to_string()),
        }
    }
}

#[cfg(test)]
pub(crate) async fn test_channel() -> (RawSocketChannel, broadcast::Sender<(String, EventData)>) {
    let client = PondClient::new("ws://localhost/socket", None).expect("valid test url");
    let channel = client.create_channel("/rtc/test", None).await;
    let raw = RawSocketChannel::new(channel);
    let sender = raw.message_tx.clone();
    (raw, sender)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinguishes_not_connected_from_channel_closed() {
        assert!(matches!(
            VoxRtcError::from(ClientError::NotConnected),
            VoxRtcError::NotConnected
        ));
        assert!(matches!(
            VoxRtcError::from(ClientError::ChannelClosed),
            VoxRtcError::ChannelClosed
        ));
    }

    #[test]
    fn reconnect_delay_doubles_then_caps() {
        let max = Duration::from_secs(5);
        assert_eq!(
            next_reconnect_delay(Duration::from_millis(200), max),
            Duration::from_millis(400)
        );
        assert_eq!(
            next_reconnect_delay(Duration::from_secs(4), max),
            Duration::from_secs(5)
        );
        assert_eq!(next_reconnect_delay(max, max), max);
    }

    #[tokio::test]
    async fn send_message_errors_when_channel_closed() {
        let (channel, _sender) = test_channel().await;
        channel.leave().await.expect("first leave closes channel");
        let error = channel
            .send_message("response.start", EventData::new())
            .await
            .expect_err("closed channel must reject sends");
        assert!(matches!(error, VoxRtcError::ChannelClosed));
    }

    #[tokio::test]
    async fn join_and_leave_error_when_channel_closed() {
        let (channel, _sender) = test_channel().await;
        channel.leave().await.expect("first leave closes channel");
        assert!(matches!(
            channel
                .join()
                .await
                .expect_err("cannot join a closed channel"),
            VoxRtcError::ChannelClosed
        ));
        assert!(matches!(
            channel
                .leave()
                .await
                .expect_err("cannot leave an already-closed channel"),
            VoxRtcError::ChannelClosed
        ));
    }

    #[tokio::test]
    async fn lagged_broadcast_does_not_stop_consumption() {
        let (tx, mut rx) = broadcast::channel::<(String, EventData)>(2);
        for index in 0..5u32 {
            let _ = tx.send((format!("event-{index}"), EventData::new()));
        }

        let mut lagged = false;
        let mut delivered = Vec::new();
        loop {
            match rx.try_recv() {
                Ok(message) => delivered.push(message.0),
                Err(broadcast::error::TryRecvError::Lagged(_)) => lagged = true,
                Err(_) => break,
            }
        }

        assert!(lagged, "small buffer overflow must surface a lag");
        assert!(
            delivered.contains(&"event-4".to_owned()),
            "consumer must keep reading past the lag: {delivered:?}"
        );
    }
}
