defmodule VoxRtcServer.ClientTest do
  use ExUnit.Case, async: false

  alias VoxRtcServer.{
    Client,
    Event,
    IceCandidate,
    ResponseOptions,
    Session,
    SessionConfig,
    SessionDescription
  }

  setup do
    client =
      start_supervised!(
        {Client,
         target: "vox.internal:9090",
         api_key: "secret",
         transport: VoxRtcServer.TestTransport,
         connect_options: [test: self()]}
      )

    assert_receive {:transport_connected, "vox.internal:9090", options}
    assert options[:test] == self()
    %{client: client}
  end

  test "ships the HTTP/2 adapter used by the default gRPC transport" do
    assert Code.ensure_loaded?(GRPC.Client.Adapters.Mint)
    assert function_exported?(GRPC.Client.Adapters.Mint, :connect, 2)
  end

  test "creates a private session and sends attach before every other control message", %{
    client: client
  } do
    {bootstrap, session, stream, _receiver} = create_attached_session(client)

    assert bootstrap.session_id == "rtc_test"
    assert bootstrap.attach_ttl_seconds == 30
    assert [%VoxRtcServer.IceServer{urls: ["stun:example.test"]}] = bootstrap.ice_servers
    assert Session.session_id(session) == "rtc_test"

    assert :ok =
             Session.configure(session, %SessionConfig{
               stt_model: "parakeet-stt:tdt-0.6b-v3",
               tts_model: "kokoro-tts:v1.0",
               voice: "af_heart"
             })

    assert_receive {:control_sent, ^stream,
                    %Vox.RtcControlClientMessage{
                      msg: {:session_update, %Vox.ConversationSessionUpdate{} = update}
                    }}

    assert update.stt_model == "parakeet-stt:tdt-0.6b-v3"
    assert update.tts_model == "kokoro-tts:v1.0"

    assert :ok =
             Session.send_offer(
               session,
               %SessionDescription{type: "offer", sdp: "offer-sdp"},
               true
             )

    assert_receive {:control_sent, ^stream, %Vox.RtcControlClientMessage{msg: {:offer, offer}}}

    assert offer.restart
    assert offer.offer.sdp == "offer-sdp"

    assert :ok =
             Session.send_ice_candidate(session, %IceCandidate{
               candidate: "candidate:browser",
               sdp_mid: "0",
               sdp_m_line_index: 0
             })

    assert_receive {:control_sent, ^stream,
                    %Vox.RtcControlClientMessage{msg: {:candidate, candidate}}}

    assert candidate.candidate == "candidate:browser"
    assert candidate.sdp_m_line_index == 0

    assert :ok = Session.send_ice_candidate(session, :complete)

    assert_receive {:control_sent, ^stream,
                    %Vox.RtcControlClientMessage{msg: {:candidates_complete, _complete}}}
  end

  test "streams generative response commands and client events over the same control stream", %{
    client: client
  } do
    {_bootstrap, session, stream, _receiver} = create_attached_session(client)
    options = %ResponseOptions{allow_interruptions: true}

    assert :ok = Session.start_response(session, options)
    assert :ok = Session.append_response_text(session, "Hello", options)
    assert :ok = Session.append_response_text(session, " world", options)
    assert :ok = Session.replace_response_text(session, "Hello world", options)
    assert :ok = Session.commit_response(session)
    assert :ok = Session.cancel_response(session)

    assert :ok =
             Session.send_client_event(session, "application.context", %{document_id: "doc-1"})

    kinds =
      for _ <- 1..7 do
        assert_receive {:control_sent, ^stream,
                        %Vox.RtcControlClientMessage{msg: {kind, _payload}}}

        kind
      end

    assert kinds == [
             :response_start,
             :response_delta,
             :response_delta,
             :response_replace_text,
             :response_commit,
             :response_cancel,
             :client_event
           ]
  end

  test "delivers typed signaling, conversation, browser, and malformed wire events", %{
    client: client
  } do
    {_bootstrap, session, stream, receiver} = create_attached_session(client)

    send_server(receiver, stream, %Vox.RtcControlServerMessage{
      msg:
        {:answer,
         %Vox.RtcControlAnswer{
           session_id: "rtc_test",
           answer: %Vox.RtcSessionDescription{type: "answer", sdp: "answer-sdp"}
         }}
    })

    assert_receive {:vox_rtc, ^session,
                    %Event{
                      type: :answer,
                      payload: %SessionDescription{sdp: "answer-sdp"}
                    }}

    send_server(receiver, stream, %Vox.RtcControlServerMessage{
      msg:
        {:conversation,
         %Vox.ConverseServerMessage{
           msg:
             {:transcript_done,
              %Vox.ConversationTranscriptDone{transcript: "hello", language: "en"}}
         }}
    })

    assert_receive {:vox_rtc, ^session,
                    %Event{
                      type: :transcript_completed,
                      payload: %Vox.ConversationTranscriptDone{transcript: "hello"}
                    }}

    send_server(receiver, stream, %Vox.RtcControlServerMessage{
      msg:
        {:browser_event, %Vox.RtcClientEvent{event: "rtc.stats", payload_json: ~s({"rtt_ms":23})}}
    })

    assert_receive {:vox_rtc, ^session,
                    %Event{
                      type: :browser_event,
                      payload: %{name: "rtc.stats", data: %{"rtt_ms" => 23}}
                    }}

    send_server(receiver, stream, %Vox.RtcControlServerMessage{
      msg: {:event, %Vox.RtcWireEvent{type: "custom", payload_json: "not-json"}}
    })

    assert_receive {:vox_rtc, ^session,
                    %Event{
                      type: :wire_event,
                      payload: %{name: "custom", raw_payload: "not-json", decode_error: _error}
                    }}
  end

  test "an attach timeout tears down the stream and returns an error", %{client: client} do
    task =
      Task.async(fn ->
        Client.create_controlled_session(client,
          attach_timeout: 30,
          timeout: 1_000,
          subscriber: self()
        )
      end)

    reply_to_create()
    assert_receive {:control_opened, stream, _options}
    assert_receive {:control_sent, ^stream, %Vox.RtcControlClientMessage{msg: {:attach, _attach}}}
    assert_receive {:receiver_ready, ^stream, _receiver}

    assert Task.await(task) == {:error, :attach_timeout}
    assert_receive {:stream_cancelled, ^stream}
  end

  test "a stream failure before attach is returned and does not leak the session", %{
    client: client
  } do
    task =
      Task.async(fn ->
        Client.create_controlled_session(client, timeout: 1_000, subscriber: self())
      end)

    reply_to_create()
    assert_receive {:control_opened, stream, _options}
    assert_receive {:control_sent, ^stream, %Vox.RtcControlClientMessage{msg: {:attach, _attach}}}
    assert_receive {:receiver_ready, ^stream, receiver}

    send(receiver, {:server_item, stream.reference, {:error, :unavailable}})

    assert Task.await(task) == {:error, :unavailable}
    assert_receive {:stream_cancelled, ^stream}
  end

  test "explicit close sends one close and ends the stream exactly once", %{client: client} do
    {_bootstrap, session, stream, _receiver} = create_attached_session(client)
    monitor = Process.monitor(session)

    assert :ok = Session.close(session, "test_complete")

    assert_receive {:control_sent, ^stream,
                    %Vox.RtcControlClientMessage{
                      msg: {:close, %Vox.RtcControlClose{reason: "test_complete"}}
                    }}

    assert_receive {:stream_ended, ^stream}

    assert_receive {:vox_rtc, ^session,
                    %Event{type: :closed, payload: %{reason: "test_complete"}}}

    assert_receive {:DOWN, ^monitor, :process, ^session, :normal}
    refute_receive {:stream_ended, ^stream}, 20
  end

  test "closing the client closes owned sessions and disconnects the channel exactly once", %{
    client: client
  } do
    {_bootstrap, session, stream, _receiver} = create_attached_session(client)
    client_monitor = Process.monitor(client)

    assert :ok = Client.close(client)
    assert_receive {:control_sent, ^stream, %Vox.RtcControlClientMessage{msg: {:close, _close}}}
    assert_receive {:stream_ended, ^stream}
    assert_receive {:transport_disconnected, _channel}
    assert_receive {:DOWN, ^client_monitor, :process, ^client, :normal}
    refute Process.alive?(session)
    refute_receive {:transport_disconnected, _channel}, 20
  end

  test "an abrupt client exit closes its session stream", %{client: client} do
    {_bootstrap, session, stream, _receiver} = create_attached_session(client)
    session_monitor = Process.monitor(session)

    Process.exit(client, :kill)

    assert_receive {:control_sent, ^stream,
                    %Vox.RtcControlClientMessage{
                      msg: {:close, %Vox.RtcControlClose{reason: "owner_closed"}}
                    }}

    assert_receive {:stream_ended, ^stream}
    assert_receive {:vox_rtc, ^session, %Event{type: :closed, payload: %{reason: "owner_closed"}}}
    assert_receive {:DOWN, ^session_monitor, :process, ^session, :normal}
  end

  defp create_attached_session(client) do
    subscriber = self()
    task = Task.async(fn -> Client.create_controlled_session(client, subscriber: subscriber) end)
    reply_to_create()

    assert_receive {:control_opened, stream, options}
    assert options[:metadata] == %{"authorization" => "Bearer secret"}

    assert_receive {:control_sent, ^stream,
                    %Vox.RtcControlClientMessage{
                      msg: {:attach, %Vox.RtcControlAttach{session_id: "rtc_test"}}
                    }}

    assert_receive {:receiver_ready, ^stream, receiver}

    send_server(receiver, stream, %Vox.RtcControlServerMessage{
      msg: {:attached, %Vox.RtcSessionAttached{session_id: "rtc_test", provider: "grpc"}}
    })

    assert {:ok, bootstrap, session} = Task.await(task)
    assert_receive {:vox_rtc, ^session, %Event{type: :session_attached}}
    {bootstrap, session, stream, receiver}
  end

  defp reply_to_create do
    assert_receive {:create_session, caller, reference, request, options}
    assert request.browser_events == false
    assert options[:metadata] == %{"authorization" => "Bearer secret"}

    bootstrap = %Vox.RtcSessionBootstrap{
      session_id: "rtc_test",
      expires_at: "2026-07-16T22:00:00Z",
      attach_ttl_seconds: 30,
      ice_servers: [%Vox.RtcIceServer{urls: ["stun:example.test"]}]
    }

    send(caller, {:create_session_reply, reference, {:ok, bootstrap}})
  end

  defp send_server(receiver, stream, message) do
    send(receiver, {:server_item, stream.reference, {:ok, message}})
  end
end
