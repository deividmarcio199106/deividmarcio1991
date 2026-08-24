import type { Candle, Direction } from "./types";

/**
 * §26 — DETECTOR DE FALSO ROMPIMENTO: diferencia BREAKOUT real de LIQUIDITY
 * SWEEP usando somente candles reais: fechamento além do nível, retorno
 * rápido, proporção de pavio, reação e continuidade.
 *
 * §27 — QUALIDADE DA REAÇÃO: métricas reais medidas após um evento.
 *
 * §30 — FILTRO DE VOLATILIDADE: ATR atual vs mediana recente; anormal
 * SINALIZA, não bloqueia.
 */

export type ExcursionKind = "BREAKOUT" | "LIQUIDITY_SWEEP" | "INDEFINIDO";

export interface ExcursionRead {
  kind: ExcursionKind;
  /** Índice (na janela) do candle que excursionou além do nível. */
  excursionIndex: number | null;
  closedBeyond: boolean;
  returnedInBars: number | null;
  wickRatio: number;
  continuationBars: number;
  evidences: string[];
}

/**
 * Classifica a excursão mais recente além de `level`.
 * `side`: "acima" = excursão acima do nível (relevante para venda/sweep de
 * topo); "abaixo" = excursão abaixo (compra/sweep de fundo).
 */
export function classifyExcursion(
  window: Candle[],
  level: number,
  side: "acima" | "abaixo",
): ExcursionRead {
  const evidences: string[] = [];
  const beyond = (candle: Candle) => (side === "acima" ? candle.h > level : candle.l < level);
  const closeBeyond = (candle: Candle) => (side === "acima" ? candle.c > level : candle.c < level);
  const backInside = (candle: Candle) => (side === "acima" ? candle.c < level : candle.c > level);

  let excursionIndex: number | null = null;
  for (let i = window.length - 1; i >= 0; i--) {
    if (beyond(window[i]!)) {
      excursionIndex = i;
      break;
    }
  }
  // Ancorar no PRIMEIRO candle da excursão corrente: a continuidade é medida
  // a partir de onde o movimento começou, não do candle mais recente (que por
  // definição nunca tem candles depois).
  while (excursionIndex !== null && excursionIndex > 0 && beyond(window[excursionIndex - 1]!)) {
    excursionIndex--;
  }
  if (excursionIndex === null) {
    return {
      kind: "INDEFINIDO",
      excursionIndex: null,
      closedBeyond: false,
      returnedInBars: null,
      wickRatio: 0,
      continuationBars: 0,
      evidences: ["Nenhuma excursão além do nível na janela."],
    };
  }

  const excursion = window[excursionIndex]!;
  const range = Math.max(excursion.h - excursion.l, 1e-9);
  const wick =
    side === "acima"
      ? excursion.h - Math.max(excursion.o, excursion.c)
      : Math.min(excursion.o, excursion.c) - excursion.l;
  const wickRatio = wick / range;
  const closedBeyond = closeBeyond(excursion);
  evidences.push(
    `fechamento ${closedBeyond ? "ALÉM" : "AQUÉM"} do nível`,
    `pavio=${(wickRatio * 100).toFixed(0)}% do candle`,
  );

  // Retorno: em quantos candles o fechamento voltou para dentro.
  let returnedInBars: number | null = null;
  for (let i = excursionIndex; i < window.length; i++) {
    if (backInside(window[i]!)) {
      returnedInBars = i - excursionIndex;
      break;
    }
  }
  if (returnedInBars !== null) evidences.push(`retornou em ${returnedInBars} candle(s)`);

  // Continuidade: candles subsequentes fechando além do nível.
  let continuationBars = 0;
  for (let i = excursionIndex + 1; i < window.length; i++) {
    if (closeBeyond(window[i]!)) continuationBars++;
    else break;
  }
  evidences.push(`continuidade=${continuationBars} candle(s)`);

  // Decisão pelas evidências do spec: sweep = não fechou além OU retornou
  // rápido com pavio dominante; breakout = fechou além com continuidade.
  const quickReturn = returnedInBars !== null && returnedInBars <= 2;
  if (!closedBeyond || (quickReturn && wickRatio >= 0.4)) {
    return {
      kind: "LIQUIDITY_SWEEP",
      excursionIndex,
      closedBeyond,
      returnedInBars,
      wickRatio,
      continuationBars,
      evidences,
    };
  }
  if (closedBeyond && continuationBars >= 1 && !quickReturn) {
    return {
      kind: "BREAKOUT",
      excursionIndex,
      closedBeyond,
      returnedInBars,
      wickRatio,
      continuationBars,
      evidences,
    };
  }
  return {
    kind: "INDEFINIDO",
    excursionIndex,
    closedBeyond,
    returnedInBars,
    wickRatio,
    continuationBars,
    evidences: [...evidences, "Evidências mistas — aguardar próximo fechamento."],
  };
}

export interface ReactionQuality {
  reactionAmplitude: number; // pontos percorridos a favor após o evento
  reactionAmplitudeAtr: number;
  reactionSpeed: number; // pontos/candle até o pico da reação
  barsUntilReaction: number | null; // candles até o 1º fechamento a favor
  closeStrength: number; // 0..1: posição do fechamento do candle de reação no próprio range
  continuationBars: number; // fechamentos consecutivos a favor após a reação
  measuredBars: number;
}

/** §27 — mede a reação REAL nos candles posteriores a `eventIndex`. */
export function measureReaction(
  window: Candle[],
  eventIndex: number,
  direction: Exclude<Direction, "NEUTRO">,
  atr: number,
): ReactionQuality | null {
  if (eventIndex < 0 || eventIndex >= window.length - 1) return null;
  const eventCandle = window[eventIndex]!;
  const after = window.slice(eventIndex + 1);
  const dir = direction === "COMPRA" ? 1 : -1;
  const reference = eventCandle.c;

  let favorable = 0;
  let peakBar = 0;
  after.forEach((candle, i) => {
    const excursion = dir > 0 ? candle.h - reference : reference - candle.l;
    if (excursion > favorable) {
      favorable = excursion;
      peakBar = i + 1;
    }
  });

  let barsUntilReaction: number | null = null;
  for (let i = 0; i < after.length; i++) {
    const closedFavorable = dir > 0 ? after[i]!.c > reference : after[i]!.c < reference;
    if (closedFavorable) {
      barsUntilReaction = i + 1;
      break;
    }
  }

  let closeStrength = 0;
  let continuationBars = 0;
  if (barsUntilReaction !== null) {
    const reactionCandle = after[barsUntilReaction - 1]!;
    const range = Math.max(reactionCandle.h - reactionCandle.l, 1e-9);
    closeStrength =
      dir > 0
        ? (reactionCandle.c - reactionCandle.l) / range
        : (reactionCandle.h - reactionCandle.c) / range;
    for (let i = barsUntilReaction; i < after.length; i++) {
      const favorableClose =
        dir > 0 ? after[i]!.c > after[i - 1]!.c : after[i]!.c < after[i - 1]!.c;
      if (favorableClose) continuationBars++;
      else break;
    }
  }

  return {
    reactionAmplitude: Math.max(0, favorable),
    reactionAmplitudeAtr: atr > 0 ? Math.max(0, favorable) / atr : 0,
    reactionSpeed: peakBar > 0 ? favorable / peakBar : 0,
    barsUntilReaction,
    closeStrength,
    continuationBars,
    measuredBars: after.length,
  };
}

export interface VolatilityContext {
  currentAtr: number;
  medianAtrRecent: number;
  ratio: number;
  /** Anormal SINALIZA (§30) — a decisão de bloquear é de outro motor. */
  abnormal: boolean;
  note: string;
}

/** §30 — ATR do candle atual vs mediana das amplitudes reais recentes. */
export function volatilityContext(window: Candle[], lookback = 30): VolatilityContext | null {
  if (window.length < 6) return null;
  const ranges = window.slice(-lookback).map((candle) => candle.h - candle.l);
  const last = ranges[ranges.length - 1]!;
  const sorted = [...ranges].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const ratio = median > 0 ? last / median : 0;
  const abnormal = ratio > 3 || (ratio > 0 && ratio < 1 / 3);
  return {
    currentAtr: last,
    medianAtrRecent: median,
    ratio,
    abnormal,
    note: abnormal
      ? `Volatilidade anormal: candle atual ${ratio.toFixed(1)}× a mediana recente.`
      : `Volatilidade dentro do padrão recente (${ratio.toFixed(1)}× a mediana).`,
  };
}
