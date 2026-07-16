defmodule VoxRtcServer.TestTransport do
  @moduledoc false

  @behaviour VoxRtcServer.Transport

  @impl true
  def connect(target, options) do
    test = Keyword.fetch!(options, :test)
    send(test, {:transport_connected, target, options})
    {:ok, %{test: test}}
  end

  @impl true
  def disconnect(%{test: test} = channel) do
    send(test, {:transport_disconnected, channel})
    :ok
  end

  @impl true
  def create_session(%{test: test}, request, options) do
    reference = make_ref()
    send(test, {:create_session, self(), reference, request, options})

    receive do
      {:create_session_reply, ^reference, reply} -> reply
    after
      1_000 -> {:error, :fake_create_timeout}
    end
  end

  @impl true
  def open_control(%{test: test}, options) do
    stream = %{test: test, reference: make_ref()}
    send(test, {:control_opened, stream, options})
    {:ok, stream}
  end

  @impl true
  def send_request(stream, message) do
    send(stream.test, {:control_sent, stream, message})
    {:ok, stream}
  end

  @impl true
  def receive(stream) do
    receiver = self()
    send(stream.test, {:receiver_ready, stream, receiver})

    enumerable =
      Stream.resource(
        fn -> :open end,
        fn
          :closed ->
            {:halt, :closed}

          :open ->
            receive do
              {:server_item, reference, item} when reference == stream.reference ->
                {[item], :open}

              {:server_done, reference} when reference == stream.reference ->
                {:halt, :closed}
            end
        end,
        fn _state -> :ok end
      )

    {:ok, enumerable}
  end

  @impl true
  def end_stream(stream) do
    send(stream.test, {:stream_ended, stream})
    {:ok, stream}
  end

  @impl true
  def cancel(stream) do
    send(stream.test, {:stream_cancelled, stream})
    :ok
  end
end
