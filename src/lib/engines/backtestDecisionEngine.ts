import { assetConfig, validationBlockReason } from "@/lib/t4/assets";
import type { BacktestTrade } from "./backtestEngine";
import { evaluateEvidence, MIN_EVIDENCE_SAMPLE, type EvidenceReport } from "./evidenceValidation";
import { computeContractsByFinancialRisk, type FinancialRiskConfig } from "./financialRisk";
import { findSimilarCases, queryFromAnalysis, type SimilarCase } from "./historicalSimilarity";
import type { Instrument } from "./instruments";
import type { AnalysisResult } from "./types";

/**
 * BACKTEST_DECISION_ENGINE (comando master §29, §74–§75, §99).
 *
 * A autoridade operacional é técnica + contexto + CASOS HISTÓRICOS
 * SEMELHANTES + estatística validada + regime + robustez + risco. Não existe
 * pontuação agregada nem faixa percentual autorizando entrada.
 *
 * REGRA §75: AUSÊNCIA DE EVIDÊNCIA = WAIT. Nada é preenchido artificialmente.
 */

export type DecisionKind = "ENTER_LONG" | "ENTER_SHORT" | "WAIT" | "REJECT";
export type MarketDrift = "NORMAL" | "MODERATE_DRIFT" | "HIGH_DRIFT" | "OUT_OF_DISTRIBUTION";

export interface DecisionObject {
  decisionId: string;
  candidateId: string | null;
  decision: DecisionKind;
  strategyId: string | null;
  strategyVersion: string;
  instrument: string;
  timeframe: "1m";
  timestamp: number;
  marketRegime: string;
  entryPrice: number | null;
  stopPrice: number | null;
  partialPrice: number | null;
  targetPrice: number | null;
  riskPoints: number | null;
  rewardPoints: number | null;
  riskRewardRatio: number | null;
  recommendedContracts: number | null;
  sampleSize: number;
  winRate: number | null;
  profitFactor: number | null;
  expectancyR: number | null;
  maxDrawdown: number | null;
  averageMfeR: number | null;
  averageMaeR: number | null;
  outOfSampleValidated: boolean;
  walkForwardStable: boolean;
  evidenceConfidence: EvidenceReport["confidence"];
  marketDrift: MarketDrift;
  strategyHealth: string;
  decisionReasons: string[];
  rejectionReasons: string[];
  evidenceIds: string[];
  similarCases: number;
}

/** §42: deriva do mercado — a configuração atual existe na base histórica? */
export function assessDrift(similar: SimilarCase[], base: BacktestTrade[]): MarketDrift {
  if (base.length < MIN_EVIDENCE_SAMPLE) return "NORMAL"; // sem base, drift não é mensurável
  const ratio = similar.length / base.length;
  if (similar.length === 0) return "OUT_OF_DISTRIBUTION";
  if (ratio < 0.03) return "HIGH_DRIFT";
  if (ratio < 0.08) return "MODERATE_DRIFT";
  return "NORMAL";
}

export interface RiskSizingInput {
  direction: "COMPRA" | "VENDA";
  entry: number;
  stop: number;
  instrument: Instrument | null;
  config: FinancialRiskConfig;
  /** Drawdown atual acumulado em R (<= 0). */
  currentDrawdownR: number;
  /** Resultado do dia em R (<= 0 quando perdendo). */
  dailyLossR: number;
}

export interface RiskSizingResult {
  recommendedContracts: number | null;
  reasons: string[];
}

/**
 * RiskSizingEngine (§62): contratos SEM faixas percentuais. Base = risco
 * financeiro configurado; reduções objetivas por drawdown e perda diária.
 * Sem configuração => null + "AGUARDANDO DADOS" (nunca inventa).
 */
export function computeRecommendedContracts(input: RiskSizingInput): RiskSizingResult {
  const reasons: string[] = [];
  if (!input.instrument) {
    return {
      recommendedContracts: null,
      reasons: ["Instrumento não configurado (tick/valor do ponto)."],
    };
  }
  const financial = computeContractsByFinancialRisk(
    input.direction,
    input.entry,
    input.stop,
    input.instrument,
    input.config,
  );
  if (!financial.configured) return { recommendedContracts: null, reasons: [financial.reason] };
  reasons.push(financial.reason);
  let contracts = Math.min(financial.contracts, input.config.contractsLimit);

  if (input.dailyLossR <= -2) {
    reasons.push(
      `Perda diária ${input.dailyLossR.toFixed(1)}R atingiu o limite — 0 contratos hoje.`,
    );
    return { recommendedContracts: 0, reasons };
  }
  if (input.currentDrawdownR <= -5 && contracts > 1) {
    contracts = Math.max(1, Math.floor(contracts / 2));
    reasons.push(`Drawdown ${input.currentDrawdownR.toFixed(1)}R — tamanho reduzido pela metade.`);
  }
  return { recommendedContracts: contracts, reasons };
}

export type DecisionMode = "PRODUCTION" | "BACKTEST_DISCOVERY";

export interface DecisionInput {
  analysis: AnalysisResult;
  asset: string;
  /** Base histórica completa (o motor filtra por versão e similaridade). */
  trades: BacktestTrade[];
  instrument: Instrument | null;
  riskConfig: FinancialRiskConfig;
  currentDrawdownR?: number;
  dailyLossR?: number;
  /**
   * PRODUCTION exige evidência histórica validada. BACKTEST_DISCOVERY permite
   * que um setup tecnicamente completo seja congelado e acompanhado para
   * CONSTRUIR a própria evidência. Nunca usar BACKTEST_DISCOVERY no ao vivo.
   */
  mode?: DecisionMode;
  /**
   * §17: versão da técnica CONGELADA no início da sessão ao vivo. A base de
   * evidência filtra por ela — uma candidata do Laboratório nunca afeta a
   * sessão em andamento.
   */
  techniqueSnapshot?: string;
}

export function decide(input: DecisionInput): DecisionObject {
  const { analysis, asset } = input;
  const base: DecisionObject = {
    decisionId: `dec_${analysis.t}`,
    candidateId: null,
    decision: "WAIT",
    strategyId: null,
    strategyVersion: input.techniqueSnapshot ?? analysis.strategyVersion,
    instrument: asset,
    timeframe: "1m",
    timestamp: analysis.t,
    marketRegime: analysis.regime.regime,
    entryPrice: null,
    stopPrice: null,
    partialPrice: null,
    targetPrice: null,
    riskPoints: null,
    rewardPoints: null,
    riskRewardRatio: null,
    recommendedContracts: null,
    sampleSize: 0,
    winRate: null,
    profitFactor: null,
    expectancyR: null,
    maxDrawdown: null,
    averageMfeR: null,
    averageMaeR: null,
    outOfSampleValidated: false,
    walkForwardStable: false,
    evidenceConfidence: "INSUFFICIENT",
    marketDrift: "NORMAL",
    strategyHealth: "WATCH",
    decisionReasons: [],
    rejectionReasons: [],
    evidenceIds: [],
    similarCases: 0,
  };

  // Sem setup técnico completo (sequência causal, gates, direção) => WAIT.
  const query = queryFromAnalysis(analysis, asset);
  if (!analysis.technicalReady || !query || !analysis.plan) {
    base.rejectionReasons.push("Sequência técnica incompleta — sem candidato de operação.");
    return base;
  }
  base.candidateId = `cand_${analysis.t}`;
  base.strategyId = query.setup;

  // Contradições bloqueantes do motor adversarial => REJECT com motivos.
  const blocking = analysis.contradictions.filter((c) => c.severity === "bloqueia");
  if (blocking.length > 0 || analysis.blockers.length > 0) {
    base.decision = analysis.blockers.length > 0 && blocking.length === 0 ? "WAIT" : "REJECT";
    base.rejectionReasons.push(
      ...blocking.map((c) => c.description),
      ...analysis.blockers.slice(0, 4),
    );
    return base;
  }

  // Evidência histórica: casos semelhantes da MESMA versão da estratégia.
  const techniqueVersion = input.techniqueSnapshot ?? analysis.strategyVersion;
  const versionTrades = input.trades.filter((t) => t.strategyVersion === techniqueVersion);
  const similar = findSimilarCases(query, versionTrades);
  const similarTrades = similar.map((s) => s.trade);
  base.similarCases = similar.length;
  base.marketDrift = assessDrift(similar, versionTrades);
  base.evidenceIds = similarTrades.slice(0, 20).map((t) => t.id);

  const evidence = evaluateEvidence(similarTrades);
  base.sampleSize = evidence.sample;
  base.evidenceConfidence = evidence.confidence;
  base.strategyHealth = evidence.health.health;
  if (evidence.sample > 0) {
    base.winRate = Number(evidence.stats.winRate.toFixed(1));
    base.profitFactor = Number.isFinite(evidence.stats.profitFactor)
      ? Number(evidence.stats.profitFactor.toFixed(2))
      : null;
    base.expectancyR = Number(evidence.stats.expectancy.toFixed(3));
    base.maxDrawdown = Number(evidence.stats.maxDrawdown.toFixed(2));
    const mfe = similarTrades
      .map((trade) => trade.mfeR)
      .filter((value): value is number => value !== null && Number.isFinite(value));
    const mae = similarTrades
      .map((trade) => trade.maeR)
      .filter((value): value is number => value !== null && Number.isFinite(value));
    base.averageMfeR = mfe.length
      ? Number((mfe.reduce((sum, value) => sum + value, 0) / mfe.length).toFixed(2))
      : null;
    base.averageMaeR = mae.length
      ? Number((mae.reduce((sum, value) => sum + value, 0) / mae.length).toFixed(2))
      : null;
  }
  base.outOfSampleValidated = evidence.oosValidated;
  base.walkForwardStable = evidence.walkForward.stable;

  // BOOTSTRAP DO BACKTEST: o histórico precisa conseguir nascer do zero.
  // Neste modo, evidência anterior é INFORMAÇÃO, não autorização. O candidato
  // só chega aqui se todos os gates técnicos/causais e preços reais estiverem
  // válidos no instante T. A operação é congelada e o resultado só pode ser
  // conhecido pelos candles T+1, T+2... O modo de produção continua abaixo e
  // mantém a exigência de amostra/OOS/walk-forward.
  if ((input.mode ?? "PRODUCTION") === "BACKTEST_DISCOVERY") {
    const plan = analysis.plan;
    const direction = analysis.direction as "COMPRA" | "VENDA";
    base.decision = direction === "COMPRA" ? "ENTER_LONG" : "ENTER_SHORT";
    base.entryPrice = plan.entry;
    base.stopPrice = plan.stop;
    base.partialPrice = plan.target1;
    base.targetPrice = plan.target2;
    base.riskPoints = plan.stopDistance;
    base.rewardPoints = Math.abs(plan.target2 - plan.entry);
    base.riskRewardRatio = plan.riskRewardPlan;
    base.recommendedContracts = null; // backtest mede técnica; não dimensiona ordem real
    base.decisionReasons.push(
      "BACKTEST_DISCOVERY: setup técnico completo congelado no instante T para construir evidência histórica.",
      `${similar.length} caso(s) semelhante(s) existentes; essa amostra NÃO autorizou a entrada histórica.`,
      `Regime observado em T: ${analysis.regime.regime}.`,
      "Candles posteriores podem apenas executar/encerrar a operação; nunca reescrever esta decisão.",
    );
    return base;
  }

  /*
   * PRODUÇÃO EXIGE ATIVO VALIDADO — antes de olhar evidência.
   *
   * A validação da técnica era global: provar a T4 no WIN liberava sinal em
   * qualquer símbolo digitado no campo "Ativo". WIN e WDO têm liquidez, horário,
   * tick e comportamento diferentes; a evidência histórica de um não descreve o
   * outro, e reaproveitá-la é a forma mais silenciosa de operar sem base.
   *
   * A checagem vem PRIMEIRO porque é sobre permissão, não sobre mercado: não
   * faz sentido avaliar a qualidade da evidência de um ativo que não pode
   * operar de qualquer forma.
   */
  const assetGate = validationBlockReason(
    assetConfig(asset),
    asset,
    input.techniqueSnapshot ?? analysis.strategyVersion,
  );
  if (assetGate !== null) {
    base.rejectionReasons.push(
      assetGate,
      "Valide o ativo por backtest, out-of-sample e walk-forward antes de liberar sinal real nele.",
    );
    return base;
  }

  // PRODUÇÃO: evidência insuficiente/fraca = WAIT, com motivos honestos.
  if (evidence.confidence === "INSUFFICIENT") {
    base.rejectionReasons.push(
      `${similar.length} caso(s) semelhante(s) — evidência insuficiente (mínimo ${MIN_EVIDENCE_SAMPLE}).`,
      "Continue alimentando o Backtest pela observação contínua do gráfico para construir a base desta configuração.",
    );
    return base;
  }
  if (evidence.confidence === "WEAK") {
    base.decision = "REJECT";
    base.rejectionReasons.push(...evidence.reasons);
    return base;
  }
  // Produção só recebe autorização depois de validação cronológica fora da amostra
  // E walk-forward estável. O backtest/replay continua coletando candidatos técnicos
  // sem esta exigência para que a base possa ser construída.
  if (!evidence.oosValidated || !evidence.walkForward.stable) {
    base.rejectionReasons.push(
      !evidence.oosValidated ? "Out-of-sample ainda não aprovado para esta configuração." : "",
      !evidence.walkForward.stable ? "Walk-forward ainda não estável para esta configuração." : "",
    );
    base.rejectionReasons = base.rejectionReasons.filter(Boolean);
    return base;
  }
  if (base.marketDrift === "OUT_OF_DISTRIBUTION" || base.marketDrift === "HIGH_DRIFT") {
    base.rejectionReasons.push(`Mercado fora da distribuição da base (${base.marketDrift}).`);
    return base;
  }
  if (evidence.health.health === "SUSPENDED") {
    base.decision = "REJECT";
    base.rejectionReasons.push(evidence.health.reason);
    return base;
  }

  // Confirmada: preços REAIS do plano congelado + dimensionamento por risco.
  const plan = analysis.plan;
  const direction = analysis.direction as "COMPRA" | "VENDA";
  base.decision = direction === "COMPRA" ? "ENTER_LONG" : "ENTER_SHORT";
  base.entryPrice = plan.entry;
  base.stopPrice = plan.stop;
  base.partialPrice = plan.target1;
  base.targetPrice = plan.target2;
  base.riskPoints = plan.stopDistance;
  base.rewardPoints = Math.abs(plan.target2 - plan.entry);
  base.riskRewardRatio = plan.riskRewardPlan;
  base.decisionReasons.push(
    `${similar.length} ocorrências semelhantes na base (${analysis.strategyVersion}).`,
    ...evidence.reasons,
    `Regime compatível: ${analysis.regime.regime}.`,
    `Deriva de mercado: ${base.marketDrift}.`,
  );
  const sizing = computeRecommendedContracts({
    direction,
    entry: plan.entry,
    stop: plan.stop,
    instrument: input.instrument,
    config: input.riskConfig,
    currentDrawdownR: input.currentDrawdownR ?? 0,
    dailyLossR: input.dailyLossR ?? 0,
  });
  base.recommendedContracts = sizing.recommendedContracts;
  base.decisionReasons.push(...sizing.reasons);
  return base;
}

// ---------------------------------------------------------------------------
// EntryStateMachine (§55–§56)
// ---------------------------------------------------------------------------

export type EntryState =
  | "SCANNING"
  | "POTENTIAL"
  | "WAITING_CONFIRMATION"
  | "CONFIRMED"
  | "INVALIDATED"
  | "MANAGING"
  | "FINISHED";

export interface FrozenEntry {
  confirmedEntryPrice: number;
  confirmedAt: number;
  stopPrice: number;
  partialPrice: number;
  targetPrice: number;
  strategyVersion: string;
  candidateId: string;
}

/**
 * Evita CONFIRMOU/DESCONFIRMOU a cada tick: depois de CONFIRMED, somente uma
 * REGRA OBJETIVA (preço além da invalidação) muda o estado. Ao confirmar, os
 * preços congelam (§56) e não acompanham novas análises.
 */
export class EntryStateMachine {
  private state: EntryState = "SCANNING";
  private frozen: FrozenEntry | null = null;

  current(): EntryState {
    return this.state;
  }

  frozenEntry(): FrozenEntry | null {
    return this.frozen;
  }

  /** Alimenta a máquina com a decisão do motor. Ignorada após CONFIRMED. */
  onDecision(decision: DecisionObject): EntryState {
    if (this.state === "CONFIRMED" || this.state === "MANAGING" || this.state === "FINISHED") {
      return this.state; // §55: decisão nova NÃO desconfirma — só regra objetiva.
    }
    if (decision.decision === "ENTER_LONG" || decision.decision === "ENTER_SHORT") {
      if (
        decision.entryPrice !== null &&
        decision.stopPrice !== null &&
        decision.partialPrice !== null &&
        decision.targetPrice !== null &&
        decision.candidateId !== null
      ) {
        this.frozen = Object.freeze({
          confirmedEntryPrice: decision.entryPrice,
          confirmedAt: decision.timestamp,
          stopPrice: decision.stopPrice,
          partialPrice: decision.partialPrice,
          targetPrice: decision.targetPrice,
          strategyVersion: decision.strategyVersion,
          candidateId: decision.candidateId,
        });
        this.state = "CONFIRMED";
      }
    } else if (decision.decision === "WAIT") {
      this.state = decision.candidateId ? "WAITING_CONFIRMATION" : "SCANNING";
    } else if (decision.decision === "REJECT") {
      this.state = decision.candidateId ? "POTENTIAL" : "SCANNING";
    }
    return this.state;
  }

  /** Regra objetiva: preço fechou além do stop congelado => INVALIDATED. */
  onPrice(close: number, direction: "COMPRA" | "VENDA"): EntryState {
    if (this.state !== "CONFIRMED" && this.state !== "MANAGING") return this.state;
    const frozen = this.frozen!;
    const invalidated =
      direction === "COMPRA" ? close < frozen.stopPrice : close > frozen.stopPrice;
    if (invalidated) this.state = "INVALIDATED";
    else if (this.state === "CONFIRMED") {
      const entered =
        direction === "COMPRA"
          ? close <= frozen.confirmedEntryPrice
          : close >= frozen.confirmedEntryPrice;
      if (entered) this.state = "MANAGING";
    }
    return this.state;
  }

  finish(): void {
    if (this.state === "MANAGING") this.state = "FINISHED";
  }

  reset(): void {
    this.state = "SCANNING";
    this.frozen = null;
  }
}

// ---------------------------------------------------------------------------
// HistoricalDuplicateDetector (§25, §81)
// ---------------------------------------------------------------------------

/** Assinatura estável da operação: regravar o mesmo período não duplica caso. */
export function tradeSignature(trade: BacktestTrade): string {
  const bucket = Math.max(1e-9, Math.abs(trade.entry - trade.stop) / 4);
  const q = (v: number) => Math.round(v / bucket);
  return [
    trade.asset,
    trade.direction,
    trade.setupId,
    q(trade.entry),
    q(trade.stop),
    q(trade.target1),
  ].join("|");
}

export function dedupeTrades(
  existing: BacktestTrade[],
  incoming: BacktestTrade[],
): { unique: BacktestTrade[]; duplicates: BacktestTrade[] } {
  const seen = new Set(existing.map(tradeSignature));
  const unique: BacktestTrade[] = [];
  const duplicates: BacktestTrade[] = [];
  for (const trade of incoming) {
    const signature = tradeSignature(trade);
    if (seen.has(signature)) {
      duplicates.push(trade);
      continue;
    }
    seen.add(signature);
    unique.push(trade);
  }
  return { unique, duplicates };
}
