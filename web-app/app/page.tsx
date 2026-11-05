'use client';

import { useState, useEffect, useRef } from 'react';
import { getSupabase } from '@/lib/supabase';
import { RealtimeChannel } from '@supabase/supabase-js';

interface Champion {
  id: string;
  key: number;
  name: string;
  title: string;
  iconUrl: string;
}

interface SummonerInfo {
  displayName?: string;
  gameName?: string;
  tagLine?: string;
  summonerLevel?: number;
}

interface ReadyCheckInfo {
  state?: string;
  playerResponse?: string; // "None" | "Accepted" | "Declined"
  timer?: number;
}

interface ChampSelectInfo {
  localPlayerCellId?: number;
  isMyTurn?: boolean;
  hasSession?: boolean;
}

interface GameState {
  online: boolean;
  lolRunning: boolean;
  summoner?: SummonerInfo | null;
  phase: string;
  readyCheck?: ReadyCheckInfo | null;
  champSelect?: ChampSelectInfo | null;
  timestamp: number;
}

const FALLBACK_CHAMPIONS: Champion[] = [
  { id: 'Aatrox', key: 266, name: 'Aatrox', title: 'la Espada de los Oscuros', iconUrl: 'https://ddragon.leagueoflegends.com/cdn/14.23.1/img/champion/Aatrox.png' },
  { id: 'Ahri', key: 103, name: 'Ahri', title: 'la Mujer Zorro de Nueve Colas', iconUrl: 'https://ddragon.leagueoflegends.com/cdn/14.23.1/img/champion/Ahri.png' },
  { id: 'Jinx', key: 222, name: 'Jinx', title: 'la Bala Perdida', iconUrl: 'https://ddragon.leagueoflegends.com/cdn/14.23.1/img/champion/Jinx.png' },
  { id: 'LeeSin', key: 64, name: 'Lee Sin', title: 'el Monje Ciego', iconUrl: 'https://ddragon.leagueoflegends.com/cdn/14.23.1/img/champion/LeeSin.png' },
  { id: 'Lux', key: 99, name: 'Lux', title: 'la Dama Luminosa', iconUrl: 'https://ddragon.leagueoflegends.com/cdn/14.23.1/img/champion/Lux.png' },
  { id: 'Thresh', key: 412, name: 'Thresh', title: 'el Carcelero de las Cadenas', iconUrl: 'https://ddragon.leagueoflegends.com/cdn/14.23.1/img/champion/Thresh.png' },
  { id: 'Yasuo', key: 157, name: 'Yasuo', title: 'el Imperdonable', iconUrl: 'https://ddragon.leagueoflegends.com/cdn/14.23.1/img/champion/Yasuo.png' },
  { id: 'Yone', key: 777, name: 'Yone', title: 'el Inolvidado', iconUrl: 'https://ddragon.leagueoflegends.com/cdn/14.23.1/img/champion/Yone.png' },
  { id: 'Zed', key: 238, name: 'Zed', title: 'el Maestro de las Sombras', iconUrl: 'https://ddragon.leagueoflegends.com/cdn/14.23.1/img/champion/Zed.png' },
];

export default function HomePage() {
  const [champions, setChampions] = useState<Champion[]>(FALLBACK_CHAMPIONS);
  const [selectedChampionId, setSelectedChampionId] = useState<number>(FALLBACK_CHAMPIONS[0].key);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusBanner, setStatusBanner] = useState<{ text: string; type: 'info' | 'success' | 'error' | 'warning' } | null>(null);
  const [channelStatus, setChannelStatus] = useState<'DISCONNECTED' | 'CONNECTING' | 'CONNECTED'>('CONNECTING');
  const [gameState, setGameState] = useState<GameState>({
    online: false,
    lolRunning: false,
    phase: 'None',
    timestamp: 0,
  });
  const [isAccepting, setIsAccepting] = useState(false);
  const [isLocking, setIsLocking] = useState(false);

  const channelRef = useRef<RealtimeChannel | null>(null);
  const lastStateTime = useRef<number>(0);
  const prevPhase = useRef<string>('None');

  // 1. Fetch complete champions list from Riot Data Dragon
  useEffect(() => {
    async function loadChampions() {
      try {
        const verRes = await fetch('https://ddragon.leagueoflegends.com/api/versions.json');
        const versions = await verRes.json();
        const latestVer = versions[0] || '14.23.1';

        const champRes = await fetch(`https://ddragon.leagueoflegends.com/cdn/${latestVer}/data/es_ES/champion.json`);
        const champData = await champRes.json();

        const list: Champion[] = Object.values(champData.data).map((c: any) => ({
          id: c.id,
          key: Number(c.key),
          name: c.name,
          title: c.title,
          iconUrl: `https://ddragon.leagueoflegends.com/cdn/${latestVer}/img/champion/${c.image.full}`,
        }));

        list.sort((a, b) => a.name.localeCompare(b.name));
        setChampions(list);
        if (list.length > 0) {
          setSelectedChampionId(Number(list[0].key));
        }
      } catch (err) {
        console.warn('Error fetching Data Dragon champions, using fallback:', err);
      }
    }
    loadChampions();
  }, []);

  // 2. Connect to Supabase Realtime
  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) {
      setChannelStatus('DISCONNECTED');
      setStatusBanner({
        text: 'Configura las variables de Supabase en .env.local o en Vercel',
        type: 'warning',
      });
      return;
    }

    const channelName = process.env.NEXT_PUBLIC_SUPABASE_CHANNEL || 'lol-commands';
    const channel = supabase.channel(channelName, {
      config: {
        broadcast: { ack: true, self: true },
      },
    });

    channel.on('broadcast', { event: 'GAME_STATE' }, (payload: any) => {
      const state: GameState = payload.payload || payload;
      lastStateTime.current = Date.now();
      setGameState(state);

      if (state.phase === 'ReadyCheck' && prevPhase.current !== 'ReadyCheck') {
        if (typeof window !== 'undefined' && 'vibrate' in navigator) {
          try {
            navigator.vibrate([400, 200, 400]);
          } catch {}
        }
      }
      prevPhase.current = state.phase;
    });

    channel.on('broadcast', { event: 'ACTION_RESULT' }, (payload: any) => {
      const res = payload.payload || payload;
      setStatusBanner({
        text: res.message || (res.success ? 'Acción completada con éxito' : 'No se pudo completar la acción'),
        type: res.success ? 'success' : 'error',
      });
    });

    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        setChannelStatus('CONNECTED');
        channel.send({
          type: 'broadcast',
          event: 'PING_STATE',
          payload: { req: Date.now() },
        });
      } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
        setChannelStatus('DISCONNECTED');
      } else {
        setChannelStatus('CONNECTING');
      }
    });

    channelRef.current = channel;

    const watchdog = setInterval(() => {
      if (Date.now() - lastStateTime.current > 4000) {
        setGameState((prev) => (prev.online ? { ...prev, online: false } : prev));
      }
    }, 2000);

    return () => {
      clearInterval(watchdog);
      supabase.removeChannel(channel);
    };
  }, []);

  // Filter champions based on query
  const filteredChampions = champions.filter((c) =>
    c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    c.id.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Manejo de búsqueda y auto-selección de coincidencia
  const handleSearchChange = (query: string) => {
    setSearchQuery(query);
    const matches = champions.filter((c) =>
      c.name.toLowerCase().includes(query.toLowerCase()) ||
      c.id.toLowerCase().includes(query.toLowerCase())
    );
    if (matches.length > 0) {
      setSelectedChampionId(matches[0].key);
    }
  };

  // Selección directa de campeón
  const handleSelectChampion = (champion: Champion) => {
    setSelectedChampionId(champion.key);
  };

  // Campeón actualmente seleccionado con fallback seguro
  const selectedChamp =
    champions.find((c) => Number(c.key) === Number(selectedChampionId)) ||
    champions[0] ||
    FALLBACK_CHAMPIONS[0];

  // Enviar orden de Aceptar Partida
  const handleAcceptMatch = async () => {
    if (!channelRef.current || channelStatus !== 'CONNECTED') {
      setStatusBanner({ text: 'Sin conexión a Supabase Realtime', type: 'error' });
      return;
    }
    if (!gameState.online) {
      setStatusBanner({ text: 'El Agente Local en tu PC no está ejecutándose', type: 'error' });
      return;
    }

    setIsAccepting(true);
    setStatusBanner({ text: 'Enviando orden a la PC...', type: 'info' });

    try {
      await channelRef.current.send({
        type: 'broadcast',
        event: 'ACCEPT_MATCH',
        payload: { timestamp: Date.now() },
      });
    } catch (err: any) {
      setStatusBanner({ text: `Error: ${err?.message || err}`, type: 'error' });
    } finally {
      setTimeout(() => setIsAccepting(false), 600);
    }
  };

  // Enviar orden de Fijar Campeón
  const handleLockChampion = async () => {
    if (!selectedChamp) return;

    if (!channelRef.current || channelStatus !== 'CONNECTED') {
      setStatusBanner({ text: 'Sin conexión a Supabase Realtime', type: 'error' });
      return;
    }
    if (!gameState.online) {
      setStatusBanner({ text: 'El Agente Local en tu PC no está ejecutándose', type: 'error' });
      return;
    }

    setIsLocking(true);
    setStatusBanner({ text: `Enviando selección de ${selectedChamp.name} a la PC...`, type: 'info' });

    try {
      await channelRef.current.send({
        type: 'broadcast',
        event: 'LOCK_CHAMPION',
        payload: {
          championId: selectedChamp.key,
          championName: selectedChamp.name,
          timestamp: Date.now(),
        },
      });
    } catch (err: any) {
      setStatusBanner({ text: `Error: ${err?.message || err}`, type: 'error' });
    } finally {
      setTimeout(() => setIsLocking(false), 800);
    }
  };

  const isReadyCheck = gameState.phase === 'ReadyCheck';
  const hasAccepted = gameState.readyCheck?.playerResponse === 'Accepted';
  const isChampSelect = gameState.phase === 'ChampSelect';
  const isMatchmaking = gameState.phase === 'Matchmaking';

  const getPhaseDisplay = () => {
    if (!gameState.online) return 'PC Desconectada';
    if (!gameState.lolRunning) return 'LoL Cerrado';
    switch (gameState.phase) {
      case 'None':
        return 'En Menú Principal';
      case 'Lobby':
        return 'En Sala / Lobby';
      case 'Matchmaking':
        return 'Buscando Partida...';
      case 'ReadyCheck':
        return '¡PARTIDA ENCONTRADA!';
      case 'ChampSelect':
        return 'En Selección de Campeón';
      case 'InProgress':
        return 'En Partida';
      case 'WaitingForStats':
      case 'EndOfGame':
        return 'Fin de Partida';
      default:
        return gameState.phase;
    }
  };

  return (
    <main style={{
      width: '100%',
      maxWidth: '480px',
      padding: '18px 16px 40px',
      display: 'flex',
      flexDirection: 'column',
      gap: '18px',
    }}>
      {/* Header */}
      <header style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingBottom: '12px',
        borderBottom: '1px solid var(--border-gold)',
      }}>
        <div>
          <h1 style={{
            fontSize: '1.35rem',
            fontWeight: 800,
            letterSpacing: '1px',
            color: 'var(--hextech-gold)',
            textTransform: 'uppercase',
          }}>
            LoL Remote
          </h1>
          <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
            {gameState.summoner?.displayName
              ? `${gameState.summoner.displayName}#${gameState.summoner.tagLine || 'LAS'} (Lv ${gameState.summoner.summonerLevel})`
              : 'Control Móvil Remoto'}
          </p>
        </div>

        {/* Status Pill */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '4px 10px',
          borderRadius: '999px',
          fontSize: '0.68rem',
          fontWeight: 700,
          backgroundColor:
            gameState.online
              ? 'rgba(37, 187, 132, 0.2)'
              : 'rgba(232, 64, 87, 0.2)',
          color:
            gameState.online
              ? 'var(--riot-green)'
              : 'var(--riot-red)',
          border: `1px solid ${gameState.online ? 'var(--riot-green)' : 'var(--riot-red)'}`,
        }}>
          <span style={{
            width: '7px',
            height: '7px',
            borderRadius: '50%',
            backgroundColor: gameState.online ? 'var(--riot-green)' : 'var(--riot-red)',
          }} />
          {gameState.online ? 'PC CONECTADA' : 'PC OFFLINE'}
        </div>
      </header>

      {/* Banner de Aviso si el PC no está conectado */}
      {!gameState.online && (
        <div style={{
          padding: '12px 14px',
          borderRadius: '10px',
          backgroundColor: 'rgba(232, 64, 87, 0.15)',
          border: '1px solid var(--riot-red)',
          fontSize: '0.8rem',
          color: '#f8d7da',
          lineHeight: '1.4',
        }}>
          ⚠️ <strong>Agente Local no detectado en tu PC:</strong> Asegúrate de ejecutar <code>LoL-Remote.bat</code> en tu escritorio con League of Legends abierto.
        </div>
      )}

      {/* Banner de Notificaciones / Feedback */}
      {statusBanner && (
        <div style={{
          padding: '10px 14px',
          borderRadius: '8px',
          fontSize: '0.82rem',
          lineHeight: '1.3',
          border: '1px solid',
          borderColor:
            statusBanner.type === 'success'
              ? 'var(--riot-green)'
              : statusBanner.type === 'error'
              ? 'var(--riot-red)'
              : statusBanner.type === 'warning'
              ? 'var(--hextech-gold)'
              : 'var(--hextech-blue)',
          backgroundColor:
            statusBanner.type === 'success'
              ? 'rgba(37, 187, 132, 0.18)'
              : statusBanner.type === 'error'
              ? 'rgba(232, 64, 87, 0.18)'
              : statusBanner.type === 'warning'
              ? 'rgba(200, 170, 110, 0.18)'
              : 'rgba(10, 200, 185, 0.18)',
          color: 'var(--hextech-gold-bright)',
        }}>
          {statusBanner.text}
        </div>
      )}

      {/* SECCIÓN 1: READY CHECK / ESTADO ACTUAL */}
      <section style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '22px 16px',
        background: 'var(--bg-card)',
        borderRadius: '16px',
        border: `1px solid ${isReadyCheck ? 'var(--hextech-blue)' : 'var(--border-gold)'}`,
        boxShadow: isReadyCheck
          ? '0 0 30px var(--hextech-blue-glow)'
          : '0 8px 32px rgba(0, 0, 0, 0.4)',
        transition: 'all 0.3s ease',
      }}>
        {isReadyCheck ? (
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <span style={{
              fontSize: '0.8rem',
              letterSpacing: '2px',
              textTransform: 'uppercase',
              color: 'var(--riot-green)',
              marginBottom: '14px',
              fontWeight: 800,
            }}>
              🚨 ¡PARTIDA ENCONTRADA! 🚨
            </span>

            {hasAccepted ? (
              <div style={{
                width: '100%',
                padding: '24px 16px',
                borderRadius: '12px',
                backgroundColor: 'rgba(37, 187, 132, 0.25)',
                border: '2px solid var(--riot-green)',
                textAlign: 'center',
                color: 'var(--riot-green)',
                fontWeight: 800,
                fontSize: '1.1rem',
                letterSpacing: '1px',
              }}>
                ✓ ¡PARTIDA YA ACEPTADA!
                <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', marginTop: '6px' }}>
                  Esperando que los demás jugadores acepten...
                </div>
              </div>
            ) : (
              <button
                onClick={handleAcceptMatch}
                disabled={isAccepting}
                className="ready-check-pulse"
                style={{
                  width: '100%',
                  height: '115px',
                  borderRadius: '12px',
                  background: 'linear-gradient(135deg, #1e3a5f 0%, #0ac8b9 50%, #25bb84 100%)',
                  border: '2px solid #ffffff',
                  color: '#ffffff',
                  fontSize: '1.4rem',
                  fontWeight: 900,
                  letterSpacing: '2px',
                  textTransform: 'uppercase',
                  textShadow: '0 2px 8px rgba(0, 0, 0, 0.7)',
                  boxShadow: '0 4px 24px var(--hextech-blue-glow)',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px',
                  transform: isAccepting ? 'scale(0.97)' : 'scale(1)',
                  transition: 'transform 0.15s ease',
                }}
              >
                <span>{isAccepting ? '¡ACEPTANDO!' : '¡ACEPTAR PARTIDA!'}</span>
                <span style={{ fontSize: '0.75rem', fontWeight: 700, letterSpacing: '1px', opacity: 0.95 }}>
                  TOCA AQUÍ PARA ACEPTAR
                </span>
              </button>
            )}
          </div>
        ) : (
          <div style={{ width: '100%', textAlign: 'center', padding: '10px 0' }}>
            <span style={{
              fontSize: '0.72rem',
              letterSpacing: '2px',
              textTransform: 'uppercase',
              color: 'var(--hextech-gold)',
              fontWeight: 700,
            }}>
              Estado en Vivo del Juego
            </span>

            <div style={{
              marginTop: '12px',
              padding: '16px',
              borderRadius: '10px',
              backgroundColor: 'rgba(9, 20, 40, 0.8)',
              border: '1px solid rgba(200, 170, 110, 0.25)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '6px',
            }}>
              <div style={{ fontSize: '1.15rem', fontWeight: 800, color: 'var(--hextech-gold-bright)' }}>
                {isMatchmaking && '⏳ '}
                {getPhaseDisplay()}
              </div>

              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                {isMatchmaking
                  ? 'Buscando partida en cola... El botón de aceptar vibrará y aparecerá automáticamente apenas salte la partida.'
                  : isChampSelect
                  ? 'Estás en selección de campeón. Puedes fijar tu pick y runas abajo.'
                  : gameState.online
                  ? 'Esperando que entres en cola de emparejamiento...'
                  : 'Inicia el archivo LoL-Remote.bat en tu PC para sincronizar.'}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* SECCIÓN 2: SELECTOR DE CAMPEÓN */}
      <section style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        padding: '20px 16px',
        background: 'var(--bg-card)',
        borderRadius: '16px',
        border: `1px solid ${isChampSelect ? 'var(--hextech-gold)' : 'var(--border-gold)'}`,
        boxShadow: isChampSelect
          ? '0 0 25px rgba(200, 170, 110, 0.3)'
          : '0 8px 32px rgba(0, 0, 0, 0.4)',
      }}>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
        }}>
          <span style={{
            fontSize: '0.75rem',
            letterSpacing: '2px',
            textTransform: 'uppercase',
            color: 'var(--hextech-gold)',
            fontWeight: 700,
          }}>
            Selección de Campeón
          </span>
          {isChampSelect && (
            <span style={{
              fontSize: '0.7rem',
              fontWeight: 800,
              color: gameState.champSelect?.isMyTurn ? 'var(--riot-green)' : 'var(--hextech-gold)',
            }}>
              {gameState.champSelect?.isMyTurn ? '● ¡ES TU TURNO DE PICK!' : '● EN SELECCIÓN'}
            </span>
          )}
        </div>

        {/* Tarjeta Destacada del Campeón Seleccionado */}
        {selectedChamp && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '14px',
            padding: '14px',
            backgroundColor: 'rgba(9, 20, 40, 0.95)',
            borderRadius: '12px',
            border: '2px solid var(--hextech-gold)',
            boxShadow: '0 4px 16px rgba(200, 170, 110, 0.25)',
          }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={`avatar-${selectedChamp.key}`}
              src={selectedChamp.iconUrl}
              alt={selectedChamp.name}
              style={{
                width: '64px',
                height: '64px',
                borderRadius: '10px',
                border: '2px solid var(--hextech-gold-bright)',
                objectFit: 'cover',
                boxShadow: '0 0 10px rgba(200, 170, 110, 0.4)',
              }}
            />
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
              <span style={{ fontSize: '1.25rem', fontWeight: 900, color: 'var(--hextech-gold-bright)', letterSpacing: '0.5px' }}>
                {selectedChamp.name}
              </span>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'capitalize' }}>
                {selectedChamp.title}
              </span>
              <span style={{ fontSize: '0.68rem', color: 'var(--hextech-blue)', marginTop: '3px', fontWeight: 600 }}>
                LCU ID: {selectedChamp.key}
              </span>
            </div>
          </div>
        )}

        {/* Buscador de Campeón con botón de limpiar */}
        <div style={{ position: 'relative', width: '100%' }}>
          <input
            type="text"
            placeholder="Buscar por nombre (ej: Yasuo, Ahri)..."
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            style={{
              width: '100%',
              padding: '11px 36px 11px 14px',
              backgroundColor: 'rgba(9, 20, 40, 0.9)',
              border: '1px solid var(--border-gold)',
              borderRadius: '8px',
              color: 'var(--text-main)',
              fontSize: '0.9rem',
            }}
          />
          {searchQuery && (
            <button
              onClick={() => handleSearchChange('')}
              style={{
                position: 'absolute',
                right: '10px',
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'transparent',
                color: 'var(--text-muted)',
                fontSize: '1rem',
                padding: '4px 8px',
                cursor: 'pointer',
              }}
            >
              ✕
            </button>
          )}
        </div>

        {/* Selector Desplegable Sincronizado */}
        <select
          value={selectedChamp.key}
          onChange={(e) => {
            const chosenKey = Number(e.target.value);
            const found = champions.find((c) => Number(c.key) === chosenKey);
            if (found) handleSelectChampion(found);
          }}
          style={{
            width: '100%',
            padding: '12px 14px',
            backgroundColor: 'rgba(9, 20, 40, 0.9)',
            border: '1px solid var(--border-gold)',
            borderRadius: '8px',
            color: 'var(--text-main)',
            fontSize: '0.95rem',
            fontWeight: 600,
          }}
        >
          {champions.map((c) => (
            <option key={c.key} value={c.key} style={{ background: '#091428', color: '#f0e6d2' }}>
              {c.name} - {c.title}
            </option>
          ))}
        </select>

        {/* Galería Visual Táctil de Campeones (Estilo Cliente LoL) */}
        <div>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '8px', display: 'block' }}>
            Toca cualquier campeón para seleccionarlo:
          </span>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(5, 1fr)',
            gap: '8px',
            maxHeight: '190px',
            overflowY: 'auto',
            padding: '6px',
            backgroundColor: 'rgba(5, 12, 24, 0.8)',
            borderRadius: '10px',
            border: '1px solid rgba(200, 170, 110, 0.2)',
          }}>
            {filteredChampions.slice(0, 30).map((c) => {
              const isSelected = Number(c.key) === Number(selectedChamp.key);
              return (
                <div
                  key={`thumb-${c.key}`}
                  onClick={() => handleSelectChampion(c)}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    cursor: 'pointer',
                    padding: '4px',
                    borderRadius: '8px',
                    backgroundColor: isSelected ? 'rgba(200, 170, 110, 0.3)' : 'transparent',
                    border: isSelected ? '2px solid var(--hextech-gold)' : '1px solid transparent',
                    transition: 'all 0.15s ease',
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={c.iconUrl}
                    alt={c.name}
                    style={{
                      width: '42px',
                      height: '42px',
                      borderRadius: '6px',
                      objectFit: 'cover',
                      opacity: isSelected ? 1 : 0.8,
                    }}
                  />
                  <span style={{
                    fontSize: '0.62rem',
                    textAlign: 'center',
                    marginTop: '3px',
                    color: isSelected ? 'var(--hextech-gold-bright)' : 'var(--text-muted)',
                    fontWeight: isSelected ? 800 : 500,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    maxWidth: '48px',
                  }}>
                    {c.name}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Botón Fijar Campeón */}
        <button
          onClick={handleLockChampion}
          disabled={isLocking || !selectedChamp || !gameState.online}
          style={{
            marginTop: '6px',
            width: '100%',
            padding: '16px',
            borderRadius: '10px',
            background: gameState.online
              ? 'linear-gradient(135deg, #785a28 0%, #c89b3c 50%, #f0e6d2 100%)'
              : 'rgba(255, 255, 255, 0.1)',
            border: '1px solid #f0e6d2',
            color: gameState.online ? '#091428' : 'var(--text-muted)',
            fontSize: '1.05rem',
            fontWeight: 900,
            letterSpacing: '1.5px',
            textTransform: 'uppercase',
            boxShadow: gameState.online ? '0 4px 16px rgba(200, 170, 110, 0.3)' : 'none',
            transform: isLocking ? 'scale(0.98)' : 'scale(1)',
            transition: 'transform 0.15s ease',
            cursor: gameState.online ? 'pointer' : 'not-allowed',
          }}
        >
          {isLocking
            ? 'Enviando Pick...'
            : !gameState.online
            ? 'PC Desconectada'
            : `Fijar a ${selectedChamp.name}`}
        </button>

        <p style={{
          fontSize: '0.7rem',
          color: 'var(--text-muted)',
          textAlign: 'center',
          lineHeight: '1.4',
        }}>
          Al fijar a <strong>{selectedChamp.name}</strong>, el Agente Local aplicará automáticamente las runas y hechizos recomendados.
        </p>
      </section>

      {/* Footer */}
      <footer style={{
        marginTop: 'auto',
        textAlign: 'center',
        fontSize: '0.7rem',
        color: 'var(--text-muted)',
      }}>
        LoL Remote &bull; Sincronización en Tiempo Real
      </footer>
    </main>
  );
}
