import { describe, expect, it } from "vitest";

import {
  axisNeedsRefresh,
  confidenceAt,
  detectAnomaly,
  EMPTY_TIME_AXIS,
  fitTimeAxis,
  parseClockLabel,
  resolveInstant,
  timeAt,
  type TimeLabel,
} from "../timeAxis";

const DIA = Date.UTC(2026, 2, 13, 0, 0, 0);
const MIN = 60_000;

function label(x: number, hhmm: string, confidence = 0.9): TimeLabel {
  const ms = parseClockLabel(hhmm)!;
  return { x, raw: hhmm, t: resolveInstant(DIA, ms), confidence };
}

describe("leitura do eixo de tempo", () => {
  it("interpreta HH:MM e HH:MM:SS", () => {
    expect(parseClockLabel("18:04")).toBe(18 * 3_600_000 + 4 * MIN);
    expect(parseClockLabel("09:47:30")).toBe(9 * 3_600_000 + 47 * MIN + 30_000);
  });

  it("recusa o que não é horário", () => {
    // Rotulo de data no eixo produziria um instante absurdo se aceito.
    expect(parseClockLabel("10/ago")).toBeNull();
    expect(parseClockLabel("172.410")).toBeNull();
    expect(parseClockLabel("25:00")).toBeNull();
    expect(parseClockLabel("18:99")).toBeNull();
  });

  it("ajusta a reta com os rótulos do print real (18:04 a 18:24)", () => {
    const axis = fitTimeAxis([
      label(0.05, "18:04"),
      label(0.25, "18:08"),
      label(0.55, "18:14"),
      label(0.95, "18:22"),
    ]);
    expect(axis.trusted).toBe(true);
    expect(axis.anchors).toHaveLength(4);
    // 20 min ao longo de 0.9 de largura.
    expect(axis.msPerX).toBeGreaterThan(19 * MIN);
    expect(axis.msPerX).toBeLessThan(21 * MIN);
    expect(axis.residualMs).toBeLessThan(5_000);
  });

  it("converte posição em instante de mercado", () => {
    const axis = fitTimeAxis([label(0.0, "18:00"), label(1.0, "18:20")]);
    const meio = timeAt(axis, 0.5);
    expect(meio).toBe(resolveInstant(DIA, parseClockLabel("18:10")!));
  });

  it("um rótulo só não define escala", () => {
    const axis = fitTimeAxis([label(0.5, "18:10")]);
    expect(axis.trusted).toBe(false);
    expect(timeAt(axis, 0.9)).toBeNull();
    expect(axis.detail).toContain("1 rótulo");
  });

  it("rótulos amontoados não definem escala", () => {
    // Sem separacao horizontal, a inclinacao e ruido amplificado.
    const axis = fitTimeAxis([label(0.5, "18:10"), label(0.52, "18:12")]);
    expect(axis.trusted).toBe(false);
    expect(axis.detail).toContain("concentrados");
  });

  it("rótulos de baixa confiança do OCR são descartados", () => {
    const axis = fitTimeAxis([
      label(0.1, "18:04", 0.95),
      label(0.5, "18:12", 0.2),
      label(0.9, "18:20", 0.95),
    ]);
    expect(axis.anchors).toHaveLength(2);
  });

  it("eixo que corre para trás é recusado", () => {
    const axis = fitTimeAxis([label(0.1, "18:20"), label(0.9, "18:04")]);
    expect(axis.trusted).toBe(false);
    expect(axis.detail).toContain("crescente");
  });

  it("leitura inconsistente derruba a confiança em vez de passar", () => {
    // 18:12 fora da reta por muitos minutos: eixo nao e linear ou o OCR errou.
    const axis = fitTimeAxis([label(0.1, "18:04"), label(0.5, "19:30"), label(0.9, "18:20")]);
    expect(axis.trusted).toBe(false);
    expect(axis.residualMs).toBeGreaterThan(20_000);
  });

  it("confiança cai fora do intervalo lido — inclusive na borda direita", () => {
    const axis = fitTimeAxis([label(0.2, "18:04"), label(0.8, "18:16")]);
    const dentro = confidenceAt(axis, 0.5);
    const extrapolado = confidenceAt(axis, 1.0);
    // O candle mais novo esta sempre fora do intervalo lido: fingir a mesma
    // confianca esconderia que o dado mais importante e o menos garantido.
    expect(extrapolado).toBeLessThan(dentro);
    expect(extrapolado).toBeGreaterThan(0);
  });

  it("sem eixo confiável não há horário — nulo, não Date.now()", () => {
    expect(timeAt(EMPTY_TIME_AXIS, 0.5)).toBeNull();
    expect(confidenceAt(EMPTY_TIME_AXIS, 0.5)).toBe(0);
  });
});

describe("anomalias de sessão", () => {
  it("intervalo normal não é anomalia", () => {
    expect(detectAnomaly(DIA, DIA + MIN, MIN)).toBeNull();
  });

  it("buraco é buraco, não candle perdido", () => {
    // Leilao ou pausa: fato do mercado, precisa aparecer.
    expect(detectAnomaly(DIA, DIA + 5 * MIN, MIN)).toBe("GAP");
  });

  it("silêncio longo é outro pregão", () => {
    expect(detectAnomaly(DIA, DIA + 18 * 3_600_000, MIN)).toBe("SESSAO_NOVA");
  });

  it("tempo andando para trás é retrocesso de replay", () => {
    expect(detectAnomaly(DIA + 5 * MIN, DIA, MIN)).toBe("RETROCESSO");
  });
});

describe("quando reler o eixo", () => {
  it("eixo não confiável sempre pede releitura", () => {
    expect(axisNeedsRefresh(EMPTY_TIME_AXIS, null, 1000, 0)).toBe(true);
  });

  it("relê por rotina a cada minuto", () => {
    const axis = fitTimeAxis([label(0.1, "18:04"), label(0.9, "18:20")]);
    expect(axisNeedsRefresh(axis, null, 100_000, 30_000)).toBe(true);
    expect(axisNeedsRefresh(axis, null, 40_000, 30_000)).toBe(false);
  });

  it("relê quando a observação discorda da reta — zoom ou arrasto", () => {
    const axis = fitTimeAxis([label(0.1, "18:04"), label(0.9, "18:20")]);
    const coerente = { x: 0.5, t: timeAt(axis, 0.5)! };
    expect(axisNeedsRefresh(axis, coerente, 10_000, 5_000)).toBe(false);

    const discordante = { x: 0.5, t: timeAt(axis, 0.5)! + 10 * MIN };
    expect(axisNeedsRefresh(axis, discordante, 10_000, 5_000)).toBe(true);
  });
});
