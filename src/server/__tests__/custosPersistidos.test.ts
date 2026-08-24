import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { BacktestRecord } from "@/lib/storage";
import {
  listDnaOutcomes,
  resetTradingRepositoryForTests,
  upsertBacktest,
} from "../tradingRepository";

/**
 * A CADEIA DO CUSTO ATÉ A ESTATÍSTICA (auditoria sênior, BLOCO 5).
 *
 * Liquidar no fechamento não basta se o número morrer no caminho: aqui se
 * tranca que (1) `costs_brl`/`result_brl`/`slippage_points` chegam às COLUNAS
 * (eram sempre null), e (2) `outcomeFromTrade` propaga o `costR` REAL para o
 * DnaOutcome — que é de onde `dnaStats` calcula `netAfterCostsR`. Trade
 * antigo sem o campo segue null: custo desconhecido nunca vira zero.
 */

let workingDir: string | null = null;

function freshDatabase(): string {
  resetTradingRepositoryForTests();
  const dir = mkdtempSync(join(tmpdir(), "analisador-custos-"));
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

const T0 = 1_772_000_000_000;

function tradeComCusto(id: string, extras: Record<string, unknown> = {}) {
  return {
    id,
    setupId: "T4|TREND_FIRST_PULLBACK|TREND_UP",
    strategyVersion: "T4.0.0",
    asset: "WINFUT",
    timeframe: "1m",
    openedAt: T0,
    closedAt: T0 + 300_000,
    direction: "COMPRA",
    setup: "TREND_FIRST_PULLBACK",
    context: "Tendência",
    entry: 169_500,
    stop: 169_300,
    target1: 170_100,
    target2: 170_500,
    riskReward: 3,
    reversalRisk: 10,
    exit: 170_100,
    result: "GANHO",
    rMultiple: 3,
    mfePoints: 620,
    maePoints: 40,
    mfeR: 3.1,
    maeR: 0.2,
    hour: 10,
    wyckoffPhase: "D",
    poiKind: "retest",
    regime: "TREND_UP",
    sourceCaptureId: "teste",
    tradingSessionId: null,
    tradingDate: "02/03/2026",
    origin: "VIDEO_REPLAY",
    frozenAnalysis: {},
    // `quality` faz a linha entrar como orphan-trade no listDnaOutcomes.
    quality: "A",
    stopDistancePoints: 200,
    costsBrl: 16.62,
    resultBrl: 343.38,
    slippagePoints: 15,
    costR: 0.1385,
    ...extras,
  };
}

function record(id: string, trades: unknown[]): BacktestRecord {
  return {
    id,
    strategyVersion: "T4.0.0",
    asset: "WINFUT",
    timeframe: "1m",
    createdAt: T0,
    sourceCaptureId: "teste",
    origin: "VIDEO_REPLAY",
    trades,
  } as unknown as BacktestRecord;
}

describe.sequential("custos persistidos e propagados", () => {
  it("as colunas costs_brl/result_brl/slippage_points saem do null", () => {
    const dir = freshDatabase();
    upsertBacktest(record("bt_custos", [tradeComCusto("trade_custo_1")]));
    resetTradingRepositoryForTests();
    const database = new DatabaseSync(join(dir, "analisador.sqlite"));
    const row = database
      .prepare("SELECT costs_brl, result_brl, slippage_points FROM trades WHERE id='trade_custo_1'")
      .get() as { costs_brl: number; result_brl: number; slippage_points: number };
    database.close();
    expect(row.costs_brl).toBeCloseTo(16.62, 2);
    expect(row.result_brl).toBeCloseTo(343.38, 2);
    expect(row.slippage_points).toBe(15);
  });

  it("outcomeFromTrade propaga o costR REAL para a estatística de DNA", () => {
    freshDatabase();
    upsertBacktest(record("bt_custos", [tradeComCusto("trade_custo_2")]));
    const outcomes = listDnaOutcomes({});
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.costR).toBeCloseTo(0.1385, 4);
    expect(outcomes[0]!.resultMoney).toBeCloseTo(343.38, 2);
  });

  it("trade antigo SEM costR segue null — custo desconhecido nunca vira zero", () => {
    freshDatabase();
    upsertBacktest(
      record("bt_legado", [
        tradeComCusto("trade_legado", {
          costsBrl: undefined,
          resultBrl: undefined,
          slippagePoints: undefined,
          costR: undefined,
        }),
      ]),
    );
    const outcomes = listDnaOutcomes({});
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.costR).toBeNull();
  });
});
