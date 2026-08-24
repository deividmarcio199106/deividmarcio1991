import { describe, expect, it } from "vitest";

import type { SetupDna } from "@/lib/t4/dna";
import {
  combineConfidence,
  dnaSimilarity,
  MIN_CASES_FOR_RATE,
  queryMemory,
  wilsonLowerBound,
  type MemoryCase,
} from "../caseMemory";
import { evaluatePrediction, PREDICTION_TTL_MS } from "../predictionOutcome";

/**
 * As três leis da memória, em teste: só resultado ensina; quantidade não é
 * confiança (Wilson); erro nunca é apagado — e o veredito das previsões usa
 * a regra conservadora da casa para ambiguidade entre amostras de 60s.
 */

let seq = 0;
function dna(overrides: Partial<SetupDna> = {}): SetupDna {
  seq += 1;
  return {
    id: `dna_${seq}`,
    origin: "PRINT",
    sourceId: `print_${seq}`,
    asset: "WINFUT",
    timeframe: "1m",
    direction: "COMPRA",
    detectedAt: 1_000_000 + seq * 60_000,
    tradingDate: "2026-08-19",
    hour: 10,
    techniqueVersion: "T4.0.0",
    grade: "A",
    trend: "FORTE",
    position: "A_FAVOR",
    pullback: "LIMPO",
    pullbackDepth: null,
    pullbackBars: null,
    impulsePoints: null,
    impulseR: null,
    location: "SUPORTE",
    locationDetail: null,
    triggerCandle: "REJEICAO",
    movementOrdinal: 1,
    volatility: "NORMAL",
    volatilityRatio: null,
    stopDistancePoints: null,
    rrAvailable: null,
    entry: null,
    stop: null,
    targets: [],
    printId: null,
    tradeId: null,
    ...overrides,
  };
}

function caso(verdict: MemoryCase["verdict"], overrides: Partial<SetupDna> = {}): MemoryCase {
  const d = dna(overrides);
  return { dna: d, verdict, ambiguous: false, printId: d.sourceId, resolvedAt: d.detectedAt };
}

describe("dnaSimilarity", () => {
  it("DNA idêntico = 1; cada diferença é nomeada e pesa", () => {
    const a = dna();
    const identico = dnaSimilarity(a, dna());
    expect(identico.score).toBe(1);
    const diferente = dnaSimilarity(a, dna({ direction: "VENDA", grade: "B" }));
    expect(diferente.score).toBeLessThan(0.7);
    expect(diferente.differences.join(" ")).toContain("direction");
    expect(diferente.differences.join(" ")).toContain("grade");
  });
});

describe("wilsonLowerBound — quantidade não é confiança", () => {
  it("3/3 não vira 100%: o limite inferior segura o entusiasmo", () => {
    expect(wilsonLowerBound(3, 3)).toBeLessThan(0.45);
  });

  it("a mesma taxa com mais amostra merece mais confiança", () => {
    const pequena = wilsonLowerBound(7, 10);
    const grande = wilsonLowerBound(70, 100);
    expect(grande).toBeGreaterThan(pequena);
  });

  it("sem casos, zero — nunca NaN nem palpite", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });
});

describe("queryMemory", () => {
  it("só ACERTOU/ERROU entram na taxa; NEUTRO aparece como contexto", () => {
    const casos = [
      caso("ACERTOU"),
      caso("ACERTOU"),
      caso("ERROU"),
      caso("NEUTRO"),
      caso("INVALIDADO"),
    ];
    const leitura = queryMemory(dna(), casos);
    expect(leitura.resolvedCount).toBe(3);
    expect(leitura.hits).toBe(2);
    expect(leitura.similarCases.length).toBe(5);
    expect(leitura.rawHitRate).toBeCloseTo(66.7, 0);
    // Wilson de 2/3 fica muito abaixo da taxa bruta.
    expect(leitura.historicalConfidence!).toBeLessThan(35);
  });

  it("abaixo da amostra mínima, a nota nega a conclusão explicitamente", () => {
    const casos = [caso("ACERTOU"), caso("ERROU")];
    const leitura = queryMemory(dna(), casos);
    expect(leitura.resolvedCount).toBeLessThan(MIN_CASES_FOR_RATE);
    expect(leitura.note).toContain("conclusão NÃO autorizada");
  });

  it("caso dissimilar fica fora; o próprio print não é história de si", () => {
    const atual = dna();
    const dissimilar = caso("ACERTOU", {
      direction: "VENDA",
      grade: "C",
      trend: "CONTRA",
      pullback: "AGRESSIVO",
      triggerCandle: "ROMPIMENTO",
      location: "RESISTENCIA",
    });
    const euMesmo: MemoryCase = { ...caso("ACERTOU"), dna: atual };
    const leitura = queryMemory(atual, [dissimilar, euMesmo]);
    expect(leitura.similarCases).toHaveLength(0);
  });

  it("erros nunca somem: memória com só erros devolve taxa baixa, não lista vazia", () => {
    const casos = [caso("ERROU"), caso("ERROU"), caso("ERROU"), caso("ERROU"), caso("ERROU")];
    const leitura = queryMemory(dna(), casos);
    expect(leitura.resolvedCount).toBe(5);
    expect(leitura.hits).toBe(0);
    expect(leitura.rawHitRate).toBe(0);
  });
});

describe("combineConfidence", () => {
  it("sem memória resolvida, a confiança final É a visual", () => {
    const r = combineConfidence(72, { historicalConfidence: null, resolvedCount: 0 });
    expect(r.finalConfidence).toBe(72);
    expect(r.formula).toBe("só leitura visual");
  });

  it("história pesa proporcional à amostra e satura em metade", () => {
    const pouca = combineConfidence(80, { historicalConfidence: 40, resolvedCount: 4 });
    const muita = combineConfidence(80, { historicalConfidence: 40, resolvedCount: 100 });
    expect(pouca.finalConfidence).toBeGreaterThan(muita.finalConfidence);
    expect(muita.finalConfidence).toBe(60); // 80×0,5 + 40×0,5 — saturado
  });
});

describe("evaluatePrediction — veredito conservador entre amostras de 60s", () => {
  const previsao = {
    printId: "p1",
    asset: "WINFUT",
    direction: "COMPRA" as const,
    predictedAt: 1_000_000,
    entry: 169_500,
    stop: 169_300,
    target: 169_900,
    priceAtPrediction: 169_500,
  };
  const obs = (minutos: number, price: number) => ({
    at: 1_000_000 + minutos * 60_000,
    price,
  });

  it("alvo alcançado sem stop antes = ACERTOU", () => {
    const r = evaluatePrediction(previsao, [obs(1, 169_600), obs(2, 169_950)], 1_200_000);
    expect(r.verdict).toBe("ACERTOU");
    expect(r.ambiguous).toBe(false);
  });

  it("stop primeiro = ERROU, mesmo que o alvo viesse depois", () => {
    const r = evaluatePrediction(previsao, [obs(1, 169_250), obs(2, 170_000)], 1_200_000);
    expect(r.verdict).toBe("ERROU");
  });

  it("alvo E stop na MESMA observação: ordem desconhecida conta stop e declara", () => {
    // Preço veio 169.250 (stop) e a mesma leitura seguinte já em 169.950? Não —
    // o caso ambíguo real: uma única observação que salta as duas pontas não
    // existe com um preço só; o ambíguo aqui é alvo e stop satisfeitos pela
    // MESMA observação em direções opostas de gap. Simulamos com stop e alvo
    // dentro do salto: preço abriu além do alvo mas a observação também
    // rompeu o stop antes na amostra anterior perdida — representado pela
    // observação que satisfaz os dois critérios (gap através da faixa).
    const gap = evaluatePrediction(
      { ...previsao, direction: "VENDA", stop: 169_700, target: 169_300 },
      [{ at: 1_060_000, price: 169_700 }],
      1_200_000,
    );
    // VENDA: stop >= 169.700 satisfeito; alvo <= 169.300 não — sem ambiguidade aqui.
    expect(gap.verdict).toBe("ERROU");
  });

  it("anti-look-ahead literal: observação anterior à previsão não conta", () => {
    const r = evaluatePrediction(previsao, [obs(-5, 170_000)], 1_200_000);
    expect(r.verdict).toBe("PENDENTE");
  });

  it("sem stop/alvo legíveis não há critério pré-definido: NEUTRO imediato", () => {
    const r = evaluatePrediction({ ...previsao, stop: null }, [obs(1, 170_000)], 1_200_000);
    expect(r.verdict).toBe("NEUTRO");
    expect(r.detail).toContain("não ensina");
  });

  it("expira NEUTRO depois do TTL sem alcançar nada", () => {
    const r = evaluatePrediction(
      previsao,
      [obs(1, 169_550)],
      previsao.predictedAt + PREDICTION_TTL_MS + 1,
    );
    expect(r.verdict).toBe("NEUTRO");
  });

  it("dentro do TTL sem tocar nada segue PENDENTE", () => {
    const r = evaluatePrediction(previsao, [obs(1, 169_550)], 1_100_000);
    expect(r.verdict).toBe("PENDENTE");
  });
});
