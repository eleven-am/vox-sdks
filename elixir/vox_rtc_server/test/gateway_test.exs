defmodule VoxRtcServer.GatewayTest.FakeClient do
  alias VoxRtcServer.{Bootstrap, IceServer}

  def create_controlled_session(client, _options) do
    {:ok,
     %Bootstrap{
       session_id: "rtc_gateway",
       expires_at: "2026-08-01T12:00:00Z",
       attach_ttl_seconds: 120,
       ice_servers: [%IceServer{urls: ["stun:turn.test:3478"]}]
     }, client}
  end
end

defmodule VoxRtcServer.GatewayTest.FailingClient do
  def create_controlled_session(_client, _options), do: {:error, :unavailable}
end

defmodule VoxRtcServer.GatewayTest.FakeSession do
  def send_offer(session, offer, restart, generation) do
    notify(session, {:offer, offer, restart, generation})
  end

  def send_ice_candidate(session, candidate, generation) do
    notify(session, {:candidate, candidate, generation})
  end

  def close(session, reason) do
    notify(session, {:close, reason})
  end

  defp notify(session, message) do
    owner = Agent.get(session, & &1)
    send(owner, message)
    :ok
  end
end

defmodule VoxRtcServer.GatewayTest do
  use ExUnit.Case, async: true

  alias VoxRtcServer.{ErrorEvent, Event, Gateway, IceCandidate, SessionDescription}

  alias VoxRtcServer.GatewayTest.{FailingClient, FakeClient, FakeSession}

  setup do
    owner = self()
    {:ok, session} = Agent.start_link(fn -> owner end)

    options = %{
      client: session,
      client_module: FakeClient,
      session_module: FakeSession,
      request: %{headers: [{"x-user-id", "user-1"}]},
      on_session_created: nil,
      on_session_closed: nil,
      on_error: nil
    }

    %{session: session, options: options}
  end

  test "Plug defaults keep quiet signaling sockets alive" do
    options = Gateway.init(client: :client)
    assert options[:path] == "/api/vox/rtc"
    assert options[:websocket_options][:timeout] == :infinity
    assert options[:websocket_options][:max_frame_size] == 1_048_576
  end

  test "failed setup can terminate without an allocated session", %{options: options} do
    options = Map.put(options, :client_module, FailingClient)

    assert {:stop, :unavailable, {1011, "RTC gateway setup failed"}, state} =
             Gateway.Socket.init(options)

    assert :ok = Gateway.Socket.terminate({:error, :unavailable}, state)
  end

  test "forwards generated offers, candidates, completion, and stale generations", %{
    session: session,
    options: options
  } do
    {:push, {:text, ready_json}, state} = Gateway.Socket.init(options)
    ready = Jason.decode!(ready_json)
    assert ready["type"] == "gateway.ready"
    assert ready["data"]["session"]["sessionId"] == "rtc_gateway"
    refute ready_json =~ "api_key"

    assert {:ok, state} =
             Gateway.Socket.handle_in(
               {Jason.encode!(%{
                  id: "offer-1",
                  type: "rtc.offer",
                  data: %{
                    offer: %{type: "offer", sdp: "offer-sdp"},
                    generation: 1
                  }
                }), opcode: :text},
               state
             )

    assert_receive {:offer, %SessionDescription{sdp: "offer-sdp"}, false, 1}

    assert {:ok, state} =
             Gateway.Socket.handle_in(
               {Jason.encode!(%{
                  id: "candidate-1",
                  type: "rtc.ice_candidate",
                  data: %{
                    candidate: %{
                      candidate: "candidate:first",
                      sdpMid: "audio",
                      sdpMLineIndex: 0
                    },
                    generation: 1
                  }
                }), opcode: :text},
               state
             )

    assert_receive {:candidate, %IceCandidate{candidate: "candidate:first", sdp_m_line_index: 0},
                    1}

    assert {:ok, state} =
             Gateway.Socket.handle_in(
               {Jason.encode!(%{
                  id: "candidate-complete",
                  type: "rtc.ice_candidate",
                  data: %{candidate: nil, generation: 1}
                }), opcode: :text},
               state
             )

    assert_receive {:candidate, :complete, 1}

    answer = %Event{
      type: :answer,
      payload: %SessionDescription{type: "answer", sdp: "answer-sdp", generation: 1},
      session_id: "rtc_gateway"
    }

    assert {:push, {:text, answer_json}, state} =
             Gateway.Socket.handle_info({:vox_rtc, session, answer}, state)

    assert %{
             "id" => "offer-1",
             "type" => "rtc.answer",
             "data" => %{"generation" => 1}
           } = Jason.decode!(answer_json)

    assert {:ok, state} =
             Gateway.Socket.handle_in(
               {Jason.encode!(%{
                  id: "offer-2",
                  type: "rtc.offer",
                  data: %{
                    offer: %{type: "offer", sdp: "restart-sdp"},
                    restart: true,
                    generation: 2
                  }
                }), opcode: :text},
               state
             )

    assert_receive {:offer, %SessionDescription{sdp: "restart-sdp"}, true, 2}

    assert {:ok, _state} =
             Gateway.Socket.handle_in(
               {Jason.encode!(%{
                  id: "stale-candidate",
                  type: "rtc.ice_candidate",
                  data: %{candidate: nil, generation: 1}
                }), opcode: :text},
               state
             )

    assert_receive {:candidate, :complete, 1}
  end

  test "generated negotiation rejects missing and malformed candidate generations", %{
    options: options
  } do
    {:push, _ready, state} = Gateway.Socket.init(options)

    {:ok, state} =
      Gateway.Socket.handle_in(
        {Jason.encode!(%{
           id: "offer",
           type: "rtc.offer",
           data: %{offer: %{type: "offer", sdp: "sdp"}, generation: 1}
         }), opcode: :text},
        state
      )

    for {id, data} <- [
          {"missing", %{candidate: nil}},
          {"malformed", %{candidate: nil, generation: 1.5}}
        ] do
      assert {:push, {:text, error_json}, ^state} =
               Gateway.Socket.handle_in(
                 {Jason.encode!(%{id: id, type: "rtc.ice_candidate", data: data}), opcode: :text},
                 state
               )

      error = Jason.decode!(error_json)
      assert error["id"] == id
      assert error["type"] == "gateway.error"
      assert error["data"]["code"] == "command_invalid"
    end
  end

  test "legacy negotiations remain compatible and null server candidates retain generation", %{
    session: session,
    options: options
  } do
    {:push, _ready, state} = Gateway.Socket.init(options)

    {:ok, state} =
      Gateway.Socket.handle_in(
        {Jason.encode!(%{
           id: "legacy-offer",
           type: "rtc.offer",
           data: %{offer: %{type: "offer", sdp: "legacy"}}
         }), opcode: :text},
        state
      )

    assert_receive {:offer, %SessionDescription{}, false, nil}

    complete = %Event{
      type: :ice_candidates_complete,
      payload: %{generation: 7},
      session_id: "rtc_gateway"
    }

    assert {:push, {:text, json}, _state} =
             Gateway.Socket.handle_info({:vox_rtc, session, complete}, state)

    assert Jason.decode!(json)["data"] == %{"candidate" => nil, "generation" => 7}
  end

  test "signaling errors reject the pending offer without becoming conversation errors", %{
    session: session,
    options: options
  } do
    {:push, _ready, state} = Gateway.Socket.init(options)

    {:ok, state} =
      Gateway.Socket.handle_in(
        {Jason.encode!(%{
           id: "offer-1",
           type: "rtc.offer",
           data: %{offer: %{type: "offer", sdp: "sdp"}, generation: 3}
         }), opcode: :text},
        state
      )

    event = %Event{
      type: :signaling_error,
      payload: %ErrorEvent{
        message: "stale generation",
        code: "command_invalid",
        recoverable: true,
        generation: 3
      },
      session_id: "rtc_gateway"
    }

    assert {:push, {:text, json}, _state} =
             Gateway.Socket.handle_info({:vox_rtc, session, event}, state)

    assert %{
             "id" => "offer-1",
             "type" => "rtc.signaling_error",
             "data" => %{"generation" => 3, "message" => "stale generation"}
           } = Jason.decode!(json)
  end

  test "browser disconnect closes the controlled session and runs the close hook once", %{
    options: options
  } do
    test = self()

    options =
      Map.put(options, :on_session_closed, fn context ->
        send(test, {:closed, context})
        :ok
      end)

    {:push, _ready, state} = Gateway.Socket.init(options)

    assert :ok = Gateway.Socket.terminate(:remote, state)
    assert_receive {:close, "browser_disconnected"}
    assert_receive {:closed, %{reason: "browser_disconnected"}}
    refute_receive {:closed, _context}
  end
end
