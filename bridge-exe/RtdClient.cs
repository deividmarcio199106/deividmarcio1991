/*
 * Cliente RTD — conversa com o Profit por COM.
 *
 * Um "tópico" no RTD é o par (ativo, campo). Para montar um negócio completo de
 * WINFUT assinamos ULT, MAX, MIN, VOL, HORA e os demais como tópicos separados,
 * e remontamos o conjunto aqui.
 *
 * Regra que atravessa o arquivo inteiro: campo que não veio é NULO, nunca zero.
 * Zero é um preço; ausência de dado não é. Trocar um pelo outro faria o T4
 * decidir sobre uma vela que não existiu.
 */

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace T4Bridge
{
    public class TopicKey
    {
        public string Symbol;
        public string Field;
    }

    public class SymbolState
    {
        public string Symbol;
        public Dictionary<string, object> Values = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
        public long Sequence;
        public double? LastPrice;
        public long? LastMarketTime;
        /// <summary>Assinatura do último tick emitido, para não repetir o mesmo negócio.</summary>
        public string LastSignature = "";
    }

    public class RtdClient
    {
        private readonly FieldMap fields;
        private readonly Action<string> log;

        private object comObject;
        private IRtdServer server;
        private RtdCallback callback;

        private int nextTopicId = 1;
        private readonly Dictionary<int, TopicKey> topics = new Dictionary<int, TopicKey>();
        private readonly Dictionary<string, SymbolState> symbols =
            new Dictionary<string, SymbolState>(StringComparer.OrdinalIgnoreCase);

        public bool Connected { get; private set; }
        public string LastError { get; private set; }
        /// <summary>Primeiro motivo de recusa do ConnectData, para o diagnóstico.</summary>
        public string ConnectError { get; private set; }
        /// <summary>true quando ao menos um campo foi aceito pelo servidor.</summary>
        public bool HasLiveTopics { get { return topics.Count > 0 && ConnectError == null; } }
        public int TopicCount { get { return topics.Count; } }
        /// <summary>Campos que o servidor recusou ou nunca preencheu.</summary>
        public readonly HashSet<string> SilentFields = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        public RtdClient(FieldMap fieldMap, Action<string> logger)
        {
            fields = fieldMap;
            log = logger;
        }

        /// <summary>
        /// Sobe o servidor RTD. Como o CLSID é LocalServer32 apontando para o
        /// profitchart.exe, isto inicia o Profit se ele estiver fechado — e
        /// falha se o Profit não estiver instalado.
        /// </summary>
        /// <summary>
        /// true quando o Profit já está em execução.
        ///
        /// A bridge NÃO abre o Profit. Medido em teste: ativar o COM com o
        /// Profit fechado faz o Windows iniciá-lo, o `ServerStart` responde
        /// normalmente, e aí TODO `ConnectData` estoura com violação de acesso
        /// dentro do profitchart.exe — porque o programa subiu na tela de login,
        /// sem sessão de dados. O erro parece da bridge e não é.
        /// </summary>
        public static bool ProfitRunning()
        {
            try
            {
                return System.Diagnostics.Process.GetProcessesByName("profitchart").Length > 0;
            }
            catch (Exception)
            {
                return false;
            }
        }

        public bool Start()
        {
            try
            {
                if (!ProfitRunning())
                {
                    LastError = "O Profit nao esta aberto. Abra o Profit, faca login e deixe o " +
                                "grafico do ativo na tela; so entao conecte a T4.";
                    return false;
                }

                Type type = Type.GetTypeFromProgID("RTDTrading.RtdServer", false);
                if (type == null)
                {
                    LastError = "O servidor RTD do Profit nao esta registrado neste Windows " +
                                "(ProgID RTDTrading.RtdServer). Abra o Profit uma vez e tente de novo.";
                    return false;
                }

                comObject = Activator.CreateInstance(type);
                server = comObject as IRtdServer;
                if (server == null)
                {
                    LastError = "O objeto COM do Profit nao expoe IRtdServer.";
                    return false;
                }

                callback = new RtdCallback();
                int started = server.ServerStart(callback);
                if (started != 1)
                {
                    LastError = "ServerStart devolveu " + started + " (esperado 1). O Profit pode " +
                                "estar sem login ou sem permissao de dado em tempo real.";
                    return false;
                }

                Connected = true;
                LastError = null;
                log("RTD conectado ao Profit (RTDTrading.RtdServer).");
                return true;
            }
            catch (Exception error)
            {
                LastError = "Falha ao iniciar o RTD: " + error.Message;
                Connected = false;
                return false;
            }
        }

        public void Subscribe(string symbol)
        {
            if (!Connected || string.IsNullOrEmpty(symbol)) return;
            symbol = symbol.Trim().ToUpperInvariant();
            if (symbols.ContainsKey(symbol)) return;

            SymbolState state = new SymbolState();
            state.Symbol = symbol;
            symbols[symbol] = state;

            int accepted = 0;
            int rejected = 0;
            foreach (string field in fields.All())
            {
                int topicId = nextTopicId++;
                TopicKey key = new TopicKey();
                key.Symbol = symbol;
                key.Field = field;
                topics[topicId] = key;

                try
                {
                    object[] args = new object[] { symbol, field };
                    bool getNewValues = true;
                    object initial = server.ConnectData(topicId, ref args, ref getNewValues);
                    if (initial != null) state.Values[field] = initial;
                    accepted++;
                }
                catch (Exception error)
                {
                    SilentFields.Add(field);
                    rejected++;
                    // Uma linha por campo viraria 12 linhas iguais. Guardamos o
                    // primeiro motivo e resumimos depois.
                    if (ConnectError == null) ConnectError = error.Message;
                }
            }

            if (rejected > 0)
            {
                log("ATENCAO: " + rejected + " de " + fields.All().Count + " campos recusados por " +
                    symbol + ".");
                log("  Motivo do RTD: " + ConnectError);
                if (ConnectError != null && ConnectError.IndexOf("Access violation",
                        StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    // Observado em teste: e o que o Profit responde quando esta
                    // aberto mas sem sessao de dados.
                    log("  Isso costuma significar Profit sem login ou sem dado em tempo real.");
                    log("  Faca login no Profit, abra o grafico do ativo e reconecte.");
                }
                else
                {
                    log("  Confira os nomes dos campos em t4-bridge.ini.");
                }
            }
            if (accepted > 0)
            {
                log("Assinado " + symbol + " (" + accepted + " de " + fields.All().Count + " campos).");
            }
        }

        public void Unsubscribe(string symbol)
        {
            if (!Connected || string.IsNullOrEmpty(symbol)) return;
            symbol = symbol.Trim().ToUpperInvariant();
            if (!symbols.ContainsKey(symbol)) return;

            List<int> remove = new List<int>();
            foreach (KeyValuePair<int, TopicKey> pair in topics)
            {
                if (string.Equals(pair.Value.Symbol, symbol, StringComparison.OrdinalIgnoreCase))
                    remove.Add(pair.Key);
            }
            foreach (int topicId in remove)
            {
                try { server.DisconnectData(topicId); }
                catch (Exception) { /* o servidor pode ja ter soltado o topico */ }
                topics.Remove(topicId);
            }
            symbols.Remove(symbol);
            log("Assinatura de " + symbol + " encerrada.");
        }

        /// <summary>
        /// Lê o que mudou e devolve os negócios novos.
        /// Chamada pela thread STA — é ela que possui o objeto COM.
        /// </summary>
        public List<Tick> Poll()
        {
            List<Tick> emitted = new List<Tick>();
            if (!Connected || callback == null) return emitted;
            if (!callback.TakePending()) return emitted;

            object[,] data;
            int topicCount = 0;
            try
            {
                data = server.RefreshData(ref topicCount);
            }
            catch (Exception error)
            {
                LastError = "RefreshData falhou: " + error.Message;
                Connected = false;
                return emitted;
            }
            if (data == null) return emitted;

            HashSet<string> touched = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            int columns = data.GetLength(1);
            for (int i = 0; i < columns; i++)
            {
                object idRaw = data[0, i];
                object value = data[1, i];
                if (idRaw == null) continue;

                int topicId;
                try { topicId = Convert.ToInt32(idRaw); }
                catch (Exception) { continue; }

                TopicKey key;
                if (!topics.TryGetValue(topicId, out key)) continue;

                SymbolState state;
                if (!symbols.TryGetValue(key.Symbol, out state)) continue;

                state.Values[key.Field] = value;
                touched.Add(key.Symbol);
            }

            foreach (string symbol in touched)
            {
                Tick tick = BuildTick(symbols[symbol]);
                if (tick != null) emitted.Add(tick);
            }
            return emitted;
        }

        private object Get(SymbolState state, string field)
        {
            object value;
            if (state.Values.TryGetValue(field, out value)) return value;
            return null;
        }

        /// <summary>
        /// Monta o negócio. Devolve null quando falta o essencial (preço e hora
        /// de mercado) ou quando é repetição do anterior.
        /// </summary>
        private Tick BuildTick(SymbolState state)
        {
            double? price = Values.ToNumber(Get(state, fields.Last));
            if (!price.HasValue || price.Value <= 0) return null;

            long? marketTime = Values.ToMarketTime(Get(state, fields.Time), Get(state, fields.Date));
            if (!marketTime.HasValue)
            {
                // Sem hora do mercado nao ha candle possivel. Registrar uma vez
                // por sessao e seguir — inventar Date.now() aqui seria o erro
                // que este projeto inteiro existe para nao cometer.
                if (SilentFields.Add(fields.Time))
                {
                    log("AVISO: campo de hora (" + fields.Time + ") vazio. Sem hora do mercado " +
                        "nao ha candle. Confira o nome do campo em t4-bridge.ini.");
                }
                return null;
            }

            double? volume = Values.ToNumber(Get(state, fields.Volume));
            string signature = price.Value.ToString("R") + "|" + marketTime.Value + "|" +
                               (volume.HasValue ? volume.Value.ToString("R") : "-");
            if (signature == state.LastSignature) return null;
            state.LastSignature = signature;

            state.Sequence++;
            state.LastPrice = price;
            state.LastMarketTime = marketTime;

            Tick tick = new Tick();
            tick.Symbol = state.Symbol;
            tick.Timestamp = marketTime.Value;
            tick.Price = price.Value;
            tick.Open = Values.ToNumber(Get(state, fields.Open));
            tick.High = Values.ToNumber(Get(state, fields.High));
            tick.Low = Values.ToNumber(Get(state, fields.Low));
            tick.Close = Values.ToNumber(Get(state, fields.Close));
            tick.Bid = Values.ToNumber(Get(state, fields.Bid));
            tick.Ask = Values.ToNumber(Get(state, fields.Ask));
            tick.Volume = volume;
            tick.Qty = Values.ToNumber(Get(state, fields.Qty));
            tick.Trades = Values.ToNumber(Get(state, fields.Trades));
            tick.Source = "RTD";
            tick.Sequence = state.Sequence;
            tick.ReceivedAt = Clock.NowMs();
            return tick;
        }

        public void Stop()
        {
            if (server != null)
            {
                try { server.ServerTerminate(); }
                catch (Exception) { /* o Profit pode ter fechado antes */ }
            }
            if (comObject != null)
            {
                try { Marshal.ReleaseComObject(comObject); }
                catch (Exception) { }
            }
            server = null;
            comObject = null;
            Connected = false;
        }
    }
}
