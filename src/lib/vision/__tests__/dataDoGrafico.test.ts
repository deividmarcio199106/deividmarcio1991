import { describe, expect, it } from "vitest";

import { MarketClock } from "../marketClock";
import { normalizeDate } from "../chartClock";
import { emptyLedger, observeCandle } from "@/lib/print/candleLedger";

/**
 * O DEFEITO DE PRODUÇÃO DE 20/08/2026, TRANCADO.
 *
 * Às 14:58 a tela do operador mostrou "Invalid time value" e nenhuma análise
 * concluía. A cadeia:
 *
 *   1. o prompt pede data em AAAA-MM-DD, mas a barra de abas do Profit escreve
 *      "20/08/2026" — e é isso que o modelo devolve;
 *   2. a validação do contrato conferia `chartClock.time` e NÃO `chartClock.date`;
 *   3. `MarketClock` fazia `"20/08/2026".split("-").map(Number)` → `[NaN]`,
 *      `setFullYear(NaN)` → Invalid Date, `getTime()` → NaN;
 *   4. quem formatava esse instante com `toISOString()` LANÇAVA, e o
 *      lançamento derrubava o passo inteiro da análise.
 *
 * Cada teste abaixo corta a cadeia num elo diferente: uma correção só teria
 * deixado as outras três portas abertas para o próximo formato inesperado.
 */

describe("elo 1 e 2 — a data do gráfico é normalizada, não rejeitada", () => {
  it("aceita o formato BRASILEIRO, que é o que está na tela", () => {
    expect(normalizeDate("20/08/2026")).toBe("2026-08-20");
    expect(normalizeDate("20.08.2026")).toBe("2026-08-20");
    expect(normalizeDate("20-08-2026")).toBe("2026-08-20");
  });

  it("aceita ISO, que é o que o prompt pede", () => {
    expect(normalizeDate("2026-08-20")).toBe("2026-08-20");
  });

  it("e devolve null para o que não é data — ausência é um valor", () => {
    expect(normalizeDate("ontem")).toBeNull();
    expect(normalizeDate("")).toBeNull();
    expect(normalizeDate("99/99/9999")).toBeNull();
  });
});

describe("elo 3 — MarketClock não publica instante inválido", () => {
  const LOCAL = Date.UTC(2026, 7, 20, 17, 58, 0);

  it("data em formato inesperado NÃO envenena o relógio", () => {
    /*
     * A data é OPCIONAL para identificar o candle dentro do pregão: hora e
     * minuto bastam. Então data ruim é ignorada e a leitura segue valendo —
     * degradar é melhor que derrubar, e muito melhor que propagar NaN.
     */
    const clock = new MarketClock();
    clock.update(
      { date: "20/08/2026", time: "14:58", asset: "WINFUT", timeframe: "1Min", confidence: 1 },
      LOCAL,
    );
    const snap = clock.snapshot();
    expect(snap.chartEpochAtRead).not.toBeNull();
    expect(Number.isFinite(snap.chartEpochAtRead!)).toBe(true);
    // E o instante publicado pode ser formatado sem lançar — que era o ponto.
    expect(() => new Date(snap.chartEpochAtRead!).toISOString()).not.toThrow();
  });

  it("data ISO válida continua sendo aplicada", () => {
    const clock = new MarketClock();
    clock.update(
      { date: "2026-08-19", time: "14:58", asset: "WINFUT", timeframe: "1Min", confidence: 1 },
      LOCAL,
    );
    const d = new Date(clock.snapshot().chartEpochAtRead!);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7);
    expect(d.getDate()).toBe(19);
  });

  it("nenhum caminho publica NaN — a última porta", () => {
    const clock = new MarketClock();
    for (const date of ["20/08/2026", "lixo", "", "2026-13-45", "0000-00-00"]) {
      clock.reset();
      clock.update(
        { date, time: "14:58", asset: "WINFUT", timeframe: "1Min", confidence: 1 },
        LOCAL,
      );
      const t = clock.snapshot().chartEpochAtRead;
      if (t !== null) expect(Number.isFinite(t)).toBe(true);
      expect(() => clock.now(LOCAL)).not.toThrow();
    }
  });
});

describe("elo 4 — o livro-razão não lança ao dizer que não sabe", () => {
  it("chartTime não finito é tratado como ausência de leitura", () => {
    /*
     * Um módulo cuja função é dizer "não sei" não pode derrubar quem o chamou
     * ao dizer isso. As frases de motivo formatam o instante, e formatar NaN
     * lança.
     */
    const passo = observeCandle(emptyLedger(), {
      identity: { asset: "WINFUT", timeframe: "1Min", chartTime: Number.NaN },
      capturedAt: Date.UTC(2026, 7, 20, 17, 58, 0),
      price: 170_505,
      previousOhlc: null,
    });
    expect(passo.event).toBe("SEM_CHART_TIME");
    expect(passo.podeConfirmar).toBe(false);
    expect(passo.state.current).toBeNull();
    expect(passo.reason).toContain("inválido");
  });

  it("e a sequência inteira sobrevive a uma leitura envenenada no meio", () => {
    const bom = (chart: number) => ({
      identity: { asset: "WINFUT", timeframe: "1Min", chartTime: chart },
      capturedAt: chart,
      price: 170_500,
      previousOhlc: null,
    });
    let estado = emptyLedger();
    const T = Date.UTC(2026, 7, 20, 17, 58, 0);
    for (const entrada of [
      bom(T),
      { ...bom(T), identity: { asset: "WINFUT", timeframe: "1Min", chartTime: Number.NaN } },
      bom(T + 60_000),
    ]) {
      expect(() => {
        estado = observeCandle(estado, entrada).state;
      }).not.toThrow();
    }
    // O candle bom seguinte fechou o bom anterior: o veneno não quebrou a série.
    expect(estado.current?.identity.chartTime).toBe(T + 60_000);
  });
});
