defmodule Vox.HealthRequest do
  @moduledoc false

  use Protobuf,
    full_name: "vox.HealthRequest",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3
end

defmodule Vox.HealthResponse do
  @moduledoc false

  use Protobuf,
    full_name: "vox.HealthResponse",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:status, 1, type: :string)
end

defmodule Vox.ListLoadedRequest do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ListLoadedRequest",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3
end

defmodule Vox.ListLoadedResponse do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ListLoadedResponse",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:models, 1, repeated: true, type: Vox.LoadedModel)
end

defmodule Vox.LoadedModel do
  @moduledoc false

  use Protobuf, full_name: "vox.LoadedModel", protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field(:name, 1, type: :string)
  field(:tag, 2, type: :string)
  field(:type, 3, type: :string)
  field(:device, 4, type: :string)
  field(:vram_bytes, 5, type: :int64, json_name: "vramBytes")
  field(:loaded_at, 6, type: :double, json_name: "loadedAt")
  field(:last_used, 7, type: :double, json_name: "lastUsed")
  field(:ref_count, 8, type: :int32, json_name: "refCount")
end

defmodule Vox.PullRequest do
  @moduledoc false

  use Protobuf, full_name: "vox.PullRequest", protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field(:name, 1, type: :string)
  field(:variant, 2, type: :string)
end

defmodule Vox.PullProgress do
  @moduledoc false

  use Protobuf,
    full_name: "vox.PullProgress",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:status, 1, type: :string)
  field(:error, 2, type: :string)
  field(:completed, 3, type: :int32)
  field(:total, 4, type: :int32)
end

defmodule Vox.ListModelsRequest do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ListModelsRequest",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3
end

defmodule Vox.ListModelsResponse do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ListModelsResponse",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:models, 1, repeated: true, type: Vox.ModelInfo)
end

defmodule Vox.ModelInfo do
  @moduledoc false

  use Protobuf, full_name: "vox.ModelInfo", protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field(:name, 1, type: :string)
  field(:type, 2, type: :string)
  field(:format, 3, type: :string)
  field(:architecture, 4, type: :string)
  field(:size_bytes, 5, type: :int64, json_name: "sizeBytes")
  field(:description, 6, type: :string)
end

defmodule Vox.ShowRequest do
  @moduledoc false

  use Protobuf, full_name: "vox.ShowRequest", protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field(:name, 1, type: :string)
end

defmodule Vox.ShowResponse.ConfigEntry do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ShowResponse.ConfigEntry",
    map: true,
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:key, 1, type: :string)
  field(:value, 2, type: :string)
end

defmodule Vox.ShowResponse do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ShowResponse",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:name, 1, type: :string)
  field(:config, 2, repeated: true, type: Vox.ShowResponse.ConfigEntry, map: true)
  field(:layers, 3, repeated: true, type: Vox.LayerInfo)
end

defmodule Vox.LayerInfo do
  @moduledoc false

  use Protobuf, full_name: "vox.LayerInfo", protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field(:media_type, 1, type: :string, json_name: "mediaType")
  field(:digest, 2, type: :string)
  field(:size, 3, type: :int64)
  field(:filename, 4, type: :string)
end

defmodule Vox.DeleteRequest do
  @moduledoc false

  use Protobuf,
    full_name: "vox.DeleteRequest",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:name, 1, type: :string)
end

defmodule Vox.DeleteResponse do
  @moduledoc false

  use Protobuf,
    full_name: "vox.DeleteResponse",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:status, 1, type: :string)
end

defmodule Vox.TranscribeRequest do
  @moduledoc false

  use Protobuf,
    full_name: "vox.TranscribeRequest",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:audio, 1, type: :bytes)
  field(:model, 2, type: :string)
  field(:language, 3, type: :string)
  field(:word_timestamps, 4, type: :bool, json_name: "wordTimestamps")
  field(:temperature, 5, type: :float)
  field(:response_format, 6, type: :string, json_name: "responseFormat")
  field(:format_hint, 7, type: :string, json_name: "formatHint")
end

defmodule Vox.TranscribeResponse do
  @moduledoc false

  use Protobuf,
    full_name: "vox.TranscribeResponse",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:model, 1, type: :string)
  field(:text, 2, type: :string)
  field(:language, 3, type: :string)
  field(:duration_ms, 4, type: :int32, json_name: "durationMs")
  field(:processing_ms, 5, type: :int32, json_name: "processingMs")
  field(:segments, 6, repeated: true, type: Vox.TranscriptSegment)
  field(:entities, 7, repeated: true, type: Vox.Entity)
  field(:topics, 8, repeated: true, type: :string)
end

defmodule Vox.Entity do
  @moduledoc false

  use Protobuf, full_name: "vox.Entity", protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field(:type, 1, type: :string)
  field(:text, 2, type: :string)
  field(:start_char, 3, type: :uint32, json_name: "startChar")
  field(:end_char, 4, type: :uint32, json_name: "endChar")
end

defmodule Vox.AnnotateRequest do
  @moduledoc false

  use Protobuf,
    full_name: "vox.AnnotateRequest",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:text, 1, type: :string)
  field(:language, 2, type: :string)
end

defmodule Vox.AnnotateResponse do
  @moduledoc false

  use Protobuf,
    full_name: "vox.AnnotateResponse",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:entities, 1, repeated: true, type: Vox.Entity)
  field(:topics, 2, repeated: true, type: :string)
end

defmodule Vox.TranscriptSegment do
  @moduledoc false

  use Protobuf,
    full_name: "vox.TranscriptSegment",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:text, 1, type: :string)
  field(:start_ms, 2, type: :int32, json_name: "startMs")
  field(:end_ms, 3, type: :int32, json_name: "endMs")
  field(:words, 4, repeated: true, type: Vox.WordTimestamp)
end

defmodule Vox.WordTimestamp do
  @moduledoc false

  use Protobuf,
    full_name: "vox.WordTimestamp",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:word, 1, type: :string)
  field(:start_ms, 2, type: :int32, json_name: "startMs")
  field(:end_ms, 3, type: :int32, json_name: "endMs")
  field(:confidence, 4, proto3_optional: true, type: :float)
end

defmodule Vox.SynthesizeRequest do
  @moduledoc false

  use Protobuf,
    full_name: "vox.SynthesizeRequest",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:model, 1, type: :string)
  field(:input, 2, type: :string)
  field(:voice, 3, type: :string)
  field(:speed, 4, type: :float)
  field(:language, 5, type: :string)
  field(:response_format, 6, type: :string, json_name: "responseFormat")
  field(:params, 7, type: Google.Protobuf.Struct)
end

defmodule Vox.AudioChunk do
  @moduledoc false

  use Protobuf, full_name: "vox.AudioChunk", protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field(:audio, 1, type: :bytes)
  field(:sample_rate, 2, type: :int32, json_name: "sampleRate")
  field(:is_final, 3, type: :bool, json_name: "isFinal")
end

defmodule Vox.StreamInput do
  @moduledoc false

  use Protobuf, full_name: "vox.StreamInput", protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  oneof(:msg, 0)

  field(:config, 1, type: Vox.StreamConfig, oneof: 0)
  field(:audio, 2, type: Vox.AudioFrame, oneof: 0)
  field(:opus_frame, 3, type: Vox.OpusFrame, json_name: "opusFrame", oneof: 0)
  field(:encoded_audio, 4, type: Vox.EncodedAudioFrame, json_name: "encodedAudio", oneof: 0)
  field(:end_of_stream, 5, type: Vox.EndOfStream, json_name: "endOfStream", oneof: 0)
end

defmodule Vox.EndOfStream do
  @moduledoc false

  use Protobuf, full_name: "vox.EndOfStream", protoc_gen_elixir_version: "0.17.0", syntax: :proto3
end

defmodule Vox.StreamConfig do
  @moduledoc false

  use Protobuf,
    full_name: "vox.StreamConfig",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:language, 1, type: :string)
  field(:sample_rate, 2, type: :uint32, json_name: "sampleRate")
  field(:model, 3, type: :string)
  field(:partials, 4, type: :bool)
  field(:partial_window_ms, 5, type: :uint32, json_name: "partialWindowMs")
  field(:partial_stride_ms, 6, type: :uint32, json_name: "partialStrideMs")
  field(:include_word_timestamps, 7, type: :bool, json_name: "includeWordTimestamps")
  field(:temperature, 8, type: :float)
end

defmodule Vox.AudioFrame do
  @moduledoc false

  use Protobuf, full_name: "vox.AudioFrame", protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field(:pcm16, 1, type: :bytes)
  field(:sample_rate, 2, type: :uint32, json_name: "sampleRate")
end

defmodule Vox.OpusFrame do
  @moduledoc false

  use Protobuf, full_name: "vox.OpusFrame", protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field(:data, 1, type: :bytes)
  field(:sample_rate, 2, type: :uint32, json_name: "sampleRate")
  field(:channels, 3, type: :uint32)
end

defmodule Vox.EncodedAudioFrame do
  @moduledoc false

  use Protobuf,
    full_name: "vox.EncodedAudioFrame",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:data, 1, type: :bytes)
  field(:format, 2, type: :string)
end

defmodule Vox.StreamOutput do
  @moduledoc false

  use Protobuf,
    full_name: "vox.StreamOutput",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  oneof(:msg, 0)

  field(:ready, 1, type: Vox.StreamReady, oneof: 0)
  field(:speech_started, 2, type: Vox.StreamSpeechStarted, json_name: "speechStarted", oneof: 0)
  field(:speech_stopped, 3, type: Vox.StreamSpeechStopped, json_name: "speechStopped", oneof: 0)
  field(:transcript, 4, type: Vox.StreamTranscriptResult, oneof: 0)
  field(:error, 5, type: Vox.StreamErrorMessage, oneof: 0)
end

defmodule Vox.StreamReady do
  @moduledoc false

  use Protobuf, full_name: "vox.StreamReady", protoc_gen_elixir_version: "0.17.0", syntax: :proto3
end

defmodule Vox.StreamSpeechStarted do
  @moduledoc false

  use Protobuf,
    full_name: "vox.StreamSpeechStarted",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:timestamp_ms, 1, type: :uint32, json_name: "timestampMs")
end

defmodule Vox.StreamSpeechStopped do
  @moduledoc false

  use Protobuf,
    full_name: "vox.StreamSpeechStopped",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:timestamp_ms, 1, type: :uint32, json_name: "timestampMs")
end

defmodule Vox.StreamTranscriptResult do
  @moduledoc false

  use Protobuf,
    full_name: "vox.StreamTranscriptResult",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:text, 1, type: :string)
  field(:is_partial, 2, type: :bool, json_name: "isPartial")
  field(:start_ms, 3, type: :uint32, json_name: "startMs")
  field(:end_ms, 4, type: :uint32, json_name: "endMs")
  field(:audio_duration_ms, 5, type: :uint32, json_name: "audioDurationMs")
  field(:processing_duration_ms, 6, type: :uint32, json_name: "processingDurationMs")
  field(:model, 7, type: :string)
  field(:eou_probability, 8, proto3_optional: true, type: :float, json_name: "eouProbability")
  field(:entities, 9, repeated: true, type: Vox.Entity)
  field(:topics, 10, repeated: true, type: :string)
  field(:words, 11, repeated: true, type: Vox.WordTimestamp)
  field(:segments, 12, repeated: true, type: Vox.TranscriptSegment)
end

defmodule Vox.StreamErrorMessage do
  @moduledoc false

  use Protobuf,
    full_name: "vox.StreamErrorMessage",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:message, 1, type: :string)
end

defmodule Vox.ListVoicesRequest do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ListVoicesRequest",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:model, 1, type: :string)
end

defmodule Vox.ListVoicesResponse do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ListVoicesResponse",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:voices, 1, repeated: true, type: Vox.VoiceInfo)
end

defmodule Vox.CreateVoiceRequest do
  @moduledoc false

  use Protobuf,
    full_name: "vox.CreateVoiceRequest",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:name, 1, type: :string)
  field(:audio, 2, type: :bytes)
  field(:language, 3, type: :string)
  field(:gender, 4, type: :string)
  field(:reference_text, 5, type: :string, json_name: "referenceText")
  field(:format_hint, 6, type: :string, json_name: "formatHint")
end

defmodule Vox.CreateVoiceResponse do
  @moduledoc false

  use Protobuf,
    full_name: "vox.CreateVoiceResponse",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:voice, 1, type: Vox.VoiceInfo)
  field(:created_at, 2, type: :int64, json_name: "createdAt")
end

defmodule Vox.DeleteVoiceRequest do
  @moduledoc false

  use Protobuf,
    full_name: "vox.DeleteVoiceRequest",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:id, 1, type: :string)
end

defmodule Vox.DeleteVoiceResponse do
  @moduledoc false

  use Protobuf,
    full_name: "vox.DeleteVoiceResponse",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:id, 1, type: :string)
  field(:deleted, 2, type: :bool)
end

defmodule Vox.VoiceInfo do
  @moduledoc false

  use Protobuf, full_name: "vox.VoiceInfo", protoc_gen_elixir_version: "0.17.0", syntax: :proto3

  field(:id, 1, type: :string)
  field(:name, 2, type: :string)
  field(:language, 3, type: :string)
  field(:gender, 4, type: :string)
  field(:description, 5, type: :string)
  field(:is_cloned, 6, type: :bool, json_name: "isCloned")
  field(:model, 7, type: :string)
end

defmodule Vox.RtcCreateSessionRequest do
  @moduledoc false

  use Protobuf,
    full_name: "vox.RtcCreateSessionRequest",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:browser_events, 1, proto3_optional: true, type: :bool, json_name: "browserEvents")
end

defmodule Vox.RtcIceServer do
  @moduledoc false

  use Protobuf,
    full_name: "vox.RtcIceServer",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:urls, 1, repeated: true, type: :string)
  field(:username, 2, type: :string)
  field(:credential, 3, type: :string)
end

defmodule Vox.RtcSessionBootstrap do
  @moduledoc false

  use Protobuf,
    full_name: "vox.RtcSessionBootstrap",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:session_id, 1, type: :string, json_name: "sessionId")
  field(:expires_at, 3, type: :string, json_name: "expiresAt")
  field(:ice_servers, 5, repeated: true, type: Vox.RtcIceServer, json_name: "iceServers")
  field(:attach_ttl_seconds, 6, type: :uint32, json_name: "attachTtlSeconds")
end

defmodule Vox.RtcSessionDescription do
  @moduledoc false

  use Protobuf,
    full_name: "vox.RtcSessionDescription",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:type, 1, type: :string)
  field(:sdp, 2, type: :string)
end

defmodule Vox.RtcControlAnswer do
  @moduledoc false

  use Protobuf,
    full_name: "vox.RtcControlAnswer",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:session_id, 1, type: :string, json_name: "sessionId")
  field(:answer, 2, type: Vox.RtcSessionDescription)
end

defmodule Vox.RtcIceCandidate do
  @moduledoc false

  use Protobuf,
    full_name: "vox.RtcIceCandidate",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:candidate, 1, type: :string)
  field(:sdp_mid, 2, proto3_optional: true, type: :string, json_name: "sdpMid")
  field(:sdp_m_line_index, 3, proto3_optional: true, type: :uint32, json_name: "sdpMLineIndex")

  field(:username_fragment, 4,
    proto3_optional: true,
    type: :string,
    json_name: "usernameFragment"
  )
end

defmodule Vox.RtcIceCandidatesComplete do
  @moduledoc false

  use Protobuf,
    full_name: "vox.RtcIceCandidatesComplete",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3
end

defmodule Vox.RtcControlOffer do
  @moduledoc false

  use Protobuf,
    full_name: "vox.RtcControlOffer",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:offer, 1, type: Vox.RtcSessionDescription)
  field(:restart, 2, type: :bool)
end

defmodule Vox.RtcControlClose do
  @moduledoc false

  use Protobuf,
    full_name: "vox.RtcControlClose",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:reason, 1, type: :string)
end

defmodule Vox.RtcControlClosed do
  @moduledoc false

  use Protobuf,
    full_name: "vox.RtcControlClosed",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:session_id, 1, type: :string, json_name: "sessionId")
  field(:reason, 2, type: :string)
end

defmodule Vox.RtcSignalingError do
  @moduledoc false

  use Protobuf,
    full_name: "vox.RtcSignalingError",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:message, 1, type: :string)
end

defmodule Vox.RtcWireEvent do
  @moduledoc false

  use Protobuf,
    full_name: "vox.RtcWireEvent",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:type, 1, type: :string)
  field(:payload_json, 2, type: :string, json_name: "payloadJson")
end

defmodule Vox.ConverseClientMessage do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ConverseClientMessage",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  oneof(:msg, 0)

  field(:session_update, 1,
    type: Vox.ConversationSessionUpdate,
    json_name: "sessionUpdate",
    oneof: 0
  )

  field(:audio_append, 2, type: Vox.ConversationAudioAppend, json_name: "audioAppend", oneof: 0)

  field(:response_cancel, 4,
    type: Vox.ConversationResponseCancel,
    json_name: "responseCancel",
    oneof: 0
  )

  field(:response_start, 5,
    type: Vox.ConversationResponseStart,
    json_name: "responseStart",
    oneof: 0
  )

  field(:response_delta, 6,
    type: Vox.ConversationResponseDelta,
    json_name: "responseDelta",
    oneof: 0
  )

  field(:response_commit, 7,
    type: Vox.ConversationResponseCommit,
    json_name: "responseCommit",
    oneof: 0
  )

  field(:response_replace_text, 8,
    type: Vox.ConversationResponseReplaceText,
    json_name: "responseReplaceText",
    oneof: 0
  )
end

defmodule Vox.RtcControlClientMessage do
  @moduledoc false

  use Protobuf,
    full_name: "vox.RtcControlClientMessage",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  oneof(:msg, 0)

  field(:attach, 1, type: Vox.RtcControlAttach, oneof: 0)

  field(:session_update, 2,
    type: Vox.ConversationSessionUpdate,
    json_name: "sessionUpdate",
    oneof: 0
  )

  field(:response_cancel, 4,
    type: Vox.ConversationResponseCancel,
    json_name: "responseCancel",
    oneof: 0
  )

  field(:response_start, 5,
    type: Vox.ConversationResponseStart,
    json_name: "responseStart",
    oneof: 0
  )

  field(:response_delta, 6,
    type: Vox.ConversationResponseDelta,
    json_name: "responseDelta",
    oneof: 0
  )

  field(:response_commit, 7,
    type: Vox.ConversationResponseCommit,
    json_name: "responseCommit",
    oneof: 0
  )

  field(:client_event, 8, type: Vox.RtcClientEvent, json_name: "clientEvent", oneof: 0)

  field(:response_replace_text, 9,
    type: Vox.ConversationResponseReplaceText,
    json_name: "responseReplaceText",
    oneof: 0
  )

  field(:offer, 10, type: Vox.RtcControlOffer, oneof: 0)
  field(:candidate, 11, type: Vox.RtcIceCandidate, oneof: 0)

  field(:candidates_complete, 12,
    type: Vox.RtcIceCandidatesComplete,
    json_name: "candidatesComplete",
    oneof: 0
  )

  field(:close, 13, type: Vox.RtcControlClose, oneof: 0)
end

defmodule Vox.RtcControlServerMessage do
  @moduledoc false

  use Protobuf,
    full_name: "vox.RtcControlServerMessage",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  oneof(:msg, 0)

  field(:attached, 1, type: Vox.RtcSessionAttached, oneof: 0)
  field(:answer, 2, type: Vox.RtcControlAnswer, oneof: 0)
  field(:candidate, 3, type: Vox.RtcIceCandidate, oneof: 0)

  field(:candidates_complete, 4,
    type: Vox.RtcIceCandidatesComplete,
    json_name: "candidatesComplete",
    oneof: 0
  )

  field(:conversation, 5, type: Vox.ConverseServerMessage, oneof: 0)
  field(:error, 6, type: Vox.RtcSignalingError, oneof: 0)
  field(:closed, 7, type: Vox.RtcControlClosed, oneof: 0)
  field(:browser_event, 8, type: Vox.RtcClientEvent, json_name: "browserEvent", oneof: 0)
  field(:event, 9, type: Vox.RtcWireEvent, oneof: 0)
end

defmodule Vox.RtcControlAttach do
  @moduledoc false

  use Protobuf,
    full_name: "vox.RtcControlAttach",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:session_id, 1, type: :string, json_name: "sessionId")
end

defmodule Vox.ConverseServerMessage do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ConverseServerMessage",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  oneof(:msg, 0)

  field(:session_created, 1,
    type: Vox.ConversationSessionCreated,
    json_name: "sessionCreated",
    oneof: 0
  )

  field(:speech_started, 2,
    type: Vox.ConversationSpeechStarted,
    json_name: "speechStarted",
    oneof: 0
  )

  field(:speech_stopped, 3,
    type: Vox.ConversationSpeechStopped,
    json_name: "speechStopped",
    oneof: 0
  )

  field(:transcript_done, 4,
    type: Vox.ConversationTranscriptDone,
    json_name: "transcriptDone",
    oneof: 0
  )

  field(:response_created, 5,
    type: Vox.ConversationResponseCreated,
    json_name: "responseCreated",
    oneof: 0
  )

  field(:audio_delta, 6, type: Vox.ConversationAudioDelta, json_name: "audioDelta", oneof: 0)

  field(:response_done, 7,
    type: Vox.ConversationResponseDone,
    json_name: "responseDone",
    oneof: 0
  )

  field(:response_cancelled, 8,
    type: Vox.ConversationResponseCancelled,
    json_name: "responseCancelled",
    oneof: 0
  )

  field(:state_changed, 9,
    type: Vox.ConversationStateChanged,
    json_name: "stateChanged",
    oneof: 0
  )

  field(:error, 10, type: Vox.ConversationError, oneof: 0)

  field(:response_committed, 11,
    type: Vox.ConversationResponseCommitted,
    json_name: "responseCommitted",
    oneof: 0
  )

  field(:audio_clear, 12, type: Vox.ConversationAudioClear, json_name: "audioClear", oneof: 0)

  field(:interruption_detected, 13,
    type: Vox.ConversationInterruptionDetected,
    json_name: "interruptionDetected",
    oneof: 0
  )

  field(:interruption_false_positive, 14,
    type: Vox.ConversationInterruptionFalsePositive,
    json_name: "interruptionFalsePositive",
    oneof: 0
  )

  field(:turn_eou_predicted, 15,
    type: Vox.ConversationTurnEouPredicted,
    json_name: "turnEouPredicted",
    oneof: 0
  )

  field(:transcript_delta, 18,
    type: Vox.ConversationTranscriptDelta,
    json_name: "transcriptDelta",
    oneof: 0
  )
end

defmodule Vox.RtcSessionAttached do
  @moduledoc false

  use Protobuf,
    full_name: "vox.RtcSessionAttached",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:session_id, 1, type: :string, json_name: "sessionId")
  field(:provider, 2, type: :string)
end

defmodule Vox.RtcClientEvent do
  @moduledoc false

  use Protobuf,
    full_name: "vox.RtcClientEvent",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:event, 1, type: :string)
  field(:payload_json, 2, type: :string, json_name: "payloadJson")
end

defmodule Vox.ConversationResponseCommitted do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ConversationResponseCommitted",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:response_id, 1, type: :string, json_name: "responseId")
end

defmodule Vox.ConversationTurnPolicy do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ConversationTurnPolicy",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:allow_interrupt_while_speaking, 1,
    proto3_optional: true,
    type: :bool,
    json_name: "allowInterruptWhileSpeaking"
  )

  field(:min_interrupt_duration_ms, 2,
    proto3_optional: true,
    type: :uint32,
    json_name: "minInterruptDurationMs"
  )

  field(:max_endpointing_delay_ms, 3,
    proto3_optional: true,
    type: :uint32,
    json_name: "maxEndpointingDelayMs"
  )

  field(:stable_speaking_min_ms, 4,
    proto3_optional: true,
    type: :uint32,
    json_name: "stableSpeakingMinMs"
  )

  field(:false_interruption_timeout_ms, 5,
    proto3_optional: true,
    type: :uint32,
    json_name: "falseInterruptionTimeoutMs"
  )

  field(:min_interrupt_words, 6,
    proto3_optional: true,
    type: :uint32,
    json_name: "minInterruptWords"
  )

  field(:partial_interrupts, 7,
    proto3_optional: true,
    type: :bool,
    json_name: "partialInterrupts"
  )

  field(:dynamic_endpointing, 8,
    proto3_optional: true,
    type: :bool,
    json_name: "dynamicEndpointing"
  )

  field(:min_endpointing_delay_ms, 9,
    proto3_optional: true,
    type: :uint32,
    json_name: "minEndpointingDelayMs"
  )

  field(:speaking_interrupt_min_duration_ms, 10,
    proto3_optional: true,
    type: :uint32,
    json_name: "speakingInterruptMinDurationMs"
  )

  field(:speaking_interrupt_min_words, 11,
    proto3_optional: true,
    type: :uint32,
    json_name: "speakingInterruptMinWords"
  )

  field(:self_echo_min_words, 12,
    proto3_optional: true,
    type: :uint32,
    json_name: "selfEchoMinWords"
  )

  field(:self_echo_min_overlap, 13,
    proto3_optional: true,
    type: :float,
    json_name: "selfEchoMinOverlap"
  )

  field(:aec_warmup_ms, 14, proto3_optional: true, type: :uint32, json_name: "aecWarmupMs")

  field(:backchannel_end_cooldown_ms, 15,
    proto3_optional: true,
    type: :uint32,
    json_name: "backchannelEndCooldownMs"
  )

  field(:vad_min_silence_ms, 16,
    proto3_optional: true,
    type: :uint32,
    json_name: "vadMinSilenceMs"
  )
end

defmodule Vox.ConversationSessionUpdate do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ConversationSessionUpdate",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:stt_model, 1, type: :string, json_name: "sttModel")
  field(:tts_model, 2, type: :string, json_name: "ttsModel")
  field(:voice, 3, type: :string)
  field(:language, 4, type: :string)
  field(:sample_rate, 5, type: :uint32, json_name: "sampleRate")
  field(:policy, 6, type: Vox.ConversationTurnPolicy)
  field(:vad_backend, 7, type: :string, json_name: "vadBackend")
  field(:turn_detector, 8, type: :string, json_name: "turnDetector")
  field(:turn_profile, 9, type: :string, json_name: "turnProfile")
  field(:include_word_timestamps, 10, type: :bool, json_name: "includeWordTimestamps")
end

defmodule Vox.ConversationAudioAppend do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ConversationAudioAppend",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:pcm16, 1, type: :bytes)
  field(:sample_rate, 2, type: :uint32, json_name: "sampleRate")
end

defmodule Vox.ConversationResponseStart do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ConversationResponseStart",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:allow_interruptions, 1,
    proto3_optional: true,
    type: :bool,
    json_name: "allowInterruptions"
  )
end

defmodule Vox.ConversationResponseDelta do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ConversationResponseDelta",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:delta, 1, type: :string)

  field(:allow_interruptions, 2,
    proto3_optional: true,
    type: :bool,
    json_name: "allowInterruptions"
  )
end

defmodule Vox.ConversationResponseCommit do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ConversationResponseCommit",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3
end

defmodule Vox.ConversationResponseCancel do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ConversationResponseCancel",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3
end

defmodule Vox.ConversationResponseReplaceText do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ConversationResponseReplaceText",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:text, 1, type: :string)

  field(:allow_interruptions, 2,
    proto3_optional: true,
    type: :bool,
    json_name: "allowInterruptions"
  )
end

defmodule Vox.ConversationSessionCreated do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ConversationSessionCreated",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:turn_profile, 1, type: :string, json_name: "turnProfile")
  field(:policy, 2, type: Vox.ConversationTurnPolicy)
end

defmodule Vox.ConversationSpeechStarted do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ConversationSpeechStarted",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:timestamp_ms, 1, type: :uint32, json_name: "timestampMs")
end

defmodule Vox.ConversationSpeechStopped do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ConversationSpeechStopped",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:timestamp_ms, 1, type: :uint32, json_name: "timestampMs")
end

defmodule Vox.ConversationTranscriptDelta do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ConversationTranscriptDelta",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:delta, 1, type: :string)
  field(:start_ms, 2, type: :uint32, json_name: "startMs")
  field(:end_ms, 3, type: :uint32, json_name: "endMs")
end

defmodule Vox.ConversationTranscriptDone do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ConversationTranscriptDone",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:transcript, 1, type: :string)
  field(:language, 2, type: :string)
  field(:start_ms, 3, type: :uint32, json_name: "startMs")
  field(:end_ms, 4, type: :uint32, json_name: "endMs")
  field(:eou_probability, 5, proto3_optional: true, type: :float, json_name: "eouProbability")
  field(:entities, 6, repeated: true, type: Vox.Entity)
  field(:topics, 7, repeated: true, type: :string)
  field(:words, 8, repeated: true, type: Vox.WordTimestamp)
end

defmodule Vox.ConversationResponseCreated do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ConversationResponseCreated",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:response_id, 1, type: :string, json_name: "responseId")
end

defmodule Vox.ConversationAudioDelta do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ConversationAudioDelta",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:audio, 1, type: :bytes)
  field(:sample_rate, 2, type: :uint32, json_name: "sampleRate")
  field(:response_id, 3, type: :string, json_name: "responseId")
  field(:sequence, 4, type: :uint32)
end

defmodule Vox.ConversationAudioClear do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ConversationAudioClear",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:response_id, 1, type: :string, json_name: "responseId")
end

defmodule Vox.ConversationInterruptionDetected do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ConversationInterruptionDetected",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:response_id, 1, type: :string, json_name: "responseId")
  field(:vad_active_ms, 2, type: :uint32, json_name: "vadActiveMs")
  field(:partial_transcript, 3, type: :string, json_name: "partialTranscript")
end

defmodule Vox.ConversationInterruptionFalsePositive do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ConversationInterruptionFalsePositive",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:response_id, 1, type: :string, json_name: "responseId")
  field(:vad_active_ms, 2, type: :uint32, json_name: "vadActiveMs")
  field(:partial_transcript, 3, type: :string, json_name: "partialTranscript")
  field(:reason, 4, type: :string)
end

defmodule Vox.ConversationTurnEouPredicted do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ConversationTurnEouPredicted",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:probability, 1, type: :float)
  field(:threshold, 2, type: :float)
  field(:decision, 3, type: :string)
  field(:action, 4, type: :string)
  field(:delay_ms, 5, type: :uint32, json_name: "delayMs")
  field(:turn_detector, 6, type: :string, json_name: "turnDetector")
  field(:start_ms, 7, type: :uint32, json_name: "startMs")
  field(:end_ms, 8, type: :uint32, json_name: "endMs")
end

defmodule Vox.ConversationResponseDone do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ConversationResponseDone",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:response_id, 1, type: :string, json_name: "responseId")
end

defmodule Vox.ConversationResponseCancelled do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ConversationResponseCancelled",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:response_id, 1, type: :string, json_name: "responseId")
end

defmodule Vox.ConversationStateChanged do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ConversationStateChanged",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:state, 1, type: :string)
  field(:previous_state, 2, type: :string, json_name: "previousState")
end

defmodule Vox.ConversationError do
  @moduledoc false

  use Protobuf,
    full_name: "vox.ConversationError",
    protoc_gen_elixir_version: "0.17.0",
    syntax: :proto3

  field(:message, 1, type: :string)
end

defmodule Vox.HealthService.Service do
  @moduledoc false

  use GRPC.Service, name: "vox.HealthService", protoc_gen_elixir_version: "0.17.0"

  rpc(:Health, Vox.HealthRequest, Vox.HealthResponse)

  rpc(:ListLoaded, Vox.ListLoadedRequest, Vox.ListLoadedResponse)
end

defmodule Vox.HealthService.Stub do
  @moduledoc false

  use GRPC.Stub, service: Vox.HealthService.Service
end

defmodule Vox.ModelService.Service do
  @moduledoc false

  use GRPC.Service, name: "vox.ModelService", protoc_gen_elixir_version: "0.17.0"

  rpc(:Pull, Vox.PullRequest, stream(Vox.PullProgress))

  rpc(:List, Vox.ListModelsRequest, Vox.ListModelsResponse)

  rpc(:Show, Vox.ShowRequest, Vox.ShowResponse)

  rpc(:Delete, Vox.DeleteRequest, Vox.DeleteResponse)
end

defmodule Vox.ModelService.Stub do
  @moduledoc false

  use GRPC.Stub, service: Vox.ModelService.Service
end

defmodule Vox.TranscriptionService.Service do
  @moduledoc false

  use GRPC.Service, name: "vox.TranscriptionService", protoc_gen_elixir_version: "0.17.0"

  rpc(:Transcribe, Vox.TranscribeRequest, Vox.TranscribeResponse)

  rpc(:Annotate, Vox.AnnotateRequest, Vox.AnnotateResponse)
end

defmodule Vox.TranscriptionService.Stub do
  @moduledoc false

  use GRPC.Stub, service: Vox.TranscriptionService.Service
end

defmodule Vox.SynthesisService.Service do
  @moduledoc false

  use GRPC.Service, name: "vox.SynthesisService", protoc_gen_elixir_version: "0.17.0"

  rpc(:Synthesize, Vox.SynthesizeRequest, stream(Vox.AudioChunk))

  rpc(:ListVoices, Vox.ListVoicesRequest, Vox.ListVoicesResponse)

  rpc(:CreateVoice, Vox.CreateVoiceRequest, Vox.CreateVoiceResponse)

  rpc(:DeleteVoice, Vox.DeleteVoiceRequest, Vox.DeleteVoiceResponse)
end

defmodule Vox.SynthesisService.Stub do
  @moduledoc false

  use GRPC.Stub, service: Vox.SynthesisService.Service
end

defmodule Vox.StreamingService.Service do
  @moduledoc false

  use GRPC.Service, name: "vox.StreamingService", protoc_gen_elixir_version: "0.17.0"

  rpc(:StreamTranscribe, stream(Vox.StreamInput), stream(Vox.StreamOutput))
end

defmodule Vox.StreamingService.Stub do
  @moduledoc false

  use GRPC.Stub, service: Vox.StreamingService.Service
end

defmodule Vox.ConversationService.Service do
  @moduledoc false

  use GRPC.Service, name: "vox.ConversationService", protoc_gen_elixir_version: "0.17.0"

  rpc(:Converse, stream(Vox.ConverseClientMessage), stream(Vox.ConverseServerMessage))
end

defmodule Vox.ConversationService.Stub do
  @moduledoc false

  use GRPC.Stub, service: Vox.ConversationService.Service
end

defmodule Vox.RtcService.Service do
  @moduledoc false

  use GRPC.Service, name: "vox.RtcService", protoc_gen_elixir_version: "0.17.0"

  rpc(:CreateSession, Vox.RtcCreateSessionRequest, Vox.RtcSessionBootstrap)

  rpc(:Control, stream(Vox.RtcControlClientMessage), stream(Vox.RtcControlServerMessage))
end

defmodule Vox.RtcService.Stub do
  @moduledoc false

  use GRPC.Stub, service: Vox.RtcService.Service
end
