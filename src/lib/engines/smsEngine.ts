import { SMS_CONFIG } from "./strategy";
import type { Features } from "./marketFeatures";
import type { Candle, Direction, PriceActionRead, HSSRead, SMSRead } from "./types";

const EMPTY_SMS: SMSRead = {
  confirmed: false,
  pending: false,
  direction: null,
  brokenLevel: null,
  displacement: 0,
  closeConfirmed: false,
  liquidityDefended: false,
  reactionConfirmed: false,
  structureFormed: false,
  retestExpected: false,
  confidence: 0,
  invalidation: null,
  label: "Sem shift de estrutura em andamento",
};

interface DirectionRead {
  hardPass: boolean;
  confidence: number;
  closeConfirmed: boolean;
  liquidityDefended: boolean;
  reactionConfirmed: boolean;
  structureFormed: boolean;
  retestExpected: boolean;
  level: number;
  displacement: number;
}

/**
 * Avalia UMA direção candidata. Gates objetivos (obrigatórios) filtram falsos
 * SMS por puro pavio, candle isolado ou rompimento sem
 * deslocamento — exatamente os quatro casos que o spec pede para filtrar.
 * Os demais fatores (defesa de liquidez, fundo mais alto/topo mais
 * baixo, retorno ao POI) entram como confirmação ponderada, não como gate.
 */
function evalDirection(
  window: Candle[],
  f: Features,
  pa: PriceActionRead,
  hss: HSSRead,
  bull: boolean,
): DirectionRead {
  const direction: Direction = bull ? "COMPRA" : "VENDA";
  const level = bull ? f.swingHigh : f.swingLow;
  const structuralBreak = bull ? f.brokeHigh : f.brokeLow;
  const last = window[window.length - 1]!;
  const range = Math.max(last.h - last.l, 1e-9);
  const bodyRatio = Math.abs(last.c - last.o) / range;
  const closedBeyond = bull ? last.c > level : last.c < level;
  const closeConfirmed =
    structuralBreak && closedBeyond && bodyRatio >= SMS_CONFIG.minBreakBodyRatio;

  const displacementOk =
    f.displacement >= SMS_CONFIG.minDisplacement && (bull ? f.momentum > 0 : f.momentum < 0);
  const notIsolated = bull ? f.consecutiveUp >= 2 : f.consecutiveDown >= 2;
  const reactionConfirmed = bull
    ? pa.conviction > 55 && pa.imbalance > 0
    : pa.conviction > 55 && pa.imbalance < 0;

  const hardPass =
    structuralBreak && closeConfirmed && displacementOk && notIsolated && reactionConfirmed;

  const liquidityDefended =
    hss.direction === direction && ["rejeicao", "deslocamento", "confirmado"].includes(hss.stage);

  const recentSeg = window.slice(-20, -1);
  const olderSeg = window.slice(-40, -20);
  let structureFormed = false;
  if (recentSeg.length > 0 && olderSeg.length > 0) {
    structureFormed = bull
      ? Math.min(...recentSeg.map((c) => c.l)) > Math.min(...olderSeg.map((c) => c.l))
      : Math.max(...recentSeg.map((c) => c.h)) < Math.max(...olderSeg.map((c) => c.h));
  }

  const retestExpected = closeConfirmed && f.retestingLevel === null;

  const confidence = hardPass
    ? Math.min(
        100,
        40 +
          (liquidityDefended ? 20 : 0) +
          (reactionConfirmed ? 10 : 0) +
          (structureFormed ? 15 : 0) +
          (hss.returnedToPOI && hss.direction === direction ? 10 : 0) +
          Math.min(15, f.displacement * 15),
      )
    : 0;

  return {
    hardPass,
    confidence,
    closeConfirmed,
    liquidityDefended,
    reactionConfirmed,
    structureFormed,
    retestExpected,
    level,
    displacement: Math.round(f.displacement * 100),
  };
}

/**
 * SMS — distinto de um rompimento simples: exige fechamento consistente
 * (corpo mínimo), deslocamento real, candle não isolado e reação geométrica —
 * não apenas `brokeHigh`/`brokeLow`. Sem estado, sem look-ahead.
 */
export function analyzeSMS(
  window: Candle[],
  f: Features,
  pa: PriceActionRead,
  hss: HSSRead,
): SMSRead {
  if (window.length < 24) return EMPTY_SMS;

  const bull = evalDirection(window, f, pa, hss, true);
  const bear = evalDirection(window, f, pa, hss, false);

  const pick =
    bull.hardPass && bull.confidence >= bear.confidence
      ? { bull, dir: "COMPRA" as Direction }
      : bear.hardPass
        ? { bull: bear, dir: "VENDA" as Direction }
        : null;

  if (!pick) return EMPTY_SMS;
  const r = pick.bull;
  const direction = pick.dir;
  const confirmed = r.confidence >= SMS_CONFIG.minConfidence;

  const label = confirmed
    ? `SMS de ${direction === "COMPRA" ? "alta" : "baixa"} confirmado: rompimento de ${r.level.toFixed(2)} com fechamento consistente${r.liquidityDefended ? " após defesa de liquidez" : ""}${r.structureFormed ? `, formando ${direction === "COMPRA" ? "fundo mais alto" : "topo mais baixo"}` : ""}.`
    : `SMS de ${direction === "COMPRA" ? "alta" : "baixa"} pendente: rompimento de ${r.level.toFixed(2)} ainda sem confirmação suficiente.`;

  return {
    confirmed,
    pending: !confirmed,
    direction,
    brokenLevel: r.level,
    displacement: r.displacement,
    closeConfirmed: r.closeConfirmed,
    liquidityDefended: r.liquidityDefended,
    reactionConfirmed: r.reactionConfirmed,
    structureFormed: r.structureFormed,
    retestExpected: r.retestExpected,
    confidence: Math.round(r.confidence),
    invalidation: r.level,
    label,
  };
}
