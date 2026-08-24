import type { Candle, DataQuality } from "./types";

export interface Features {
  price: number;
  atr: number;
  ema9: number;
  ema21: number;
  ema50: number;
  slope: number; // inclinação normalizada da ema21
  trend: number; // -1..1
  locationInTrend: number; // 0..1 (0 = início do movimento, 1 = esticado)
  swingHigh: number;
  swingLow: number;
  rangeHigh: number;
  rangeLow: number;
  rangeWidth: number;
  positionInRange: number; // 0..1
  bodyRatio: number;
  upperWick: number;
  lowerWick: number;
  momentum: number; // -1..1
  acceleration: number; // -1..1
  brokeHigh: boolean;
  brokeLow: boolean;
  displacement: number; // 0..1 força do deslocamento
  retestingLevel: number | null;
  distanceToLevel: number; // em ATR
  consecutiveUp: number;
  consecutiveDown: number;
  divergence: number; // -1..1 (preço x momentum)
}

/**
 * MME de `period` sobre a série já fechada.
 *
 * Exportada porque a condução do runner (`t4/management`) precisa da MESMA
 * média que as features. Uma segunda implementação divergiria no primeiro
 * ajuste, e a divergência apareceria como o runner saindo num painel e
 * continuando no outro.
 */
export function ema(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let e = values[0]!;
  for (let i = 1; i < values.length; i++) e = values[i]! * k + e * (1 - k);
  return e;
}

function clamp(v: number, min = -1, max = 1) {
  return Math.max(min, Math.min(max, v));
}

/**
 * Extrai features de uma janela de candles.
 * IMPORTANTE (anti look-ahead): recebe SOMENTE candles já fechados até o instante
 * analisado. Nenhum motor tem acesso a candles futuros.
 */
export function extractFeatures(window: Candle[]): Features | null {
  if (window.length < 12) return null;

  const closes = window.map((c) => c.c);
  const highs = window.map((c) => c.h);
  const lows = window.map((c) => c.l);
  const last = window[window.length - 1]!;
  const price = last.c;

  // ATR (Wilder simplificado)
  let trSum = 0;
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1]!;
    const cur = window[i]!;
    trSum += Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c));
  }
  const atr = Math.max(trSum / (window.length - 1), 1e-9);

  const e9 = ema(closes.slice(-Math.min(closes.length, 40)), 9);
  const e21 = ema(closes.slice(-Math.min(closes.length, 80)), 21);
  const e50 = ema(closes, 50);

  const prevSliceEma21 = ema(closes.slice(0, -3), 21);
  const slope = clamp((e21 - prevSliceEma21) / atr);

  const trend = clamp(((e9 - e21) / atr) * 0.7 + slope * 0.6);

  const lookback = window.slice(-30);
  const rangeHigh = Math.max(...lookback.map((c) => c.h));
  const rangeLow = Math.min(...lookback.map((c) => c.l));
  const rangeWidth = Math.max(rangeHigh - rangeLow, 1e-9);
  const positionInRange = (price - rangeLow) / rangeWidth;

  const prior = window.slice(0, -1);
  const swingHigh = Math.max(...prior.slice(-20).map((c) => c.h));
  const swingLow = Math.min(...prior.slice(-20).map((c) => c.l));

  const bodyRange = Math.max(last.h - last.l, 1e-9);
  const bodyRatio = Math.abs(last.c - last.o) / bodyRange;
  const upperWick = (last.h - Math.max(last.c, last.o)) / bodyRange;
  const lowerWick = (Math.min(last.c, last.o) - last.l) / bodyRange;

  const mom5 = (price - closes[closes.length - 6]!) / atr;
  const mom10 = (price - closes[closes.length - 11]!) / atr;
  const momentum = clamp(mom5 / 3);
  const acceleration = clamp((mom5 - mom10 / 2) / 2);

  const brokeHigh = last.c > swingHigh;
  const brokeLow = last.c < swingLow;
  const displacement = Math.min(1, (Math.abs(last.c - last.o) / atr) * 0.8);

  // localização dentro da tendência: quão esticado o preço está das médias
  const stretch = Math.abs(price - e21) / atr;
  const locationInTrend = Math.min(1, stretch / 3.5);

  let consecutiveUp = 0;
  let consecutiveDown = 0;
  for (let i = window.length - 1; i >= 0; i--) {
    const c = window[i]!;
    if (c.c > c.o && consecutiveDown === 0) consecutiveUp++;
    else if (c.c < c.o && consecutiveUp === 0) consecutiveDown++;
    else break;
  }

  // divergência: preço faz novo extremo mas momentum não acompanha
  const priorMomentum = (closes[closes.length - 6]! - closes[closes.length - 11]!) / atr;
  let divergence = 0;
  if (price > Math.max(...closes.slice(-10, -1)) && mom5 < priorMomentum)
    divergence = -Math.min(1, (priorMomentum - mom5) / 2);
  if (price < Math.min(...closes.slice(-10, -1)) && mom5 > priorMomentum)
    divergence = Math.min(1, (mom5 - priorMomentum) / 2);

  // reteste de nível rompido recentemente
  let retestingLevel: number | null = null;
  const levels = [swingHigh, swingLow, rangeHigh, rangeLow];
  let bestDist = Infinity;
  for (const lv of levels) {
    const d = Math.abs(price - lv) / atr;
    if (d < bestDist) {
      bestDist = d;
      if (d < 0.6) retestingLevel = lv;
    }
  }

  return {
    price,
    atr,
    ema9: e9,
    ema21: e21,
    ema50: e50,
    slope,
    trend,
    locationInTrend,
    swingHigh,
    swingLow,
    rangeHigh,
    rangeLow,
    rangeWidth,
    positionInRange,
    bodyRatio,
    upperWick,
    lowerWick,
    momentum,
    acceleration,
    brokeHigh,
    brokeLow,
    displacement,
    retestingLevel,
    distanceToLevel: bestDist,
    consecutiveUp,
    consecutiveDown,
    divergence,
  };
}

export { clamp };

const IDEAL_WINDOW_BARS = 120;

/**
 * Qualidade objetiva dos dados da janela — nunca inventa problemas nem os
 * esconde. Usada tanto no painel ("qualidade dos dados") quanto como
 * penalidade de risco (ver riskEngine.ts).
 */
export function assessDataQuality(window: Candle[]): DataQuality {
  const issues: string[] = [];
  let quality = 100;

  if (window.length < IDEAL_WINDOW_BARS) {
    const missingRatio = 1 - window.length / IDEAL_WINDOW_BARS;
    quality -= Math.round(missingRatio * 35);
    issues.push(`Janela curta (${window.length}/${IDEAL_WINDOW_BARS} candles ideais)`);
  }

  if (window.length >= 2) {
    const gaps = [];
    for (let i = 1; i < window.length; i++) gaps.push(window[i]!.t - window[i - 1]!.t);
    const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] ?? 0;
    if (median > 0) {
      const irregular = gaps.filter((g) => g > median * 4).length;
      if (irregular > Math.max(1, gaps.length * 0.08)) {
        quality -= 15;
        issues.push("Intervalos irregulares entre candles (possível perda de frames/dados)");
      }
    }
  }

  return { quality: Math.max(0, Math.min(100, Math.round(quality))), issues };
}
