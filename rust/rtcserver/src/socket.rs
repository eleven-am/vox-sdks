use crate::error::{Result, VoxRtcError};
use crate::types::{ChannelState, ConnectionState, EventData};
use pondsocket_client::{
    Channel as PondChannel, ClientError, ClientOptions, ConnectionState as PondConnectionState,
    PondClient,
};
use pondsocket_common::{ChannelEvent, ChannelState as PondChannelState};
use std::time::Duration;
use tokio::sync::{broadcast, watch};

#[derive(Clone)]
pub(crate) struct RawSocketClient {
    client: PondClient,
    params: EventData,
    state_tx: watch::Sender<ConnectionState>,
}

#[derive(Clone)]
pub(crate) struct RawSocketChannel {
    channel: PondChannel,
    state_tx: watch::Sender<ChannelState>,
    message_tx: broadcast::Sender<(String, EventData)>,
}

impl RawSocketClient {
    pub(crate) fn new(endpoint: &str, params: EventData) -> Result<Self> {
        let options = ClientOptions {
            connection_timeout: Duration::from_secs(10),
            ..ClientOptions::default()
        };
        let client = PondClient::with_options(endpoint, Some(params.clone()), options)?;
        let (state_tx, _) = watch::channel(map_connection_state(client.state()));
        Ok(Self {
            client,
            params,
            state_tx,
        })
    }

    pub(crate) fn state(&self) -> ConnectionState {
        map_connection_state(self.client.state())
    }

    pub(crate) fn subscribe_state(&self) -> watch::Receiver<ConnectionState> {
        self.state_tx.subscribe()
    }

    pub(crate) async fn connect(&self) -> Result<()> {
        self.state_tx
            .send_replace(map_connection_state(self.client.state()));
        self.client.connect().await?;
        self.state_tx
            .send_replace(map_connection_state(self.client.state()));
        Ok(())
    }

    pub(crate) async fn disconnect(&self) {
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

    pub(crate) async fn join(&self) -> Result<()> {
        self.channel.join().await;
        Ok(())
    }

    pub(crate) async fn leave(&self) -> Result<()> {
        self.channel.leave().await;
        Ok(())
    }

    pub(crate) async fn send_message(&self, event: &str, payload: EventData) -> Result<()> {
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
            ClientError::NotConnected | ClientError::ChannelClosed => Self::Disconnected,
            other => Self::PondSocketClient(other.to_string()),
        }
    }
}
