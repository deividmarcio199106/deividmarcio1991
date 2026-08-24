import { describe, expect, it } from "vitest";

import type { Candle } from "@/lib/engines/types";

import { chronologicalFrontiers } from "./chronologicalFrontier";

function candle(t: number, c: number): Candle {
  return { t, o: c, h: c + 1, l: c - 1, c, v: 0 };
}

describe("chronologicalFrontiers — anti-look-ahead do backtest arrastado", () => {
  it("reproduz o primeiro frame candle a candle sem expor o futuro", () => {
    const sequence = [
      candle(10_30, 100),
      candle(10_31, 101),
      candle(10_32, 102),
      candle(10_33, 103),
    ];
    const steps = chronologicalFrontiers(sequence, 0, 160);

    expect(steps).toHaveLength(4);
    expect(steps[0]!.history.map((item) => item.t)).toEqual([10_30]);
    expect(steps[1]!.history.map((item) => item.t)).toEqual([10_30, 10_31]);
    expect(steps[2]!.history.map((item) => item.t)).toEqual([10_30, 10_31, 10_32]);
    expect(steps[3]!.history.map((item) => item.t)).toEqual([10_30, 10_31, 10_32, 10_33]);
    for (const step of steps) {
      expect(step.history.at(-1)?.t).toBe(step.candle.t);
      expect(step.history.some((item) => item.t > step.candle.t)).toBe(false);
    }
  });

  it("processa somente candles novos quando o frame seguinte sobrepõe o anterior", () => {
    const sequence = [
      candle(1, 100),
      candle(2, 101),
      candle(3, 102),
      candle(4, 103),
      candle(5, 104),
    ];
    const steps = chronologicalFrontiers(sequence, 4, 160);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.candle.t).toBe(5);
    expect(steps[0]!.history.at(-1)?.t).toBe(5);
  });

  it("limita a janela de análise sem alterar a fronteira T", () => {
    const sequence = Array.from({ length: 10 }, (_, index) => candle(index + 1, 100 + index));
    const steps = chronologicalFrontiers(sequence, 9, 4);
    expect(steps[0]!.history.map((item) => item.t)).toEqual([7, 8, 9, 10]);
  });
});
