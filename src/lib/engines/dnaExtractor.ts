/**
 * ADAPTADOR DNA → TRADE. A classificação NÃO vive aqui.
 *
 * A primeira versão deste arquivo classificava sozinha — e classificava
 * errado: lia `analysis.features` (campo que não existe no AnalysisResult;
 * o `as any` escondia isso do compilador), o que zerava a tendência e
 * carimbava TODA operação como CONTRA_TENDÊNCIA; gravava `stopDistanceR = 1`
 * constante; fixava a 1ª T4 com um TODO; e datava a classificação com
 * `Date.now()`, que nunca representa tempo de mercado.
 *
 * A classificação real, determinística e testada, mora em `@/lib/t4/dna`.
 * Este arquivo só traduz o `SetupDna` para os campos consultáveis do
 * `BacktestTrade` — UM vocabulário, duas projeções.
 */

import type { Candle } from "./types";
import type { AnalysisResult } from "./types";
import type { BacktestTrade } from "./backtestEngine";
import { dnaFromAnalysis, type DnaOrigin, type SetupDna } from "@/lib/t4/dna";

export interface DnaExtractionContext {
  /** Candles fechados ATÉ o instante da decisão. Sem eles, as dimensões
   * geométricas saem NAO_IDENTIFICADO — honestas, nunca inventadas. */
  window?: Candle[];
  /** Instantes dos setups anteriores na mesma direção, no mesmo pregão. */
  priorSameDirectionAt?: number[];
  origin?: DnaOrigin;
  sourceId?: string;
  dnaId?: string;
  asset?: string;
}

/** Campos DNA do trade a partir de um SetupDna já classificado. */
export function dnaTradeFields(dna: SetupDna): Partial<BacktestTrade> {
  return {
    quality: dna.grade,
    trendStrength: dna.trend,
    positionVsTrend: dna.position,
    pullbackType: dna.pullback,
    // Unidade: R — impulso anterior dividido pela distância do stop.
    impulseStrength: dna.impulseR ?? undefined,
    location: dna.location,
    triggerCandle: dna.triggerCandle,
    t4NumberInMove: dna.movementOrdinal ?? undefined,
    volatilityLevel: dna.volatility ?? undefined,
    stopDistancePoints: dna.stopDistancePoints ?? undefined,
    // Instante de MERCADO da decisão — a prova de que a classificação veio
    // antes do desfecho é o próprio `t` da análise congelada.
    classifiedAt: dna.detectedAt,
    dnaId: dna.id,
  };
}

/**
 * Extrai o DNA de uma análise no instante da decisão.
 *
 * Sem plano ou com direção NEUTRA devolve objeto vazio: um trade sem DNA é
 * um dado incompleto declarado; um trade com DNA fabricado é mentira com
 * cara de estatística.
 */
export function extractDNA(
  analysis: AnalysisResult,
  context: DnaExtractionContext = {},
): Partial<BacktestTrade> {
  const dna = dnaFromAnalysis(analysis, {
    id: context.dnaId ?? `dna_${analysis.t}_${analysis.direction}`,
    origin: context.origin ?? "REPLAY",
    sourceId: context.sourceId ?? "sem-sessao",
    asset: context.asset ?? "WINFUT",
    window: context.window ?? [],
    priorSameDirectionAt: context.priorSameDirectionAt ?? [],
    techniqueVersion: analysis.versions.strategyVersion,
  });
  if (dna === null) return {};
  return dnaTradeFields(dna);
}

/** Reexportado para quem congela o DNA no armamento e o entrega ao trade. */
export { dnaFromAnalysis };
export type { SetupDna };
