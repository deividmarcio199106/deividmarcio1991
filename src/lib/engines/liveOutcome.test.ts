import { describe, expect, it } from "vitest";

import { LiveOutcomeTracker } from "./liveOutcome";
import type { Candle } from "./types";

const bar = (l: number, h: number, c = (l + h) / 2): Candle => ({
  t: 0,
  o: (l + h) / 2,
  h,
  l,
  c,
  v: 0,
});

describe("rastreador de desfecho ao vivo", () => {
  it("segue AGUARDANDO → ENTRADA → PARCIAL → ALVO com resultado 0.6·rr1 + 0.4·rr2", () => {
    const tracker = new LiveOutcomeTracker("COMPRA", 100, 95, 108, 114);
    expect(tracker.push(bar(101, 105)).status).toBe("AGUARDANDO ENTRADA");
    expect(tracker.push(bar(99, 103)).status).toBe("ENTRADA ATINGIDA");
    expect(tracker.push(bar(100, 109)).status).toBe("PARCIAL ATINGIDA");
    const final = tracker.push(bar(107, 115));
    expect(final.status).toBe("ALVO ATINGIDO");
    expect(final.done).toBe(true);
    expect(final.result).toBe("GANHO");
    expect(final.rMultiple).toBeCloseTo(0.6 * 1.6 + 0.4 * 2.8, 3);
    expect(final.mfePoints).toBeGreaterThanOrEqual(15);
  });

  it("stop antes da parcial = -1R; mesmo candle stop+alvo resolve como stop", () => {
    const tracker = new LiveOutcomeTracker("COMPRA", 100, 95, 108, 114);
    tracker.push(bar(99, 103));
    const final = tracker.push(bar(94, 115));
    expect(final.status).toBe("STOP ATINGIDO");
    expect(final.rMultiple).toBe(-1);
    expect(final.ambiguousIntrabar).toBe(true); // §24: auditável
    expect(final.exitReason).toBe("stop");
  });

  it("venda espelhada: parcial e stop no lado correto", () => {
    const tracker = new LiveOutcomeTracker("VENDA", 100, 105, 92, 86);
    tracker.push(bar(97, 101)); // executa
    expect(tracker.push(bar(90, 96)).status).toBe("PARCIAL ATINGIDA");
    const final = tracker.push(bar(99, 106));
    expect(final.status).toBe("STOP ATINGIDO");
    expect(final.result).toBe("GANHO"); // 0.6*1.6 - 0.4 > 0
  });

  it("sinal expira sem execução após a janela máxima", () => {
    const tracker = new LiveOutcomeTracker("COMPRA", 100, 95, 108, 114, 3);
    tracker.push(bar(101, 105));
    tracker.push(bar(102, 106));
    const final = tracker.push(bar(103, 107));
    expect(final.status).toBe("EXPIRADA");
    expect(final.done).toBe(true);
    expect(final.result).toBe("NEUTRO");
    expect(final.rMultiple).toBe(0);
  });

  it("depois de done, novos candles não mudam nada", () => {
    const tracker = new LiveOutcomeTracker("COMPRA", 100, 95, 108, 114);
    tracker.push(bar(99, 103));
    tracker.push(bar(94, 100));
    const frozen = tracker.current();
    const after = tracker.push(bar(90, 120));
    expect(after).toEqual(frozen);
  });
  it("registra os instantes reais de entrada, parcial e saída", () => {
    const tracker = new LiveOutcomeTracker("COMPRA", 100, 95, 108, 114);
    const candle = (t: number, l: number, h: number): Candle => ({
      t,
      o: (l + h) / 2,
      h,
      l,
      c: (l + h) / 2,
      v: 0,
    });
    tracker.push(candle(1_000, 99, 103));
    tracker.push(candle(2_000, 100, 109));
    const final = tracker.push(candle(3_000, 107, 115));
    expect(final.entryHitAt).toBe(1_000);
    expect(final.partialHitAt).toBe(2_000);
    expect(final.exitAt).toBe(3_000);
  });
});
