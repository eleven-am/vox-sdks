defmodule VoxRtcServer do
  @moduledoc """
  Elixir client for trusted server-side control of Vox WebRTC sessions over gRPC.

  Vox continues to own media, VAD, turn detection, interruption, STT, and TTS.
  This SDK carries only RTC signaling and server control over one ordered gRPC
  stream per session.
  """

  alias VoxRtcServer.Client

  @spec start_link(keyword()) :: GenServer.on_start()
  defdelegate start_link(options), to: Client

  @spec create_controlled_session(Client.t(), keyword()) ::
          {:ok, VoxRtcServer.Bootstrap.t(), VoxRtcServer.Session.t()} | {:error, term()}
  defdelegate create_controlled_session(client, options \\ []), to: Client

  @spec close(Client.t()) :: :ok
  defdelegate close(client), to: Client
end
