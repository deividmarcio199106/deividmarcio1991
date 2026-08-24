import { describe, expect, it } from "vitest";

import {
  extractCandlesFromPixels,
  frameHash,
  inspectPixelFrame,
  timeAxisCropBounds,
  type PixelFrame,
} from "./frameProcessor";
import type { Calibration } from "@/lib/vision/priceScale";

function fixtureFrame(): PixelFrame {
  const width = 100;
  const height = 60;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 3; index < data.length; index += 4) data[index] = 255;

  const set = (x: number, y: number, side: "bull" | "bear") => {
    const index = (y * width + x) * 4;
    if (side === "bull") {
      data[index] = 20;
      data[index + 1] = 220;
      data[index + 2] = 70;
    } else {
      data[index] = 225;
      data[index + 1] = 40;
      data[index + 2] = 35;
    }
  };
  const candle = (
    from: number,
    side: "bull" | "bear",
    wickTop: number,
    bodyTop: number,
    bodyBottom: number,
    wickBottom: number,
  ) => {
    for (let x = from; x < from + 4; x++) {
      for (let y = bodyTop; y <= bodyBottom; y++) set(x, y, side);
    }
    for (let y = wickTop; y <= wickBottom; y++) set(from + 1, y, side);
  };

  candle(10, "bull", 14, 20, 26, 31);
  candle(30, "bear", 18, 23, 29, 35);
  candle(50, "bull", 10, 16, 22, 28); // candle mais à direita: em formação
  return { data, width, height };
}

const calibration: Calibration = {
  status: "calibrada",
  usable: true,
  slope: -1,
  intercept: 200,
  anchors: [
    { y: 0, price: 200, raw: "200", source: "manual", confidence: 1 },
    { y: 60, price: 140, raw: "140", source: "manual", confidence: 1 },
  ],
  decimals: 0,
  tickSize: 1,
  r2: 1,
  maxResidualPx: 0,
  confidence: 100,
  reason: "Calibração válida.",
};

describe("processamento visual do frame", () => {
  it("localiza atividade e preço visual sem fabricar cotação", () => {
    const read = inspectPixelFrame(fixtureFrame());
    expect(read.priceY).toBe(16);
    expect(read.bullMass).toBeGreaterThan(0);
    expect(read.bearMass).toBeGreaterThan(0);
    expect(read.quality).toBeGreaterThan(0);
  });

  it("extrai OHLC pela escala real, exclui a vela aberta e mantém volume zero", () => {
    const candles = extractCandlesFromPixels(fixtureFrame(), calibration, 1_700_000_060_000);
    expect(candles).toHaveLength(2);
    expect(candles[0]!.c).toBeGreaterThan(candles[0]!.o);
    expect(candles[1]!.c).toBeLessThan(candles[1]!.o);
    expect(candles.every((candle) => candle.v === 0)).toBe(true);
    expect(candles[1]!.t - candles[0]!.t).toBe(60_000);
  });

  it("candle em formação estreito (<2px) não descarta o último candle FECHADO", () => {
    // Regressão: a ordem antiga (filtrar largura -> remover o último) fazia o
    // filtro engolir a vela em formação de 1px e o slice remover a última vela
    // fechada real, deslocando todos os timestamps em 1 minuto.
    const width = 100;
    const height = 60;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 3; index < data.length; index += 4) data[index] = 255;
    const set = (x: number, y: number) => {
      const index = (y * width + x) * 4;
      data[index] = 20;
      data[index + 1] = 220;
      data[index + 2] = 70;
    };
    for (let x = 10; x < 14; x++) for (let y = 20; y <= 26; y++) set(x, y);
    for (let x = 30; x < 34; x++) for (let y = 23; y <= 29; y++) set(x, y);
    // Vela em formação recém-aberta: coluna única de 1px.
    for (let y = 24; y <= 27; y++) set(50, y);

    const lastClosedAt = 1_700_000_060_000;
    const candles = extractCandlesFromPixels({ data, width, height }, calibration, lastClosedAt);
    expect(candles).toHaveLength(2);
    expect(candles[1]!.t).toBe(lastClosedAt);
  });

  it("mantém candle histórico fechado de 1px quando o gráfico está comprimido", () => {
    const width = 100;
    const height = 60;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 3; index < data.length; index += 4) data[index] = 255;
    const set = (x: number, y: number, r: number, g: number, b: number) => {
      const index = (y * width + x) * 4;
      data[index] = r;
      data[index + 1] = g;
      data[index + 2] = b;
    };
    // Dois candles fechados estreitos e um candle aberto à direita.
    for (let y = 18; y <= 25; y++) set(15, y, 20, 220, 70);
    for (let y = 22; y <= 30; y++) set(25, y, 225, 40, 35);
    for (let y = 24; y <= 28; y++) set(40, y, 20, 220, 70);

    const candles = extractCandlesFromPixels(
      { data, width, height },
      calibration,
      1_700_000_060_000,
    );
    expect(candles).toHaveLength(2);
    expect(candles[0]!.c).toBeGreaterThanOrEqual(candles[0]!.o);
    expect(candles[1]!.c).toBeLessThanOrEqual(candles[1]!.o);
  });

  it("não produz candles sem calibração válida", () => {
    expect(extractCandlesFromPixels(fixtureFrame(), { ...calibration, usable: false }, 0)).toEqual(
      [],
    );
  });
});

describe("hash de frame (spec V5 §8)", () => {
  it("frames idênticos têm o mesmo hash; um pixel diferente muda o hash", () => {
    const a = fixtureFrame();
    const b = fixtureFrame();
    expect(frameHash(a.data)).toBe(frameHash(b.data));
    b.data[0] = (b.data[0]! + 1) % 256;
    expect(frameHash(b.data)).not.toBe(frameHash(a.data));
  });
});

describe("ROI do eixo de tempo do Profit", () => {
  it("captura a faixa do eixo e exclui a extrema direita/barra inferior", () => {
    const band = timeAxisCropBounds(1340, 596);
    expect(band.y).toBeGreaterThanOrEqual(Math.floor(596 * 0.82));
    expect(band.y + band.height).toBeLessThanOrEqual(Math.ceil(596 * 0.95));
    expect(band.width).toBeLessThan(1340);
    expect(band.width).toBeGreaterThan(1200);
  });
});
