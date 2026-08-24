import { POI_CONFIG } from "./strategy";
import type { Features } from "./marketFeatures";
import type {
  Candle,
  Direction,
  PriceActionRead,
  LiquidityMap,
  POI,
  POICondition,
  POIKind,
  WyckoffRead,
} from "./types";

interface ZoneCandidate {
  kind: POIKind;
  upper: number;
  lower: number;
  direction: Direction;
  originAt: number;
  originIndex: number;
  reasons: string[];
  wyckoffRelation: string;
  baseStrength: number;
}

/** Zonas a partir de eventos de varredura já detectados no mapa de liquidez (Spring/UT/absorção contextual). */
function zonesFromLiquiditySweeps(
  seg: Candle[],
  f: Features,
  liquidity: LiquidityMap,
  wy: WyckoffRead,
  pa: PriceActionRead,
): ZoneCandidate[] {
  const out: ZoneCandidate[] = [];
  for (const lv of liquidity.levels) {
    if (!["varrida", "rejeitada", "capturada_com_reversao"].includes(lv.status)) continue;
    const idx = seg.findIndex((c) => c.t === lv.formedAt);
    const bullish = lv.kind === "vendedora"; // fundo varrido -> reação compradora
    let kind: POIKind = "suporte_resistencia";
    let relation = "Sem contexto Wyckoff associado";
    if (bullish && wy.schema === "Acumulação" && wy.events.includes("Spring")) {
      kind = "spring";
      relation = `Spring — ${wy.label}`;
    } else if (!bullish && wy.schema === "Distribuição" && wy.events.includes("UTAD")) {
      kind = "utad";
      relation = `UTAD — ${wy.label}`;
    } else if (!bullish && wy.schema === "Distribuição" && wy.events.includes("UT")) {
      kind = "ut";
      relation = `UT — ${wy.label}`;
    }
    const buffer = Math.max(Math.abs(lv.price) * 0.0006, 1e-6);
    out.push({
      kind,
      upper: bullish ? lv.price + buffer : lv.price + buffer * 3,
      lower: bullish ? lv.price - buffer * 3 : lv.price - buffer,
      direction: bullish ? "COMPRA" : "VENDA",
      originAt: lv.formedAt,
      originIndex: idx >= 0 ? idx : 0,
      reasons: [
        `Liquidez ${lv.kind} ${lv.status.replace(/_/g, " ")} em ${lv.origin.replace(/_/g, " ")}`,
        `Testada ${lv.testCount}x antes da captura`,
      ],
      wyckoffRelation: relation,
      baseStrength: kind === "suporte_resistencia" ? 42 : 68,
    });

    // Test: reteste com estagnação geométrica sobre nível já varrido/rejeitado.
    if (pa.stall > 55) {
      out.push({
        kind: "test",
        upper: lv.price + buffer * 2,
        lower: lv.price - buffer * 2,
        direction: bullish ? "COMPRA" : "VENDA",
        originAt: lv.formedAt,
        originIndex: idx >= 0 ? idx : 0,
        reasons: ["Reteste com amplitude/corpo contraindo sobre região já varrida"],
        wyckoffRelation: bullish ? "Test pós-Spring" : "Test pós-UT/UTAD",
        baseStrength: 50,
      });
    }
  }
  return out;
}

/** LPS/LPSY: reteste de um nível que já rompeu com aceitação. */
function zonesFromBreakRetest(
  seg: Candle[],
  f: Features,
  liquidity: LiquidityMap,
): ZoneCandidate[] {
  if (f.retestingLevel === null) return [];
  const level = f.retestingLevel;
  const bull = f.price > f.ema21;
  const broken = liquidity.levels.find(
    (l) => l.status === "rompida_com_aceitacao" && Math.abs(l.price - level) < f.atr * 0.25,
  );
  const idx = seg.findIndex((c) => Math.abs(c.h - level) < 1e-6 || Math.abs(c.l - level) < 1e-6);
  const buffer = f.atr * 0.15;
  return [
    {
      kind: bull ? "lps" : "lpsy",
      upper: level + buffer,
      lower: level - buffer,
      direction: bull ? "COMPRA" : "VENDA",
      originAt: seg[Math.max(idx, 0)]?.t ?? seg[seg.length - 1]!.t,
      originIndex: Math.max(idx, 0),
      reasons: [
        broken
          ? "Reteste de nível rompido com aceitação anterior"
          : "Reteste de nível estrutural recente",
        `Preço ${bull ? "acima" : "abaixo"} da EMA21 no reteste`,
      ],
      wyckoffRelation: bull
        ? "LPS — suporte de última reação"
        : "LPSY — resistência de última reação",
      baseStrength: broken ? 58 : 46,
    },
  ];
}

/** Origem de deslocamento forte — candle de range/corpo anômalo antecedido por consolidação (order block simplificado). */
function zonesFromDisplacementOrigin(seg: Candle[], f: Features): ZoneCandidate[] {
  const out: ZoneCandidate[] = [];
  for (let i = seg.length - 12; i < seg.length; i++) {
    if (i < 4) continue;
    const c = seg[i]!;
    const range = c.h - c.l;
    if (range < f.atr * 1.6) continue;
    const body = Math.abs(c.c - c.o);
    if (body / Math.max(range, 1e-9) < 0.55) continue;
    const prior = seg.slice(Math.max(0, i - 3), i);
    const consolidated = prior.every((p) => p.h - p.l < f.atr * 1.05);
    if (!consolidated) continue;
    const bull = c.c > c.o;
    // order block clássico: última vela de cor oposta antes do deslocamento.
    const origin =
      [...prior].reverse().find((p) => (bull ? p.c < p.o : p.c > p.o)) ?? prior[prior.length - 1]!;
    out.push({
      kind: "origem_deslocamento",
      upper: Math.max(origin.o, origin.c),
      lower: Math.min(origin.o, origin.c),
      direction: bull ? "COMPRA" : "VENDA",
      originAt: origin.t,
      originIndex: seg.indexOf(origin),
      reasons: [
        "Vela de origem antes de deslocamento com range > 1.6 ATR",
        "Consolidação prévia de 3 candles antes do impulso",
      ],
      wyckoffRelation: "Origem de deslocamento (proxy de order block)",
      baseStrength: 55,
    });
  }
  return out;
}

/** Fair value gaps / desequilíbrios (3 candles: gap entre o 1º e o 3º). */
function zonesFromFVG(seg: Candle[]): ZoneCandidate[] {
  const out: ZoneCandidate[] = [];
  for (let i = 2; i < seg.length; i++) {
    const a = seg[i - 2]!;
    const c = seg[i]!;
    if (c.l > a.h) {
      out.push({
        kind: "fvg",
        upper: c.l,
        lower: a.h,
        direction: "COMPRA",
        originAt: c.t,
        originIndex: i,
        reasons: ["Desequilíbrio de alta entre candles (fair value gap)"],
        wyckoffRelation: "Gap não preenchido",
        baseStrength: 32,
      });
    } else if (c.h < a.l) {
      out.push({
        kind: "fvg",
        upper: a.l,
        lower: c.h,
        direction: "VENDA",
        originAt: c.t,
        originIndex: i,
        reasons: ["Desequilíbrio de baixa entre candles (fair value gap)"],
        wyckoffRelation: "Gap não preenchido",
        baseStrength: 32,
      });
    }
  }
  return out;
}

/** Extremos do range recente — fallback sempre disponível. */
function zonesFromRangeExtremes(f: Features): ZoneCandidate[] {
  const buffer = f.atr * 0.12;
  return [
    {
      kind: "extremo_range",
      upper: f.rangeHigh + buffer,
      lower: f.rangeHigh - buffer,
      direction: "VENDA",
      originAt: 0,
      originIndex: 0,
      reasons: ["Topo do range recente (30 candles)"],
      wyckoffRelation: "Extremo de range",
      baseStrength: 34,
    },
    {
      kind: "extremo_range",
      upper: f.rangeLow + buffer,
      lower: f.rangeLow - buffer,
      direction: "COMPRA",
      originAt: 0,
      originIndex: 0,
      reasons: ["Fundo do range recente (30 candles)"],
      wyckoffRelation: "Extremo de range",
      baseStrength: 34,
    },
  ];
}

function evaluateCondition(
  seg: Candle[],
  originIndex: number,
  upper: number,
  lower: number,
  direction: Direction,
): { condition: POICondition; testCount: number } {
  let testCount = 0;
  let mitigated = false;
  let invalidated = false;
  const invalidation = direction === "COMPRA" ? lower : upper;
  for (let j = originIndex + 1; j < seg.length; j++) {
    const c = seg[j]!;
    const overlaps = c.l <= upper && c.h >= lower;
    if (overlaps) {
      testCount++;
      const mid = (upper + lower) / 2;
      if (direction === "COMPRA" && c.c < mid) mitigated = true;
      if (direction === "VENDA" && c.c > mid) mitigated = true;
    }
    if (direction === "COMPRA" && c.c < invalidation) invalidated = true;
    if (direction === "VENDA" && c.c > invalidation) invalidated = true;
  }
  if (invalidated) return { condition: "invalidado", testCount };
  if (mitigated) return { condition: "mitigado", testCount };
  if (testCount > 0) return { condition: "testado", testCount };
  return { condition: "novo", testCount };
}

function nearbyLiquidity(upper: number, lower: number, liquidity: LiquidityMap, atr: number) {
  const mid = (upper + lower) / 2;
  const near = liquidity.levels
    .filter((l) => Math.abs(l.price - mid) <= atr * 0.5)
    .sort((a, b) => Math.abs(a.price - mid) - Math.abs(b.price - mid))[0];
  return near ?? null;
}

/**
 * CONSTRUÇÃO DE POIs — sem estado, sem look-ahead (só enxerga `window`).
 * POIs fracos (força < POI_CONFIG.minStrengthForSignal) NÃO autorizam sinal
 * sozinhos — essa checagem é feita em analysisPipeline.
 */
export function buildPOIs(
  window: Candle[],
  f: Features,
  wy: WyckoffRead,
  pa: PriceActionRead,
  liquidity: LiquidityMap,
): POI[] {
  if (window.length < 24) return [];
  const seg = window.slice(-120);

  const candidates: ZoneCandidate[] = [
    ...zonesFromLiquiditySweeps(seg, f, liquidity, wy, pa),
    ...zonesFromBreakRetest(seg, f, liquidity),
    ...zonesFromDisplacementOrigin(seg, f),
    ...zonesFromFVG(seg),
    ...zonesFromRangeExtremes(f),
  ];

  const pois: POI[] = candidates.map((cand, i) => {
    const { condition, testCount } = evaluateCondition(
      seg,
      cand.originIndex,
      cand.upper,
      cand.lower,
      cand.direction,
    );
    const liq = nearbyLiquidity(cand.upper, cand.lower, liquidity, f.atr);
    const ageBars = seg.length - 1 - cand.originIndex;

    let strength = cand.baseStrength;
    if (liq) strength += 12;
    if (wy.schema !== "Indefinido" && cand.wyckoffRelation.includes(wy.schema)) strength += 8;
    strength += Math.min(10, wy.confidence * 10);
    if (testCount === 1) strength += 4;
    else if (testCount > 3) strength -= (testCount - 3) * 5;
    strength -= Math.min(20, ageBars * 0.1);
    if (condition === "mitigado") strength -= 18;
    if (condition === "invalidado") strength -= 45;

    return {
      id: `poi_${cand.kind}_${i}_${Math.round((cand.upper + cand.lower) * 50)}`,
      kind: cand.kind,
      upper: Math.max(cand.upper, cand.lower),
      lower: Math.min(cand.upper, cand.lower),
      direction: cand.direction,
      originAt: cand.originAt,
      testCount,
      condition,
      strength: Math.max(0, Math.min(100, Math.round(strength))),
      reasons: cand.reasons,
      invalidation: cand.direction === "COMPRA" ? cand.lower : cand.upper,
      nearbyLiquidityId: liq?.id ?? null,
      wyckoffRelation: cand.wyckoffRelation,
    };
  });

  return pois
    .filter((p) => p.strength > 0)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, POI_CONFIG.maxPois);
}

/** Seleciona o POI principal: mais forte, alinhado à direção corrente, não invalidado e o mais próximo do preço. */
export function selectMainPoi(pois: POI[], price: number, direction: Direction): POI | null {
  const candidates = pois.filter(
    (p) => p.condition !== "invalidado" && (direction === "NEUTRO" || p.direction === direction),
  );
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    const strengthGap = b.strength - a.strength;
    if (Math.abs(strengthGap) > 15) return strengthGap; // POI bem mais forte vence
    const distA = Math.abs((a.upper + a.lower) / 2 - price);
    const distB = Math.abs((b.upper + b.lower) / 2 - price);
    return distA - distB; // força parecida: desempata pelo mais próximo do preço
  })[0]!;
}
