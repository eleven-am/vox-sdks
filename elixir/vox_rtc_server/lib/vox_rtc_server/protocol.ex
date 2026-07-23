defmodule VoxRtcServer.Protocol do
  @moduledoc false

  alias VoxRtcServer.{
    Bootstrap,
    ErrorEvent,
    Event,
    IceCandidate,
    IceServer,
    ResponseOptions,
    ResponseOutputOptions,
    SessionConfig,
    SessionDescription,
    SpeechContext,
    TranscriptCompleted,
    TurnPolicy
  }

  @spec bootstrap(Vox.RtcSessionBootstrap.t()) :: Bootstrap.t()
  def bootstrap(value) do
    %Bootstrap{
      session_id: value.session_id,
      expires_at: value.expires_at,
      attach_ttl_seconds: value.attach_ttl_seconds,
      ice_servers:
        Enum.map(value.ice_servers, fn server ->
          %IceServer{
            urls: server.urls,
            username: empty_to_nil(server.username),
            credential: empty_to_nil(server.credential)
          }
        end)
    }
  end

  @spec attach(String.t()) :: Vox.RtcControlClientMessage.t()
  def attach(session_id) do
    control(:attach, %Vox.RtcControlAttach{session_id: session_id})
  end

  @spec configure(SessionConfig.t()) :: Vox.RtcControlClientMessage.t()
  def configure(%SessionConfig{} = config) do
    update = %Vox.ConversationSessionUpdate{
      stt_model: config.stt_model || "",
      tts_model: config.tts_model || "",
      voice: config.voice || "",
      language: config.language || "",
      sample_rate: config.sample_rate || 0,
      policy: turn_policy(config.policy),
      vad_backend: config.vad_backend || "",
      turn_detector: config.turn_detector || "",
      turn_profile: config.turn_profile || "",
      include_word_timestamps: config.include_word_timestamps,
      speech_context: config.speech_context || false
    }

    control(:session_update, update)
  end

  @spec offer(SessionDescription.t(), boolean()) :: Vox.RtcControlClientMessage.t()
  def offer(%SessionDescription{} = offer, restart) when is_boolean(restart) do
    control(:offer, %Vox.RtcControlOffer{
      offer: %Vox.RtcSessionDescription{type: offer.type, sdp: offer.sdp},
      restart: restart
    })
  end

  @spec candidate(IceCandidate.t() | :complete) :: Vox.RtcControlClientMessage.t()
  def candidate(%IceCandidate{} = candidate) do
    control(:candidate, %Vox.RtcIceCandidate{
      candidate: candidate.candidate,
      sdp_mid: candidate.sdp_mid,
      sdp_m_line_index: candidate.sdp_m_line_index,
      username_fragment: candidate.username_fragment
    })
  end

  def candidate(:complete) do
    control(:candidates_complete, %Vox.RtcIceCandidatesComplete{})
  end

  @spec close(String.t()) :: Vox.RtcControlClientMessage.t()
  def close(reason), do: control(:close, %Vox.RtcControlClose{reason: reason})

  @spec response_start(ResponseOptions.t()) :: Vox.RtcControlClientMessage.t()
  def response_start(%ResponseOptions{} = options) do
    control(:response_start, %Vox.ConversationResponseStart{
      allow_interruptions: options.allow_interruptions,
      generation_id: options.generation_id || "",
      output: response_output(options.output)
    })
  end

  @spec response_delta(String.t(), ResponseOptions.t()) :: Vox.RtcControlClientMessage.t()
  def response_delta(delta, %ResponseOptions{} = options) do
    control(:response_delta, %Vox.ConversationResponseDelta{
      delta: delta,
      allow_interruptions: options.allow_interruptions,
      generation_id: options.generation_id || ""
    })
  end

  @spec response_commit(ResponseOptions.t()) :: Vox.RtcControlClientMessage.t()
  def response_commit(%ResponseOptions{} = options) do
    control(:response_commit, %Vox.ConversationResponseCommit{
      generation_id: options.generation_id || ""
    })
  end

  @spec response_cancel(ResponseOptions.t()) :: Vox.RtcControlClientMessage.t()
  def response_cancel(%ResponseOptions{} = options) do
    control(:response_cancel, %Vox.ConversationResponseCancel{
      generation_id: options.generation_id || ""
    })
  end

  @spec response_replace_text(String.t(), ResponseOptions.t()) ::
          Vox.RtcControlClientMessage.t()
  def response_replace_text(text, %ResponseOptions{} = options) do
    control(:response_replace_text, %Vox.ConversationResponseReplaceText{
      text: text,
      allow_interruptions: options.allow_interruptions
    })
  end

  @spec client_event(String.t(), map()) ::
          {:ok, Vox.RtcControlClientMessage.t()} | {:error, term()}
  def client_event(event, payload) when is_binary(event) and is_map(payload) do
    with {:ok, payload_json} <- Jason.encode(payload) do
      {:ok, control(:client_event, %Vox.RtcClientEvent{event: event, payload_json: payload_json})}
    end
  end

  @spec decode_event(Vox.RtcControlServerMessage.t(), String.t()) ::
          {:ok, Event.t()} | {:error, term()}
  def decode_event(%Vox.RtcControlServerMessage{msg: {kind, payload}}, session_id) do
    decode_server_event(kind, payload, session_id)
  end

  def decode_event(_message, _session_id), do: {:error, :missing_event}

  defp decode_server_event(:attached, payload, session_id),
    do: event(:session_attached, payload, session_id)

  defp decode_server_event(:answer, payload, session_id) do
    description = payload.answer || %Vox.RtcSessionDescription{}

    event(
      :answer,
      %SessionDescription{type: description.type, sdp: description.sdp},
      session_id
    )
  end

  defp decode_server_event(:candidate, payload, session_id) do
    event(
      :ice_candidate,
      %IceCandidate{
        candidate: payload.candidate,
        sdp_mid: payload.sdp_mid,
        sdp_m_line_index: payload.sdp_m_line_index,
        username_fragment: payload.username_fragment
      },
      session_id
    )
  end

  defp decode_server_event(:candidates_complete, payload, session_id),
    do: event(:ice_candidates_complete, payload, session_id)

  defp decode_server_event(:conversation, payload, session_id),
    do: decode_conversation_event(payload, session_id)

  defp decode_server_event(:error, payload, session_id),
    do: event(:error, error_event(payload), session_id)

  defp decode_server_event(:closed, payload, session_id),
    do: event(:closed, %{reason: payload.reason}, session_id)

  defp decode_server_event(:browser_event, payload, session_id),
    do: json_event(:browser_event, payload.event, payload.payload_json, session_id)

  defp decode_server_event(:event, payload, session_id),
    do: json_event(:wire_event, payload.type, payload.payload_json, session_id)

  defp decode_server_event(kind, _payload, _session_id),
    do: {:error, {:unknown_server_event, kind}}

  defp response_output(nil), do: nil

  defp response_output(%ResponseOutputOptions{} = output) do
    %Vox.ConversationResponseOutput{
      model: output.model,
      voice: output.voice,
      language: output.language,
      speed: output.speed,
      params:
        if(is_nil(output.params),
          do: nil,
          else: Google.Protobuf.from_map(output.params)
        )
    }
  end

  @conversation_events %{
    session_created: :session_created,
    speech_started: :speech_started,
    speech_stopped: :speech_stopped,
    transcript_delta: :transcript_delta,
    response_created: :response_created,
    response_committed: :response_committed,
    audio_delta: :response_audio,
    audio_clear: :response_audio_clear,
    response_done: :response_done,
    response_cancelled: :response_cancelled,
    state_changed: :turn_state_changed,
    interruption_detected: :interruption_detected,
    interruption_false_positive: :interruption_false_positive,
    turn_eou_predicted: :turn_eou_predicted,
    error: :error
  }

  defp decode_conversation_event(
         %Vox.ConverseServerMessage{msg: {:transcript_done, payload}},
         session_id
       ) do
    event(
      :transcript_completed,
      %TranscriptCompleted{
        transcript: payload.transcript,
        language: payload.language,
        start_ms: payload.start_ms,
        end_ms: payload.end_ms,
        eou_probability: payload.eou_probability,
        entities: payload.entities,
        topics: payload.topics,
        words: payload.words,
        speech_context: SpeechContext.decode(payload.speech_context)
      },
      session_id
    )
  end

  defp decode_conversation_event(%Vox.ConverseServerMessage{msg: {kind, payload}}, session_id) do
    case Map.fetch(@conversation_events, kind) do
      {:ok, :error} -> event(:error, error_event(payload), session_id)
      {:ok, type} -> event(type, payload, session_id)
      :error -> {:error, {:unknown_conversation_event, kind}}
    end
  end

  defp decode_conversation_event(_payload, _session_id), do: {:error, :missing_conversation_event}

  defp json_event(type, name, payload_json, session_id) do
    payload =
      case Jason.decode(payload_json) do
        {:ok, decoded} ->
          %{name: name, data: decoded}

        {:error, error} ->
          %{name: name, raw_payload: payload_json, decode_error: Exception.message(error)}
      end

    event(type, payload, session_id)
  end

  defp event(type, payload, session_id),
    do: {:ok, %Event{type: type, payload: payload, session_id: session_id}}

  defp error_event(payload) do
    %ErrorEvent{
      message: payload.message,
      code: empty_to_nil(payload.code),
      recoverable: payload.recoverable,
      generation_id: empty_to_nil(payload.generation_id)
    }
  end

  defp control(kind, payload), do: %Vox.RtcControlClientMessage{msg: {kind, payload}}

  defp turn_policy(nil), do: nil

  defp turn_policy(%TurnPolicy{} = policy) do
    struct(Vox.ConversationTurnPolicy, Map.from_struct(policy))
  end

  defp empty_to_nil(""), do: nil
  defp empty_to_nil(value), do: value
end
