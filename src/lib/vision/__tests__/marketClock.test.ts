import { describe, expect, it } from "vitest";

import { MarketClock } from "../marketClock";
import type { ChartClockRead } from "../chartClock";

function read(time: string, confidence = 0.9, date: string | null = "2026-08-07"): ChartClockRead {
  return { date, time, asset: "WINFUT", timeframe: "1 min", confidence };
}

describe("MarketClock (comando §4)", () => {
  it("marketTime = chartClock quando a leitura é válida", () => {
    const clock = new MarketClock();
    const at = Date.UTC(2026, 7, 7, 12, 0, 0);
    clock.update(read("10:30"), at);
    const now = clock.now(at);
    expect(now.source).toBe("CHART_CLOCK");
    const emitted = new Date(now.t);
    expect(emitted.getHours()).toBe(10);
    expect(emitted.getMinutes()).toBe(30);
  });

  it("avança com o delta local entre leituras — replay acelerado fecha candle sem esperar 1 min real", () => {
    const clock = new MarketClock();
    const at = 1_700_000_000_000;
    clock.update(read("10:30"), at);
    const first = clock.now(at).t;
    // 6 segundos reais depois, o replay 10x mostra 10:31 no gráfico:
    clock.update(read("10:31"), at + 6_000);
    const second = clock.now(at + 6_000).t;
    expect(second - first).toBeGreaterThanOrEqual(59_000); // pulou ~1 minuto de gráfico
  });

  it("fallback realtime SOMENTE sem chartClock, com motivo registrado", () => {
    const clock = new MarketClock();
    const now = clock.now(1_700_000_000_000);
    expect(now.source).toBe("REALTIME_FALLBACK");
    expect(clock.snapshot().fallbackReason).toBeTruthy();
  });

  it("leitura com confiança baixa não vira relógio oficial", () => {
    const clock = new MarketClock();
    clock.update(read("10:30", 0.2), 1_700_000_000_000);
    expect(clock.valid(1_700_000_000_000)).toBe(false);
  });

  it("é monotônico: correção de OCR nunca volta o tempo já emitido", () => {
    const clock = new MarketClock();
    const at = 1_700_000_000_000;
    clock.update(read("10:30"), at);
    const first = clock.now(at).t;
    // OCR "corrige" para um horário anterior:
    clock.update(read("10:20"), at + 1_000);
    const second = clock.now(at + 1_000).t;
    expect(second).toBeGreaterThanOrEqual(first);
  });

  it("leitura envelhecida volta ao fallback declarando o motivo", () => {
    const clock = new MarketClock();
    const at = 1_700_000_000_000;
    clock.update(read("10:30"), at);
    const later = clock.now(at + 10 * 60_000);
    expect(later.source).toBe("REALTIME_FALLBACK");
    expect(clock.snapshot().fallbackReason).toContain("envelheceu");
  });
});
