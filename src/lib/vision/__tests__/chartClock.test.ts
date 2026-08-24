import { describe, expect, it } from "vitest";

import { labelSegments, parseChartClock, tradingDayLabel } from "../chartClock";

describe("leitura do relógio do gráfico (§16)", () => {
  it("faz parse de data BR/ISO, hora, ativo e timeframe", () => {
    const read = parseChartClock(
      '{"date":"02/01/2025","time":"10:31:07","asset":"winfut","timeframe":"1 min","confidence":0.9}',
    );
    expect(read.date).toBe("2025-01-02");
    expect(read.time).toBe("10:31");
    expect(read.asset).toBe("WINFUT");
    expect(read.confidence).toBe(0.9);
  });

  it("UNKNOWN e respostas inválidas viram null — nunca inventa", () => {
    const unknown = parseChartClock(
      '{"date":"UNKNOWN","time":"desconhecido","asset":"","confidence":0.8}',
    );
    expect(unknown.date).toBeNull();
    expect(unknown.time).toBeNull();
    expect(parseChartClock("não sei ler isso").confidence).toBe(0);
    expect(parseChartClock('{"date":"99/99/2025","confidence":1}').date).toBeNull();
  });

  it("rotula segmentos pela leitura mais próxima e exige confiança mínima", () => {
    const reads = [
      { frameIndex: 2, read: parseChartClock('{"date":"02/01/2025","confidence":0.9}') },
      { frameIndex: 40, read: parseChartClock('{"date":"03/01/2025","confidence":0.9}') },
      { frameIndex: 60, read: parseChartClock('{"date":"04/01/2025","confidence":0.3}') }, // baixa confiança
    ];
    const labels = labelSegments([0, 35, 58], reads);
    expect(labels[0]).toBe("02/01/2025");
    expect(labels[1]).toBe("02/01/2025"); // última leitura confiável <= frame 35
    expect(labels[2]).toBe("03/01/2025"); // 0.3 descartada; usa a anterior confiável
  });

  it("sem leitura confiável o rótulo é honesto", () => {
    expect(labelSegments([0], [])).toEqual(["Trecho 1 (data não reconhecida)"]);
    expect(tradingDayLabel(null, 2)).toContain("Trecho 3");
  });
});
