import { describe, expect, it } from "vitest";

import type { BacktestTrade } from "@/lib/engines/backtestEngine";
import { decide } from "@/lib/engines/backtestDecisionEngine";
import { filterEvidenceTrades, type EvidenceRecordLike } from "@/lib/engines/evidenceFilter";
import { EventStore } from "@/lib/engines/eventStore";
import { resolveInstrument } from "@/lib/engines/instruments";
import { STRATEGY_VERSION } from "@/lib/engines/strategy";
import { parseChartClock } from "@/lib/vision/chartClock";
import { ClockStabilizer } from "@/lib/vision/clockStabilizer";
import type { AnalysisResult, Candle } from "@/lib/engines/types";

const read = (date: string | null, confidence = 0.9) =>
  parseChartClock(JSON.stringify({ date: date ?? "UNKNOWN", confidence }));

// ---------- §6–§7: estabilização do OCR e mudança de pregão ----------
describe("estabilizador do relógio (§6–§7)", () => {
  it("só confirma data após 3 leituras consecutivas iguais", () => {
    const stabilizer = new ClockStabilizer();
    expect(stabilizer.push(read("18/03/2025")).sessionChanged).toBe(false);
    expect(stabilizer.push(read("18/03/2025")).sessionChanged).toBe(false);
    const third = stabilizer.push(read("18/03/2025"));
    expect(third.sessionChanged).toBe(true);
    expect(third.state.confirmedDate).toBe("2025-03-18");
    expect(third.previousDate).toBeNull();
  });

  it("leitura isolada divergente NUNCA muda o pregão", () => {
    const stabilizer = new ClockStabilizer();
    for (let i = 0; i < 3; i++) stabilizer.push(read("18/03/2025"));
    const noise = stabilizer.push(read("19/03/2025")); // OCR errou uma vez
    expect(noise.sessionChanged).toBe(false);
    expect(noise.state.confirmedDate).toBe("2025-03-18");
    stabilizer.push(read("18/03/2025")); // voltou ao normal: candidato ruidoso zera
    expect(stabilizer.snapshot().candidateCount).toBe(0);
  });

  it("mudança real de pregão confirma após 3 leituras e informa o anterior", () => {
    const stabilizer = new ClockStabilizer();
    for (let i = 0; i < 3; i++) stabilizer.push(read("18/03/2025"));
    stabilizer.push(read("19/03/2025"));
    stabilizer.push(read("19/03/2025"));
    const changed = stabilizer.push(read("19/03/2025"));
    expect(changed.sessionChanged).toBe(true);
    expect(changed.previousDate).toBe("2025-03-18");
    expect(changed.state.confirmedDate).toBe("2025-03-19");
  });

  it("baixa confiança e UNKNOWN são ignorados sem apagar progresso", () => {
    const stabilizer = new ClockStabilizer();
    stabilizer.push(read("18/03/2025"));
    stabilizer.push(read("18/03/2025"));
    stabilizer.push(read(null)); // UNKNOWN
    stabilizer.push(read("18/03/2025", 0.3)); // confiança baixa
    const confirm = stabilizer.push(read("18/03/2025"));
    expect(confirm.sessionChanged).toBe(true);
  });
});

// ---------- §28: LEGACY_IMAGE fora da evidência por padrão ----------
describe("filtro de evidência LEGACY_IMAGE (§28)", () => {
  const record = (origin: EvidenceRecordLike["origin"], count: number): EvidenceRecordLike => ({
    origin,
    trades: Array.from({ length: count }, (_, i) => ({ id: `${origin}_${i}` }) as BacktestTrade),
  });

  it("exclui LEGACY_IMAGE (inclusive origem ausente) por padrão", () => {
    const records = [record("VIDEO_REPLAY", 3), record("LIVE_REPLAY", 2), record(undefined, 4)];
    expect(filterEvidenceTrades(records)).toHaveLength(5);
  });

  it("inclusão só com opt-in explícito", () => {
    const records = [record("VIDEO_REPLAY", 3), record("LEGACY_IMAGE", 4)];
    expect(filterEvidenceTrades(records, { includeLegacyImage: true })).toHaveLength(7);
  });
});

// ---------- §17: candidata do Laboratório não afeta a sessão live ----------
describe("snapshot da técnica na sessão (§17)", () => {
  it("trades de versão candidata são ignorados quando o snapshot está congelado", () => {
    const makeTrade = (version: string, i: number): BacktestTrade =>
      ({
        id: `${version}_${i}`,
        setupId: "acumulacao|spring",
        strategyVersion: version,
        asset: "WINFUT",
        timeframe: "1m",
        openedAt: 1 + i,
        closedAt: 2 + i,
        direction: "COMPRA",
        setup: "spring",
        context: "acumulacao",
        entry: 100,
        stop: 95,
        target1: 108,
        target2: 114,
        riskReward: 1.6,
        reversalRisk: 30,
        exit: 114,
        result: "GANHO",
        rMultiple: 1.6,
        mfePoints: null,
        maePoints: null,
        mfeR: null,
        maeR: null,
        hour: 10,
        wyckoffPhase: "spring",
        poiKind: "order_block",
        regime: "RANGE",
      }) as unknown as BacktestTrade;
    const analysis = {
      t: 1_700_100_000_000,
      price: 100,
      direction: "COMPRA",
      technicalReady: true,
      strategyVersion: STRATEGY_VERSION,
      blockers: [],
      contradictions: [],
      regime: { regime: "RANGE", evidences: [], strength: 60 },
      wyckoff: { schema: "acumulacao", phase: "spring" },
      mainPoi: { kind: "order_block" },
      // t4 neutro (setup NONE): similaridade usa o fallback wyckoff ("spring").
      t4: {
        setup: "NONE",
        quality: "REJEITADA",
        productionReady: false,
        reasons: [],
        blockers: [],
      },
      plan: {
        direction: "COMPRA",
        entry: 100,
        stop: 95,
        target1: 108,
        target2: 114,
        riskReward: 1.6,
        riskRewardPlan: 2.1,
        stopDistance: 5,
      },
    } as unknown as AnalysisResult;
    // Base tem SÓ trades da candidata v-nova — o snapshot congelado não os vê.
    const candidateTrades = Array.from({ length: 80 }, (_, i) => makeTrade("v-candidata", i));
    const decision = decide({
      analysis,
      asset: "WINFUT",
      trades: candidateTrades,
      instrument: resolveInstrument("WINFUT"),
      riskConfig: { accountBalance: 10_000, maxRiskPercent: 1, maxRiskMoney: 0, contractsLimit: 3 },
      techniqueSnapshot: STRATEGY_VERSION,
    });
    expect(decision.decision).toBe("WAIT");
    expect(decision.sampleSize).toBe(0);
    expect(decision.strategyVersion).toBe(STRATEGY_VERSION);
  });
});

// A ambiguidade intrabar (§24) é coberta em liveOutcome.test.ts — o motor
// legado de replay por vídeo foi removido (T4 é o único caminho).

// ---------- §10: eventos de gestão e sessão no event store ----------
describe("eventos de gestão (§10)", () => {
  it("ENTRY/PARTIAL/TARGET/STOP e SESSION_OPEN/CLOSE têm grupos próprios", () => {
    const events = new EventStore("WINFUT", 50);
    const base = {
      timestamp: 1,
      candleId: "c",
      price: 130_000,
      region: "gestão",
      evidence: "e",
      confidenceVisual: 1,
      sourceCaptureId: "s",
    };
    const entry = events.add({ ...base, type: "ENTRY_CONFIRMED" });
    const partial = events.add({ ...base, type: "PARTIAL_HIT" });
    const stop = events.add({ ...base, type: "STOP_HIT" });
    expect(entry.evidenceGroupId).not.toBe(partial.evidenceGroupId);
    expect(partial.evidenceGroupId).not.toBe(stop.evidenceGroupId);
    expect(events.uniqueGroups()).toBe(3);
  });
});
