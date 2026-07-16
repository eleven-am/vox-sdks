defmodule VoxRtcServer.Client do
  @moduledoc "A persistent trusted-service connection to Vox's gRPC RTC API."

  use GenServer

  alias VoxRtcServer.{Protocol, Session}

  @type t :: pid()

  defstruct [:channel, :transport, :call_options, sessions: %{}]

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(options) do
    {name, options} = Keyword.pop(options, :name)
    gen_server_options = if name, do: [name: name], else: []
    GenServer.start_link(__MODULE__, options, gen_server_options)
  end

  @spec create_controlled_session(t(), keyword()) ::
          {:ok, VoxRtcServer.Bootstrap.t(), Session.t()} | {:error, term()}
  def create_controlled_session(client, options \\ []) do
    caller = self()
    timeout = Keyword.get(options, :timeout, :infinity)
    GenServer.call(client, {:create_controlled_session, options, caller}, timeout)
  end

  @spec close(t()) :: :ok
  def close(client) do
    try do
      GenServer.call(client, :close, 10_000)
    catch
      :exit, {:noproc, _details} -> :ok
      :exit, {:normal, _details} -> :ok
    end
  end

  @impl true
  def init(options) do
    target = Keyword.fetch!(options, :target)
    transport = Keyword.get(options, :transport, VoxRtcServer.Transport.GRPC)
    connect_options = Keyword.get(options, :connect_options, [])

    with {:ok, channel} <- transport.connect(target, connect_options) do
      {:ok,
       %__MODULE__{
         channel: channel,
         transport: transport,
         call_options: call_options(options)
       }}
    end
  end

  @impl true
  def handle_call({:create_controlled_session, options, caller}, _from, state) do
    request = %Vox.RtcCreateSessionRequest{
      browser_events: Keyword.get(options, :browser_events, false)
    }

    with {:ok, raw_bootstrap} <-
           state.transport.create_session(state.channel, request, state.call_options),
         bootstrap = Protocol.bootstrap(raw_bootstrap),
         {:ok, session} <- start_session(state, bootstrap, options, caller),
         :ok <- await_session(session, bootstrap, options) do
      monitor = Process.monitor(session)
      sessions = Map.put(state.sessions, monitor, session)
      {:reply, {:ok, bootstrap, session}, %{state | sessions: sessions}}
    else
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call(:close, _from, state) do
    Enum.each(state.sessions, fn {_monitor, session} ->
      Session.close(session, "client_closed")
    end)

    {:stop, :normal, :ok, %{state | sessions: %{}}}
  end

  @impl true
  def handle_info({:DOWN, monitor, :process, _pid, _reason}, state) do
    {:noreply, %{state | sessions: Map.delete(state.sessions, monitor)}}
  end

  def handle_info(_message, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, state) do
    Enum.each(state.sessions, fn {_monitor, session} ->
      Session.close(session, "client_closed")
    end)

    state.transport.disconnect(state.channel)
    :ok
  end

  defp start_session(state, bootstrap, options, caller) do
    child_options = [
      owner: self(),
      channel: state.channel,
      transport: state.transport,
      call_options: state.call_options,
      session_id: bootstrap.session_id,
      subscriber:
        if(Keyword.get(options, :subscribe, true),
          do: Keyword.get(options, :subscriber, caller)
        )
    ]

    DynamicSupervisor.start_child(
      VoxRtcServer.SessionSupervisor,
      {Session, child_options}
    )
  end

  defp await_session(session, bootstrap, options) do
    default_timeout = max(bootstrap.attach_ttl_seconds * 1_000, 5_000)
    timeout = Keyword.get(options, :attach_timeout, default_timeout)

    case Session.await_attached(session, timeout) do
      :ok ->
        :ok

      {:error, _reason} = error ->
        DynamicSupervisor.terminate_child(VoxRtcServer.SessionSupervisor, session)
        error
    end
  catch
    :exit, {:timeout, _details} ->
      DynamicSupervisor.terminate_child(VoxRtcServer.SessionSupervisor, session)
      {:error, :attach_timeout}

    :exit, reason ->
      DynamicSupervisor.terminate_child(VoxRtcServer.SessionSupervisor, session)
      {:error, {:attach_failed, reason}}
  end

  defp call_options(options) do
    base = Keyword.get(options, :call_options, [])

    case Keyword.get(options, :api_key) || System.get_env("VOX_API_KEY") do
      nil ->
        base

      "" ->
        base

      api_key ->
        metadata =
          Map.put(Keyword.get(base, :metadata, %{}), "authorization", "Bearer #{api_key}")

        Keyword.put(base, :metadata, metadata)
    end
  end
end
