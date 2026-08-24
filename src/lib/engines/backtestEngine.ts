import { assetConfig } from "@/lib/t4/assets";
import { liquidarOperacao } from "@/lib/t4/costs";
import type { AnalysisResult, Direction } from "./types";
import { extractDNA } from "./dnaExtractor";

export type TradeOrigin = "LIVE" | "LIVE_REPLAY" | "VIDEO_REPLAY" | "BACKTEST" | "LEGACY_IMAGE";

/**
 * A GESTÃO DA T4 É DE TRÊS CONTRATOS (parcial 3R / alvo 5R / runner — os
 * terços de strategy.ts). O custo da operação é liquidado sobre essa gestão.
 * `costR` independe do número de contratos (custo e risco escalam juntos);
 * `costsBrl`/`resultBrl` dependem, e este é o número declarado da técnica.
 */
export const T4_CONTRACTS = 3;

export interface BacktestTrade {
  id: string;
  setupId: string;
  strategyVersion: string;
  asset: string;
  timeframe: "1m";
  /** Instante da decisão; útil para auditoria anti-look-ahead. */
  signalAt?: number;
  /** Instante real/simulado de execução da entrada. */
  openedAt: number;
  closedAt: number;
  entryHitAt?: number | null;
  partialHitAt?: number | null;
  exitAt?: number | null;
  direction: Exclude<Direction, "NEUTRO">;
  setup: string;
  context: string;
  entry: number;
  stop: number;
  target1: number;
  target2: number;
  riskReward: number;
  reversalRisk: number;
  exit: number;
  result: "GANHO" | "PERDA" | "NEUTRO";
  rMultiple: number;
  mfePoints: number | null;
  maePoints: number | null;
  mfeR: number | null;
  maeR: number | null;
  exitReason?: string | null;
  ambiguousIntrabar?: boolean;
  tradingDate?: string | null;
  /** IDs das técnicas detectadas no snapshot da decisão. */
  techniqueIds?: string[];
  /** Versão do detector usada para cada técnica no instante da decisão. */
  techniqueDetectorVersions?: Record<string, string>;
  /** Versão da técnica de produção congelada para esta decisão/sessão. */
  productionTechniqueVersion?: string;
  /** @deprecated Compatibilidade com registros anteriores; prefira techniqueIds. */
  techniques?: string[];
  hour: number;
  wyckoffPhase: string;
  poiKind: string;
  regime: string;
  /** Identificador da captura/sessão contínua que originou o trade. */
  sourceCaptureId: string;
  /** Segmento cronológico da gravação/replay, quando disponível. */
  segmentId?: string | null;
  /** Sessão/pregão persistente, quando disponível. */
  tradingSessionId?: string | null;
  origin: TradeOrigin;
  /** Snapshot congelado: dados futuros nunca recalculam esta decisão. */
  frozenAnalysis: AnalysisResult;

  // === DNA T4 ===
  // Vocabulário ÚNICO: os enums de @/lib/t4/dna. A classificação acontece no
  // instante da decisão (idealmente congelada no ARMAMENTO, junto com a
  // análise) e nunca é reescrita depois que o resultado aparece.
  /** Id do registro em `setup_dna` — o mesmo DNA, na tabela de detecções. */
  dnaId?: string;
  quality?: import("@/lib/t4/dna").DnaGrade;
  trendStrength?: import("@/lib/t4/dna").DnaTrend;
  positionVsTrend?: import("@/lib/t4/dna").DnaPosition;
  pullbackType?: import("@/lib/t4/dna").DnaPullback;
  /** Força do impulso anterior em R (impulso ÷ distância do stop). */
  impulseStrength?: number;
  location?: import("@/lib/t4/dna").DnaLocation;
  triggerCandle?: import("@/lib/t4/dna").DnaTrigger;
  /** 1ª, 2ª, 3ª T4 do movimento; 4 = posterior. Ausente quando não computável. */
  t4NumberInMove?: number;
  volatilityLevel?: import("@/lib/t4/dna").DnaVolatility;
  /** Distância do stop em PONTOS (em R ela é 1 por definição). */
  stopDistancePoints?: number;
  /** Resultado em R$ — preenchido no DESFECHO, nunca na classificação. */
  resultBrl?: number;
  /** Custos totais em R$ — preenchido no desfecho. */
  costsBrl?: number;
  /** Slippage em pontos — preenchido no desfecho. */
  slippagePoints?: number;
  /**
   * Custo da operação em MÚLTIPLOS DE R — o número que a expectância líquida
   * consome (`netAfterCostsR = rMultiple − costR`). Null = custo não
   * conversível (ativo sem config ou risco zero) — NUNCA zero: custo
   * desconhecido não é custo inexistente. `rMultiple` permanece BRUTO.
   */
  costR?: number | null;
  /** URL/path do print original vinculado, quando houver. */
  printUrl?: string;
  /** Análise/overlay como texto estruturado, quando houver. */
  analysisText?: string;
  /** Instante de MERCADO da classificação (= t da análise congelada). */
  classifiedAt?: number;
}

export function createBacktestTrade(input: {
  analysis: AnalysisResult;
  asset: string;
  sourceCaptureId: string;
  segmentId?: string | null;
  tradingSessionId?: string | null;
  origin?: TradeOrigin;
  closedAt: number;
  entryHitAt?: number | null;
  partialHitAt?: number | null;
  exitAt?: number | null;
  exit: number;
  result: BacktestTrade["result"];
  rMultiple: number;
  mfeMae?: {
    mfePoints: number;
    maePoints: number;
    mfeR: number | null;
    maeR: number | null;
  } | null;
  exitReason?: string | null;
  ambiguousIntrabar?: boolean;
  tradingDate?: string | null;
  techniqueIds?: string[];
  techniqueDetectorVersions?: Record<string, string>;
  productionTechniqueVersion?: string;
  /** @deprecated Compatibilidade de chamada antiga. */
  techniques?: string[];
  /**
   * DNA congelado no ARMAMENTO (com a janela de candles daquele instante).
   * Quando o chamador não o tem, a extração roda aqui sobre a análise
   * congelada — sem janela, as dimensões geométricas saem NAO_IDENTIFICADO.
   */
  dna?: Partial<BacktestTrade>;
}): BacktestTrade | null {
  const { analysis } = input;
  if (!analysis.plan || analysis.direction === "NEUTRO") return null;

  const dna =
    input.dna ??
    extractDNA(analysis, {
      asset: input.asset,
      origin: input.origin === "LIVE" ? "LIVE" : "REPLAY",
      sourceId: input.sourceCaptureId,
    });

  return {
    id: `trade_${analysis.t}_${input.closedAt}`,
    setupId: `T4|${analysis.t4.setup}|${analysis.regime.regime}`,
    strategyVersion: analysis.strategyVersion,
    asset: input.asset,
    timeframe: "1m",
    signalAt: analysis.t,
    openedAt: input.entryHitAt ?? analysis.t,
    closedAt: input.exitAt ?? input.closedAt,
    entryHitAt: input.entryHitAt ?? null,
    partialHitAt: input.partialHitAt ?? null,
    exitAt: input.exitAt ?? input.closedAt,
    direction: analysis.direction,
    setup:
      analysis.t4.setup !== "NONE"
        ? analysis.t4.setup
        : analysis.wyckoff.events.join("+") || analysis.wyckoff.schema,
    context: analysis.marketState,
    entry: analysis.plan.entry,
    stop: analysis.plan.stop,
    target1: analysis.plan.target1,
    target2: analysis.plan.target2,
    riskReward: analysis.plan.riskRewardPlan,
    reversalRisk: analysis.risk.reversalRisk,
    exit: input.exit,
    result: input.result,
    rMultiple: input.rMultiple,
    mfePoints: input.mfeMae?.mfePoints ?? null,
    maePoints: input.mfeMae?.maePoints ?? null,
    mfeR: input.mfeMae?.mfeR ?? null,
    maeR: input.mfeMae?.maeR ?? null,
    exitReason: input.exitReason ?? null,
    ambiguousIntrabar: input.ambiguousIntrabar ?? false,
    tradingDate: input.tradingDate ?? null,
    techniqueIds: input.techniqueIds ?? input.techniques ?? [],
    techniqueDetectorVersions: input.techniqueDetectorVersions ?? {},
    productionTechniqueVersion: input.productionTechniqueVersion ?? analysis.strategyVersion,
    techniques: input.techniques ?? input.techniqueIds ?? [],
    regime: analysis.regime?.regime ?? "UNCLEAR",
    hour: new Date(analysis.t).getHours(),
    wyckoffPhase: analysis.wyckoff.phase ?? "indefinida",
    poiKind: analysis.mainPoi?.kind ?? "sem_poi",
    sourceCaptureId: input.sourceCaptureId,
    segmentId: input.segmentId ?? null,
    tradingSessionId: input.tradingSessionId ?? null,
    origin: input.origin ?? "BACKTEST",
    frozenAnalysis: structuredClone(analysis),
    // O DNA entra por spread: só contém campos de DNA por construção, e a
    // lista não precisa ser reescrita a cada dimensão nova.
    ...dna,
    // A LIQUIDAÇÃO entra por último: são campos de DESFECHO (o trade acabou
    // de fechar) e não podem ser sobrepostos por um DNA congelado antigo.
    ...liquidacaoDoTrade(input.asset, analysis.plan.entry, analysis.plan.stop, input.rMultiple),
  };
}

/**
 * CUSTOS NO FECHAMENTO — EM TODOS OS CAMINHOS (auditoria sênior, BLOCO 5).
 *
 * `liquidarOperacao` existia com teste verde e ZERO chamadas em runtime:
 * `costs_brl`, `result_brl` e `slippage_points` chegavam SEMPRE null ao banco,
 * e `netAfterCostsR` — o número que decide se a técnica pode operar — nunca
 * saía do null. Ligar aqui, dentro de `createBacktestTrade`, cobre os três
 * criadores de trade de uma vez (ao vivo/observação, replay de vídeo por
 * sessão e quant) — a alternativa, três chamadas espalhadas, é o padrão que a
 * auditoria acabou de condenar.
 *
 * CUSTO DESCONHECIDO É NULL, NUNCA ZERO: ativo sem configuração ou risco
 * não conversível devolve todos os campos null e o rastro `liquido:false`
 * fica implícito na ausência — nenhuma estatística pode somar esse trade
 * como se o custo fosse zero.
 */
function liquidacaoDoTrade(
  asset: string,
  entry: number,
  stop: number,
  grossR: number,
): Partial<
  Pick<BacktestTrade, "stopDistancePoints" | "resultBrl" | "costsBrl" | "slippagePoints" | "costR">
> {
  const stopDistancePoints = Math.abs(entry - stop);
  const config = assetConfig(asset);
  if (config === null || !(stopDistancePoints > 0) || !Number.isFinite(grossR)) {
    // Nada de chave com `undefined` explícito: sobreporia o que o DNA
    // congelado já mediu. Só o costR sai declarado como desconhecido.
    return { costR: null };
  }
  const liq = liquidarOperacao({
    config,
    grossR,
    stopDistancePoints,
    contracts: T4_CONTRACTS,
    // Cada contrato entra uma vez e sai uma vez: 3 contratos ⇒ 6 pernas.
    exitLegs: 1,
  });
  return {
    stopDistancePoints,
    resultBrl: liq.resultBrl ?? undefined,
    costsBrl: liq.costsBrl,
    slippagePoints: liq.slippagePoints,
    costR: liq.cost.costR,
  };
}
