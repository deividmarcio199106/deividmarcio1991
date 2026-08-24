/*
 * T4-BRIDGE — ponte entre o Profit e o analisador T4.
 *
 * O QUE ESTE PROGRAMA É
 *   Um executável Windows portátil. Duplo clique, sem instalação, sem
 *   administrador, sem Node, sem Bun, sem Excel e sem planilha. Ele fala com o
 *   Profit pela interface RTD do próprio Profit e publica os negócios num
 *   WebSocket local que o site consome.
 *
 * POR QUE NÃO PRECISA MAIS DO EXCEL
 *   O Profit registra um servidor RTD COM out-of-process:
 *
 *     ProgID  RTDTrading.RtdServer
 *     CLSID   {272D2E65-05FB-4500-BD7B-5905D5B0A1B8}
 *     Host    LocalServer32 -> profitchart.exe
 *
 *   e implementa a interface RTD PADRÃO do Excel (IRtdServer,
 *   IID {EC0E6191-DB51-11D3-8F3E-00C04F3651B8}). Ou seja: o Excel nunca foi
 *   necessário — ele era só um intermediário caro. Este programa conversa com
 *   o mesmo servidor diretamente.
 *
 *   Verificado no registro da máquina antes de escrever uma linha. A versão
 *   anterior desta integração documentava o ProgID `profitchart.rtd`, que NÃO
 *   existe: a planilha simplesmente nunca receberia dado.
 *
 * O QUE ELE NÃO FAZ
 *   Não envia ordem. Não clica no Profit. Não inventa preço nem candle. Não
 *   lê a tela. Se o dado não vier, ele diz que não veio.
 *
 * COMPILAÇÃO
 *   build.cmd — usa o csc.exe que já vem no Windows. Por isso o código é C# 5:
 *   sem interpolação de string, sem `?.`, sem separador de dígito, sem nameof.
 */

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace T4Bridge
{
    // ---------------------------------------------------------------- COM ---

    /// <summary>
    /// Interface RTD do Excel, implementada pelo Profit.
    /// Os DispIds são fixos pelo padrão — não invente.
    /// </summary>
    [ComImport]
    [Guid("EC0E6191-DB51-11D3-8F3E-00C04F3651B8")]
    [InterfaceType(ComInterfaceType.InterfaceIsDual)]
    public interface IRtdServer
    {
        [DispId(10)]
        int ServerStart([MarshalAs(UnmanagedType.Interface)] IRTDUpdateEvent callback);

        [DispId(11)]
        [return: MarshalAs(UnmanagedType.Struct)]
        object ConnectData(
            int topicId,
            [MarshalAs(UnmanagedType.SafeArray, SafeArraySubType = VarEnum.VT_VARIANT)] ref object[] strings,
            ref bool getNewValues);

        [DispId(12)]
        [return: MarshalAs(UnmanagedType.SafeArray, SafeArraySubType = VarEnum.VT_VARIANT)]
        object[,] RefreshData(ref int topicCount);

        [DispId(13)]
        void DisconnectData(int topicId);

        [DispId(14)]
        int Heartbeat();

        [DispId(15)]
        void ServerTerminate();
    }

    /// <summary>Callback que o Profit chama quando há dado novo.</summary>
    [ComImport]
    [Guid("A43788C1-D91B-11D3-8F39-00C04F3651B8")]
    [InterfaceType(ComInterfaceType.InterfaceIsDual)]
    public interface IRTDUpdateEvent
    {
        [DispId(10)]
        void UpdateNotify();

        [DispId(11)]
        int HeartbeatInterval { get; set; }

        [DispId(12)]
        void Disconnect();
    }

    /// <summary>
    /// Implementação do callback. O Profit chama <see cref="UpdateNotify"/> na
    /// thread STA; só levantamos uma bandeira e devolvemos o controle na hora —
    /// segurar essa chamada trava o Profit inteiro.
    /// </summary>
    public class RtdCallback : IRTDUpdateEvent
    {
        private int heartbeatInterval = 1000;
        private volatile bool pending;
        private volatile bool disconnected;

        public bool TakePending()
        {
            bool value = pending;
            pending = false;
            return value;
        }

        public bool Disconnected { get { return disconnected; } }

        public void UpdateNotify() { pending = true; }

        public int HeartbeatInterval
        {
            get { return heartbeatInterval; }
            set { heartbeatInterval = value; }
        }

        public void Disconnect() { disconnected = true; }
    }

    // ------------------------------------------------------------- modelo ---

    /// <summary>Um negócio já validado, no formato único do projeto.</summary>
    public class Tick
    {
        public string Symbol;
        public long Timestamp;      // ms epoch, relógio do MERCADO
        public double Price;
        public double? Open, High, Low, Close, Bid, Ask, Volume;
        public double? Trades, Qty;
        public string Source;
        public long Sequence;
        public long ReceivedAt;     // ms epoch, relógio da bridge
    }

    /// <summary>
    /// Campos que pedimos ao RTD por ativo.
    /// Os nomes são os da Nelogica. Ficam configuráveis porque variam entre
    /// versões, e um nome errado precisa aparecer como campo vazio no
    /// diagnóstico — nunca como preço inventado.
    /// </summary>
    public class FieldMap
    {
        public string Last = "ULT";
        public string Open = "ABE";
        public string High = "MAX";
        public string Low = "MIN";
        public string Close = "FEC";
        public string Volume = "VOL";
        public string Qty = "QTD";
        public string Bid = "COMPRA";
        public string Ask = "VENDA";
        public string Trades = "NEG";
        public string Time = "HORA";
        public string Date = "DATA";

        public List<string> All()
        {
            List<string> list = new List<string>();
            list.Add(Last); list.Add(Open); list.Add(High); list.Add(Low);
            list.Add(Close); list.Add(Volume); list.Add(Qty); list.Add(Bid);
            list.Add(Ask); list.Add(Trades); list.Add(Time); list.Add(Date);
            return list;
        }
    }

    // ------------------------------------------------------------ helpers ---

    public static class Json
    {
        public static string Escape(string raw)
        {
            if (raw == null) return "null";
            StringBuilder sb = new StringBuilder("\"");
            foreach (char c in raw)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.Append('"').ToString();
        }

        public static string Num(double? value)
        {
            if (!value.HasValue || double.IsNaN(value.Value) || double.IsInfinity(value.Value)) return "null";
            return value.Value.ToString("R", CultureInfo.InvariantCulture);
        }

        /// <summary>Extrai o valor de uma chave de string. Suficiente para as
        /// poucas mensagens que o cliente envia; não é um parser geral.</summary>
        public static string StringField(string json, string key)
        {
            string needle = "\"" + key + "\"";
            int at = json.IndexOf(needle, StringComparison.Ordinal);
            if (at < 0) return null;
            int colon = json.IndexOf(':', at + needle.Length);
            if (colon < 0) return null;
            int i = colon + 1;
            while (i < json.Length && char.IsWhiteSpace(json[i])) i++;
            if (i >= json.Length || json[i] != '"') return null;
            i++;
            StringBuilder sb = new StringBuilder();
            while (i < json.Length && json[i] != '"')
            {
                if (json[i] == '\\' && i + 1 < json.Length) i++;
                sb.Append(json[i]);
                i++;
            }
            return sb.ToString();
        }

        public static long? LongField(string json, string key)
        {
            string needle = "\"" + key + "\"";
            int at = json.IndexOf(needle, StringComparison.Ordinal);
            if (at < 0) return null;
            int colon = json.IndexOf(':', at + needle.Length);
            if (colon < 0) return null;
            int i = colon + 1;
            while (i < json.Length && char.IsWhiteSpace(json[i])) i++;
            int start = i;
            while (i < json.Length && (char.IsDigit(json[i]) || json[i] == '-')) i++;
            if (i == start) return null;
            long parsed;
            if (long.TryParse(json.Substring(start, i - start), NumberStyles.Integer,
                              CultureInfo.InvariantCulture, out parsed)) return parsed;
            return null;
        }
    }

    public static class Clock
    {
        private static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        public static long NowMs()
        {
            return (long)(DateTime.UtcNow - Epoch).TotalMilliseconds;
        }

        public static long ToMs(DateTime local)
        {
            return (long)(local.ToUniversalTime() - Epoch).TotalMilliseconds;
        }
    }

    public static class Values
    {
        /// <summary>
        /// Converte o VARIANT do RTD em número.
        /// O Profit devolve texto com vírgula decimal conforme a região; aceitar
        /// os dois separadores evita transformar 179,5 em 1795.
        /// </summary>
        public static double? ToNumber(object raw)
        {
            if (raw == null) return null;
            if (raw is double) return (double)raw;
            if (raw is float) return (double)(float)raw;
            if (raw is int) return (double)(int)raw;
            if (raw is long) return (double)(long)raw;
            if (raw is decimal) return (double)(decimal)raw;

            string text = Convert.ToString(raw, CultureInfo.InvariantCulture);
            if (string.IsNullOrEmpty(text)) return null;
            text = text.Trim();
            if (text.Length == 0) return null;

            // Erro do RTD chega como texto ("N/D", "#N/A", ...). Não é zero.
            if (text.StartsWith("#", StringComparison.Ordinal)) return null;
            if (text.Equals("N/D", StringComparison.OrdinalIgnoreCase)) return null;

            text = text.Replace(" ", "");
            if (text.Contains(",") && text.Contains("."))
            {
                // 1.234,56 -> milhar com ponto
                text = text.Replace(".", "").Replace(",", ".");
            }
            else
            {
                text = text.Replace(",", ".");
            }

            double parsed;
            if (double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out parsed))
            {
                return parsed;
            }
            return null;
        }

        /// <summary>
        /// Monta o instante de mercado a partir de HORA (e DATA quando houver).
        /// Sem hora confiável devolve null: o horário do candle NUNCA pode vir do
        /// relógio do PC.
        /// </summary>
        public static long? ToMarketTime(object timeRaw, object dateRaw)
        {
            string time = timeRaw == null ? null : Convert.ToString(timeRaw, CultureInfo.InvariantCulture);
            if (string.IsNullOrEmpty(time)) return null;
            time = time.Trim();

            TimeSpan parsedTime;
            if (!TimeSpan.TryParse(time, CultureInfo.InvariantCulture, out parsedTime))
            {
                string[] formats = new string[] { "HH:mm:ss", "H:mm:ss", "HH:mm", "HHmmss" };
                DateTime tmp;
                if (!DateTime.TryParseExact(time, formats, CultureInfo.InvariantCulture,
                                            DateTimeStyles.None, out tmp)) return null;
                parsedTime = tmp.TimeOfDay;
            }

            DateTime day = DateTime.Now.Date;
            string date = dateRaw == null ? null : Convert.ToString(dateRaw, CultureInfo.InvariantCulture);
            if (!string.IsNullOrEmpty(date))
            {
                DateTime parsedDay;
                string[] formats = new string[] { "dd/MM/yyyy", "d/M/yyyy", "yyyy-MM-dd", "dd/MM/yy" };
                if (DateTime.TryParseExact(date.Trim(), formats, CultureInfo.InvariantCulture,
                                           DateTimeStyles.None, out parsedDay)) day = parsedDay.Date;
            }

            return Clock.ToMs(day.Add(parsedTime));
        }
    }
}
