using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Security;
using System.Net.WebSockets;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace LoLRemote
{
    class Program
    {
        // Credenciales de Supabase embebidas (no requiere ningún archivo .env para tu amigo)
        private const string SupabaseUrl = "https://myfehiysehyubgtlvhew.supabase.co";
        private const string SupabaseKey = "sb_publishable_IKuShZGGK5fz-SRXw6QhBg_Hmwk-KAE";

        private static int _lcuPort;
        private static string _lcuPassword;
        private static string _authHeader;
        private static string _roomCode = "";
        private static string _channelTopic = "";

        private static ClientWebSocket _ws;
        private static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer();
        private static Dictionary<string, object> _cachedSummoner = null;

        static void Main(string[] args)
        {
            Console.Title = "LoL Remote - Agente Windows";
            Console.ForegroundColor = ConsoleColor.Cyan;
            Console.WriteLine("========================================================================");
            Console.WriteLine("                     🎮 LoL Remote - Windows Agent                     ");
            Console.WriteLine("========================================================================");
            Console.ResetColor();

            // Ignorar certificados SSL autofirmados de Riot LCU
            ServicePointManager.ServerCertificateValidationCallback = 
                (sender, certificate, chain, sslPolicyErrors) => true;
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;

            // 1. Detectar League of Legends
            Console.WriteLine("\n[1/3] Buscando cliente de League of Legends en tu PC...");
            LockfileInfo lockfile = WaitForLockfile();
            _lcuPort = lockfile.Port;
            _lcuPassword = lockfile.Password;
            _authHeader = "Basic " + Convert.ToBase64String(Encoding.ASCII.GetBytes("riot:" + _lcuPassword));

            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine("[✓] League of Legends detectado con éxito!");
            Console.ResetColor();

            // Consultar datos del invocador
            string summonerName = "Invocador";
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
                    summonerName = name;

                    Console.ForegroundColor = ConsoleColor.Yellow;
                    Console.WriteLine("    Jugador: " + name + "#" + tag + " (Nivel " + level + ")");
                    Console.ResetColor();
                }
            }
            catch { }

            // 2. Determinar Código de Sala (Room Code)
            if (args.Length > 0 && !string.IsNullOrEmpty(args[0]))
            {
                _roomCode = CleanRoomCode(args[0]);
            }
            else
            {
                // Limpiar nombre de invocador para que sirva de código fácil
                _roomCode = CleanRoomCode(summonerName);
                if (string.IsNullOrEmpty(_roomCode)) _roomCode = "amigo";
            }

            _channelTopic = "realtime:lol-commands-" + _roomCode;

            // 3. Banner de Instrucciones para el Amigo
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine("\n========================================================================");
            Console.WriteLine("               📲 CÓMO USAR EN TU TELÉFONO CELULAR                      ");
            Console.WriteLine("========================================================================");
            Console.ResetColor();
            Console.WriteLine("1. Abre la web en el navegador de tu celular.");
            Console.WriteLine("2. Toca arriba a la derecha donde dice:  🔑 Sala");
            Console.ForegroundColor = ConsoleColor.Yellow;
            Console.WriteLine("3. Escribe tu Código de Sala:            " + _roomCode);
            Console.ResetColor();
            Console.WriteLine("4. Presiona Guardar ¡Y LISTO! Tu celular ya controla este LoL.");
            Console.WriteLine("========================================================================\n");

            // 4. Iniciar bucle de WebSocket y Estado en paralelo
            Task.Run(() => ConnectAndListenWebSocket()).Wait();
        }

        private static string CleanRoomCode(string input)
        {
            if (string.IsNullOrEmpty(input)) return "";
            string cleaned = Regex.Replace(input, @"[^a-zA-Z0-9]", "").ToLower();
            return cleaned;
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
                Console.Write(".");
                Thread.Sleep(1500);
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

                    Console.WriteLine("[Supabase] Conectando servidor en la nube...");
                    _ws = new ClientWebSocket();
                    _ws.Options.SetRequestHeader("apikey", SupabaseKey);
                    _ws.Options.SetRequestHeader("Authorization", "Bearer " + SupabaseKey);

                    CancellationTokenSource cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
                    await _ws.ConnectAsync(new Uri(wsUrl), cts.Token);

                    Console.ForegroundColor = ConsoleColor.Green;
                    Console.WriteLine("[✓] Conectado a Supabase Realtime! Vinculando sala: '" + _roomCode + "'...");
                    Console.ResetColor();

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

                    Console.ForegroundColor = ConsoleColor.Cyan;
                    Console.WriteLine(">>> AGENTE LISTO Y ESPERANDO ÓRDENES DESDE TU CELULAR <<<\n");
                    Console.ResetColor();

                    // Iniciar Tareas de Heartbeat y Loop de Estado
                    var cancelSrc = new CancellationTokenSource();
                    var heartbeatTask = Task.Run(() => HeartbeatLoop(cancelSrc.Token));
                    var stateTask = Task.Run(() => GameStateLoop(cancelSrc.Token));

                    // Loop de Recepción de Comandos
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
                    Console.WriteLine("[Aviso] Conexión interrumpida: " + ex.Message + ". Reconectando en 3s...");
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
                                                Convert.ToBoolean(actDict["isInProgress"]))
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
                    }
                }
                catch { }
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
                            Console.ForegroundColor = ConsoleColor.Yellow;
                            Console.WriteLine("\n[Órden Recibida] ACEPTAR PARTIDA...");
                            Console.ResetColor();
                            AcceptMatch();
                        }
                        else if (subEvent == "LOCK_CHAMPION" && data != null)
                        {
                            int championId = Convert.ToInt32(data["championId"]);
                            string name = data.ContainsKey("championName") && data["championName"] != null ? data["championName"].ToString() : championId.ToString();
                            Console.ForegroundColor = ConsoleColor.Yellow;
                            Console.WriteLine("\n[Órden Recibida] FIJAR CAMPEÓN: " + name + " (ID: " + championId + ")...");
                            Console.ResetColor();
                            LockChampion(championId);
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
                var res = LcuRequest("POST", "/lol-matchmaking/v1/ready-check/accept", null);
                Console.ForegroundColor = ConsoleColor.Green;
                Console.WriteLine(">>> [Éxito] ¡Partida Aceptada en League of Legends!");
                Console.ResetColor();
                SendActionResult("ACCEPT_MATCH", true, "¡Partida aceptada exitosamente en LoL!");
            }
            catch (Exception ex)
            {
                Console.WriteLine("[Aviso] No se pudo aceptar: " + ex.Message);
                SendActionResult("ACCEPT_MATCH", false, "No hay partida activa para aceptar en este momento.");
            }
        }

        private static void LockChampion(int championId)
        {
            try
            {
                var session = LcuGet("/lol-champ-select/v1/session");
                if (session == null)
                {
                    SendActionResult("LOCK_CHAMPION", false, "No estás en selección de campeón.");
                    return;
                }

                int localCellId = Convert.ToInt32(session["localPlayerCellId"]);
                int targetActionId = -1;

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
                                        targetActionId = Convert.ToInt32(actDict["id"]);
                                        break;
                                    }
                                }
                            }
                            if (targetActionId != -1) break;
                        }
                    }
                }

                if (targetActionId == -1)
                {
                    SendActionResult("LOCK_CHAMPION", false, "No es tu turno de selección o ya fijaste campeón.");
                    return;
                }

                // PATCH
                LcuRequest("PATCH", "/lol-champ-select/v1/session/actions/" + targetActionId, 
                    Serializer.Serialize(new Dictionary<string, object> { { "championId", championId } }));

                // COMPLETE
                LcuRequest("POST", "/lol-champ-select/v1/session/actions/" + targetActionId + "/complete", "{}");

                Console.ForegroundColor = ConsoleColor.Green;
                Console.WriteLine(">>> [Éxito] ¡Campeón fijado! Aplicando runas y hechizos recomendados...");
                Console.ResetColor();

                SendActionResult("LOCK_CHAMPION", true, "¡Campeón fijado! Aplicando runas recomendadas...");

                // Runas y Hechizos en background
                Task.Run(async () =>
                {
                    await Task.Delay(600);
                    try
                    {
                        // 1. Runas recomendadas
                        var recPages = LcuGetList("/lol-perks/v1/recommended-pages?championId=" + championId);
                        if (recPages != null && recPages.Count > 0)
                        {
                            LcuRequest("POST", "/lol-perks/v1/currentpage", Serializer.Serialize(recPages[0]));
                        }

                        // 2. Hechizos
                        var grid = LcuGetList("/lol-champ-select/v1/grid-recommendations");
                        if (grid != null && grid.Count > 0)
                        {
                            var first = grid[0] as Dictionary<string, object>;
                            if (first != null && first.ContainsKey("recommendedSpells"))
                            {
                                var spells = first["recommendedSpells"] as object[];
                                if (spells != null && spells.Length > 0)
                                {
                                    var sDict = spells[0] as Dictionary<string, object>;
                                    if (sDict != null)
                                    {
                                        LcuRequest("PATCH", "/lol-champ-select/v1/session/my-selection",
                                            Serializer.Serialize(new Dictionary<string, object>
                                            {
                                                { "spell1Id", sDict["spell1Id"] },
                                                { "spell2Id", sDict["spell2Id"] }
                                            }));
                                    }
                                }
                            }
                        }
                    }
                    catch { }
                });
            }
            catch (Exception ex)
            {
                SendActionResult("LOCK_CHAMPION", false, "Error: " + ex.Message);
            }
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
                Task.Run(() => SendWsJson(frame));
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

        // Helpers de LCU HTTP
        private static Dictionary<string, object> LcuGet(string endpoint)
        {
            string json = LcuRequest("GET", endpoint, null);
            return Serializer.Deserialize<Dictionary<string, object>>(json);
        }

        private static List<object> LcuGetList(string endpoint)
        {
            string json = LcuRequest("GET", endpoint, null);
            return Serializer.Deserialize<List<object>>(json);
        }

        private static string LcuGetString(string endpoint)
        {
            return LcuRequest("GET", endpoint, null);
        }

        private static string LcuRequest(string method, string endpoint, string body)
        {
            string url = string.Format("https://127.0.0.1:{0}{1}", _lcuPort, endpoint);
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = method;
            req.Headers["Authorization"] = _authHeader;
            req.Accept = "application/json";

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
            using (var sr = new StreamReader(resp.GetResponseStream()))
            {
                return sr.ReadToEnd();
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
