package realtime

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// PhoenixMessage represents the standard frame format for Phoenix / Supabase Realtime Channels
type PhoenixMessage struct {
	Topic   string         `json:"topic"`
	Event   string         `json:"event"`
	Payload map[string]any `json:"payload"`
	Ref     *string        `json:"ref"`
}

// CommandPayload holds data parsed from a broadcast event
type CommandPayload struct {
	Event      string
	ChampionID int
	RawPayload map[string]any
}

// HandlerFunc is called whenever a command event arrives on the subscribed channel
type HandlerFunc func(cmd CommandPayload)

// SupabaseClient manages the Realtime WebSocket connection to Supabase
type SupabaseClient struct {
	supabaseURL string
	anonKey     string
	channelName string
	handler     HandlerFunc
	conn        *websocket.Conn
	mu          sync.Mutex
	refCounter  uint64
	done        chan struct{}
}

// NewSupabaseClient creates a new Realtime subscriber
func NewSupabaseClient(supabaseURL, anonKey, channelName string, handler HandlerFunc) *SupabaseClient {
	return &SupabaseClient{
		supabaseURL: strings.TrimRight(supabaseURL, "/"),
		anonKey:     anonKey,
		channelName: channelName,
		handler:     handler,
		done:        make(chan struct{}),
	}
}

// NextRef generates an incremental reference string for Phoenix frames
func (s *SupabaseClient) NextRef() string {
	n := atomic.AddUint64(&s.refCounter, 1)
	return fmt.Sprintf("%d", n)
}

// Connect establishes the WebSocket connection and continuously listens with auto-reconnect
func (s *SupabaseClient) Start(ctx context.Context) error {
	// Parse project URL to get hostname
	u, err := url.Parse(s.supabaseURL)
	if err != nil {
		return fmt.Errorf("URL de Supabase inválida: %w", err)
	}

	wsScheme := "wss"
	if u.Scheme == "http" {
		wsScheme = "ws"
	}

	// Supabase realtime endpoint
	wsURL := fmt.Sprintf("%s://%s/realtime/v1/websocket?apikey=%s&vsn=1.0.0", wsScheme, u.Host, s.anonKey)

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		log.Printf("[Supabase Realtime] Conectando a %s://%s/realtime/v1/websocket...", wsScheme, u.Host)
		reqHeaders := make(map[string][]string)
		reqHeaders["apikey"] = []string{s.anonKey}
		reqHeaders["Authorization"] = []string{"Bearer " + s.anonKey}

		conn, _, err := websocket.DefaultDialer.DialContext(ctx, wsURL, reqHeaders)
		if err != nil {
			log.Printf("[Supabase Realtime] Error al conectar: %v. Reintentando en 3s...", err)
			time.Sleep(3 * time.Second)
			continue
		}

		s.mu.Lock()
		s.conn = conn
		s.mu.Unlock()

		log.Println("[Supabase Realtime] Conexión WebSocket establecida.")

		// Join the channel
		topic := fmt.Sprintf("realtime:%s", s.channelName)
		joinRef := s.NextRef()
		joinMsg := PhoenixMessage{
			Topic: topic,
			Event: "phx_join",
			Payload: map[string]any{
				"config": map[string]any{
					"broadcast": map[string]any{
						"self": true,
						"ack":  true,
					},
				},
				"access_token": s.anonKey,
			},
			Ref: &joinRef,
		}

		if err := conn.WriteJSON(joinMsg); err != nil {
			log.Printf("[Supabase Realtime] Error al unirse al canal %s: %v", s.channelName, err)
			conn.Close()
			time.Sleep(2 * time.Second)
			continue
		}
		log.Printf("[Supabase Realtime] Suscrito exitosamente al canal '%s' (esperando broadcast...)", s.channelName)

		// Start heartbeat routine
		stopHeartbeat := make(chan struct{})
		go s.heartbeatLoop(conn, stopHeartbeat)

		// Read loop
		s.readLoop(conn, topic)

		close(stopHeartbeat)
		conn.Close()
		log.Println("[Supabase Realtime] Conexión cerrada. Reconectando en 2 segundos...")
		time.Sleep(2 * time.Second)
	}
}

func (s *SupabaseClient) heartbeatLoop(conn *websocket.Conn, stop <-chan struct{}) {
	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			ref := s.NextRef()
			hb := PhoenixMessage{
				Topic:   "phoenix",
				Event:   "heartbeat",
				Payload: map[string]any{},
				Ref:     &ref,
			}
			s.mu.Lock()
			err := conn.WriteJSON(hb)
			s.mu.Unlock()
			if err != nil {
				return
			}
		case <-stop:
			return
		}
	}
}

func (s *SupabaseClient) readLoop(conn *websocket.Conn, targetTopic string) {
	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			log.Printf("[Supabase Realtime] Lectura interrumpida: %v", err)
			return
		}

		var msg PhoenixMessage
		if err := json.Unmarshal(message, &msg); err != nil {
			continue
		}

		// Check for broadcast events on our topic
		if msg.Topic == targetTopic && (msg.Event == "broadcast" || msg.Event == "ACCEPT_MATCH" || msg.Event == "LOCK_CHAMPION") {
			s.dispatch(msg)
		}
	}
}

func (s *SupabaseClient) dispatch(msg PhoenixMessage) {
	var eventName string
	var payloadData map[string]any

	if msg.Event == "broadcast" {
		// Supabase broadcast wraps payload as { "event": "...", "payload": { ... } }
		if subEvent, ok := msg.Payload["event"].(string); ok {
			eventName = subEvent
		}
		if raw, ok := msg.Payload["payload"].(map[string]any); ok {
			payloadData = raw
		} else {
			payloadData = msg.Payload
		}
	} else {
		eventName = msg.Event
		payloadData = msg.Payload
	}

	cmd := CommandPayload{
		Event:      eventName,
		RawPayload: payloadData,
	}

	// Extract championId if present
	if champVal, exists := payloadData["championId"]; exists {
		switch v := champVal.(type) {
		case float64:
			cmd.ChampionID = int(v)
		case int:
			cmd.ChampionID = v
		}
	}

	log.Printf("[Supabase Realtime] COMANDO RECIBIDO -> Evento: '%s' | Data: %+v", cmd.Event, cmd.RawPayload)

	if s.handler != nil {
		s.handler(cmd)
	}
}
