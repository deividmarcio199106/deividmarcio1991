import type { BacktestTrade } from "./backtestEngine";
import { computeStats, type PerformanceStats } from "./performanceEngine";

/**
 * Validação estatística da evidência (comando master §33–§43).
 *
 * Tudo aqui é determinístico: mesma amostra ⇒ mesmos números (o Monte Carlo
 * usa gerador com semente fixa). Nenhum estado representa "chance garantida
 * de vitória" — são graus de robustez da evidência histórica.
 */

export type EvidenceConfidence = "INSUFFICIENT" | "WEAK" | "MODERATE" | "STRONG" | "VERY_STRONG";

export const MIN_EVIDENCE_SAMPLE = 30;

/** §36: separação cronológica TRAIN/VALIDATION/TEST (60/20/20). */
export function splitChronological(trades: BacktestTrade[]): {
  train: BacktestTrade[];
  validation: BacktestTrade[];
  test: BacktestTrade[];
} {
  const ordered = [...trades].sort((a, b) => a.openedAt - b.openedAt);
  const trainEnd = Math.floor(ordered.length * 0.6);
  const validationEnd = Math.floor(ordered.length * 0.8);
  return {
    train: ordered.slice(0, trainEnd),
    validation: ordered.slice(trainEnd, validationEnd),
    test: ordered.slice(validationEnd),
  };
}

export interface WalkForwardWindow {
  trainSize: number;
  testSize: number;
  testExpectancy: number;
}

/** §37: janelas cronológicas — treina no passado, testa no futuro imediato. */
export function walkForward(
  trades: BacktestTrade[],
  folds = 4,
): { windows: WalkForwardWindow[]; stable: boolean } {
  const ordered = [...trades].sort((a, b) => a.openedAt - b.openedAt);
  if (ordered.length < folds * 8) return { windows: [], stable: false };
  const foldSize = Math.floor(ordered.length / folds);
  const windows: WalkForwardWindow[] = [];
  for (let i = 1; i < folds; i++) {
    const test = ordered.slice(i * foldSize, (i + 1) * foldSize);
    const stats = computeStats(test);
    windows.push({
      trainSize: i * foldSize,
      testSize: test.length,
      testExpectancy: stats.expectancy,
    });
  }
  const positive = windows.filter((w) => w.testExpectancy > 0).length;
  const catastrophic = windows.some((w) => w.testExpectancy < -0.5);
  return {
    windows,
    stable: windows.length > 0 && positive >= Math.ceil(windows.length / 2) && !catastrophic,
  };
}

/** Gerador determinístico (LCG) — Monte Carlo reprodutível, nunca Math.random. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export interface MonteCarloResult {
  runs: number;
  p95DrawdownR: number;
  worstStreakP95: number;
  fractionNegative: number;
}

/** §38: reordenações da sequência de resultados — risco de sequência, não previsão. */
export function monteCarlo(
  trades: BacktestTrade[],
  runs = 500,
  seed = 42,
): MonteCarloResult | null {
  if (trades.length < MIN_EVIDENCE_SAMPLE) return null;
  const rs = trades.map((trade) => trade.rMultiple);
  const random = seededRandom(seed);
  const drawdowns: number[] = [];
  const streaks: number[] = [];
  let negative = 0;
  for (let run = 0; run < runs; run++) {
    const shuffled = [...rs];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    let equity = 0;
    let peak = 0;
    let maxDd = 0;
    let streak = 0;
    let worstStreak = 0;
    for (const r of shuffled) {
      equity += r;
      peak = Math.max(peak, equity);
      maxDd = Math.max(maxDd, peak - equity);
      streak = r < 0 ? streak + 1 : 0;
      worstStreak = Math.max(worstStreak, streak);
    }
    drawdowns.push(maxDd);
    streaks.push(worstStreak);
    if (equity < 0) negative++;
  }
  drawdowns.sort((a, b) => a - b);
  streaks.sort((a, b) => a - b);
  const p95 = (values: number[]) =>
    values[Math.min(values.length - 1, Math.floor(values.length * 0.95))]!;
  return {
    runs,
    p95DrawdownR: Number(p95(drawdowns).toFixed(2)),
    worstStreakP95: p95(streaks),
    fractionNegative: Number((negative / runs).toFixed(3)),
  };
}

/** §40: sinais objetivos de overfitting — flags, nunca veredito automático. */
export function overfittingFlags(trades: BacktestTrade[]): string[] {
  const flags: string[] = [];
  const stats = computeStats(trades);
  if (trades.length < MIN_EVIDENCE_SAMPLE)
    flags.push(`Amostra pequena (${trades.length}/${MIN_EVIDENCE_SAMPLE}).`);
  if (stats.winRate > 88 && trades.length < 100)
    flags.push(`Resultado perfeito demais (${stats.winRate.toFixed(0)}% em ${trades.length} ops).`);
  const ordered = [...trades].sort((a, b) => a.openedAt - b.openedAt);
  if (ordered.length >= 10) {
    const span = ordered[ordered.length - 1]!.openedAt - ordered[0]!.openedAt;
    if (span > 0) {
      const firstFifthEnd = ordered[0]!.openedAt + span * 0.2;
      const concentrated =
        ordered.filter((t) => t.openedAt <= firstFifthEnd).length / ordered.length;
      if (concentrated > 0.6)
        flags.push(
          `Concentração temporal: ${(concentrated * 100).toFixed(0)}% dos casos em 20% do período.`,
        );
    }
  }
  const regimes = new Set(trades.map((t) => t.regime).filter(Boolean));
  if (trades.length >= MIN_EVIDENCE_SAMPLE && regimes.size === 1)
    flags.push(`Dependência de um único regime (${[...regimes][0]}).`);
  return flags;
}

export type StrategyHealth = "HEALTHY" | "WATCH" | "DECAYING" | "SUSPENDED";

/** §43: decadência — desempenho recente vs base, só com amostra mínima. */
export function decayHealth(
  trades: BacktestTrade[],
  recentN = 20,
): { health: StrategyHealth; reason: string } {
  if (trades.length < MIN_EVIDENCE_SAMPLE)
    return {
      health: "WATCH",
      reason: `Amostra ${trades.length}/${MIN_EVIDENCE_SAMPLE} — saúde não avaliável.`,
    };
  const ordered = [...trades].sort((a, b) => a.openedAt - b.openedAt);
  const base = computeStats(ordered);
  const recent = computeStats(ordered.slice(-recentN));
  if (recent.total < Math.min(recentN, 10))
    return {
      health: "HEALTHY",
      reason: "Sem operações recentes suficientes para medir decadência.",
    };
  const delta = recent.expectancy - base.expectancy;
  if (recent.expectancy < -0.35 && delta < -0.35)
    return {
      health: "SUSPENDED",
      reason: `Expectância recente ${recent.expectancy.toFixed(2)}R desabou vs base ${base.expectancy.toFixed(2)}R.`,
    };
  if (delta < -0.25)
    return {
      health: "DECAYING",
      reason: `Expectância recente ${recent.expectancy.toFixed(2)}R abaixo da base ${base.expectancy.toFixed(2)}R.`,
    };
  if (delta < -0.1) return { health: "WATCH", reason: "Leve queda recente de expectância." };
  return { health: "HEALTHY", reason: "Desempenho recente compatível com a base." };
}

export interface EvidenceReport {
  sample: number;
  stats: PerformanceStats;
  oosExpectancy: number | null;
  oosValidated: boolean;
  walkForward: ReturnType<typeof walkForward>;
  monteCarlo: MonteCarloResult | null;
  overfitting: string[];
  health: { health: StrategyHealth; reason: string };
  confidence: EvidenceConfidence;
  reasons: string[];
}

/** §33–§35: consolida tudo num grau de confiança da EVIDÊNCIA (nunca "chance de ganhar"). */
export function evaluateEvidence(trades: BacktestTrade[]): EvidenceReport {
  const stats = computeStats(trades);
  const reasons: string[] = [];
  const split = splitChronological(trades);
  const oos = split.test.length >= 6 ? computeStats(split.test) : null;
  const oosValidated = oos !== null && oos.expectancy > 0;
  const wf = walkForward(trades);
  const mc = monteCarlo(trades);
  const overfit = overfittingFlags(trades);
  const health = decayHealth(trades);

  let confidence: EvidenceConfidence;
  if (trades.length < MIN_EVIDENCE_SAMPLE) {
    confidence = "INSUFFICIENT";
    reasons.push(`Somente ${trades.length} casos (mínimo ${MIN_EVIDENCE_SAMPLE}).`);
  } else if (stats.expectancy <= 0 || stats.profitFactor <= 1) {
    // §35: win rate alto não salva expectância/PF ruins.
    confidence = "WEAK";
    reasons.push(
      `Expectância ${stats.expectancy.toFixed(2)}R, profit factor ${stats.profitFactor.toFixed(2)} — sem vantagem estatística.`,
    );
  } else {
    let grade = 1; // MODERATE
    reasons.push(
      `${trades.length} casos, expectância ${stats.expectancy.toFixed(2)}R, PF ${stats.profitFactor.toFixed(2)}.`,
    );
    if (oosValidated) {
      grade++;
      reasons.push(`Out-of-sample positivo (${oos!.expectancy.toFixed(2)}R em ${oos!.total} ops).`);
    } else
      reasons.push(
        oos
          ? `Out-of-sample negativo (${oos.expectancy.toFixed(2)}R).`
          : "Out-of-sample ainda sem amostra.",
      );
    if (wf.stable) {
      grade++;
      reasons.push("Walk-forward estável.");
    }
    if (overfit.length > 0) {
      grade--;
      reasons.push(...overfit);
    }
    if (health.health === "DECAYING" || health.health === "SUSPENDED") {
      grade--;
      reasons.push(health.reason);
    }
    confidence =
      grade <= 0 ? "WEAK" : grade === 1 ? "MODERATE" : grade === 2 ? "STRONG" : "VERY_STRONG";
  }
  return {
    sample: trades.length,
    stats,
    oosExpectancy: oos ? Number(oos.expectancy.toFixed(3)) : null,
    oosValidated,
    walkForward: wf,
    monteCarlo: mc,
    overfitting: overfit,
    health,
    confidence,
    reasons,
  };
}
