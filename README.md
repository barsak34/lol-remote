# LoL Remote 🎮📲

Sistema distribuido para aceptar partidas de League of Legends, seleccionar campeones y aplicar runas/hechizos recomendados de manera remota desde un teléfono móvil.

## Arquitectura del Proyecto

```
lol-remote/
├── local-agent/             # Binario ligero en Go (corre en tu PC)
│   ├── lcu/
│   │   ├── lockfile.go      # Lectura y parsing automático del lockfile de LoL
│   │   └── client.go        # Cliente HTTP LCU con InsecureSkipVerify y Basic Auth
│   ├── realtime/
│   │   └── supabase.go      # Suscriptor WebSocket Supabase Realtime (Phoenix Channels)
│   ├── main.go              # Servidor principal y orquestador de comandos
│   ├── go.mod
│   ├── .env.example
│   └── .env                 # Variables de entorno (Credenciales de Supabase)
│
└── web-app/                 # Aplicación Web Móvil en Next.js (App Router)
    ├── app/
    │   ├── layout.tsx       # Layout optimizado para viewport móvil
    │   ├── globals.css      # Estilos Hextech oscuros con animaciones
    │   └── page.tsx         # Botón gigante Ready Check y selector de campeones
    ├── lib/
    │   └── supabase.ts      # Cliente de Supabase (@supabase/supabase-js)
    ├── package.json
    ├── .env.local.example
    └── .env.local           # Variables de entorno para la Web App
```

---

## 1. Configuración de Credenciales de Supabase

Copia tus credenciales de Supabase en los dos archivos `.env`:

### En `local-agent/.env`:
```env
SUPABASE_URL=https://tu-proyecto.supabase.co
SUPABASE_ANON_KEY=tu-anon-key-de-supabase
SUPABASE_CHANNEL=lol-commands
# LOL_LOCKFILE_PATH=E:\Riot Games\League of Legends\lockfile # (Opcional si usas ruta no estándar)
```

### En `web-app/.env.local`:
```env
NEXT_PUBLIC_SUPABASE_URL=https://tu-proyecto.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=tu-anon-key-de-supabase
NEXT_PUBLIC_SUPABASE_CHANNEL=lol-commands
```

> **Nota:** Supabase Realtime Broadcast no requiere crear tablas ni base de datos; funciona directamente sobre WebSockets como un bus de eventos en memoria.

---

## 2. Ejecución del Agente Local (Go)

Asegúrate de tener Go instalado (`go version`).

```bash
cd local-agent

# Descargar dependencias
go mod tidy

# Iniciar el agente
go run .
```

Si el cliente de League of Legends está iniciado, el agente detectará automáticamente el `lockfile` (en `C:\Riot Games\League of Legends\lockfile` o `E:\Riot Games\League of Legends\lockfile`), autenticará con la LCU API (`riot:<password>`) y mostrará el nombre de tu invocador.

### Comandos que procesa el Agente Local:
1. **`ACCEPT_MATCH`**:
   - `POST /lol-matchmaking/v1/ready-check/accept`
2. **`LOCK_CHAMPION`** (`championId`):
   - Obtiene sesión en `/lol-champ-select/v1/session`.
   - Busca la acción de `pick` de tu celda (`localPlayerCellId`).
   - Envía `PATCH` a `/lol-champ-select/v1/session/actions/{actionId}` con `championId`.
   - Envía `POST` a `/lol-champ-select/v1/session/actions/{actionId}/complete`.
   - Consulta `/lol-perks/v1/recommended-pages` o `/lol-champ-select/v1/grid-recommendations`.
   - Aplica automáticamente la 1ra página de runas recomendadas (`POST /lol-perks/v1/currentpage`).
   - Aplica los hechizos de invocador recomendados (`PATCH /lol-champ-select/v1/session/my-selection`).

---

## 4. Deploy en Vercel (Para usar desde el celular en cualquier lugar)

El sistema **NO requiere estar en la misma red WiFi**. Como la comunicación se realiza a través de **Supabase Realtime (WebSockets por Internet)**, puedes usar la app web desde tus datos móviles (4G/5G) o cualquier red fuera de casa. El único requisito es que tu PC esté encendida con el juego y el Agente Local corriendo.

### Pasos para Vercel:
1. Importa este repositorio (`barsak34/lol-remote`) en tu cuenta de [Vercel](https://vercel.com).
2. En la configuración del proyecto (**Project Settings**):
   - **Root Directory:** selecciona o escribe `web-app`.
   - **Framework Preset:** `Next.js` (se autodetecta).
3. En **Environment Variables**, añade:
   - `NEXT_PUBLIC_SUPABASE_URL`: Tu URL de Supabase (ej: `https://xyz.supabase.co`).
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`: Tu clave anónima / publicable de Supabase.
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`: Tu clave anónima / publicable de Supabase.
   - `NEXT_PUBLIC_SUPABASE_CHANNEL`: `lol-commands`
4. Haz click en **Deploy**.
5. Abre la URL generada por Vercel (ej: `https://lol-remote-xxx.vercel.app`) en el navegador de tu celular y guárdala en la pantalla de inicio como acceso directo.
