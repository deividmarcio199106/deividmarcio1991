# Auditoria: Estado Atual vs 14 Requisitos de Refinamento T4

**Data:** 2026-08-18  
**Auditor:** Project Engineer Agent  
**Projeto:** ANALISADOR_T4_RTD  
**HEAD:** a8230b1 (produção)

---

## Resumo Executivo

O projeto possui **infraestrutura sólida** para a maioria dos requisitos, mas **nenhum deles está 100% completo**. A base técnica (motor T4, banco SQLite, pipeline de visão) está madura, porém o sistema de **mensuração estatística granular** (DNA completo, segmentação multidimensional, proteção contra overfitting, otimização de saída) precisa ser construído sobre essa base.

**Estado geral:** 40% implementado, 40% parcial, 20% ausente.

---

## Análise Detalhada por Requisito

### 1. DNA T4 (Registro Completo por Operação)

**Status:** ⚠️ **PARCIAL (35%)**

**O QUE EXISTE:**
- Interface `BacktestTrade` (`src/lib/engines/backtestEngine.ts:4-58`) com 30+ campos
- Campos presentes: ID, data/hora, ativo, timeframe, direção, setup, context, entrada/stop/alvos, RR, resultado, MFE/MAE (pontos e R), exitReason, regime, wyckoffPhase, poiKind, hour
- Tabela `trades` no SQLite (migration 001) + campos de auditoria (migration 002: entry, stop, partial, target, timestamps, mfe, mae)
- Classificação A+/A/B/C em `T4Quality` (`t4Engine.ts:16`)
- Persistência completa via `tradingRepository.ts`

**O QUE FALTA:**
- ❌ **Nota A+/A/B/C/DESCARTADA** como campo consultável (hoje só em `frozenAnalysis.t4.quality`, não em coluna SQL)
- ❌ **Tendência** (FORTE/NORMAL/LATERAL/TRANSIÇÃO/CONTRA) como enum estruturado
- ❌ **Posição** (A_FAVOR/CONTRA_TENDÊNCIA) explícita
- ❌ **Tipo de pullback** (CURTO/PROFUNDO/LIMPO/LATERAL/AGRESSIVO/FALSO_ROMPIMENTO)
- ❌ **Força do impulso anterior** como métrica numérica
- ❌ **Localização** (suporte/resistência/VWAP/média/máxima/mínima/rompimento/consolidação) como enum
- ❌ **Candle gatilho** (fechamento/rompimento/rejeição/engolfo/força/reteste) categorizado
- ❌ **Número da T4 no movimento** (1ª, 2ª, 3ª ou posterior)
- ❌ **Volatilidade** (BAIXA/NORMAL/ALTA/EXTREMA) como campo consultável
- ❌ **Distância do stop** em R (derivável, mas não armazenada)
- ❌ **Resultado em R$** (só R múltiplo hoje)
- ❌ **Custos/slippage** já calculados por `costs.ts` mas não persistidos por trade
- ❌ **Print original** (URL/base64) vinculado ao trade
- ❌ **Análise/overlay** como texto estruturado
- ❌ **Classificação ANTES do resultado** (hoje qualidade é calculada no instante da decisão, mas não há garantia temporal explícita)

**Arquivos relevantes:**
- `src/lib/engines/backtestEngine.ts` (interface BacktestTrade)
- `migrations/001_initial.sql` + `002_trade_audit_fields.sql`
- `src/lib/t4/costs.ts` (cálculo de custos, não integrado ao trade)
- `src/lib/engines/t4Engine.ts` (T4Quality)

---

### 2. MFE/MAE (Maximum Favorable/Adverse Excursion)

**Status:** ✅ **EXISTE (90%)**

**O QUE EXISTE:**
- ✅ Calculado em **pontos** (`mfePoints`, `maePoints`) e em **R** (`mfeR`, `maeR`)
- ✅ Armazenado no banco (`trades.mfe`, `trades.mae` via migration 002)
- ✅ `computePointStats()` em `performanceEngine.ts` calcula médias de MFE/MAE
- ✅ Usado em `dailyLearning.ts` para detectar "badTarget" (ganho com movimento além do colhido)

**O QUE FALTA:**
- ⚠️ **Uso sistemático** para validar se 3R/5R é realmente o melhor (hoje é hard-coded em `strategy.ts`)
- ⚠️ **Análise de saída ótima** baseada em MFE/MAE (ver requisito 10)

**Arquivos relevantes:**
- `src/lib/engines/backtestEngine.ts:30-33` (campos mfe/mae)
- `src/lib/engines/performanceEngine.ts:125-159` (computePointStats)
- `migrations/002_trade_audit_fields.sql`

---

### 3. Performance Segmentada (Múltiplas Dimensões)

**Status:** ⚠️ **PARCIAL (30%)**

**O QUE EXISTE:**
- ✅ `groupBy()` genérico em `performanceEngine.ts:70-88` (agrupa por qualquer chave)
- ✅ `computeStats()` calcula: total, wins, losses, winRate, payoff, profitFactor, expectancy, maxDrawdown
- ✅ `dailyLearning.ts` usa rolling window de 60 trades
- ✅ Métricas disponíveis: amostra, win rate, expectancy, profit factor, drawdown

**O QUE FALTA:**
- ❌ **Segmentação automática** por: nota (A+/A/B/C), compra×venda, favor×contra tendência, tipo de tendência, tipo de pullback, candle gatilho, 1ª/2ª/3ª T4, volatilidade, ativo, timeframe, faixa horária, localização/contexto
- ❌ **Painel consolidado** com todas as dimensões
- ❌ **MFE/MAE médio/mediano por segmento**
- ❌ **Resultado líquido por segmento**
- ❌ **Validação de amostra mínima** (hoje não bloqueia conclusão com N<30)
- ❌ **Endpoints API** para consulta segmentada
- ❌ **Componentes UI** para visualizar segmentos

**Arquivos relevantes:**
- `src/lib/engines/performanceEngine.ts` (groupBy, computeStats)
- `src/lib/engines/dailyLearning.ts` (uso de stats)

---

### 4. Painel "DNA T4" (Consolidado por Operação)

**Status:** ❌ **NÃO EXISTE (0%)**

**O QUE EXISTE:**
- ✅ Dados estão em `trades.payload_json` (JSON completo do BacktestTrade)
- ✅ `frozenAnalysis` contém snapshot da decisão

**O QUE FALTA:**
- ❌ **Painel unificado** mostrando: T4 #ID, direção, nota, tendência, posição, pullback, gatilho, volatilidade, RR, resultado, MFE, MAE
- ❌ **Visualização temporal** (linha do tempo da operação)
- ❌ **Comparação** com operações semelhantes
- ❌ **Exportação** de DNA completo

**Arquivos relevantes:**
- Nenhum componente dedicado existe hoje

---

### 5. "Por que Perdeu?" (Análise de Fatores de Loss)

**Status:** ⚠️ **PARCIAL (40%)**

**O QUE EXISTE:**
- ✅ `postTradeReview.ts` com `reviewTrade()` que retorna tags: `wrongDirection`, `badStop`, `badTarget`, `falsePositive`
- ✅ `detectDegradedSetups()` identifica setups degradados
- ✅ `setupErrorMatrix()` agrupa erros por setup
- ✅ `dailyLearning.ts` gera lições baseadas em padrões de loss

**O QUE FALTA:**
- ❌ **Lista completa de fatores**: contra tendência, pullback profundo, entrada próxima a barreira, T4 tardia, volatilidade anormal, confirmação fraca, RR ruim
- ❌ **Comparação com vencedoras semelhantes** (matching por contexto)
- ❌ **Análise estatística** (não só tags binárias)
- ❌ **UI de análise** pós-loss
- ❌ **Integração com DNA** para correlacionar fatores

**Arquivos relevantes:**
- `src/lib/engines/postTradeReview.ts` (reviewTrade, detectDegradedSetups, setupErrorMatrix)
- `src/lib/engines/dailyLearning.ts:64-110` (geração de lições)

---

### 6. Laboratório T4 (Controle de Versão)

**Status:** ✅ **EXISTE (85%)**

**O QUE EXISTE:**
- ✅ Tabela `techniques` (produção) e `technique_candidates` (laboratório)
- ✅ Fluxo de status: DISCOVERED → BACKTESTING → VALIDATION → OOS → WALK_FORWARD → VALIDATED → PRODUCTION
- ✅ `promoteTechniqueCandidate()` com validação (só VALIDATED pode ser promovido)
- ✅ `dailyLearning.ts` cria candidatas automaticamente com `hypothesis`, `baseVersion`, `rules`
- ✅ `techniques` armazena `rules_json` (snapshot da técnica)
- ✅ Proteção: candidata não altera sessão em andamento (`productionMutationDuringSession: false`)
- ✅ Promoção só na próxima sessão (`applyValidatedChangeOnlyNextSession: true`)

**O QUE FALTA:**
- ⚠️ **Registro explícito** de: regra adicionada/removida, motivo detalhado, dataset usado
- ⚠️ **Comparação visual** entre produção e candidatas
- ⚠️ **Histórico de experimentos** (quantas variações testadas)

**Arquivos relevantes:**
- `migrations/001_initial.sql` (techniques, technique_candidates, validation_results)
- `src/server/tradingRepository.ts` (upsertTechniqueCandidate, promoteTechniqueCandidate)
- `src/lib/engines/dailyLearning.ts` (criação de candidatas)

---

### 7. Validação OOS (Treino/Validação/Fora da Amostra)

**Status:** ⚠️ **PARCIAL (50%)**

**O QUE EXISTE:**
- ✅ Pipeline declarado em `strategy.ts:98-106`: DAILY_REVIEW → SHADOW → BACKTEST → OOS → WALK_FORWARD → VALIDATED → EXPLICIT_PROMOTION
- ✅ `validation_results` tabela para armazenar métricas de validação
- ✅ `dailyLearning.ts` exige `requiredPath: ["BACKTESTING", "VALIDATION", "OOS", "WALK_FORWARD", "VALIDATED"]`

**O QUE FALTA:**
- ❌ **Separação física** de datasets (treino/validação/OOS) no banco
- ❌ **Split temporal** automático (ex: 70% treino, 15% validação, 15% OOS)
- ❌ **Validação walk-forward** implementada (declaração sem código)
- ❌ **Métricas OOS** comparadas com treino (expectancy, PF, drawdown, estabilidade)
- ❌ **Bloqueio** de promoção sem OOS aprovado

**Arquivos relevantes:**
- `src/lib/engines/strategy.ts:98-106` (pipeline declarado)
- `migrations/001_initial.sql` (validation_results)

---

### 8. Proteção Contra Overfitting

**Status:** ❌ **NÃO EXISTE (10%)**

**O QUE EXISTE:**
- ✅ `requireAdmin` protege endpoints de promoção (`technique-promote`, `technique-candidates`)
- ✅ Candidata precisa ser VALIDATED (mas não há critério de amostra mínima explícito)

**O QUE FALTA:**
- ❌ **Registro de quantas hipóteses/variações/filtros foram testados**
- ❌ **Exigência de validação maior** quanto mais hipóteses testadas (correção de Bonferroni)
- ❌ **Bloqueio** de alteração automática de: horário, candle, stop, alvo, break-even, filtro, tendência, volatilidade por poucos losses
- ❌ **Painel de descoberta automática** (ver requisito 9)
- ❌ **Alerta** quando muitas variações são testadas sem validação OOS

**Arquivos relevantes:**
- `src/server/adminGuard.ts` (proteção de endpoints, mas não de overfitting)

---

### 9. Descoberta Automática (Padrões Encontrados)

**Status:** ⚠️ **PARCIAL (25%)**

**O QUE EXISTE:**
- ✅ `dailyLearning.ts` detecta padrões degradados (`detectDegradedSetups`)
- ✅ Gera lições textuais (ex: "Manter SETUP_X em shadow: média -0.5R em 15 operações")
- ✅ `setupErrorMatrix()` agrupa erros por setup

**O QUE FALTA:**
- ❌ **Painel "PADRÕES ENCONTRADOS"** com estatísticas:
  - Ex: "T4 A+ / SELL / 1ª correção / tendência forte: N=327, Win=71%, Expectancy=+0.84R, PF=2.26"
  - Ex: "T4 B / lateral / 3ª T4: N=184, Expectancy=-0.11R"
- ❌ **Descoberta automática** de combinações vencedoras/perdedoras
- ❌ **Sugestão para laboratório** (não bloqueia, só sugere)
- ❌ **Ranking** de setups por expectativa

**Arquivos relevantes:**
- `src/lib/engines/dailyLearning.ts` (detecção de padrões, mas sem painel)
- `src/lib/engines/postTradeReview.ts` (setupErrorMatrix)

---

### 10. Otimização de Saída (Comparação de Alvos)

**Status:** ❌ **NÃO EXISTE (5%)**

**O QUE EXISTE:**
- ✅ MFE/MAE armazenados (ver requisito 2)
- ✅ `realizedPoints()` calcula pontos realizados

**O QUE FALTA:**
- ❌ **Simulação de saídas alternativas** usando MESMAS entradas:
  - 1R, 1.5R, 2R, 2.5R, 3R, 4R, 5R
  - Parcial (60/40, 50/50, etc.)
  - Runner com trailing estrutural
  - Break-even após X R
- ❌ **Comparação justa** (mesmas entradas, diferentes saídas)
- ❌ **Análise de MFE/MAE** para descobrir saída ótima
- ❌ **Validação** de que saída atual (3R/5R/runner) é realmente a melhor
- ❌ **UI** para testar diferentes estratégias de saída

**Arquivos relevantes:**
- `src/lib/engines/strategy.ts` (gestão atual hard-coded)
- `src/lib/engines/performanceEngine.ts` (base para simulação, mas não implementada)

---

### 11. Integração Print → DNA (Fluxo Completo)

**Status:** ⚠️ **PARCIAL (40%)**

**O QUE EXISTE:**
- ✅ Pipeline de visão: `getDisplayMedia` → `useProfitVision` → `ChartTracker` → `analyze()` → `decide()`
- ✅ `printAnalysis.ts` com contrato anti-alucinação
- ✅ `chartVision.ts` (schema forçado no Ollama)
- ✅ `nextScreenshot` (4 estados, 15 gatilhos)
- ✅ `printComparison.ts` (comparação determinística)
- ✅ UI: `analisar-print.tsx` com drag-drop, upload, timeline, abas T4|AÇÃO
- ✅ Histórico: `printHistory.ts` (localStorage, máx 8 prints)

**O QUE FALTA:**
- ❌ **Persistência automática** de TODOS os campos do DNA no banco
- ❌ **Vinculação** print → operação (hoje prints ficam em localStorage, trades no SQLite)
- ❌ **Overlay** com dados mensuráveis (só visual)
- ❌ **Feedback** integrado ao DNA (👍/👎 não vira métrica)
- ❌ **Fluxo completo testado** sem mocks

**Arquivos relevantes:**
- `src/lib/vision/printAnalysis.ts`
- `src/services/ai/chartVision.ts`
- `src/routes/analisar-print.tsx`
- `src/lib/print/printHistory.ts`

---

### 12. Banco (Migrations Reais)

**Status:** ⚠️ **PARCIAL (60%)**

**O QUE EXISTE:**
- ✅ 3 migrations aplicadas (001, 002, 003)
- ✅ Tabelas: `trades`, `techniques`, `technique_candidates`, `validation_results`, `backtest_runs`, `trading_sessions`, `segments`, `market_events`
- ✅ Índices para performance
- ✅ `tradingRepository.ts` com funções CRUD completas
- ✅ `schema_migrations` para controle de versão

**O QUE FALTA:**
- ❌ **Tabela dedicada para DNA** (hoje tudo em `trades.payload_json`)
- ❌ **Tabela de MFE/MAE** separada (hoje colunas em `trades`)
- ❌ **Tabela de resultados** (hoje campos em `trades`)
- ❌ **Tabela de experimentos** (quantas hipóteses testadas)
- ❌ **Tabela de datasets** (treino/validação/OOS)
- ❌ **Tabela de métricas** por segmento
- ❌ **Tabela de hipóteses** (além de `technique_candidates.hypothesis`)
- ❌ **Tabela de validações OOS** (além de `validation_results`)
- ❌ **Campos consultáveis** para nota, tendência, pullback, gatilho, volatilidade (hoje só em JSON)

**Arquivos relevantes:**
- `migrations/001_initial.sql`, `002_trade_audit_fields.sql`, `003_daily_learning.sql`
- `src/server/tradingRepository.ts`

---

### 13. Regra Crítica (IA Observa, Dados Validam)

**Status:** ⚠️ **PARCIAL (55%)**

**O QUE EXISTE:**
- ✅ IA não altera técnica de produção sozinha (`productionMutationDuringSession: false`)
- ✅ Candidata precisa ser VALIDATED antes de promoção
- ✅ `requireAdmin` protege endpoints críticos
- ✅ Aprendizado diário gera hipótese, não aplica
- ✅ `frozenAnalysis` preserva snapshot da decisão (anti-look-ahead)

**O QUE FALTA:**
- ❌ **Validação de amostra mínima** (não impede promoção com N<30)
- ❌ **Bloqueio** de IA declarar técnica vencedora por poucos casos
- ❌ **Proteção** contra inventar estatísticas (hoje depende de quem implementa)
- ❌ **Proteção** contra escolher filtro pelo resultado passado (data snooping)
- ❌ **Proteção** contra eliminar setup sem amostra suficiente
- ❌ **Auditoria** de quem/quando alterou regras

**Arquivos relevantes:**
- `src/server/adminGuard.ts`
- `src/lib/engines/strategy.ts:93-107` (dailyLearning config)
- `src/lib/engines/dailyLearning.ts`

---

### 14. Testes/Aceite (E2E sem Mocks)

**Status:** ⚠️ **PARCIAL (70%)**

**O QUE EXISTE:**
- ✅ 521 testes passando (re-executados 18/08)
- ✅ Testes de: `replayIgualLive`, `signalSnapshot`, `simulation`, `priceGuard`, `dataGates`, `leadTime`, `preEntry`, `progress`, `visionProgress`, `assetsCosts`
- ✅ `noLegacyPipeline.test.ts` garante que RTD/bridge não voltam
- ✅ Typecheck/build passando
- ✅ Lint: 0 erros, 4 warnings pré-existentes

**O QUE FALTA:**
- ❌ **E2E completo** PRINT → GPT → T4 → DNA → GERENCIAMENTO → OVERLAY (depende de GPU real, túnel fora)
- ❌ **Teste de DNA completo** (todos os campos persistidos)
- ❌ **Teste de performance segmentada**
- ❌ **Teste de proteção contra overfitting**
- ❌ **Teste de validação OOS**
- ❌ **Teste de otimização de saída**
- ⚠️ GPU fora (`/api/ai/health` 503) impede teste de visão real

**Arquivos relevantes:**
- `src/lib/**/__tests__/*.test.ts` (521 testes)
- `CLAUDE_CONTEXT.md` (estado atual documentado)

---

## Prioridades de Implementação (Ordenadas por Valor)

### **FASE 1: DNA T4 Completo** (Requisito 1)
**Valor:** Alto — base para todos os outros requisitos  
**Esforço:** Médio  
**Arquivos a modificar:**
- `migrations/004_dna_completo.sql` (nova migration)
- `src/lib/engines/backtestEngine.ts` (expandir BacktestTrade)
- `src/lib/engines/dnaExtractor.ts` (novo arquivo)
- `src/server/tradingRepository.ts` (novas funções)

**Campos a adicionar:**
```sql
ALTER TABLE trades ADD COLUMN quality TEXT; -- A+/A/B/C/DESCARTADA
ALTER TABLE trades ADD COLUMN trend_strength TEXT; -- FORTE/NORMAL/LATERAL/TRANSIÇÃO/CONTRA
ALTER TABLE trades ADD COLUMN position_vs_trend TEXT; -- A_FAVOR/CONTRA_TENDÊNCIA
ALTER TABLE trades ADD COLUMN pullback_type TEXT; -- CURTO/PROFUNDO/LIMPO/LATERAL/AGRESSIVO/FALSO_ROMPIMENTO
ALTER TABLE trades ADD COLUMN impulse_strength REAL;
ALTER TABLE trades ADD COLUMN location TEXT; -- suporte/resistência/VWAP/média/máxima/mínima/rompimento/consolidação
ALTER TABLE trades ADD COLUMN trigger_candle TEXT; -- fechamento/rompimento/rejeição/engolfo/força/reteste
ALTER TABLE trades ADD COLUMN t4_number_in_move INTEGER; -- 1, 2, 3, ...
ALTER TABLE trades ADD COLUMN volatility_level TEXT; -- BAIXA/NORMAL/ALTA/EXTREMA
ALTER TABLE trades ADD COLUMN stop_distance_r REAL;
ALTER TABLE trades ADD COLUMN result_brl REAL;
ALTER TABLE trades ADD COLUMN costs_brl REAL;
ALTER TABLE trades ADD COLUMN print_url TEXT;
ALTER TABLE trades ADD COLUMN analysis_text TEXT;
```

**Critério de aceitação:**
- [ ] Todo trade persistido tem DNA completo
- [ ] Classificação (nota) ocorre ANTES do resultado
- [ ] Testes unitários validam extração de DNA
- [ ] Endpoint API retorna DNA completo

---

### **FASE 2: Performance Segmentada** (Requisito 3)
**Valor:** Alto — descobre quais contextos têm vantagem  
**Esforço:** Alto  
**Arquivos a criar/modificar:**
- `src/lib/engines/segmentedPerformance.ts` (novo)
- `src/server/performanceEndpoints.ts` (novo)
- `src/routes/performance-segmentada.tsx` (novo)
- `src/components/performance/SegmentTable.tsx` (novo)

**Funções a implementar:**
```typescript
// src/lib/engines/segmentedPerformance.ts
export interface SegmentStats {
  segment: string;
  dimension: string; // 'quality' | 'direction' | 'trend' | 'pullback' | ...
  sample: number;
  winRate: number;
  lossRate: number;
  expectancyR: number;
  payoff: number;
  profitFactor: number;
  maxDrawdown: number;
  mfeMedian: number | null;
  maeMedian: number | null;
  netResult: number;
  confidence: 'ALTA' | 'MÉDIA' | 'BAIXA'; // baseado em N
}

export function computeSegmentedPerformance(
  trades: BacktestTrade[]
): Map<string, SegmentStats[]>;
```

**Critério de aceitação:**
- [ ] 12 dimensões segmentadas automaticamente
- [ ] Amostra mínima (N≥30) para considerar estatística válida
- [ ] UI mostra tabela por dimensão
- [ ] MFE/MAE mediano por segmento
- [ ] Testes validam cálculos

---

### **FASE 3: Laboratório + Validação OOS** (Requisitos 6, 7)
**Valor:** Alto — previne overfitting  
**Esforço:** Médio  
**Arquivos a modificar:**
- `migrations/005_datasets.sql` (nova migration)
- `src/lib/engines/datasetSplitter.ts` (novo)
- `src/lib/engines/walkForwardValidator.ts` (novo)
- `src/lib/engines/dailyLearning.ts` (integrar OOS)

**Nova migration:**
```sql
CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('TREINO','VALIDAÇÃO','OOS')),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  trade_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oos_validations (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  passed INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(candidate_id) REFERENCES technique_candidates(id),
  FOREIGN KEY(dataset_id) REFERENCES datasets(id)
);
```

**Critério de aceitação:**
- [ ] Split automático 70/15/15 (treino/validação/OOS)
- [ ] Walk-forward implementado (rolling window)
- [ ] Candidata só é VALIDATED se passar em OOS
- [ ] Métricas OOS comparadas com treino
- [ ] UI mostra comparação

---

### **FASE 4: Proteção Contra Overfitting + Descoberta Automática** (Requisitos 8, 9)
**Valor:** Alto — integridade estatística  
**Esforço:** Médio  
**Arquivos a criar:**
- `src/lib/engines/overfittingGuard.ts` (novo)
- `src/lib/engines/patternDiscovery.ts` (novo)
- `src/routes/descoberta-automatica.tsx` (novo)
- `src/components/lab/PatternPanel.tsx` (novo)

**Funções:**
```typescript
// src/lib/engines/overfittingGuard.ts
export interface HypothesisTracker {
  candidateId: string;
  hypothesesTested: number;
  filtersTested: string[];
  requiredOOSPassRate: number; // aumenta com mais hipóteses
}

export function trackHypotheses(candidateId: string): HypothesisTracker;
export function validateWithBonferroni(tracker: HypothesisTracker, pValue: number): boolean;

// src/lib/engines/patternDiscovery.ts
export interface DiscoveredPattern {
  pattern: string; // "T4 A+ / SELL / 1ª correção / tendência forte"
  sample: number;
  winRate: number;
  expectancy: number;
  profitFactor: number;
  confidence: number;
  suggestion: 'PROMOVER' | 'MANTER_SHADOW' | 'DEGRADAR';
}

export function discoverPatterns(trades: BacktestTrade[]): DiscoveredPattern[];
```

**Critério de aceitação:**
- [ ] Contagem de hipóteses testadas
- [ ] Exigência de validação aumenta com mais testes (Bonferroni)
- [ ] Painel "PADRÕES ENCONTRADOS" com top 10 vencedores/perdedores
- [ ] Sugestão para laboratório (não aplica automaticamente)
- [ ] Bloqueio de alteração automática por poucos losses

---

### **FASE 5: Otimização de Saída** (Requisito 10)
**Valor:** Médio — melhoria incremental  
**Esforço:** Médio  
**Arquivos a criar:**
- `src/lib/engines/exitOptimizer.ts` (novo)
- `src/routes/otimizacao-saida.tsx` (novo)
- `src/components/lab/ExitComparison.tsx` (novo)

**Funções:**
```typescript
// src/lib/engines/exitOptimizer.ts
export interface ExitStrategy {
  name: string; // "3R/5R/runner", "1R fixo", "2.5R parcial 50%", ...
  simulate(trade: BacktestTrade): { resultR: number; resultPoints: number };
}

export function compareExitStrategies(
  trades: BacktestTrade[],
  strategies: ExitStrategy[]
): Map<string, PerformanceStats>;
```

**Critério de aceitação:**
- [ ] 11 estratégias comparadas (1R, 1.5R, 2R, 2.5R, 3R, 4R, 5R, parcial, runner, trailing, break-even)
- [ ] Mesmas entradas, diferentes saídas (comparação justa)
- [ ] MFE/MAE usado para validar saída ótima
- [ ] UI mostra comparação lado a lado
- [ ] Recomendação baseada em dados (não opinião)

---

### **FASE 6: Análise de Perdas + Integração Print** (Requisitos 5, 11)
**Valor:** Médio — aprendizado contínuo  
**Esforço:** Alto  
**Arquivos a modificar:**
- `src/lib/engines/postTradeReview.ts` (expandir fatores)
- `src/lib/engines/lossAnalyzer.ts` (novo)
- `src/lib/print/printHistory.ts` (integrar com SQLite)
- `src/routes/analise-perdas.tsx` (novo)

**Novos fatores:**
```typescript
// src/lib/engines/lossAnalyzer.ts
export type LossFactor =
  | 'contra_tendencia'
  | 'pullback_profundo'
  | 'entrada_proxima_barreira'
  | 't4_tardia'
  | 'volatilidade_anormal'
  | 'confirmacao_fraca'
  | 'rr_ruim';

export function analyzeLoss(trade: BacktestTrade): LossFactor[];
export function compareWithWinners(
  loss: BacktestTrade,
  winners: BacktestTrade[]
): { similarWins: BacktestTrade[]; differences: string[] };
```

**Critério de aceitação:**
- [ ] 7 fatores de loss analisados
- [ ] Comparação com vencedoras semelhantes
- [ ] Print vinculado ao trade no SQLite
- [ ] Fluxo PRINT → DNA → REGISTRO → RESULTADO testado
- [ ] UI de análise pós-loss

---

## Conclusão

O projeto tem **base técnica sólida** (motor T4, banco, pipeline de visão), mas o sistema de **mensuração estatística** precisa ser construído. Os 14 requisitos formam um **ciclo virtuoso**:

```
DNA Completo → Performance Segmentada → Descoberta de Padrões
       ↓                                    ↓
  Análise de Perdas ← Validação OOS ← Laboratório
       ↓                                    ↓
Otimização de Saída ← Proteção Overfitting ← Regra Crítica
```

**Próximos passos recomendados:**
1. Implementar **FASE 1 (DNA Completo)** — habilita todos os outros
2. Implementar **FASE 2 (Performance Segmentada)** — descobre vantagens reais
3. Implementar **FASE 3 (Validação OOS)** — previne overfitting
4. As fases 4-6 podem ser feitas em paralelo após as 3 primeiras

**Estimativa total:** 4-6 semanas de desenvolvimento focado, com testes reais em produção.

---

**Fim da auditoria.**