package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"lol-remote/local-agent/lcu"
	"lol-remote/local-agent/realtime"
)

// Simple .env loader
func loadEnv(filepath string) {
	file, err := os.Open(filepath)
	if err != nil {
		return
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) == 2 {
			key := strings.TrimSpace(parts[0])
			val := strings.TrimSpace(parts[1])
			val = strings.Trim(val, `"'`)
			if os.Getenv(key) == "" {
				os.Setenv(key, val)
			}
		}
	}
}

func main() {
	log.Println("==================================================")
	log.Println("          LoL Remote - Local Agent (Go)           ")
	log.Println("==================================================")

	// Load environment variables from .env if present
	loadEnv(".env")

	testMode := flag.Bool("test-lcu", false, "Verifica únicamente la conexión con la LCU API de League of Legends y sale")
	httpPort := flag.String("http", "8080", "Puerto para pruebas HTTP locales directas")
	flag.Parse()

	// 1. Intentar detectar y parsear lockfile
	var lcuClient *lcu.Client
	var mu sync.RWMutex

	getOrInitLCU := func() (*lcu.Client, error) {
		mu.Lock()
		defer mu.Unlock()
		if lcuClient != nil {
			return lcuClient, nil
		}

		info, err := lcu.GetLockfile(0) // No blocking wait
		if err != nil {
			return nil, err
		}
		log.Printf("[LCU] Lockfile encontrado en: %s", info.Path)
		log.Printf("[LCU] PID: %d, Puerto: %d, Protocolo: %s", info.PID, info.Port, info.Protocol)

		client := lcu.NewClient(info)
		summoner, err := client.GetCurrentSummoner()
		if err != nil {
			log.Printf("[LCU] Cliente detectado pero aún no está logueado o listo: %v", err)
		} else {
			displayName := summoner.GameName
			if displayName == "" {
				displayName = summoner.DisplayName
			}
			log.Printf("[LCU] ¡Conexión exitosa! Invocador: %s#%s (Nivel: %d)", displayName, summoner.TagLine, summoner.SummonerLevel)
		}

		lcuClient = client
		return lcuClient, nil
	}

	// Primer intento de conexión al iniciar
	if client, err := getOrInitLCU(); err == nil && client != nil {
		log.Println("[LCU] Agente vinculado al cliente de League of Legends.")
	} else {
		log.Println("[LCU] El cliente de LoL no parece estar abierto en este momento.")
		log.Println("[LCU] El agente buscará el lockfile automáticamente cuando reciba comandos.")
	}

	if *testMode {
		log.Println("[LCU Test] Modo test finalizado.")
		return
	}

	// 2. Servidor local auxiliar para pruebas rápidas sin Supabase
	go func() {
		mux := http.NewServeMux()
		mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"status":"ok"}`))
		})
		mux.HandleFunc("/test/accept", func(w http.ResponseWriter, r *http.Request) {
			client, err := getOrInitLCU()
			if err != nil {
				http.Error(w, fmt.Sprintf("Error obteniendo LCU: %v", err), http.StatusInternalServerError)
				return
			}
			if err := client.AcceptMatch(); err != nil {
				http.Error(w, fmt.Sprintf("Error aceptando: %v", err), http.StatusInternalServerError)
				return
			}
			w.Write([]byte(`{"status":"match_accepted"}`))
		})
		mux.HandleFunc("/test/lock", func(w http.ResponseWriter, r *http.Request) {
			champIDStr := r.URL.Query().Get("championId")
			if champIDStr == "" {
				http.Error(w, "championId requerido en query params", http.StatusBadRequest)
				return
			}
			var champID int
			fmt.Sscanf(champIDStr, "%d", &champID)

			client, err := getOrInitLCU()
			if err != nil {
				http.Error(w, fmt.Sprintf("Error obteniendo LCU: %v", err), http.StatusInternalServerError)
				return
			}
			if err := client.LockChampion(champID); err != nil {
				http.Error(w, fmt.Sprintf("Error fijando campeón: %v", err), http.StatusInternalServerError)
				return
			}
			w.Write([]byte(fmt.Sprintf(`{"status":"champion_locked", "championId": %d}`, champID)))
		})

		addr := fmt.Sprintf("127.0.0.1:%s", *httpPort)
		log.Printf("[Local Server] Servidor local de pruebas activo en http://%s", addr)
		if err := http.ListenAndServe(addr, mux); err != nil {
			log.Printf("[Local Server] Error: %v", err)
		}
	}()

	// 3. Configurar conexión con Supabase Realtime
	supabaseURL := os.Getenv("SUPABASE_URL")
	supabaseAnonKey := os.Getenv("SUPABASE_ANON_KEY")
	if supabaseAnonKey == "" {
		supabaseAnonKey = os.Getenv("SUPABASE_PUBLISHABLE_KEY")
	}
	supabaseChannel := os.Getenv("SUPABASE_CHANNEL")
	if supabaseChannel == "" {
		supabaseChannel = "lol-commands"
	}

	if supabaseURL == "" || supabaseAnonKey == "" {
		log.Println("------------------------------------------------------------------")
		log.Println("[ATENCIÓN] SUPABASE_URL o SUPABASE_ANON_KEY no están configuradas.")
		log.Println("Por favor configura el archivo .env en local-agent con tus credenciales.")
		log.Println("Ejemplo:")
		log.Println("  SUPABASE_URL=https://xyzcompany.supabase.co")
		log.Println("  SUPABASE_ANON_KEY=eyJh...")
		log.Println("  SUPABASE_CHANNEL=lol-commands")
		log.Println("------------------------------------------------------------------")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Handler para eventos provenientes de Supabase Realtime
	commandHandler := func(cmd realtime.CommandPayload) {
		log.Printf(">>> PROCESANDO COMANDO REMOTO: %s", cmd.Event)

		client, err := getOrInitLCU()
		if err != nil {
			log.Printf("[ERROR] No se pudo conectar a la LCU API de LoL: %v", err)
			return
		}

		switch cmd.Event {
		case "ACCEPT_MATCH":
			if err := client.AcceptMatch(); err != nil {
				log.Printf("[ERROR] Fallo al procesar ACCEPT_MATCH: %v", err)
			} else {
				log.Println("[ÉXITO] ¡Comando ACCEPT_MATCH ejecutado satisfactoriamente!")
			}

		case "LOCK_CHAMPION":
			if cmd.ChampionID <= 0 {
				log.Printf("[ERROR] LOCK_CHAMPION recibido pero championId no es válido: %d", cmd.ChampionID)
				return
			}
			log.Printf("[PROCESO] Fijando campeón con ID: %d...", cmd.ChampionID)
			if err := client.LockChampion(cmd.ChampionID); err != nil {
				log.Printf("[ERROR] Fallo al fijar campeón: %v", err)
			} else {
				log.Printf("[ÉXITO] Campeón %d seleccionado y runas/hechizos recomendados aplicados.", cmd.ChampionID)
			}

		default:
			log.Printf("[ADVERTENCIA] Evento desconocido recibido: %s", cmd.Event)
		}
	}

	// Si las credenciales de Supabase están disponibles, iniciamos el subscriber
	if supabaseURL != "" && supabaseAnonKey != "" {
		sub := realtime.NewSupabaseClient(supabaseURL, supabaseAnonKey, supabaseChannel, commandHandler)
		go func() {
			if err := sub.Start(ctx); err != nil && err != context.Canceled {
				log.Printf("[Supabase Realtime] Conexión terminada: %v", err)
			}
		}()
	} else {
		log.Println("[Supabase Realtime] Esperando configuración de .env para suscribirse a 'lol-commands'.")
	}

	// Manejo de señales para apagado limpio (Ctrl+C)
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	<-sigChan

	log.Println("\n[LoL Remote] Apagando el Agente Local...")
	cancel()
	time.Sleep(500 * time.Millisecond)
	log.Println("[LoL Remote] Finalizado.")
}
