/*
 * Servidor HTTP/WebSocket local da bridge.
 *
 * TEXTO CLARO E TLS NA MESMA PORTA
 *   A 8765 atende dois públicos com exigências opostas: o site em
 *   https://analisador.dvdswap.com.br só pode abrir `wss://`, porque o
 *   navegador bloqueia conteúdo misto; ferramentas locais e o próprio
 *   diagnóstico falam HTTP em claro. O primeiro byte decide: 0x16 é um
 *   ClientHello TLS, qualquer letra ASCII é um método HTTP.
 *
 *   Aqui o embrulho TLS é direto (SslStream.AuthenticateAsServer), sem o
 *   truque de proxy que a versão em Node precisou usar: no .NET o TLS
 *   server-side sobre um stream existente funciona.
 *
 * SOMENTE LOOPBACK
 *   Escuta em 127.0.0.1 e ::1. Nunca 0.0.0.0. O feed do operador não sai da
 *   máquina, e não há porta para encaminhar.
 */

using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading;

namespace T4Bridge
{
    /// <summary>Stream que devolve bytes já lidos antes de seguir para o real.</summary>
    public class PrefixedStream : Stream
    {
        private readonly Stream inner;
        private byte[] prefix;
        private int offset;

        public PrefixedStream(Stream inner, byte[] prefix)
        {
            this.inner = inner;
            this.prefix = prefix;
            this.offset = 0;
        }

        public override int Read(byte[] buffer, int index, int count)
        {
            if (prefix != null && offset < prefix.Length)
            {
                int available = Math.Min(count, prefix.Length - offset);
                Array.Copy(prefix, offset, buffer, index, available);
                offset += available;
                if (offset >= prefix.Length) prefix = null;
                return available;
            }
            return inner.Read(buffer, index, count);
        }

        public override void Write(byte[] buffer, int index, int count) { inner.Write(buffer, index, count); }
        public override void Flush() { inner.Flush(); }
        public override bool CanRead { get { return true; } }
        public override bool CanWrite { get { return true; } }
        public override bool CanSeek { get { return false; } }
        public override long Length { get { throw new NotSupportedException(); } }
        public override long Position
        {
            get { throw new NotSupportedException(); }
            set { throw new NotSupportedException(); }
        }
        public override long Seek(long o, SeekOrigin s) { throw new NotSupportedException(); }
        public override void SetLength(long v) { throw new NotSupportedException(); }
        protected override void Dispose(bool disposing)
        {
            if (disposing) inner.Dispose();
            base.Dispose(disposing);
        }
    }

    public class WsClient
    {
        public Stream Stream;
        public TcpClient Socket;
        public string Origin;
        public bool Secure;
        public readonly HashSet<string> Symbols = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        public readonly object WriteLock = new object();
        public volatile bool Closed;
    }

    public class WsServer
    {
        private const string Guid6455 = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

        /// <summary>
        /// Origens autorizadas. Sem esta lista, qualquer página aberta no
        /// navegador do operador durante o pregão poderia abrir um WebSocket
        /// para 127.0.0.1 e ler o book: a política de mesma origem NÃO protege
        /// WebSocket. Requisição sem Origin é aceita de propósito — navegador
        /// sempre envia, então a ausência identifica ferramenta local.
        /// </summary>
        private static readonly string[] AllowedOrigins = new string[] {
            "https://analisador.dvdswap.com.br",
            "http://localhost:3000",
            "http://127.0.0.1:3000"
        };

        private readonly int port;
        private readonly X509Certificate2 certificate;
        private readonly Action<string> log;
        private readonly List<TcpListener> listeners = new List<TcpListener>();
        private readonly List<WsClient> clients = new List<WsClient>();
        private readonly object clientsLock = new object();
        private volatile bool running;

        public Func<string> HealthJson;
        public Action<WsClient, string> OnMessage;
        public int ClientCount { get { lock (clientsLock) { return clients.Count; } } }
        public bool TlsEnabled { get { return certificate != null; } }

        public WsServer(int port, X509Certificate2 certificate, Action<string> logger)
        {
            this.port = port;
            this.certificate = certificate;
            this.log = logger;
        }

        public void Start()
        {
            running = true;
            // Um listener por endereço de loopback: no Windows `localhost`
            // resolve para ::1 antes de 127.0.0.1, e escutar só no IPv4 faria
            // wss://localhost bater em porta fechada.
            StartListener(IPAddress.Loopback);
            StartListener(IPAddress.IPv6Loopback);
        }

        private void StartListener(IPAddress address)
        {
            try
            {
                TcpListener listener = new TcpListener(address, port);
                listener.Start();
                listeners.Add(listener);
                Thread thread = new Thread(delegate() { AcceptLoop(listener); });
                thread.IsBackground = true;
                thread.Start();
                log("Escutando em " + address + ":" + port);
            }
            catch (Exception error)
            {
                // Maquina sem IPv6 e comum: falhar ali nao pode derrubar a
                // bridge se o IPv4 subiu.
                log("Aviso: nao foi possivel escutar em " + address + ": " + error.Message);
            }
        }

        private void AcceptLoop(TcpListener listener)
        {
            while (running)
            {
                TcpClient socket;
                try { socket = listener.AcceptTcpClient(); }
                catch (Exception) { return; }

                Thread thread = new Thread(delegate() { Handle(socket); });
                thread.IsBackground = true;
                thread.Start();
            }
        }

        private void Handle(TcpClient socket)
        {
            try
            {
                socket.NoDelay = true;
                Stream stream = socket.GetStream();

                byte[] first = new byte[1];
                int read = stream.Read(first, 0, 1);
                if (read <= 0) { socket.Close(); return; }

                bool secure = false;
                Stream effective = new PrefixedStream(stream, first);
                if (first[0] == 0x16)
                {
                    if (certificate == null)
                    {
                        // Cliente pediu TLS e nao temos certificado: fechar e
                        // dizer o motivo no log e melhor que silencio.
                        log("Conexao TLS recusada: bridge sem certificado. Rode setup-rtd-tls.ps1.");
                        socket.Close();
                        return;
                    }
                    SslStream ssl = new SslStream(effective, false);
                    ssl.AuthenticateAsServer(certificate, false, SslProtocols.Tls12, false);
                    effective = ssl;
                    secure = true;
                }

                HandleHttp(socket, effective, secure);
            }
            catch (Exception)
            {
                try { socket.Close(); } catch (Exception) { }
            }
        }

        private static string ReadLine(Stream stream)
        {
            StringBuilder sb = new StringBuilder();
            int previous = -1;
            while (true)
            {
                int current = stream.ReadByte();
                if (current < 0) return sb.Length > 0 ? sb.ToString() : null;
                if (previous == '\r' && current == '\n')
                {
                    sb.Length = sb.Length - 1;
                    return sb.ToString();
                }
                sb.Append((char)current);
                previous = current;
            }
        }

        private void HandleHttp(TcpClient socket, Stream stream, bool secure)
        {
            string requestLine = ReadLine(stream);
            if (string.IsNullOrEmpty(requestLine)) { socket.Close(); return; }

            Dictionary<string, string> headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            while (true)
            {
                string line = ReadLine(stream);
                if (string.IsNullOrEmpty(line)) break;
                int colon = line.IndexOf(':');
                if (colon > 0) headers[line.Substring(0, colon).Trim()] = line.Substring(colon + 1).Trim();
            }

            string[] parts = requestLine.Split(' ');
            string method = parts.Length > 0 ? parts[0] : "";
            string path = parts.Length > 1 ? parts[1] : "/";
            int query = path.IndexOf('?');
            if (query >= 0) path = path.Substring(0, query);

            string origin;
            headers.TryGetValue("Origin", out origin);
            if (!OriginAllowed(origin))
            {
                log("Recusado: origem nao autorizada (" + origin + ")");
                WriteHttp(stream, 403, "text/plain; charset=utf-8", "origem nao autorizada", origin);
                socket.Close();
                return;
            }

            string upgrade;
            headers.TryGetValue("Upgrade", out upgrade);
            if (upgrade != null && upgrade.ToLowerInvariant() == "websocket")
            {
                Upgrade(socket, stream, headers, origin, secure);
                return;
            }

            if (method == "OPTIONS")
            {
                WriteHttp(stream, 204, "text/plain", "", origin);
                socket.Close();
                return;
            }

            if (path == "/health" || path == "/")
            {
                string body = HealthJson != null ? HealthJson() : "{\"ok\":true}";
                WriteHttp(stream, 200, "application/json; charset=utf-8", body, origin);
                socket.Close();
                return;
            }

            WriteHttp(stream, 404, "application/json; charset=utf-8",
                      "{\"ok\":false,\"error\":\"rota desconhecida\"}", origin);
            socket.Close();
        }

        public static bool OriginAllowed(string origin)
        {
            if (string.IsNullOrEmpty(origin)) return true;
            string normalized = origin.Trim().ToLowerInvariant().TrimEnd('/');
            foreach (string allowed in AllowedOrigins)
            {
                if (normalized == allowed) return true;
            }
            return false;
        }

        private void WriteHttp(Stream stream, int status, string contentType, string body, string origin)
        {
            byte[] payload = Encoding.UTF8.GetBytes(body == null ? "" : body);
            StringBuilder head = new StringBuilder();
            head.Append("HTTP/1.1 ").Append(status).Append(" ").Append(StatusText(status)).Append("\r\n");
            head.Append("Content-Type: ").Append(contentType).Append("\r\n");
            head.Append("Content-Length: ").Append(payload.Length).Append("\r\n");
            head.Append("Cache-Control: no-store\r\n");
            head.Append("Vary: Origin\r\n");
            // Ecoa a origem autorizada em vez de responder `*`: com `*`
            // qualquer pagina conseguiria ler o estado do feed do operador.
            if (!string.IsNullOrEmpty(origin) && OriginAllowed(origin))
            {
                head.Append("Access-Control-Allow-Origin: ").Append(origin).Append("\r\n");
                head.Append("Access-Control-Allow-Headers: content-type\r\n");
                head.Append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n");
            }
            head.Append("Connection: close\r\n\r\n");
            byte[] headBytes = Encoding.ASCII.GetBytes(head.ToString());
            stream.Write(headBytes, 0, headBytes.Length);
            if (payload.Length > 0) stream.Write(payload, 0, payload.Length);
            stream.Flush();
        }

        private static string StatusText(int status)
        {
            if (status == 200) return "OK";
            if (status == 204) return "No Content";
            if (status == 400) return "Bad Request";
            if (status == 403) return "Forbidden";
            if (status == 404) return "Not Found";
            return "OK";
        }

        private void Upgrade(TcpClient socket, Stream stream, Dictionary<string, string> headers,
                             string origin, bool secure)
        {
            string key;
            if (!headers.TryGetValue("Sec-WebSocket-Key", out key) || string.IsNullOrEmpty(key))
            {
                WriteHttp(stream, 400, "text/plain", "handshake invalido", origin);
                socket.Close();
                return;
            }

            byte[] hash;
            using (SHA1 sha = SHA1.Create())
            {
                hash = sha.ComputeHash(Encoding.ASCII.GetBytes(key + Guid6455));
            }
            string accept = Convert.ToBase64String(hash);

            StringBuilder response = new StringBuilder();
            response.Append("HTTP/1.1 101 Switching Protocols\r\n");
            response.Append("Upgrade: websocket\r\n");
            response.Append("Connection: Upgrade\r\n");
            response.Append("Sec-WebSocket-Accept: ").Append(accept).Append("\r\n\r\n");
            byte[] bytes = Encoding.ASCII.GetBytes(response.ToString());
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush();

            WsClient client = new WsClient();
            client.Stream = stream;
            client.Socket = socket;
            client.Origin = origin;
            client.Secure = secure;
            lock (clientsLock) { clients.Add(client); }
            log("Cliente conectado" + (secure ? " (TLS)" : "") + ". Total: " + ClientCount);

            ReadLoop(client);
        }

        private void ReadLoop(WsClient client)
        {
            try
            {
                while (running && !client.Closed)
                {
                    int opcode;
                    byte[] payload = ReadFrame(client.Stream, out opcode);
                    if (payload == null) break;

                    if (opcode == 0x8) break;                       // close
                    if (opcode == 0x9) { SendFrame(client, payload, 0xA); continue; }  // ping -> pong
                    if (opcode != 0x1) continue;                    // só texto interessa

                    string text = Encoding.UTF8.GetString(payload);
                    if (OnMessage != null) OnMessage(client, text);
                }
            }
            catch (Exception) { /* queda de cliente e rotina */ }
            finally { Remove(client); }
        }

        private static byte[] ReadFrame(Stream stream, out int opcode)
        {
            opcode = 0;
            int b0 = stream.ReadByte();
            if (b0 < 0) return null;
            int b1 = stream.ReadByte();
            if (b1 < 0) return null;

            opcode = b0 & 0x0F;
            bool masked = (b1 & 0x80) != 0;
            long length = b1 & 0x7F;

            if (length == 126)
            {
                byte[] ext = ReadExactly(stream, 2);
                if (ext == null) return null;
                length = (ext[0] << 8) | ext[1];
            }
            else if (length == 127)
            {
                byte[] ext = ReadExactly(stream, 8);
                if (ext == null) return null;
                length = 0;
                for (int i = 0; i < 8; i++) length = (length << 8) | ext[i];
            }
            // Um frame gigante so pode ser erro ou ataque; a bridge nunca recebe
            // mensagem grande do site.
            if (length < 0 || length > 1000000) return null;

            byte[] mask = null;
            if (masked)
            {
                mask = ReadExactly(stream, 4);
                if (mask == null) return null;
            }

            byte[] payload = ReadExactly(stream, (int)length);
            if (payload == null) return null;
            // Frames do cliente chegam SEMPRE mascarados pelo RFC 6455.
            if (mask != null)
            {
                for (int i = 0; i < payload.Length; i++) payload[i] = (byte)(payload[i] ^ mask[i & 3]);
            }
            return payload;
        }

        private static byte[] ReadExactly(Stream stream, int count)
        {
            byte[] buffer = new byte[count];
            int filled = 0;
            while (filled < count)
            {
                int read = stream.Read(buffer, filled, count - filled);
                if (read <= 0) return null;
                filled += read;
            }
            return buffer;
        }

        public void Send(WsClient client, string text)
        {
            SendFrame(client, Encoding.UTF8.GetBytes(text), 0x1);
        }

        private void SendFrame(WsClient client, byte[] payload, int opcode)
        {
            if (client.Closed) return;
            try
            {
                byte[] header;
                if (payload.Length < 126)
                {
                    header = new byte[2];
                    header[1] = (byte)payload.Length;
                }
                else if (payload.Length < 65536)
                {
                    header = new byte[4];
                    header[1] = 126;
                    header[2] = (byte)(payload.Length >> 8);
                    header[3] = (byte)(payload.Length & 0xFF);
                }
                else
                {
                    header = new byte[10];
                    header[1] = 127;
                    long len = payload.Length;
                    for (int i = 0; i < 8; i++) header[9 - i] = (byte)((len >> (8 * i)) & 0xFF);
                }
                header[0] = (byte)(0x80 | opcode);   // FIN + opcode; servidor nao mascara

                lock (client.WriteLock)
                {
                    client.Stream.Write(header, 0, header.Length);
                    if (payload.Length > 0) client.Stream.Write(payload, 0, payload.Length);
                    client.Stream.Flush();
                }
            }
            catch (Exception) { Remove(client); }
        }

        public void Broadcast(string text, string symbol)
        {
            List<WsClient> snapshot;
            lock (clientsLock) { snapshot = new List<WsClient>(clients); }
            foreach (WsClient client in snapshot)
            {
                // Cliente sem assinatura recebe tudo; com assinatura, só o que pediu.
                if (symbol != null && client.Symbols.Count > 0 && !client.Symbols.Contains(symbol)) continue;
                Send(client, text);
            }
        }

        private void Remove(WsClient client)
        {
            if (client.Closed) return;
            client.Closed = true;
            lock (clientsLock) { clients.Remove(client); }
            try { client.Socket.Close(); } catch (Exception) { }
            log("Cliente desconectado. Total: " + ClientCount);
        }

        public List<string> SubscribedSymbols()
        {
            List<string> all = new List<string>();
            lock (clientsLock)
            {
                foreach (WsClient client in clients)
                {
                    foreach (string symbol in client.Symbols)
                    {
                        if (!all.Contains(symbol)) all.Add(symbol);
                    }
                }
            }
            return all;
        }

        public void Stop()
        {
            running = false;
            foreach (TcpListener listener in listeners)
            {
                try { listener.Stop(); } catch (Exception) { }
            }
            List<WsClient> snapshot;
            lock (clientsLock) { snapshot = new List<WsClient>(clients); }
            foreach (WsClient client in snapshot) Remove(client);
        }
    }
}
