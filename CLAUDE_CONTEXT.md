# CLAUDE_CONTEXT — Checkpoint do Analisador T4 / NEXUS

> Gerado em 2026-08-18. Leia este arquivo inteiro antes de mexer em qualquer
> coisa. Ele existe porque o repositório local já foi apagado uma vez e o
> servidor já foi sobrescrito por outra linha de desenvolvimento uma vez —
> os dois eventos estão documentados abaixo.
>
> **Reverificado em 2026-08-18 07:50–07:53** por sessão independente, contra o
> estado real: git local/remotos, `.deployed-commit` na VPS, HTTPS externo,
> typecheck e suíte completa de testes. Itens conferidos estão marcados
> "(verificado 18/08)"; fatos que mudaram foram corrigidos no texto.

---

## 0-bis. ATUALIZAÇÃO 2026-08-24 — OS 9 BLOCOS ESTÃO CONCLUÍDOS

> O placar do §0.2 abaixo ficou HISTÓRICO. Estado final da correção:
> BLOCOS 1–9 concluídos, cada um com commit próprio e 4 gates verdes:
> B1 90fde1e · B2 38eda04 · B3 623c358 · B4 0a30696 · B5 64c57dc ·
> B6 7472e8d (correção 590251e) · B7 2f82382 · B8 9317236 · B9 334130e.
> FINAL: teste E2E da cadeia completa (e2eCadeiaCompleta.test.ts — print→
> T4→E2 fechado→zona T4.2→fill→Luna→Terra→CONFIRMADO→freeze→gestão→
> fechamento→ledger com custos+dedup) e relatório §31 com flags §30 em
> docs/RELATORIO_CORRECAO_9BLOCOS.md. Suíte: 1492 passed / 12 skipped.
> Schema do banco: v8 (migration 010 trades_dedup).
> PRONTA_PARA_OPERACAO_ASSISTIDA = false (bloqueadores reais no relatório:
> N=0, sem VALIDATION/WF/OOS, OpenAI sem créditos, março 13–22 não
> processado, OCR de vídeo pausado). Validação de ABRIL segue fechada —
> decisão do operador. PRÓXIMO PASSO: decisão do operador (reprocessar
> março como referência com o motor T4.2 novo, ou abrir abril).

## 0. CHECKPOINT DA SESSÃO 2026-08-23 — este bloco SUPERSEDE os números do §1

> Escrito ao fim da sessão de 23/08, com o estado conferido por `git log`,
> `npm test`, `tsc --noEmit`, `eslint` e `npm run build` REAIS — nada abaixo é
> promessa. O §1 antigo (18/08) fica como histórico; onde conflitar, vale aqui.

### 0.1 Estado verificado (23/08 ~21:40 BRT)

| Item | Valor |
|---|---|
| Branch / HEAD local | `main` @ `90fde1e` |
| origin/main (VPS, bare) | `c3b3ce9` — HEAD local está **3 commits À FRENTE, sem push** (`bb4f5aa`, `90fde1e` + o commit deste checkpoint). Deploy é decisão do operador. |
| Testes | 1433 passando, 12 skipped (135 arquivos) — suíte completa em ~7,5 min |
| Typecheck | limpo (`tsc --noEmit`) |
| Lint | 0 erros; 7 warnings pré-existentes (react-hooks/react-refresh) em arquivos NÃO tocados pela correção |
| Build | ok (vite/nitro) |
| Banco | schema **7** (seeds T4.1/T4.2, tabela `ai_validations`) |
| OpenAI | chave em `backend/.env` VÁLIDA, mas conta **sem créditos** (HTTP 429 no smoke) — Sol/Luna/Terra bloqueados até o operador adicionar créditos |

### 0.2 Comando vigente: CORREÇÃO em 9 blocos (base AVALIACAO_SENIOR_c3b3ce9.md)

Regras permanentes do comando (NÃO expirar): código+teste real prevalece sobre
documentação; provar import+uso runtime de tudo que se declarar pronto; não
redesenhar a T4; não afrouxar gate; **não mudar nenhum número de
`T42_EXECUTION`** (congelada, hash `c115a37b…`); **não abrir dados de
abril/julho** durante as correções; não deletar/enfraquecer teste para ficar
verde; sem force-push. Um bloco = um commit; após CADA bloco os 4 gates
(`npm test`, `typecheck`, `lint`, `build`) verdes antes do commit.

**Placar dos blocos:**

| Bloco | Estado | Prova |
|---|---|---|
| 1 — motor T4.2 real + 3 consumidores | **CONCLUÍDO** — commit `90fde1e` | `src/lib/t4/t42FillEngine.ts`; 22 testes do motor + 5 do tracker + 7 de cadeia (34 novos); consumidores: `setupTracker.ts` (fork CONFIRMED→reteste→fill/EXPIRED_NO_FILL/RISK_REJECTED), `quantBacktest.ts` (perfil `T42_HYBRID`, ledger `t42Events`, padrão T4.1 intocado — testado), `pregao.ts` (opção `experimento.execucaoT42`, contadores `t42Fills`/`t42ExpiredNoFill`; alcança o motor VIA `advanceSetup` — um ponto de decisão) |
| 2 — E2 fechado no runtime (detectOrderedPullback ligado; bypass rastreável) | PENDENTE | — |
| 3 — unificar pregao.ts (constantes de strategy/riskGate, sem ??0, paridade replay×analyze) | PENDENTE | — |
| 4 — dedup (UNIQUE em trades, ids determinísticos, "replay repetido não aumenta N") | PENDENTE | — |
| 5 — custos ligados no fechamento (costs_brl/result_brl/slippage; custo desconhecido = null) | PENDENTE | — |
| 6 — OpenAI no runtime só server-side (Terra/Luna na promoção; guard de janela; Sol offline) | PENDENTE (e bloqueado p/ smoke real por falta de créditos) | — |
| 7 — congelamento verificável (hash conferido na leitura; 409 em update de candidata) | PENDENTE | — |
| 8 — robustez do marketMonitor (listeners em try/catch, finally no ciclo, timer limpo) | PENDENTE | — |
| 9 — enforcement de dataset (mês→papel, OOS trancado sem hash, datasetSeen lido) | PENDENTE | — |
| FINAL — E2E print→…→ledger + relatório §31 com flags §30 provadas | PENDENTE | — |

**Flags:** NENHUMA flag de veredito declarada nesta sessão.
`PRONTA_PARA_OPERACAO_ASSISTIDA` segue **false** (homologação de 22/08: 0
operações válidas, N<30, sem OOS/walk-forward). Não iniciar Validação Abril —
decisão do operador.

### 0.3 O que esta sessão fez de fato (commits locais desde `340645c`)

- `0670b86` — travas auditadas: RR único (MIN_RR=3), E2 por contrato
  (lastClosedIndex), bloqueios nomeados (`blockCodes.ts`), borda 2,99/3,00.
- `23eaa2a` — OpenAI validador independente (Luna/Terra/Sol, Responses API,
  schemas estritos, persistência idempotente) + homologação final HONESTA:
  T4_FUNCIONAL=true, T4_DESTRAVADA=false, PRONTA=false (0 fills em 11 pregões
  de março; entrada limite nunca é tocada — motivação da T4.2).
- `197d238` — **T4.2-HYBRID_ENTRY congelada** ANTES de abrir dados novos
  (`techniqueT42.ts`, rulesHash `c115a37b…`, datasetSeen=["MARCO"]).
  MARÇO ESTÁ CONTAMINADO: nunca mais otimizar nele.
- `c3b3ce9` — reconstrução determinística de vídeo (OCR template + parser de
  candles por pixel) — base da auditoria sênior.
- `bb4f5aa` — OCR single-pass selado como **PAUSADO/NÃO VALIDADO** (aprendeu
  0% de acurácia; contador não lido; lição: `-ss` do ffmpeg desalinha frames).
- `90fde1e` — **BLOCO 1** (ver placar acima).

### 0.4 Erros/limitações ABERTOS (não esconder)

1. **OpenAI sem créditos** (429). Chave ok. Sol nunca rodou de verdade.
2. **OCR de vídeo: 0% de acurácia** — reconstrução de preço por OCR está
   PAUSADA (não retomar durante os blocos). O replay de vídeo segue lendo
   estrutura, não OHLC confiável ⇒ na T4.2 em vídeo o caminho comum é
   E2_OPEN_OR_UNKNOWN por falta de PROVA (comportamento correto).
3. **Estado t42 do setup NÃO é persistido no servidor** — vive no tracker do
   navegador; o payload do endpoint não envia `t42` (o `.strict()` não
   rejeita). Persistir é trabalho futuro, não afirmado como pronto.
4. Defeitos ALTA dos blocos 2–9 da auditoria sênior continuam abertos
   (dedup quebrado, custos órfãos, freeze reescrevível, monitor com 3 buracos,
   `services/ai/router.ts:83` lendo chave fora de `src/server`, etc.).
5. Baseline março: dias 13–22 não processados; N=0 execuções válidas.

### 0.5 Próximo passo EXATO

Retomar no **BLOCO 2** do comando de correção: ligar `detectOrderedPullback`
no `analysisPipeline.ts:214-226` → ramo `t4Engine.ts:230-235`; sem prova de
fechamento ⇒ BLOCKED `E2_OPEN_OR_UNKNOWN`; manter o bypass
`exigirCandleFechado:false` mas torná-lo RASTREÁVEL (flag
`provaFechamento:"DISPENSADA"` persistida e EXCLUÍDA das estatísticas de
homologação por padrão). Depois: 4 gates verdes → commit único do bloco →
BLOCO 3. Não abrir abril/julho; não tocar `T42_EXECUTION`.

---

## 1. ESTADO ATUAL

| Item | Valor |
|---|---|
| Repo local | `C:\Users\user\Desktop\projetos\ANALISADOR_T4_RTD` |
| HEAD = produção | `340645c` (DNA T4) — `.deployed-commit` na VPS confere; working tree limpo (deploy 18/08 15:19) |
| Repo autoritativo | bare em `root@179.197.238.143:/var/repo/analisador.git`, branch `main` (`origin` e `vps` = mesma URL; ver armadilha em §3) |
| Testes | 614 passando, 59 arquivos (18/08 16:35 — +29 da captura inteligente e do contrato do print) |
| Lint | 0 erros, 4 warnings pré-existentes (react-hooks/exhaustive-deps) |
| Typecheck / build | OK (typecheck re-executado 18/08) |
| Site | https://analisador.dvdswap.com.br — `/`, `/dna-t4`, `/analisar-print`, `/operacao-ao-vivo`, `/historico-prints`, `/diagnostico` 200 (18/08 pós-deploy) |
| Banco | schema **5**; migração 4→5 na VPS preservou 42 sessões ao vivo, 2 backtests e a técnica T4.0.0 PRODUCTION |
| Backend | `/api/health` 200; `/api/ai/health` **200 `status:"ok"`** — GPU no ar com qwen3.5:35b (18/08 15:56) |
| PM2 | processo `analisador`, porta 8081, na VPS 179.197.238.143 |

**A fonte da verdade é o bare repo da VPS.** O histórico completo do trabalho
está nos ~20 commits de `b94a28e` até `a8230b1` — as mensagens de commit são
longas de propósito e documentam cada defeito com causa e cenário.

---

## 2. ARQUITETURA (decisões vigentes — não reverter sem decisão do operador)

- **Pipeline ÚNICO Profit Vision**: `getDisplayMedia` → `useProfitVision` →
  `ChartTracker` → `analyze()` → `decide()` → máquina de entrada → operação.
  **RTD/bridge/8765/useLiveSession/CandleReconstructor foram REMOVIDOS do
  runtime por decisão explícita do operador** (não reintroduzir; o teste
  `src/lib/__tests__/noLegacyPipeline.test.ts` falha se voltarem).
- **Fonte única de estado**: `visionDiagnostics` montado uma vez no
  `AnalyzerProvider`; Operação ao Vivo, /diagnostico, /erros e StatusBar leem o
  MESMO objeto. Dois painéis nunca podem discordar do mesmo instante.
- **Guarda de preço** (`src/lib/t4/priceGuard.ts`): com `priceScaleReady=false`
  nenhum preço absoluto sai — campos E texto (`guardNarration` cobre frases,
  `guardRegion` cobre intervalos puros como "194.00–197.00").
- **Escala** (`src/lib/vision/scaleLabels.ts`): seleção de âncoras num lugar só;
  descarte POR RÓTULO (nunca a leitura inteira); corte de confiança 0.3 (a reta
  julga, não a autoavaliação do modelo); vão vertical mínimo 18%; normalização
  BR só corrige milhar com assinatura no TEXTO (`203.625`→203625; `263.70` é
  decimal e NUNCA é multiplicado — o laço de fatores antigo produziu preço
  negativo em produção).
- **Projeção pixel→preço** (`src/lib/vision/priceProjection.ts`): extração e
  costura ficam em unidade geométrica; conversão só na SAÍDA; checagem de faixa
  do contrato como última rede.
- **Antiduplicação de candles** (`chartTracker.ts`): fingerprint de frame
  idempotente + teto `MAX_NEW_CLOSED_PER_FRAME=2` + resync após
  `RESYNC_AFTER=6` recusas (gap legítimo não congela a série). Costurador
  converte casamento afim antes de anexar (`toMasterSpace`).
- **Versões separadas** (`src/lib/t4/version.ts`): `T4_PRODUCTION_VERSION`,
  `T4_ENGINE_VERSION` (engine-1.1.0), `T4_MANAGEMENT_VERSION`.
- **Gestão** (`src/lib/t4/management.ts`): PRODUCTION = 3 contratos 3R/5R/runner
  (decisão do operador); 60/40 é EXPERIMENTAL. `rrPlan` usa o perfil ativo.
- **Replay = Live**: `buildReadingState` único (mínimo 24 candles nos dois
  caminhos), mesmos riskParams, backtest passa pelos gates T4
  (`evaluateT4Gates` + `evaluateOperation` com `now` do candle). Teste:
  `replayIgualLive.test.ts`. `decide()` fica fora da paridade (consulta base
  histórica mutável — documentado).
- **Ativos** (`src/lib/t4/assets.ts`): config por ativo + custos + validação
  POR ativo E POR versão. **Nenhum ativo nasce liberado; WINFUT está
  IN_VALIDATION e não emite sinal de produção** — comportamento correto com
  base histórica em 0 casos. Liberação: `setAssetValidation()` (em memória,
  de propósito; falta UI/fluxo de aprovação).
- **Custos** (`src/lib/t4/costs.ts`): backtest desconta corretagem/emolumentos/
  spread/slippage; cada perna paga; `costR` null quando não conversível (nunca
  zero disfarçado).
- **Status por subsistema** (`subsystemStatus.ts`): GPU (health HTTP em
  `/api/ai/health`), CAPTURA, ESCALA (ERRO só após 4 falhas), T4 — independentes;
  erro de escala NÃO derruba GPU; nada acende verde sem sessão/prova.
- **Barra de progresso**: binária 0|100 (`visionT4Progress`) — pipeline
  funcional ou não; oportunidade é da MATURIDADE, não da barra.
- **Segurança**: `requireAdmin` (`src/server/adminGuard.ts`, header
  `x-admin-token` + rate-limit) protege `technique-promote` e
  `technique-candidates`; status VALIDATED é validado no SERVIDOR (amostra
  mínima + OOS + walk-forward); chave Gemini em header; mensagens de erro
  sanitizadas.

### Módulo DNA T4 (18/08 — mensuração estatística dos setups)
- **Vocabulário ÚNICO** (`src/lib/t4/dna.ts`): enums ASCII (A_PLUS/FORTE/
  CONTRA_TENDENCIA/…) usados na MESMA forma no classificador, no SQLite, no
  schema forçado do Ollama e no painel. `NAO_IDENTIFICADO` existe em toda
  dimensão que pode faltar — default substantivo afirmaria o que ninguém mediu.
- **Classificação PRÉ-RESULTADO, congelada no ARMAMENTO**
  (`useContinuousBacktest`, junto de `frozenAnalysisRef`): o DNA nasce com a
  janela daquele instante e NUNCA é reescrito. `setup_dna` é imutável; só
  `trade_id` é preenchido depois. Reclassificar sabendo o desfecho é viés
  retrospectivo — a estatística passaria a "descobrir" o que já sabia.
- **Sem indicador novo**: cada dimensão deriva do que o motor já lê (regime,
  amplitude real, POI, captura de liquidez, geometria dos candles fechados).
- **Tempo de mercado**: `marketTimeTrusted=false` ⇒ `tradingDate`/`hour` saem
  NULL. No replay sem OCR do eixo a grade é ancorada no relógio local; carimbar
  um pregão de março com a data de agosto contaminaria faixa horária, filtros
  de período e o corte treino/validação/OOS.
- **Guarda de amostra** (`dnaStats.ts`, `MIN_SEGMENT_SAMPLE=30`): métricas são
  exibidas sempre, mas abaixo do corte carregam `sufficient:false` e a frase
  "conclusão NÃO autorizada" — e a UI não pinta cor de conclusão. Vale também
  para os fatores de perda.
- **Custo**: `netAfterCostsR` só existe com custo conhecido em TODAS as
  operações do grupo; caso contrário null + `costNote`. `costR ?? 0` seria
  zero disfarçado. **Hoje `costR` é sempre null** (ver pendências).
- **Otimização de saída**: alvos 1R–5R sobre as MESMAS operações, contra a
  linha de base do gerenciamento real. Parcial realizada (`partialReachedR`)
  PROVA a ordem intra-trade e evita contar como stop alvos que ocorreram
  antes dele; alvo acima do MFE observado sai marcado `truncatedByExit` (é
  PISO, não medida — o mercado depois da saída real não foi observado).
  Trailing/BE não aparecem: exigem trajetória candle a candle não gravada.
- **Anti-overfitting**: `lab_experiments` conta hipóteses por versão-base
  (candidata criada por QUALQUER via registra experimento) e a régua de PF
  fora da amostra sobe com `1.3 + 0.2·log2(1+n)`.
- **Print → DNA**: bloco `dna` no schema forçado do Ollama + zod, com reparos
  DECLARADOS (status negativo ⇒ grade DESCARTADA; trend CONTRA arrasta
  position). `Date.now()` é legítimo só aqui: o print é a decisão do AGORA.
- **Painel** `/dna-t4`: detecções, performance segmentada (12 dimensões),
  PADRÕES ENCONTRADOS (sempre sugestão ao Laboratório, nunca bloqueio), POR
  QUE PERDEU (associação dita como associação) e otimização de saída.

### Captura Contínua de 60s (18/08 noite — DECISÃO FINAL do operador)
- **A captura por evento foi REMOVIDA** (`relevanceDetector`/`useSmartCapture`
  apagados). O operador testou o modo por evento no replay e decidiu de forma
  explícita: **um print real a cada 60 segundos, obrigatório, com o gráfico
  parado ou não**. Não recolocar detector de relevância sem decisão dele.
- **`marketMonitor`** (`src/lib/capture/marketMonitor.ts`, singleton fora do
  React como o capture manager, 12 testes com relógio falso): scheduler
  `setTimeout` ancorado em timestamp (drift corrigido; máquina dormiu →
  reancora, nunca rajada), heartbeat 1s (track live + currentTime avançando +
  dimensões — NUNCA chama IA), contador regressivo, fila de UM slot (minuto
  seguinte com IA ocupada CAPTURA normalmente e só o pendente mais novo
  espera; nunca duas requests), timeout de análise 180s liberando a fila,
  validação de frame (readyState/dimensões/track/variância contra frame
  preto/blob), captura em resolução nativa com rebaixa a 1920 só se estourar
  o limite de upload. Falha de captura não conta, não sobe e não para o ciclo.
- **Controles**: ANALISAR AGORA captura já sem deslocar o alvo do ciclo;
  PAUSAR segura o scheduler mantendo o stream; CONTINUAR recomeça em 60s
  cheios; ENCERRAR limpa tudo; onended → STREAM ENCERRADO + nova seleção.
- **Painel**: CAPTURA ATIVA · STREAM OK/CONGELADO · T4 MONITORANDO ·
  PRÓXIMO PRINT: Xs · ÚLTIMO PRINT: HH:MM:SS · ANÁLISE · CAPTURAS: N.
  Timeline da sessão numerada `#001 17:30 → status`.
- **Aceite do operador**: deixar 5 min rodando → #001..#005, um por minuto,
  cada um analisado, DevTools sem timer duplicado/request vazia/4xx-5xx
  silencioso, stream vivo durante a análise.

### Captura Inteligente (18/08 tarde — SUPERADA pela decisão acima; histórico)
- **Gatilho por EVENTO, nunca por relógio** (`src/lib/capture/relevanceDetector.ts`,
  puro, 12 testes): primeira captura imediata; depois só em NOVO_CANDLE,
  MOVIMENTO_PRECO (≥1,2% da altura), EXTREMO_ROMPIDO ou CANDLE_ATUAL (≥0,6%).
  Debounce de 2 ticks (leitura transitória de redesenho não dispara) +
  cooldown de 8s (freio, não gatilho). Cursor/menu/relógio não disparam:
  a comparação é estrutural (candles/priceY da região útil), `activity` de
  pixel nunca decide sozinha. Falha de captura NÃO marca o detector — o
  evento re-dispara em vez de morrer como "duplicado".
- **`useSmartCapture`** (hook): valida frame (readyState≥2, dimensões, track
  viva, variância de luminância contra frame preto, blob plausível), fabrica
  JPEG ≤1600px q0.92, fila de UMA análise com um slot pendente (evento novo
  substitui o que esperava), heartbeat de stream congelado (5s) com tentativa
  de `video.play()`, `onended` → "SELECIONAR JANELA NOVAMENTE". Estados:
  MONITORANDO→CAPTURANDO→ANALISANDO→MARCANDO→CONCLUÍDO→MONITORANDO.
- **Fluxo ÚNICO de análise**: a captura entrega a imagem à MESMA
  `analisarImagem` do print colado (rota), com motivo/código/latência; retry
  automático 1x só no caminho automático. Histórico guarda `capture`
  {motivo, code, latencyMs}. A pilha antiga (useScreenCapture + frameDiff +
  timer 60s) foi REMOVIDA.
- **Sidebar enxuta** (pedido do operador 18/08): restaram Analisar Print,
  Analisador, Aprendizado, DNA T4, Biblioteca. Operação ao Vivo, Erros,
  Claude Admin, Configurações e Gerenciamento saíram DO MENU — rotas vivas
  por URL (mesmo precedente de Dashboard/Backtest). Resumo do gerenciamento
  (contratos máx, risco/operação, saldo) agora dentro do Analisar Print.
- **Contrato do print endurecido** (testes reais com o 35b): entrada sem stop
  legível é rebaixada; timeframe com cara de contador regressivo ("41s") é
  descartado; níveis com magnitude mista (169 vs 169235 — milhar truncado)
  caem EM BLOCO com reparo declarado e rebaixam status confirmado; plano
  condicional (SE→ENTÃO, `conditionalPlans`) com gatilho/stop ilegível ou
  stop do lado errado é descartado com motivo.

### Módulo Analisar Print (novo, dois últimos commits)
- **Contrato anti-alucinação** (`src/lib/vision/printAnalysis.ts`): IA descreve,
  front desenha; todo número tem `visible` ("NÃO LEGÍVEL NO PRINT" em vez de
  palpite); coordenadas normalizadas 0–1; validador DESCARTA e reporta, nunca
  conserta; status incoerente com níveis é rebaixado com reparo dito.
- **Serviço** (`src/services/ai/chartVision.ts`): schema forçado no Ollama,
  regras T4 vão no prompt (modelo não cria regra), 1 re-prompt com o erro, depois
  erro controlado. `askAboutChartPrint` = chat (texto puro, nunca vira traço).
- **Próximo Print** (`nextScreenshot`): 4 estados, 15 gatilhos, nível só
  legível, ≤3 gatilhos no gráfico, IA instruída a não pedir print sem mudança.
- **Comparação** (`printComparison.ts`): DETERMINÍSTICA, sem modelo; só afirma
  o que os DOIS prints sustentam ("sumiu da análise" ≠ "rompeu" →
  "MUDANÇA NÃO CONFIRMÁVEL PELAS IMAGENS"); iguais → "NÃO PRECISA ENVIAR OUTRO
  PRINT AGORA".
- **UI** (`src/routes/analisar-print.tsx` + `src/components/print/*`): Ctrl+V
  global, drag-drop, upload, linha do tempo PRINT #1→#N reabrível, abas
  T4|AÇÃO, slider antes/depois (clip-path do overlay — mesmo bitmap), zoom em
  degraus, chat, feedback 👍/👎 com motivos.
- **Histórico** (`/historico-prints`, `src/lib/print/printHistory.ts`):
  localStorage, máx. 8, miniatura 900px JPEG (não o print cru), reabertura com
  aviso, feedback amarrado à entrada.

---

## 3. AMBIENTE / OPERAÇÃO

- **Node portátil**: `tools/node/node-v22.20.0-win-x64` (git-ignored; se sumir,
  baixar de nodejs.org e extrair ali) — padrão do projeto para validar/buildar.
  Além dele existe Node v24.19.0 com npm/npx no PATH do usuário
  (`C:\Users\user\nodejs\node-v24.19.0-win-x64`, desde 11/08), visível no
  PowerShell (verificado 18/08). Bun NÃO está instalado, apesar do `bun.lock`.
- **Bindings nativos win32** (instalar com `--no-save` após `npm ci`):
  `@rolldown/binding-win32-x64-msvc@1.2.0`, `lightningcss-win32-x64-msvc`,
  `@tailwindcss/oxide-win32-x64-msvc@<versão do oxide instalado>`.
- **Shell**: Git Bash; prefixar comandos com
  `export PATH="/usr/bin:/bin:/mingw64/bin:<node portátil>:$PATH"` (o PATH da
  sessão já quebrou mais de uma vez).
- **SSH/VPS**: host `t4vps` SUMIU do `~/.ssh/config` (substituído por
  `vision-vps` com outra chave). O repo usa remote por IP com chave explícita:
  `git config --local core.sshCommand "ssh -i /c/Users/user/.ssh/t4_vps ..."`,
  remotes `origin`/`vps` → `root@179.197.238.143:/var/repo/analisador.git`.
  **Armadilha dos remotes gêmeos**: push via `vps` NÃO atualiza o ref local
  `origin/main`, e o upstream de `main` é `origin` — `git status` passa a
  mostrar "ahead N" FALSO. Aconteceu em 18/08 (parecia haver 2 commits não
  publicados que JÁ estavam em produção); saneado com `git fetch origin`.
  Sempre fetch nos DOIS remotes antes de concluir que há commit não publicado.
- **Deploy**: `git push vps main` → hook `post-receive` roda npm ci, typecheck,
  TESTES e build em staging; publica só se tudo passar; rollback automático;
  backups em `/var/backups/analisador/`. Log: `/var/log/t4-autodeploy.log`.
- **PM2**: processo `analisador`. O hook usa `pm2 reload --update-env` mas NÃO
  carrega o `.env` — se variável nova entrar no `.env`, recarregar manualmente:
  `cd /var/www/analisador && set -a && . ./.env && set +a && pm2 restart analisador --update-env`.
  ATENÇÃO: `--update-env` MESCLA (não remove); para expurgar variável fantasma
  é preciso `pm2 delete` + `pm2 start` + `pm2 save` (já foi feito uma vez para
  matar uma ANTHROPIC_API_KEY inválida que vivia só na memória do PM2).
- **`.env` da VPS**: PORT, DATA_DIR, OLLAMA_BASE_URL=http://127.0.0.1:11435,
  **OLLAMA_TEXT_MODEL=qwen3.5:35b, OLLAMA_VISION_MODEL=qwen3.5:35b**
  (atualizado 18/08 15:56; backups `.env.backup-*` na mesma pasta),
  ADMIN_TOKEN (gerado por openssl na VPS; valor NUNCA passou pelo chat —
  recuperar com
  `ssh root@179.197.238.143 'grep ADMIN_TOKEN /var/www/analisador/.env'`).
- **GPU (19/08, instância ATUAL)**: Vast.ai RTX 5000 Ada (32 GB), instância `48064086`, `154.36.209.172:21222`, template vastai/ollama (JÁ VEM com qwen3.5:35b — não precisou de pull). A anterior (RTX 5090, 48035550) morreu em ~5h: instâncias Vast somem MESMO; religar é rotina, não incidente.
  **O qwen3.5:35b VOLTOU** — a instância traz ele e mais nada; declara
  `capabilities:["vision","completion","tools","thinking"]`, então serve texto
  E visão (é a configuração original do projeto, ver `.env.example` e
  `docs/DEPLOY.md`). Os qwen3:8b/qwen2.5vl:7b NÃO existem nesta instância —
  apontar o `.env` para eles deixa `/api/ai/health` em "degradado" com
  `modelAvailable:false` (contrato honesto, sintoma exato).
- **Religar o túnel** (instância Vast é efêmera; a cada nova, o IP e a PORTA
  mudam): `bash /root/religar-gpu.sh <IP> <PORTA_SSH>` na VPS. O script testa
  o SSH, confirma o Ollama, lista os modelos, reescreve
  `/etc/systemd/system/vast-gpu-tunnel.service` (`-L 127.0.0.1:11435:127.0.0.1:11434`),
  sobe com `Restart=always` e valida `/api/ai/health`. LIÇÃO 19/08: com o serviço em loop de crash, `enable --now` NÃO reinicia — o script agora usa `systemctl restart` explícito (sem isso o túnel continua tentando o endereço antigo com o unit novo já no disco). A porta SSH externa sai
  DENTRO da instância com `echo $VAST_TCP_PORT_22`; a chave pública que a
  instância precisa autorizar é `/root/.ssh/vast_gpu_ed25519.pub`.
  Se o modelo mudar, editar o `.env` e recarregar COM ele:
  `cd /var/www/analisador && set -a && . ./.env && set +a && pm2 restart analisador --update-env`.
- **Comportamento medido do 35b no OCR de escala** (18/08, amostra sintética
  com régua percentual): lê os rótulos e o formato BR corretamente
  (`171.500`→171500), respeita o schema forçado, responde em ~2,5 s com o
  modelo já na VRAM (~45 s na primeira chamada, carregando 23 GB) e
  **acerta o `linearScale`** — recusou uma escala propositalmente não-linear.
  O `yPercent` tem desvio de até ~4 pontos percentuais e às vezes omite um
  rótulo: é exatamente o erro sistemático que a régua percentual, a regressão
  robusta e a checagem de faixa do contrato existem para absorver. Vale
  acompanhar `scaleResidual`/R² no painel com print REAL do Profit.

---

## 4. HISTÓRICO CRÍTICO (eventos que explicam o estado)

1. **17/08**: `/var/www/analisador` foi SOBRESCRITO por outra linha de
   desenvolvimento (sem git, com arquivos como `candleValidation.ts`), apagando
   as correções do ar; o repo local também sumiu do Desktop. Recuperação: clone
   do bare repo. Backup daquela linha: `/var/www/analisador-versao-17ago-1001`.
   **Se outra sessão/ferramenta (Lovable?) publicar de novo por cima, é isto
   que aconteceu.**
2. **`.env` editado por terceiros em 12/08 13:14** (trocou modelos do Ollama,
   removeu ANTHROPIC). Backups: `.env.backup-*` em `/var/www/analisador/`.
3. **localizações antigas do projeto**: `Desktop/ANALISADOR_T4_RTD` (apagada) →
   `Desktop/projetos/ANALISADOR_T4_RTD` (apagada) → recriada por clone. Cópias
   sem git existem em `Desktop/vision_prod`, `projetos/vision`,
   `projetos/vision-audit` — NÃO têm as correções; não usar como base.
   `vision_prod` é a linha VISION separada, com deploy próprio (ritual
   `deploy-vision.ps1`, porta 3002) e build gerado na noite de 17→18/08
   (`Desktop/vision.zip` de 00:00) — não confundir com o analisador (8081).

---

## 5. PENDÊNCIAS

### Do operador (bloqueiam verificação, não desenvolvimento)
- ~~Túnel da GPU fora~~ **RESOLVIDO 18/08 15:56**: túnel religado
  (`vast-gpu-tunnel` ativo e habilitado no boot), `/api/ai/health` = 200 com
  `status:"ok"`, texto e visão disponíveis, breaker fechado. Inferência de
  texto e OCR de visão validados de verdade pelo túnel. **Falta o teste com
  print REAL do Profit em `/analisar-print`** — é o que fecha os critérios
  7–18 do pedido original e mede o `yPercent` em imagem de verdade.
- **ANTHROPIC_API_KEY**: decisão do operador = ele mesmo edita o `.env`
  ("esqueca de chave api apague la vou editar tudo aqui"). Já foi expurgada do
  PM2. Sem ela, /claude e "CORRIGIR COM IA" ficam fora (motor T4 não depende).
- **Custos reais da corretora** em `src/lib/t4/assets.ts` (valores atuais são
  ponto de partida B3: 0,50+0,27 por contrato/perna, 1 tick spread/slippage).



### Onda final da spec de 39 pontos (20/08 madrugada)
- **Setup persistente** (setupTracker.ts, 13 testes): máquina única
  SEM_SETUP→…→CONFIRMADO/INVALIDADO/EXPIRADO; setupId T4-AAAA-MM-DD-XXX; o
  MESMO setup atravessa prints; TOQUE NÃO É ENTRADA (toque + confirmação do
  modelo + auditor não-reprovado + confiança de entrada >= 60 + R:R >= 1,5);
  cooldown 5min pós-confirmação; TTL 40min; card SETUP T4 na tela com
  distância em pts/% e pré-alerta T4 PRÓXIMA — PREPARAR. LINHA ROXA
  "ENTRAR SE TOCAR AQUI" desenhada pela RÉGUA (sem calibração não desenha).
- **§8 cores**: ENTRADA = ROXO (#a855f7) nos dois lados (o lado é do
  triângulo/label); stop vermelho; alvo verde; T4_PAST virou ciano.
- **Auditor IA** (§11): segunda passada adversarial no servidor após a
  validação — tenta REPROVAR (direção vs estrutura, overlay vs texto, número
  ilegível afirmado, esticado sem reteste…); preenche analysis.audit;
  falha de IA = null (análise nunca cai); reprovado ⇒ gate do setup veta.
- **Confianças por camada** (§12): bloco confidences (contexto/estrutura/
  t4/entrada) no contrato; entrada < 60 bloqueia no gate mesmo com o resto alto.
- **T4 AUTO RESEARCH v1** (§25-§30): rota /pesquisa — IMPORTAR CSV (parser
  tolerante PT/EN, ;/vírgula e ,/ponto, problemas contados linha a linha) →
  INICIAR PESQUISA → motor quant HEADLESS com o pipeline T4 REAL candle a
  candle (anti-look-ahead estrutural TESTADO: prefixo == série completa até o
  corte; futuro mutado não reescreve passado), OOS declarado (últimos 15%),
  walk-forward por folds cronológicos, Monte Carlo com seed fixa (LCG;
  Math.random proibido) e ranking que NUNCA elege por lucro (amostra < 30 =
  inelegível dito). E2E verificado no navegador com CSV sintético de 600
  candles: 0 setups (honesto em série sintética), 23 descartes declarados,
  ranking INELEGÍVEL com a nota certa. Endpoints: research/import,
  research/run, research/runs; tabelas imported_candles/research_runs.
- **§24**: POST /api/trading/memory-hypotheses (admin) — fatores que
  sobre-representam perdas na memória viram candidatas DISCOVERED + experimento
  contado (a régua anti-overfitting sobe sozinha).
- **§34 parcial**: badge IA OK/FORA no painel de captura (health HTTP 30s).
- PENDENTE da spec (real): multi-timeframe (§16), score T4 detalhado (§18),
  shadow mode AO VIVO (§33 — na pesquisa a comparação é pelo ranking), health
  monitor completo (§34), replay visual auditável dedicado (§31 — o backtest
  contínuo cobre parte), resultado automático de SETUPS ao vivo (§21 — hoje
  cobre previsões de print).

### VIÉS ≠ ENTRADA CONFIRMADA (19/08 — correção de causa raiz)
Defeito relatado com print real: a tela exibia `T4 EM FORMAÇÃO — COMPRA` com
ENTRADA, STOP, ALVO e R:R todos NÃO IDENTIFICADOS. `direction` é o VIÉS da
estrutura; o operador lia como ordem.
- **Regra única** em `printAnalysis.ts`: `evaluateEntryProof` (níveis entram por
  parâmetro) + `deriveEntryDecision` (olha só o print) + `applyConfirmationGate`
  (rebaixa e DIZ). Exige TUDO junto: lado; entrada/stop/alvo NUMÉRICOS; níveis
  coerentes com o lado; R:R ≥ 1,5; **candle de confirmação FECHADO** (pavio não
  confirma); status do modelo; auditor não reprovado (null = não rodou, nunca
  derruba); confianças reportadas com entrada ≥ 60; leitura visual ≥ 60.
  Faltando qualquer item: `entradaConfirmada=false`, status cai para
  PRE_ENTRADA (níveis completos) ou T4_EM_FORMACAO, com a pendência dita.
- **A trava roda DUAS vezes**: na validação e DEPOIS do auditor — a reprovação
  chega tarde e precisa rebaixar o objeto que vai ao banco, à máquina e à tela.
- **Máquina de setup** consome a MESMA regra (níveis podem ser herdados de
  prints anteriores do mesmo setup; a prova do GATILHO tem de ser deste print).
  `SetupUpdate` agora carrega `entradaConfirmada` + `pendencias`.
- **Contrato**: `confidences` virou obrigatório no schema forçado (sem as quatro
  camadas o gate não tem o que medir); novo kind `CONFIRMATION_CANDLE`, marcado
  no candle exato — e REMOVIDO pela trava quando a entrada não passa (seta de
  entrada sobre setup não confirmado é a mentira mais cara da tela).
- **UI**: rótulo `VIÉS: COMPRA` em tom neutro antes da confirmação e `AÇÃO:
  COMPRA` em verde/vermelho depois; `AGUARDANDO CONFIRMAÇÃO`; card FALTA PARA
  CONFIRMAR; triângulo/seta só com `entradaLiberada()`; print CONGELADO na
  confirmação até nascer setup novo / invalidar / expirar (botão VER ÚLTIMO).
- Testes: 15 casos no contrato + 5 na máquina, incluindo o print do defeito.

### §13 — Auto-crop + zoom em dois passes (19/08)
`printCrop.ts`, reusando `detectRoi` do pipeline ao vivo (um vocabulário só).
- **Restrição que não se negocia**: o recorte apara a ESQUERDA e as bordas
  verticais e vai SEMPRE até a borda direita — é onde mora o eixo de preço, a
  régua de todo o sistema. Cortá-lo mataria a calibração.
- O ganho vem do RECORTE (o gráfico ocupa mais do orçamento de pixels do
  modelo), não da interpolação; a ampliação (≤2×, lado ≤2400px) só evita que o
  recorte chegue minúsculo ao provedor. Isso está dito no cabeçalho do módulo.
- Segundo passe é CONDICIONAL (`readingIsWeak`: INCONCLUSIVO, confiança < 60,
  imageIssues, preço atual ilegível ou nenhum nível lido) e só quando sobrou
  tempo no ciclo de 60s. `SEM_T4` limpo NÃO repete.
- Vencedor por evidência contável (`chooseBetterReading`): números legíveis e
  níveis pesam; confiança do modelo entra com peso baixo (autoavaliação não
  pode ser juiz). Empate mantém o 1º passe. O passe é sempre DITO na tela.
- A imagem guardada na sessão passa a ser a ANALISADA — exibir o print inteiro
  com marcações do recorte desalinharia tudo. 17 testes nas partes puras.

### Onda 3 (19/08) — auditor soberano e captura ancorada no candle
**1. O card não pode contradizer o auditor.** Fluxo único e sem inversão:
ANÁLISE → AUDITOR → VALIDAÇÃO → ESTADO FINAL → UI. O auditor ganhou um campo
ESTRUTURADO (`directionContradicted`), não texto para interpretar. Quando ele
diz que a estrutura contradiz o lado afirmado, a direção é **bloqueada na
origem**: `analysis.direction` vira NEUTRO no próprio objeto validado, o DNA é
rebaixado para DESCARTADA e o status derivado volta a AGUARDANDO. Bloquear só
na tela não bastaria — o mesmo objeto alimenta banco, memória e máquina de
setup, e o sistema aprenderia com uma direção que ele próprio reprovou. O lado
oposto NÃO é inventado: inverter seria criar um sinal que ninguém leu.
`deriveEntryDecision` passou a expor `auditorAprovou` (null = não rodou) e
`direcaoBloqueadaPeloAuditor`. Aprovação com contradição marcada resolve para
o lado seguro (vale a negação).

**2. CAUSA DO ATRASO, encontrada.** O ciclo somava 60s ao ALVO ANTERIOR
(`nextDueAt += CAPTURE_PERIOD_MS`). Parece equivalente a ancorar no relógio e
não é: qualquer ciclo atrasado (GPU lenta, aba em segundo plano) deslocava
TODOS os seguintes, e o print passava a cair no meio do candle. Pior, a tela só
trocava a imagem quando a ANÁLISE terminava — com a IA demorando mais que um
minuto, o operador via o print de dois candles atrás.
Correções na raiz:
- alvo recalculado do relógio a cada disparo: virada do minuto + `RENDER_DELAY_MS`
  (900ms para o Profit desenhar a barra). Ciclo atrasado não contamina o próximo.
- `candleTime` (piso do minuto) vira CHAVE: um print principal por candle;
  disparo repetido no mesmo minuto é contado em `duplicatesSkipped` e dito.
  `setSeries(ativo, timeframe)` reseta a referência ao trocar de série.
- `captureId`/`capturedAt`/`candleTime`/`captureDelayMs`/`sync` em toda captura.
- **`setOnCapture`**: a imagem entra na tela no INSTANTE da captura, antes da
  fila. A entrada da sessão nasce com `analise: null` e é preenchida depois.
- **latest-wins** (`resultadoGovernaTela`, puro e testado): resultado cujo
  `captureId` não é o exibido vai para histórico/DNA/memória mas NÃO troca
  linhas, ação nem congelamento — fica marcado "ANÁLISE TARDIA".
- cache: `key={captureId}` no `<img>` força nó novo a cada print.
- UI (§14): `PRINT #NNN · CANDLE hh:mm · CAPTURA hh:mm:ss (+Xs)` e selo
  SINCRONIZADO/ATRASADO/PROCESSANDO; a linha do tempo usa a hora do CANDLE.
Testes: 17 no monitor (10 candles consecutivos sem repetir nem perder minuto,
duplicata recusada, reset de série, imagem antes da análise) + 11 de
sincronismo. Relógio do teste fixado numa virada para não ficar intermitente.

### Onda 2 (19/08) — P3, P4, P5, health e shadow
- **§21 RESULTADO AUTOMÁTICO DOS SETUPS**: tabela `setups` + `setupOutcome.ts`
  puro (`evaluateSetup`). Ciclo `FORMACAO → CONFIRMADO → WIN|LOSS|EXPIRADO|
  INVALIDADO`. Amostras de 60s NÃO são candles: quando alvo e stop caem entre
  duas observações, resolve **LOSS** com `ambiguous: true` — nunca se fabrica
  sequência intrabar. Observação anterior ao `confirmedAt` não conta.
  `learned` é a trava de aprender UMA vez; a varredura só toca
  `outcome='ABERTO'` e a guarda está no próprio WHERE do UPDATE, então setup
  fechado não reabre nem reconta. Endpoints POST/GET /api/trading/setups,
  /setups/stats. O cliente persiste a cada passo e RESTAURA ao montar — é o
  item 11 do aceite (sobreviver ao restart).
- **Retenção com guarda de evidência**: imagem vinculada a setup ABERTO ou
  previsão PENDENTE não é apagada, e a contagem preservada é declarada.
- **§25/28-30 AUTO RESEARCH DE CANDIDATAS**: `candidates.ts` (espaço de
  parâmetros REAIS do motor, geração determinística com teto) + `paramSweep.ts`
  (treino/validação/OOS, walk-forward, Monte Carlo com seed, régua
  anti-overfitting `1.3 + 0.2·⌈log2(1+hipóteses)⌉`). O BASELINE entra na tabela
  e é imutável; a ordenação usa a janela de SELEÇÃO e o OOS é VETO, nunca
  critério de escolha. Toda variante sai `CANDIDATA` — nada promove sozinho.
  Endpoint POST /api/trading/research/sweep + botão TESTAR CANDIDATAS.
- **§18 SCORE T4** (`score.ts`): 0–100 por componente com contribuição e
  penalização ditas. Score alto com `entradaConfirmada=false` continua
  PROIBINDO operação — travado em teste e dito no próprio card.
- **§16 MULTI-TIMEFRAME** (`multiTimeframe.ts`): 1min é execução, superiores
  são filtro. `confidenceAdjustment` é sempre ≤ 0 — concordar NUNCA eleva
  confiança; sem dado confiável o resultado é SEM_DADOS, jamais um viés
  "provável". (Módulo pronto e testado; falta a fonte de leitura de timeframe
  superior no pipeline visual — ver PENDENTE.)
- **§34 HEALTH** (`systemHealth.ts` + /api/health/system + rota /saude):
  estados OK/DEGRADED/ERROR, o pior manda, e **subsistema não medido é
  DEGRADED, nunca OK** — um painel verde por falta de medição é pior que um
  vermelho. `podeEmitirSinal` bloqueia com captura/IA/banco em ERROR *ou
  ausentes*. A rota junta servidor (IA, banco, disco, memória, setups) com
  navegador (captura 60s, fila, última captura), porque o monitor é singleton
  do cliente e nenhum dos dois vê o sistema inteiro sozinho.
- **§33 SHADOW** (`shadowMode.ts`): registra o que cada versão TERIA feito, sem
  campo de execução no tipo. Amostra mínima 30 por versão; abaixo disso
  SEM_AMOSTRA. `podePromover` refaz a conta de amostra em vez de confiar no
  veredito, e apenas RESPONDE — promoção continua sendo decisão humana.

### Auditoria adversarial da trava (19/08) — 4 furos fechados
Varredura multi-lente + refutação sobre "algum caminho mostra COMPRA/VENDA
confirmada sem `entradaConfirmada=true`?". O que sobreviveu e foi corrigido:
1. **Seta desenhada sem liberação** (ALTA): a marcação `CONFIRMATION_CANDLE`
   sobrevivia quando o PRINT provava a confirmação mas a MÁQUINA não liberava
   (preço ainda não tocou a linha roxa). O gráfico gritava "✓ CONFIRMOU" com o
   card dizendo AGUARDANDO — e diante da contradição o operador obedece ao
   gráfico. Fechado nas QUATRO superfícies por um predicado único,
   `podeDesenharAnotacao` (traço SVG, rótulo HTML, PNG exportado e a lista de
   CAMADAS, que ainda exibia um botão aceso e morto).
2. **Crash em análise legada** (ALTA na prática): histórico do localStorage
   volta com `audit`/`confidences`/`targets` AUSENTES, não null. `undefined !==
   null` passava no guard e derrubava a tela. A trava agora normaliza ausência
   e NEGA a entrada — nunca explode.
3. **Badge verde sem trava** (MÉDIA): análise antiga reaberta mostrava
   "ENTRADA CONFIRMADA" em verde a partir do campo GRAVADO. Agora o badge segue
   a trava: quando o campo diz confirmada e a prova não sustenta, sai
   "CONFIRMAÇÃO NÃO PROVADA" em âmbar (na tela de análise e no histórico).
4. **Bloqueio mudo** (ALTA): com prova completa no print e preço longe da
   linha, `pendencias` vinha VAZIA e a caixa "FALTA PARA CONFIRMAR" sumia —
   bloqueio sem motivo dito. Agora o toque é a pendência declarada.

### Teste de aceite dos 13 itens (19/08)
`src/lib/print/__tests__/aceiteOperador.test.ts` amarra cada item ao código
real. Para isso a decisão de congelamento saiu do callback de React e virou
função pura `decidirCongelamento` em setupTracker — os itens 6 e 7 eram
inspeção visual enquanto fossem um `if` dentro do componente.
Itens 8, 9 e 11 (fechamento WIN/LOSS, aprendizado uma única vez, sobreviver ao
restart) são cobertos pelos testes do lado servidor; a prova definitiva deles é
uma sessão real, e isso está DITO no rodapé do arquivo em vez de simulado.

### Retenção de imagens (19/08)
`sweepPrintImages` no repositório: imagens de prints além de
`PRINT_IMAGE_RETENTION_DAYS` (padrão 7; ≤0 ou não numérico DESLIGA) são
apagadas do disco e `image_path` vira NULL — **a análise, as previsões e o DNA
ficam para sempre**; só o bitmap sai. Órfãos só caem com mtime anterior ao
corte. UPDATE em lote commitado ANTES do unlink (a ordem inversa deixaria linha
apontando para arquivo removido). Dispara em `savePrintRecord`, estrangulada a
1×/hora. 6 testes com arquivos reais em tmpdir.

### Pesquisa: ANALISAR CSV em um clique (19/08)
`csvOneClick.ts` encadeia import→run com IO injetado (testável sem DOM);
import com `saved=0` NÃO chama a pesquisa (rodar sobre zero candle produziria
um resultado vazio que parece resultado). `ImportResult`/`RunMetrics` moradas
no módulo, importadas pela rota — fonte única. Os dois botões antigos seguem.

### Memória T4 persistente (19/08 noite — aprendizado contínuo, fase 1)
- **Todo print analisado vira caso persistente**: tabela prints (análise
  validada + referências) com a IMAGEM em DATA_DIR/prints/{id}.jpg — nunca
  base64 em banco/código. capture_code distingue CICLO_60S/MANUAL/COLADO.
- **currentPrice no contrato**: a etiqueta de preço do eixo é lida a cada
  print e vira OBSERVAÇÃO — é ela que fecha vereditos de previsões antigas.
- **Vereditos automáticos** (print_predictions): previsão só nasce com
  critério PRÉ-definido (direção+stop+alvo legíveis). A varredura roda a cada
  print salvo: ACERTOU/ERROU/NEUTRO(45min TTL)/PENDENTE, com a regra
  conservadora da casa (alvo E stop entre duas amostras de 60s = stop
  primeiro, ambiguous=1). Anti-look-ahead literal: observação anterior à
  previsão não conta. predictionOutcome.ts, puro, testado.
- **Motor de memória** (caseMemory.ts, puro): similaridade por dimensões do
  DNA (pesos fixos e visíveis — calibrá-los por resultado seria overfitting
  da memória sobre si), corte 0.6; taxa histórica = limite INFERIOR de
  Wilson (3/3 ≈ 44%, nunca 100%); confiança final = visual × histórica com
  peso saturando em 0.5 aos 20 casos resolvidos; NEUTRO/INVALIDADO listam
  como contexto mas ficam FORA da taxa; erros nunca são apagados. As três
  leis estão em teste (17 casos).
- **Endpoints**: POST /api/trading/prints (grava + varre vereditos do ativo);
  GET /api/trading/memory?dnaId&asset&visual → casos compactos + taxas +
  confiança composta. Card MEMÓRIA T4 no painel do print.
- **Fluxo aguardado de propósito** na rota: DNA e print vão por fetch direto
  (a consulta de memória precisa deles gravados); falha → memoria null, a
  análise nunca quebra.

### ROTEIRO-MESTRE (spec consolidada de 39 pontos do operador, 19/08)
FEITO: captura 60s persistente fora do React (§1,3,37); print congelado até
confirmar (§2); leitura T4 com regras no prompt (§4 parcial — ordem/vocab ok);
níveis pela régua + zonas/bandas + entrada sinalizada (§6 parcial, §8 cores);
R:R quando legível (§9 parcial); confiança visual vs histórica separadas
(§12 parcial); memória temporal da sessão + O QUE MUDOU (§14); cenários (§15);
DNA/regime segmentado (§17 parcial); anti-duplicação por análise única (§19
parcial); resultado automático de previsões (§21 fase 1); aprendizado
persistente (§22 fase 1 — SQLite+disco, não os arquivos /knowledge literais:
a fonte oficial é o SQLite, decisão de arquitetura documentada); casos
semelhantes com Wilson (§23); treino/val/OOS + hipóteses contadas (§24
parcial, §27); sem look-ahead no replay contínuo (§26); versionamento de
técnica + rollback via git/techniques (§32 parcial); histórico/controles
(§36,37); sidebar enxuta (§38).
FEITO depois (19/08): máquina de setup persistente com setupId entre prints
(§5) + linha roxa ENTRAR SE TOCAR AQUI com pré-alerta (§6,7); AUDITOR IA
revisor independente (§11); confiança por camada (§12, agora obrigatória no
contrato); auto-crop+zoom em dois passes (§13); expiração de setup na UI (§20);
T4 Auto Research completo (§25,28,29,30) + ANALISAR CSV em um clique; e a
separação VIÉS × ENTRADA CONFIRMADA com trava determinística (§2,7,8 por
extenso), que é a regra que hoje governa toda sinalização de ordem na tela.
PENDENTE (real, o que sobrou depois da onda 2):
- **PENDENTE_DADOS_REAIS** — nenhum número de performance foi produzido: todo
  backtest até aqui rodou sobre série SINTÉTICA, que gera 0 trades. Só um CSV
  real do WIN 1min (10+ pregões, para a divisão treino/validação/OOS existir)
  transforma o sweep de candidatas em evidência. Enquanto isso, o ranking sai
  honesto e vazio — que é o comportamento certo, não uma falha.
- **§16 multi-timeframe**: motor pronto e testado, mas SEM FONTE — o print
  carrega um timeframe só. Falta decidir de onde vem a leitura do timeframe
  superior (segundo print? segunda janela do Profit?) antes de ligar o card.
- **§33 shadow AO VIVO**: motor de comparação pronto; falta o laço que roda a
  candidata em paralelo à produção durante a sessão e grava as decisões.
- **§24** comparador vencedores×perdedores gerando candidatas automaticamente.
- **§31** replay visual auditável dedicado (o backtest contínuo cobre parte).
- **§34** os subsistemas ERROS/PESQUISA aparecem como não medidos no /saude —
  precisam de coletor próprio para virarem medição de verdade.

### Direção declarada pelo operador (18/08 noite): T4 AUTO RESEARCH
Arquitetura-alvo, nas palavras dele:
`HISTÓRICO → BACKTEST T4 → WALK-FORWARD → OOS → MONTE CARLO → ROBUSTEZ →
REPLAY VISUAL → APROVAR/REPROVAR → RANKING → NOVA VERSÃO`
— dois motores complementares: **QUANT** (CSV exportado do Profit/Nelogica →
candles → T4 candle a candle → custos/slippage → estatística) e **VISUAL**
(Replay do Profit pela captura contínua, para validar a leitura — NUNCA para
medir resultado financeiro: a própria Nelogica documenta que o Replay usa
preço negociado e não reproduz fila/liquidez). Regras: anti-look-ahead
absoluto; walk-forward automático; OOS obrigatório (período final nunca entra
na otimização); Monte Carlo de sequência de trades para drawdown provável;
segmentação por regime/horário/dia; multi-timeframe e multiativo; ranking
ponderando PF/DD/expectância/estabilidade/amostra — nunca só lucro; evolução
por candidatas versionadas (T4.0→T4.1…) e NUNCA promoção automática.
Já existe no repo: gates T4 no caminho de backtest, custos (costs.ts),
datasetSplit treino/val/OOS, lab_experiments com exigência crescente,
candidatas versionadas com promoção guardada, DNA segmentado, captura
contínua p/ o motor visual. Falta construir: importador CSV, motor quant
sobre candles importados, runner de walk-forward por fold, Monte Carlo,
ranking automático. É o próximo grande bloco de trabalho.

### Da Captura Inteligente — aceite que SÓ o operador fecha (18/08)
O que já foi verificado de verdade: 614 testes (12 do detector cobrem gráfico
parado ≠ print, cursor não dispara, movimento pequeno não se perde, sem
duplicata, falha de captura re-dispara), typecheck, build, e navegação real no
preview local (painel renderiza, MONITORANDO↔ENCERRADO, heartbeat marcou
STREAM: CONGELADO com captura bloqueada, sidebar com 5 itens, console limpo).
O que EXIGE o Profit real na tela do operador — não declarar pronto sem isto:
1. selecionar a janela 1x e ver a primeira captura+análise imediatas;
2. gráfico parado → nenhum print novo; candle novo/movimento → print sozinho;
3. mexer cursor/menu sobre o gráfico → NÃO dispara;
4. ANALISAR AGORA / PAUSAR / CONTINUAR / ENCERRAR e fechar o compartilhamento
   pelo Profit (onended → "SELECIONAR JANELA NOVAMENTE");
5. conferir MOTIVO/LATÊNCIA na faixa e no histórico das capturas.

### Do DNA T4 (lacunas CONHECIDAS e declaradas — não são bugs escondidos)
1. **AO VIVO não registra DNA**: só REPLAY (`useContinuousBacktest`) e PRINT
   gravam. `useProfitVision` precisa do mesmo congelamento no armamento.
2. **Só setups CONFIRMADOS entram**: T4 rejeitada pelos gates não vira
   registro, então `grade=DESCARTADA` vindo do motor é estruturalmente vazia
   (só prints produzem). A razão "quantas apareceram vs executaram" mede hoje
   ARMADAS vs executadas — a tabela `setup_dna` foi desenhada para o caso
   completo, o produtor é que ainda não o cobre.
3. **Custo/R$/slippage sem produtor**: as colunas existem (migration 004) mas
   nada as preenche; `costR` é sempre null e `netAfterCostsR` sai null com o
   motivo. Ligar `src/lib/t4/costs.ts` ao fechamento do trade resolve.
4. **Split treino/validação/OOS não é aplicado**: `datasetSplit.ts` está
   implementado e testado, e os endpoints `/datasets` e `/experiments`
   existem, mas nada os consome — a evidência OOS que a promoção valida ainda
   é AUTODECLARADA pelo cliente no corpo da requisição. Walk-forward por fold
   segue não implementado.
5. **Re-replay do mesmo trecho duplica detecções**: o id do DNA embute a
   sessão, então reprocessar o mesmo pregão insere registros novos; e os ids
   de trade são determinísticos, então o segundo lote colide na PK e sofre
   rollback (detecções ficam órfãs). Falta chave de dedup por identidade de
   mercado — que depende do item 4 do bloco anterior (data confiável).
6. **`Infinity` vira null no JSON**: PF sem nenhuma perda chega ao painel
   indistinguível de "sem dado" (a UI mostra "—" nos dois casos).

### De desenvolvimento (ordenadas por valor)
1. **E2E do Analisar Print com GPU real** — critérios 7–18 do pedido original
   só fecham com modelo vivo; avaliar se o 7B devolve coordenadas úteis.
2. **OCR do eixo de tempo** não ligado no pipeline visual → PREGÃO/HORÁRIO
   "NÃO CONFIÁVEL" (honesto, mas o Golden de Replay 13/03 não mede lead time
   sem isso).
3. **UI de validação de ativo** (fluxo de aprovação → `setAssetValidation`,
   hoje só em memória) e migração do `Settings` global do storage para config
   por ativo.
4. **Achados restantes da auditoria** (60 mapeados, ~25 corrigidos; journal:
   `~/.claude/.../workflows/wf_80ef1a4d-a03/journal.jsonl`): POI/reteste com
   rótulos conflitantes entre cards; `stop()` do recorder descarta último
   chunk; grade de tempo ancorada em relógio local diverge entre caminhos;
   `dayKey()` usa fuso da máquina; contador "Sessões ao vivo" órfão;
   SETUP TÉCNICO COMPLETO convive com AMOSTRA INSUFICIENTE sem se explicarem.
5. **Golden**: Replay 13/03/2026 WINFUT 1min medindo candidateTime/preEntryTime/
   confirmationTime — depende do item 2.

### Bugs conhecidos (menores, não corrigidos)
- 4 warnings react-hooks/exhaustive-deps pré-existentes.
- `/api/ai/health` 503 com GPU fora loga erro no console do navegador (ruído
  esperado; mudar o contrato por cosmética foi rejeitado).
- Erros antigos listados em /erros (React #520 de 11/08, CHART_CLOCK ×42) são
  de ANTES do pipeline atual; não se repetem.

---

## 6. COMO RETOMAR NUMA SESSÃO NOVA

```bash
cd /c/Users/user/Desktop/projetos/ANALISADOR_T4_RTD
export PATH="/usr/bin:/bin:/mingw64/bin:$PWD/tools/node/node-v22.20.0-win-x64:$PATH"
git fetch origin && git fetch vps && git status   # fetch nos DOIS (§3); conferir se produção divergiu (§4.1!)
npx tsc --noEmit && npx vitest run                # base sã = 521 testes
```

Equivalente em PowerShell (shell padrão das sessões atuais):

```powershell
cd C:\Users\user\Desktop\projetos\ANALISADOR_T4_RTD
$env:PATH = "$PWD\tools\node\node-v22.20.0-win-x64;$env:PATH"
git fetch origin; git fetch vps; git status
npx tsc --noEmit; npx vitest run
```

Deploy: commit → `git push vps main` → validar:
`ssh -i ~/.ssh/t4_vps root@179.197.238.143 'cat /var/www/analisador/.deployed-commit; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8081/api/health'`
(depois do push, rodar também `git fetch origin` — ver §3).

Este arquivo (`CLAUDE_CONTEXT.md`) passou a ser **versionado** no commit
`340645c` — sobrevive a um novo clone, que é o ponto (§4.3). Mantenha-o
atualizado no MESMO commit da mudança que ele descreve.

### Regras invioláveis (do operador, reafirmadas várias vezes)
- NÃO alterar gates/estratégia T4; NÃO fabricar sinais nem preços.
- Escala/OCR NUNCA bloqueia leitura estrutural; sem escala → guarda de preço
  ligada ("PREÇOS EM CALIBRAÇÃO"), nunca número de pixel.
- Captura viva + gráfico parado = estado VÁLIDO (não resetar nada).
- Nada verde sem prova; todo estado de falha carrega motivo específico.
- Verificar de verdade antes de declarar pronto: typecheck + testes + build +
  percorrer o site; sem mock em produção; relatar o que ficou de fora.
- RTD/bridge fora do runtime (decisão do operador; visual é a fonte).
- Sidebar sem Dashboard/Backtest (rotas continuam vivas por URL).
