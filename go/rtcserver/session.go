package rtcserver

import (
	"context"
	"fmt"
	"time"
)

type ControlSession struct {
	channel     socketChannel
	sessionID   string
	channelName string
	joinTimeout time.Duration
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
			select {
			case done <- fmt.Errorf("RTC channel closed during join: %s", s.channelName):
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
		handler(WireEvent{Type: event, Data: payload})
	})
}

func (s *ControlSession) On(eventName string, handler func(map[string]interface{})) func() {
	return s.channel.OnMessage(func(event string, payload map[string]interface{}) {
		if event == eventName {
			handler(payload)
		}
	})
}

func (s *ControlSession) SendControl(event string, payload map[string]interface{}) {
	if payload == nil {
		payload = map[string]interface{}{}
	}
	s.channel.SendMessage(event, payload)
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
	s.SendControl("response.start", responseOptionsPayload(options))
}

func (s *ControlSession) AppendResponseText(delta string, options *ResponseOptions) {
	payload := responseOptionsPayload(options)
	payload["delta"] = delta
	s.SendControl("response.delta", payload)
}

func (s *ControlSession) CommitResponse() {
	s.SendControl("response.commit", nil)
}

func (s *ControlSession) CancelResponse() {
	s.SendControl("response.cancel", nil)
}

func (s *ControlSession) ReplaceResponseText(text string, options *ResponseOptions) {
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

func responseOptionsPayload(options *ResponseOptions) map[string]interface{} {
	payload := map[string]interface{}{}
	if options != nil && options.AllowInterruptions != nil {
		payload["allow_interruptions"] = *options.AllowInterruptions
	}
	return payload
}
