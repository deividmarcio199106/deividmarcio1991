/**
 * MOTOR QUANT (spec §25/§26) — backtest candle a candle sobre séries IMPORTADAS.
 *
 * É a versão HEADLESS e PURA do fluxo `useContinuousBacktest.runFrontier`:
 * nenhuma tela, nenhum store, nenhum relógio local — só a série e a técnica.
 * NADA de técnica é reimplementado aqui: `analyze`, `evaluateT4Gates`,
 * `evaluateOperation`, `decide`, `EntryStateMachine`, `LiveOutcomeTracker` e
 * `createBacktestTrade` são as MESMAS peças do ao vivo/replay. Se este motor
 * calculasse qualquer gate por conta própria, mediria outra técnica.
 *
 * RESTRIÇÕES QUE ESTE ARQUIVO EXISTE PARA GARANTIR:
 *
 * 1. ANTI-LOOK-AHEAD LITERAL — no candle i, `analyze()` recebe SOMENTE
 *    candles[0..i]. Candle futuro só alimenta o `LiveOutcomeTracker` DEPOIS
 *    que a decisão foi congelada por `structuredClone` (decisão em T, desfecho
 *    com T+1 em diante — a mesma mecânica do `runFrontier`).
 * 2. `now` é o instante do CANDLE, nunca `Date.now()`: reexecutar a mesma
 *    série tem de produzir os mesmos estágios e os mesmos trades.
 * 3. UM setup por vez. O candle que alimenta um desfecho em curso fica
 *    reservado a ele — mesmo que a operação feche nesse candle, não há
 *    reentrada no mesmo candle (paridade com `hadTrackerAtOpen` do hook).
 * 4. `decide()` roda em BACKTEST_DISCOVERY com base VAZIA: a evidência
 *    histórica nasce aqui, então evidência anterior não pode autorizar nem
 *    contaminar a própria construção.
 * 5. Cobertura nunca é silêncio: todo candle que não virou análise entra em
 *    `discards` com motivo, e operação ainda aberta no fim da série NUNCA
 *    vira trade — amostra insuficiente não é conclusão.
 */

import { analyze } from "@/lib/engines/analysisPipeline";
import { decide, EntryStateMachine } from "@/lib/engines/backtestDecisionEngine";
import { createBacktestTrade, type BacktestTrade } from "@/lib/engines/backtestEngine";
import { dnaFromAnalysis, dnaTradeFields } from "@/lib/engines/dnaExtractor";
import type { FinancialRiskConfig } from "@/lib/engines/financialRisk";
import { resolveInstrument } from "@/lib/engines/instruments";
import { LiveOutcomeTracker, type LiveOperationResult } from "@/lib/engines/liveOutcome";
import {
  DEFAULT_RISK_PARAMS,
  riskParamsForAsset,
  STRATEGY_VERSION,
  type RiskParams,
} from "@/lib/engines/strategy";
import type { AnalysisResult, Candle } from "@/lib/engines/types";
import { evaluateT4Gates } from "@/lib/t4/gates";
import { executeHybridEntry } from "@/lib/t4/t42FillEngine";
import { evaluateOperation, type T4Operation } from "@/lib/t4/preEntry";
import { buildReadingState, MIN_CLOSED_CANDLES } from "@/lib/t4/readingState";

/**
 * MESMA janela de análise do `useContinuousBacktest` (constante local de lá).
 * A decisão em T do caminho visual enxerga no máximo 160 candles; se o motor
 * quant olhasse a série inteira, mediria uma técnica com mais contexto do que
 * a produção jamais teve.
 */
const ANALYSIS_WINDOW = 160;

/** Mesmo default do armamento no hook: `new LiveOutcomeTracker(..., 10, ...)`. */
export const DEFAULT_MAX_WAIT_BARS = 10;

/**
 * BACKTEST_DISCOVERY não dimensiona ordem real (`recommendedContracts` sai
 * null por construção). Zeros = "não configurado" DECLARADO — nunca um saldo
 * ou risco inventado para dentro da estatística.
 */
const ZERO_RISK: FinancialRiskConfig = {
  accountBalance: 0,
  maxRiskPercent: 0,
  maxRiskMoney: 0,
  contractsLimit: 0,
};

export interface QuantOptions {
  /** Ativo da série importada (ex.: WINFUT). Resolve o instrumento padrão B3. */
  asset: string;
  /**
   * Mínimo de candles fechados antes de a análise sequer rodar. Default:
   * `MIN_CLOSED_CANDLES` (24) — o MESMO portão do ao vivo. Abaixar este número
   * não afrouxa gate nenhum: `buildReadingState` continua declarando leitura
   * insuficiente e a técnica continua bloqueada; só muda o que vira discard.
   */
  minWindow?: number;
  /** Candles de espera pela execução da entrada antes de expirar. Default 10. */
  maxWaitBars?: number;
  /**
   * Parâmetros de risco REPASSADOS a `analyze()` — o MESMO ponto de injeção que
   * o pipeline de produção já expõe (`analyze(window, { reading, riskParams })`).
   *
   * RESTRIÇÃO: este campo NÃO cria knob novo nenhum. Ele apenas deixa o motor
   * quant usar a configuração que `buildPlan` já lê (método do stop, distância
   * mínima/máxima, múltiplos de alvo e tick). Ausente ⇒ `DEFAULT_RISK_PARAMS`,
   * exatamente o comportamento anterior a este campo existir.
   */
  riskParams?: RiskParams;
  /**
   * PERFIL DE EXECUÇÃO pós-confirmação.
   *
   * "T41_LIMIT_EXACT" (default): o comportamento de SEMPRE — limite na entrada
   * do plano, espera de maxWaitBars. É a produção; nada muda sem pedir.
   *
   * "T42_HYBRID": a candidata congelada — zona do E2, TTL de candles FECHADOS,
   * fill recalculado e re-gateado pelo MESMO motor (t42FillEngine) que
   * setupTracker e pregao consomem. Nenhum número da candidata é configurável
   * por aqui: todos moram congelados em T42_EXECUTION.
   */
  executionProfile?: "T41_LIMIT_EXACT" | "T42_HYBRID";
}

/** Evento de execução T4.2 — uma linha por E2 confirmado, qualquer desfecho. */
export interface T42Event {
  eventoId: string;
  decisionAt: number;
  direction: "COMPRA" | "VENDA";
  e2: Candle;
  zone: { zoneLow: number; zoneHigh: number; proximal: number; distal: number };
  ttl: number;
  status: "FILLED" | "EXPIRED_NO_FILL" | "BLOCKED";
  code: string | null;
  reason: string | null;
  fillCandle: number | null;
  rawFillPrice: number | null;
  fillPrice: number | null;
  slippagePoints: number | null;
  stopEstrutural: number;
  target3R: number | null;
  target5R: number | null;
  rrAtFill: number | null;
}

export interface QuantResult {
  /** Somente operações com desfecho CONHECIDO (executadas e encerradas). */
  trades: BacktestTrade[];
  /** Decisões congeladas (trackers armados) — inclui as que expiraram. */
  setupsDetected: number;
  /** Total de candles recebidos, inclusive os que caíram em `discards`. */
  candlesProcessed: number;
  /**
   * Por que candles não viraram análise — transparência de cobertura:
   * - `candle_invalido`: OHLC não finito ou máxima < mínima (pré-passe);
   * - `timestamp_duplicado`: mesmo `t` repetido — o primeiro vence;
   * - `janela_curta`: menos candles fechados que `minWindow`;
   * - `reservado_ao_desfecho`: candle consumido pelo outcome da decisão
   *   congelada (sem reentrada no mesmo candle);
   * - `sem_features`: `analyze()` devolveu null (série curta demais para
   *   extrair features).
   * Dois contadores NÃO são candles, e sim desfechos declarados:
   * - `setups_expirados_sem_execucao`: decisão congelada cuja entrada nunca
   *   executou em `maxWaitBars` candles;
   * - `operacoes_em_aberto_no_fim`: decisão ainda sem desfecho quando a série
   *   acabou — nunca vira trade.
   */
  discards: Record<string, number>;
  /** Só no perfil T42_HYBRID: um evento por E2 confirmado. */
  t42Events?: T42Event[];
}

/**
 * `2026-03-13` LOCAL do instante da decisão — MESMA convenção de
 * `tradingDateOf` em `@/lib/t4/dna.ts`, para o trade e o seu DNA nunca
 * afirmarem datas diferentes do mesmo instante.
 */
export function tradingDateOf(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function runQuantBacktest(candles: Candle[], options: QuantOptions): QuantResult {
  const minWindow = Math.max(1, Math.trunc(options.minWindow ?? MIN_CLOSED_CANDLES));
  const maxWaitBars = Math.max(1, Math.trunc(options.maxWaitBars ?? DEFAULT_MAX_WAIT_BARS));
  /*
   * O TICK É DO ATIVO, NÃO DA VARIANTE — e o laboratório não é exceção.
   *
   * Este ponto caía em `DEFAULT_RISK_PARAMS` puro, cujo `tickSize` é 0, e a
   * varredura de parâmetros não corrige isso: `toQuantOptions` copia
   * `BASELINE_PARAMS.tickSize`, que também nasce de `DEFAULT_RISK_PARAMS`. Ou
   * seja, os DOIS caminhos do quant mediam planos com `roundToTick` inerte —
   * entrada/stop/alvo em preços que o contrato não negocia. Como o ao vivo, o
   * backtest contínuo e o replay já aplicam `riskParamsForAsset`, a pesquisa
   * estava medindo uma técnica que a produção não executa: PF, drawdown em R e
   * ranking de candidatas saíam de níveis arredondados de um jeito que o book
   * arredonda de outro.
   *
   * Sobrepor o tick não afrouxa nem cria knob: `SweepableParam` já EXCLUI
   * `tickSize` da varredura de propósito ("varrê-lo mediria o ativo, não a
   * técnica"), então nenhuma variante o estava usando como eixo. Tudo o mais
   * que a variante define — método do stop, distâncias, múltiplos de alvo —
   * continua vindo dela, intacto.
   */
  const riskParams = riskParamsForAsset(options.asset, options.riskParams ?? DEFAULT_RISK_PARAMS);

  const discards: Record<string, number> = {};
  const discard = (reason: string): void => {
    discards[reason] = (discards[reason] ?? 0) + 1;
  };

  /*
   * PRÉ-PASSE: valida, ordena e deduplica ANTES de qualquer decisão.
   *
   * Uma série importada fora de ordem faria o "passado" de i conter candles
   * posteriores — look-ahead silencioso por dado sujo, não por lógica. Cada
   * candle removido entra em `discards` com motivo; nada some calado.
   */
  const valid: Candle[] = [];
  for (const candle of candles) {
    const finite = [candle.t, candle.o, candle.h, candle.l, candle.c].every((value) =>
      Number.isFinite(value),
    );
    if (!finite || candle.h < candle.l) {
      discard("candle_invalido");
      continue;
    }
    valid.push(candle);
  }
  valid.sort((a, b) => a.t - b.t);
  const series: Candle[] = [];
  const seenAt = new Set<number>();
  for (const candle of valid) {
    if (seenAt.has(candle.t)) {
      // Sort estável: em empate de `t`, o PRIMEIRO da série importada vence.
      discard("timestamp_duplicado");
      continue;
    }
    seenAt.add(candle.t);
    series.push(candle);
  }

  const instrument = resolveInstrument(options.asset, {});
  const machine = new EntryStateMachine();
  /** Identidade determinística da execução: mesma série ⇒ mesmos ids de DNA. */
  const sourceCaptureId = `quant_${options.asset}_${series[0]?.t ?? 0}`;

  const executionProfile = options.executionProfile ?? "T41_LIMIT_EXACT";
  const t42Events: T42Event[] = [];

  const trades: BacktestTrade[] = [];
  let setupsDetected = 0;
  let tracker: LiveOutcomeTracker | null = null;
  /**
   * E2 confirmado AGUARDANDO a zona T4.2 (só no perfil T42_HYBRID). Os candles
   * fechados pós-E2 acumulam aqui e o veredito vem SEMPRE do motor congelado —
   * este arquivo não decide zona, TTL nem fill.
   */
  let pendingT42: {
    e2: Candle;
    decisionAt: number;
    direction: "COMPRA" | "VENDA";
    stopEstrutural: number;
    obstaculo: number | null;
    candles: Candle[];
  } | null = null;
  let frozenAnalysis: AnalysisResult | null = null;
  /** DNA classificado no ARMAMENTO, com a janela daquele instante — prova por
   * construção de que a classificação não conheceu o desfecho. */
  let frozenDna: Partial<BacktestTrade> | null = null;
  let previousOperation: T4Operation | null = null;
  /** Detecções anteriores, para o ordinal (1ª/2ª/3ª T4 do movimento). */
  let priorDetections: { direction: string; detectedAt: number }[] = [];

  /**
   * Encerra a operação congelada. Como no `closeTrade` do hook: o estado zera
   * SEMPRE; trade só existe quando houve execução E desfecho conhecido.
   */
  const finalizeOperation = (progressed: LiveOperationResult, lastCandle: Candle): void => {
    const frozen = frozenAnalysis;
    const dna = frozenDna;
    tracker = null;
    frozenAnalysis = null;
    frozenDna = null;
    machine.reset();
    if (!frozen) return;
    if (!progressed.filled || progressed.result === null || progressed.rMultiple === null) {
      // Expirou SEM operação: a detecção já está em setupsDetected. Fabricar
      // um trade aqui transformaria ausência de execução em estatística.
      discard("setups_expirados_sem_execucao");
      return;
    }
    const trade = createBacktestTrade({
      analysis: frozen,
      // DNA do ARMAMENTO, com a janela daquele instante — não uma extração
      // tardia sem geometria.
      dna: dna ?? undefined,
      asset: options.asset,
      sourceCaptureId,
      origin: "BACKTEST",
      closedAt: progressed.exitAt ?? lastCandle.t,
      entryHitAt: progressed.entryHitAt,
      partialHitAt: progressed.partialHitAt,
      exitAt: progressed.exitAt,
      exit: progressed.exit ?? frozen.price,
      result: progressed.result,
      rMultiple: progressed.rMultiple,
      mfeMae:
        progressed.mfePoints !== null && progressed.maePoints !== null
          ? {
              mfePoints: progressed.mfePoints,
              maePoints: progressed.maePoints,
              mfeR: progressed.mfeR,
              maeR: progressed.maeR,
            }
          : null,
      exitReason: progressed.exitReason,
      ambiguousIntrabar: progressed.ambiguousIntrabar,
      // Candle importado carrega o próprio instante de mercado — a data é do
      // dado, não do dia em que o motor rodou.
      tradingDate: tradingDateOf(frozen.t),
      productionTechniqueVersion: STRATEGY_VERSION,
    });
    if (trade !== null) trades.push(trade);
  };

  for (let index = 0; index < series.length; index++) {
    const candle = series[index]!;

    /*
     * T4.2 PENDENTE VEM ANTES DE TUDO: o candle que acabou de fechar pertence
     * ao rastreio do fill — nunca a uma nova análise. Mesma disciplina do
     * "candle reservado ao desfecho", uma casa antes.
     */
    if (pendingT42 !== null) {
      pendingT42.candles.push(candle);
      const veredito = executeHybridEntry({
        e2: pendingT42.e2,
        direction: pendingT42.direction,
        stopEstrutural: pendingT42.stopEstrutural,
        obstaculo: pendingT42.obstaculo,
        candlesFechadosAposE2: pendingT42.candles,
      });
      if (veredito.status === "AGUARDANDO_RETESTE") {
        discard("reservado_ao_fill_t42");
        continue;
      }
      const eventoBase = {
        eventoId: `t42_${sourceCaptureId}_${pendingT42.decisionAt}`,
        decisionAt: pendingT42.decisionAt,
        direction: pendingT42.direction,
        e2: pendingT42.e2,
        zone: veredito.zone,
        ttl: pendingT42.candles.length,
        stopEstrutural: pendingT42.stopEstrutural,
      };
      if (veredito.status === "EXPIRED_NO_FILL" || veredito.status === "BLOCKED") {
        // NÃO é operação: vira evento + discard declarado. Fabricar trade de
        // um não-preenchimento transformaria ausência em estatística.
        t42Events.push({
          ...eventoBase,
          status: veredito.status,
          code: veredito.status === "BLOCKED" ? veredito.code : "EXPIRED_NO_FILL",
          reason: veredito.status === "BLOCKED" ? veredito.reason : veredito.reason,
          fillCandle: null,
          rawFillPrice: null,
          fillPrice: null,
          slippagePoints: null,
          target3R: null,
          target5R: null,
          rrAtFill: null,
        });
        discard(
          veredito.status === "EXPIRED_NO_FILL"
            ? "t42_expired_no_fill"
            : `t42_blocked_${veredito.code}`,
        );
        pendingT42 = null;
        frozenAnalysis = null;
        frozenDna = null;
        machine.reset();
        continue;
      }
      // FILLED — o rastreador de desfecho nasce NO PREÇO DO FILL.
      //
      // ENTRY = rawFillPrice (contido no candle do toque por construção); o
      // slippage congelado vira CUSTO declarado no evento, não deslocamento do
      // tracker — o gate de RR já rodou sobre o preço COM slippage (pior),
      // então a aprovação é conservadora.
      const raw = veredito.fill.rawFillPrice;
      const riscoRaw = Math.abs(raw - pendingT42.stopEstrutural);
      const dirNum = pendingT42.direction === "COMPRA" ? 1 : -1;
      const alvo3Raw = raw + dirNum * riscoRaw * 3;
      const alvo5Raw = raw + dirNum * riscoRaw * 5;
      t42Events.push({
        ...eventoBase,
        status: "FILLED",
        code: null,
        reason: null,
        fillCandle: veredito.fill.fillCandle,
        rawFillPrice: raw,
        fillPrice: veredito.fill.fillPrice,
        slippagePoints: veredito.fill.slippagePoints,
        target3R: veredito.plan.target3R,
        target5R: veredito.plan.target5R,
        rrAtFill: veredito.plan.rr,
      });
      // Cópia local: closures (finalizeOperation) também escrevem nesta let e
      // o narrowing do TypeScript não sobrevive a isso.
      if (frozenAnalysis !== null && frozenAnalysis.plan !== null) {
        // A asserção existe porque o narrowing desta let não sobrevive às
        // closures que também a escrevem (finalizeOperation) — a checagem de
        // null REAL está na linha de cima; o `as` só repete para o compilador
        // o que o runtime acabou de provar.
        const congelada = frozenAnalysis as AnalysisResult & {
          plan: NonNullable<AnalysisResult["plan"]>;
        };
        // O trade nasce dos NÍVEIS EXECUTADOS, não dos planejados no E2.
        frozenAnalysis = {
          ...congelada,
          plan: {
            ...congelada.plan,
            entry: raw,
            stop: pendingT42.stopEstrutural,
            target1: alvo3Raw,
            target2: alvo5Raw,
            stopDistance: riscoRaw,
            riskReward: riscoRaw > 0 ? Math.abs(alvo3Raw - raw) / riscoRaw : 0,
            riskRewardFinal: riscoRaw > 0 ? Math.abs(alvo5Raw - raw) / riscoRaw : 0,
          },
        };
      }
      tracker = new LiveOutcomeTracker(
        pendingT42.direction,
        raw,
        pendingT42.stopEstrutural,
        alvo3Raw,
        alvo5Raw,
        maxWaitBars,
        { threeContractRunner: true },
      );
      pendingT42 = null;
      // O candle do fill TAMBÉM avança o desfecho (fill e stop/alvo no mesmo
      // candle seguem a regra stop-vence do tracker, como no resto do motor).
      const progressed = tracker.push(candle);
      if (progressed.done) finalizeOperation(progressed, candle);
      discard("reservado_ao_fill_t42");
      continue;
    }

    // PRIMEIRO: decisão congelada antes deste candle só pode ter o DESFECHO
    // avançado por ele. Isso impede usar o candle atual para criar a decisão
    // e, no mesmo passo, dizer que entrada/stop/alvo já aconteceram.
    const hadTrackerAtOpen = tracker !== null;
    if (tracker !== null) {
      const progressed = tracker.push(candle);
      if (progressed.done) finalizeOperation(progressed, candle);
    }
    if (hadTrackerAtOpen) {
      // Mesmo que a operação tenha fechado AGORA, o candle foi reservado ao
      // outcome — sem reentrada no mesmo candle (paridade com o hook).
      discard("reservado_ao_desfecho");
      continue;
    }

    const closedCount = index + 1;
    if (closedCount < minWindow) {
      discard("janela_curta");
      continue;
    }

    // Janela encerrada EXATAMENTE em T: candles[max(0, i-159)..i]. Nenhum
    // acesso a index+1 existe deste ponto em diante nesta iteração.
    const history = series.slice(Math.max(0, index - ANALYSIS_WINDOW + 1), index + 1);

    /*
     * Série importada = preço REAL por construção: não existe conversão
     * pixel→preço para calibrar nem qualidade visual a degradar. Declarar
     * menos que isso inventaria um defeito que o dado não tem.
     */
    const reading = buildReadingState({
      closedCandles: closedCount,
      quality: 100,
      priceScaleReady: true,
      calibrationConfidence: 100,
    });
    const result = analyze(history, { reading, riskParams });
    if (result === null) {
      discard("sem_features");
      continue;
    }

    /*
     * MESMOS GATES DO AO VIVO, com `now` = t do candle. `Date.now()` aqui
     * quebraria o determinismo que o teste de reexecução tranca.
     */
    const gates = evaluateT4Gates(result, true);

    /*
     * ORDEM IGUAL À DO AO VIVO — decidir, mover a máquina, e SÓ ENTÃO avaliar a
     * operação (useProfitVision: decide 274 → onDecision 290 → evaluateOperation
     * 324). Aqui `decide()` vinha DEPOIS e `decision: null` entrava no lugar
     * dela; como `entry`/`stop` nascem exclusivamente de `decision`
     * (preEntry.ts:214-215) e `confirmed: true` exige os dois (preEntry.ts:261),
     * `operation.confirmed` era inatingível e o portão de armamento abaixo
     * NUNCA abria: zero setup, zero trade, em toda série. Reordenar não afrouxa
     * o anti-lookahead — `decide()` lê apenas `result`, derivado da janela
     * fechada em T.
     */
    const decided = decide({
      analysis: result,
      asset: options.asset,
      // A base NASCE VAZIA: este motor constrói a evidência; evidência
      // anterior seria a base autorizando a própria construção.
      trades: [],
      techniqueSnapshot: STRATEGY_VERSION,
      instrument,
      riskConfig: ZERO_RISK,
      mode: "BACKTEST_DISCOVERY",
    });
    const state = machine.onDecision(decided);

    const operation = evaluateOperation({
      dataReady: true,
      dataGates: [],
      t4Gates: gates,
      analysis: result,
      decision: decided,
      entryState: machine.current(),
      previous: previousOperation,
      now: candle.t,
    });
    previousOperation = operation;

    // O ESTÁGIO T4 É PORTÃO AQUI TAMBÉM: a máquina de entrada só olha a
    // decisão; `operation.confirmed` exige o gatilho técnico cumprido.
    const plan = result.plan;
    if (
      state === "CONFIRMED" &&
      operation.confirmed &&
      plan !== null &&
      result.direction !== "NEUTRO"
    ) {
      // DECISÃO CONGELADA EM T: candles posteriores só podem executar ou
      // encerrar esta operação; nunca recalculá-la.
      frozenAnalysis = structuredClone(result);
      const dna = dnaFromAnalysis(result, {
        id: `dna_${sourceCaptureId}_${result.t}_${result.direction}`,
        // Vocabulário fechado de DnaOrigin não tem "QUANT"; REPLAY é a origem
        // fora-do-ao-vivo — a mesma usada pelo backtest por observação.
        origin: "REPLAY",
        sourceId: sourceCaptureId,
        asset: options.asset,
        window: history,
        priorSameDirectionAt: priorDetections
          .filter((prior) => prior.direction === result.direction)
          .map((prior) => prior.detectedAt),
        techniqueVersion: STRATEGY_VERSION,
        // Diferente do replay em vídeo: a grade de tempo é do PRÓPRIO dado
        // importado, não do relógio local — data/hora podem ser afirmadas.
        marketTimeTrusted: true,
      });
      if (dna !== null) {
        frozenDna = dnaTradeFields(dna);
        priorDetections = [
          ...priorDetections,
          { direction: dna.direction, detectedAt: dna.detectedAt },
        ].slice(-200);
      } else {
        frozenDna = null;
      }
      if (executionProfile === "T42_HYBRID") {
        /*
         * O E2 é ESTE candle fechado (a confirmação nasceu dele). A execução
         * agora pertence ao motor congelado: zona, TTL e fill saem de lá, e o
         * stop ESTRUTURAL do plano viaja imutável para o recálculo.
         */
        pendingT42 = {
          e2: candle,
          decisionAt: candle.t,
          direction: result.direction,
          stopEstrutural: plan.stop,
          obstaculo: plan.targetLiquidityPrice ?? null,
          candles: [],
        };
      } else {
        tracker = new LiveOutcomeTracker(
          result.direction,
          plan.entry,
          plan.stop,
          plan.target1,
          plan.target2,
          maxWaitBars,
          { threeContractRunner: true },
        );
      }
      setupsDetected++;
    }
  }

  // Operação sem desfecho quando a série acabou: declarada, nunca concluída.
  if (tracker !== null) discard("operacoes_em_aberto_no_fim");
  if (pendingT42 !== null) discard("t42_aguardando_no_fim");

  return {
    trades,
    setupsDetected,
    candlesProcessed: candles.length,
    discards,
    ...(executionProfile === "T42_HYBRID" ? { t42Events } : {}),
  };
}
