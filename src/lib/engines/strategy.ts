/**
 * T4 — técnica de produção estudada para WIN 1m.
 *
 * Princípios imutáveis:
 * - leitura causal em candle fechado; replay e ao vivo usam o MESMO analyze();
 * - stop vem da invalidação estrutural, nunca é encurtado para "caber" no RR;
 * - entrada só existe quando há espaço técnico real >= 3R;
 * - 3 contratos: parcial em 3R, segundo alvo em 5R e terceiro contrato runner;
 * - aprendizado diário gera candidatas de laboratório, nunca altera uma sessão em andamento.
 */
import { resolveInstrument } from "./instruments";

export const STRATEGY_VERSION = "T4.0.0";
export const STRATEGY_NAME = "T4";

/** Corte global; módulos T4 podem exigir risco ainda menor. */
export const MAX_REVERSAL_RISK = 45;

export const MIN_RISK_REWARD_PARTIAL = 3;
export const MIN_RISK_REWARD_FINAL = 3;
export const MIN_RISK_REWARD_PLAN = 3;
export const MIN_RISK_REWARD = MIN_RISK_REWARD_PLAN;

/**
 * Fração realizada na parcial do MODO LEGADO de 2 alvos (60% na parcial,
 * 40% ao alvo final). Usada pelo rastreador/replay sem runner e pelo rrPlan.
 * NÃO é a gestão T4 — para os três contratos T4, use as frações abaixo.
 */
export const PARTIAL_EXIT_FRACTION = 0.6;

/** Gestão T4 para três WIN: 1 contrato em cada perna (3R, 5R, runner). */
export const FIRST_EXIT_FRACTION = 1 / 3;
export const SECOND_EXIT_FRACTION = 1 / 3;
export const RUNNER_EXIT_FRACTION = 1 / 3;
export const PROTECT_AFTER_R = 3.5;
export const PROFIT_LOCK_R = 0.25;
export const RUNNER_TRAIL_START_R = 5;

export type StopMethod = "combinado" | "somente_atr";
export interface RiskParams {
  stopMethod: StopMethod;
  tickSize: number;
  minStopDistance: number;
  maxStopDistance: number;
  partialTargetMultiple: number;
  finalTargetMultiple: number;
}

export const DEFAULT_RISK_PARAMS: RiskParams = {
  stopMethod: "combinado",
  tickSize: 0,
  minStopDistance: 0,
  maxStopDistance: Number.POSITIVE_INFINITY,
  partialTargetMultiple: 3,
  finalTargetMultiple: 5,
};

/**
 * PARÂMETROS DE RISCO JÁ COM O TICK DO ATIVO.
 *
 * POR QUE ELA EXISTE: `DEFAULT_RISK_PARAMS.tickSize` é 0, e `roundToTick`
 * devolve o preço CRU quando o tick não é positivo. Ou seja, todo caminho que
 * chama `analyze()` sem passar `riskParams` publica entrada, stop e alvos fora
 * do tick do contrato — "entrada 139.237" num WIN que só negocia de 5 em 5.
 * O número sai plausível na tela, o operador digita no book e a corretora
 * arredonda por conta própria: o plano executado deixa de ser o plano medido.
 *
 * O tick é a ÚNICA coisa que esta função sobrescreve. Método do stop, distância
 * mínima/máxima e múltiplos de alvo são decisão da técnica (ou do laboratório,
 * quando ele passa uma base própria) e não têm nada a ver com o contrato.
 *
 * Ativo desconhecido devolve a base INALTERADA — `resolveInstrument` já se
 * recusa a inventar tick, e inventar aqui seria o mesmo defeito com outro nome.
 */
export function riskParamsForAsset(
  asset: string,
  base: RiskParams = DEFAULT_RISK_PARAMS,
): RiskParams {
  const instrument = resolveInstrument(asset);
  if (instrument === null) return base;
  return { ...base, tickSize: instrument.tickSize };
}

export const T4_PROFILE = {
  name: STRATEGY_NAME,
  version: STRATEGY_VERSION,
  timeframe: "1m",
  contracts: 3,
  minimumRiskReward: 3,
  management: {
    firstContractR: 3,
    secondContractR: 5,
    thirdContract: "STRUCTURAL_RUNNER",
    protectAfterR: PROTECT_AFTER_R,
    profitLockR: PROFIT_LOCK_R,
    runnerTrailStartR: RUNNER_TRAIL_START_R,
  },
  productionFamilies: [
    "TREND_FIRST_PULLBACK",
    "RANGE_SWEEP",
    "FAILED_BREAKOUT",
    "PHASE_RESET",
    "EXPANSION_RETEST",
    "HSS_CAPTURE",
  ],
  guards: [
    "DIRECTION_SANITY",
    "OVEREXTENSION_BLOCK",
    "FAKE_CONTINUATION_DETECTOR",
    "LOSS_RESET",
    "REAL_3R_SPACE",
    "NO_MIDDLE_RANGE",
  ],
  qualityTargets: {
    minTradeDaysPerMonth: 12,
    preferredTradeDaysPerMonth: [14, 18],
    minProfitFactor: 3,
    maxDrawdownR: 5,
    minimumRiskReward: 3,
  },
  dailyLearning: {
    enabled: true,
    learnOnNoTradeDay: true,
    productionMutationDuringSession: false,
    applyValidatedChangeOnlyNextSession: true,
    pipeline: [
      "DAILY_REVIEW",
      "SHADOW",
      "BACKTEST",
      "OOS",
      "WALK_FORWARD",
      "VALIDATED",
      "EXPLICIT_PROMOTION",
    ],
  },
} as const;

export function roundToTick(price: number, tickSize: number): number {
  if (!Number.isFinite(tickSize) || tickSize <= 0) return price;
  return Math.round(price / tickSize) * tickSize;
}

export const READING_GATES = {
  minCalibrationConfidence: 60,
  minCandleReadQuality: 55,
  minClosedCandles: 14,
} as const;

/** Parâmetros internos da sequência varredura → rejeição → deslocamento. */
export const HSS_CONFIG = {
  rejectionWindowBars: 4,
  minRejectionWick: 0.32,
  minDisplacement: 0.32,
  poiReturnAtr: 0.6,
  invalidationBufferAtr: 0.15,
  minConfidence: 45,
} as const;

/** SMS/CHoCH é confirmação interna da técnica, nunca uma estratégia separada. */
export const SMS_CONFIG = {
  minDisplacement: 0.3,
  minBreakBodyRatio: 0.4,
  minVolumeRatio: 0,
  minConfidence: 55,
} as const;

export const LIQUIDITY_CONFIG = {
  lookbackBars: 120,
  equalLevelToleranceAtr: 0.18,
  approachAtr: 1.2,
  touchAtr: 0.15,
  minRelevance: 30,
  maxLevels: 14,
} as const;

export const POI_CONFIG = {
  minStrengthForSignal: 55,
  maxPois: 10,
} as const;

export const ENTRY_CHASE_TOLERANCE_ATR = 1.2;
