package rtcserver

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"sync"
	"time"
)

type ControlSession struct {
	channel              socketChannel
	sessionID            string
	channelName          string
	joinTimeout          time.Duration
	responseMu           sync.Mutex
	responseGeneration   uint64
	responseGenerationID string
}

type joinErrorReporter interface {
	JoinError() string
}

func newControlSession(channel socketChannel, sessionID string, joinTimeout time.Duration) *ControlSession {
	return &ControlSession{
		channel:     channel,
		sessionID:   sessionID,
		channelName: "/rtc/" + sessionID,
		joinTimeout: joinTimeout,
	}
}

func (s *ControlSession) SessionID() string {
	return s.sessionID
}

func (s *ControlSession) ChannelName() string {
	return s.channelName
}

func (s *ControlSession) Join(ctx context.Context) error {
	done := make(chan error, 1)
	unsub := s.channel.OnChannelStateChange(func(state channelState) {
		switch state {
		case channelStateJoined:
			select {
			case done <- nil:
			default:
			}
		case channelStateClosed, channelStateDeclined:
			reason := ""
			if reporter, ok := s.channel.(joinErrorReporter); ok {
				reason = reporter.JoinError()
			}
			if reason != "" {
				reason = ": " + reason
			}
			select {
			case done <- fmt.Errorf("RTC channel join failed for %s: %s%s", s.channelName, state, reason):
			default:
			}
		}
	})
	defer unsub()

	s.channel.Join()

	timeoutCtx, cancel := context.WithTimeout(ctx, s.joinTimeout)
	defer cancel()

	select {
	case err := <-done:
		return err
	case <-timeoutCtx.Done():
		return fmt.Errorf("timed out waiting for RTC channel join on %s: %w", s.channelName, timeoutCtx.Err())
	}
}

func (s *ControlSession) Close() {
	s.channel.Leave()
}

func (s *ControlSession) OnEvent(handler func(WireEvent)) func() {
	return s.channel.OnMessage(func(event string, payload map[string]interface{}) {
		handler(WireEvent{
			Type:        event,
			Data:        payload,
			SessionID:   s.sessionID,
			ChannelName: s.channelName,
		})
	})
}

func (s *ControlSession) On(eventName string, handler func(map[string]interface{})) func() {
	return s.channel.OnMessage(func(event string, payload map[string]interface{}) {
		if event == eventName {
			handler(payload)
		}
	})
}

func (s *ControlSession) OnSessionAttached(handler func(SessionAttachedEvent)) func() {
	return s.On(EventRTCSessionAttached, func(payload map[string]interface{}) {
		handler(SessionAttachedEvent{
			SessionID:   eventSessionID(payload, s.sessionID),
			ChannelName: s.channelName,
			Data:        payload,
		})
	})
}

func (s *ControlSession) OnSessionCreated(handler func(SessionCreatedEvent)) func() {
	return s.On(EventSessionCreated, func(payload map[string]interface{}) {
		handler(SessionCreatedEvent{
			SessionID:   eventSessionID(payload, s.sessionID),
			ChannelName: s.channelName,
			Data:        payload,
			Session:     mapValue(payload, "session"),
		})
	})
}

func (s *ControlSession) OnTranscript(handler func(TranscriptEvent)) func() {
	return s.On(EventTranscriptCompleted, func(payload map[string]interface{}) {
		handler(TranscriptEvent{
			SessionID:      eventSessionID(payload, s.sessionID),
			ChannelName:    s.channelName,
			Data:           payload,
			Transcript:     stringValue(payload, "transcript", ""),
			Language:       stringValue(payload, "language", ""),
			StartMS:        numberValue(payload, "start_ms"),
			EndMS:          numberValue(payload, "end_ms"),
			EOUProbability: numberValue(payload, "eou_probability"),
			Topics:         stringSliceValue(payload, "topics"),
		})
	})
}

func (s *ControlSession) OnTurnStateChanged(handler func(TurnStateEvent)) func() {
	return s.On(EventTurnStateChanged, func(payload map[string]interface{}) {
		handler(TurnStateEvent{
			SessionID:     eventSessionID(payload, s.sessionID),
			ChannelName:   s.channelName,
			Data:          payload,
			State:         stringValue(payload, "state", "unknown"),
			PreviousState: stringValue(payload, "previous_state", ""),
		})
	})
}

func (s *ControlSession) OnSpeechStarted(handler func(SpeechStartedEvent)) func() {
	return s.On(EventSpeechStarted, func(payload map[string]interface{}) {
		handler(SpeechStartedEvent{
			SessionID:   eventSessionID(payload, s.sessionID),
			ChannelName: s.channelName,
			Data:        payload,
			TimestampMS: numberValue(payload, "timestamp_ms"),
		})
	})
}

func (s *ControlSession) OnSpeechStopped(handler func(SpeechStoppedEvent)) func() {
	return s.On(EventSpeechStopped, func(payload map[string]interface{}) {
		handler(SpeechStoppedEvent{
			SessionID:   eventSessionID(payload, s.sessionID),
			ChannelName: s.channelName,
			Data:        payload,
			TimestampMS: numberValue(payload, "timestamp_ms"),
		})
	})
}

func (s *ControlSession) OnTranscriptDelta(handler func(TranscriptDeltaEvent)) func() {
	return s.On(EventTranscriptDelta, func(payload map[string]interface{}) {
		handler(TranscriptDeltaEvent{
			SessionID:   eventSessionID(payload, s.sessionID),
			ChannelName: s.channelName,
			Data:        payload,
			Delta:       stringValue(payload, "delta", ""),
			StartMS:     numberValue(payload, "start_ms"),
			EndMS:       numberValue(payload, "end_ms"),
		})
	})
}

func (s *ControlSession) OnTurnEouPredicted(handler func(TurnEouPredictedEvent)) func() {
	return s.On(EventTurnEouPredicted, func(payload map[string]interface{}) {
		handler(TurnEouPredictedEvent{
			SessionID:    eventSessionID(payload, s.sessionID),
			ChannelName:  s.channelName,
			Data:         payload,
			Probability:  numberValue(payload, "probability"),
			Threshold:    numberValue(payload, "threshold"),
			DelayMS:      numberValue(payload, "delay_ms"),
			StartMS:      numberValue(payload, "start_ms"),
			EndMS:        numberValue(payload, "end_ms"),
			Decision:     stringValue(payload, "decision", ""),
			Action:       stringValue(payload, "action", ""),
			TurnDetector: stringValue(payload, "turn_detector", ""),
		})
	})
}

func (s *ControlSession) OnResponseCreated(handler func(ResponseEvent)) func() {
	return s.onResponseEvent(EventResponseCreated, handler)
}

func (s *ControlSession) OnResponseCommitted(handler func(ResponseEvent)) func() {
	return s.onResponseEvent(EventResponseCommitted, handler)
}

func (s *ControlSession) OnResponseDone(handler func(ResponseEvent)) func() {
	return s.onResponseEvent(EventResponseDone, handler)
}

func (s *ControlSession) OnResponseCancelled(handler func(ResponseEvent)) func() {
	return s.onResponseEvent(EventResponseCancelled, handler)
}

func (s *ControlSession) OnResponseAudioClear(handler func(ResponseEvent)) func() {
	return s.onResponseEvent(EventResponseAudioClear, handler)
}

func (s *ControlSession) onResponseEvent(eventName string, handler func(ResponseEvent)) func() {
	return s.On(eventName, func(payload map[string]interface{}) {
		handler(ResponseEvent{
			SessionID:   eventSessionID(payload, s.sessionID),
			ChannelName: s.channelName,
			Data:        payload,
			ResponseID:  stringValue(payload, "response_id", ""),
		})
	})
}

func (s *ControlSession) OnInterruptionDetected(handler func(InterruptionEvent)) func() {
	return s.onInterruptionEvent(EventInterruptionDetected, handler)
}

func (s *ControlSession) OnInterruptionFalsePositive(handler func(InterruptionEvent)) func() {
	return s.onInterruptionEvent(EventInterruptionFalsePositive, handler)
}

func (s *ControlSession) onInterruptionEvent(eventName string, handler func(InterruptionEvent)) func() {
	return s.On(eventName, func(payload map[string]interface{}) {
		handler(InterruptionEvent{
			ResponseEvent: ResponseEvent{
				SessionID:   eventSessionID(payload, s.sessionID),
				ChannelName: s.channelName,
				Data:        payload,
				ResponseID:  stringValue(payload, "response_id", ""),
			},
			VADActiveMS:       numberValue(payload, "vad_active_ms"),
			PartialTranscript: stringValue(payload, "partial_transcript", ""),
		})
	})
}

func (s *ControlSession) OnBrowserEvent(handler func(BrowserEvent)) func() {
	return s.On(EventBrowserEvent, func(payload map[string]interface{}) {
		handler(BrowserEvent{
			SessionID:   eventSessionID(payload, s.sessionID),
			ChannelName: s.channelName,
			Data:        payload,
			Event:       stringValue(payload, "event", ""),
			Payload:     payload["payload"],
		})
	})
}

func (s *ControlSession) OnClose(handler func(CloseEvent)) func() {
	return s.On(EventRTCClientDisconnected, func(payload map[string]interface{}) {
		handler(CloseEvent{
			SessionID:          eventSessionID(payload, s.sessionID),
			ChannelName:        s.channelName,
			Data:               payload,
			Reason:             stringValue(payload, "reason", "unknown"),
			ConnectionState:    stringValue(payload, "connection_state", ""),
			ICEConnectionState: stringValue(payload, "ice_connection_state", ""),
			DataChannelState:   stringValue(payload, "data_channel_state", ""),
		})
	})
}

func (s *ControlSession) OnError(handler func(ErrorEvent)) func() {
	return s.On(EventError, func(payload map[string]interface{}) {
		handler(ErrorEvent{
			SessionID:   eventSessionID(payload, s.sessionID),
			ChannelName: s.channelName,
			Data:        payload,
			Message:     stringValue(payload, "message", ""),
			Code:        stringValue(payload, "code", ""),
		})
	})
}

func (s *ControlSession) SendControl(event string, payload map[string]interface{}) {
	if payload == nil {
		payload = map[string]interface{}{}
	}
	s.channel.SendMessage(event, payload)
}

func (s *ControlSession) SendOffer(offer RTCSessionDescription, restart bool) error {
	if offer.Type != "offer" || strings.TrimSpace(offer.SDP) == "" {
		return fmt.Errorf("RTC offer requires a non-empty SDP offer")
	}
	s.SendControl("rtc.offer", map[string]interface{}{
		"offer":   offer,
		"restart": restart,
	})
	return nil
}

func (s *ControlSession) SendIceCandidate(candidate *RTCIceCandidate) {
	var payload interface{}
	if candidate != nil {
		payload = candidate
	}
	s.SendControl("rtc.ice_candidate", map[string]interface{}{
		"candidate": payload,
	})
}

func (s *ControlSession) CloseRTC(reason string) {
	if strings.TrimSpace(reason) == "" {
		reason = "client_closed"
	}
	s.SendControl("rtc.close", map[string]interface{}{"reason": reason})
}

func (s *ControlSession) Configure(config SessionConfig) {
	session := map[string]interface{}{}
	if config.STTModel != "" {
		session["stt_model"] = config.STTModel
	}
	if config.TTSModel != "" {
		session["tts_model"] = config.TTSModel
	}
	if config.Voice != "" {
		session["voice"] = config.Voice
	}
	if config.TurnProfile != "" {
		session["turn_profile"] = config.TurnProfile
	}
	if config.VADBackend != "" {
		session["vad_backend"] = config.VADBackend
	}
	if config.TurnDetector != "" {
		session["turn_detector"] = config.TurnDetector
	}
	for key, value := range config.Extra {
		session[key] = value
	}
	s.SendControl("session.update", map[string]interface{}{"session": session})
}

func (s *ControlSession) StartResponse(options *ResponseOptions) {
	payload := responseOptionsPayload(options)
	s.responseMu.Lock()
	s.responseGeneration++
	random := make([]byte, 16)
	if _, err := rand.Read(random); err == nil {
		s.responseGenerationID = fmt.Sprintf(
			"generation_%d_%s",
			s.responseGeneration,
			hex.EncodeToString(random),
		)
	} else {
		s.responseGenerationID = fmt.Sprintf(
			"generation_%d_%d",
			s.responseGeneration,
			time.Now().UnixNano(),
		)
	}
	payload["generation_id"] = s.responseGenerationID
	s.responseMu.Unlock()
	s.SendControl("response.start", payload)
}

func (s *ControlSession) AppendResponseText(delta string, options *ResponseOptions) {
	payload := responseOptionsPayload(options)
	payload["delta"] = delta
	s.addResponseGeneration(payload)
	s.SendControl("response.delta", payload)
}

func (s *ControlSession) CommitResponse() {
	payload := map[string]interface{}{}
	s.addResponseGeneration(payload)
	s.SendControl("response.commit", payload)
}

func (s *ControlSession) CancelResponse() {
	payload := map[string]interface{}{}
	s.responseMu.Lock()
	if s.responseGenerationID != "" {
		payload["generation_id"] = s.responseGenerationID
	}
	s.responseGenerationID = ""
	s.responseMu.Unlock()
	s.SendControl("response.cancel", payload)
}

func (s *ControlSession) ReplaceResponseText(text string, options *ResponseOptions) {
	s.responseMu.Lock()
	s.responseGenerationID = ""
	s.responseMu.Unlock()
	payload := responseOptionsPayload(options)
	payload["text"] = text
	s.SendControl("response.replace_text", payload)
}

func (s *ControlSession) SendTextResponse(text string, options *ResponseOptions, cancelFirst bool) {
	if cancelFirst {
		s.ReplaceResponseText(text, options)
		return
	}
	s.StartResponse(options)
	s.AppendResponseText(text, options)
	s.CommitResponse()
}

func (s *ControlSession) SendClientEvent(event ClientEvent) {
	s.SendControl("client.event", map[string]interface{}{
		"event":   event.Event,
		"payload": event.Payload,
	})
}

func (s *ControlSession) addResponseGeneration(payload map[string]interface{}) {
	s.responseMu.Lock()
	defer s.responseMu.Unlock()
	if s.responseGenerationID != "" {
		payload["generation_id"] = s.responseGenerationID
	}
}

func responseOptionsPayload(options *ResponseOptions) map[string]interface{} {
	payload := map[string]interface{}{}
	if options != nil && options.AllowInterruptions != nil {
		payload["allow_interruptions"] = *options.AllowInterruptions
	}
	return payload
}

func eventSessionID(payload map[string]interface{}, fallback string) string {
	return stringValue(payload, "session_id", fallback)
}

func stringValue(payload map[string]interface{}, key string, fallback string) string {
	value, ok := payload[key]
	if !ok {
		return fallback
	}
	text, ok := value.(string)
	if !ok || text == "" {
		return fallback
	}
	return text
}

func numberValue(payload map[string]interface{}, key string) float64 {
	switch value := payload[key].(type) {
	case float64:
		return value
	case float32:
		return float64(value)
	case int:
		return float64(value)
	case int64:
		return float64(value)
	case int32:
		return float64(value)
	case uint:
		return float64(value)
	case uint64:
		return float64(value)
	case uint32:
		return float64(value)
	default:
		return 0
	}
}

func stringSliceValue(payload map[string]interface{}, key string) []string {
	value, ok := payload[key]
	if !ok {
		return nil
	}
	switch typed := value.(type) {
	case []string:
		return append([]string(nil), typed...)
	case []interface{}:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			text, ok := item.(string)
			if !ok {
				return nil
			}
			out = append(out, text)
		}
		return out
	default:
		return nil
	}
}

func mapValue(payload map[string]interface{}, key string) map[string]interface{} {
	value, ok := payload[key]
	if !ok {
		return nil
	}
	typed, ok := value.(map[string]interface{})
	if !ok {
		return nil
	}
	return typed
}
