import { describe, expect, it } from "vitest";

import { parseCandlesCsv } from "../csvImport";

/** Mesma série em dois dialetos: BR (;+vírgula decimal) e EN (,+ponto). */
const BR_CSV = [
  "Data;Hora;Abertura;Máxima;Mínima;Fechamento;Volume",
  "18/03/2026;09:00;128.450,50;128.500,00;128.400,00;128.480,00;1500",
  "18/03/2026;09:01;128.480,00;128.520,00;128.460,00;128.500,00;1200",
  "18/03/2026;09:02;128.500,00;128.510,00;128.430,00;128.440,00;900",
].join("\n");

const EN_CSV = [
  "Date,Time,Open,High,Low,Close,Volume",
  "2026-03-18,09:00:00,128450.5,128500,128400,128480,1500",
  "2026-03-18,09:01:00,128480,128520,128460,128500,1200",
  "2026-03-18,09:02:00,128500,128510,128430,128440,900",
].join("\n");

describe("parseCandlesCsv", () => {
  it("CSV BR e CSV EN da mesma série produzem candles IDÊNTICOS", () => {
    const br = parseCandlesCsv(BR_CSV);
    const en = parseCandlesCsv(EN_CSV);

    expect(br.problems).toEqual([]);
    expect(en.problems).toEqual([]);
    expect(br.candles).toHaveLength(3);
    // O formato detectado difere; o DADO não pode diferir.
    expect(br.candles).toEqual(en.candles);
    expect(br.candles[0]).toEqual({
      t: Date.UTC(2026, 2, 18, 9, 0, 0),
      o: 128450.5,
      h: 128500,
      l: 128400,
      c: 128480,
      v: 1500,
    });
    expect(br.format).toContain("ponto-e-virgula");
    expect(br.format).toContain("decimal=virgula");
    expect(en.format).toContain("sep=virgula");
    expect(en.format).toContain("decimal=ponto");
  });

  it("separador tab com decimal ponto também é detectado", () => {
    const tabCsv = [
      "Date\tTime\tOpen\tHigh\tLow\tClose\tVolume",
      "2026-03-18\t09:00\t100.5\t101\t100\t100.75\t10",
    ].join("\n");
    const out = parseCandlesCsv(tabCsv);
    expect(out.problems).toEqual([]);
    expect(out.candles).toHaveLength(1);
    expect(out.candles[0]!.o).toBe(100.5);
    expect(out.format).toContain("sep=tab");
  });

  it("linha podre é DESCARTADA e CONTADA — o resto do arquivo sobrevive", () => {
    const csv = [
      "Data;Hora;Abertura;Máxima;Mínima;Fechamento;Volume",
      "18/03/2026;09:00;100,0;101,0;99,0;100,5;10",
      "lixo total sem colunas",
      "18/03/2026;09:01;abc;101,0;99,0;100,5;10",
      "18/03/2026;09:02;100,0;99,0;101,0;100,5;10", // máxima < mínima
      "18/03/2026;09:03;150,0;101,0;99,0;100,5;10", // abertura fora de [l,h]
      "31/02/2026;09:04;100,0;101,0;99,0;100,5;10", // data inexistente
      "18/03/2026;09:05;100,0;101,0;99,0;100,5;10",
    ].join("\n");
    const out = parseCandlesCsv(csv);
    expect(out.candles).toHaveLength(2);
    expect(out.problems).toHaveLength(5);
    expect(out.problems.join("\n")).toContain("linha 3");
    expect(out.problems.join("\n")).toContain("máxima");
    expect(out.problems.join("\n")).toContain("fora do intervalo");
  });

  it("timestamp duplicado mantém a PRIMEIRA ocorrência e conta problema", () => {
    const csv = [
      "Data;Hora;Abertura;Máxima;Mínima;Fechamento;Volume",
      "18/03/2026;09:00;100,0;101,0;99,0;100,5;10",
      "18/03/2026;09:00;555,0;556,0;554,0;555,5;99",
    ].join("\n");
    const out = parseCandlesCsv(csv);
    expect(out.candles).toHaveLength(1);
    expect(out.candles[0]!.o).toBe(100); // a primeira, nunca a segunda
    expect(out.problems).toHaveLength(1);
    expect(out.problems[0]).toContain("duplicado");
  });

  it("linhas fora de ordem saem ordenadas por t crescente", () => {
    const csv = [
      "Data;Hora;Abertura;Máxima;Mínima;Fechamento",
      "18/03/2026;09:02;100,0;101,0;99,0;100,5",
      "18/03/2026;09:00;100,0;101,0;99,0;100,5",
      "18/03/2026;09:01;100,0;101,0;99,0;100,5",
    ].join("\n");
    const out = parseCandlesCsv(csv);
    const ts = out.candles.map((c) => c.t);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    // Sem coluna de volume: 0 é a convenção declarada do tipo Candle.
    expect(out.candles.every((c) => c.v === 0)).toBe(true);
  });

  it("cabeçalho irreconhecível NÃO vira adivinhação de colunas", () => {
    const out = parseCandlesCsv("foo;bar;baz\n1;2;3");
    expect(out.candles).toEqual([]);
    expect(out.problems.join("\n")).toContain("cabeçalho não reconhecido");
    expect(out.format).toBe("DESCONHECIDO");
  });

  it("arquivo vazio devolve problema declarado, nunca silêncio", () => {
    const out = parseCandlesCsv("");
    expect(out.candles).toEqual([]);
    expect(out.problems).toHaveLength(1);
  });

  it("volume ilegível vira 0 COM problema contado — candle não morre por isso", () => {
    const csv = [
      "Data;Hora;Abertura;Máxima;Mínima;Fechamento;Volume",
      "18/03/2026;09:00;100,0;101,0;99,0;100,5;n/d",
    ].join("\n");
    const out = parseCandlesCsv(csv);
    expect(out.candles).toHaveLength(1);
    expect(out.candles[0]!.v).toBe(0);
    expect(out.problems).toHaveLength(1);
    expect(out.problems[0]).toContain("volume ilegível");
  });
});
