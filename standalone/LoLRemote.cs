using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Net.Security;
using System.Net.WebSockets;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace LoLRemote
{
    class Program
    {
        // Credenciales de Supabase embebidas
        private const string SupabaseUrl = "https://myfehiysehyubgtlvhew.supabase.co";
        private const string SupabaseKey = "sb_publishable_IKuShZGGK5fz-SRXw6QhBg_Hmwk-KAE";

        private static int _lcuPort;
        private static string _lcuPassword;
        private static string _authHeader;
        private static string _roomCode = "";
        private static string _channelTopic = "";
        private static string _summonerName = "Invocador";

        private static ClientWebSocket _ws;
        private static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer();
        private static Dictionary<string, object> _cachedSummoner = null;
        private static int _pendingLockChampionId = 0;
        private static string _pendingLockChampionName = "";
        private static bool _isConnected = false;
        private static string _lastGamePhase = "None";

        public static MainForm MainFormInstance;
        private static Mutex _singleInstanceMutex;

        [STAThread]
        static void Main(string[] args)
        {
            // Evitar múltiples instancias del programa ejecutándose al mismo tiempo
            bool createdNew;
            _singleInstanceMutex = new Mutex(true, "LoLRemote_SingleInstance_Mutex_34", out createdNew);
            if (!createdNew)
            {
                MessageBox.Show("LoL Remote ya se está ejecutando en segundo plano en tu PC.\nRevisa los iconos ocultos al lado del reloj de Windows.",
                    "LoL Remote ya está abierto", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // Ignorar certificados SSL autofirmados de Riot LCU
            ServicePointManager.ServerCertificateValidationCallback =
                (sender, certificate, chain, sslPolicyErrors) => true;
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;

            MainFormInstance = new MainForm();

            // Iniciar tarea en segundo plano para conexión de LoL y Supabase
            Task.Run(() => BackgroundWorkerLoop(args));

            Application.Run(MainFormInstance);

            if (_singleInstanceMutex != null)
            {
                _singleInstanceMutex.ReleaseMutex();
                _singleInstanceMutex = null;
            }
        }

        private static async Task BackgroundWorkerLoop(string[] args)
        {
            Log("🎮 Iniciando LoL Remote Windows Companion...", Color.FromArgb(10, 200, 185));
            Log("Buscando cliente de League of Legends en tu PC...", Color.FromArgb(200, 170, 110));

            while (true)
            {
                try
                {
                    LockfileInfo lockfile = WaitForLockfile();
                    _lcuPort = lockfile.Port;
                    _lcuPassword = lockfile.Password;
                    _authHeader = "Basic " + Convert.ToBase64String(Encoding.ASCII.GetBytes("riot:" + _lcuPassword));

                    Log("✓ League of Legends detectado con éxito!", Color.FromArgb(37, 187, 132));

                    // Obtener Invocador y PUUID
                    string summonerPuuid = "";
                    try
                    {
                        var sumRes = LcuGet("/lol-summoner/v1/current-summoner");
                        if (sumRes != null)
                        {
                            _cachedSummoner = sumRes;
                            var name = sumRes.ContainsKey("gameName") && sumRes["gameName"] != null
                                ? sumRes["gameName"].ToString()
                                : (sumRes.ContainsKey("displayName") && sumRes["displayName"] != null ? sumRes["displayName"].ToString() : "Invocador");
                            var tag = sumRes.ContainsKey("tagLine") && sumRes["tagLine"] != null ? sumRes["tagLine"].ToString() : "LAS";
                            var level = sumRes.ContainsKey("summonerLevel") && sumRes["summonerLevel"] != null ? sumRes["summonerLevel"].ToString() : "?";
                            _summonerName = name + "#" + tag;

                            if (sumRes.ContainsKey("puuid") && sumRes["puuid"] != null)
                            {
                                summonerPuuid = sumRes["puuid"].ToString();
                            }

                            Log("Jugador: " + _summonerName + " (Nivel " + level + ")", Color.FromArgb(240, 230, 210));
                        }
                    }
                    catch { }

                    // Token Único por Cuenta
                    if (args != null && args.Length > 0 && !string.IsNullOrEmpty(args[0]))
                    {
                        _roomCode = CleanRoomCode(args[0]);
                    }
                    else if (!string.IsNullOrEmpty(summonerPuuid))
                    {
                        _roomCode = summonerPuuid.Replace("-", "").Substring(0, 10).ToLower();
                    }
                    else
                    {
                        _roomCode = CleanRoomCode(_summonerName);
                        if (string.IsNullOrEmpty(_roomCode)) _roomCode = "user" + new Random().Next(1000, 9999);
                    }

                    _channelTopic = "realtime:lol-commands-" + _roomCode;

                    string webUrl = "https://lol-remote-tau.vercel.app";
                    string pairLink = string.Format("{0}/?pair={1}", webUrl.TrimEnd('/'), _roomCode);

                    if (MainFormInstance != null)
                    {
                        MainFormInstance.UpdateConnectionInfo(_summonerName, _roomCode, pairLink);
                    }

                    // Comprobar si ya fue emparejado anteriormente
                    CheckSmartPairingLaunch(_summonerName, _roomCode, pairLink);

                    // Conectar a Supabase y escuchar comandos
                    await ConnectAndListenWebSocket();
                }
                catch (Exception ex)
                {
                    Log("Aviso de conexión: " + ex.Message + ". Reintentando en 4s...", Color.FromArgb(232, 64, 87));
                }

                await Task.Delay(4000);
            }
        }

        private static void CheckSmartPairingLaunch(string summoner, string token, string pairUrl)
        {
            try
            {
                string markerPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".lol_remote_paired_" + token);
                if (!File.Exists(markerPath))
                {
                    // Primera vez que se abre con esta cuenta: Mostrar QR automáticamente
                    Log("Primera vez detectada: Abriendo Código QR para vinculación inicial con tu celular...", Color.FromArgb(10, 200, 185));
                    File.WriteAllText(markerPath, DateTime.UtcNow.ToString("o"));
                    OpenPairingQrWindow(summoner, token, pairUrl);
                }
                else
                {
                    // Ya emparejado anteriormente: No abrir molestas pestañas en el navegador
                    Log("✓ PC ya vinculada previamente con el token: " + token + ". Listo para recibir órdenes sin necesidad de reescanear.", Color.FromArgb(37, 187, 132));
                    if (MainFormInstance != null)
                    {
                        MainFormInstance.ShowTrayBalloon("LoL Remote Conectado",
                            "Listo para recibir órdenes de " + summoner + " desde tu celular. El programa sigue activo en segundo plano.", ToolTipIcon.Info);
                    }
                }
            }
            catch { }
        }

        public static void OpenPairingQrWindow(string summoner, string token, string pairUrl)
        {
            try
            {
                string qrImageUrl = "https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=10&data=" + Uri.EscapeDataString(pairUrl);

                string html = @"<!DOCTYPE html>
<html lang=""es"">
<head>
    <meta charset=""UTF-8"">
    <meta name=""viewport"" content=""width=device-width, initial-scale=1.0"">
    <title>Vincular Celular - LoL Remote</title>
    <style>
        body {
            background: #091428;
            color: #f0e6d2;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            padding: 20px;
            box-sizing: border-box;
        }
        .card {
            background: rgba(10, 20, 40, 0.95);
            border: 2px solid #c8aa6e;
            border-radius: 16px;
            padding: 30px;
            max-width: 420px;
            text-align: center;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.7), 0 0 30px rgba(10, 200, 185, 0.2);
        }
        h1 {
            color: #c8aa6e;
            font-size: 1.5rem;
            margin-top: 0;
            text-transform: uppercase;
            letter-spacing: 1.5px;
        }
        p {
            color: #a09b8c;
            font-size: 0.9rem;
            line-height: 1.4;
            margin: 8px 0 20px;
        }
        .qr-wrapper {
            background: #ffffff;
            padding: 12px;
            border-radius: 12px;
            display: inline-block;
            margin: 10px 0;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
        }
        .qr-wrapper img {
            width: 250px;
            height: 250px;
            display: block;
        }
        .pin-badge {
            background: rgba(200, 170, 110, 0.15);
            border: 1px solid #c8aa6e;
            border-radius: 8px;
            padding: 10px;
            margin-top: 15px;
            font-size: 0.85rem;
            color: #f0e6d2;
        }
        .pin-badge strong {
            color: #0ac8b9;
            font-size: 1.1rem;
            letter-spacing: 1px;
            display: block;
            margin-top: 4px;
        }
        .footer {
            font-size: 0.75rem;
            color: #7a7568;
            margin-top: 20px;
        }
    </style>
</head>
<body>
    <div class=""card"">
        <h1>LoL Remote</h1>
        <p>Apunta con la cámara de tu celular al código QR para vincular tu juego:</p>
        
        <div class=""qr-wrapper"">
            <img src=""" + qrImageUrl + @""" alt=""Código QR de Vinculación"">
        </div>

        <div class=""pin-badge"">
            Invocador: " + summoner + @"<br>
            PIN Privado: <strong>" + token + @"</strong>
        </div>

        <div class=""footer"">
            Una vez escaneado, puedes cerrar esta pestaña. Tu celular quedará guardado para siempre.
        </div>
    </div>
</body>
</html>";

                string tempFile = Path.Combine(Path.GetTempPath(), "lol_remote_pairing.html");
                File.WriteAllText(tempFile, html, Encoding.UTF8);
                Process.Start(new ProcessStartInfo(tempFile) { UseShellExecute = true });
            }
            catch { }
        }

        private static string CleanRoomCode(string input)
        {
            if (string.IsNullOrEmpty(input)) return "";
            return Regex.Replace(input, @"[^a-zA-Z0-9]", "").ToLower();
        }

        private static LockfileInfo WaitForLockfile()
        {
            string[] paths = new string[]
            {
                @"C:\Riot Games\League of Legends\lockfile",
                @"E:\Riot Games\League of Legends\lockfile",
                @"D:\Riot Games\League of Legends\lockfile"
            };

            while (true)
            {
                foreach (var p in paths)
                {
                    if (File.Exists(p))
                    {
                        try
                        {
                            using (var fs = new FileStream(p, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                            using (var sr = new StreamReader(fs))
                            {
                                string content = sr.ReadToEnd().Trim();
                                var parts = content.Split(':');
                                if (parts.Length >= 5)
                                {
                                    return new LockfileInfo
                                    {
                                        Process = parts[0],
                                        Pid = int.Parse(parts[1]),
                                        Port = int.Parse(parts[2]),
                                        Password = parts[3],
                                        Protocol = parts[4]
                                    };
                                }
                            }
                        }
                        catch { }
                    }
                }
                Thread.Sleep(2000);
            }
        }

        private static async Task ConnectAndListenWebSocket()
        {
            while (true)
            {
                try
                {
                    Uri u = new Uri(SupabaseUrl);
                    string wsUrl = string.Format("wss://{0}/realtime/v1/websocket?apikey={1}&vsn=1.0.0", u.Host, SupabaseKey);

                    Log("Conectando con el servidor en la nube Supabase...", Color.FromArgb(160, 155, 140));
                    _ws = new ClientWebSocket();
                    _ws.Options.SetRequestHeader("apikey", SupabaseKey);
                    _ws.Options.SetRequestHeader("Authorization", "Bearer " + SupabaseKey);

                    CancellationTokenSource cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
                    await _ws.ConnectAsync(new Uri(wsUrl), cts.Token);

                    _isConnected = true;
                    Log("✓ ¡Conectado a la nube! Canal vinculado: '" + _roomCode + "'", Color.FromArgb(37, 187, 132));

                    if (MainFormInstance != null)
                    {
                        MainFormInstance.SetCloudStatus(true);
                    }

                    // Join Channel
                    var joinMsg = new Dictionary<string, object>
                    {
                        { "topic", _channelTopic },
                        { "event", "phx_join" },
                        { "payload", new Dictionary<string, object>
                            {
                                { "config", new Dictionary<string, object> { { "broadcast", new Dictionary<string, object> { { "self", true }, { "ack", true } } } } },
                                { "access_token", SupabaseKey }
                            }
                        },
                        { "ref", "1" }
                    };
                    await SendWsJson(joinMsg);

                    Log(">>> AGENTE ACTIVO Y LISTO PARA RECIBIR ÓRDENES <<<", Color.FromArgb(10, 200, 185));

                    var cancelSrc = new CancellationTokenSource();
                    var heartbeatTask = Task.Run(() => HeartbeatLoop(cancelSrc.Token));
                    var stateTask = Task.Run(() => GameStateLoop(cancelSrc.Token));

                    byte[] buffer = new byte[16384];
                    while (_ws.State == WebSocketState.Open)
                    {
                        var result = await _ws.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);
                        if (result.MessageType == WebSocketMessageType.Close)
                        {
                            break;
                        }

                        string message = Encoding.UTF8.GetString(buffer, 0, result.Count);
                        HandleIncomingMessage(message);
                    }

                    cancelSrc.Cancel();
                }
                catch (Exception ex)
                {
                    _isConnected = false;
                    if (MainFormInstance != null) MainFormInstance.SetCloudStatus(false);
                    Log("Aviso de conexión: " + ex.Message + ". Reconectando en 3s...", Color.FromArgb(232, 64, 87));
                }

                await Task.Delay(3000);
            }
        }

        private static async Task HeartbeatLoop(CancellationToken token)
        {
            while (!token.IsCancellationRequested && _ws.State == WebSocketState.Open)
            {
                await Task.Delay(25000, token);
                try
                {
                    var hb = new Dictionary<string, object>
                    {
                        { "topic", "phoenix" },
                        { "event", "heartbeat" },
                        { "payload", new Dictionary<string, object>() },
                        { "ref", DateTime.UtcNow.Ticks.ToString() }
                    };
                    await SendWsJson(hb);
                }
                catch { }
            }
        }

        private static async Task GameStateLoop(CancellationToken token)
        {
            while (!token.IsCancellationRequested && _ws.State == WebSocketState.Open)
            {
                try
                {
                    await BroadcastGameState();
                }
                catch { }
                await Task.Delay(1200, token);
            }
        }

        private static async Task BroadcastGameState()
        {
            string phase = "None";
            try
            {
                var phaseRes = LcuGetString("/lol-gameflow/v1/gameflow-phase");
                if (!string.IsNullOrEmpty(phaseRes))
                {
                    phase = phaseRes.Trim('"');
                }
            }
            catch { }

            if (phase != _lastGamePhase)
            {
                _lastGamePhase = phase;
                if (MainFormInstance != null) MainFormInstance.SetLoLPhase(phase);
                Log("Fase actual de LoL: " + phase, Color.FromArgb(240, 230, 210));
            }

            object readyCheck = null;
            if (phase == "ReadyCheck")
            {
                try
                {
                    readyCheck = LcuGet("/lol-matchmaking/v1/ready-check");
                }
                catch { }
            }

            object champSelect = null;
            if (phase == "ChampSelect")
            {
                try
                {
                    var session = LcuGet("/lol-champ-select/v1/session");
                    if (session != null)
                    {
                        int localCellId = Convert.ToInt32(session["localPlayerCellId"]);
                        bool isMyTurn = false;
                        if (session.ContainsKey("actions"))
                        {
                            var actionGroups = session["actions"] as object[];
                            if (actionGroups != null)
                            {
                                foreach (var group in actionGroups)
                                {
                                    var acts = group as object[];
                                    if (acts != null)
                                    {
                                        foreach (var a in acts)
                                        {
                                            var actDict = a as Dictionary<string, object>;
                                            if (actDict != null &&
                                                Convert.ToInt32(actDict["actorCellId"]) == localCellId &&
                                                actDict.ContainsKey("type") && actDict["type"] != null && actDict["type"].ToString() == "pick" &&
                                                !Convert.ToBoolean(actDict["completed"]) &&
                                                actDict.ContainsKey("isInProgress") && Convert.ToBoolean(actDict["isInProgress"]))
                                            {
                                                isMyTurn = true;
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        champSelect = new Dictionary<string, object>
                        {
                            { "localPlayerCellId", localCellId },
                            { "isMyTurn", isMyTurn },
                            { "hasSession", true }
                        };

                        // Auto-lock si el usuario seleccionó un campeón antes de que fuera su turno
                        if (isMyTurn && _pendingLockChampionId > 0)
                        {
                            int cid = _pendingLockChampionId;
                            string cname = _pendingLockChampionName;
                            _pendingLockChampionId = 0;
                            _pendingLockChampionName = "";
                            Log("[Auto-Lock] ¡Llegó tu turno! Fijando automáticamente a " + cname + "...", Color.FromArgb(200, 170, 110));
                            ThreadPool.QueueUserWorkItem((state) => LockChampion(cid, cname));
                        }
                    }
                }
                catch { }
            }
            else if (phase != "None")
            {
                _pendingLockChampionId = 0;
                _pendingLockChampionName = "";
            }

            var broadcastPayload = new Dictionary<string, object>
            {
                { "type", "broadcast" },
                { "event", "GAME_STATE" },
                { "payload", new Dictionary<string, object>
                    {
                        { "online", true },
                        { "lolRunning", true },
                        { "summoner", _cachedSummoner },
                        { "phase", phase },
                        { "readyCheck", readyCheck },
                        { "champSelect", champSelect },
                        { "timestamp", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() }
                    }
                }
            };

            var frame = new Dictionary<string, object>
            {
                { "topic", _channelTopic },
                { "event", "broadcast" },
                { "payload", broadcastPayload },
                { "ref", null }
            };

            await SendWsJson(frame);
        }

        private static void HandleIncomingMessage(string json)
        {
            try
            {
                var dict = Serializer.Deserialize<Dictionary<string, object>>(json);
                if (dict == null || !dict.ContainsKey("event")) return;

                string ev = dict["event"] != null ? dict["event"].ToString() : "";
                if (ev == "broadcast" && dict.ContainsKey("payload"))
                {
                    var payloadDict = dict["payload"] as Dictionary<string, object>;
                    if (payloadDict != null && payloadDict.ContainsKey("event"))
                    {
                        string subEvent = payloadDict["event"] != null ? payloadDict["event"].ToString() : "";
                        var data = payloadDict.ContainsKey("payload") ? payloadDict["payload"] as Dictionary<string, object> : null;

                        if (subEvent == "ACCEPT_MATCH")
                        {
                            Log("[Orden Recibida Celular] ACEPTAR PARTIDA...", Color.FromArgb(200, 170, 110));
                            AcceptMatch();
                        }
                        else if (subEvent == "LOCK_CHAMPION" && data != null)
                        {
                            int championId = Convert.ToInt32(data["championId"]);
                            string name = data.ContainsKey("championName") && data["championName"] != null ? data["championName"].ToString() : championId.ToString();
                            Log("[Orden Recibida Celular] FIJAR CAMPEÓN: " + name + " (ID: " + championId + ")...", Color.FromArgb(200, 170, 110));
                            LockChampion(championId, name);
                        }
                        else if (subEvent == "HOVER_CHAMPION" && data != null)
                        {
                            int championId = Convert.ToInt32(data["championId"]);
                            string name = data.ContainsKey("championName") && data["championName"] != null ? data["championName"].ToString() : championId.ToString();
                            HoverChampion(championId, name);
                        }
                    }
                }
            }
            catch { }
        }

        private static void AcceptMatch()
        {
            try
            {
                int sc; string resp;
                bool ok = LcuTryRequest("POST", "/lol-matchmaking/v1/ready-check/accept", null, out sc, out resp);
                if (ok)
                {
                    Log(">>> [ÉXITO] ¡Partida Aceptada en League of Legends!", Color.FromArgb(37, 187, 132));
                    SendActionResult("ACCEPT_MATCH", true, "¡Partida aceptada exitosamente en LoL!");
                }
                else
                {
                    Log("[Aviso] No se pudo aceptar (status " + sc + "): " + resp, Color.FromArgb(232, 64, 87));
                    SendActionResult("ACCEPT_MATCH", false, "No hay partida activa para aceptar en este momento.");
                }
            }
            catch (Exception ex)
            {
                Log("[Aviso] No se pudo aceptar: " + ex.Message, Color.FromArgb(232, 64, 87));
                SendActionResult("ACCEPT_MATCH", false, "No hay partida activa para aceptar en este momento.");
            }
        }

        private static void HoverChampion(int championId, string champName)
        {
            try
            {
                var session = LcuGet("/lol-champ-select/v1/session");
                if (session == null) return;

                int localCellId = Convert.ToInt32(session["localPlayerCellId"]);
                int pickActionId = -1;

                if (session.ContainsKey("actions"))
                {
                    var actionGroups = session["actions"] as object[];
                    if (actionGroups != null)
                    {
                        foreach (var group in actionGroups)
                        {
                            var acts = group as object[];
                            if (acts != null)
                            {
                                foreach (var a in acts)
                                {
                                    var actDict = a as Dictionary<string, object>;
                                    if (actDict != null &&
                                        Convert.ToInt32(actDict["actorCellId"]) == localCellId &&
                                        actDict.ContainsKey("type") && actDict["type"] != null && actDict["type"].ToString() == "pick" &&
                                        !Convert.ToBoolean(actDict["completed"]))
                                    {
                                        pickActionId = Convert.ToInt32(actDict["id"]);
                                        break;
                                    }
                                }
                            }
                            if (pickActionId != -1) break;
                        }
                    }
                }

                int sc; string resText;
                var hoverBody = Serializer.Serialize(new Dictionary<string, object> { { "championId", championId } });
                if (pickActionId != -1)
                {
                    LcuTryRequest("PATCH", "/lol-champ-select/v1/session/actions/" + pickActionId, hoverBody, out sc, out resText);
                }
                LcuTryRequest("PATCH", "/lol-champ-select/v1/session/my-selection", hoverBody, out sc, out resText);
                Log("[Hover] Preseleccionando a " + champName + " en el juego.", Color.FromArgb(160, 155, 140));
            }
            catch { }
        }

        private static void LockChampion(int championId, string champName)
        {
            try
            {
                var session = LcuGet("/lol-champ-select/v1/session");
                if (session == null)
                {
                    string phase = LcuGetString("/lol-gameflow/v1/gameflow-phase");
                    if (!string.IsNullOrEmpty(phase)) phase = phase.Trim('"');
                    Log("[Aviso] Intento de fijar campeón pero no estás en ChampSelect (fase actual: " + phase + ")", Color.FromArgb(232, 64, 87));
                    SendActionResult("LOCK_CHAMPION", false, "No estás en la selección de campeón en LoL.");
                    return;
                }

                int localCellId = Convert.ToInt32(session["localPlayerCellId"]);
                int activeActionId = -1;
                int pendingActionId = -1;

                if (session.ContainsKey("actions"))
                {
                    var actionGroups = session["actions"] as object[];
                    if (actionGroups != null)
                    {
                        foreach (var group in actionGroups)
                        {
                            var acts = group as object[];
                            if (acts != null)
                            {
                                foreach (var a in acts)
                                {
                                    var actDict = a as Dictionary<string, object>;
                                    if (actDict != null &&
                                        Convert.ToInt32(actDict["actorCellId"]) == localCellId &&
                                        actDict.ContainsKey("type") && actDict["type"] != null && actDict["type"].ToString() == "pick" &&
                                        !Convert.ToBoolean(actDict["completed"]))
                                    {
                                        int aId = Convert.ToInt32(actDict["id"]);
                                        bool inProg = actDict.ContainsKey("isInProgress") && Convert.ToBoolean(actDict["isInProgress"]);
                                        if (inProg)
                                        {
                                            activeActionId = aId;
                                            break;
                                        }
                                        else if (pendingActionId == -1)
                                        {
                                            pendingActionId = aId;
                                        }
                                    }
                                }
                            }
                            if (activeActionId != -1) break;
                        }
                    }
                }

                // Caso 1: Turno activo de selección (isInProgress == true)
                if (activeActionId != -1)
                {
                    int sc; string resText;

                    // Hover
                    var hoverBody = Serializer.Serialize(new Dictionary<string, object> { { "championId", championId } });
                    LcuTryRequest("PATCH", "/lol-champ-select/v1/session/actions/" + activeActionId, hoverBody, out sc, out resText);

                    // Lock-in
                    var lockBody = Serializer.Serialize(new Dictionary<string, object>
                    {
                        { "championId", championId },
                        { "completed", true }
                    });
                    bool locked = LcuTryRequest("PATCH", "/lol-champ-select/v1/session/actions/" + activeActionId, lockBody, out sc, out resText);

                    if (!locked)
                    {
                        LcuTryRequest("POST", "/lol-champ-select/v1/session/actions/" + activeActionId + "/complete", "{}", out sc, out resText);
                    }

                    _pendingLockChampionId = 0;
                    _pendingLockChampionName = "";

                    Log(">>> [ÉXITO] ¡" + champName + " FIJADO EN TU PARTIDA!", Color.FromArgb(37, 187, 132));
                    SendActionResult("LOCK_CHAMPION", true, "¡" + champName + " fijado con éxito! Configurando runas...");

                    ApplyRunesAndSpellsAsync(championId);
                    return;
                }

                // Caso 2: En Draft pero esperando turno (preseleccionar y auto-lock)
                if (pendingActionId != -1)
                {
                    int sc; string resText;
                    var hoverBody = Serializer.Serialize(new Dictionary<string, object> { { "championId", championId } });
                    LcuTryRequest("PATCH", "/lol-champ-select/v1/session/actions/" + pendingActionId, hoverBody, out sc, out resText);
                    LcuTryRequest("PATCH", "/lol-champ-select/v1/session/my-selection", hoverBody, out sc, out resText);

                    _pendingLockChampionId = championId;
                    _pendingLockChampionName = champName;

                    Log(">>> [Preselección] " + champName + " preseleccionado. Se fijará automáticamente al comenzar tu turno.", Color.FromArgb(10, 200, 185));
                    SendActionResult("LOCK_CHAMPION", true, "¡" + champName + " preseleccionado! Se fijará automáticamente al comenzar tu turno.");

                    ApplyRunesAndSpellsAsync(championId);
                    return;
                }

                // Caso 3: Modos especiales (Blind Pick, ARAM, partidas sin acciones draft)
                {
                    int sc; string resText;
                    var mySelBody = Serializer.Serialize(new Dictionary<string, object> { { "championId", championId } });
                    bool selOk = LcuTryRequest("PATCH", "/lol-champ-select/v1/session/my-selection", mySelBody, out sc, out resText);

                    if (selOk)
                    {
                        Log(">>> [ÉXITO] Campeón seleccionado en my-selection.", Color.FromArgb(37, 187, 132));
                        SendActionResult("LOCK_CHAMPION", true, "¡" + champName + " seleccionado con éxito!");
                        ApplyRunesAndSpellsAsync(championId);
                    }
                    else
                    {
                        Log("[Aviso] No se encontró turno de selección ni acción para fijar.", Color.FromArgb(232, 64, 87));
                        SendActionResult("LOCK_CHAMPION", false, "No es tu turno de selección o ya tienes tu campeón fijado.");
                    }
                }
            }
            catch (Exception ex)
            {
                Log("[Error LockChampion] " + ex.Message, Color.FromArgb(232, 64, 87));
                SendActionResult("LOCK_CHAMPION", false, "Error en el cliente de LoL: " + ex.Message);
            }
        }

        private static void ApplyRunesAndSpellsAsync(int championId)
        {
            Task.Run(async () =>
            {
                await Task.Delay(600);
                try
                {
                    // 1. Runas recomendadas
                    var recPages = LcuGetList("/lol-perks/v1/recommended-pages?championId=" + championId);
                    bool runeOk = false;
                    if (recPages != null && recPages.Count > 0)
                    {
                        int sc; string resText;
                        runeOk = LcuTryRequest("POST", "/lol-perks/v1/currentpage", Serializer.Serialize(recPages[0]), out sc, out resText);
                        if (runeOk) Log("✓ Página de runas recomendadas aplicada.", Color.FromArgb(37, 187, 132));
                    }

                    // 2. Hechizos y Runas de Champ Select Grid
                    var grid = LcuGetList("/lol-champ-select/v1/grid-recommendations");
                    if (grid != null && grid.Count > 0)
                    {
                        var first = grid[0] as Dictionary<string, object>;
                        if (first != null)
                        {
                            if (!runeOk && first.ContainsKey("recommendedPerkPages"))
                            {
                                var perkPages = first["recommendedPerkPages"] as object[];
                                if (perkPages != null && perkPages.Length > 0)
                                {
                                    int sc; string resText;
                                    LcuTryRequest("POST", "/lol-perks/v1/currentpage", Serializer.Serialize(perkPages[0]), out sc, out resText);
                                }
                            }

                            if (first.ContainsKey("recommendedSpells"))
                            {
                                var spells = first["recommendedSpells"] as object[];
                                if (spells != null && spells.Length > 0)
                                {
                                    var sDict = spells[0] as Dictionary<string, object>;
                                    if (sDict != null)
                                    {
                                        int sc; string resText;
                                        LcuTryRequest("PATCH", "/lol-champ-select/v1/session/my-selection",
                                            Serializer.Serialize(new Dictionary<string, object>
                                            {
                                                { "spell1Id", sDict["spell1Id"] },
                                                { "spell2Id", sDict["spell2Id"] }
                                            }), out sc, out resText);
                                        Log("✓ Hechizos recomendados asignados (D/F).", Color.FromArgb(37, 187, 132));
                                    }
                                }
                            }
                        }
                    }
                }
                catch (Exception ex)
                {
                    Log("[Aviso Runas] " + ex.Message, Color.FromArgb(232, 64, 87));
                }
            });
        }

        private static void SendActionResult(string action, bool success, string message)
        {
            try
            {
                var payload = new Dictionary<string, object>
                {
                    { "type", "broadcast" },
                    { "event", "ACTION_RESULT" },
                    { "payload", new Dictionary<string, object>
                        {
                            { "action", action },
                            { "success", success },
                            { "message", message }
                        }
                    }
                };
                var frame = new Dictionary<string, object>
                {
                    { "topic", _channelTopic },
                    { "event", "broadcast" },
                    { "payload", payload },
                    { "ref", null }
                };
                ThreadPool.QueueUserWorkItem((s) => { SendWsJson(frame).Wait(); });
            }
            catch { }
        }

        private static async Task SendWsJson(object obj)
        {
            if (_ws == null || _ws.State != WebSocketState.Open) return;
            string json = Serializer.Serialize(obj);
            byte[] bytes = Encoding.UTF8.GetBytes(json);
            await _ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None);
        }

        private static Dictionary<string, object> LcuGet(string endpoint)
        {
            string json = LcuRequest("GET", endpoint, null);
            if (string.IsNullOrEmpty(json)) return null;
            try
            {
                return Serializer.Deserialize<Dictionary<string, object>>(json);
            }
            catch
            {
                return null;
            }
        }

        private static List<object> LcuGetList(string endpoint)
        {
            string json = LcuRequest("GET", endpoint, null);
            if (string.IsNullOrEmpty(json)) return null;
            try
            {
                var arr = Serializer.Deserialize<object[]>(json);
                if (arr != null) return new List<object>(arr);
                var list = Serializer.Deserialize<List<object>>(json);
                return list;
            }
            catch
            {
                return null;
            }
        }

        private static string LcuGetString(string endpoint)
        {
            return LcuRequest("GET", endpoint, null);
        }

        private static string LcuRequest(string method, string endpoint, string body)
        {
            int code;
            string resp;
            LcuTryRequest(method, endpoint, body, out code, out resp);
            return resp;
        }

        private static bool LcuTryRequest(string method, string endpoint, string body, out int statusCode, out string responseText)
        {
            statusCode = 0;
            responseText = "";
            try
            {
                string url = string.Format("https://127.0.0.1:{0}{1}", _lcuPort, endpoint);
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = method;
                req.Headers["Authorization"] = _authHeader;
                req.Accept = "application/json";
                req.Timeout = 6000;

                if (body != null)
                {
                    req.ContentType = "application/json";
                    byte[] bytes = Encoding.UTF8.GetBytes(body);
                    req.ContentLength = bytes.Length;
                    using (var stream = req.GetRequestStream())
                    {
                        stream.Write(bytes, 0, bytes.Length);
                    }
                }

                using (var resp = (HttpWebResponse)req.GetResponse())
                {
                    statusCode = (int)resp.StatusCode;
                    using (var stream = resp.GetResponseStream())
                    {
                        if (stream != null)
                        {
                            using (var sr = new StreamReader(stream))
                            {
                                responseText = sr.ReadToEnd();
                            }
                        }
                    }
                    return statusCode >= 200 && statusCode < 300;
                }
            }
            catch (WebException wex)
            {
                var errResp = wex.Response as HttpWebResponse;
                if (errResp != null)
                {
                    statusCode = (int)errResp.StatusCode;
                    try
                    {
                        using (var stream = errResp.GetResponseStream())
                        {
                            if (stream != null)
                            {
                                using (var sr = new StreamReader(stream))
                                {
                                    responseText = sr.ReadToEnd();
                                }
                            }
                        }
                    }
                    catch { }
                }
                return false;
            }
            catch (Exception ex)
            {
                responseText = ex.Message;
                return false;
            }
        }

        public static void Log(string message, Color? color = null)
        {
            string ts = DateTime.Now.ToString("HH:mm:ss");
            string full = string.Format("[{0}] {1}", ts, message);

            if (MainFormInstance != null && !MainFormInstance.IsDisposed)
            {
                MainFormInstance.AppendLog(full, color ?? Color.FromArgb(240, 230, 210));
            }
        }
    }

    public class MainForm : Form
    {
        private Label _lblHeader;
        private Label _lblSub;
        private Label _lblStatusBadge;
        private RichTextBox _rtbLogs;
        private Button _btnQr;
        private Button _btnWeb;
        private Button _btnHide;
        private Button _btnExit;
        private NotifyIcon _trayIcon;
        private ContextMenu _trayMenu;

        private string _currentSummoner = "Invocador";
        private string _currentRoom = "";
        private string _pairLink = "https://lol-remote-tau.vercel.app";

        public MainForm()
        {
            InitializeComponent();
        }

        private void InitializeComponent()
        {
            this.Text = "LoL Remote - Windows Agent";
            this.Size = new Size(560, 480);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.BackColor = Color.FromArgb(9, 20, 40);
            this.ForeColor = Color.FromArgb(240, 230, 210);
            this.FormBorderStyle = FormBorderStyle.FixedSingle;
            this.MaximizeBox = false;

            // Generar icono Hextech nativo en memoria
            Icon hextechIcon = CreateHextechIcon();
            this.Icon = hextechIcon;

            // Top Header Panel
            Panel topPanel = new Panel
            {
                Dock = DockStyle.Top,
                Height = 85,
                BackColor = Color.FromArgb(11, 22, 42),
                Padding = new Padding(16, 12, 16, 12)
            };

            _lblHeader = new Label
            {
                Text = "⚡ LoL Remote - Agente Windows",
                Font = new Font("Segoe UI", 13f, FontStyle.Bold),
                ForeColor = Color.FromArgb(200, 170, 110),
                AutoSize = true,
                Location = new Point(16, 12)
            };

            _lblSub = new Label
            {
                Text = "Buscando cliente de League of Legends en tu PC...",
                Font = new Font("Segoe UI", 8.5f),
                ForeColor = Color.FromArgb(160, 155, 140),
                AutoSize = true,
                Location = new Point(18, 38)
            };

            _lblStatusBadge = new Label
            {
                Text = "● CONECTANDO...",
                Font = new Font("Segoe UI", 8.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(200, 170, 110),
                AutoSize = true,
                Location = new Point(18, 58)
            };

            topPanel.Controls.Add(_lblHeader);
            topPanel.Controls.Add(_lblSub);
            topPanel.Controls.Add(_lblStatusBadge);

            // Center Log Box
            _rtbLogs = new RichTextBox
            {
                Dock = DockStyle.Fill,
                BackColor = Color.FromArgb(5, 10, 20),
                ForeColor = Color.FromArgb(240, 230, 210),
                Font = new Font("Consolas", 9f),
                ReadOnly = true,
                BorderStyle = BorderStyle.None,
                ScrollBars = RichTextBoxScrollBars.Vertical
            };

            // Bottom Button Panel
            Panel bottomPanel = new Panel
            {
                Dock = DockStyle.Bottom,
                Height = 55,
                BackColor = Color.FromArgb(11, 22, 42),
                Padding = new Padding(12, 10, 12, 10)
            };

            _btnQr = CreateStyledButton("📱 Ver Código QR", 12, 10, 130);
            _btnQr.Click += (s, e) =>
            {
                Program.OpenPairingQrWindow(_currentSummoner, _currentRoom, _pairLink);
            };

            _btnWeb = CreateStyledButton("🌐 Abrir App Web", 150, 10, 125);
            _btnWeb.Click += (s, e) =>
            {
                try { Process.Start(new ProcessStartInfo(_pairLink) { UseShellExecute = true }); } catch { }
            };

            _btnHide = CreateStyledButton("🔽 Ocultar a Bandeja", 283, 10, 145);
            _btnHide.Click += (s, e) =>
            {
                this.Hide();
                ShowTrayBalloon("LoL Remote", "Sigue funcionando en segundo plano aquí al lado del reloj.", ToolTipIcon.Info);
            };

            _btnExit = CreateStyledButton("✕ Salir", 436, 10, 95);
            _btnExit.BackColor = Color.FromArgb(40, 15, 20);
            _btnExit.ForeColor = Color.FromArgb(232, 64, 87);
            _btnExit.Click += (s, e) =>
            {
                ExitApplication();
            };

            bottomPanel.Controls.Add(_btnQr);
            bottomPanel.Controls.Add(_btnWeb);
            bottomPanel.Controls.Add(_btnHide);
            bottomPanel.Controls.Add(_btnExit);

            this.Controls.Add(_rtbLogs);
            this.Controls.Add(topPanel);
            this.Controls.Add(bottomPanel);

            // Context Menu de Bandeja del Sistema
            _trayMenu = new ContextMenu();
            _trayMenu.MenuItems.Add(new MenuItem("📱 Vincular Celular (Código QR)", (s, e) => Program.OpenPairingQrWindow(_currentSummoner, _currentRoom, _pairLink)));
            _trayMenu.MenuItems.Add(new MenuItem("🌐 Abrir App Web en Navegador", (s, e) => { try { Process.Start(new ProcessStartInfo(_pairLink) { UseShellExecute = true }); } catch { } }));
            _trayMenu.MenuItems.Add(new MenuItem("📋 Copiar PIN Privado", (s, e) => { if (!string.IsNullOrEmpty(_currentRoom)) Clipboard.SetText(_currentRoom); }));
            _trayMenu.MenuItems.Add(new MenuItem("-"));
            _trayMenu.MenuItems.Add(new MenuItem("🖥️ Mostrar Panel", (s, e) => RestoreWindow()));
            _trayMenu.MenuItems.Add(new MenuItem("-"));
            _trayMenu.MenuItems.Add(new MenuItem("❌ Salir de LoL Remote", (s, e) => ExitApplication()));

            // NotifyIcon en la barra de tareas
            _trayIcon = new NotifyIcon
            {
                Icon = hextechIcon,
                Text = "LoL Remote - Conectado",
                Visible = true,
                ContextMenu = _trayMenu
            };

            _trayIcon.DoubleClick += (s, e) =>
            {
                if (this.Visible) this.Hide();
                else RestoreWindow();
            };
        }

        private Button CreateStyledButton(string text, int x, int y, int width)
        {
            Button btn = new Button
            {
                Text = text,
                Location = new Point(x, y),
                Size = new Size(width, 34),
                BackColor = Color.FromArgb(20, 35, 60),
                ForeColor = Color.FromArgb(240, 230, 210),
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 8.5f, FontStyle.Bold),
                Cursor = Cursors.Hand
            };
            btn.FlatAppearance.BorderColor = Color.FromArgb(200, 170, 110);
            btn.FlatAppearance.BorderSize = 1;
            return btn;
        }

        public void RestoreWindow()
        {
            if (this.InvokeRequired)
            {
                this.Invoke(new Action(RestoreWindow));
                return;
            }
            this.Show();
            this.WindowState = FormWindowState.Normal;
            this.BringToFront();
            this.Activate();
        }

        public void ExitApplication()
        {
            if (_trayIcon != null)
            {
                _trayIcon.Visible = false;
                _trayIcon.Dispose();
            }
            Application.Exit();
            Environment.Exit(0);
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            // Al hacer clic en la X de la ventana, NO se apaga el proceso: se minimiza a la bandeja del sistema
            if (e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                this.Hide();
                ShowTrayBalloon("LoL Remote sigue activo",
                    "El agente continúa funcionando en segundo plano aquí al lado del reloj.", ToolTipIcon.Info);
            }
            else
            {
                base.OnFormClosing(e);
            }
        }

        public void ShowTrayBalloon(string title, string text, ToolTipIcon icon)
        {
            if (_trayIcon != null && _trayIcon.Visible)
            {
                _trayIcon.ShowBalloonTip(3000, title, text, icon);
            }
        }

        public void UpdateConnectionInfo(string summoner, string roomCode, string pairUrl)
        {
            if (this.InvokeRequired)
            {
                this.Invoke(new Action(() => UpdateConnectionInfo(summoner, roomCode, pairUrl)));
                return;
            }
            _currentSummoner = summoner;
            _currentRoom = roomCode;
            _pairLink = pairUrl;
            _lblSub.Text = string.Format("Jugador: {0} | PIN Privado: {1}", summoner, roomCode);
            if (_trayIcon != null)
            {
                _trayIcon.Text = ("LoL Remote: " + summoner).Substring(0, Math.Min(63, ("LoL Remote: " + summoner).Length));
            }
        }

        public void SetCloudStatus(bool online)
        {
            if (this.InvokeRequired)
            {
                this.Invoke(new Action(() => SetCloudStatus(online)));
                return;
            }
            if (online)
            {
                _lblStatusBadge.Text = "● NUBE CONECTADA (LISTO)";
                _lblStatusBadge.ForeColor = Color.FromArgb(37, 187, 132);
            }
            else
            {
                _lblStatusBadge.Text = "● RECONECTANDO A LA NUBE...";
                _lblStatusBadge.ForeColor = Color.FromArgb(232, 64, 87);
            }
        }

        public void SetLoLPhase(string phase)
        {
            if (this.InvokeRequired)
            {
                this.Invoke(new Action(() => SetLoLPhase(phase)));
                return;
            }
            string text = phase;
            switch (phase)
            {
                case "Lobby": text = "En Sala / Lobby"; break;
                case "Matchmaking": text = "Buscando Partida..."; break;
                case "ReadyCheck": text = "¡Partida Encontrada!"; break;
                case "ChampSelect": text = "En Selección de Campeón"; break;
                case "InProgress": text = "En Partida"; break;
                case "None": text = "En Menú Principal"; break;
            }
            _lblStatusBadge.Text = string.Format("● NUBE CONECTADA | {0}", text);
            _lblStatusBadge.ForeColor = Color.FromArgb(10, 200, 185);
        }

        public void AppendLog(string message, Color color)
        {
            if (_rtbLogs == null || _rtbLogs.IsDisposed) return;
            if (_rtbLogs.InvokeRequired)
            {
                _rtbLogs.Invoke(new Action(() => AppendLog(message, color)));
                return;
            }

            _rtbLogs.SelectionStart = _rtbLogs.TextLength;
            _rtbLogs.SelectionLength = 0;
            _rtbLogs.SelectionColor = color;
            _rtbLogs.AppendText(message + "\r\n");
            _rtbLogs.SelectionColor = _rtbLogs.ForeColor;
            _rtbLogs.ScrollToCaret();
        }

        private Icon CreateHextechIcon()
        {
            try
            {
                using (var bmp = new Bitmap(32, 32))
                using (var g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.Clear(Color.FromArgb(9, 20, 40));
                    using (var goldPen = new Pen(Color.FromArgb(200, 170, 110), 2.5f))
                    {
                        g.DrawEllipse(goldPen, 3, 3, 25, 25);
                    }
                    using (var cyanPen = new Pen(Color.FromArgb(10, 200, 185), 1.5f))
                    {
                        g.DrawEllipse(cyanPen, 7, 7, 17, 17);
                    }
                    using (var font = new Font("Arial", 10f, FontStyle.Bold, GraphicsUnit.Pixel))
                    using (var brush = new SolidBrush(Color.FromArgb(240, 230, 210)))
                    using (var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
                    {
                        g.DrawString("LR", font, brush, new RectangleF(0, 0, 32, 32), sf);
                    }
                    IntPtr hIcon = bmp.GetHicon();
                    return Icon.FromHandle(hIcon);
                }
            }
            catch
            {
                return SystemIcons.Application;
            }
        }
    }

    class LockfileInfo
    {
        public string Process { get; set; }
        public int Pid { get; set; }
        public int Port { get; set; }
        public string Password { get; set; }
        public string Protocol { get; set; }
    }
}
