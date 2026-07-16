defmodule VoxRtcServer.Application do
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    DynamicSupervisor.start_link(
      name: VoxRtcServer.SessionSupervisor,
      strategy: :one_for_one
    )
  end
end
