import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// Permitir certificados autofirmados del cliente de League of Legends
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Cargar variables de entorno desde .env
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return {};
  const content = fs.readFileSync(envPath, 'utf-8');
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...rest] = trimmed.split('=');
    env[key.trim()] = rest.join('=').trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

const env = loadEnv();
const SUPABASE_URL = env.SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = env.SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
const argRoom = process.argv[2];
const ROOM_CODE = (argRoom || env.ROOM_CODE || process.env.ROOM_CODE || '').trim().toLowerCase();
const SUPABASE_CHANNEL = ROOM_CODE ? `lol-commands-${ROOM_CODE}` : (env.SUPABASE_CHANNEL || 'lol-commands');

// 2. Localizar y parsear lockfile dinámicamente
function getLockfile() {
  const candidates = [
    process.env.LOL_LOCKFILE_PATH,
    'E:\\Riot Games\\League of Legends\\lockfile',
    'C:\\Riot Games\\League of Legends\\lockfile',
    'D:\\Riot Games\\League of Legends\\lockfile',
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        const raw = fs.readFileSync(p, 'utf-8').trim();
        const [processName, pid, port, password, protocol] = raw.split(':');
        return { path: p, processName, pid: parseInt(pid, 10), port: parseInt(port, 10), password, protocol };
      } catch (e) {
        // archivo posiblemente bloqueado temporalmente durante arranque
      }
    }
  }
  return null;
}

// 3. Cliente LCU
class LCUClient {
  constructor(lockfile) {
    this.updateCredentials(lockfile);
  }

  updateCredentials(lockfile) {
    this.lockfile = lockfile;
    this.baseURL = `https://127.0.0.1:${lockfile.port}`;
    this.authHeader = 'Basic ' + Buffer.from(`riot:${lockfile.password}`).toString('base64');
  }

  async request(method, endpoint, body = null) {
    const url = `${this.baseURL}${endpoint}`;
    const options = {
      method,
      headers: {
        Authorization: this.authHeader,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    };
    if (body) {
      options.body = JSON.stringify(body);
    }
    try {
      const res = await fetch(url, options);
      let data = null;
      const text = await res.text();
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      return { status: res.status, ok: res.ok, data };
    } catch (err) {
      return { status: 0, ok: false, error: err.message };
    }
  }

  async getCurrentSummoner() {
    return this.request('GET', '/lol-summoner/v1/current-summoner');
  }

  async getGameflowPhase() {
    const res = await this.request('GET', '/lol-gameflow/v1/gameflow-phase');
    if (res.ok) {
      return typeof res.data === 'string' ? res.data : String(res.data);
    }
    return 'None';
  }

  async getReadyCheck() {
    const res = await this.request('GET', '/lol-matchmaking/v1/ready-check');
    if (res.ok && typeof res.data === 'object') {
      return res.data;
    }
    return null;
  }

  async getChampSelectSession() {
    const res = await this.request('GET', '/lol-champ-select/v1/session');
    if (res.ok && typeof res.data === 'object') {
      return res.data;
    }
    return null;
  }

  async acceptMatch() {
    console.log('[LCU] Enviando POST /lol-matchmaking/v1/ready-check/accept...');
    const res = await this.request('POST', '/lol-matchmaking/v1/ready-check/accept');
    if (res.ok) {
      console.log('>>> [LCU ÉXITO] ¡Partida aceptada en el cliente!');
      return { success: true, message: '¡Partida aceptada exitosamente en LoL!' };
    } else {
      console.error('[LCU ERROR] No se pudo aceptar la partida:', res.status, res.data);
      const msg = res.status === 404
        ? 'No hay ninguna partida activa por aceptar en este momento.'
        : `Error al aceptar partida (código ${res.status})`;
      return { success: false, message: msg };
    }
  }

  async hoverChampion(championId) {
    try {
      const sessionRes = await this.request('GET', '/lol-champ-select/v1/session');
      if (!sessionRes.ok) return;
      const session = sessionRes.data;
      const localCellId = session.localPlayerCellId;

      let pickActionId = null;
      if (session.actions) {
        for (const group of session.actions) {
          for (const action of group) {
            if (action.actorCellId === localCellId && action.type === 'pick' && !action.completed) {
              pickActionId = action.id;
              break;
            }
          }
          if (pickActionId !== null) break;
        }
      }

      if (pickActionId !== null) {
        await this.request('PATCH', `/lol-champ-select/v1/session/actions/${pickActionId}`, { championId });
      }
      await this.request('PATCH', '/lol-champ-select/v1/session/my-selection', { championId });
    } catch {}
  }

  async lockChampion(championId, championName = '') {
    console.log(`[LCU] Iniciando fijación de campeón: ${championName || championId}...`);

    // 1. Obtener sesión de selección de campeón
    const sessionRes = await this.request('GET', '/lol-champ-select/v1/session');
    if (!sessionRes.ok) {
      console.error('[LCU ERROR] No estás en selección de campeón o LCU respondió error:', sessionRes.data);
      return { success: false, message: 'No estás en selección de campeón en LoL.' };
    }

    const session = sessionRes.data;
    const localCellId = session.localPlayerCellId;
    console.log(`[LCU] Tu celda local es: ${localCellId}`);

    // 2. Buscar acción activa y acción pendiente
    let activeActionId = null;
    let pendingActionId = null;

    if (session.actions) {
      for (const group of session.actions) {
        for (const action of group) {
          if (action.actorCellId === localCellId && action.type === 'pick' && !action.completed) {
            if (action.isInProgress) {
              activeActionId = action.id;
              break;
            } else if (pendingActionId === null) {
              pendingActionId = action.id;
            }
          }
        }
        if (activeActionId !== null) break;
      }
    }

    // Caso 1: Turno activo de selección
    if (activeActionId !== null) {
      console.log(`[LCU] Acción activa encontrada (ID: ${activeActionId}). Bloqueando campeón...`);

      // Hover primero
      await this.request('PATCH', `/lol-champ-select/v1/session/actions/${activeActionId}`, { championId });

      // Lock-in completando la acción
      const lockRes = await this.request('PATCH', `/lol-champ-select/v1/session/actions/${activeActionId}`, {
        championId,
        completed: true,
      });

      if (!lockRes.ok) {
        // Fallback
        await this.request('POST', `/lol-champ-select/v1/session/actions/${activeActionId}/complete`);
      }

      console.log(`>>> [LCU ÉXITO] ¡${championName || championId} fijado con éxito!`);
      setTimeout(async () => {
        await this.applyRunesAndSpells(championId);
      }, 600);

      return { success: true, message: `¡${championName || championId} fijado con éxito! Configurando runas...` };
    }

    // Caso 2: En Draft pero esperando turno
    if (pendingActionId !== null) {
      console.log(`[LCU] Turno aún no activo. Preseleccionando (hover) para el equipo...`);
      await this.request('PATCH', `/lol-champ-select/v1/session/actions/${pendingActionId}`, { championId });
      await this.request('PATCH', '/lol-champ-select/v1/session/my-selection', { championId });

      setTimeout(async () => {
        await this.applyRunesAndSpells(championId);
      }, 600);

      return {
        success: true,
        message: `¡${championName || championId} preseleccionado! Se fijará automáticamente al comenzar tu turno.`,
      };
    }

    // Caso 3: Modos alternativos (Blind pick / ARAM)
    const mySelRes = await this.request('PATCH', '/lol-champ-select/v1/session/my-selection', { championId });
    if (mySelRes.ok) {
      setTimeout(async () => {
        await this.applyRunesAndSpells(championId);
      }, 600);
      return { success: true, message: `¡${championName || championId} seleccionado con éxito!` };
    }

    return { success: false, message: 'No es tu turno de selección o ya fijaste campeón.' };
  }

  async applyRunesAndSpells(championId) {
    console.log(`[LCU] Obteniendo runas y hechizos recomendados para campeón ${championId}...`);

    // Consultar páginas recomendadas
    const recRes = await this.request('GET', `/lol-perks/v1/recommended-pages?championId=${championId}`);
    let runesApplied = false;

    if (recRes.ok && Array.isArray(recRes.data) && recRes.data.length > 0) {
      const bestPage = recRes.data[0];
      console.log(`[LCU] Aplicando primera página de runas: "${bestPage.name}"`);
      const postPage = await this.request('POST', '/lol-perks/v1/currentpage', bestPage);
      if (postPage.ok) {
        console.log('>>> [LCU ÉXITO] ¡Runas recomendadas aplicadas con éxito!');
        runesApplied = true;
      }
    }

    // Consultar recomendaciones de grid (spells)
    const gridRes = await this.request('GET', '/lol-champ-select/v1/grid-recommendations');
    if (gridRes.ok && Array.isArray(gridRes.data) && gridRes.data.length > 0) {
      const rec = gridRes.data[0];
      if (!runesApplied && rec.recommendedPerkPages && rec.recommendedPerkPages.length > 0) {
        console.log(`[LCU] Aplicando runa desde recomendación de grid: "${rec.recommendedPerkPages[0].name}"`);
        await this.request('POST', '/lol-perks/v1/currentpage', rec.recommendedPerkPages[0]);
      }

      if (rec.recommendedSpells && rec.recommendedSpells.length > 0) {
        const spells = rec.recommendedSpells[0];
        console.log(`[LCU] Aplicando hechizos de invocador: Spell1=${spells.spell1Id}, Spell2=${spells.spell2Id}`);
        const patchSpell = await this.request('PATCH', '/lol-champ-select/v1/session/my-selection', {
          spell1Id: spells.spell1Id,
          spell2Id: spells.spell2Id,
        });
        if (patchSpell.ok) {
          console.log('>>> [LCU ÉXITO] ¡Hechizos recomendados aplicados con éxito!');
        }
      }
    }
  }
}

// 4. Inicialización
async function main() {
  console.log('====================================================');
  console.log('           LoL Remote - Local Agent Runner          ');
  console.log('====================================================');

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[ERROR] Falta SUPABASE_URL o SUPABASE_ANON_KEY en local-agent/.env');
    return;
  }

  // Importar createClient de forma dinámica y flexible
  let createClient;
  try {
    const localModule = path.join(__dirname, 'node_modules', '@supabase', 'supabase-js', 'dist', 'index.mjs');
    if (fs.existsSync(localModule)) {
      const res = await import(pathToFileURL(localModule).href);
      createClient = res.createClient;
    } else {
      const parentModule = path.join(__dirname, '..', 'web-app', 'node_modules', '@supabase', 'supabase-js', 'dist', 'index.mjs');
      const res = await import(pathToFileURL(parentModule).href);
      createClient = res.createClient;
    }
  } catch (err) {
    const res = await import('@supabase/supabase-js');
    createClient = res.createClient;
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log(`[Supabase Realtime] Conectando a ${SUPABASE_URL}`);
  console.log(`>>> CANAL ACTIVO: '${SUPABASE_CHANNEL}' ${ROOM_CODE ? `(Código de Sala: "${ROOM_CODE}")` : '(Sala por Defecto)'} <<<`);
  console.log(`(Asegúrate de colocar este mismo código de sala en tu celular)`);

  const channel = supabase.channel(SUPABASE_CHANNEL, {
    config: { broadcast: { ack: true, self: true } },
  });

  let client = null;
  let cachedSummoner = null;

  function ensureClient() {
    const lockfile = getLockfile();
    if (!lockfile) {
      client = null;
      return null;
    }
    if (!client || client.lockfile.port !== lockfile.port || client.lockfile.password !== lockfile.password) {
      client = new LCUClient(lockfile);
      console.log(`[LCU] Lockfile vinculado en puerto: ${lockfile.port}`);
    }
    return client;
  }

  // Enviar estado actual del juego hacia Supabase Realtime
  async function broadcastGameState() {
    const c = ensureClient();
    if (!c) {
      channel.send({
        type: 'broadcast',
        event: 'GAME_STATE',
        payload: {
          online: false,
          lolRunning: false,
          phase: 'None',
          timestamp: Date.now(),
        },
      });
      return;
    }

    if (!cachedSummoner) {
      const sumRes = await c.getCurrentSummoner();
      if (sumRes.ok) {
        cachedSummoner = {
          displayName: sumRes.data.displayName || sumRes.data.gameName,
          gameName: sumRes.data.gameName,
          tagLine: sumRes.data.tagLine,
          summonerLevel: sumRes.data.summonerLevel,
        };
      }
    }

    const phase = await c.getGameflowPhase();
    let readyCheck = null;
    let champSelect = null;

    if (phase === 'ReadyCheck') {
      readyCheck = await c.getReadyCheck();
    } else if (phase === 'ChampSelect') {
      const session = await c.getChampSelectSession();
      if (session) {
        const localCellId = session.localPlayerCellId;
        let isMyTurn = false;
        if (session.actions) {
          for (const group of session.actions) {
            for (const action of group) {
              if (action.actorCellId === localCellId && action.type === 'pick' && !action.completed && action.isInProgress) {
                isMyTurn = true;
                break;
              }
            }
          }
        }
        champSelect = {
          localPlayerCellId: localCellId,
          isMyTurn,
          hasSession: true,
        };
      }
    }

    channel.send({
      type: 'broadcast',
      event: 'GAME_STATE',
      payload: {
        online: true,
        lolRunning: true,
        summoner: cachedSummoner,
        phase,
        readyCheck,
        champSelect,
        timestamp: Date.now(),
      },
    });
  }

  // Handlers para comandos desde el teléfono
  channel.on('broadcast', { event: 'ACCEPT_MATCH' }, async () => {
    console.log('\n>>> [EVENTO RECIBIDO] ACCEPT_MATCH');
    const c = ensureClient();
    if (!c) {
      channel.send({
        type: 'broadcast',
        event: 'ACTION_RESULT',
        payload: { action: 'ACCEPT_MATCH', success: false, message: 'League of Legends no está iniciado en la PC.' },
      });
      return;
    }

    const result = await c.acceptMatch();
    channel.send({
      type: 'broadcast',
      event: 'ACTION_RESULT',
      payload: { action: 'ACCEPT_MATCH', ...result },
    });
    // Inmediatamente emitir nuevo estado
    setTimeout(broadcastGameState, 300);
  });

  channel.on('broadcast', { event: 'LOCK_CHAMPION' }, async (eventPayload) => {
    const data = eventPayload.payload || eventPayload;
    console.log('\n>>> [EVENTO RECIBIDO] LOCK_CHAMPION:', data);
    const c = ensureClient();
    if (!c) {
      channel.send({
        type: 'broadcast',
        event: 'ACTION_RESULT',
        payload: { action: 'LOCK_CHAMPION', success: false, message: 'League of Legends no está iniciado en la PC.' },
      });
      return;
    }

    const championId = parseInt(data.championId, 10);
    if (!championId) {
      channel.send({
        type: 'broadcast',
        event: 'ACTION_RESULT',
        payload: { action: 'LOCK_CHAMPION', success: false, message: 'ID de campeón inválido.' },
      });
      return;
    }

    const result = await c.lockChampion(championId);
    channel.send({
      type: 'broadcast',
      event: 'ACTION_RESULT',
      payload: { action: 'LOCK_CHAMPION', championId, ...result },
    });
    setTimeout(broadcastGameState, 400);
  });

  // Cuando el teléfono solicita actualización instantánea
  channel.on('broadcast', { event: 'PING_STATE' }, async () => {
    await broadcastGameState();
  });

  channel.subscribe((status) => {
    console.log(`[Supabase Realtime] Estado de suscripción: ${status}`);
    if (status === 'SUBSCRIBED') {
      console.log('====================================================');
      console.log(`>>> AGENTE LOCAL ACTIVO Y LISTO PARA RECIBIR ÓRDENES <<<`);
      console.log('====================================================');

      // Iniciar sincronización de estado cada 1.2 segundos
      setInterval(broadcastGameState, 1200);
      broadcastGameState();
    }
  });
}

main().catch(console.error);
