import { LIQUIDITY_CONFIG, HSS_CONFIG } from "./strategy";
import type { Features } from "./marketFeatures";
import type {
  Candle,
  LiquidityEventRead,
  LiquidityKind,
  LiquidityLevel,
  LiquidityMap,
  LiquidityOrigin,
  LiquidityStatus,
} from "./types";

interface Fractal {
  index: number;
  price: number;
  t: number;
  kind: "topo" | "fundo";
}

/** Fractal simples de 5 barras (2 candles de cada lado) — não usa dado futuro real: só é confirmado quando os 2 candles seguintes já fecharam. */
function findFractals(seg: Candle[]): Fractal[] {
  const out: Fractal[] = [];
  for (let i = 2; i < seg.length - 2; i++) {
    const c = seg[i]!;
    const left = seg.slice(i - 2, i);
    const right = seg.slice(i + 1, i + 3);
    const isHigh = [...left, ...right].every((o) => o.h <= c.h);
    const isLow = [...left, ...right].every((o) => o.l >= c.l);
    if (isHigh) out.push({ index: i, price: c.h, t: c.t, kind: "topo" });
    if (isLow) out.push({ index: i, price: c.l, t: c.t, kind: "fundo" });
  }
  return out;
}

/** Agrupa fractais do mesmo tipo que estão a menos de `tolerance` um do outro — "topos/fundos iguais". */
function groupEqualLevels(
  fractals: Fractal[],
  tolerance: number,
): { price: number; t: number; index: number; testCount: number }[] {
  const sorted = [...fractals].sort((a, b) => a.price - b.price);
  const groups: { price: number; t: number; index: number; testCount: number }[] = [];
  for (const f of sorted) {
    const existing = groups.find((g) => Math.abs(g.price - f.price) <= tolerance);
    if (existing) {
      existing.testCount++;
      if (f.index > existing.index) {
        existing.index = f.index;
        existing.t = f.t;
      }
      existing.price = (existing.price * (existing.testCount - 1) + f.price) / existing.testCount;
    } else {
      groups.push({ price: f.price, t: f.t, index: f.index, testCount: 1 });
    }
  }
  return groups;
}

function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

const ORIGIN_BASE_RELEVANCE: Record<LiquidityOrigin, number> = {
  maxima_dia_anterior: 88,
  minima_dia_anterior: 88,
  maxima_sessao: 72,
  minima_sessao: 72,
  topo_igual: 78,
  fundo_igual: 78,
  topo_anterior: 55,
  fundo_anterior: 55,
  extremo_range: 50,
  abertura_dia: 58,
  gap: 45,
};

const TOP_ORIGINS = new Set<LiquidityOrigin>([
  "maxima_dia_anterior",
  "maxima_sessao",
  "topo_igual",
  "topo_anterior",
]);
const BOTTOM_ORIGINS = new Set<LiquidityOrigin>([
  "minima_dia_anterior",
  "minima_sessao",
  "fundo_igual",
  "fundo_anterior",
]);
/** Externa = referência de contexto maior (dia/sessão); interna = estrutura local do range corrente. */
const EXTERNAL_ORIGINS = new Set<LiquidityOrigin>([
  "maxima_dia_anterior",
  "minima_dia_anterior",
  "maxima_sessao",
  "minima_sessao",
  "extremo_range",
]);

interface RawLevel {
  price: number;
  origin: LiquidityOrigin;
  formedAt: number;
  formedIndex: number;
  testCount: number;
}

function collectRawLevels(window: Candle[], f: Features): RawLevel[] {
  const seg = window.slice(-LIQUIDITY_CONFIG.lookbackBars);
  const tol = f.atr * LIQUIDITY_CONFIG.equalLevelToleranceAtr;
  const fractals = findFractals(seg);
  const tops = fractals.filter((x) => x.kind === "topo");
  const bottoms = fractals.filter((x) => x.kind === "fundo");

  const raw: RawLevel[] = [];

  for (const g of groupEqualLevels(tops, tol))
    raw.push({
      price: g.price,
      origin: g.testCount >= 2 ? "topo_igual" : "topo_anterior",
      formedAt: g.t,
      formedIndex: g.index,
      testCount: g.testCount,
    });
  for (const g of groupEqualLevels(bottoms, tol))
    raw.push({
      price: g.price,
      origin: g.testCount >= 2 ? "fundo_igual" : "fundo_anterior",
      formedAt: g.t,
      formedIndex: g.index,
      testCount: g.testCount,
    });

  // Extremos do range recente (último "range" já usado pelo restante do motor).
  raw.push({
    price: f.rangeHigh,
    origin: "extremo_range",
    formedAt: seg[0]?.t ?? window[0]!.t,
    formedIndex: 0,
    testCount: 1,
  });
  raw.push({
    price: f.rangeLow,
    origin: "extremo_range",
    formedAt: seg[0]?.t ?? window[0]!.t,
    formedIndex: 0,
    testCount: 1,
  });

  // Agrupamento por dia — máxima/mínima do dia anterior, sessão (dia corrente) e abertura do dia.
  const byDay = new Map<string, Candle[]>();
  for (const c of seg) {
    const k = dayKey(c.t);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k)!.push(c);
  }
  const days = [...byDay.entries()];
  if (days.length >= 2) {
    const [, prevCandles] = days[days.length - 2]!;
    const prevHigh = Math.max(...prevCandles.map((c) => c.h));
    const prevLow = Math.min(...prevCandles.map((c) => c.l));
    raw.push({
      price: prevHigh,
      origin: "maxima_dia_anterior",
      formedAt: prevCandles[prevCandles.length - 1]!.t,
      formedIndex: seg.indexOf(prevCandles[prevCandles.length - 1]!),
      testCount: 1,
    });
    raw.push({
      price: prevLow,
      origin: "minima_dia_anterior",
      formedAt: prevCandles[prevCandles.length - 1]!.t,
      formedIndex: seg.indexOf(prevCandles[prevCandles.length - 1]!),
      testCount: 1,
    });
  }
  const [, curCandles] = days[days.length - 1]!;
  if (curCandles.length >= 4) {
    const curHigh = Math.max(...curCandles.map((c) => c.h));
    const curLow = Math.min(...curCandles.map((c) => c.l));
    const openIdx = seg.indexOf(curCandles[0]!);
    raw.push({
      price: curHigh,
      origin: "maxima_sessao",
      formedAt: curCandles[0]!.t,
      formedIndex: openIdx,
      testCount: 1,
    });
    raw.push({
      price: curLow,
      origin: "minima_sessao",
      formedAt: curCandles[0]!.t,
      formedIndex: openIdx,
      testCount: 1,
    });
    raw.push({
      price: curCandles[0]!.o,
      origin: "abertura_dia",
      formedAt: curCandles[0]!.t,
      formedIndex: openIdx,
      testCount: 1,
    });
  }

  // Gaps / desequilíbrios entre candles consecutivos (fair value gap por preço, sem inventar volume).
  for (let i = 2; i < seg.length; i++) {
    const a = seg[i - 2]!;
    const c = seg[i]!;
    if (c.l > a.h) {
      raw.push({
        price: (c.l + a.h) / 2,
        origin: "gap",
        formedAt: c.t,
        formedIndex: i,
        testCount: 1,
      });
    } else if (c.h < a.l) {
      raw.push({
        price: (c.h + a.l) / 2,
        origin: "gap",
        formedAt: c.t,
        formedIndex: i,
        testCount: 1,
      });
    }
  }

  return raw;
}

function classifyKind(origin: LiquidityOrigin, price: number, currentPrice: number): LiquidityKind {
  if (TOP_ORIGINS.has(origin)) return "compradora";
  if (BOTTOM_ORIGINS.has(origin)) return "vendedora";
  if (origin === "extremo_range") return price >= currentPrice ? "compradora" : "vendedora";
  // gap / abertura_dia: caráter direcional depende de onde o preço está agora.
  return price > currentPrice ? "compradora" : "vendedora";
}

/**
 * Varre o segmento após a formação do nível para classificar o estado atual
 * e coletar eventos objetivos (nunca inferidos, sempre a partir de high/low/close reais).
 */
function scanLevel(
  seg: Candle[],
  formedIndex: number,
  price: number,
  kind: LiquidityKind,
  atr: number,
): { status: LiquidityStatus; events: LiquidityEventRead[] } {
  const touchDist = atr * LIQUIDITY_CONFIG.touchAtr;
  const approachDist = atr * LIQUIDITY_CONFIG.approachAtr;
  const events: LiquidityEventRead[] = [];
  let status: LiquidityStatus = "disponivel";
  let sweptAt = -1;

  const isTop = kind === "compradora";

  for (let j = Math.max(formedIndex + 1, 0); j < seg.length; j++) {
    const c = seg[j]!;
    const extreme = isTop ? c.h : c.l;
    const beyond = isTop ? extreme > price : extreme < price;
    const closedBeyond = isTop ? c.c > price : c.c < price;
    const distToPrice = Math.abs(extreme - price);

    if (beyond && !closedBeyond) {
      // pavio além do nível, fechamento de volta do lado de origem: varredura.
      sweptAt = j;
      status = "varrida";
      events.push({
        t: c.t,
        levelId: "",
        type: "varredura",
        direction: isTop ? "VENDA" : "COMPRA",
      });
      // Rejeição: pavio contra proporcionalmente grande.
      const range = Math.max(c.h - c.l, 1e-9);
      const wick = isTop ? (c.h - Math.max(c.o, c.c)) / range : (Math.min(c.o, c.c) - c.l) / range;
      if (wick >= HSS_CONFIG.minRejectionWick) {
        status = "rejeitada";
        events.push({
          t: c.t,
          levelId: "",
          type: "rejeicao",
          direction: isTop ? "VENDA" : "COMPRA",
        });
      }
    } else if (beyond && closedBeyond) {
      // Fechou além do nível — checar se sustenta (aceitação) ou volta (falso rompimento).
      const holdWindow = seg.slice(j + 1, j + 1 + 3);
      const held =
        holdWindow.length > 0 && holdWindow.every((h) => (isTop ? h.c > price : h.c < price));
      const reverted = holdWindow.some((h) => (isTop ? h.c < price : h.c > price));
      if (held) {
        status = "rompida_com_aceitacao";
        events.push({
          t: c.t,
          levelId: "",
          type: "rompimento_aceitacao",
          direction: isTop ? "COMPRA" : "VENDA",
        });
      } else if (reverted || holdWindow.length === 0) {
        status = "falso_rompimento";
        events.push({
          t: c.t,
          levelId: "",
          type: "falso_rompimento",
          direction: isTop ? "VENDA" : "COMPRA",
        });
      }
    } else if (distToPrice <= touchDist && status === "disponivel") {
      status = "tocada";
      events.push({ t: c.t, levelId: "", type: "toque", direction: isTop ? "VENDA" : "COMPRA" });
    } else if (distToPrice <= approachDist && status === "disponivel") {
      status = "aproximada";
      events.push({
        t: c.t,
        levelId: "",
        type: "aproximacao",
        direction: isTop ? "VENDA" : "COMPRA",
      });
    }

    // Captura seguida de reversão: após uma varredura, deslocamento sustentado contrário.
    if (sweptAt >= 0 && j > sweptAt && j - sweptAt <= HSS_CONFIG.rejectionWindowBars) {
      const post = seg.slice(sweptAt + 1, j + 1);
      const displaced = post.length >= 2 && post.every((h) => (isTop ? h.c < price : h.c > price));
      if (displaced) {
        status = "capturada_com_reversao";
        events.push({
          t: c.t,
          levelId: "",
          type: "captura_reversao",
          direction: isTop ? "VENDA" : "COMPRA",
        });
        sweptAt = -1;
      }
    }
  }

  return { status, events };
}

/**
 * MAPA DE LIQUIDEZ — puro e sem estado (mesmo padrão dos demais motores):
 * recalculado a cada janela, sem look-ahead (só enxerga `window`).
 */
export function buildLiquidityMap(window: Candle[], f: Features): LiquidityMap {
  if (window.length < 24) {
    return { levels: [], nearestBuy: null, nearestSell: null, lastEvent: null, events: [] };
  }

  const seg = window.slice(-LIQUIDITY_CONFIG.lookbackBars);
  const raw = collectRawLevels(window, f);
  const currentPrice = f.price;

  const levels: LiquidityLevel[] = [];
  const allEvents: LiquidityEventRead[] = [];

  raw.forEach((r, i) => {
    const kind = classifyKind(r.origin, r.price, currentPrice);
    const { status, events } = scanLevel(seg, r.formedIndex, r.price, kind, f.atr);
    const ageBars = seg.length - 1 - r.formedIndex;
    const relevance = Math.max(
      0,
      Math.min(
        100,
        ORIGIN_BASE_RELEVANCE[r.origin] +
          Math.min(20, (r.testCount - 1) * 8) -
          Math.min(25, ageBars * 0.15) +
          (status === "rompida_com_aceitacao" ? -30 : 0),
      ),
    );
    if (relevance < LIQUIDITY_CONFIG.minRelevance) return;

    const id = `liq_${r.origin}_${Math.round(r.price * 100)}_${i}`;
    levels.push({
      id,
      price: r.price,
      kind,
      origin: r.origin,
      testCount: r.testCount,
      formedAt: r.formedAt,
      ageBars,
      relevance,
      status,
      internal: !EXTERNAL_ORIGINS.has(r.origin),
    });
    for (const e of events) allEvents.push({ ...e, levelId: id });
  });

  // Deduplicar níveis quase idênticos (dois raw origins convergindo no mesmo preço).
  const dedup: LiquidityLevel[] = [];
  for (const lv of levels.sort((a, b) => b.relevance - a.relevance)) {
    const dupe = dedup.find(
      (d) => Math.abs(d.price - lv.price) < f.atr * 0.1 && d.kind === lv.kind,
    );
    if (!dupe) dedup.push(lv);
  }

  const top = dedup.sort((a, b) => b.relevance - a.relevance).slice(0, LIQUIDITY_CONFIG.maxLevels);
  const keptIds = new Set(top.map((l) => l.id));
  const events = allEvents
    .filter((e) => keptIds.has(e.levelId))
    .sort((a, b) => b.t - a.t)
    .slice(0, 20);

  const active = top.filter((l) => l.status !== "rompida_com_aceitacao");
  const nearestBuy =
    active
      .filter((l) => l.kind === "compradora")
      .sort((a, b) => Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice))[0] ??
    null;
  const nearestSell =
    active
      .filter((l) => l.kind === "vendedora")
      .sort((a, b) => Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice))[0] ??
    null;

  const lastEvent = events[0] ?? null;

  return {
    levels: top.sort((a, b) => Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice)),
    nearestBuy,
    nearestSell,
    lastEvent,
    events,
  };
}

/** Distância (em ATR) do preço até o nível de liquidez mais próximo relevante — usado pela análise de risco. */
export function distanceToNearestLiquidity(map: LiquidityMap, price: number, atr: number): number {
  const all = [map.nearestBuy, map.nearestSell].filter((x): x is LiquidityLevel => x !== null);
  if (all.length === 0) return Infinity;
  const dist = Math.min(...all.map((l) => Math.abs(l.price - price)));
  return dist / Math.max(atr, 1e-9);
}
