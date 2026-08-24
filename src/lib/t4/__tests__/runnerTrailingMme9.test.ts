import { describe, expect, it } from "vitest";

import type { Candle } from "@/lib/engines/types";
import { ema } from "@/lib/engines/marketFeatures";
import {
  BREAK_EVEN_OFFSET_POINTS,
  RUNNER_MME_PERIODO,
  runnerTrailingMme9,
  stopAposParcial,
  stopJaProtegido,
} from "../management";

function serie(closes: number[]): Candle[] {
  return closes.map((c, i) => ({ t: i * 60_000, o: c, h: c + 10, l: c - 10, c, v: 0 }));
}

/** Alta constante: o fechamento fica sempre acima de uma MME que persegue de baixo. */
const SUBINDO = serie([100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200]);
const CAINDO = serie([200, 190, 180, 170, 160, 150, 140, 130, 120, 110, 100]);

describe("runnerTrailingMme9", () => {
  it("sem candles suficientes não emite veredito", () => {
    const r = runnerTrailingMme9({ side: "COMPRA", closedCandles: SUBINDO.slice(0, 4) });
    expect(r.verdict).toBe("RUNNER_SEM_DADO");
    expect(r.mme9).toBeNull();
  });

  it("exige exatamente o período da MME para começar a julgar", () => {
    const curto = runnerTrailingMme9({
      side: "COMPRA",
      closedCandles: SUBINDO.slice(0, RUNNER_MME_PERIODO - 1),
    });
    const noLimite = runnerTrailingMme9({
      side: "COMPRA",
      closedCandles: SUBINDO.slice(0, RUNNER_MME_PERIODO),
    });
    expect(curto.verdict).toBe("RUNNER_SEM_DADO");
    expect(noLimite.verdict).not.toBe("RUNNER_SEM_DADO");
  });

  it("compra: fechamento acima da MME 9 mantém o runner", () => {
    const r = runnerTrailingMme9({ side: "COMPRA", closedCandles: SUBINDO });
    expect(r.verdict).toBe("RUNNER_SEGUE");
    expect(r.close).toBe(200);
    expect(r.mme9).toBeLessThan(200);
  });

  it("compra: o PRIMEIRO fechamento abaixo da MME 9 encerra", () => {
    const rompe = [...SUBINDO, ...serie([1])].slice(0, SUBINDO.length + 1);
    rompe[rompe.length - 1] = { t: 0, o: 200, h: 200, l: 100, c: 100, v: 0 };
    const r = runnerTrailingMme9({ side: "COMPRA", closedCandles: rompe });
    expect(r.verdict).toBe("RUNNER_ENCERRA");
    expect(r.detail).toContain("abaixo");
  });

  it("venda: fechamento abaixo da MME 9 mantém o runner", () => {
    const r = runnerTrailingMme9({ side: "VENDA", closedCandles: CAINDO });
    expect(r.verdict).toBe("RUNNER_SEGUE");
  });

  it("venda: o primeiro fechamento acima da MME 9 encerra", () => {
    const rompe = [...CAINDO];
    rompe[rompe.length - 1] = { t: 0, o: 100, h: 300, l: 100, c: 300, v: 0 };
    const r = runnerTrailingMme9({ side: "VENDA", closedCandles: rompe });
    expect(r.verdict).toBe("RUNNER_ENCERRA");
    expect(r.detail).toContain("acima");
  });

  it("fechamento EXATAMENTE na média não encerra — abaixo é abaixo", () => {
    const base = serie([100, 100, 100, 100, 100, 100, 100, 100, 100]);
    const media = ema(
      base.map((c) => c.c),
      RUNNER_MME_PERIODO,
    );
    expect(media).toBeCloseTo(100, 6);
    const r = runnerTrailingMme9({ side: "COMPRA", closedCandles: base });
    expect(r.verdict).toBe("RUNNER_SEGUE");
  });

  it("usa a MESMA média das features, não uma cópia", () => {
    const r = runnerTrailingMme9({ side: "COMPRA", closedCandles: SUBINDO });
    expect(r.mme9).toBeCloseTo(
      ema(
        SUBINDO.map((c) => c.c),
        RUNNER_MME_PERIODO,
      ),
      9,
    );
  });

  it("é barra fechada: o pavio que fura a média não encerra", () => {
    const comPavio = [...SUBINDO];
    // Mínima muito abaixo da média, fechamento acima dela.
    comPavio[comPavio.length - 1] = { t: 0, o: 195, h: 205, l: 50, c: 200, v: 0 };
    const r = runnerTrailingMme9({ side: "COMPRA", closedCandles: comPavio });
    expect(r.verdict).toBe("RUNNER_SEGUE");
  });
});

describe("break-even protegido após a parcial", () => {
  it("compra sobe o stop para entrada + offset", () => {
    expect(stopAposParcial("COMPRA", 100_000)).toBe(100_000 + BREAK_EVEN_OFFSET_POINTS);
  });

  it("venda DESCE o stop — o offset é sempre a favor", () => {
    expect(stopAposParcial("VENDA", 100_000)).toBe(100_000 - BREAK_EVEN_OFFSET_POINTS);
  });

  it("o stop protegido nunca fica no preço de entrada", () => {
    expect(stopAposParcial("COMPRA", 100_000)).not.toBe(100_000);
    expect(stopAposParcial("VENDA", 100_000)).not.toBe(100_000);
  });

  it("reconhece stop já protegido e não pede piora", () => {
    expect(stopJaProtegido("COMPRA", 100_000, 100_050)).toBe(true);
    expect(stopJaProtegido("COMPRA", 100_000, 100_010)).toBe(true);
    expect(stopJaProtegido("COMPRA", 100_000, 99_900)).toBe(false);
    expect(stopJaProtegido("VENDA", 100_000, 99_950)).toBe(true);
    expect(stopJaProtegido("VENDA", 100_000, 100_100)).toBe(false);
  });
});
