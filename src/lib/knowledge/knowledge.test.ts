import { describe, expect, it } from "vitest";

import type { BacktestTrade } from "@/lib/engines/backtestEngine";
import type { AnalysisResult } from "@/lib/engines/types";
import { detectTechniqueIds, detectTechniqueSnapshot, detectTechniques } from "./techniqueDetector";
import { detectableTechniques, TECHNIQUE_LIBRARY, techniqueById } from "./techniqueLibrary";
import { techniqueStats, TECHNIQUE_MIN_SAMPLE } from "./techniqueStats";

function makeAnalysis(overrides: Record<string, unknown> = {}): AnalysisResult {
  return {
    t: 1_700_100_000_000,
    price: 131_000,
    direction: "COMPRA",
    score: 85,
    scoreBand: "confirmado",
    qualified: true,
    strategyVersion: "v-teste",
    blockers: [],
    contradictions: [],
    regime: { regime: "RANGE", evidences: [], strength: 60 },
    wyckoff: { schema: "Acumulação", phase: "C", events: [], confidence: 70, label: "" },
    mainPoi: { id: "p1", kind: "origem_deslocamento", condition: "testado" },
    plan: {
      direction: "COMPRA",
      entry: 131_000,
      stop: 130_800,
      target1: 131_320,
      target2: 131_560,
      riskReward: 1.6,
      riskRewardPlan: 2.1,
      stopDistance: 200,
    },
    sequence: {
      direction: "COMPRA",
      stages: [{ stage: "sweep", met: true, note: "" }],
      complete: true,
      missing: [],
      staleSweep: false,
      orderViolated: false,
    },
    internalConfirmation: {
      capture: {
        valid: true,
        direction: "COMPRA",
        quality: 80,
        isAcceptedBreakoutOnly: false,
        detail: {
          levelId: "l1",
          type: "sweep",
          price: 130_700,
          side: "vendedora",
          at: 1,
          strength: 70,
          sweepDepth: 40,
          rejection: 60,
        },
      },
      sms: {
        confirmed: true,
        pending: false,
        direction: "COMPRA",
        brokenLevel: 130_950,
        displacement: 120,
        closeConfirmed: true,
        liquidityDefended: true,
        reactionConfirmed: true,
      },
    },
    ...overrides,
  } as unknown as AnalysisResult;
}

describe("integridade da biblioteca", () => {
  it("ids únicos; detectáveis sem requiredData; catalogadas explicam o que falta", () => {
    const ids = TECHNIQUE_LIBRARY.map((technique) => technique.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const technique of TECHNIQUE_LIBRARY) {
      expect(technique.origin.length).toBeGreaterThan(5);
      expect(technique.trigger.length).toBeGreaterThan(10);
      if (technique.status === "CATALOGED") {
        expect(technique.requiredData.join(" ").length > 10).toBe(true);
      }
    }
    expect(detectableTechniques().length).toBeGreaterThanOrEqual(6);
    expect(techniqueById("spring-acumulacao")?.category).toBe("wyckoff");
    expect(techniqueById("inexistente")).toBeNull();
  });
});

describe("detector de técnicas (determinístico e honesto)", () => {
  it("detecta spring + sweep SMC + order block + falso rompimento na fixture completa", () => {
    const ids = detectTechniqueIds(makeAnalysis());
    expect(ids).toContain("spring-acumulacao");
    expect(ids).toContain("sweep-reversao-smc");
    expect(ids).toContain("order-block-retest");
    expect(ids).toContain("falso-rompimento-brooks");
    // A gestão anexada é a de PRODUÇÃO (3 contratos), não o plano legado de
    // duas pernas: marcar a operação com uma gestão que o sistema não executa
    // envenenava o histórico e o contexto da IA.
    expect(ids).toContain("gestao-t4-3-contratos");
    expect(ids).not.toContain("parcial-60-40");
    // Espelho de distribuição NÃO pode aparecer numa acumulação comprada.
    expect(ids).not.toContain("utad-distribuicao");
  });

  it("sem captura válida, nada de spring/sweep; direção NEUTRO derruba tudo exceto nada", () => {
    const semCaptura = makeAnalysis();
    (semCaptura.internalConfirmation.capture as { valid: boolean }).valid = false;
    const ids = detectTechniqueIds(semCaptura);
    expect(ids).not.toContain("spring-acumulacao");
    expect(ids).not.toContain("sweep-reversao-smc");

    const neutro = makeAnalysis({ direction: "NEUTRO", plan: null });
    expect(detectTechniqueIds(neutro)).toHaveLength(0);
  });

  it("UTAD detectado no espelho vendedor em Distribuição", () => {
    const utad = makeAnalysis({
      direction: "VENDA",
      wyckoff: { schema: "Distribuição", phase: "C", events: [], confidence: 70, label: "" },
    });
    (utad.internalConfirmation.capture.detail as { side: string }).side = "compradora";
    (utad.internalConfirmation.sms as { direction: string }).direction = "VENDA";
    const ids = detectTechniqueIds(utad);
    expect(ids).toContain("utad-distribuicao");
    expect(ids).not.toContain("spring-acumulacao");
  });

  it("BOS de continuação exige regime de tendência NA MESMA direção", () => {
    const range = detectTechniqueIds(makeAnalysis());
    expect(range).not.toContain("bos-continuacao");
    const trend = detectTechniqueIds(
      makeAnalysis({ regime: { regime: "TREND_UP", evidences: [], strength: 70 } }),
    );
    expect(trend).toContain("bos-continuacao");
  });

  it("técnica CATALOGADA jamais é detectada, mesmo com evidências para adicioná-la", () => {
    const matches = detectTechniques(makeAnalysis());
    for (const match of matches) {
      expect(match.technique.status).toBe("DETECTABLE");
    }
    expect(matches.map((m) => m.techniqueId)).not.toContain("absorcao-orderflow");
    expect(matches.map((m) => m.techniqueId)).not.toContain("fvg-mitigacao");
  });

  it("cada detecção carrega evidências textuais rastreáveis", () => {
    for (const match of detectTechniques(makeAnalysis())) {
      expect(match.evidence.length).toBeGreaterThan(0);
      expect(match.evidence.every((evidence) => evidence.length > 10)).toBe(true);
      expect(match.detectedAt).toBe(1_700_100_000_000);
      expect(match.detectorVersion).toBe(match.technique.detectorVersion);
    }
  });

  it("snapshot grava ids e versões dos detectores sem score/confluência", () => {
    const snapshot = detectTechniqueSnapshot(makeAnalysis());
    expect(snapshot.techniqueIds.length).toBeGreaterThan(0);
    expect(Object.keys(snapshot.techniqueDetectorVersions).sort()).toEqual(
      [...snapshot.techniqueIds].sort(),
    );
    for (const id of snapshot.techniqueIds) {
      expect(snapshot.techniqueDetectorVersions[id]).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

describe("estatística individual por técnica", () => {
  const makeTrade = (i: number, techniques: string[], win: boolean): BacktestTrade =>
    ({
      id: `t${i}`,
      setupId: "s",
      strategyVersion: "v",
      asset: "WINFUT",
      timeframe: "1m",
      openedAt: i,
      closedAt: i + 1,
      direction: "COMPRA",
      setup: "spring",
      context: "acumulacao",
      score: 85,
      scoreBand: "confirmado",
      entry: 100,
      stop: 95,
      target1: 108,
      target2: 114,
      riskReward: 1.6,
      reversalRisk: 30,
      exit: win ? 114 : 95,
      result: win ? "GANHO" : "PERDA",
      rMultiple: win ? 1.6 : -1,
      mfePoints: null,
      maePoints: null,
      mfeR: null,
      maeR: null,
      hour: 10,
      wyckoffPhase: "C",
      poiKind: "order_block",
      regime: "RANGE",
      techniqueIds: techniques,
      techniqueDetectorVersions: Object.fromEntries(techniques.map((id) => [id, "1.0.0"])),
      productionTechniqueVersion: "v",
    }) as unknown as BacktestTrade;

  it("gate de amostra: abaixo de 30 casos = AMOSTRA INSUFICIENTE mesmo com 100% de acerto", () => {
    const trades = Array.from({ length: 10 }, (_, i) => makeTrade(i, ["spring-acumulacao"], true));
    const row = techniqueStats(trades).find((r) => r.technique.id === "spring-acumulacao")!;
    expect(row.verdict).toBe("AMOSTRA_INSUFICIENTE");
    expect(row.sample).toBe(10);
  });

  it("com amostra e expectância positiva = VALIDADA; negativa = NAO_VALIDADA", () => {
    const good = Array.from({ length: TECHNIQUE_MIN_SAMPLE + 10 }, (_, i) =>
      makeTrade(i, ["spring-acumulacao"], i % 10 < 6),
    );
    const bad = Array.from({ length: TECHNIQUE_MIN_SAMPLE + 10 }, (_, i) =>
      makeTrade(100 + i, ["bos-continuacao"], i % 10 < 2),
    );
    const rows = techniqueStats([...good, ...bad]);
    expect(rows.find((r) => r.technique.id === "spring-acumulacao")!.verdict).toBe("VALIDADA");
    expect(rows.find((r) => r.technique.id === "bos-continuacao")!.verdict).toBe("NAO_VALIDADA");
  });

  it("técnica catalogada informa o dado que falta em vez de estatística", () => {
    const row = techniqueStats([]).find((r) => r.technique.id === "absorcao-orderflow")!;
    expect(row.verdict).toBe("AMOSTRA_INSUFICIENTE");
    expect(row.reason).toContain("Não detectável");
    expect(row.stats).toBeNull();
  });
});
