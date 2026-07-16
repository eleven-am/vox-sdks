defmodule VoxRtcServer.Session do
  @moduledoc """
  Owns one Vox RTC gRPC control stream.

  The process serializes every outgoing control message and delivers incoming
  events to subscribers as `{:vox_rtc, session, event}` messages.
  """

  use GenServer

  alias VoxRtcServer.{
    Event,
    IceCandidate,
    Protocol,
    ResponseOptions,
    SessionConfig,
    SessionDescription
  }

  @type t :: pid()

  @spec child_spec(keyword()) :: Supervisor.child_spec()
  def child_spec(options) do
    %{
      id: {__MODULE__, Keyword.fetch!(options, :session_id)},
      start: {__MODULE__, :start_link, [options]},
      restart: :temporary
    }
  end

  defstruct [
    :session_id,
    :transport,
    :stream,
    :receiver,
    :owner_monitor,
    attached?: false,
    closing?: false,
    closed_emitted?: false,
    terminal_error: nil,
    attach_waiters: [],
    subscribers: %{},
    subscriber_monitors: %{}
  ]

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(options), do: GenServer.start_link(__MODULE__, options)

  @spec session_id(t()) :: String.t()
  def session_id(session), do: GenServer.call(session, :session_id)

  @spec await_attached(t(), timeout()) :: :ok | {:error, term()}
  def await_attached(session, timeout), do: GenServer.call(session, :await_attached, timeout)

  @spec subscribe(t(), pid()) :: :ok
  def subscribe(session, subscriber \\ self()),
    do: GenServer.call(session, {:subscribe, subscriber})

  @spec unsubscribe(t(), pid()) :: :ok
  def unsubscribe(session, subscriber \\ self()),
    do: GenServer.call(session, {:unsubscribe, subscriber})

  @spec configure(t(), SessionConfig.t()) :: :ok | {:error, term()}
  def configure(session, %SessionConfig{} = config),
    do: send_control(session, Protocol.configure(config))

  @spec send_offer(t(), SessionDescription.t(), boolean()) :: :ok | {:error, term()}
  def send_offer(session, %SessionDescription{} = offer, restart \\ false),
    do: send_control(session, Protocol.offer(offer, restart))

  @spec send_ice_candidate(t(), IceCandidate.t() | :complete) :: :ok | {:error, term()}
  def send_ice_candidate(session, candidate),
    do: send_control(session, Protocol.candidate(candidate))

  @spec start_response(t(), ResponseOptions.t()) :: :ok | {:error, term()}
  def start_response(session, options \\ %ResponseOptions{}),
    do: send_control(session, Protocol.response_start(options))

  @spec append_response_text(t(), String.t(), ResponseOptions.t()) :: :ok | {:error, term()}
  def append_response_text(session, delta, options \\ %ResponseOptions{}) when is_binary(delta),
    do: send_control(session, Protocol.response_delta(delta, options))

  @spec commit_response(t()) :: :ok | {:error, term()}
  def commit_response(session), do: send_control(session, Protocol.response_commit())

  @spec cancel_response(t()) :: :ok | {:error, term()}
  def cancel_response(session), do: send_control(session, Protocol.response_cancel())

  @spec replace_response_text(t(), String.t(), ResponseOptions.t()) :: :ok | {:error, term()}
  def replace_response_text(session, text, options \\ %ResponseOptions{}) when is_binary(text),
    do: send_control(session, Protocol.response_replace_text(text, options))

  @spec send_client_event(t(), String.t(), map()) :: :ok | {:error, term()}
  def send_client_event(session, event, payload \\ %{}) do
    with {:ok, message} <- Protocol.client_event(event, payload) do
      send_control(session, message)
    end
  end

  @spec close(t(), String.t()) :: :ok
  def close(session, reason \\ "client_closed") do
    try do
      GenServer.call(session, {:close, reason}, 5_000)
    catch
      :exit, {:noproc, _details} -> :ok
      :exit, {:normal, _details} -> :ok
    end
  end

  @impl true
  def init(options) do
    Process.flag(:trap_exit, true)

    session_id = Keyword.fetch!(options, :session_id)
    transport = Keyword.fetch!(options, :transport)
    owner = Keyword.fetch!(options, :owner)
    subscriber = Keyword.get(options, :subscriber)

    with {:ok, stream} <-
           transport.open_control(
             Keyword.fetch!(options, :channel),
             Keyword.get(options, :call_options, [])
           ),
         {:ok, stream} <- transport.send_request(stream, Protocol.attach(session_id)) do
      owner_monitor = Process.monitor(owner)

      state = %__MODULE__{
        session_id: session_id,
        transport: transport,
        stream: stream,
        owner_monitor: owner_monitor
      }

      state = if subscriber, do: add_subscriber(state, subscriber), else: state
      receiver = start_receiver(transport, stream, self())
      {:ok, %{state | receiver: receiver}}
    else
      {:error, reason} -> {:stop, {:control_open_failed, reason}}
    end
  end

  @impl true
  def handle_call(:session_id, _from, state), do: {:reply, state.session_id, state}

  def handle_call(:await_attached, _from, %{attached?: true} = state),
    do: {:reply, :ok, state}

  def handle_call(:await_attached, _from, %{terminal_error: reason} = state)
      when not is_nil(reason),
      do: {:reply, {:error, reason}, state}

  def handle_call(:await_attached, from, state),
    do: {:noreply, %{state | attach_waiters: [from | state.attach_waiters]}}

  def handle_call({:subscribe, subscriber}, _from, state),
    do: {:reply, :ok, add_subscriber(state, subscriber)}

  def handle_call({:unsubscribe, subscriber}, _from, state),
    do: {:reply, :ok, remove_subscriber(state, subscriber)}

  def handle_call({:send, _message}, _from, %{closing?: true} = state),
    do: {:reply, {:error, :session_closed}, state}

  def handle_call({:send, message}, _from, state) do
    case state.transport.send_request(state.stream, message) do
      {:ok, stream} -> {:reply, :ok, %{state | stream: stream}}
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:close, _reason}, _from, %{closing?: true} = state),
    do: {:reply, :ok, state}

  def handle_call({:close, reason}, _from, state) do
    {:stop, :normal, :ok, close_transport(state, reason)}
  end

  @impl true
  def handle_info({:vox_rtc_stream, receiver, {:ok, message}}, %{receiver: receiver} = state) do
    case Protocol.decode_event(message, state.session_id) do
      {:ok, %Event{type: :session_attached, payload: payload} = event} ->
        if payload.session_id == state.session_id do
          Enum.each(state.attach_waiters, &GenServer.reply(&1, :ok))
          state = %{state | attached?: true, attach_waiters: []}
          {:noreply, broadcast(state, event)}
        else
          stop_for_stream_error(state, {:session_id_mismatch, payload.session_id})
        end

      {:ok, %Event{type: :closed, payload: payload} = event} ->
        state = broadcast(%{state | closed_emitted?: true, closing?: true}, event)
        reply_attach_waiters(state, {:error, {:closed, payload.reason}})

        if state.attached? do
          {:stop, :normal, %{state | attach_waiters: []}}
        else
          {:noreply, %{state | attach_waiters: [], terminal_error: {:closed, payload.reason}}}
        end

      {:ok, event} ->
        {:noreply, broadcast(state, event)}

      {:error, reason} ->
        {:noreply, broadcast(state, error_event(state, reason))}
    end
  end

  def handle_info({:vox_rtc_stream, receiver, {:error, reason}}, %{receiver: receiver} = state),
    do: stop_for_stream_error(state, reason)

  def handle_info({:vox_rtc_stream_done, receiver}, %{receiver: receiver} = state) do
    reason = if state.closing?, do: "client_closed", else: "transport_closed"
    state = emit_closed_once(state, reason)
    reply_attach_waiters(state, {:error, :stream_closed})

    if state.attached? do
      {:stop, :normal, %{state | attach_waiters: []}}
    else
      {:noreply, %{state | attach_waiters: [], terminal_error: :stream_closed}}
    end
  end

  def handle_info(
        {:DOWN, reference, :process, _pid, _reason},
        %{owner_monitor: reference} = state
      ) do
    {:stop, :normal, close_transport(state, "owner_closed")}
  end

  def handle_info({:DOWN, reference, :process, _pid, _reason}, state) do
    case Map.pop(state.subscriber_monitors, reference) do
      {nil, _monitors} ->
        {:noreply, state}

      {subscriber, monitors} ->
        {:noreply,
         %{
           state
           | subscribers: Map.delete(state.subscribers, subscriber),
             subscriber_monitors: monitors
         }}
    end
  end

  def handle_info({:EXIT, receiver, :normal}, %{receiver: receiver} = state),
    do: {:noreply, state}

  def handle_info({:EXIT, receiver, reason}, %{receiver: receiver} = state) do
    stop_for_stream_error(state, {:receiver_exit, reason})
  end

  def handle_info(_message, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, state) do
    if state.receiver && Process.alive?(state.receiver),
      do: Process.exit(state.receiver, :shutdown)

    unless state.closing? do
      state.transport.cancel(state.stream)
    end

    :ok
  end

  defp send_control(session, message), do: GenServer.call(session, {:send, message})

  defp start_receiver(transport, stream, session) do
    {:ok, receiver} =
      Task.start_link(fn ->
        case transport.receive(stream) do
          {:ok, enumerable} ->
            Enum.each(enumerable, fn item -> send(session, {:vox_rtc_stream, self(), item}) end)

          {:error, reason} ->
            send(session, {:vox_rtc_stream, self(), {:error, reason}})
        end

        send(session, {:vox_rtc_stream_done, self()})
      end)

    receiver
  end

  defp end_stream(state) do
    case state.transport.end_stream(state.stream) do
      {:ok, stream} -> %{state | stream: stream}
      {:error, _reason} -> state
    end
  end

  defp close_transport(state, reason) do
    state = %{state | closing?: true}

    state =
      case state.transport.send_request(state.stream, Protocol.close(reason)) do
        {:ok, stream} -> %{state | stream: stream}
        {:error, _reason} -> state
      end

    state
    |> end_stream()
    |> emit_closed_once(reason)
  end

  defp stop_for_stream_error(state, reason) do
    state.transport.cancel(state.stream)
    state = broadcast(state, error_event(state, reason))
    state = emit_closed_once(%{state | closing?: true}, "transport_error")
    reply_attach_waiters(state, {:error, reason})

    if state.attached? do
      {:stop, :normal, %{state | attach_waiters: []}}
    else
      {:noreply, %{state | attach_waiters: [], terminal_error: reason}}
    end
  end

  defp error_event(state, reason) do
    %Event{type: :error, payload: %{reason: reason}, session_id: state.session_id}
  end

  defp emit_closed_once(%{closed_emitted?: true} = state, _reason), do: state

  defp emit_closed_once(state, reason) do
    event = %Event{type: :closed, payload: %{reason: reason}, session_id: state.session_id}
    broadcast(%{state | closed_emitted?: true}, event)
  end

  defp broadcast(state, event) do
    Enum.each(Map.keys(state.subscribers), &send(&1, {:vox_rtc, self(), event}))
    state
  end

  defp reply_attach_waiters(state, reply),
    do: Enum.each(state.attach_waiters, &GenServer.reply(&1, reply))

  defp add_subscriber(state, subscriber) when is_pid(subscriber) do
    if Map.has_key?(state.subscribers, subscriber) do
      state
    else
      monitor = Process.monitor(subscriber)

      %{
        state
        | subscribers: Map.put(state.subscribers, subscriber, monitor),
          subscriber_monitors: Map.put(state.subscriber_monitors, monitor, subscriber)
      }
    end
  end

  defp remove_subscriber(state, subscriber) do
    case Map.pop(state.subscribers, subscriber) do
      {nil, _subscribers} ->
        state

      {monitor, subscribers} ->
        Process.demonitor(monitor, [:flush])

        %{
          state
          | subscribers: subscribers,
            subscriber_monitors: Map.delete(state.subscriber_monitors, monitor)
        }
    end
  end
end
