import { describe, expect, it } from "vitest";

import { formatFactor, formatInt, formatNumber, formatPct, formatR, ordinalLabel } from "./format";

/**
 * O que está em teste NÃO é o toLocaleString do Node — é o contrato de
 * honestidade dos formatadores: ausência vira "—" (nunca zero), sinal sempre
 * presente no R, Infinity dito como "∞".
 */
describe("formatR", () => {
  it("2 decimais, vírgula pt-BR e sinal explícito nos dois lados", () => {
    expect(formatR(1.254)).toBe("+1,25R");
    expect(formatR(-0.5)).toBe("-0,50R");
    expect(formatR(0)).toBe("+0,00R");
  });

  it("null nunca vira zero — ausência é dita", () => {
    expect(formatR(null)).toBe("—");
  });
});

describe("formatPct", () => {
  it("valor já em pontos percentuais, 1 decimal no máximo", () => {
    expect(formatPct(54.345)).toBe("54,3%");
    expect(formatPct(100)).toBe("100%");
  });

  it("null é ausência, não 0%", () => {
    expect(formatPct(null)).toBe("—");
  });
});

describe("formatInt", () => {
  it("milhar com ponto, como o resto do produto", () => {
    expect(formatInt(1234)).toBe("1.234");
    expect(formatInt(7)).toBe("7");
  });
});

describe("formatFactor", () => {
  it("Infinity (grupo sem perdas) é dito como ∞, nunca arredondado", () => {
    expect(formatFactor(Infinity)).toBe("∞");
  });

  it("null e número normal", () => {
    expect(formatFactor(null)).toBe("—");
    expect(formatFactor(1.5)).toBe("1,50");
  });
});

describe("formatNumber", () => {
  it("decimais fixos sem sinal forçado", () => {
    expect(formatNumber(3)).toBe("3,00");
    expect(formatNumber(null)).toBe("—");
  });
});

describe("ordinalLabel", () => {
  it("1ª/2ª/3ª/posterior e null dito como SEM ORDINAL", () => {
    expect(ordinalLabel(1)).toBe("1ª");
    expect(ordinalLabel(2)).toBe("2ª");
    expect(ordinalLabel(3)).toBe("3ª");
    expect(ordinalLabel(4)).toBe("posterior");
    expect(ordinalLabel(null)).toBe("SEM ORDINAL");
  });
});
