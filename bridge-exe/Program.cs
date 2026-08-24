/*
 * Entrada do T4-Bridge.
 *
 * A thread principal é STA e roda um message pump porque o RTD é COM: o Profit
 * chama `UpdateNotify` de volta nesta thread, e sem pump a chamada nunca chega.
 * O servidor WebSocket vive em threads próprias; o encontro entre os dois
 * acontece no timer que faz o Poll.
 */

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Windows.Forms;

namespace T4Bridge
{
    public static class Program
    {
        public const string Version = "2.0.0";

        private static WsServer server;
        private static RtdClient rtd;
        private static string sessionId;
        private static long ticksAccepted;
        private static long ticksRejected;
        private static long lastIngestAt;
        private static string defaultSymbol = "WINFUT";
        private static readonly object stateLock = new object();

        [STAThread]
        public static void Main(string[] args)
        {
            Console.Title = "T4-Bridge " + Version;
            Banner();

            string baseDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            Config config = Config.Load(Path.Combine(baseDir, "t4-bridge.ini"), Log);
            defaultSymbol = config.Symbol;
            sessionId = Guid.NewGuid().ToString();

            X509Certificate2 certificate = LoadCertificate(baseDir, config, Log);

            server = new WsServer(config.Port, certificate, Log);
            server.HealthJson = BuildHealth;
            server.OnMessage = HandleClientMessage;
            server.Start();

            Log("");
            if (certificate != null)
            {
                Log("  WebSocket  wss://localhost:" + config.Port + "   (site em HTTPS)");
                Log("  WebSocket  ws://127.0.0.1:" + config.Port + "    (site em HTTP local)");
            }
            else
            {
                Log("  WebSocket  ws://127.0.0.1:" + config.Port);
                Log("  TLS DESLIGADO — o site em HTTPS nao vai conseguir conectar.");
                Log("  Rode bridge/tls/setup-rtd-tls.ps1 -Pfx para gerar o certificado.");
            }
            Log("  Health     http://127.0.0.1:" + config.Port + "/health");
            Log("");

            rtd = new RtdClient(config.Fields, Log);
            if (rtd.Start())
            {
                rtd.Subscribe(defaultSymbol);
            }
            else
            {
                Log("RTD INDISPONIVEL: " + rtd.LastError);
                Log("A bridge continua no ar; o site vai mostrar FEED OFFLINE ate o Profit responder.");
            }

            // O Poll roda no message pump para tocar o COM sempre da mesma thread.
            Timer poll = new Timer();
            poll.Interval = 100;
            poll.Tick += delegate(object s, EventArgs e) { PumpRtd(); };
            poll.Start();

            Timer beat = new Timer();
            beat.Interval = 1000;
            beat.Tick += delegate(object s, EventArgs e) { Heartbeat(); };
            beat.Start();

            Log("Aguardando negocios reais do Profit. Nao existe gerador simulado.");
            Log("Feche esta janela para encerrar a bridge.");
            Log("");

            Application.Run(new ApplicationContext());

            poll.Stop();
            beat.Stop();
            if (rtd != null) rtd.Stop();
            if (server != null) server.Stop();
        }

        private static void Banner()
        {
            Console.WriteLine("========================================");
            Console.WriteLine(" T4-BRIDGE " + Version);
            Console.WriteLine(" Profit -> RTD (COM) -> WebSocket local");
            Console.WriteLine(" Somente leitura. Nao envia ordem.");
            Console.WriteLine("========================================");
        }

        private static void Log(string message)
        {
            Console.WriteLine("[" + DateTime.Now.ToString("HH:mm:ss") + "] " + message);
        }

        private static X509Certificate2 LoadCertificate(string baseDir, Config config, Action<string> log)
        {
            string path = config.PfxPath;
            if (string.IsNullOrEmpty(path)) path = Path.Combine(baseDir, "tls", "bridge.pfx");
            if (!File.Exists(path)) return null;
            try
            {
                X509Certificate2 cert = new X509Certificate2(path, config.PfxPassword,
                    X509KeyStorageFlags.MachineKeySet | X509KeyStorageFlags.Exportable);
                log("Certificado TLS carregado: " + cert.Subject);
                return cert;
            }
            catch (Exception error)
            {
                log("Aviso: certificado em " + path + " nao pode ser lido: " + error.Message);
                return null;
            }
        }

        private static void PumpRtd()
        {
            if (rtd == null || !rtd.Connected) return;
            List<Tick> ticks;
            try { ticks = rtd.Poll(); }
            catch (Exception error)
            {
                Log("Erro ao ler RTD: " + error.Message);
                return;
            }

            foreach (Tick tick in ticks)
            {
                lock (stateLock)
                {
                    ticksAccepted++;
                    lastIngestAt = Clock.NowMs();
                }
                server.Broadcast(TickMessage(tick), tick.Symbol);
            }
        }

        private static string TickMessage(Tick tick)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"type\":\"tick\",\"tick\":{");
            sb.Append("\"symbol\":").Append(Json.Escape(tick.Symbol));
            sb.Append(",\"timestamp\":").Append(tick.Timestamp);
            sb.Append(",\"price\":").Append(Json.Num(tick.Price));
            sb.Append(",\"open\":").Append(Json.Num(tick.Open));
            sb.Append(",\"high\":").Append(Json.Num(tick.High));
            sb.Append(",\"low\":").Append(Json.Num(tick.Low));
            sb.Append(",\"close\":").Append(Json.Num(tick.Close));
            sb.Append(",\"bid\":").Append(Json.Num(tick.Bid));
            sb.Append(",\"ask\":").Append(Json.Num(tick.Ask));
            sb.Append(",\"volume\":").Append(Json.Num(tick.Volume));
            sb.Append(",\"qty\":").Append(Json.Num(tick.Qty));
            sb.Append(",\"trades\":").Append(Json.Num(tick.Trades));
            sb.Append(",\"source\":").Append(Json.Escape(tick.Source));
            sb.Append(",\"sequence\":").Append(tick.Sequence);
            // `seq` e `receivedAt` mantem o formato que o site ja consome.
            sb.Append(",\"seq\":").Append(tick.Sequence);
            sb.Append(",\"receivedAt\":").Append(tick.ReceivedAt);
            sb.Append("}}");
            return sb.ToString();
        }

        /// <summary>
        /// WAITING = bridge de pé sem negócio ainda. LIVE = negócio recente.
        /// STALE = havia fluxo e parou. Distinguir os três é o que permite ao
        /// site dizer o que fazer em vez de só piscar vermelho.
        /// </summary>
        private static string Producer()
        {
            long last;
            lock (stateLock) { last = lastIngestAt; }
            if (last == 0) return "WAITING";
            long age = Clock.NowMs() - last;
            if (age > 10000) return "STALE";
            return "LIVE";
        }

        private static void Heartbeat()
        {
            if (server == null || server.ClientCount == 0) return;
            StringBuilder sb = new StringBuilder();
            long accepted, rejected, last;
            lock (stateLock) { accepted = ticksAccepted; rejected = ticksRejected; last = lastIngestAt; }
            sb.Append("{\"type\":\"heartbeat\"");
            sb.Append(",\"sessionId\":").Append(Json.Escape(sessionId));
            sb.Append(",\"producer\":").Append(Json.Escape(Producer()));
            sb.Append(",\"serverTime\":").Append(Clock.NowMs());
            sb.Append(",\"ticksAccepted\":").Append(accepted);
            sb.Append(",\"ticksRejected\":").Append(rejected);
            sb.Append(",\"lastIngestAt\":").Append(last == 0 ? "null" : last.ToString(CultureInfo.InvariantCulture));
            sb.Append("}");
            server.Broadcast(sb.ToString(), null);
        }

        private static string BuildHealth()
        {
            long accepted, rejected, last;
            lock (stateLock) { accepted = ticksAccepted; rejected = ticksRejected; last = lastIngestAt; }
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"ok\":true");
            sb.Append(",\"service\":\"t4-bridge\"");
            sb.Append(",\"flavor\":\"exe\"");
            sb.Append(",\"version\":").Append(Json.Escape(Version));
            sb.Append(",\"tls\":").Append(server.TlsEnabled ? "true" : "false");
            sb.Append(",\"sessionId\":").Append(Json.Escape(sessionId));
            sb.Append(",\"serverTime\":").Append(Clock.NowMs());
            sb.Append(",\"producer\":").Append(Json.Escape(Producer()));
            sb.Append(",\"rtdConnected\":").Append(rtd != null && rtd.Connected ? "true" : "false");
            sb.Append(",\"rtdError\":").Append(rtd == null || rtd.LastError == null
                ? "null" : Json.Escape(rtd.LastError));
            sb.Append(",\"topics\":").Append(rtd == null ? 0 : rtd.TopicCount);
            sb.Append(",\"profitRunning\":").Append(RtdClient.ProfitRunning() ? "true" : "false");
            sb.Append(",\"rtdFieldsOk\":").Append(rtd != null && rtd.HasLiveTopics ? "true" : "false");
            sb.Append(",\"rtdConnectError\":").Append(rtd == null || rtd.ConnectError == null ? "null" : Json.Escape(rtd.ConnectError));
            sb.Append(",\"ticksAccepted\":").Append(accepted);
            sb.Append(",\"ticksRejected\":").Append(rejected);
            sb.Append(",\"lastIngestAgeMs\":").Append(last == 0
                ? "null" : (Clock.NowMs() - last).ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"clients\":").Append(server.ClientCount);
            sb.Append(",\"symbols\":[");
            List<string> symbols = server.SubscribedSymbols();
            if (symbols.Count == 0) symbols.Add(defaultSymbol);
            for (int i = 0; i < symbols.Count; i++)
            {
                if (i > 0) sb.Append(",");
                sb.Append(Json.Escape(symbols[i]));
            }
            sb.Append("]}");
            return sb.ToString();
        }

        private static void HandleClientMessage(WsClient client, string text)
        {
            string type = Json.StringField(text, "type");
            if (type == null) return;

            if (type == "ping")
            {
                long? clientTime = Json.LongField(text, "clientTime");
                StringBuilder sb = new StringBuilder();
                sb.Append("{\"type\":\"pong\",\"clientTime\":");
                sb.Append(clientTime.HasValue ? clientTime.Value.ToString(CultureInfo.InvariantCulture) : "null");
                sb.Append(",\"serverTime\":").Append(Clock.NowMs()).Append("}");
                server.Send(client, sb.ToString());
                return;
            }

            if (type == "subscribe")
            {
                // O array de simbolos vem simples; extrair sem parser geral.
                int at = text.IndexOf("\"symbols\"", StringComparison.Ordinal);
                if (at < 0) return;
                int open = text.IndexOf('[', at);
                int close = text.IndexOf(']', open + 1);
                if (open < 0 || close < 0) return;

                client.Symbols.Clear();
                string[] pieces = text.Substring(open + 1, close - open - 1).Split(',');
                foreach (string piece in pieces)
                {
                    string symbol = piece.Trim().Trim('"').Trim().ToUpperInvariant();
                    if (symbol.Length == 0) continue;
                    client.Symbols.Add(symbol);
                    if (rtd != null && rtd.Connected) rtd.Subscribe(symbol);
                }
                Log("Cliente assinou: " + string.Join(", ", new List<string>(client.Symbols).ToArray()));
                SendHello(client);
            }
        }

        private static void SendHello(WsClient client)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"type\":\"hello\"");
            sb.Append(",\"service\":\"t4-bridge\"");
            sb.Append(",\"version\":").Append(Json.Escape(Version));
            sb.Append(",\"sessionId\":").Append(Json.Escape(sessionId));
            sb.Append(",\"producer\":").Append(Json.Escape(Producer()));
            sb.Append(",\"serverTime\":").Append(Clock.NowMs());
            sb.Append(",\"symbols\":[");
            int i = 0;
            foreach (string symbol in client.Symbols)
            {
                if (i++ > 0) sb.Append(",");
                sb.Append(Json.Escape(symbol));
            }
            sb.Append("]}");
            server.Send(client, sb.ToString());
        }
    }

    /// <summary>Configuração em arquivo texto ao lado do executável.</summary>
    public class Config
    {
        public int Port = 8765;
        public string Symbol = "WINFUT";
        public string PfxPath = "";
        public string PfxPassword = "t4bridge";
        public FieldMap Fields = new FieldMap();

        public static Config Load(string path, Action<string> log)
        {
            Config config = new Config();
            if (!File.Exists(path))
            {
                log("Sem t4-bridge.ini; usando padroes (porta 8765, ativo WINFUT).");
                return config;
            }
            foreach (string raw in File.ReadAllLines(path))
            {
                string line = raw.Trim();
                if (line.Length == 0 || line.StartsWith("#") || line.StartsWith(";")) continue;
                int eq = line.IndexOf('=');
                if (eq <= 0) continue;
                string key = line.Substring(0, eq).Trim().ToLowerInvariant();
                string value = line.Substring(eq + 1).Trim();

                if (key == "port") { int p; if (int.TryParse(value, out p)) config.Port = p; }
                else if (key == "symbol") config.Symbol = value.ToUpperInvariant();
                else if (key == "pfx") config.PfxPath = value;
                else if (key == "pfxpassword") config.PfxPassword = value;
                else if (key == "field.last") config.Fields.Last = value;
                else if (key == "field.open") config.Fields.Open = value;
                else if (key == "field.high") config.Fields.High = value;
                else if (key == "field.low") config.Fields.Low = value;
                else if (key == "field.close") config.Fields.Close = value;
                else if (key == "field.volume") config.Fields.Volume = value;
                else if (key == "field.qty") config.Fields.Qty = value;
                else if (key == "field.bid") config.Fields.Bid = value;
                else if (key == "field.ask") config.Fields.Ask = value;
                else if (key == "field.trades") config.Fields.Trades = value;
                else if (key == "field.time") config.Fields.Time = value;
                else if (key == "field.date") config.Fields.Date = value;
            }
            log("Configuracao lida de t4-bridge.ini (porta " + config.Port + ", ativo " + config.Symbol + ").");
            return config;
        }
    }
}
