/** Tipos compartilhados pelo analisador visual Wyckoff V4. */
import type { PriceActionRead } from "./priceActionEngine";

export type Direction = "COMPRA" | "VENDA" | "NEUTRO";

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** A captura visual não conhece volume: permanece sempre zero. */
  v: number;
}

export type MarketState =
  | "Tendência Compradora"
  | "Tendência Vendedora"
  | "Range"
  | "Acumulação"
  | "Distribuição"
  | "Reacumulação"
  | "Redistribuição"
  | "Breakout"
  | "Pullback"
  | "Reteste"
  | "Exaustão"
  | "Possível Reversão"
  | "Indefinido";

export type WyckoffEvent =
  "PS" | "SC" | "AR" | "ST" | "Spring" | "Test" | "SOS" | "LPS" | "UT" | "UTAD" | "SOW" | "LPSY";

export interface WyckoffRead {
  schema: "Acumulação" | "Distribuição" | "Indefinido";
  phase: "A" | "B" | "C" | "D" | "E" | null;
  events: WyckoffEvent[];
  confidence: number;
  label: string;
}

export type LiquidityKind = "compradora" | "vendedora";
export type LiquidityOrigin =
  | "topo_anterior"
  | "fundo_anterior"
  | "topo_igual"
  | "fundo_igual"
  | "maxima_dia_anterior"
  | "minima_dia_anterior"
  | "maxima_sessao"
  | "minima_sessao"
  | "abertura_dia"
  | "extremo_range"
  | "gap";
export type LiquidityStatus =
  | "disponivel"
  | "aproximada"
  | "tocada"
  | "varrida"
  | "rompida_com_aceitacao"
  | "falso_rompimento"
  | "rejeitada"
  | "capturada_com_reversao";

export interface LiquidityLevel {
  id: string;
  price: number;
  kind: LiquidityKind;
  origin: LiquidityOrigin;
  testCount: number;
  formedAt: number;
  ageBars: number;
  relevance: number;
  status: LiquidityStatus;
  internal: boolean;
}

export type LiquidityEventType =
  | "aproximacao"
  | "toque"
  | "varredura"
  | "rompimento_aceitacao"
  | "falso_rompimento"
  | "rejeicao"
  | "captura_reversao";

export interface LiquidityEventRead {
  t: number;
  levelId: string;
  type: LiquidityEventType;
  direction: Direction;
}

export interface LiquidityMap {
  levels: LiquidityLevel[];
  nearestBuy: LiquidityLevel | null;
  nearestSell: LiquidityLevel | null;
  lastEvent: LiquidityEventRead | null;
  events: LiquidityEventRead[];
}

export type POIKind =
  | "spring"
  | "test"
  | "lps"
  | "lpsy"
  | "ut"
  | "utad"
  | "origem_deslocamento"
  | "suporte_resistencia"
  | "rompimento_reteste"
  | "fvg"
  | "extremo_range";
export type POICondition = "novo" | "testado" | "mitigado" | "invalidado";

export interface POI {
  id: string;
  kind: POIKind;
  upper: number;
  lower: number;
  direction: Direction;
  originAt: number;
  testCount: number;
  condition: POICondition;
  strength: number;
  reasons: string[];
  invalidation: number;
  nearbyLiquidityId: string | null;
  wyckoffRelation: string;
}

/** Confirmações internas da captura. Não são estratégias independentes. */
export type HSSStage =
  "nenhum" | "varredura" | "rejeicao" | "deslocamento" | "confirmado" | "invalidado";
export interface HSSRead {
  detected: boolean;
  direction: Direction | null;
  stage: HSSStage;
  sweptLevelId: string | null;
  sweepExtreme: number | null;
  rejection: number;
  displacement: number;
  structuralConfirmation: boolean;
  returnedToPOI: boolean;
  invalidation: number | null;
  confidence: number;
  label: string;
}

export interface SMSRead {
  confirmed: boolean;
  pending: boolean;
  direction: Direction | null;
  brokenLevel: number | null;
  displacement: number;
  closeConfirmed: boolean;
  liquidityDefended: boolean;
  reactionConfirmed: boolean;
  structureFormed: boolean;
  retestExpected: boolean;
  confidence: number;
  invalidation: number | null;
  label: string;
}

export interface LiquidityCaptureDetail {
  levelId: string | null;
  type: LiquidityEventType | "invalidacao" | null;
  price: number | null;
  side: LiquidityKind | null;
  at: number | null;
  strength: number;
  sweepDepth: number | null;
  rejection: number;
  recovery: boolean;
  displacement: number;
  closeConfirmed: boolean;
  status: "sem_captura" | "em_formacao" | "capturada_valida" | "invalidada";
}

export interface LiquidityCaptureResult {
  valid: boolean;
  direction: Direction | null;
  detail: LiquidityCaptureDetail;
  quality: number;
  isAcceptedBreakoutOnly: boolean;
}

export interface DataQuality {
  quality: number;
  issues: string[];
}

export interface ReadingState {
  /**
   * SUFICIÊNCIA ESTRUTURAL — geometria, quantidade e qualidade dos candles.
   * NÃO depende da calibração da escala: gráfico visível = leitura ativa.
   */
  sufficient: boolean;
  timeframeConfirmed: boolean;
  /**
   * Estado INDEPENDENTE da conversão pixel→preço. False = estrutura é lida
   * normalmente, mas nenhum preço exato (entrada/stop/parcial/alvo) é confiável.
   */
  priceScaleReady: boolean;
  calibrationConfidence: number;
  candleQuality: number;
  closedCandles: number;
  lastCandleClosed: boolean;
  issues: string[];
  label: string;
}

export interface RiskRead {
  reversalRisk: number;
  stopQuality: number;
  targetRoom: number;
  riskReward: number;
  factors: { label: string; value: number }[];
  qualityFactors: { label: string; value: number; note?: string }[];
}

export interface TradePlan {
  direction: Direction;
  entry: number;
  stop: number;
  target1: number;
  target2: number;
  riskReward: number;
  riskRewardFinal: number;
  riskRewardPlan: number;
  stopDistance: number;
  mode: "ENTRADA DIRETA PROVÁVEL" | "AGUARDANDO RETESTE";
  entryPoiId: string | null;
  targetLiquidityPrice: number | null;
}

export type TechnicalEvidenceState = "confirmada" | "parcial" | "ausente" | "invalidada";
export type TechnicalEvidenceGroup =
  "estrutura" | "captura_liquidez" | "poi_reteste" | "contexto_wyckoff" | "risco_retorno";

/**
 * Evidência técnica auditável. Não existe soma, nota agregada ou faixa
 * percentual: cada evidência descreve somente o que foi observado.
 */
export interface TechnicalEvidence {
  id: string;
  label: string;
  group: TechnicalEvidenceGroup;
  state: TechnicalEvidenceState;
  occurredAt: number | null;
  chartRegion: string;
  visualQuality: number;
  measuredValue: number | null;
  justification: string;
}

export interface AnalysisResult {
  t: number;
  strategyVersion: string;
  price: number;
  direction: Direction;
  /** Setup técnico completo antes da validação estatística histórica. */
  technicalReady: boolean;
  reason: string;
  blockers: string[];
  reading: ReadingState;
  priceAction: PriceActionRead;
  wyckoff: WyckoffRead;
  marketState: MarketState;
  /** Regime objetivo (spec V5 §20). */
  regime: import("./regimeEngine").RegimeRead;
  /** Contradições do motor adversarial (spec V5 §18–§19). */
  contradictions: import("./contradictionEngine").Contradiction[];
  /** Sequência causal (spec §23–§25) — incompleta = WAIT. */
  sequence: import("./causalSequence").CausalSequenceRead;
  /** Contexto de volatilidade (spec §30) — sinaliza, não bloqueia. */
  volatility: import("./marketBehavior").VolatilityContext | null;
  /** Leitura categórica da técnica T4; não é score 0–100. */
  t4: import("./t4Engine").T4Read;
  /** Versão da técnica usada nesta leitura. */
  versions: { strategyVersion: string };
  risk: RiskRead;
  plan: TradePlan | null;
  liquidity: LiquidityMap;
  mainPoi: POI | null;
  pois: POI[];
  internalConfirmation: { capture: LiquidityCaptureResult; sms: SMSRead };
  evidences: TechnicalEvidence[];
  explanation: string;
}

export interface ChatEntry {
  t: number;
  text: string;
  tone: "info" | "bull" | "bear" | "warn" | "alert";
}

export type { PriceActionRead } from "./priceActionEngine";
