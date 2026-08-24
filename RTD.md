> ## ⚠️ DEPRECIADO — este NÃO é o pipeline oficial
>
> O pipeline em produção é o **Profit Vision**: captura de tela contínua (60 s),
> auto-crop e leitura visual. RTD, planilha e `t4-bridge` **não participam do
> runtime** — `src/lib/__tests__/noLegacyPipeline.test.ts` falha se alguma
> importação os trouxer de volta.
>
> Este documento fica como registro histórico do modo RTD e como referência para
> a ponte que ainda existe fora do runtime (`npm run bridge`). Nada aqui descreve
> como o motor decide hoje.

# Modo RTD — dado real do Profit como fonte oficial

```
Profit ──RTD──> Excel ──HTTP──> t4-bridge ──WebSocket──> site ──> candles 1Min ──> T4
```

| Papel | Quem |
|---|---|
| **Dado** | RTD (preço, hora, volume) |
| **Visual** | Profit — só conferência humana |
| **Decisão** | T4, determinística, sobre candle fechado |
| **Apoio** | IA — revisa código, nunca cria mercado |

No modo RTD **nada** depende de OCR, escala de pixel, âncora, calibração ou do
relógio do gráfico. Esses módulos continuam existindo para o modo Profit legado,
que segue disponível e separado.

---

## 1. Como iniciar

```bash
node bridge/t4-bridge.mjs
```

Bridge em `ws://127.0.0.1:8765` **e** `wss://localhost:8765` — os dois esquemas
na mesma porta, junto de `/health` e `/ingest`. Sem dependências: não precisa de
`npm install`. Roda em Node 18+ ou Bun.

Para produção em HTTPS, prepare o TLS uma única vez:

```powershell
powershell -ExecutionPolicy Bypass -File bridge\tls\setup-rtd-tls.ps1
```

Depois, o site:

```bash
npm run dev
```

Ou os dois de uma vez, com prova de que subiram:

```bash
npm run t4:start
```

Outros comandos: `npm run t4:doctor` (config check), `npm run t4:test`,
`npm run t4:stop`, `npm run bridge:test`.

O site escolhe o esquema sozinho, pelo protocolo da própria página:

| Página | Endereço usado |
|---|---|
| `https://analisador.dvdswap.com.br` | `wss://localhost:8765` |
| `http://localhost:3000` (dev) | `ws://127.0.0.1:8765` |

Um `ws://` gravado antes do suporte a TLS é promovido para `wss://` na
inicialização — a preferência antiga não derruba a produção.

**Não abra produção por `http://localhost`.** Isso trocaria o problema por um
contorno que some no dia em que alguém acessar o site pelo endereço normal.

## 2. Como conectar o RTD

Detalhes em [`bridge/README.md`](bridge/README.md). Resumo: uma planilha Excel
com fórmulas `=RTD("RTDTrading.RtdServer";;$A2;"ULT")` publica na bridge, por um
destes caminhos:

- **`bridge/rtd/T4_RTD.bas`** — módulo VBA, envia no evento de recálculo (menor latência);
- **`bridge/rtd/Push-ProfitRtd.ps1`** — PowerShell lendo a planilha aberta por COM (sem macro);
- **seu próprio produtor** — qualquer `POST /ingest` no contrato documentado.

Não existe modo simulado. Profit fechado = bridge sem dados = T4 bloqueado.

## 3. Na tela

`Operação ao Vivo` → **FONTE DE DADOS: [ PROFIT ] [ RTD ]** — RTD é o recomendado.

O console RTD mostra Bridge · RTD · Ativo · Preço · MarketTime · Latência ·
Idade · Drift · Candles · Integridade · Ticks · T4, e os 19 gates em ordem.

`/diagnostico` traz **🔍 DIAGNÓSTICO COMPLETO**, **🤖 CORRIGIR COM IA**,
**MODO ENGENHEIRO**, **REPRODUZIR ERRO** e o SCORE 0–100.

## 4. Os gates

**Dado (8)** — enquanto qualquer um reprovar, os técnicos aparecem como
`BLOCKED`, não como reprovados. "Não avaliei" é honesto; "reprovou" seria mentira.

`BRIDGE_CONNECTED` · `RTD_CONNECTED` · `DATA_FRESH` · `TIME_SYNC` ·
`PRICE_VALID` · `SYMBOL_VALID` · `CANDLE_STREAM` · `HISTORY_READY`

**Técnicos (11)** — derivados do `AnalysisResult`; nenhum recalcula técnica:

`CONTEXT` · `STRUCTURE` · `LOCATION` · `LIQUIDITY` · `REACTION` ·
`STRUCTURE_SHIFT` · `POI_RETEST` · `CONFIRMATION_CANDLE` · `STOP_VALID` ·
`RISK_REWARD` · `T4_SIGNAL`

`BRIDGE_CONNECTED` e `RTD_CONNECTED` são coisas diferentes de propósito: a
bridge estar de pé não prova que o Profit está publicando.

## 5. Sincronia e integridade

- O bucket do candle vem do `timestamp` do RTD, **nunca** de `Date.now()`.
- O frescor é medido na base de tempo da **bridge**, corrigida por ping/pong
  (NTP simplificado). Um relógio de Windows errado não vira sinal de mercado.
- `> 3s` → `DATA_DELAYED`. `> 10s` → `DATA_STALE` e T4 em `PAUSED_DATA`.
- Cada tick é validado: symbol, preço, timestamp, duplicidade, ordem temporal,
  lacuna de sequência e outlier impossível. **Preço nunca é corrigido** — o tick
  sai da série e a recusa fica registrada com motivo.
- `seq` monotônico por ativo revela tick perdido; `sessionId` novo significa
  bridge reiniciada, e a série é zerada em vez de emendada.
- Minuto sem tick **não vira candle**. O buraco é declarado (`DATA_GAP`) e o T4
  pausa até a série voltar a ser contínua.
- Trocar de ativo zera candles, histórico, monitor e gravação de replay.

## 6. Candles

OHLCV de 1 minuto, fechados uma única vez na virada. Volume vem da soma de `qty`
quando disponível; senão, do delta do volume acumulado. Máximo de 500 candles.
Candle fechado é congelado — tick atrasado para minuto selado é recusado.

## 7. Diagnóstico e observabilidade

- `/api/health` · `/api/diagnostics` · `/api/ai/health` · `/api/ai/providers` ·
  `/api/rtd/health` · `/api/t4/health`
- `/api/t4/health` **executa** o motor sobre uma série sintética determinística
  para provar que o pipeline roda. Esses candles nunca alimentam decisão, banco
  ou gravação, e isso está dito na própria resposta.
- `/api/rtd/health` responde `client-side` e `proven: false`: a bridge é local ao
  operador e o servidor não a alcança. Afirmar saúde daqui seria health falso.
- **SCORE 0–100**: FAIL em domínio crítico limita em 60; crítico não provado
  limita em 90; qualquer FAIL limita em 99. Um `PASS` sem prova é rebaixado a
  `WARNING` automaticamente, na construção do check.
- Timeline técnica com `CANDLE_CLOSED`, `DATA_GAP`, `T4_SIGNAL_CONFIRMED` etc.,
  carimbada com hora de mercado quando disponível.
- **REPRODUZIR ERRO**: reconstrói os candles a partir dos ticks brutos gravados e
  compara com o que a sessão produziu. Divergência aponta bug no agregador.
  O bundle exportado leva ticks, candles, gates, timeline e versão da técnica.
- **POR QUE ESSA ENTRADA?**: contexto, liquidez, estrutura, shift, POI, reteste,
  candle de confirmação, entrada, stop, R:R e cada gate aprovado/reprovado —
  tudo lido de campo do motor, nada gerado por IA.

## 8. IA

Router `Claude → OpenAI → Gemini → Ollama/Qwen`, com estados `READY`, `ERROR`,
`OFFLINE`, `RATE_LIMIT`, `FALLBACK`. Chaves ficam **só no servidor**
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OLLAMA_BASE_URL`).

A IA lê arquivos por uma **allowlist** (`src/`, `bridge/`, `migrations/`,
`docs/`) com negação explícita de `.env`, chaves, credenciais, banco e
`node_modules` — a negação vence a permissão.

`REVISÃO MULTI-IA`: um modelo propõe, outro procura o defeito.

**A IA não escreve no disco.** Ela devolve proposta e diff; aplicar continua
sendo um passo humano. Um clique no navegador que grava arquivo no servidor é
execução remota de código, não ferramenta de diagnóstico.

## 9. Arquivos

**Bridge:** `bridge/t4-bridge.mjs`, `bridge/lib/httpServer.mjs`,
`bridge/lib/wsServer.mjs`, `bridge/selftest.mjs`, `bridge/rtd/T4_RTD.bas`,
`bridge/rtd/Push-ProfitRtd.ps1`, `bridge/README.md`

**RTD:** `src/lib/rtd/{types,bridgeClient,feedMonitor,candleAggregator,gates,progress,timeline,replayRecorder,dataSource}.ts`,
`src/hooks/useRtdSession.ts`, `src/lib/rtd/__tests__/`

**Diagnóstico:** `src/lib/diagnostics/{types,clientChecks}.ts`,
`src/server/diagnosticsEndpoints.ts`, `src/server/sourceAccess.ts`,
`src/services/ai/router.ts`, `src/lib/aiFix.functions.ts`,
`src/routes/diagnostico.tsx`

**UI:** `src/components/rtd/{RtdConsole,SignalExplanation}.tsx`,
`src/components/AnalyzerProvider.tsx`, `src/components/StatusBar.tsx`,
`src/routes/operacao-ao-vivo.tsx`

**Deploy:** `updater/` — veja [`updater/README.md`](updater/README.md)
