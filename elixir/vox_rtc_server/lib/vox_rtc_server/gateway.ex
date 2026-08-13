defmodule VoxRtcServer.Gateway do
  @moduledoc """
  Plug/WebSock gateway for `@eleven-am/vox-rtc-client`.

  The Plug upgrades one browser WebSocket into one private controlled Vox
  session. The socket remains open for signaling and lifecycle events while
  WebRTC carries microphone and assistant audio directly between Vox and the
  browser.
  """

  @behaviour Plug

  @default_path "/api/vox/rtc"

  @impl true
  def init(options) do
    options
    |> Keyword.put_new(:path, @default_path)
    |> Keyword.update!(:path, &normalize_path/1)
    |> Keyword.put_new(:client_module, VoxRtcServer.Client)
    |> Keyword.put_new(:session_module, VoxRtcServer.Session)
    |> Keyword.put_new(:websocket_options, timeout: :infinity, max_frame_size: 1_048_576)
  end

  @impl true
  def call(%Plug.Conn{request_path: path} = conn, options) do
    if normalize_path(path) == Keyword.fetch!(options, :path) do
      state =
        options
        |> Keyword.put(:request, request_context(conn))
        |> Map.new()

      WebSockAdapter.upgrade(
        conn,
        VoxRtcServer.Gateway.Socket,
        state,
        Keyword.get(options, :websocket_options, [])
      )
    else
      conn
    end
  end

  defp request_context(conn) do
    %{
      method: conn.method,
      path: conn.request_path,
      query_string: conn.query_string,
      headers: conn.req_headers,
      remote_ip: conn.remote_ip
    }
  end

  defp normalize_path(path) do
    case path |> to_string() |> String.trim() |> String.trim("/") do
      "" -> "/"
      value -> "/" <> value
    end
  end
end

defmodule VoxRtcServer.Gateway.Socket do
  @moduledoc false

  @behaviour WebSock

  alias VoxRtcServer.{Event, IceCandidate, SessionDescription}

  @max_safe_integer 9_007_199_254_740_991

  @event_names %{
    session_attached: "rtc.session.attached",
    session_created: "session.created",
    speech_started: "input_audio_buffer.speech_started",
    speech_stopped: "input_audio_buffer.speech_stopped",
    transcript_delta: "conversation.item.input_audio_transcription.delta",
    transcript_completed: "conversation.item.input_audio_transcription.completed",
    response_created: "response.created",
    response_committed: "response.committed",
    response_audio: "response.audio.delta",
    response_audio_clear: "response.audio.clear",
    response_done: "response.done",
    response_cancelled: "response.cancelled",
    response_spoken_text: "response.spoken_text.resolved",
    turn_state_changed: "turn.state_changed",
    interruption_detected: "interruption.detected",
    interruption_false_positive: "interruption.false_positive",
    turn_eou_predicted: "turn.eou.predicted",
    browser_event: "browser.event",
    signaling_error: "rtc.signaling_error",
    error: "error",
    closed: "rtc.session.closed"
  }

  @impl true
  def init(options) do
    client_module = Map.fetch!(options, :client_module)
    session_module = Map.fetch!(options, :session_module)
    client = Map.fetch!(options, :client)

    case client_module.create_controlled_session(client, subscriber: self()) do
      {:ok, bootstrap, session} ->
        state = %{
          client_module: client_module,
          session_module: session_module,
          session: session,
          request: Map.get(options, :request, %{}),
          on_session_created: Map.get(options, :on_session_created),
          on_session_closed: Map.get(options, :on_session_closed),
          on_error: Map.get(options, :on_error),
          pending_offer_id: nil,
          generated_offer?: false,
          rtc_close_requested?: false,
          closed?: false,
          close_reason: nil
        }

        case call_hook(state.on_session_created, context(state)) do
          :ok ->
            {:push, text("gateway.ready", bootstrap_payload(bootstrap)), state}

          {:error, reason} ->
            report(state, reason)
            session_module.close(session, "session_created_hook_failed")
            {:stop, reason, {1011, "RTC gateway setup failed"}, %{state | closed?: true}}
        end

      {:error, reason} ->
        report(options, reason)
        {:stop, reason, {1011, "RTC gateway setup failed"}, Map.put(options, :closed?, true)}
    end
  end

  @impl true
  def handle_in({payload, opcode: :text}, state) do
    case parse_message(payload) do
      {:ok, message} -> handle_message(message, state)
      {:error, error} -> {:push, gateway_error(nil, error), state}
    end
  end

  def handle_in({_payload, _metadata}, state),
    do: {:push, gateway_error(nil, {"RTC gateway accepts text JSON only", nil}), state}

  @impl true
  def handle_info({:vox_rtc, session, %Event{} = event}, %{session: session} = state) do
    {event_type, data} = wire_event(event)

    {request_id, state} =
      if event_type in ["rtc.answer", "rtc.signaling_error"] do
        {state.pending_offer_id, %{state | pending_offer_id: nil}}
      else
        {nil, state}
      end

    frame = text(event_type, data, request_id)

    if event_type == "rtc.session.closed" do
      reason = Map.get(data, "reason", "session_closed") |> to_string()

      state = %{
        state
        | rtc_close_requested?: true,
          closed?: true,
          close_reason: reason
      }

      {:stop, :normal, {1000, reason}, frame, state}
    else
      {:push, frame, state}
    end
  end

  def handle_info(_message, state), do: {:ok, state}

  @impl true
  def terminate(_reason, state) when not is_map_key(state, :session), do: :ok

  def terminate(reason, state) do
    unless Map.get(state, :closed?, false) do
      close_reason = terminate_reason(reason)
      state.session_module.close(state.session, close_reason)
      call_closed_hook(state, close_reason)
    else
      call_closed_hook(state, state.close_reason || terminate_reason(reason))
    end

    :ok
  end

  defp handle_message(%{id: id, type: "rtc.offer", data: data}, state) do
    with nil <- state.pending_offer_id,
         {:ok, generation} <- generation(data, "rtc.offer", false),
         {:ok, offer} <- offer(Map.get(data, "offer")),
         :ok <-
           state.session_module.send_offer(
             state.session,
             offer,
             Map.get(data, "restart") == true,
             generation
           ) do
      {:ok,
       %{
         state
         | pending_offer_id: id,
           generated_offer?: not is_nil(generation)
       }}
    else
      pending when is_binary(pending) ->
        {:push, gateway_error(id, {"An RTC offer is already pending", nil}), state}

      {:error, error} ->
        {:push, gateway_error(id, normalize_error(error)), state}
    end
  end

  defp handle_message(%{id: id, type: "rtc.ice_candidate", data: data}, state) do
    with {:ok, generation} <-
           generation(data, "rtc.ice_candidate", state.generated_offer?),
         {:ok, candidate} <- candidate(Map.get(data, "candidate")),
         :ok <- state.session_module.send_ice_candidate(state.session, candidate, generation) do
      {:ok, state}
    else
      {:error, error} -> {:push, gateway_error(id, normalize_error(error)), state}
    end
  end

  defp handle_message(%{type: "rtc.close", data: data}, state) do
    reason =
      case Map.get(data, "reason") do
        value when is_binary(value) -> value
        _ -> "client_closed"
      end

    case state.session_module.close(state.session, reason) do
      :ok ->
        {:ok,
         %{
           state
           | rtc_close_requested?: true,
             closed?: true,
             close_reason: reason
         }}

      {:error, error} ->
        {:push, gateway_error(nil, normalize_error(error)), state}
    end
  end

  defp handle_message(%{id: id, type: type}, state),
    do: {:push, gateway_error(id, {"Unsupported RTC gateway message type: #{type}", nil}), state}

  defp parse_message(payload) do
    with {:ok, value} when is_map(value) <- Jason.decode(payload),
         id when is_binary(id) and id != "" <- value["id"],
         type when is_binary(type) and type != "" <- value["type"],
         data when is_map(data) <- value["data"] do
      {:ok, %{id: String.trim(id), type: String.trim(type), data: data}}
    else
      {:error, _error} -> {:error, {"RTC gateway message must be valid JSON", nil}}
      _ -> {:error, {"RTC gateway message requires id, type, and object data", nil}}
    end
  end

  defp generation(data, command, required?) do
    case Map.fetch(data, "generation") do
      :error when required? ->
        {:error,
         {"#{command} requires generation for a generated RTC negotiation", "command_invalid"}}

      :error ->
        {:ok, nil}

      {:ok, value}
      when is_integer(value) and value > 0 and value <= @max_safe_integer ->
        {:ok, value}

      {:ok, _value} ->
        {:error, {"#{command} generation must be a positive safe integer", "command_invalid"}}
    end
  end

  defp offer(%{"type" => "offer", "sdp" => sdp}) when is_binary(sdp) and sdp != "",
    do: {:ok, %SessionDescription{type: "offer", sdp: sdp}}

  defp offer(_value), do: {:error, {"rtc.offer requires a non-empty SDP offer", nil}}

  defp candidate(nil), do: {:ok, :complete}

  defp candidate(%{"candidate" => text} = value) when is_binary(text) do
    index = Map.get(value, "sdpMLineIndex")

    if is_nil(index) or (is_integer(index) and index >= 0) do
      {:ok,
       %IceCandidate{
         candidate: text,
         sdp_mid: string_or_nil(value["sdpMid"]),
         sdp_m_line_index: index,
         username_fragment: string_or_nil(value["usernameFragment"])
       }}
    else
      {:error, {"rtc.ice_candidate requires a candidate object or null", nil}}
    end
  end

  defp candidate(_value),
    do: {:error, {"rtc.ice_candidate requires a candidate object or null", nil}}

  defp wire_event(%Event{type: :answer, payload: payload}) do
    {"rtc.answer",
     compact(%{
       "answer" => %{"type" => payload.type, "sdp" => payload.sdp},
       "generation" => payload.generation
     })}
  end

  defp wire_event(%Event{type: :ice_candidate, payload: payload}) do
    {"rtc.ice_candidate",
     compact(%{
       "candidate" =>
         compact(%{
           "candidate" => payload.candidate,
           "sdpMid" => payload.sdp_mid,
           "sdpMLineIndex" => payload.sdp_m_line_index,
           "usernameFragment" => payload.username_fragment
         }),
       "generation" => payload.generation
     })}
  end

  defp wire_event(%Event{type: :ice_candidates_complete, payload: payload}) do
    data = %{"candidate" => nil}
    generation = Map.get(payload, :generation)
    data = if is_nil(generation), do: data, else: Map.put(data, "generation", generation)
    {"rtc.ice_candidate", data}
  end

  defp wire_event(%Event{type: :wire_event, payload: %{name: name, data: data}}),
    do: {name, normalize(data)}

  defp wire_event(%Event{type: :browser_event, payload: %{name: name, data: data}}),
    do: {"browser.event", %{"event" => name, "payload" => normalize(data)}}

  defp wire_event(%Event{type: type, payload: payload}) do
    {Map.fetch!(@event_names, type), normalize(payload)}
  end

  defp bootstrap_payload(bootstrap) do
    %{
      "session" => %{
        "sessionId" => bootstrap.session_id,
        "expiresAt" => bootstrap.expires_at,
        "attachTtlSeconds" => bootstrap.attach_ttl_seconds,
        "iceServers" =>
          Enum.map(bootstrap.ice_servers, fn server ->
            compact(%{
              "urls" => server.urls,
              "username" => server.username,
              "credential" => server.credential
            })
          end)
      }
    }
  end

  defp text(type, data, id \\ nil) do
    payload = compact(%{"id" => id, "type" => type, "data" => data})
    {:text, Jason.encode!(payload)}
  end

  defp gateway_error(id, {message, code}) do
    text("gateway.error", compact(%{"message" => message, "code" => code}), id)
  end

  defp normalize_error({message, code}) when is_binary(message), do: {message, code}
  defp normalize_error(error), do: {inspect(error), nil}

  defp normalize(%_{} = value), do: value |> Map.from_struct() |> normalize()

  defp normalize(value) when is_map(value) do
    value
    |> Enum.reject(fn {key, _value} -> key == :__unknown_fields__ end)
    |> Map.new(fn {key, child} -> {to_string(key), normalize(child)} end)
    |> compact()
  end

  defp normalize(value) when is_list(value), do: Enum.map(value, &normalize/1)
  defp normalize(value) when is_tuple(value), do: value |> Tuple.to_list() |> normalize()
  defp normalize(value), do: value

  defp compact(map), do: Map.reject(map, fn {_key, value} -> is_nil(value) end)
  defp string_or_nil(value) when is_binary(value), do: value
  defp string_or_nil(_value), do: nil

  defp context(state), do: %{request: state.request, session: state.session}

  defp call_closed_hook(state, reason) do
    case call_hook(
           state.on_session_closed,
           %{request: state.request, session: state.session, reason: reason}
         ) do
      :ok -> :ok
      {:error, error} -> report(state, error)
    end
  end

  defp call_hook(nil, _context), do: :ok

  defp call_hook(hook, context) when is_function(hook, 1) do
    case hook.(context) do
      :ok -> :ok
      nil -> :ok
      {:error, _reason} = error -> error
      other -> {:error, {:invalid_hook_result, other}}
    end
  rescue
    error -> {:error, error}
  end

  defp report(state, reason) do
    case Map.get(state, :on_error) do
      hook when is_function(hook, 1) ->
        try do
          hook.(reason)
        rescue
          _error -> :ok
        end

      _other ->
        :ok
    end
  end

  defp terminate_reason(:remote), do: "browser_disconnected"
  defp terminate_reason(:normal), do: "client_closed"
  defp terminate_reason(:shutdown), do: "gateway_shutdown"
  defp terminate_reason(:timeout), do: "browser_timeout"
  defp terminate_reason(reason), do: "gateway_error:#{inspect(reason)}"
end
