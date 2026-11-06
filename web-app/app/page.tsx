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
  playerResponse?: string;
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
  // Por defecto NINGÚN campeón seleccionado al entrar
  const [selectedChampionId, setSelectedChampionId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusBanner, setStatusBanner] = useState<{ text: string; type: 'info' | 'success' | 'error' | 'warning' } | null>(null);
  const [channelStatus, setChannelStatus] = useState<'DISCONNECTED' | 'CONNECTING' | 'CONNECTED'>('CONNECTING');
  const [roomCode, setRoomCode] = useState<string>('');
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

  // 1. Vinculación silenciosa automática mediante QR (?pair=TOKEN) o memoria guardada
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const urlParams = new URLSearchParams(window.location.search);
      const pairParam = urlParams.get('pair') || urlParams.get('token') || urlParams.get('room');

      if (pairParam) {
        const cleanToken = pairParam.trim().toLowerCase();
        setRoomCode(cleanToken);
        localStorage.setItem('lol_remote_room', cleanToken);

        // Limpiar URL para que quede estéticamente impecable
        window.history.replaceState({}, '', window.location.pathname);
        setStatusBanner({
          text: '🎉 ¡PC Vinculada con éxito!',
          type: 'success',
        });
      } else {
        const saved = localStorage.getItem('lol_remote_room') || '';
        setRoomCode(saved);
      }
    }
  }, []);

  // 2. Cargar campeones de Riot Data Dragon (sin auto-seleccionar ninguno)
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
      } catch (err) {
        console.warn('Usando lista de campeones offline:', err);
      }
    }
    loadChampions();
  }, []);

  // 3. Conexión a Supabase Realtime
  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) {
      setChannelStatus('DISCONNECTED');
      return;
    }

    const defaultChannel = process.env.NEXT_PUBLIC_SUPABASE_CHANNEL || 'lol-commands';
    const channelName = roomCode.trim() ? `lol-commands-${roomCode.trim().toLowerCase()}` : defaultChannel;

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
  }, [roomCode]);

  // Filtro de campeones
  const filteredChampions = champions.filter((c) =>
    c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    c.id.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const selectedChamp = selectedChampionId
    ? champions.find((c) => Number(c.key) === Number(selectedChampionId)) || null
    : null;

  // Enviar orden de Aceptar Partida
  const handleAcceptMatch = async () => {
    if (!channelRef.current || channelStatus !== 'CONNECTED') {
      setStatusBanner({ text: 'Sin conexión a Supabase', type: 'error' });
      return;
    }
    if (!gameState.online) {
      setStatusBanner({ text: 'El programa en tu PC no está abierto', type: 'error' });
      return;
    }

    setIsAccepting(true);
    setStatusBanner({ text: 'Aceptando partida en PC...', type: 'info' });

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

  // Seleccionar y Preseleccionar (Hover) Campeón
  const handleSelectChampion = async (champ: Champion) => {
    setSelectedChampionId(champ.key);
    if (channelRef.current && channelStatus === 'CONNECTED' && gameState.online) {
      try {
        await channelRef.current.send({
          type: 'broadcast',
          event: 'HOVER_CHAMPION',
          payload: {
            championId: champ.key,
            championName: champ.name,
            timestamp: Date.now(),
          },
        });
      } catch {}
    }
  };

  // Enviar orden de Fijar Campeón
  const handleLockChampion = async () => {
    if (!selectedChamp) return;

    if (!channelRef.current || channelStatus !== 'CONNECTED') {
      setStatusBanner({ text: 'Sin conexión a Supabase', type: 'error' });
      return;
    }
    if (!gameState.online) {
      setStatusBanner({ text: 'El programa en tu PC no está abierto', type: 'error' });
      return;
    }

    setIsLocking(true);
    setStatusBanner({ text: `Fijando a ${selectedChamp.name}...`, type: 'info' });

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

  const getPhaseText = () => {
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
        return 'Partida en Curso';
      default:
        return 'Conectado';
    }
  };

  return (
    <main style={{
      width: '100%',
      maxWidth: '460px',
      padding: '16px 14px 40px',
      display: 'flex',
      flexDirection: 'column',
      gap: '16px',
    }}>
      {/* HEADER MODERNO HEXTECH */}
      <header style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '14px 18px',
        backgroundColor: 'rgba(11, 22, 42, 0.75)',
        backdropFilter: 'blur(10px)',
        borderRadius: '16px',
        border: '1px solid var(--border-gold)',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.4)',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '1.2rem' }}>⚡</span>
            <span style={{
              fontSize: '1.25rem',
              fontWeight: 900,
              letterSpacing: '2px',
              background: 'linear-gradient(135deg, #f0e6d2 0%, #c8aa6e 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              textTransform: 'uppercase',
            }}>
              LoL Remote
            </span>
          </div>
          <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '2px', fontWeight: 500 }}>
            {gameState.summoner?.displayName
              ? `${gameState.summoner.displayName}#${gameState.summoner.tagLine || 'LAS'}`
              : 'Control Remoto'}
          </span>
        </div>

        {/* Indicador de Conexión */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '6px 12px',
          borderRadius: '20px',
          backgroundColor: gameState.online ? 'rgba(37, 187, 132, 0.15)' : 'rgba(232, 64, 87, 0.15)',
          border: `1px solid ${gameState.online ? 'var(--riot-green)' : 'var(--riot-red)'}`,
        }}>
          <span style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: gameState.online ? 'var(--riot-green)' : 'var(--riot-red)',
            boxShadow: gameState.online ? '0 0 8px var(--riot-green)' : 'none',
          }} />
          <span style={{
            fontSize: '0.72rem',
            fontWeight: 800,
            color: gameState.online ? 'var(--riot-green)' : 'var(--riot-red)',
            letterSpacing: '0.5px',
          }}>
            {gameState.online ? 'ONLINE' : 'OFFLINE'}
          </span>
        </div>
      </header>

      {/* Banner de Aviso de PC Desconectada */}
      {!gameState.online && (
        <div style={{
          padding: '12px 16px',
          borderRadius: '12px',
          backgroundColor: 'rgba(232, 64, 87, 0.12)',
          border: '1px solid rgba(232, 64, 87, 0.4)',
          fontSize: '0.78rem',
          color: '#f8d7da',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
        }}>
          <span style={{ fontSize: '1.2rem' }}>⚠️</span>
          <span>Abre <strong>LoL-Remote.exe</strong> en tu PC para conectar.</span>
        </div>
      )}

      {/* Toast / Notificación temporal */}
      {statusBanner && (
        <div style={{
          padding: '10px 14px',
          borderRadius: '10px',
          fontSize: '0.8rem',
          textAlign: 'center',
          fontWeight: 600,
          border: '1px solid',
          borderColor: statusBanner.type === 'success' ? 'var(--riot-green)' : statusBanner.type === 'error' ? 'var(--riot-red)' : 'var(--hextech-blue)',
          backgroundColor: statusBanner.type === 'success' ? 'rgba(37, 187, 132, 0.2)' : statusBanner.type === 'error' ? 'rgba(232, 64, 87, 0.2)' : 'rgba(10, 200, 185, 0.2)',
          color: 'var(--hextech-gold-bright)',
        }}>
          {statusBanner.text}
        </div>
      )}

      {/* SECCIÓN 1: READY CHECK / ESTADO */}
      <section style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '20px 16px',
        backgroundColor: 'var(--bg-card)',
        borderRadius: '18px',
        border: `1px solid ${isReadyCheck ? 'var(--hextech-blue)' : 'var(--border-gold)'}`,
        boxShadow: isReadyCheck ? '0 0 35px var(--hextech-blue-glow)' : '0 6px 24px rgba(0, 0, 0, 0.4)',
        transition: 'all 0.3s ease',
      }}>
        {isReadyCheck ? (
          /* POP UP DE ACEPTAR PARTIDA */
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <span style={{
              fontSize: '0.85rem',
              letterSpacing: '2px',
              textTransform: 'uppercase',
              color: 'var(--riot-green)',
              marginBottom: '12px',
              fontWeight: 900,
            }}>
              🚨 ¡PARTIDA ENCONTRADA! 🚨
            </span>

            {hasAccepted ? (
              <div style={{
                width: '100%',
                padding: '22px 14px',
                borderRadius: '14px',
                backgroundColor: 'rgba(37, 187, 132, 0.2)',
                border: '2px solid var(--riot-green)',
                textAlign: 'center',
                color: 'var(--riot-green)',
                fontWeight: 800,
                fontSize: '1.15rem',
                letterSpacing: '1px',
              }}>
                ✓ ¡PARTIDA ACEPTADA!
                <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', marginTop: '4px' }}>
                  Esperando a los demás jugadores...
                </div>
              </div>
            ) : (
              <button
                onClick={handleAcceptMatch}
                disabled={isAccepting}
                className="ready-check-pulse"
                style={{
                  width: '100%',
                  height: '110px',
                  borderRadius: '14px',
                  background: 'linear-gradient(135deg, #1e3a5f 0%, #0ac8b9 50%, #25bb84 100%)',
                  border: '2px solid #ffffff',
                  color: '#ffffff',
                  fontSize: '1.4rem',
                  fontWeight: 900,
                  letterSpacing: '2px',
                  textTransform: 'uppercase',
                  textShadow: '0 2px 10px rgba(0, 0, 0, 0.7)',
                  transform: isAccepting ? 'scale(0.96)' : 'scale(1)',
                }}
              >
                {isAccepting ? '¡ACEPTANDO!' : '¡ACEPTAR PARTIDA!'}
              </button>
            )}
          </div>
        ) : (
          /* ESTADO ACTUAL EN COLA O MENÚ */
          <div style={{ width: '100%', textAlign: 'center', padding: '6px 0' }}>
            <div style={{
              padding: '16px',
              borderRadius: '12px',
              backgroundColor: 'rgba(7, 14, 28, 0.85)',
              border: '1px solid var(--border-subtle)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '6px',
            }}>
              <div className={isMatchmaking ? 'radar-glow' : ''} style={{
                fontSize: '1.1rem',
                fontWeight: 800,
                color: isMatchmaking ? 'var(--hextech-blue)' : 'var(--hextech-gold-bright)',
                letterSpacing: '0.5px',
              }}>
                {isMatchmaking ? '⏳ Buscando Partida...' : getPhaseText()}
              </div>

              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                {isMatchmaking
                  ? 'Tu teléfono vibrará y sonará apenas encuentre partida.'
                  : isChampSelect
                  ? 'Estás en selección. Fija tu campeón abajo.'
                  : gameState.online
                  ? 'El botón aparecerá automáticamente cuando te toque aceptar.'
                  : 'Abre el programa en tu PC para sincronizar.'}
              </span>
            </div>
          </div>
        )}
      </section>

      {/* SECCIÓN 2: SELECCIÓN DE CAMPEÓN */}
      <section style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        padding: '18px 16px',
        backgroundColor: 'var(--bg-card)',
        borderRadius: '18px',
        border: `1px solid ${isChampSelect ? 'var(--hextech-gold)' : 'var(--border-gold)'}`,
        boxShadow: isChampSelect ? '0 0 25px rgba(200, 170, 110, 0.25)' : '0 6px 24px rgba(0, 0, 0, 0.4)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{
            fontSize: '0.75rem',
            letterSpacing: '1.5px',
            textTransform: 'uppercase',
            color: 'var(--hextech-gold)',
            fontWeight: 800,
          }}>
            Fijar Campeón & Runas
          </span>
          {isChampSelect && (
            <span style={{
              fontSize: '0.68rem',
              fontWeight: 800,
              color: gameState.champSelect?.isMyTurn ? 'var(--riot-green)' : 'var(--hextech-gold)',
            }}>
              {gameState.champSelect?.isMyTurn ? '● ¡TU TURNO!' : '● EN SELECCIÓN'}
            </span>
          )}
        </div>

        {/* Tarjeta del Campeón Seleccionado (O Estado Vacío) */}
        {selectedChamp ? (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 14px',
            backgroundColor: 'rgba(7, 14, 28, 0.95)',
            borderRadius: '14px',
            border: '2px solid var(--hextech-gold)',
            boxShadow: '0 4px 16px rgba(200, 170, 110, 0.25)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={selectedChamp.iconUrl}
                alt={selectedChamp.name}
                style={{
                  width: '56px',
                  height: '56px',
                  borderRadius: '10px',
                  border: '2px solid var(--hextech-gold-bright)',
                  objectFit: 'cover',
                }}
              />
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: '1.15rem', fontWeight: 900, color: 'var(--hextech-gold-bright)' }}>
                  {selectedChamp.name}
                </span>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'capitalize' }}>
                  {selectedChamp.title}
                </span>
              </div>
            </div>

            <button
              onClick={() => setSelectedChampionId(null)}
              style={{
                background: 'rgba(255, 255, 255, 0.08)',
                color: 'var(--text-muted)',
                borderRadius: '8px',
                padding: '6px 10px',
                fontSize: '0.7rem',
                fontWeight: 600,
              }}
            >
              Cambiar
            </button>
          </div>
        ) : (
          /* Estado Vacío cuando no hay campeón seleccionado */
          <div style={{
            padding: '16px',
            borderRadius: '14px',
            backgroundColor: 'rgba(7, 14, 28, 0.6)',
            border: '1px dashed rgba(200, 170, 110, 0.3)',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '4px',
          }}>
            <span style={{ fontSize: '1.3rem' }}>🛡️</span>
            <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-muted)' }}>
              Elige un campeón abajo
            </span>
          </div>
        )}

        {/* Buscador Rápido */}
        <div style={{ position: 'relative', width: '100%' }}>
          <input
            type="text"
            placeholder="Buscar campeón (ej: Yasuo, Ahri)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              width: '100%',
              padding: '11px 36px 11px 14px',
              backgroundColor: 'rgba(7, 14, 28, 0.95)',
              border: '1px solid var(--border-gold)',
              borderRadius: '10px',
              color: 'var(--text-main)',
              fontSize: '0.88rem',
            }}
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              style={{
                position: 'absolute',
                right: '10px',
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'transparent',
                color: 'var(--text-muted)',
                fontSize: '0.9rem',
                padding: '4px 8px',
              }}
            >
              ✕
            </button>
          )}
        </div>

        {/* Galería Táctil de Campeones */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, 1fr)',
          gap: '8px',
          maxHeight: '180px',
          overflowY: 'auto',
          padding: '6px',
          backgroundColor: 'rgba(5, 10, 20, 0.8)',
          borderRadius: '12px',
          border: '1px solid var(--border-subtle)',
        }}>
          {filteredChampions.slice(0, 30).map((c) => {
            const isSelected = selectedChamp && Number(c.key) === Number(selectedChamp.key);
            return (
              <div
                key={`champ-${c.key}`}
                onClick={() => handleSelectChampion(c)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  cursor: 'pointer',
                  padding: '4px',
                  borderRadius: '8px',
                  backgroundColor: isSelected ? 'rgba(200, 170, 110, 0.25)' : 'transparent',
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
                    borderRadius: '8px',
                    objectFit: 'cover',
                    opacity: isSelected ? 1 : 0.75,
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

        {/* Botón de Acción */}
        {selectedChamp && (
          <button
            onClick={handleLockChampion}
            disabled={isLocking || !gameState.online}
            style={{
              marginTop: '4px',
              width: '100%',
              padding: '16px',
              borderRadius: '12px',
              background: gameState.online
                ? 'linear-gradient(135deg, #785a28 0%, #c89b3c 50%, #f0e6d2 100%)'
                : 'rgba(255, 255, 255, 0.1)',
              border: '1px solid #f0e6d2',
              color: gameState.online ? '#091428' : 'var(--text-muted)',
              fontSize: '1.05rem',
              fontWeight: 900,
              letterSpacing: '1px',
              textTransform: 'uppercase',
              boxShadow: gameState.online ? '0 4px 16px rgba(200, 170, 110, 0.3)' : 'none',
              transform: isLocking ? 'scale(0.98)' : 'scale(1)',
              cursor: gameState.online ? 'pointer' : 'not-allowed',
            }}
          >
            {isLocking ? 'Fijando...' : `Fijar a ${selectedChamp.name}`}
          </button>
        )}
      </section>

      {/* Footer minimalista */}
      <footer style={{
        marginTop: 'auto',
        textAlign: 'center',
        fontSize: '0.68rem',
        color: 'var(--text-muted)',
        opacity: 0.7,
      }}>
        LoL Remote &bull; Runas y Hechizos Automáticos
      </footer>
    </main>
  );
}
