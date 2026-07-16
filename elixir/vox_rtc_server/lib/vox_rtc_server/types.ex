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
    :stable_speaking_min_ms,
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
          include_word_timestamps: boolean()
        }
end

defmodule VoxRtcServer.ResponseOptions do
  @moduledoc "Response generation options."

  defstruct [:allow_interruptions]

  @type t :: %__MODULE__{allow_interruptions: boolean() | nil}
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
