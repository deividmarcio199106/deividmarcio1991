import { describe, expect, it } from "vitest";

import { createSignalSnapshot } from "../signalSnapshot";
import { hasPlayed, playConfirmationOnce, resetSignalSoundForTests } from "../signalSound";
import type { Candle } from "@/lib/engines/types";

const candle: Candle = { t: 1_700_000_000_000, o: 100, h: 105, l: 99, c: 104, v: 0 };

function build() {
  return createSignalSnapshot({
    asset: "WINFUT",
    chartTimestamp: candle.t,
    direction: "COMPRA",
    entry: 100,
    initialStop: 95,
    threeR: 115,
    fiveR: 125,
    setup: "TREND_FIRST_PULLBACK",
    confirmationCandle: candle,
  });
}

describe("TradeSignalSnapshot (comando §7)", () => {
  it("carrega signalId, versão T4.0.0 e níveis congelados", () => {
    const snapshot = build();
    expect(snapshot.signalId).toBe(`sig_WINFUT_${candle.t}_COMPRA`);
    expect(snapshot.version).toBe("T4.0.0");
    expect(snapshot.entry).toBe(100);
    expect(snapshot.initialStop).toBe(95);
    expect(snapshot.threeR).toBe(115);
    expect(snapshot.fiveR).toBe(125);
    expect(snapshot.runnerInitial).toBe(95);
  });

  it("é IMUTÁVEL: reescrever entrada/stop/3R/5R falha", () => {
    const snapshot = build();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => {
      (snapshot as { entry: number }).entry = 999;
    }).toThrow();
    expect(() => {
      (snapshot.confirmationCandle as { c: number }).c = 999;
    }).toThrow();
    expect(snapshot.entry).toBe(100);
  });
});

describe("som de confirmação (comando §8)", () => {
  it("dispara no máximo 1x por signalId e respeita o OFF", () => {
    resetSignalSoundForTests();
    // Ambiente de teste não tem AudioContext: o dedupe ainda deve funcionar.
    playConfirmationOnce("sig_a", "COMPRA", true);
    expect(hasPlayed("sig_a")).toBe(true);
    expect(playConfirmationOnce("sig_a", "COMPRA", true)).toBe(false);
    // Som desligado: nem marca o sinal.
    resetSignalSoundForTests();
    expect(playConfirmationOnce("sig_b", "VENDA", false)).toBe(false);
    expect(hasPlayed("sig_b")).toBe(false);
  });
});
