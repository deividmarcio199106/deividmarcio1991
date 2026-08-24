import { describe, expect, it } from "vitest";

import type { BacktestTrade } from "./backtestEngine";
import { computeDailyPerformance, computePointStats, realizedPoints } from "./performanceEngine";

function trade(id: string, date: string, rMultiple: number, stopDistance = 200): BacktestTrade {
  return {
    id,
    setupId: "Acumulação|spring",
    strategyVersion: "v4.0.0",
    asset: "WINFUT",
    timeframe: "1m",
    signalAt: 1,
    openedAt: Number(id.replace(/\D/g, "")) || 1,
    closedAt: (Number(id.replace(/\D/g, "")) || 1) + 1,
    entryHitAt: 1,
    partialHitAt: null,
    exitAt: 2,
    direction: "COMPRA",
    setup: "spring",
    context: "teste",
    entry: 130_000,
    stop: 130_000 - stopDistance,
    target1: 130_300,
    target2: 130_500,
    riskReward: 2.5,
    reversalRisk: 10,
    exit: 130_000 + rMultiple * stopDistance,
    result: rMultiple > 0 ? "GANHO" : rMultiple < 0 ? "PERDA" : "NEUTRO",
    rMultiple,
    mfePoints: rMultiple > 0 ? 400 : 80,
    maePoints: rMultiple < 0 ? 200 : 50,
    mfeR: null,
    maeR: null,
    tradingDate: date,
    hour: 10,
    wyckoffPhase: "spring",
    poiKind: "teste",
    regime: "RANGE",
    sourceCaptureId: "teste",
    origin: "BACKTEST",
    frozenAnalysis: {} as BacktestTrade["frozenAnalysis"],
  };
}

describe("performance em pontos e por pregão", () => {
  it("converte R para pontos equivalentes usando a distância congelada do stop", () => {
    expect(realizedPoints(trade("t1", "01/07/2026", 1.5, 200))).toBe(300);
    expect(realizedPoints(trade("t2", "01/07/2026", -1, 150))).toBe(-150);
  });

  it("classifica GAIN, LOSS e SEM_OPERACAO por saldo líquido do pregão", () => {
    const trades = [
      trade("t1", "01/07/2026", 2, 100),
      trade("t2", "01/07/2026", -1, 100),
      trade("t3", "02/07/2026", -1, 200),
    ];
    const rows = computeDailyPerformance(trades, ["01/07/2026", "02/07/2026", "03/07/2026"]);
    expect(rows.map((row) => [row.tradingDate, row.status, row.points])).toEqual([
      ["01/07/2026", "GAIN", 100],
      ["02/07/2026", "LOSS", -200],
      ["03/07/2026", "SEM_OPERACAO", 0],
    ]);
  });

  it("calcula pontos ganhos, perdidos, saldo, drawdown e MFE/MAE médios", () => {
    const stats = computePointStats([
      trade("t1", "01/07/2026", 2, 100),
      trade("t2", "02/07/2026", -1, 150),
    ]);
    expect(stats.pointsWon).toBe(200);
    expect(stats.pointsLost).toBe(150);
    expect(stats.netPoints).toBe(50);
    expect(stats.maxDrawdownPoints).toBe(150);
    expect(stats.averageMfePoints).toBe(240);
    expect(stats.averageMaePoints).toBe(125);
  });
});
