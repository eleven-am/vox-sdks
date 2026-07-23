defmodule VoxRtcServer.MixProject do
  use Mix.Project

  @version "0.2.3"
  @source_url "https://github.com/eleven-am/vox-sdks"

  def project do
    [
      app: :vox_rtc_server,
      version: @version,
      elixir: "~> 1.16",
      start_permanent: Mix.env() == :prod,
      elixirc_paths: elixirc_paths(Mix.env()),
      deps: deps(),
      description: "Elixir gRPC SDK for Vox-hosted WebRTC conversations",
      package: package(),
      source_url: @source_url,
      docs: [main: "readme", extras: ["README.md"]]
    ]
  end

  def application do
    [
      extra_applications: [:logger],
      mod: {VoxRtcServer.Application, []}
    ]
  end

  defp deps do
    [
      {:grpc, "~> 1.0"},
      {:castore, "~> 1.0"},
      {:jason, "~> 1.4"},
      {:mint, "~> 1.9"},
      {:protobuf, "~> 0.17"},
      {:ex_doc, "~> 0.38", only: :dev, runtime: false}
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_env), do: ["lib"]

  defp package do
    [
      licenses: ["GPL-3.0-or-later"],
      links: %{"GitHub" => @source_url},
      files: ["lib", "priv/proto/vox.proto", "mix.exs", "README.md"]
    ]
  end
end
