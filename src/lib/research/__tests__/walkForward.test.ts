import { describe, expect, it } from "vitest";

import { buildFolds, MIN_FOLDS_FOR_STABILITY, walkForwardStability } from "../walkForward";

/** Série de timestamps de 1 em 1 minuto, começando num instante fixo. */
function minuteTimes(count: number): number[] {
  const t0 = Date.UTC(2026, 2, 18, 9, 0, 0);
  return Array.from({ length: count }, (_, i) => t0 + i * 60_000);
}

describe("buildFolds", () => {
  it("teste vem SEMPRE depois do treino, em todos os folds", () => {
    const times = minuteTimes(100);
    const folds = buildFolds(times, 4);
    expect(folds).toHaveLength(4);
    for (const fold of folds) {
      expect(fold.trainStart).toBeLessThan(fold.trainEnd);
      expect(fold.testStart).toBeLessThan(fold.testEnd);
      // A garantia central do walk-forward: nada de teste dentro do treino.
      expect(fold.testStart).toBeGreaterThan(fold.trainEnd);
    }
  });

  it("janelas DESLIZAM cronologicamente e os testes não se sobrepõem", () => {
    const times = minuteTimes(100);
    const folds = buildFolds(times, 4);
    for (let i = 1; i < folds.length; i++) {
      expect(folds[i]!.trainStart).toBeGreaterThan(folds[i - 1]!.trainStart);
      // Teste do fold seguinte começa depois do teste anterior TERMINAR.
      expect(folds[i]!.testStart).toBeGreaterThan(folds[i - 1]!.testEnd);
    }
  });

  it("fronteiras são timestamps REAIS da série e a âncora é o fim", () => {
    const times = minuteTimes(100);
    const set = new Set(times);
    const folds = buildFolds(times, 4);
    for (const fold of folds) {
      expect(set.has(fold.trainStart)).toBe(true);
      expect(set.has(fold.trainEnd)).toBe(true);
      expect(set.has(fold.testStart)).toBe(true);
      expect(set.has(fold.testEnd)).toBe(true);
    }
    // Sobra de arredondamento descarta os candles ANTIGOS, nunca os recentes.
    expect(folds[folds.length - 1]!.testEnd).toBe(times[times.length - 1]);
  });

  it("série embaralhada e com duplicatas produz os MESMOS folds", () => {
    const times = minuteTimes(100);
    const bagunca = [...times, ...times.slice(0, 10)].reverse();
    expect(buildFolds(bagunca, 4)).toEqual(buildFolds(times, 4));
  });

  it("amostra insuficiente devolve [] — nunca fold degenerado", () => {
    expect(buildFolds(minuteTimes(3), 4)).toEqual([]);
    expect(buildFolds([], 3)).toEqual([]);
  });

  it("parâmetros absurdos devolvem []", () => {
    const times = minuteTimes(100);
    expect(buildFolds(times, 0)).toEqual([]);
    expect(buildFolds(times, 2.5)).toEqual([]);
    expect(buildFolds(times, 3, 0)).toEqual([]);
    expect(buildFolds(times, 3, 1)).toEqual([]);
  });
});

describe("walkForwardStability", () => {
  it("exige pelo menos 3 folds: 2/2 positivos NÃO é estável", () => {
    const out = walkForwardStability([{ netR: 1 }, { netR: 2 }]);
    expect(out.positiveFolds).toBe(2);
    expect(out.totalFolds).toBe(2);
    expect(out.totalFolds).toBeLessThan(MIN_FOLDS_FOR_STABILITY);
    expect(out.stable).toBe(false);
  });

  it("60% exatos com 3+ folds é estável (3 de 5)", () => {
    const out = walkForwardStability([
      { netR: 0.5 },
      { netR: 1 },
      { netR: 2 },
      { netR: -1 },
      { netR: -0.5 },
    ]);
    expect(out.positiveFolds).toBe(3);
    expect(out.stable).toBe(true);
  });

  it("abaixo de 60% não é estável (2 de 5)", () => {
    const out = walkForwardStability([
      { netR: 1 },
      { netR: 1 },
      { netR: -1 },
      { netR: -1 },
      { netR: -1 },
    ]);
    expect(out.stable).toBe(false);
  });

  it("netR zero NÃO conta como positivo — empate não é robustez", () => {
    const out = walkForwardStability([{ netR: 0 }, { netR: 0 }, { netR: 1 }]);
    expect(out.positiveFolds).toBe(1);
    expect(out.stable).toBe(false);
  });

  it("lista vazia: zero folds, nunca estável", () => {
    expect(walkForwardStability([])).toEqual({ positiveFolds: 0, totalFolds: 0, stable: false });
  });
});
