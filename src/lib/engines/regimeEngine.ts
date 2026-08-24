import type { Features } from "./marketFeatures";
import type { PriceActionRead } from "./types";

/**
 * Detector de regime (spec V5 §20) — classifica o mercado ANTES do setup,
 * usando exclusivamente evidências numéricas do motor (nunca opinião textual
 * da IA). Cada classificação vem acompanhada das evidências que a produziram.
 */

export type Regime =
  "TREND_UP" | "TREND_DOWN" | "RANGE" | "COMPRESSION" | "EXPANSION" | "TRANSITION" | "UNCLEAR";

export interface RegimeRead {
  regime: Regime;
  /** Evidências objetivas (feature = valor) que sustentam a classificação. */
  evidences: string[];
  /** 0..100 — o quanto as evidências separam este regime dos vizinhos. */
  strength: number;
}

export function detectRegime(f: Features, pa: PriceActionRead): RegimeRead {
  const evidences: string[] = [];
  const absTrend = Math.abs(f.trend);
  const rangeInAtr = f.atr > 0 ? f.rangeWidth / f.atr : 0;

  // EXPANSION: deslocamento forte com rompimento — vale mesmo dentro de tendência.
  if (f.displacement > 0.6 && (f.brokeHigh || f.brokeLow) && pa.conviction > 55) {
    evidences.push(
      `displacement=${f.displacement.toFixed(2)}>0.6`,
      f.brokeHigh ? "rompeu máxima" : "rompeu mínima",
      `conviction=${Math.round(pa.conviction)}>55`,
    );
    return { regime: "EXPANSION", evidences, strength: Math.round(f.displacement * 100) };
  }

  // COMPRESSION: range estreito em ATR + corpos pequenos.
  if (rangeInAtr > 0 && rangeInAtr < 4 && f.bodyRatio < 0.45 && absTrend < 0.3) {
    evidences.push(
      `rangeWidth=${rangeInAtr.toFixed(1)}ATR<4`,
      `bodyRatio=${f.bodyRatio.toFixed(2)}<0.45`,
      `|trend|=${absTrend.toFixed(2)}<0.3`,
    );
    return {
      regime: "COMPRESSION",
      evidences,
      strength: Math.round(Math.min(100, (4 - rangeInAtr) * 25)),
    };
  }

  // TRANSITION: momentum contra a tendência vigente ou divergência relevante.
  const momentumAgainstTrend =
    absTrend > 0.35 && f.momentum !== 0 && Math.sign(f.momentum) !== Math.sign(f.trend);
  const strongDivergence = Math.abs(f.divergence) > 0.4;
  if (momentumAgainstTrend || (absTrend > 0.35 && strongDivergence)) {
    if (momentumAgainstTrend)
      evidences.push(`momentum=${f.momentum.toFixed(2)} contra trend=${f.trend.toFixed(2)}`);
    if (strongDivergence) evidences.push(`divergence=${f.divergence.toFixed(2)}`);
    return {
      regime: "TRANSITION",
      evidences,
      strength: Math.round(Math.min(100, Math.abs(f.divergence) * 100 + 30)),
    };
  }

  // Tendências direcionais claras.
  if (f.trend >= 0.4) {
    evidences.push(`trend=${f.trend.toFixed(2)}>=0.4`, `slope=${f.slope.toFixed(3)}`);
    return { regime: "TREND_UP", evidences, strength: Math.round(f.trend * 100) };
  }
  if (f.trend <= -0.4) {
    evidences.push(`trend=${f.trend.toFixed(2)}<=-0.4`, `slope=${f.slope.toFixed(3)}`);
    return { regime: "TREND_DOWN", evidences, strength: Math.round(absTrend * 100) };
  }

  // RANGE: lateral com largura razoável.
  if (absTrend < 0.28 && rangeInAtr >= 4) {
    evidences.push(
      `|trend|=${absTrend.toFixed(2)}<0.28`,
      `rangeWidth=${rangeInAtr.toFixed(1)}ATR>=4`,
    );
    return {
      regime: "RANGE",
      evidences,
      strength: Math.round(Math.min(100, 100 - absTrend * 200)),
    };
  }

  evidences.push(
    `trend=${f.trend.toFixed(2)} intermediário`,
    `rangeWidth=${rangeInAtr.toFixed(1)}ATR`,
  );
  return { regime: "UNCLEAR", evidences, strength: 0 };
}
