import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BacktestRecord, TradingSessionRecord } from "@/lib/storage";
import {
  getProductionTechnique,
  getSnapshot,
  promoteTechniqueCandidate,
  resetTradingRepositoryForTests,
  upsertBacktest,
  upsertMarketEvent,
  upsertTechniqueCandidate,
  upsertTradingSession,
} from "./tradingRepository";

let workingDir: string | null = null;

function freshDatabase(): string {
  resetTradingRepositoryForTests();
  const dir = mkdtempSync(join(tmpdir(), "analisador-db-"));
  workingDir = dir;
  process.env.DATA_DIR = dir;
  delete process.env.DATABASE_PATH;
  return dir;
}

afterEach(() => {
  resetTradingRepositoryForTests();
  if (workingDir) rmSync(workingDir, { recursive: true, force: true });
  workingDir = null;
  delete process.env.DATA_DIR;
  delete process.env.DATABASE_PATH;
});

describe.sequential("repositório SQLite persistente", () => {
  it("mantém pregão, evento e trade depois de reabrir o banco", () => {
    freshDatabase();
    const startedAt = 1_700_000_000_000;
    const session: TradingSessionRecord = {
      id: "session_1",
      source: "VIDEO_REPLAY",
      symbol: "WINFUT",
      tradingDate: "2025-03-18",
      timeframe: "1m",
      startedAt,
      endedAt: startedAt + 60_000,
      techniqueVersion: "v4.0.0",
      segmentCount: 1,
      eventCount: 1,
      tradeCount: 1,
      createdAt: startedAt,
    };
    upsertTradingSession(session);
    upsertMarketEvent({
      eventId: "evt_1",
      sessionId: session.id,
      timestamp: startedAt,
      type: "SESSION_OPEN",
      source: "VIDEO_REPLAY",
      techniqueVersion: "v4.0.0",
    });

    const record = {
      id: "backtest_1",
      strategyVersion: "v4.0.0",
      asset: "WINFUT",
      timeframe: "1m",
      createdAt: startedAt,
      sourceCaptureId: "capture_1",
      origin: "VIDEO_REPLAY",
      trades: [
        {
          id: "trade_1",
          setupId: "setup_1",
          strategyVersion: "v4.0.0",
          asset: "WINFUT",
          timeframe: "1m",
          openedAt: startedAt,
          closedAt: startedAt + 60_000,
          direction: "COMPRA",
          setup: "Spring+LiquiditySweep",
          context: "Acumulação",
          entry: 100,
          stop: 95,
          target1: 108,
          target2: 114,
          riskReward: 2.8,
          reversalRisk: 0,
          exit: 114,
          result: "GANHO",
          rMultiple: 2,
          mfePoints: 14,
          maePoints: 2,
          mfeR: 2.8,
          maeR: 0.4,
          hour: 10,
          wyckoffPhase: "C",
          poiKind: "retest",
          regime: "RANGE",
          sourceCaptureId: "capture_1",
          tradingSessionId: session.id,
          origin: "VIDEO_REPLAY",
          frozenAnalysis: {},
        },
      ],
    } as unknown as BacktestRecord;
    upsertBacktest(record);

    resetTradingRepositoryForTests();
    const snapshot = getSnapshot();
    expect(snapshot.tradingSessions.some((item) => item.id === session.id)).toBe(true);
    expect(snapshot.backtests.find((item) => item.id === record.id)?.trades).toHaveLength(1);
  });

  it("não promove candidata sem validação e promove somente VALIDATED", () => {
    freshDatabase();
    const production = getProductionTechnique();
    expect(production?.status).toBe("PRODUCTION");

    const base = production?.version ?? "v4.0.0";
    upsertTechniqueCandidate({
      id: "candidate_1",
      version: "v4.1.0",
      baseVersion: base,
      hypothesis: "Hipótese baseada em evidência histórica.",
      status: "DISCOVERED",
      rules: { setup: "Spring+LiquiditySweep" },
      createdAt: 1,
      updatedAt: 1,
    });
    expect(() => promoteTechniqueCandidate("candidate_1")).toThrow(/VALIDATED/);

    upsertTechniqueCandidate({
      id: "candidate_1",
      version: "v4.1.0",
      baseVersion: base,
      hypothesis: "Hipótese aprovada na trilha formal.",
      status: "VALIDATED",
      rules: { setup: "Spring+LiquiditySweep" },
      createdAt: 1,
      updatedAt: 2,
    });
    expect(promoteTechniqueCandidate("candidate_1").version).toBe("v4.1.0");
  });
});
