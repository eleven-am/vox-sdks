defmodule VoxRtcServer.IceServer do
  @moduledoc "Public ICE server configuration returned by Vox."

  @enforce_keys [:urls]
  defstruct [:username, :credential, urls: []]

  @type t :: %__MODULE__{
          urls: [String.t()],
          username: String.t() | nil,
          credential: String.t() | nil
        }
end

defmodule VoxRtcServer.Bootstrap do
  @moduledoc "Private RTC session bootstrap returned to a trusted Elixir service."

  @enforce_keys [:session_id, :expires_at]
  defstruct [:session_id, :expires_at, attach_ttl_seconds: 0, ice_servers: []]

  @type t :: %__MODULE__{
          session_id: String.t(),
          expires_at: String.t(),
          attach_ttl_seconds: non_neg_integer(),
          ice_servers: [VoxRtcServer.IceServer.t()]
        }
end

defmodule VoxRtcServer.SessionDescription do
  @moduledoc "WebRTC session description used for offer/answer signaling."

  @enforce_keys [:type, :sdp]
  defstruct [:type, :sdp]

  @type t :: %__MODULE__{type: String.t(), sdp: String.t()}
end

defmodule VoxRtcServer.IceCandidate do
  @moduledoc "A trickled WebRTC ICE candidate."

  @enforce_keys [:candidate]
  defstruct [:candidate, :sdp_mid, :sdp_m_line_index, :username_fragment]

  @type t :: %__MODULE__{
          candidate: String.t(),
          sdp_mid: String.t() | nil,
          sdp_m_line_index: non_neg_integer() | nil,
          username_fragment: String.t() | nil
        }
end

defmodule VoxRtcServer.TurnPolicy do
  @moduledoc "Optional overrides for Vox's server-owned turn policy."

  defstruct [
    :allow_interrupt_while_speaking,
    :min_interrupt_duration_ms,
    :max_endpointing_delay_ms,
    :false_interruption_timeout_ms,
    :min_interrupt_words,
    :partial_interrupts,
    :dynamic_endpointing,
    :min_endpointing_delay_ms,
    :speaking_interrupt_min_duration_ms,
    :speaking_interrupt_min_words,
    :self_echo_min_words,
    :self_echo_min_overlap,
    :aec_warmup_ms,
    :backchannel_end_cooldown_ms,
    :vad_min_silence_ms
  ]

  @type t :: %__MODULE__{}
end

defmodule VoxRtcServer.SessionConfig do
  @moduledoc "RTC conversation configuration sent over the control stream."

  defstruct [
    :stt_model,
    :tts_model,
    :voice,
    :language,
    :sample_rate,
    :policy,
    :vad_backend,
    :turn_detector,
    :turn_profile,
    :speech_context,
    include_word_timestamps: false
  ]

  @type t :: %__MODULE__{
          stt_model: String.t() | nil,
          tts_model: String.t() | nil,
          voice: String.t() | nil,
          language: String.t() | nil,
          sample_rate: non_neg_integer() | nil,
          policy: VoxRtcServer.TurnPolicy.t() | nil,
          vad_backend: String.t() | nil,
          turn_detector: String.t() | nil,
          turn_profile: String.t() | nil,
          speech_context: boolean() | nil,
          include_word_timestamps: boolean()
        }
end

defmodule VoxRtcServer.ResponseOptions do
  @moduledoc "Response generation options."

  defstruct [:allow_interruptions, :generation_id]

  @type t :: %__MODULE__{
          allow_interruptions: boolean() | nil,
          generation_id: String.t() | nil
        }
end

defmodule VoxRtcServer.SpeechContextSpan do
  @moduledoc "A timestamped speaker-emotion or vocal-event span."

  @enforce_keys [:label, :start_ms, :end_ms]
  defstruct [:label, :start_ms, :end_ms]

  @type t :: %__MODULE__{
          label: String.t(),
          start_ms: non_neg_integer(),
          end_ms: pos_integer()
        }
end

defmodule VoxRtcServer.SpeechContextSoundSpan do
  @moduledoc "A timestamped YAMNet sound span with its peak model score."

  @enforce_keys [:label, :start_ms, :end_ms, :score]
  defstruct [:label, :start_ms, :end_ms, :score]

  @type t :: %__MODULE__{
          label: String.t(),
          start_ms: non_neg_integer(),
          end_ms: pos_integer(),
          score: float()
        }
end

defmodule VoxRtcServer.SpeechContext do
  @moduledoc "Versioned speech enrichment attached to a final transcript."

  alias VoxRtcServer.{SpeechContextSoundSpan, SpeechContextSpan}

  @enforce_keys [:schema_version, :status]
  defstruct [:schema_version, :status, :emotions, :vocal, :sounds, :unavailable]

  @type status :: :complete | :partial | :failed
  @type track :: :speaker | :sounds
  @type t :: %__MODULE__{
          schema_version: 2,
          status: status(),
          emotions: [SpeechContextSpan.t()] | nil,
          vocal: [SpeechContextSpan.t()] | nil,
          sounds: [SpeechContextSoundSpan.t()] | nil,
          unavailable: [track()] | nil
        }

  @spec decode(Google.Protobuf.Struct.t() | nil) :: t() | nil
  def decode(nil), do: nil

  def decode(%Google.Protobuf.Struct{} = value) do
    value
    |> Google.Protobuf.to_map()
    |> decode_map()
  end

  defp decode_map(%{"schema_version" => version, "status" => status} = value)
       when version == 2 and status in ["complete", "partial", "failed"] do
    emotions = spans(Map.get(value, "emotions"))
    vocal = spans(Map.get(value, "vocal"))
    sounds = sound_spans(Map.get(value, "sounds"))
    unavailable = tracks(Map.get(value, "unavailable"))

    if valid_shape?(status, emotions, vocal, sounds, unavailable, value) do
      %__MODULE__{
        schema_version: 2,
        status: String.to_existing_atom(status),
        emotions: value_or_nil(emotions),
        vocal: value_or_nil(vocal),
        sounds: value_or_nil(sounds),
        unavailable: value_or_nil(unavailable)
      }
    end
  end

  defp decode_map(_value), do: nil

  defp spans(nil), do: :missing

  defp spans(values) when is_list(values) do
    parse_all(values, fn
      %{"label" => label, "start_ms" => start_ms, "end_ms" => end_ms}
      when is_binary(label) and label != "" ->
        with {:ok, start_ms} <- timestamp(start_ms),
             {:ok, end_ms} <- timestamp(end_ms),
             true <- end_ms > start_ms do
          {:ok, %SpeechContextSpan{label: label, start_ms: start_ms, end_ms: end_ms}}
        else
          _error -> :error
        end

      _value ->
        :error
    end)
  end

  defp spans(_value), do: :invalid

  defp sound_spans(nil), do: :missing

  defp sound_spans(values) when is_list(values) do
    parse_all(values, fn
      %{
        "label" => label,
        "start_ms" => start_ms,
        "end_ms" => end_ms,
        "score" => score
      }
      when is_binary(label) and label != "" and is_number(score) and score >= 0 and
             score <= 1 ->
        with {:ok, start_ms} <- timestamp(start_ms),
             {:ok, end_ms} <- timestamp(end_ms),
             true <- end_ms > start_ms do
          {:ok,
           %SpeechContextSoundSpan{
             label: label,
             start_ms: start_ms,
             end_ms: end_ms,
             score: score * 1.0
           }}
        else
          _error -> :error
        end

      _value ->
        :error
    end)
  end

  defp sound_spans(_value), do: :invalid

  defp tracks(nil), do: :missing

  defp tracks(values) when is_list(values) do
    parsed =
      Enum.map(values, fn
        "speaker" -> :speaker
        "sounds" -> :sounds
        _value -> :invalid
      end)

    if :invalid in parsed or Enum.uniq(parsed) != parsed, do: :invalid, else: {:ok, parsed}
  end

  defp tracks(_value), do: :invalid

  defp valid_shape?("complete", {:ok, _}, {:ok, _}, {:ok, _}, :missing, value),
    do: not Map.has_key?(value, "unavailable")

  defp valid_shape?("partial", emotions, vocal, sounds, {:ok, [track]}, _value) do
    speaker_valid =
      if track == :speaker,
        do: emotions == :missing and vocal == :missing,
        else: matches_ok?(emotions) and matches_ok?(vocal)

    sounds_valid = if track == :sounds, do: sounds == :missing, else: matches_ok?(sounds)
    speaker_valid and sounds_valid
  end

  defp valid_shape?(
         "failed",
         :missing,
         :missing,
         :missing,
         {:ok, unavailable},
         _value
       ),
       do: MapSet.new(unavailable) == MapSet.new([:speaker, :sounds])

  defp valid_shape?(_status, _emotions, _vocal, _sounds, _unavailable, _value),
    do: false

  defp parse_all(values, parser) do
    Enum.reduce_while(values, {:ok, []}, fn value, {:ok, parsed} ->
      case parser.(value) do
        {:ok, item} -> {:cont, {:ok, [item | parsed]}}
        :error -> {:halt, :invalid}
      end
    end)
    |> case do
      {:ok, parsed} -> {:ok, Enum.reverse(parsed)}
      :invalid -> :invalid
    end
  end

  defp timestamp(value) when is_float(value) and value >= 0 and trunc(value) == value,
    do: {:ok, trunc(value)}

  defp timestamp(value) when is_integer(value) and value >= 0, do: {:ok, value}
  defp timestamp(_value), do: :error

  defp matches_ok?({:ok, _value}), do: true
  defp matches_ok?(_value), do: false
  defp value_or_nil({:ok, value}), do: value
  defp value_or_nil(_value), do: nil
end

defmodule VoxRtcServer.TranscriptCompleted do
  @moduledoc "A final transcript event with typed speech context."

  defstruct [
    :transcript,
    :language,
    :start_ms,
    :end_ms,
    :eou_probability,
    :speech_context,
    entities: [],
    topics: [],
    words: []
  ]

  @type t :: %__MODULE__{
          transcript: String.t(),
          language: String.t(),
          start_ms: non_neg_integer(),
          end_ms: non_neg_integer(),
          eou_probability: float() | nil,
          entities: [Vox.Entity.t()],
          topics: [String.t()],
          words: [Vox.WordTimestamp.t()],
          speech_context: VoxRtcServer.SpeechContext.t() | nil
        }
end

defmodule VoxRtcServer.ErrorEvent do
  @moduledoc "A structured error emitted by Vox signaling or conversation control."

  @known_codes [
    "response_rejected_turn_state",
    "response_rejected_user_speech",
    "response_stale_generation",
    "response_already_active",
    "response_failed",
    "command_invalid",
    "session_failed"
  ]

  @enforce_keys [:message, :recoverable]
  defstruct [:message, :code, :generation_id, recoverable: true]

  @type t :: %__MODULE__{
          message: String.t(),
          code: String.t() | nil,
          recoverable: boolean(),
          generation_id: String.t() | nil
        }

  @spec known_codes() :: [String.t()]
  def known_codes, do: @known_codes

  @spec known_code?(term()) :: boolean()
  def known_code?(code), do: code in @known_codes
end

defmodule VoxRtcServer.StartAck do
  @moduledoc "Vox acknowledgement for a generation-aware response start."

  @enforce_keys [:generation_id]
  defstruct [:response_id, :generation_id]

  @type t :: %__MODULE__{
          response_id: String.t() | nil,
          generation_id: String.t()
        }
end

defmodule VoxRtcServer.Event do
  @moduledoc "A typed event emitted by a Vox RTC control session."

  @enforce_keys [:type, :payload, :session_id]
  defstruct [:type, :payload, :session_id]

  @type event_type ::
          :session_attached
          | :answer
          | :ice_candidate
          | :ice_candidates_complete
          | :session_created
          | :speech_started
          | :speech_stopped
          | :transcript_delta
          | :transcript_completed
          | :response_created
          | :response_committed
          | :response_audio
          | :response_audio_clear
          | :response_done
          | :response_cancelled
          | :turn_state_changed
          | :interruption_detected
          | :interruption_false_positive
          | :turn_eou_predicted
          | :browser_event
          | :wire_event
          | :error
          | :closed

  @type t :: %__MODULE__{
          type: event_type(),
          payload: struct() | map(),
          session_id: String.t()
        }
end
