import { describe, expect, it } from "vitest";

import { marketClockGuard, minutosDoRelogio } from "../marketClockGuard";

const at = (h: number, m: number) => marketClockGuard(h * 60 + m);

describe("minutosDoRelogio", () => {
  it("lê a hora do gráfico", () => {
    expect(minutosDoRelogio("09:20")).toBe(560);
    expect(minutosDoRelogio(" 16:30 ")).toBe(990);
  });

  it("recusa o que não é hora — null é informação, não zero", () => {
    expect(minutosDoRelogio("")).toBeNull();
    expect(minutosDoRelogio("25:00")).toBeNull();
    expect(minutosDoRelogio("09:99")).toBeNull();
    expect(minutosDoRelogio(null)).toBeNull();
    expect(minutosDoRelogio(undefined)).toBeNull();
  });
});

describe("marketClockGuard", () => {
  it("hora desconhecida NÃO libera entrada", () => {
    const g = marketClockGuard(null);
    expect(g.novasEntradas).toBe(false);
    expect(g.verdict).toBe("BLOQUEIO_NOVAS");
  });

  it("antes das 09:00 não opera", () => {
    expect(at(8, 59).novasEntradas).toBe(false);
    expect(at(8, 59).window).toBe("PRE_ABERTURA");
  });

  it("09:00–09:20 bloqueia entrada nova sem encerrar posição", () => {
    const g = at(9, 5);
    expect(g.window).toBe("ABERTURA");
    expect(g.novasEntradas).toBe(false);
    expect(g.encerrarPosicoes).toBe(false);
    expect(g.forcarBreakEven).toBe(false);
  });

  it("09:20 já é pregão liberado — a borda superior é aberta", () => {
    const g = at(9, 20);
    expect(g.window).toBe("PREGAO");
    expect(g.novasEntradas).toBe(true);
  });

  it("09:55–10:15 bloqueia novas E força break-even", () => {
    const g = at(10, 0);
    expect(g.window).toBe("CHOQUE_A_VISTA");
    expect(g.novasEntradas).toBe(false);
    expect(g.forcarBreakEven).toBe(true);
    expect(g.encerrarPosicoes).toBe(false);
  });

  it("09:55 entra na trava e 10:15 já saiu", () => {
    expect(at(9, 55).window).toBe("CHOQUE_A_VISTA");
    expect(at(9, 54).window).toBe("PREGAO");
    expect(at(10, 15).window).toBe("PREGAO");
  });

  it("10:30–10:45 é janela liberada de alta liquidez", () => {
    const g = at(10, 35);
    expect(g.window).toBe("ALTA_LIQUIDEZ");
    expect(g.verdict).toBe("LIBERADO");
    expect(g.novasEntradas).toBe(true);
  });

  it("16:30 corta novas e manda encerrar", () => {
    const g = at(16, 30);
    expect(g.verdict).toBe("BLOQUEIO_TOTAL");
    expect(g.window).toBe("FECHAMENTO");
    expect(g.novasEntradas).toBe(false);
    expect(g.encerrarPosicoes).toBe(true);
  });

  it("16:29 ainda opera", () => {
    expect(at(16, 29).novasEntradas).toBe(true);
  });

  it("depois de 17:30 não há mais o que encerrar", () => {
    const g = at(17, 31);
    expect(g.window).toBe("POS_PREGAO");
    expect(g.encerrarPosicoes).toBe(false);
    expect(g.novasEntradas).toBe(false);
  });

  it("nenhuma faixa devolve detail vazio", () => {
    for (let min = 0; min < 24 * 60; min += 7) {
      expect(marketClockGuard(min).detail.length).toBeGreaterThan(0);
    }
  });
});
