import { HSS_CONFIG } from "./strategy";
import type { Features } from "./marketFeatures";
import type { Candle, Direction, HSSRead, HSSStage, LiquidityMap, POI } from "./types";

const EMPTY_HSS: HSSRead = {
  detected: false,
  direction: null,
  stage: "nenhum",
  sweptLevelId: null,
  sweepExtreme: null,
  rejection: 0,
  displacement: 0,
  structuralConfirmation: false,
  returnedToPOI: false,
  invalidation: null,
  confidence: 0,
  label: "Sem varredura de liquidez recente",
};

const SEARCH_WINDOW_BARS = 15;

function wickRejection(c: Candle, direction: "topo" | "fundo"): number {
  const range = Math.max(c.h - c.l, 1e-9);
  const wick =
    direction === "topo" ? (c.h - Math.max(c.o, c.c)) / range : (Math.min(c.o, c.c) - c.l) / range;
  return Math.max(0, Math.min(1, wick)) * 100;
}

/**
 * HSS — ver definição centralizada em strategy.ts (HSS_CONFIG). Depende do
 * mapa de liquidez (mesma detecção de varredura, sem duplicar heurística) e
 * dos POIs já construídos para checar "retorno a região de interesse".
 * Sem estado, sem look-ahead (só enxerga `window`).
 */
export function analyzeHSS(
  window: Candle[],
  f: Features,
  liquidity: LiquidityMap,
  pois: POI[],
): HSSRead {
  if (window.length < 24 || liquidity.levels.length === 0) return EMPTY_HSS;

  const sweepEvents = liquidity.events
    .filter((e) => e.type === "varredura" || e.type === "captura_reversao" || e.type === "rejeicao")
    .sort((a, b) => b.t - a.t);

  let picked: (typeof sweepEvents)[number] | null = null;
  let sweepIndex = -1;
  for (const ev of sweepEvents) {
    const idx = window.findIndex((c) => c.t === ev.t);
    if (idx < 0) continue;
    if (window.length - 1 - idx > SEARCH_WINDOW_BARS) continue;
    picked = ev;
    sweepIndex = idx;
    break;
  }
  if (!picked || sweepIndex < 0) return EMPTY_HSS;

  const level = liquidity.levels.find((l) => l.id === picked!.levelId);
  if (!level) return EMPTY_HSS;

  const direction: Direction = level.kind === "vendedora" ? "COMPRA" : "VENDA";
  const sweepCandle = window[sweepIndex]!;
  const sweepExtreme = level.kind === "vendedora" ? sweepCandle.l : sweepCandle.h;
  const rejection = wickRejection(sweepCandle, level.kind === "vendedora" ? "fundo" : "topo");

  const post = window.slice(sweepIndex + 1);
  const buf = f.atr * HSS_CONFIG.invalidationBufferAtr;
  const invalidation = direction === "COMPRA" ? sweepExtreme - buf : sweepExtreme + buf;

  const breached =
    post.some((c) => (direction === "COMPRA" ? c.c < invalidation : c.c > invalidation)) ||
    (direction === "COMPRA" ? f.price < invalidation : f.price > invalidation);

  const momentumAligned =
    (direction === "COMPRA" && f.momentum > 0) || (direction === "VENDA" && f.momentum < 0);
  const displacement =
    momentumAligned && f.displacement >= HSS_CONFIG.minDisplacement ? f.displacement * 100 : 0;

  const structuralConfirmation =
    post.length > 0 &&
    (direction === "COMPRA"
      ? post.every((c) => c.l >= sweepExtreme - buf * 0.4) && post[post.length - 1]!.c > level.price
      : post.every((c) => c.h <= sweepExtreme + buf * 0.4) &&
        post[post.length - 1]!.c < level.price);

  const returnedToPOI = pois.some((p) => {
    if (p.direction !== direction) return false;
    if (!["spring", "ut", "utad", "test", "lps", "lpsy"].includes(p.kind)) return false;
    const mid = (p.upper + p.lower) / 2;
    return Math.abs(f.price - mid) <= f.atr * HSS_CONFIG.poiReturnAtr;
  });

  const confidence = Math.max(
    0,
    Math.min(
      100,
      rejection * 0.3 +
        displacement * 0.3 +
        (structuralConfirmation ? 20 : 0) +
        (returnedToPOI ? 20 : 0),
    ),
  );

  let stage: HSSStage = "varredura";
  if (breached) stage = "invalidado";
  else if (structuralConfirmation && displacement > 0) stage = "confirmado";
  else if (displacement > 0) stage = "deslocamento";
  else if (rejection >= HSS_CONFIG.minRejectionWick * 100) stage = "rejeicao";

  const detected = !breached && confidence >= HSS_CONFIG.minConfidence;

  const label = breached
    ? `HSS ${direction} invalidado — preço fechou além do extremo capturado (${sweepExtreme.toFixed(2)}).`
    : `HSS ${direction}: varredura de liquidez ${level.kind} (${level.origin.replace(/_/g, " ")}) com rejeição ${Math.round(rejection)}% e deslocamento ${Math.round(displacement)}%${returnedToPOI ? " — preço retornou a um POI" : ""}.`;

  return {
    detected,
    direction,
    stage,
    sweptLevelId: level.id,
    sweepExtreme,
    rejection: Math.round(rejection),
    displacement: Math.round(displacement),
    structuralConfirmation,
    returnedToPOI,
    invalidation,
    confidence: Math.round(confidence),
    label,
  };
}
