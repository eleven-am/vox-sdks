defmodule VoxRtcServer.Transport do
  @moduledoc false

  @type channel :: term()
  @type stream :: term()
  @type call_options :: keyword()

  @callback connect(String.t(), keyword()) :: {:ok, channel()} | {:error, term()}
  @callback disconnect(channel()) :: term()
  @callback create_session(channel(), Vox.RtcCreateSessionRequest.t(), call_options()) ::
              {:ok, Vox.RtcSessionBootstrap.t()} | {:error, term()}
  @callback open_control(channel(), call_options()) :: {:ok, stream()} | {:error, term()}
  @callback send_request(stream(), Vox.RtcControlClientMessage.t()) ::
              {:ok, stream()} | {:error, term()}
  @callback receive(stream()) :: {:ok, Enumerable.t()} | {:error, term()}
  @callback end_stream(stream()) :: {:ok, stream()} | {:error, term()}
  @callback cancel(stream()) :: term()
end

defmodule VoxRtcServer.Transport.GRPC do
  @moduledoc false

  @behaviour VoxRtcServer.Transport

  @impl true
  def connect(target, options) do
    GRPC.Stub.connect(
      target,
      Keyword.put_new(options, :adapter, GRPC.Client.Adapters.Mint)
    )
  end

  @impl true
  def disconnect(channel), do: GRPC.Stub.disconnect(channel)

  @impl true
  def create_session(channel, request, options) do
    Vox.RtcService.Stub.create_session(channel, request, options)
  end

  @impl true
  def open_control(channel, options) do
    case Vox.RtcService.Stub.control(channel, options) do
      %GRPC.Client.Stream{} = stream -> {:ok, stream}
      {:error, _reason} = error -> error
      other -> {:error, {:unexpected_control_result, other}}
    end
  end

  @impl true
  def send_request(stream, message) do
    case GRPC.Stub.send_request(stream, message) do
      %GRPC.Client.Stream{} = next_stream -> {:ok, next_stream}
      {:error, _reason} = error -> error
      other -> {:error, {:unexpected_send_result, other}}
    end
  end

  @impl true
  def receive(stream) do
    case GRPC.Stub.recv(stream, timeout: :infinity) do
      {:ok, enumerable, _metadata} -> {:ok, enumerable}
      result -> result
    end
  end

  @impl true
  def end_stream(stream) do
    case GRPC.Stub.end_stream(stream) do
      %GRPC.Client.Stream{} = next_stream -> {:ok, next_stream}
      {:error, _reason} = error -> error
      other -> {:error, {:unexpected_end_stream_result, other}}
    end
  end

  @impl true
  def cancel(stream), do: GRPC.Stub.cancel(stream)
end
