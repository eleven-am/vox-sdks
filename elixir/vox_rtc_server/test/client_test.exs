defmodule VoxRtcServer.ClientTest do
  use ExUnit.Case, async: false

  alias VoxRtcServer.{
    Client,
    ErrorEvent,
    Event,
    IceCandidate,
    ResponseOptions,
    ResponseOutput,
    ResponseOutputOptions,
    Session,
    SessionConfig,
    SessionDescription,
    SpeechContext,
    SpeechContextSoundSpan,
    SpeechContextSpan,
    TranscriptCompleted,
    StartAck
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
               voice: "af_heart",
               speech_context: true
             })

    assert_receive {:control_sent, ^stream,
                    %Vox.RtcControlClientMessage{
                      msg: {:session_update, %Vox.ConversationSessionUpdate{} = update}
                    }}

    assert update.stt_model == "parakeet-stt:tdt-0.6b-v3"
    assert update.tts_model == "kokoro-tts:v1.0"
    assert update.speech_context

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

  test "streams one response generation over the ordered control stream", %{
    client: client
  } do
    {_bootstrap, session, stream, _receiver} = create_attached_session(client)

    options = %ResponseOptions{
      allow_interruptions: true,
      output: %ResponseOutputOptions{
        model: "qwen3-tts:0.6b-clone",
        voice: "samantha",
        language: "fr",
        speed: 0.9,
        params: %{"temperature" => 0.7}
      }
    }

    assert :ok = Session.start_response(session, options)
    assert :ok = Session.append_response_text(session, "Hello", options)
    assert :ok = Session.append_response_text(session, " world", options)
    assert :ok = Session.commit_response(session)
    assert :ok = Session.cancel_response(session)

    assert :ok =
             Session.send_client_event(session, "application.context", %{document_id: "doc-1"})

    assert_receive {:control_sent, ^stream,
                    %Vox.RtcControlClientMessage{msg: {:response_start, start}}}

    assert is_binary(start.generation_id)
    assert start.generation_id != ""
    assert start.allow_interruptions
    assert start.output.model == "qwen3-tts:0.6b-clone"
    assert start.output.voice == "samantha"
    assert start.output.language == "fr"
    assert start.output.speed == 0.9
    assert Google.Protobuf.to_map(start.output.params) == %{"temperature" => 0.7}

    assert_receive {:control_sent, ^stream,
                    %Vox.RtcControlClientMessage{msg: {:response_delta, first_delta}}}

    assert first_delta.delta == "Hello"
    assert first_delta.generation_id == start.generation_id

    assert_receive {:control_sent, ^stream,
                    %Vox.RtcControlClientMessage{msg: {:response_delta, second_delta}}}

    assert second_delta.delta == " world"
    assert second_delta.generation_id == start.generation_id

    assert_receive {:control_sent, ^stream,
                    %Vox.RtcControlClientMessage{msg: {:response_commit, commit}}}

    assert commit.generation_id == start.generation_id

    assert_receive {:control_sent, ^stream,
                    %Vox.RtcControlClientMessage{msg: {:response_cancel, cancel}}}

    assert cancel.generation_id == start.generation_id

    assert_receive {:control_sent, ^stream,
                    %Vox.RtcControlClientMessage{msg: {:client_event, client_event}}}

    assert client_event.event == "application.context"
  end

  test "preserves an explicit response generation", %{client: client} do
    {_bootstrap, session, stream, _receiver} = create_attached_session(client)
    options = %ResponseOptions{generation_id: "generation-explicit"}

    assert :ok = Session.start_response(session, options)
    assert :ok = Session.append_response_text(session, "Hello", %ResponseOptions{})
    assert :ok = Session.commit_response(session)

    for expected_kind <- [:response_start, :response_delta, :response_commit] do
      assert_receive {:control_sent, ^stream,
                      %Vox.RtcControlClientMessage{
                        msg: {^expected_kind, %{generation_id: "generation-explicit"}}
                      }}
    end
  end

  test "waits for the matching response.created acknowledgement", %{client: client} do
    {_bootstrap, session, stream, receiver} = create_attached_session(client)

    task =
      Task.async(fn ->
        Session.start_response_and_wait(session, %ResponseOptions{}, 1_000)
      end)

    assert_receive {:control_sent, ^stream,
                    %Vox.RtcControlClientMessage{msg: {:response_start, start}}}

    send_conversation(receiver, stream, :response_created, %Vox.ConversationResponseCreated{
      response_id: "response-stale",
      generation_id: "generation-stale"
    })

    assert_receive {:vox_rtc, ^session,
                    %Event{
                      type: :response_created,
                      payload: %Vox.ConversationResponseCreated{
                        generation_id: "generation-stale"
                      }
                    }}

    assert Task.yield(task, 20) == nil

    send_conversation(receiver, stream, :response_created, %Vox.ConversationResponseCreated{
      response_id: "response-current",
      generation_id: start.generation_id,
      output: %Vox.ConversationResponseOutput{
        model: "qwen3-tts:0.6b-clone",
        voice: "samantha",
        language: "fr",
        speed: 0.9,
        params: Google.Protobuf.from_map(%{"temperature" => 0.7})
      }
    })

    assert {:ok,
            %StartAck{
              response_id: "response-current",
              generation_id: generation_id,
              output: %ResponseOutput{
                model: "qwen3-tts:0.6b-clone",
                voice: "samantha",
                language: "fr",
                speed: 0.9,
                params: %{"temperature" => 0.7}
              }
            }} = Task.await(task)

    assert generation_id == start.generation_id
  end

  test "returns and broadcasts a correlated typed response rejection", %{client: client} do
    {_bootstrap, session, stream, receiver} = create_attached_session(client)

    task =
      Task.async(fn ->
        Session.start_response_and_wait(
          session,
          %ResponseOptions{generation_id: "generation-rejected"},
          1_000
        )
      end)

    assert_receive {:control_sent, ^stream,
                    %Vox.RtcControlClientMessage{
                      msg:
                        {:response_start,
                         %Vox.ConversationResponseStart{
                           generation_id: "generation-rejected"
                         }}
                    }}

    send_conversation(receiver, stream, :error, %Vox.ConversationError{
      message: "Response start no longer matches the active turn",
      code: "response_stale_generation",
      recoverable: true,
      generation_id: "generation-rejected"
    })

    assert {:error,
            %ErrorEvent{
              code: "response_stale_generation",
              recoverable: true,
              generation_id: "generation-rejected"
            }} = Task.await(task)

    assert_receive {:vox_rtc, ^session,
                    %Event{
                      type: :error,
                      payload: %ErrorEvent{
                        message: "Response start no longer matches the active turn",
                        code: "response_stale_generation",
                        recoverable: true,
                        generation_id: "generation-rejected"
                      }
                    }}
  end

  test "returns a typed timeout when response.start is not acknowledged", %{client: client} do
    {_bootstrap, session, stream, _receiver} = create_attached_session(client)

    task = Task.async(fn -> Session.start_response_and_wait(session, %ResponseOptions{}, 10) end)

    assert_receive {:control_sent, ^stream,
                    %Vox.RtcControlClientMessage{msg: {:response_start, start}}}

    assert {:error,
            %ErrorEvent{
              code: "start_ack_timeout",
              recoverable: true,
              generation_id: generation_id
            }} = Task.await(task)

    assert generation_id == start.generation_id
  end

  test "releases a response waiter when the control stream closes", %{client: client} do
    {_bootstrap, session, stream, receiver} = create_attached_session(client)

    task =
      Task.async(fn ->
        Session.start_response_and_wait(
          session,
          %ResponseOptions{generation_id: "generation-closed"},
          1_000
        )
      end)

    assert_receive {:control_sent, ^stream,
                    %Vox.RtcControlClientMessage{msg: {:response_start, _start}}}

    send(receiver, {:server_done, stream.reference})

    assert {:error,
            %ErrorEvent{
              code: "session_failed",
              recoverable: false,
              generation_id: "generation-closed"
            }} = Task.await(task)
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
              %Vox.ConversationTranscriptDone{
                transcript: "hello",
                language: "en",
                speech_context: speech_context_fixture()
              }}
         }}
    })

    assert_receive {:vox_rtc, ^session,
                    %Event{
                      type: :transcript_completed,
                      payload: %TranscriptCompleted{
                        transcript: "hello",
                        speech_context: %SpeechContext{
                          schema_version: 2,
                          status: :complete,
                          emotions: [
                            %SpeechContextSpan{
                              label: "surprised",
                              start_ms: 0,
                              end_ms: 2500
                            }
                          ],
                          vocal: [
                            %SpeechContextSpan{
                              label: "laughter",
                              start_ms: 7000,
                              end_ms: 10_500
                            }
                          ],
                          sounds: [
                            %SpeechContextSoundSpan{
                              label: "fireworks",
                              start_ms: 3360,
                              end_ms: 4320,
                              score: 0.42
                            },
                            %SpeechContextSoundSpan{
                              label: "inside, small room",
                              start_ms: 3840,
                              end_ms: 5280,
                              score: 0.31
                            }
                          ]
                        }
                      }
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

    send_server(receiver, stream, %Vox.RtcControlServerMessage{
      msg:
        {:error,
         %Vox.RtcSignalingError{
           message: "Offer generation is stale",
           code: "response_stale_generation",
           recoverable: true,
           generation_id: "generation-signaling"
         }}
    })

    assert_receive {:vox_rtc, ^session,
                    %Event{
                      type: :error,
                      payload: %ErrorEvent{
                        message: "Offer generation is stale",
                        code: "response_stale_generation",
                        recoverable: true,
                        generation_id: "generation-signaling"
                      }
                    }}
  end

  test "rejects malformed speech context instead of fabricating a typed value" do
    malformed =
      Google.Protobuf.from_map(%{
        "schema_version" => 2,
        "status" => "complete",
        "emotions" => [],
        "vocal" => [],
        "sounds" => [
          %{
            "label" => "fireworks",
            "start_ms" => 0,
            "end_ms" => 960,
            "score" => 1.1
          }
        ]
      })

    assert SpeechContext.decode(malformed) == nil
  end

  test "rejects malformed response output instead of fabricating a typed value" do
    malformed = %Vox.ConversationResponseOutput{
      model: "qwen3-tts:0.6b-clone",
      language: "fr",
      speed: 0.9
    }

    assert ResponseOutput.decode(malformed) == nil
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

  test "forwards an explicit browser_events preference and omits it otherwise", %{
    client: client
  } do
    task =
      Task.async(fn ->
        Client.create_controlled_session(client,
          browser_events: true,
          attach_timeout: 30,
          timeout: 1_000,
          subscriber: self()
        )
      end)

    assert_receive {:create_session, caller, reference, request, _options}
    assert request.browser_events == true

    bootstrap = %Vox.RtcSessionBootstrap{
      session_id: "rtc_test",
      expires_at: "2026-07-16T22:00:00Z",
      attach_ttl_seconds: 30,
      ice_servers: []
    }

    send(caller, {:create_session_reply, reference, {:ok, bootstrap}})

    assert Task.await(task) == {:error, :attach_timeout}
  end

  test "turn policy no longer advertises the server-reserved stable_speaking_min_ms knob", %{
    client: client
  } do
    refute Map.has_key?(%VoxRtcServer.TurnPolicy{}, :stable_speaking_min_ms)
    refute Map.has_key?(%Vox.ConversationTurnPolicy{}, :stable_speaking_min_ms)

    {_bootstrap, session, stream, _receiver} = create_attached_session(client)

    assert :ok =
             Session.configure(session, %SessionConfig{
               policy: %VoxRtcServer.TurnPolicy{
                 allow_interrupt_while_speaking: true,
                 min_interrupt_words: 3
               }
             })

    assert_receive {:control_sent, ^stream,
                    %Vox.RtcControlClientMessage{
                      msg: {:session_update, %Vox.ConversationSessionUpdate{policy: policy}}
                    }}

    assert policy.allow_interrupt_while_speaking == true
    assert policy.min_interrupt_words == 3
  end

  test "a terminal response error clears the ambient generation for the next append", %{
    client: client
  } do
    {_bootstrap, session, stream, receiver} = create_attached_session(client)

    assert :ok = Session.start_response(session, %ResponseOptions{})

    assert_receive {:control_sent, ^stream,
                    %Vox.RtcControlClientMessage{msg: {:response_start, start}}}

    dead_generation = start.generation_id
    assert dead_generation != ""

    send_conversation(receiver, stream, :error, %Vox.ConversationError{
      message: "response generation failed",
      code: "response_failed",
      recoverable: false,
      generation_id: dead_generation
    })

    assert_receive {:vox_rtc, ^session,
                    %Event{type: :error, payload: %ErrorEvent{code: "response_failed"}}}

    assert :ok = Session.append_response_text(session, "after failure")

    assert_receive {:control_sent, ^stream,
                    %Vox.RtcControlClientMessage{msg: {:response_delta, delta}}}

    assert delta.delta == "after failure"
    refute delta.generation_id == dead_generation
    assert delta.generation_id == ""
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
    assert request.browser_events == nil
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

  defp send_conversation(receiver, stream, kind, payload) do
    send_server(receiver, stream, %Vox.RtcControlServerMessage{
      msg: {:conversation, %Vox.ConverseServerMessage{msg: {kind, payload}}}
    })
  end

  defp speech_context_fixture do
    __DIR__
    |> Path.join("../../../fixtures/speech-context-v2.json")
    |> File.read!()
    |> Jason.decode!()
    |> Google.Protobuf.from_map()
  end
end
