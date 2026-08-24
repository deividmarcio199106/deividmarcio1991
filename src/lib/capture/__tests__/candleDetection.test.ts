import { describe, expect, it } from "vitest";

import { extractCandlesFromPixels, inspectPixelFrame, type PixelFrame } from "../frameProcessor";
import { geometricCalibration } from "@/lib/vision/priceScale";

/**
 * Reproduz o layout do Profit em pixels sintéticos, incluindo o elemento que
 * quebrava o detector: a linha horizontal de último preço.
 */
const W = 400;
const H = 300;

function blankFrame(): PixelFrame {
  const data = new Uint8ClampedArray(W * H * 4);
  // Fundo quase preto, como o tema escuro do Profit.
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 26;
    data[i + 1] = 26;
    data[i + 2] = 26;
    data[i + 3] = 255;
  }
  return { data, width: W, height: H };
}

function paint(frame: PixelFrame, x: number, y: number, bull: boolean): void {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 4;
  frame.data[i] = bull ? 0 : 229;
  frame.data[i + 1] = bull ? 200 : 57;
  frame.data[i + 2] = bull ? 83 : 53;
  frame.data[i + 3] = 255;
}

/** Candle com corpo e pavio, dentro da ROI (x 2%–88%, y 13%–86%). */
function drawCandle(
  frame: PixelFrame,
  xStart: number,
  width: number,
  top: number,
  bottom: number,
  bull: boolean,
) {
  const mid = xStart + Math.floor(width / 2);
  for (let y = top; y <= bottom; y += 1) paint(frame, mid, y, bull);
  const bodyTop = top + 10;
  const bodyBottom = bottom - 10;
  for (let x = xStart; x < xStart + width; x += 1) {
    for (let y = bodyTop; y <= bodyBottom; y += 1) paint(frame, x, y, bull);
  }
}

/** A linha de último preço: colorida, fina, atravessando o gráfico inteiro. */
function drawPriceLine(frame: PixelFrame, y: number) {
  for (let x = 10; x < W - 40; x += 1) {
    paint(frame, x, y, false);
    paint(frame, x, y + 1, false);
  }
}

function frameComCandles(count: number, comLinha: boolean): PixelFrame {
  const frame = blankFrame();
  const pitch = 22;
  const width = 12;
  for (let i = 0; i < count; i += 1) {
    const x = 20 + i * pitch;
    drawCandle(frame, x, width, 60 + (i % 3) * 8, 200 - (i % 4) * 6, i % 2 === 0);
  }
  if (comLinha) drawPriceLine(frame, 150);
  return frame;
}

describe("detector de candles", () => {
  it("separa candles vizinhos em vez de fundir tudo", () => {
    const read = inspectPixelFrame(frameComCandles(8, false));
    expect(read.candleColumns).toBeGreaterThan(1);
  });

  it("a linha de último preço NÃO funde os candles num cluster só", () => {
    // O bug real do Golden: CANDLES_VISIBLE=1 e CANDLES_PARSED=0. Uma linha
    // colorida de 2px de altura atravessando o grafico deixava toda coluna
    // "ativa", e nenhum intervalo separava mais nada.
    const semLinha = inspectPixelFrame(frameComCandles(8, false));
    const comLinha = inspectPixelFrame(frameComCandles(8, true));
    expect(comLinha.candleColumns).toBeGreaterThan(1);
    expect(comLinha.candleColumns).toBe(semLinha.candleColumns);
  });

  it("extrai OHLC de vários candles mesmo com a linha presente", () => {
    const candles = extractCandlesFromPixels(frameComCandles(8, true), geometricCalibration(H), 0);
    // O extrator descarta o ultimo cluster (candle em formacao).
    expect(candles.length).toBeGreaterThan(1);
    for (const candle of candles) {
      expect(candle.h).toBeGreaterThanOrEqual(Math.max(candle.o, candle.c));
      expect(candle.l).toBeLessThanOrEqual(Math.min(candle.o, candle.c));
      expect(candle.h).toBeGreaterThanOrEqual(candle.l);
    }
  });

  it("candles já visíveis em T0 alimentam o bootstrap de uma vez", () => {
    // Nao e lookahead: estao desenhados na tela quando a leitura comeca.
    const candles = extractCandlesFromPixels(
      frameComCandles(14, false),
      geometricCalibration(H),
      0,
    );
    expect(candles.length).toBeGreaterThanOrEqual(10);
  });

  it("tela vazia não inventa candle", () => {
    const read = inspectPixelFrame(blankFrame());
    expect(read.candleColumns).toBe(0);
    expect(extractCandlesFromPixels(blankFrame(), geometricCalibration(H), 0)).toEqual([]);
  });

  it("só a linha de preço, sem candle nenhum, não vira candle", () => {
    const frame = blankFrame();
    drawPriceLine(frame, 150);
    const read = inspectPixelFrame(frame);
    // Duas linhas de altura nao sao material de candle.
    expect(read.candleColumns).toBe(0);
  });

  it("detecta direção pela cor dominante do corpo", () => {
    const frame = blankFrame();
    drawCandle(frame, 40, 12, 60, 200, true);
    drawCandle(frame, 80, 12, 60, 200, false);
    drawCandle(frame, 120, 12, 60, 200, true);
    const candles = extractCandlesFromPixels(frame, geometricCalibration(H), 0);
    expect(candles.length).toBeGreaterThanOrEqual(2);
  });
});
