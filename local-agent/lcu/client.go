package lcu

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"
)

// Client encapsulates communication with the local League Client Update (LCU) API
type Client struct {
	baseURL    string
	username   string
	password   string
	httpClient *http.Client
	info       *LockfileInfo
}

// SessionAction represents an action in champion select
type SessionAction struct {
	ID           int    `json:"id"`
	ActorCellID  int    `json:"actorCellId"`
	ChampionID   int    `json:"championId"`
	Type         string `json:"type"` // "pick", "ban", etc.
	Completed    bool   `json:"completed"`
	IsInProgress bool   `json:"isInProgress"`
}

// SessionResponse represents the /lol-champ-select/v1/session payload
type SessionResponse struct {
	LocalPlayerCellID int               `json:"localPlayerCellId"`
	Actions           [][]SessionAction `json:"actions"`
}

// RecommendedPerkPage represents a rune page recommendation from LCU
type RecommendedPerkPage struct {
	ID                 int    `json:"id"`
	Name               string `json:"name"`
	PrimaryStyleID     int    `json:"primaryStyleId"`
	SubStyleID         int    `json:"subStyleId"`
	SelectedPerkIDs    []int  `json:"selectedPerkIds"`
	Current            bool   `json:"current"`
	IsTemporary        bool   `json:"isTemporary"`
	PrimaryPosition    string `json:"primaryPosition"`
	RecommendationType string `json:"recommendationType"`
}

// GridRecommendation represents the items returned by grid-recommendations
type GridRecommendation struct {
	ChampionID        int                   `json:"championId"`
	Position          string                `json:"position"`
	RecommendedPerks  []RecommendedPerkPage `json:"recommendedPerkPages"`
	RecommendedSpells []struct {
		Spell1ID int `json:"spell1Id"`
		Spell2ID int `json:"spell2Id"`
	} `json:"recommendedSpells"`
}

// SummonerInfo represents the current summoner data
type SummonerInfo struct {
	AccountID     int64  `json:"accountId"`
	DisplayName   string `json:"displayName"`
	GameName      string `json:"gameName"`
	TagLine       string `json:"tagLine"`
	SummonerID    int64  `json:"summonerId"`
	SummonerLevel int    `json:"summonerLevel"`
}

// NewClient initializes an LCU client using parsed lockfile info
func NewClient(info *LockfileInfo) *Client {
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: true, // LCU uses self-signed SSL certificates
		},
	}

	return &Client{
		baseURL:    fmt.Sprintf("https://127.0.0.1:%d", info.Port),
		username:   "riot",
		password:   info.Password,
		info:       info,
		httpClient: &http.Client{Transport: transport, Timeout: 10 * time.Second},
	}
}

// request sends an authenticated HTTP request to the LCU API
func (c *Client) request(method, endpoint string, body any) ([]byte, int, error) {
	url := fmt.Sprintf("%s%s", c.baseURL, endpoint)

	var reqBody io.Reader
	if body != nil {
		jsonData, err := json.Marshal(body)
		if err != nil {
			return nil, 0, fmt.Errorf("error serializando body: %w", err)
		}
		reqBody = bytes.NewBuffer(jsonData)
	}

	req, err := http.NewRequest(method, url, reqBody)
	if err != nil {
		return nil, 0, fmt.Errorf("error creando request: %w", err)
	}

	req.SetBasicAuth(c.username, c.password)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("error de conexión con LCU API (%s): %w", endpoint, err)
	}
	defer resp.Body.Close()

	respBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, fmt.Errorf("error leyendo respuesta: %w", err)
	}

	return respBytes, resp.StatusCode, nil
}

// GetCurrentSummoner queries /lol-summoner/v1/current-summoner to verify LCU connection
func (c *Client) GetCurrentSummoner() (*SummonerInfo, error) {
	respBytes, status, err := c.request(http.MethodGet, "/lol-summoner/v1/current-summoner", nil)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("LCU retornó código %d: %s", status, string(respBytes))
	}

	var summoner SummonerInfo
	if err := json.Unmarshal(respBytes, &summoner); err != nil {
		return nil, fmt.Errorf("error deserializando summoner: %w", err)
	}
	return &summoner, nil
}

// AcceptMatch executes a POST to /lol-matchmaking/v1/ready-check/accept
func (c *Client) AcceptMatch() error {
	log.Println("[LCU] Enviando orden: ACEPTAR PARTIDA...")
	respBytes, status, err := c.request(http.MethodPost, "/lol-matchmaking/v1/ready-check/accept", nil)
	if err != nil {
		return fmt.Errorf("fallo al aceptar partida: %w", err)
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("LCU retornó código %d al aceptar partida: %s", status, string(respBytes))
	}
	log.Println("[LCU] ¡Partida aceptada con éxito!")
	return nil
}

// LockChampion coordinates picking the champion, completing the action, and applying recommended runes/spells
func (c *Client) LockChampion(championID int) error {
	log.Printf("[LCU] Iniciando fijación de campeón (championId: %d)...", championID)

	// 1. Obtener sesión de selección de campeones
	respBytes, status, err := c.request(http.MethodGet, "/lol-champ-select/v1/session", nil)
	if err != nil {
		return fmt.Errorf("error al obtener /lol-champ-select/v1/session: %w", err)
	}
	if status != http.StatusOK {
		return fmt.Errorf("no estás en selección de campeón o LCU respondió %d: %s", status, string(respBytes))
	}

	var session SessionResponse
	if err := json.Unmarshal(respBytes, &session); err != nil {
		return fmt.Errorf("error al parsear sesión: %w", err)
	}

	localCellID := session.LocalPlayerCellID
	log.Printf("[LCU] Sesión detectada. localPlayerCellId: %d", localCellID)

	// 2. Buscar la acción de tipo 'pick' que corresponda a nuestro cellId
	var targetActionID int = -1
	for _, actionGroup := range session.Actions {
		for _, action := range actionGroup {
			if action.ActorCellID == localCellID && action.Type == "pick" && !action.Completed {
				targetActionID = action.ID
				break
			}
		}
		if targetActionID != -1 {
			break
		}
	}

	if targetActionID == -1 {
		return errors.New("no se encontró una acción de selección ('pick') activa o pendiente para tu celda")
	}

	log.Printf("[LCU] Acción de pick encontrada (actionId: %d). Aplicando campeón...", targetActionID)

	// 3. PATCH /lol-champ-select/v1/session/actions/{actionId} con body {"championId": championId}
	patchURL := fmt.Sprintf("/lol-champ-select/v1/session/actions/%d", targetActionID)
	patchBody := map[string]any{"championId": championID}
	_, status, err = c.request(http.MethodPatch, patchURL, patchBody)
	if err != nil {
		return fmt.Errorf("error al seleccionar campeón en la acción: %w", err)
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("LCU retornó código %d al hacer PATCH de acción: %d", status, targetActionID)
	}

	// 4. POST /lol-champ-select/v1/session/actions/{actionId}/complete para fijar el pick
	completeURL := fmt.Sprintf("/lol-champ-select/v1/session/actions/%d/complete", targetActionID)
	_, status, err = c.request(http.MethodPost, completeURL, map[string]any{})
	if err != nil {
		log.Printf("[LCU] Advertencia al completar acción: %v", err)
	} else if status >= 200 && status < 300 {
		log.Printf("[LCU] Campeón (ID: %d) fijado ('locked in') exitosamente.", championID)
	}

	// 5. Consultar y aplicar runas y hechizos recomendados
	go c.applyRecommendedRunesAndSpells(championID)

	return nil
}

// applyRecommendedRunesAndSpells fetches recommendations and automatically sets runes & spells
func (c *Client) applyRecommendedRunesAndSpells(championID int) {
	// Dar un breve respiro para que el cliente actualice el estado
	time.Sleep(600 * time.Millisecond)
	log.Printf("[LCU] Buscando páginas de runas y hechizos recomendados para campeón %d...", championID)

	// Intento 1: /lol-perks/v1/recommended-pages
	recPagesURL := fmt.Sprintf("/lol-perks/v1/recommended-pages?championId=%d", championID)
	bytesResp, status, err := c.request(http.MethodGet, recPagesURL, nil)

	var runeApplied bool
	if err == nil && status == http.StatusOK {
		var pages []map[string]any
		if jsonErr := json.Unmarshal(bytesResp, &pages); jsonErr == nil && len(pages) > 0 {
			firstPage := pages[0]
			log.Printf("[LCU] Encontradas %d páginas de runas recomendadas. Aplicando la primera: %v", len(pages), firstPage["name"])

			// POST a /lol-perks/v1/currentpage
			_, postStatus, postErr := c.request(http.MethodPost, "/lol-perks/v1/currentpage", firstPage)
			if postErr == nil && (postStatus >= 200 && postStatus < 300) {
				log.Println("[LCU] ¡Runas recomendadas aplicadas con éxito vía /lol-perks/v1/currentpage!")
				runeApplied = true
			} else {
				// Intentar PUT o POST a /lol-perks/v1/pages
				c.request(http.MethodPut, "/lol-perks/v1/currentpage", firstPage)
			}
		}
	}

	// Intento 2: /lol-champ-select/v1/grid-recommendations
	gridURL := "/lol-champ-select/v1/grid-recommendations"
	gridBytes, gridStatus, gridErr := c.request(http.MethodGet, gridURL, nil)
	if gridErr == nil && gridStatus == http.StatusOK {
		var grid []GridRecommendation
		if err := json.Unmarshal(gridBytes, &grid); err == nil && len(grid) > 0 {
			firstRec := grid[0]
			// Si no se aplicaron runas antes, aplicarlas desde el grid
			if !runeApplied && len(firstRec.RecommendedPerks) > 0 {
				bestPerk := firstRec.RecommendedPerks[0]
				log.Printf("[LCU] Aplicando runa desde grid recommendation: %s", bestPerk.Name)
				c.request(http.MethodPost, "/lol-perks/v1/currentpage", bestPerk)
			}

			// Aplicar hechizos de invocador recomendados (spell1Id y spell2Id)
			if len(firstRec.RecommendedSpells) > 0 {
				spellChoice := firstRec.RecommendedSpells[0]
				log.Printf("[LCU] Aplicando hechizos recomendados: Spell1=%d, Spell2=%d", spellChoice.Spell1ID, spellChoice.Spell2ID)
				selectionBody := map[string]int{
					"spell1Id": spellChoice.Spell1ID,
					"spell2Id": spellChoice.Spell2ID,
				}
				c.request(http.MethodPatch, "/lol-champ-select/v1/session/my-selection", selectionBody)
			}
		}
	}

	// Consultar selección actual para verificar
	selBytes, _, _ := c.request(http.MethodGet, "/lol-champ-select/v1/session/my-selection", nil)
	log.Printf("[LCU] Estado final de selección del jugador: %s", string(selBytes))
}
