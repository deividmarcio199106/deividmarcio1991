import { describe, expect, it } from "vitest";

import type { SetupDna } from "../dna";
import {
  compareExitSchemes,
  discoverPatterns,
  lossFactorTable,
  metricsFor,
  MIN_SEGMENT_SAMPLE,
  segmentBy,
  similarWinners,
  DNA_DIMENSIONS,
  type DnaOutcome,
} from "../dnaStats";

const T0 = Date.UTC(2026, 2, 13, 13, 0, 0);
let sequence = 0;

function dna(overrides: Partial<SetupDna> = {}): SetupDna {
  sequence += 1;
  return {
    id: `dna_${sequence}`,
    origin: "REPLAY",
    sourceId: "sessao",
    asset: "WINFUT",
    timeframe: "1m",
    direction: "COMPRA",
    detectedAt: T0 + sequence * 60_000,
    tradingDate: "2026-03-13",
    hour: 10,
    techniqueVersion: "T4.0.0",
    grade: "A",
    trend: "NORMAL",
    position: "A_FAVOR",
    pullback: "LIMPO",
    pullbackDepth: 0.3,
    pullbackBars: 3,
    impulsePoints: 10,
    impulseR: 5,
    location: "SUPORTE",
    locationDetail: "spring",
    triggerCandle: "FECHAMENTO",
    movementOrdinal: 1,
    volatility: "NORMAL",
    volatilityRatio: 1,
    stopDistancePoints: 2,
    rrAvailable: 3,
    entry: 100,
    stop: 98,
    targets: [106],
    printId: null,
    tradeId: null,
    ...overrides,
  };
}

function outcome(
  r: number | null,
  dnaOverrides: Partial<SetupDna> = {},
  extra: Partial<DnaOutcome> = {},
): DnaOutcome {
  return {
    dna: dna(dnaOverrides),
    rMultiple: r,
    mfeR: r === null ? null : Math.max(r, 0.5),
    maeR: r === null ? null : r < 0 ? -1.2 : -0.3,
    costR: null,
    resultMoney: null,
    ...extra,
  };
}

describe("metricsFor", () => {
  it("calcula as métricas do §3 sobre um grupo conhecido", () => {
    const rows = [outcome(3), outcome(-1), outcome(3), outcome(-1), outcome(0)];
    const m = metricsFor("grade", "A", rows);
    expect(m.sample).toBe(5);
    expect(m.wins).toBe(2);
    expect(m.losses).toBe(2);
    expect(m.neutrals).toBe(1);
    expect(m.winRate).toBe(40);
    expect(m.lossRate).toBe(40);
    expect(m.expectancyR).toBe(0.8); // (3-1+3-1+0)/5
    expect(m.payoff).toBe(3); // média ganho 3 / média perda 1
    expect(m.profitFactor).toBe(3); // 6/2
    expect(m.netR).toBe(4);
  });

  it("abaixo da amostra mínima as métricas saem, mas a conclusão é negada", () => {
    const m = metricsFor("grade", "A", [outcome(3), outcome(-1)]);
    expect(m.sufficient).toBe(false);
    expect(m.note).toContain("amostra insuficiente");
    expect(m.note).toContain("conclusão NÃO autorizada");
  });

  it("setup sem operação conta em `detected`, nunca nas métricas", () => {
    const m = metricsFor("grade", "A", [outcome(3), outcome(null)]);
    expect(m.detected).toBe(2);
    expect(m.sample).toBe(1);
  });

  it("custo parcial NÃO produz líquido: null age como zero seria zero disfarçado", () => {
    const rows = [outcome(3, {}, { costR: 0.1 }), outcome(-1, {}, { costR: null })];
    const m = metricsFor("grade", "A", rows);
    expect(m.netR).toBe(2);
    expect(m.netAfterCostsR).toBeNull();
    expect(m.costsCovered).toBe(1);
    expect(m.costNote).toContain("1/2");
  });

  it("com custo conhecido em TODAS as operações o líquido é calculado", () => {
    const rows = [outcome(3, {}, { costR: 0.1 }), outcome(-1, {}, { costR: 0.1 })];
    const m = metricsFor("grade", "A", rows);
    expect(m.netAfterCostsR).toBe(1.8);
    expect(m.costNote).toContain("custo conhecido nas 2");
  });
});

describe("segmentBy", () => {
  it("separa por dimensão e ordena por amostra", () => {
    const rows = [
      outcome(3, { grade: "A_PLUS" }),
      outcome(2, { grade: "A_PLUS" }),
      outcome(-1, { grade: "B" }),
    ];
    const grade = DNA_DIMENSIONS.find((d) => d.key === "grade")!;
    const segments = segmentBy(rows, grade);
    expect(segments[0]!.value).toBe("A_PLUS");
    expect(segments[0]!.sample).toBe(2);
    expect(segments[1]!.value).toBe("B");
  });
});

describe("discoverPatterns", () => {
  it("encontra combinação com amostra suficiente e sugere o Laboratório — nunca bloqueio", () => {
    const rows: DnaOutcome[] = [];
    for (let i = 0; i < MIN_SEGMENT_SAMPLE + 5; i += 1) {
      rows.push(outcome(i % 3 === 0 ? -1 : 2, { grade: "A_PLUS", direction: "VENDA" }));
    }
    const findings = discoverPatterns(rows);
    expect(findings.length).toBeGreaterThan(0);
    const top = findings[0]!;
    expect(top.metrics.sufficient).toBe(true);
    expect(top.suggestion).toContain("Laboratório");
    expect(top.suggestion).toContain("fora da amostra");
    expect(top.suggestion.toLowerCase()).not.toContain("bloquear automaticamente o setup");
  });

  it("grupo abaixo da amostra mínima não vira padrão descoberto", () => {
    const rows = [outcome(5, { grade: "C" }), outcome(5, { grade: "C" })];
    const findings = discoverPatterns(rows);
    expect(findings.find((f) => f.pattern.includes("grade=C"))).toBeUndefined();
  });
});

describe("lossFactorTable", () => {
  it("fator que sobre-representa perdas aparece com lift e frase de associação", () => {
    const rows: DnaOutcome[] = [];
    // 10 perdas contra tendência, 10 ganhos a favor: associação clara.
    for (let i = 0; i < 10; i += 1) {
      rows.push(outcome(-1, { position: "CONTRA_TENDENCIA", trend: "CONTRA" }));
      rows.push(outcome(2, { position: "A_FAVOR", trend: "FORTE" }));
    }
    const factors = lossFactorTable(rows);
    const contra = factors.find((f) => f.value === "CONTRA_TENDENCIA");
    expect(contra).toBeDefined();
    expect(contra!.lift).toBeGreaterThan(1.25);
    expect(contra!.note).toContain("não é afirmação de causa");
  });

  it("sem perdas ou sem ganhos não há comparação possível", () => {
    expect(lossFactorTable([outcome(2), outcome(3)])).toEqual([]);
  });
});

describe("similarWinners", () => {
  it("acha as vencedoras mais parecidas e lista o que difere", () => {
    const loser = outcome(-1, { pullback: "PROFUNDO", position: "CONTRA_TENDENCIA" });
    const rows = [
      loser,
      outcome(2, { pullback: "LIMPO", position: "A_FAVOR" }),
      outcome(3, { pullback: "PROFUNDO", position: "A_FAVOR" }),
    ];
    const similar = similarWinners(loser, rows, 2);
    expect(similar.length).toBe(2);
    // A mais parecida compartilha o pullback PROFUNDO e difere na posição.
    expect(similar[0]!.outcome.dna.pullback).toBe("PROFUNDO");
    expect(similar[0]!.differing.some((d) => d.dimension === "position")).toBe(true);
  });
});

describe("compareExitSchemes", () => {
  it("usa o MFE/MAE das MESMAS operações para cada alvo", () => {
    const rows: DnaOutcome[] = [
      // MFE 3.4 sem tocar stop: alvo 2R vira +2; alvo 5R usa o encerramento real.
      outcome(2.7, {}, { mfeR: 3.4, maeR: -0.31 }),
      // Nunca andou: stop em todos os alvos.
      outcome(-1, {}, { mfeR: 0.2, maeR: -1.5 }),
    ];
    const schemes = compareExitSchemes(rows);
    const alvo2 = schemes.find((s) => s.targetR === 2)!;
    expect(alvo2.sample).toBe(2);
    expect(alvo2.expectancyR).toBe(0.5); // (+2 - 1) / 2
    const alvo5 = schemes.find((s) => s.targetR === 5)!;
    expect(alvo5.expectancyR).toBe(0.85); // (+2.7 real - 1) / 2
  });

  it("alvo e stop alcançados sem ordem gravada contam como stop e saem como ambíguos", () => {
    const rows = [outcome(1.8, {}, { mfeR: 2.5, maeR: -1.2 })];
    const alvo2 = compareExitSchemes(rows).find((s) => s.targetR === 2)!;
    expect(alvo2.ambiguous).toBe(1);
    expect(alvo2.expectancyR).toBe(-1);
    expect(alvo2.note).toContain("conservador");
  });

  it("parcial realizada prova a ordem: alvo até a parcial deixa de contar como stop", () => {
    // Parcial em 3R realizada e depois stop: 2R ocorreu comprovadamente antes.
    const rows = [outcome(0.33, {}, { mfeR: 3.2, maeR: -1.0, partialReachedR: 3 })];
    const schemes = compareExitSchemes(rows);
    const alvo2 = schemes.find((s) => s.targetR === 2)!;
    expect(alvo2.ambiguous).toBe(0);
    expect(alvo2.expectancyR).toBe(2);
    // Acima da parcial a prova não vale: 4R nunca foi tocado (MFE 3.2) e o
    // stop foi — num esquema de alvo único em 4R a operação teria estopado.
    const alvo4 = schemes.find((s) => s.targetR === 4)!;
    expect(alvo4.expectancyR).toBe(-1);
  });

  it("alvo acima do MFE observado é declarado como PISO, não medida", () => {
    const rows = [outcome(1.9, {}, { mfeR: 2.8, maeR: -0.4 })];
    const alvo5 = compareExitSchemes(rows).find((s) => s.targetR === 5)!;
    expect(alvo5.truncatedByExit).toBe(1);
    expect(alvo5.note).toContain("PISO");
  });

  it("o gerenciamento real entra como linha de base com o R registrado", () => {
    const rows = [outcome(2.7, {}, { mfeR: 3.4, maeR: -0.31 }), outcome(-1)];
    const base = compareExitSchemes(rows).find((s) => s.targetR === null)!;
    expect(base.scheme).toContain("GERENCIAMENTO ATUAL");
    expect(base.expectancyR).toBe(0.85);
  });

  it("operação sem MFE/MAE gravados fica fora da comparação — nunca inventada", () => {
    const rows = [outcome(2, {}, { mfeR: null, maeR: null })];
    const schemes = compareExitSchemes(rows);
    expect(schemes[0]!.sample).toBe(0);
  });
});
