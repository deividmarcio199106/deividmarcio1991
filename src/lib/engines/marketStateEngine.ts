import type { Features } from "./marketFeatures";
import type { PriceActionRead, MarketState, WyckoffRead } from "./types";

/** MarketStateEngine — classifica o estado atual do mercado. */
export function detectMarketState(f: Features, pa: PriceActionRead, wy: WyckoffRead): MarketState {
  const strongTrend = Math.abs(f.trend) > 0.55;
  const lateral = Math.abs(f.trend) < 0.28;

  if (pa.exhaustion > 70 && Math.abs(f.divergence) > 0.35) return "Exaustão";
  if (
    pa.exhaustion > 60 &&
    f.divergence !== 0 &&
    Math.sign(f.divergence) !== Math.sign(f.trend || 1)
  )
    return "Possível Reversão";

  if ((f.brokeHigh || f.brokeLow) && f.displacement > 0.55 && pa.conviction > 55) return "Breakout";
  if (f.retestingLevel !== null && f.distanceToLevel < 0.5 && Math.abs(f.momentum) < 0.35)
    return "Reteste";

  if (strongTrend && f.locationInTrend < 0.45 && Math.sign(f.momentum) !== Math.sign(f.trend))
    return "Pullback";

  if (lateral && wy.schema === "Acumulação")
    return wy.phase === "E" ? "Reacumulação" : "Acumulação";
  if (lateral && wy.schema === "Distribuição")
    return wy.phase === "E" ? "Redistribuição" : "Distribuição";
  if (lateral) return "Range";

  if (strongTrend) return f.trend > 0 ? "Tendência Compradora" : "Tendência Vendedora";
  if (wy.schema === "Acumulação" && wy.phase === "E") return "Reacumulação";
  if (wy.schema === "Distribuição" && wy.phase === "E") return "Redistribuição";

  return "Indefinido";
}

/**
 * Identidade estável do estado. Enquanto o marketStateId não mudar,
 * um mesmo setup não deve gerar sinais repetidos.
 */
export function marketStateId(state: MarketState, f: Features): string {
  const dir = f.trend > 0.2 ? "up" : f.trend < -0.2 ? "dn" : "flat";
  const zone = Math.round(f.positionInRange * 4);
  return `${state}|${dir}|z${zone}`;
}
