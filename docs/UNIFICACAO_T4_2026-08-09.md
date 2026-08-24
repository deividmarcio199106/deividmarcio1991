# Unificação e finalização — 2026-08-09

Consolidação dos comandos "CORREÇÃO/FINALIZAÇÃO GERAL" e "AUDITORIA TOTAL +
CENTRAL DE ERROS + CLAUDE ADMIN". A lógica oficial T4.0.0 (gates, RR>=3,
contrato1=3R, contrato2=5R, contrato3=runner estrutural, anti-lookahead) não
foi alterada.

## Causa raiz dos problemas

1. **Captura morria ao trocar de rota**: o MediaStream, o `<video>` e o loop de
   frames viviam DENTRO dos hooks das páginas (`useContinuousChartCapture` com
   `useEffect(() => () => stop())`). Desmontar a rota parava a captura e os
   hooks de sessão recriavam candles/contexto/T4 do zero.
2. **Tempo dos candles vinha de `Date.now()`**: no replay acelerado o candle só
   fechava após 1 minuto REAL, descolando do horário do gráfico.
3. **Não existiam**: gravação persistente, snapshot congelado do sinal, som de
   confirmação, progresso 0–100 real, diagnóstico por etapa, central de erros e
   admin.

## O que foi feito

- **ScreenCaptureManager singleton** (`src/lib/capture/screenCaptureManager.ts`):
  MediaStream + `<video>` de processamento + loop de frames fora do React;
  latest-frame-wins (amostra sempre o frame atual; idênticos deduplicados por
  hash; ordem dos candles fechados preservada pelos reconstrutores). Sem
  coordenadas fixas: tudo em frações da largura/altura (Profit movido/
  redimensionado/maximizado, zoom 50–125%).
- **AnalyzerProvider no layout raiz** (`src/components/AnalyzerProvider.tsx`):
  as sessões de Operação ao Vivo e Backtest são criadas UMA vez no shell; as
  rotas apenas consomem. Trocar de rota não para captura, não zera candles e
  não reinicia o T4.
- **Replay = ao vivo**: ambos usam o MESMO `analyze()`/`evaluateT4` com candle
  fechado (já era assim) e agora também o MESMO snapshot congelado + som único
  na confirmação.
- **MarketClock** (`src/lib/vision/marketClock.ts`): quando o chartClock (OCR
  do eixo de tempo) é válido, `marketTime = chartClock` — os candles ao vivo
  são bucketizados pelo horário do GRÁFICO (replay 1x/2x/5x/10x fecha candle no
  ritmo do gráfico, sem esperar 1 min real). Fallback realtime somente sem
  chartClock, com motivo registrado e exposto no diagnóstico. Monotônico:
  correção de OCR nunca retrocede o tempo.
- **Diagnóstico real** (`src/lib/t4/diagnostics.ts` + card): CAPTURE_ACTIVE,
  PROFIT_DETECTED, GRAPH_DETECTED, PRICE_AXIS, TIME_AXIS, CHART_CLOCK,
  CANDLES_VISIBLE, CANDLES_PARSED, CANDLES_SENT_TO_T4, LAST_FRAME, LAST_CANDLE,
  LATENCY, T4_STATE, BLOCK_REASON, OLLAMA_STATUS. Gráfico visível com candles=0
  gera erro ESPECÍFICO (nunca só "AGUARDANDO GRÁFICO").
- **Progresso T4 0–100** (`src/lib/t4/progress.ts` + `T4ProgressCard`):
  0=não iniciado · 10=captura · 20=Profit · 30=gráfico · 40=preços/escala ·
  50=chartClock · 60=estrutura · 70=liquidez · 80=contraponto ·
  90=confluências/gates avaliados · 100=CONFIRMADO + signalId válido.
  Degraus monotônicos, derivados EXCLUSIVAMENTE do estado real — nunca timer,
  nunca chance de gain. <100%: "CARREGAMENTO DA TÉCNICA T4" + bloqueios reais,
  direção/níveis ocultos. 100%: COMPRA/VENDA, ENTRADA, STOP, 3R, 5R, RUNNER do
  snapshot. O preview/gráfico grande foi removido SOMENTE da UI; o
  processamento continua no serviço global.
- **TradeSignalSnapshot imutável** (`src/lib/t4/signalSnapshot.ts`):
  `Object.freeze` com signalId, version=T4.0.0, asset, chartTimestamp,
  direction, entry, initialStop, 3R, 5R, runnerInitial, setup e
  confirmationCandle. Após CONFIRMADO nada recalcula/oscila; só o
  gerenciamento T4 existente evolui o currentStop.
- **Som** (`src/lib/t4/signalSound.ts`): alerta forte 1x por signalId
  (dedupe permanente), timbres diferentes para compra/venda, ON/OFF + teste em
  /configuracoes.
- **Gravação** (`src/lib/recording/screenRecordingManager.ts` +
  `src/server/recording*`): ScreenRecordingManager singleton; MediaRecorder com
  chunks de ~2 s enviados progressivamente para disco
  (DATA_DIR/recordings/<sessão>/) com manifesto no SQLite. GRAVANDO somente com
  recorder.state=recording + primeiro chunk persistido + sessão no DB. Recorder
  caiu → RECORDER_ERROR + 1 restart (mesmo sessionId, novo segmento, nada é
  apagado). STOP força o último dataavailable, drena a fila e valida bytes>0.
  `GET /api/recording/status/:sessionId` devolve recorderState, chunksSaved,
  bytesSaved, lastChunkAt, duration, status, error. Eventos T4 sincronizados
  (realTimestamp + chartTimestamp) em `recording_events`. Falha com análise
  ativa → "ANÁLISE ATIVA — GRAVAÇÃO FALHOU".
- **Ollama**: health real (chamada verdadeira ao endpoint da VPS) com
  reachable, modelAvailable, visionModelAvailable, model, latency e agora
  lastSuccessAt/lastErrorAt/lastError. ONLINE só depois de chamada real.
- **Central de Erros `/erros`**: tabela `error_events` com id, timestamp,
  severity (INFO/WARNING/ERROR/CRITICAL), source (FRONTEND/BACKEND/API/T4/
  CAPTURA/CHART_CLOCK/OCR/GRAVACAO/OLLAMA/DB/REDE/BUILD), route, message,
  stack, context, sessionId, signalId, resolved, occurrences, firstSeen,
  lastSeen. Agrupamento de repetidos, filtros, VER DETALHES/COPIAR/RESOLVER/
  REABRIR/LIMPAR/CORRIGIR COM CLAUDE. Sanitização automática de segredos ANTES
  de persistir (`src/lib/errors/sanitize.ts`). Captura global de
  window.onerror/unhandledrejection + erros de backend. Health Center na mesma
  tela (SITE/API/DB/T4/CAPTURA/PROFIT/GRÁFICO/CHART_CLOCK/GRAVAÇÃO/OLLAMA/
  CLAUDE API) com estado REAL.
- **Claude Admin `/claude`** (+ botão CLAUDE na Operação ao Vivo): chat com a
  API Anthropic SOMENTE server-side (`ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` no
  .env; nunca no navegador/bundle/logs). Autenticação por `ADMIN_TOKEN` +
  rate-limit. Ferramentas internas controladas: listFiles, readFile,
  searchCode, proposePatch, runCommand (whitelist fixa test/typecheck/lint/
  build/git diff/git status, atrás de `CLAUDE_ADMIN_ALLOW_COMMANDS=1`). Sem
  shell arbitrário; path traversal, .env, .git, .ssh, chaves e credenciais
  bloqueados. Fluxo: proposta → DIFF (antes/depois + linhas ±) → testes →
  APROVAÇÃO do usuário → aplicar com snapshot automático → REVERTER quando
  quiser (`admin_changes` + backups em DATA_DIR/claude-admin/backups). O
  system prompt proíbe alterar gates/entrada/stop/RR/3R/5R/runner/anti-lookahead
  silenciosamente.
- **Somente T4**: removidos o motor antigo de replay por vídeo
  (`replayEngine.ts`, `replaySession.ts`), o gráfico grande
  (`TradingChart.tsx`, `poiZonesPrimitive.ts`, `replayOverlay.ts`) e a
  dependência `lightweight-charts`. Nenhum seletor/fallback de técnica antiga
  existe no runtime — a única decisão é `evaluateT4` (T4.0.0).
- **Aprendizado**: pipeline DAILY_REVIEW→SHADOW→BACKTEST→OOS→WALK_FORWARD→
  VALIDATED→EXPLICIT_PROMOTION intacto; produção congelada durante a sessão;
  promoção só explícita (endpoint technique-promote), nunca automática.

## Verificação

- `vitest run`: 240 testes passando (inclui novos testes de marketClock,
  progresso 0–100, snapshot imutável, som 1x, sanitização, path guard do
  admin, manifesto de gravação e central de erros).
- `tsc --noEmit`: limpo. `eslint`: 0 erros. `vite build`: ok.
- Smoke no build final: 10 rotas SSR 200; /api/errors com sanitização e 401
  sem token; /api/recording chunk→status→stop com bytes reais; /api/admin/
  claude/status e /chat com mensagens de erro seguras sem a chave.

Sem PM2 restart e sem deploy — aguardando autorização.
