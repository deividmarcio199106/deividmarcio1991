import type { BacktestTrade } from "@/lib/engines/backtestEngine";
import { computeStats, type PerformanceStats } from "@/lib/engines/performanceEngine";
import { TECHNIQUE_LIBRARY, type Technique } from "./techniqueLibrary";

/**
 * ESTATÍSTICA POR TÉCNICA (comando de expansão, Parte 2).
 *
 * Cada técnica da biblioteca é validada INDIVIDUALMENTE contra os trades que
 * a carregam (campo `techniques` gravado na detecção). Gate de amostra mínima:
 * abaixo de 30 casos o veredito é AMOSTRA INSUFICIENTE — nunca uma taxa
 * "promissora" sobre meia dúzia de operações.
 */

export const TECHNIQUE_MIN_SAMPLE = 30;

export type TechniqueVerdict = "VALIDADA" | "NAO_VALIDADA" | "AMOSTRA_INSUFICIENTE";

export interface TechniqueStatsRow {
  technique: Technique;
  sample: number;
  stats: PerformanceStats | null;
  verdict: TechniqueVerdict;
  reason: string;
}

export function techniqueStats(trades: BacktestTrade[]): TechniqueStatsRow[] {
  return TECHNIQUE_LIBRARY.map((technique) => {
    const subset = trades.filter((trade) =>
      (trade.techniqueIds ?? trade.techniques ?? []).includes(technique.id),
    );
    if (technique.status !== "DETECTABLE") {
      return {
        technique,
        sample: subset.length,
        stats: null,
        verdict: "AMOSTRA_INSUFICIENTE" as const,
        reason:
          technique.status === "DISABLED"
            ? "Técnica desativada: não participa de detecção nem validação."
            : `Não detectável ainda: ${technique.requiredData.join("; ") || "dados indisponíveis."}`,
      };
    }
    if (subset.length < TECHNIQUE_MIN_SAMPLE) {
      return {
        technique,
        sample: subset.length,
        stats: subset.length > 0 ? computeStats(subset) : null,
        verdict: "AMOSTRA_INSUFICIENTE" as const,
        reason: `${subset.length}/${TECHNIQUE_MIN_SAMPLE} casos — continue alimentando o backtest.`,
      };
    }
    const stats = computeStats(subset);
    const validated = stats.expectancy > 0 && stats.profitFactor > 1;
    return {
      technique,
      sample: subset.length,
      stats,
      verdict: validated ? ("VALIDADA" as const) : ("NAO_VALIDADA" as const),
      reason: validated
        ? `Expectância ${stats.expectancy.toFixed(2)}R, PF ${stats.profitFactor.toFixed(2)} em ${subset.length} casos.`
        : `Sem vantagem estatística: expectância ${stats.expectancy.toFixed(2)}R, PF ${Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : "n/d"}.`,
    };
  });
}
