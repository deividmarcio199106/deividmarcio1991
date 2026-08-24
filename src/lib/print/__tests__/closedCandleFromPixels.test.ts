import { describe, expect, it } from "vitest";

import { divergenciaDeFechamento } from "../closedCandleFromPixels";
import { fechamentoProvado, type CloseSource } from "../candleLedger";
import { rejectObservation } from "../breakout";

/**
 * A SEGUNDA VIA DE LEITURA DO CANDLE FECHADO.
 *
 * A extração em si (`extractCandlesFromPixels`) já era testada; o que é novo é
 * a PROCEDÊNCIA — duas fontes para o mesmo número — e o que se faz quando elas
 * discordam.
 */

const OHLC = (close: number) => ({ open: 170_500, high: 170_700, low: 170_450, close });

describe("as duas vias PROVAM, e a máquina aceita ambas", () => {
  it("MODELO e GEOMETRIA confirmam; NAO_PROVADO não", () => {
    expect(fechamentoProvado("MODELO")).toBe(true);
    expect(fechamentoProvado("GEOMETRIA")).toBe(true);
    expect(fechamentoProvado("NAO_PROVADO")).toBe(false);
  });

  it("o rompimento aceita candle fechado lido por geometria", () => {
    /*
     * Antes de 20/08 a checagem era `closeSource !== "GRAFICO"`, com um único
     * valor provado. Com a segunda via, uma comparação por igualdade recusaria
     * silenciosamente a geometria — que hoje é a ÚNICA que responde.
     */
    const base = { close: 170_600, candleTime: 0, at: 0, phase: "CLOSED" as const };
    expect(rejectObservation({ ...base, closeSource: "GEOMETRIA" })).toBeNull();
    expect(rejectObservation({ ...base, closeSource: "MODELO" })).toBeNull();
    expect(rejectObservation({ ...base, closeSource: "NAO_PROVADO" })).toBe(
      "FECHAMENTO_NAO_PROVADO",
    );
  });

  it("candle em formação continua recusado, venha de onde vier", () => {
    for (const fonte of ["MODELO", "GEOMETRIA"] as CloseSource[]) {
      expect(
        rejectObservation({
          close: 170_600,
          candleTime: 0,
          at: 0,
          phase: "FORMING",
          closeSource: fonte,
        }),
      ).toBe("CANDLE_EM_FORMACAO");
    }
  });
});

describe("divergência entre as duas leituras", () => {
  const TICK = 5;

  it("diferença DENTRO do tick é arredondamento de leitura, não discordância", () => {
    expect(divergenciaDeFechamento(OHLC(170_600), OHLC(170_603), TICK)).toBe(0);
    expect(divergenciaDeFechamento(OHLC(170_600), OHLC(170_600), TICK)).toBe(0);
  });

  it("acima do tick é discordância REAL, e vem com o tamanho", () => {
    expect(divergenciaDeFechamento(OHLC(170_600), OHLC(170_650), TICK)).toBe(50);
    expect(divergenciaDeFechamento(OHLC(170_650), OHLC(170_600), TICK)).toBe(50);
  });

  it("com uma fonte só, não há o que comparar — e isso é null, não zero", () => {
    /*
     * Hoje é o caso normal: o modelo devolveu o candle em 0 de 25 análises
     * reais. Dizer "zero de divergência" aqui afirmaria concordância entre uma
     * leitura e o nada.
     */
    expect(divergenciaDeFechamento(OHLC(170_600), null, TICK)).toBeNull();
    expect(divergenciaDeFechamento(null, OHLC(170_600), TICK)).toBeNull();
    expect(divergenciaDeFechamento(null, null, TICK)).toBeNull();
  });

  it("fechamento ausente em um dos lados também é null", () => {
    const semFechamento = { open: 1, high: 2, low: 0, close: null };
    expect(divergenciaDeFechamento(semFechamento, OHLC(170_600), TICK)).toBeNull();
  });
});
