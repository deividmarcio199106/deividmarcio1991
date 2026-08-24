import { describe, expect, it } from "vitest";

import { analyze, pickTargetLiquidity } from "./analysisPipeline";
import type { Candle, LiquidityMap, ReadingState } from "./types";

const liquidity: LiquidityMap = {
  levels: [
    {
      id: "top-1",
      price: 103,
      kind: "compradora",
      origin: "topo_anterior",
      testCount: 1,
      formedAt: 1,
      ageBars: 3,
      relevance: 70,
      status: "disponivel",
      internal: false,
    },
    {
      id: "top-2",
      price: 106,
      kind: "compradora",
      origin: "topo_anterior",
      testCount: 1,
      formedAt: 1,
      ageBars: 2,
      relevance: 70,
      status: "disponivel",
      internal: false,
    },
    {
      id: "low-1",
      price: 97,
      kind: "vendedora",
      origin: "fundo_anterior",
      testCount: 1,
      formedAt: 1,
      ageBars: 3,
      relevance: 70,
      status: "disponivel",
      internal: false,
    },
    {
      id: "low-2",
      price: 94,
      kind: "vendedora",
      origin: "fundo_anterior",
      testCount: 1,
      formedAt: 1,
      ageBars: 2,
      relevance: 70,
      status: "disponivel",
      internal: false,
    },
  ],
  nearestBuy: null,
  nearestSell: null,
  lastEvent: null,
  events: [],
};

const reading: ReadingState = {
  sufficient: true,
  timeframeConfirmed: true,
  priceScaleReady: true,
  calibrationConfidence: 100,
  candleQuality: 100,
  closedCandles: 30,
  lastCandleClosed: true,
  issues: [],
  label: "LEITURA SUFICIENTE",
};

describe("pipeline visual V4", () => {
  it("compra mira a liquidez compradora mais próxima acima; venda mira a vendedora abaixo", () => {
    expect(pickTargetLiquidity(liquidity, "COMPRA", 100)).toBe(103);
    expect(pickTargetLiquidity(liquidity, "VENDA", 100)).toBe(97);
    expect(pickTargetLiquidity(liquidity, "NEUTRO", 100)).toBeNull();
  });

  it("não analisa menos de 12 candles e nunca cria série substituta", () => {
    const candles: Candle[] = Array.from({ length: 11 }, (_, index) => ({
      t: index * 60_000,
      o: 100,
      h: 101,
      l: 99,
      c: 100,
      v: 0,
    }));
    expect(analyze(candles, { reading })).toBeNull();
  });
});
