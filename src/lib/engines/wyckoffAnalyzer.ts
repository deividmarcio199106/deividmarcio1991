import type { Features } from "./marketFeatures";
import type { Candle, PriceActionRead, WyckoffEvent, WyckoffRead } from "./types";

/**
 * WyckoffAnalyzer — camada estrutural.
 * Só classifica quando existe evidência suficiente; caso contrário retorna
 * "Indefinido" (nunca forçar um esquema).
 */
export function analyzeWyckoff(window: Candle[], f: Features, pa: PriceActionRead): WyckoffRead {
  const events: WyckoffEvent[] = [];
  const seg = window.slice(-40);
  if (seg.length < 20) {
    return {
      schema: "Indefinido",
      phase: null,
      events,
      confidence: 0,
      label: "Contexto insuficiente",
    };
  }

  const highs = seg.map((c) => c.h);
  const lows = seg.map((c) => c.l);
  const top = Math.max(...highs);
  const bottom = Math.min(...lows);
  const width = Math.max(top - bottom, 1e-9);
  const rangeInAtr = width / f.atr;

  // Mercado lateralizado o suficiente para ser uma fase de causa?
  const lateral = rangeInAtr < 9 && Math.abs(f.trend) < 0.45;
  const pos = (f.price - bottom) / width;

  const half = Math.floor(seg.length / 2);
  const firstHalf = seg.slice(0, half);
  const secondHalf = seg.slice(half);
  const meanRange = (candles: Candle[]) =>
    candles.reduce((total, candle) => total + candle.h - candle.l, 0) / candles.length;
  const rangeContracting = meanRange(secondHalf) < meanRange(firstHalf) * 0.85;

  // Detecção de eventos
  const lowsBeforeLast = Math.min(...seg.slice(0, -3).map((c) => c.l));
  const highsBeforeLast = Math.max(...seg.slice(0, -3).map((c) => c.h));
  const last3 = seg.slice(-3);
  const pokedDown = last3.some((c) => c.l < lowsBeforeLast) && f.price > lowsBeforeLast;
  const pokedUp = last3.some((c) => c.h > highsBeforeLast) && f.price < highsBeforeLast;

  let schema: WyckoffRead["schema"] = "Indefinido";
  let phase: WyckoffRead["phase"] = null;
  let confidence = 0;

  if (lateral) {
    const accumBias =
      pa.buyEffort - pa.sellEffort + (rangeContracting ? 6 : 0) + (pokedDown ? 12 : 0);
    const distribBias =
      pa.sellEffort - pa.buyEffort + (rangeContracting ? 6 : 0) + (pokedUp ? 12 : 0);

    if (accumBias > 8 && accumBias >= distribBias) {
      schema = "Acumulação";
      events.push("PS", "SC", "AR");
      if (pokedDown) events.push("Spring");
      if (rangeContracting) events.push("Test");
      if (f.brokeHigh && pa.conviction > 55) events.push("SOS");
      if (f.retestingLevel !== null && f.price > f.ema21) events.push("LPS");
      confidence = Math.min(
        0.92,
        0.4 + accumBias / 90 + (pokedDown ? 0.14 : 0) + (rangeContracting ? 0.08 : 0),
      );
      phase = events.includes("SOS") ? "D" : pokedDown ? "C" : rangeContracting ? "B" : "A";
    } else if (distribBias > 8) {
      schema = "Distribuição";
      events.push("PS", "SC", "AR", "ST");
      if (pokedUp) events.push(pa.exhaustion > 55 ? "UTAD" : "UT");
      if (f.brokeLow && pa.conviction > 55) events.push("SOW");
      if (f.retestingLevel !== null && f.price < f.ema21) events.push("LPSY");
      confidence = Math.min(
        0.92,
        0.4 + distribBias / 90 + (pokedUp ? 0.14 : 0) + (rangeContracting ? 0.08 : 0),
      );
      phase = events.includes("SOW") ? "D" : pokedUp ? "C" : rangeContracting ? "B" : "A";
    }
  } else if (Math.abs(f.trend) > 0.5) {
    // Fase E — causa já em execução (reacumulação/redistribuição em tendência)
    schema = f.trend > 0 ? "Acumulação" : "Distribuição";
    phase = "E";
    confidence = Math.min(0.8, 0.35 + Math.abs(f.trend) * 0.4);
    events.push(f.trend > 0 ? "SOS" : "SOW");
    if (f.retestingLevel !== null) events.push(f.trend > 0 ? "LPS" : "LPSY");
  }

  if (schema === "Indefinido" || confidence < 0.35) {
    return {
      schema: "Indefinido",
      phase: null,
      events: [],
      confidence: Math.max(0, confidence),
      label: "Sem evidência Wyckoff suficiente",
    };
  }

  const posNote = pos > 0.7 ? "topo do range" : pos < 0.3 ? "base do range" : "meio do range";
  return {
    schema,
    phase,
    events: [...new Set(events)],
    confidence,
    label: `${schema} — Fase ${phase} (${posNote})`,
  };
}
