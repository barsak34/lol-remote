'use client';

import { useState, useEffect, useRef } from 'react';
import { getSupabase } from '@/lib/supabase';
import { RealtimeChannel } from '@supabase/supabase-js';

interface Champion {
  id: string;      // "Aatrox"
  key: number;     // 266
  name: string;    // "Aatrox"
  title: string;   // "the Darkin Blade"
  iconUrl: string; // URL to avatar image
}

// Fallback champion list if Data Dragon is offline
const FALLBACK_CHAMPIONS: Champion[] = [
  { id: 'Ahri', key: 103, name: 'Ahri', title: 'the Nine-Tailed Fox', iconUrl: 'https://ddragon.leagueoflegends.com/cdn/14.23.1/img/champion/Ahri.png' },
  { id: 'Aatrox', key: 266, name: 'Aatrox', title: 'the Darkin Blade', iconUrl: 'https://ddragon.leagueoflegends.com/cdn/14.23.1/img/champion/Aatrox.png' },
  { id: 'Jinx', key: 222, name: 'Jinx', title: 'the Loose Cannon', iconUrl: 'https://ddragon.leagueoflegends.com/cdn/14.23.1/img/champion/Jinx.png' },
  { id: 'LeeSin', key: 64, name: 'Lee Sin', title: 'the Blind Monk', iconUrl: 'https://ddragon.leagueoflegends.com/cdn/14.23.1/img/champion/LeeSin.png' },
  { id: 'Lux', key: 99, name: 'Lux', title: 'the Lady of Luminosity', iconUrl: 'https://ddragon.leagueoflegends.com/cdn/14.23.1/img/champion/Lux.png' },
  { id: 'Thresh', key: 412, name: 'Thresh', title: 'the Chain Warden', iconUrl: 'https://ddragon.leagueoflegends.com/cdn/14.23.1/img/champion/Thresh.png' },
  { id: 'Yasuo', key: 157, name: 'Yasuo', title: 'the Unforgiven', iconUrl: 'https://ddragon.leagueoflegends.com/cdn/14.23.1/img/champion/Yasuo.png' },
  { id: 'Yone', key: 777, name: 'Yone', title: 'the Unforgotten', iconUrl: 'https://ddragon.leagueoflegends.com/cdn/14.23.1/img/champion/Yone.png' },
  { id: 'Zed', key: 238, name: 'Zed', title: 'the Master of Shadows', iconUrl: 'https://ddragon.leagueoflegends.com/cdn/14.23.1/img/champion/Zed.png' },
];

export default function HomePage() {
  const [champions, setChampions] = useState<Champion[]>(FALLBACK_CHAMPIONS);
  const [selectedChampionId, setSelectedChampionId] = useState<number>(FALLBACK_CHAMPIONS[0].key);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'info' | 'success' | 'error' | 'warning' } | null>(null);
  const [channelStatus, setChannelStatus] = useState<'DISCONNECTED' | 'CONNECTING' | 'CONNECTED'>('CONNECTING');
  const [isAccepting, setIsAccepting] = useState(false);
  const [isLocking, setIsLocking] = useState(false);
  const channelRef = useRef<RealtimeChannel | null>(null);

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
          key: parseInt(c.key, 10),
          name: c.name,
          title: c.title,
          iconUrl: `https://ddragon.leagueoflegends.com/cdn/${latestVer}/img/champion/${c.image.full}`,
        }));

        list.sort((a, b) => a.name.localeCompare(b.name));
        setChampions(list);
        if (list.length > 0) {
          setSelectedChampionId(list[0].key);
        }
      } catch (err) {
        console.warn('Error fetching Data Dragon champions, using fallback list:', err);
      }
    }
    loadChampions();
  }, []);

  // 2. Connect to Supabase Realtime Broadcast Channel
  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) {
      setChannelStatus('DISCONNECTED');
      setStatusMessage({
        text: 'Faltan credenciales en .env.local (NEXT_PUBLIC_SUPABASE_URL y ANON_KEY)',
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

    channel
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          setChannelStatus('CONNECTED');
          setStatusMessage({ text: `Conectado al canal '${channelName}'`, type: 'info' });
        } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
          setChannelStatus('DISCONNECTED');
        } else {
          setChannelStatus('CONNECTING');
        }
      });

    channelRef.current = channel;

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // Handler: Enviar evento ACCEPT_MATCH
  const handleAcceptMatch = async () => {
    setIsAccepting(true);
    setStatusMessage({ text: 'Enviando orden: ACEPTAR PARTIDA...', type: 'info' });

    if (!channelRef.current || channelStatus !== 'CONNECTED') {
      setStatusMessage({
        text: 'No hay conexión con Supabase Realtime. Revisa las variables en .env.local',
        type: 'error',
      });
      setIsAccepting(false);
      return;
    }

    try {
      const resp = await channelRef.current.send({
        type: 'broadcast',
        event: 'ACCEPT_MATCH',
        payload: { timestamp: Date.now() },
      });

      if (resp === 'ok') {
        setStatusMessage({ text: '¡Partida aceptada enviada al PC!', type: 'success' });
      } else {
        setStatusMessage({ text: `Estado de envío: ${resp}`, type: 'warning' });
      }
    } catch (err: any) {
      setStatusMessage({ text: `Error al enviar: ${err?.message || err}`, type: 'error' });
    } finally {
      setTimeout(() => setIsAccepting(false), 800);
    }
  };

  // Handler: Enviar evento LOCK_CHAMPION
  const handleLockChampion = async () => {
    const currentChamp = champions.find((c) => c.key === selectedChampionId);
    if (!currentChamp) return;

    setIsLocking(true);
    setStatusMessage({ text: `Enviando orden: FIJAR ${currentChamp.name.toUpperCase()} (ID: ${currentChamp.key})...`, type: 'info' });

    if (!channelRef.current || channelStatus !== 'CONNECTED') {
      setStatusMessage({
        text: 'No hay conexión con Supabase Realtime. Revisa las variables en .env.local',
        type: 'error',
      });
      setIsLocking(false);
      return;
    }

    try {
      const resp = await channelRef.current.send({
        type: 'broadcast',
        event: 'LOCK_CHAMPION',
        payload: {
          championId: currentChamp.key,
          championName: currentChamp.name,
          timestamp: Date.now(),
        },
      });

      if (resp === 'ok') {
        setStatusMessage({
          text: `¡Orden de pick enviada! Fijando ${currentChamp.name} y aplicando runas/hechizos recomendados...`,
          type: 'success',
        });
      } else {
        setStatusMessage({ text: `Estado de envío: ${resp}`, type: 'warning' });
      }
    } catch (err: any) {
      setStatusMessage({ text: `Error al enviar pick: ${err?.message || err}`, type: 'error' });
    } finally {
      setTimeout(() => setIsLocking(false), 1000);
    }
  };

  const selectedChamp = champions.find((c) => c.key === selectedChampionId);
  const filteredChampions = champions.filter((c) =>
    c.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <main style={{
      width: '100%',
      maxWidth: '480px',
      padding: '20px 16px 40px',
      display: 'flex',
      flexDirection: 'column',
      gap: '20px',
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
            fontSize: '1.4rem',
            fontWeight: 800,
            letterSpacing: '1px',
            color: 'var(--hextech-gold)',
            textTransform: 'uppercase',
          }}>
            LoL Remote
          </h1>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            Control de Selección & Partidas
          </p>
        </div>

        {/* Status Pill */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '4px 10px',
          borderRadius: '999px',
          fontSize: '0.7rem',
          fontWeight: 600,
          backgroundColor:
            channelStatus === 'CONNECTED'
              ? 'rgba(37, 187, 132, 0.2)'
              : channelStatus === 'CONNECTING'
              ? 'rgba(200, 170, 110, 0.2)'
              : 'rgba(232, 64, 87, 0.2)',
          color:
            channelStatus === 'CONNECTED'
              ? 'var(--riot-green)'
              : channelStatus === 'CONNECTING'
              ? 'var(--hextech-gold)'
              : 'var(--riot-red)',
          border: `1px solid ${
            channelStatus === 'CONNECTED'
              ? 'var(--riot-green)'
              : channelStatus === 'CONNECTING'
              ? 'var(--hextech-gold)'
              : 'var(--riot-red)'
          }`,
        }}>
          <span style={{
            width: '7px',
            height: '7px',
            borderRadius: '50%',
            backgroundColor:
              channelStatus === 'CONNECTED'
                ? 'var(--riot-green)'
                : channelStatus === 'CONNECTING'
                ? 'var(--hextech-gold)'
                : 'var(--riot-red)',
          }} />
          {channelStatus === 'CONNECTED' ? 'ONLINE' : channelStatus === 'CONNECTING' ? 'CONECTANDO' : 'OFFLINE'}
        </div>
      </header>

      {/* Status banner */}
      {statusMessage && (
        <div style={{
          padding: '12px 14px',
          borderRadius: '8px',
          fontSize: '0.85rem',
          lineHeight: '1.3',
          border: '1px solid',
          borderColor:
            statusMessage.type === 'success'
              ? 'var(--riot-green)'
              : statusMessage.type === 'error'
              ? 'var(--riot-red)'
              : statusMessage.type === 'warning'
              ? 'var(--hextech-gold)'
              : 'var(--hextech-blue)',
          backgroundColor:
            statusMessage.type === 'success'
              ? 'rgba(37, 187, 132, 0.15)'
              : statusMessage.type === 'error'
              ? 'rgba(232, 64, 87, 0.15)'
              : statusMessage.type === 'warning'
              ? 'rgba(200, 170, 110, 0.15)'
              : 'rgba(10, 200, 185, 0.15)',
          color: 'var(--hextech-gold-bright)',
        }}>
          {statusMessage.text}
        </div>
      )}

      {/* SECCIÓN 1: BOTÓN GIGANTE ACEPTAR PARTIDA */}
      <section style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '24px 16px',
        background: 'var(--bg-card)',
        borderRadius: '16px',
        border: '1px solid var(--border-gold)',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
      }}>
        <span style={{
          fontSize: '0.75rem',
          letterSpacing: '2px',
          textTransform: 'uppercase',
          color: 'var(--hextech-gold)',
          marginBottom: '16px',
          fontWeight: 700,
        }}>
          Ready Check Instantáneo
        </span>

        <button
          onClick={handleAcceptMatch}
          disabled={isAccepting}
          className="ready-check-pulse"
          style={{
            width: '100%',
            height: '110px',
            borderRadius: '12px',
            background: 'linear-gradient(135deg, #1e3a5f 0%, #0ac8b9 50%, #25bb84 100%)',
            border: '2px solid #f0e6d2',
            color: '#ffffff',
            fontSize: '1.35rem',
            fontWeight: 900,
            letterSpacing: '2px',
            textTransform: 'uppercase',
            textShadow: '0 2px 8px rgba(0, 0, 0, 0.6)',
            boxShadow: '0 4px 20px var(--hextech-blue-glow)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px',
            transform: isAccepting ? 'scale(0.97)' : 'scale(1)',
            transition: 'transform 0.15s ease',
          }}
        >
          <span>{isAccepting ? '¡ACEPTANDO!' : 'ACEPTAR PARTIDA'}</span>
          <span style={{ fontSize: '0.75rem', fontWeight: 600, opacity: 0.9, letterSpacing: '1px' }}>
            CLICK PARA ACEPTAR EN PC
          </span>
        </button>
      </section>

      {/* SECCIÓN 2: SELECTOR DE CAMPEÓN */}
      <section style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        padding: '20px 16px',
        background: 'var(--bg-card)',
        borderRadius: '16px',
        border: '1px solid var(--border-gold)',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
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
          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
            {champions.length} campeones
          </span>
        </div>

        {/* Buscador de campeón */}
        <input
          type="text"
          placeholder="Buscar por nombre (ej: Yasuo, Ahri)..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{
            width: '100%',
            padding: '10px 14px',
            backgroundColor: 'rgba(9, 20, 40, 0.9)',
            border: '1px solid var(--border-gold)',
            borderRadius: '8px',
            color: 'var(--text-main)',
            fontSize: '0.9rem',
          }}
        />

        {/* Selector nativo / dropdown */}
        <select
          value={selectedChampionId}
          onChange={(e) => setSelectedChampionId(Number(e.target.value))}
          style={{
            width: '100%',
            padding: '12px 14px',
            backgroundColor: 'rgba(9, 20, 40, 0.9)',
            border: '1px solid var(--border-gold)',
            borderRadius: '8px',
            color: 'var(--text-main)',
            fontSize: '1rem',
            fontWeight: 600,
          }}
        >
          {filteredChampions.map((c) => (
            <option key={c.key} value={c.key} style={{ background: '#091428', color: '#f0e6d2' }}>
              {c.name} - {c.title}
            </option>
          ))}
        </select>

        {/* Tarjeta del Campeón Seleccionado */}
        {selectedChamp && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '14px',
            padding: '12px',
            backgroundColor: 'rgba(9, 20, 40, 0.7)',
            borderRadius: '10px',
            border: '1px solid rgba(200, 170, 110, 0.25)',
          }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={selectedChamp.iconUrl}
              alt={selectedChamp.name}
              style={{
                width: '56px',
                height: '56px',
                borderRadius: '8px',
                border: '2px solid var(--hextech-gold)',
                objectFit: 'cover',
              }}
            />
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--hextech-gold-bright)' }}>
                {selectedChamp.name}
              </span>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'capitalize' }}>
                {selectedChamp.title}
              </span>
              <span style={{ fontSize: '0.7rem', color: 'var(--hextech-blue)', marginTop: '2px' }}>
                LCU ID: {selectedChamp.key}
              </span>
            </div>
          </div>
        )}

        {/* Botón Fijar Campeón */}
        <button
          onClick={handleLockChampion}
          disabled={isLocking || !selectedChamp}
          style={{
            marginTop: '4px',
            width: '100%',
            padding: '16px',
            borderRadius: '10px',
            background: 'linear-gradient(135deg, #785a28 0%, #c89b3c 50%, #f0e6d2 100%)',
            border: '1px solid #f0e6d2',
            color: '#091428',
            fontSize: '1.05rem',
            fontWeight: 900,
            letterSpacing: '1.5px',
            textTransform: 'uppercase',
            boxShadow: '0 4px 16px rgba(200, 170, 110, 0.3)',
            transform: isLocking ? 'scale(0.98)' : 'scale(1)',
            transition: 'transform 0.15s ease',
          }}
        >
          {isLocking ? 'Fijando Pick...' : `Fijar a ${selectedChamp ? selectedChamp.name : 'Campeón'}`}
        </button>

        <p style={{
          fontSize: '0.7rem',
          color: 'var(--text-muted)',
          textAlign: 'center',
          lineHeight: '1.4',
        }}>
          Al fijar el campeón, el Agente Local aplicará automáticamente la primera página recomendada de runas y hechizos de invocador en el cliente de LoL.
        </p>
      </section>

      {/* Footer info */}
      <footer style={{
        marginTop: 'auto',
        textAlign: 'center',
        fontSize: '0.7rem',
        color: 'var(--text-muted)',
      }}>
        LoL Remote &bull; LCU API + Supabase Realtime
      </footer>
    </main>
  );
}
