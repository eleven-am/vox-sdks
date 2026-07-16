import React from "react";
import { createRoot } from "react-dom/client";

import { VoxRtcBrowserClient } from "@eleven-am/vox-rtc-client";

import "./styles.css";

const TRANSCRIPT_EVENT = "conversation.item.input_audio_transcription.completed";

class App extends React.Component {
  audio = React.createRef();
  client = null;
  unsubscribers = [];
  state = {
    status: "idle",
    peer: "idle",
    ice: "idle",
    data: "idle",
    sessionId: "none",
    transcript: "none",
    error: null,
    events: [],
  };

  componentWillUnmount() {
    void this.disconnect();
  }

  record = (type, data = {}) => {
    this.setState((state) => ({
      events: [
        { at: new Date().toLocaleTimeString(), type, data },
        ...state.events,
      ].slice(0, 80),
    }));
  };

  connect = async () => {
    if (this.client) return;
    this.setState({ error: null });
    const client = new VoxRtcBrowserClient({
      signalingEndpoint: "/api/vox/rtc",
      audioElement: this.audio.current,
      autoPlayRemoteAudio: true,
      audioConstraints: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      audioDucking: true,
    });
    this.client = client;
    this.unsubscribers = [
      client.on("state", (state) => {
        this.setState({
          status: state.status,
          peer: state.peerConnectionState,
          ice: state.iceConnectionState,
          data: state.dataChannelState,
        });
      }),
      client.on("session", (session) => this.setState({ sessionId: session.sessionId })),
      client.on("signalingMessage", (event) => {
        this.record(event.type, event.data);
        if (event.type === TRANSCRIPT_EVENT && typeof event.data.transcript === "string") {
          this.setState({ transcript: event.data.transcript });
        }
      }),
      client.on("error", (error) => this.setState({ error: error.message })),
    ];

    try {
      await client.connect();
    } catch (error) {
      this.setState({ error: error instanceof Error ? error.message : String(error) });
      this.releaseClient();
    }
  };

  restartIce = async () => {
    try {
      await this.client?.restartIce();
      this.record("local.ice_restarted");
    } catch (error) {
      this.setState({ error: error instanceof Error ? error.message : String(error) });
    }
  };

  disconnect = async () => {
    const client = this.client;
    this.client = null;
    await client?.disconnect();
    this.releaseClient();
    this.setState({
      status: "closed",
      peer: "idle",
      ice: "idle",
      data: "idle",
      sessionId: "none",
    });
  };

  releaseClient = () => {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    this.client = null;
  };

  render() {
    const connected = this.state.status === "connected";
    const busy = this.state.status === "connecting" || this.state.status === "disconnecting";
    return (
      <main>
        <h1>Vox RTC Gateway Demo</h1>
        <section>
          <div className="status-grid">
            <Status label="Client" value={this.state.status} />
            <Status label="Peer" value={this.state.peer} />
            <Status label="ICE" value={this.state.ice} />
            <Status label="Data channel" value={this.state.data} />
            <Status label="Session" value={this.state.sessionId} />
          </div>
          <div className="actions">
            <button type="button" onClick={this.connect} disabled={connected || busy}>Connect</button>
            <button type="button" onClick={this.restartIce} disabled={!connected}>Restart ICE</button>
            <button type="button" onClick={this.disconnect} disabled={!this.client}>Disconnect</button>
          </div>
          <audio ref={this.audio} autoPlay controls />
          {this.state.error ? <p className="error">{this.state.error}</p> : null}
        </section>
        <section>
          <h2>Last transcript</h2>
          <p>{this.state.transcript}</p>
        </section>
        <section>
          <h2>Gateway events</h2>
          <div className="timeline">
            {this.state.events.map((event, index) => (
              <div key={`${event.at}-${event.type}-${index}`}>
                <time>{event.at}</time>
                <span>{event.type}</span>
              </div>
            ))}
          </div>
        </section>
      </main>
    );
  }
}

function Status({ label, value }) {
  return <div className="status"><span>{label}</span><strong>{value}</strong></div>;
}

createRoot(document.getElementById("root")).render(<App />);
