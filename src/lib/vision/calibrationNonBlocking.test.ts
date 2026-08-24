import { describe, expect, it } from "vitest";

import { analyze, PRICE_SCALE_BLOCKER } from "@/lib/engines/analysisPipeline";
import type { Candle, ReadingState } from "@/lib/engines/types";
import { extractCandlesFromPixels } from "@/lib/capture/frameProcessor";
import {
  CALIBRATION_SCHEDULE,
  CalibrationScheduler,
  calibrationSummary,
  ROI_CANDIDATES,
} from "@/lib/vision/calibrationScheduler";
import {
  calibrateFromAnchors,
  emptyCalibration,
  geometricCalibration,
  isReadable,
  priceAt,
  priceReliable,
} from "@/lib/vision/priceScale";

function series(count: number): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const up = i % 3 !== 0;
    const open = price;
    const close = up ? open + 0.6 : open - 0.4;
    candles.push({
      t: 1_700_000_000_000 + i * 60_000,
      o: open,
      h: Math.max(open, close) + 0.3,
      l: Math.min(open, close) - 0.3,
      c: close,
      v: 1_000,
    });
    price = close;
  }
  return candles;
}

function reading(priceScaleReady: boolean): ReadingState {
  return {
    sufficient: true,
    timeframeConfirmed: true,
    priceScaleReady,
    calibrationConfidence: priceScaleReady ? 100 : 0,
    candleQuality: 90,
    closedCandles: 60,
    lastCandleClosed: true,
    issues: [],
    label: "LEITURA SUFICIENTE",
  };
}

describe("gráfico visível = análise ativa (escala não bloqueia)", () => {
  it("calibração geométrica é legível mas nunca é preço confiável", () => {
    const geometric = geometricCalibration(720);
    expect(isReadable(geometric)).toBe(true);
    expect(priceReliable(geometric)).toBe(false);
    expect(geometric.status).toBe("geometrica");
    // topo do frame = maior valor
    expect(priceAt(geometric, 0)!).toBeGreaterThan(priceAt(geometric, 719)!);
  });

  it("escala vazia (sem âncora) não é legível", () => {
    expect(isReadable(emptyCalibration())).toBe(false);
    expect(priceAt(emptyCalibration(), 10)).toBeNull();
  });

  it("extrai candles do frame mesmo sem escala de preço calibrada", () => {
    const width = 60;
    const height = 100;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let x = 4; x < width; x += 8) {
      for (let y = 20; y < 70; y++) {
        for (let dx = 0; dx < 4; dx++) {
          const index = (y * width + x + dx) * 4;
          pixels[index] = 30;
          pixels[index + 1] = 200;
          pixels[index + 2] = 120;
          pixels[index + 3] = 255;
        }
      }
    }
    const frame = { data: pixels, width, height };
    const geometric = extractCandlesFromPixels(frame, geometricCalibration(height), 0);
    const blind = extractCandlesFromPixels(frame, emptyCalibration(), 0);
    expect(geometric.length).toBeGreaterThan(0);
    expect(blind.length).toBe(0);
  });

  it("análise estrutural roda sem escala e só bloqueia o preço exato", () => {
    const candles = series(80);
    const withoutScale = analyze(candles, { reading: reading(false) });
    expect(withoutScale).not.toBeNull();
    expect(withoutScale!.regime.regime.length).toBeGreaterThan(0);
    expect(withoutScale!.sequence.stages.length).toBeGreaterThan(0);
    expect(withoutScale!.evidences.length).toBeGreaterThan(0);
    expect(withoutScale!.blockers).toContain(PRICE_SCALE_BLOCKER);
    expect(withoutScale!.technicalReady).toBe(false);
  });

  it("mesma estrutura é lida com e sem escala calibrada", () => {
    const candles = series(80);
    const blind = analyze(candles, { reading: reading(false) })!;
    const calibrated = analyze(candles, { reading: reading(true) })!;
    expect(blind.regime.regime).toBe(calibrated.regime.regime);
    expect(blind.wyckoff.phase).toBe(calibrated.wyckoff.phase);
    expect(blind.sequence.complete).toBe(calibrated.sequence.complete);
    expect(calibrated.blockers).not.toContain(PRICE_SCALE_BLOCKER);
  });

  it("leitura estrutural insuficiente continua sendo o único gate da leitura", () => {
    const short = analyze(series(20), {
      reading: { ...reading(false), sufficient: false, issues: ["Poucos candles."] },
    });
    expect(short?.blockers).toContain("Leitura visual insuficiente.");
  });
});

describe("calibração como tarefa paralela", () => {
  it("primeira tentativa é imediata e as seguintes respeitam o backoff", () => {
    const scheduler = new CalibrationScheduler();
    expect(scheduler.shouldAttempt(0)).toBe(true);
    scheduler.markAttempt(0);
    scheduler.fail("sem âncoras");
    expect(scheduler.shouldAttempt(100)).toBe(false);
    expect(scheduler.shouldAttempt(CALIBRATION_SCHEDULE.maxDelayMs + 1)).toBe(true);
  });

  it("mudança relevante da imagem fura o backoff", () => {
    const scheduler = new CalibrationScheduler();
    scheduler.markAttempt(0);
    scheduler.fail("sem âncoras");
    expect(scheduler.shouldAttempt(50, true)).toBe(true);
  });

  it("autoajusta a região da escala após falhas repetidas na mesma ROI", () => {
    const scheduler = new CalibrationScheduler();
    expect(scheduler.roi()).toBe(ROI_CANDIDATES[0]);
    for (let i = 0; i < CALIBRATION_SCHEDULE.failuresPerRoi; i++) {
      scheduler.markAttempt(i * 10_000);
      scheduler.fail("escala não localizada");
    }
    expect(scheduler.roi()).toBe(ROI_CANDIDATES[1]);
    expect(scheduler.state().roiAdjustments).toBe(1);
  });

  it("ROI manual sobrepõe o autoajuste", () => {
    const scheduler = new CalibrationScheduler();
    scheduler.setManualRoi(0.5);
    for (let i = 0; i < 10; i++) scheduler.fail("falhou");
    expect(scheduler.roi()).toBe(0.5);
  });

  it("para de tentar quando calibra e volta a tentar quando invalida", () => {
    const scheduler = new CalibrationScheduler();
    scheduler.markAttempt(0);
    scheduler.succeed(2);
    expect(scheduler.shouldAttempt(999_999)).toBe(false);
    scheduler.invalidate("zoom mudou");
    expect(scheduler.shouldAttempt(1)).toBe(true);
    expect(scheduler.state().status).toBe("INVALIDATED");
  });

  it("resumo é uma linha consolidada com tentativas e âncoras", () => {
    const scheduler = new CalibrationScheduler();
    scheduler.markAttempt(Date.now());
    const state = scheduler.fail("apenas 1 âncora", 1);
    const summary = calibrationSummary(state);
    expect(summary).toContain("análise estrutural continua ativa");
    expect(summary).toContain("Tentativas: 1");
    expect(summary).toContain("Âncoras válidas: 1/2");
    scheduler.succeed(2);
    expect(calibrationSummary(scheduler.state())).toContain("Escala calibrada");
  });

  it("duas âncoras válidas produzem escala confiável de preço", () => {
    const calibration = calibrateFromAnchors([
      { y: 100, price: 110, raw: "110", source: "ocr", confidence: 1 },
      { y: 500, price: 100, raw: "100", source: "ocr", confidence: 1 },
    ]);
    expect(priceReliable(calibration)).toBe(true);
    expect(priceAt(calibration, 300)).toBeCloseTo(105, 1);
  });
});
