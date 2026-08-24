import { describe, expect, it } from "vitest";

import { monteCarloDrawdown, RUIN_THRESHOLD_R } from "../monteCarlo";

/** Sequência mista realista: ganhos e perdas em R. */
const MIXED_TRADES = [1.5, -1, 2, -1, -1, 0.5, 3, -1, -1, 1, -1, 2.5, -1, 1, -1];

describe("monteCarloDrawdown", () => {
  it("mesma seed ⇒ EXATAMENTE o mesmo relatório (reprodutibilidade é lei)", () => {
    const a = monteCarloDrawdown(MIXED_TRADES, 500, 42);
    const b = monteCarloDrawdown(MIXED_TRADES, 500, 42);
    expect(a).toEqual(b);
  });

  it("P95 ≥ P50 sempre — percentis da mesma ordenação", () => {
    const out = monteCarloDrawdown(MIXED_TRADES, 500, 7);
    expect(out.maxDrawdownP95).toBeGreaterThanOrEqual(out.maxDrawdownP50);
    expect(out.runs).toBe(500);
    expect(out.ruinProbability).toBeGreaterThanOrEqual(0);
    expect(out.ruinProbability).toBeLessThanOrEqual(1);
  });

  it("só perdas cruzando o limiar ⇒ ruína em 100% dos runs", () => {
    // 25 × (−1R): equity termina em −25R e cruza −20R em todo embaralhamento.
    const out = monteCarloDrawdown(
      Array.from({ length: 25 }, () => -1),
      50,
      3,
    );
    expect(RUIN_THRESHOLD_R).toBe(-20);
    expect(out.ruinProbability).toBe(1);
    expect(out.maxDrawdownP50).toBe(25);
    expect(out.maxDrawdownP95).toBe(25);
    expect(out.worstLossStreakP95).toBe(25);
  });

  it("só ganhos ⇒ drawdown zero e ruína zero", () => {
    const out = monteCarloDrawdown(
      Array.from({ length: 30 }, () => 1),
      50,
      3,
    );
    expect(out.maxDrawdownP50).toBe(0);
    expect(out.maxDrawdownP95).toBe(0);
    expect(out.worstLossStreakP95).toBe(0);
    expect(out.ruinProbability).toBe(0);
  });

  it("entrada vazia ou runs inválido ⇒ runs: 0 (simulação NÃO executada)", () => {
    const zerado = {
      maxDrawdownP50: 0,
      maxDrawdownP95: 0,
      worstLossStreakP95: 0,
      ruinProbability: 0,
      runs: 0,
    };
    expect(monteCarloDrawdown([], 100, 1)).toEqual(zerado);
    expect(monteCarloDrawdown(MIXED_TRADES, 0, 1)).toEqual(zerado);
    expect(monteCarloDrawdown([1, Number.NaN], 100, 1)).toEqual(zerado);
  });

  it("não mexe no array de entrada (embaralha uma CÓPIA)", () => {
    const original = [...MIXED_TRADES];
    monteCarloDrawdown(MIXED_TRADES, 100, 9);
    expect(MIXED_TRADES).toEqual(original);
  });
});
