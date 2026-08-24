import type { BacktestTrade } from "./backtestEngine";
import { computeStats, computePointStats } from "./performanceEngine";
import { detectDegradedSetups, reviewTrade, setupErrorMatrix } from "./postTradeReview";
import type { TechniqueCandidateRecord } from "../storage";

export interface DailyLearningReport {
  id: string;
  tradingDate: string;
  baseVersion: string;
  createdAt: number;
  daily: {
    trades: number;
    wins: number;
    losses: number;
    r: number;
    points: number;
  };
  rolling: {
    sample: number;
    winRate: number;
    profitFactor: number | null;
    expectancyR: number;
    maxDrawdownR: number;
  };
  lessons: string[];
  degradedSetups: string[];
  candidateId: string | null;
  status: "NO_TRADE" | "LEARNED" | "CANDIDATE_CREATED";
}

function dateToken(date: string): string {
  return date.replace(/\D/g, "") || String(Date.now());
}

function finite(value: number): number | null {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : null;
}

/**
 * Aprendizado diário protegido da T4.
 *
 * Aprende de desfechos REAIS e cria hipótese versionada para shadow. Nunca
 * altera a técnica de produção nem reescreve trades antigos. Promoção continua
 * exigindo backtest -> OOS -> walk-forward -> VALIDATED -> promoção explícita.
 */
export function learnFromDay(input: {
  tradingDate: string;
  baseVersion: string;
  trades: BacktestTrade[];
  now?: number;
}): { report: DailyLearningReport; candidate: TechniqueCandidateRecord | null } {
  const now = input.now ?? Date.now();
  const versionTrades = input.trades
    .filter(
      (trade) => (trade.productionTechniqueVersion ?? trade.strategyVersion) === input.baseVersion,
    )
    .sort((a, b) => a.closedAt - b.closedAt);
  const dailyTrades = versionTrades.filter((trade) => trade.tradingDate === input.tradingDate);
  const rollingTrades = versionTrades.slice(-60);
  const dailyStats = computeStats(dailyTrades);
  const dailyPoints = computePointStats(dailyTrades);
  const rolling = computeStats(rollingTrades);

  const lessons: string[] = [];
  const dailyReviews = dailyTrades.map(reviewTrade);
  const wrongDirection = dailyReviews.filter((review) =>
    review.tags.includes("wrongDirection"),
  ).length;
  const badStop = dailyReviews.filter((review) => review.tags.includes("badStop")).length;
  const badTarget = dailyReviews.filter((review) => review.tags.includes("badTarget")).length;
  const falsePositive = dailyReviews.filter((review) =>
    review.tags.includes("falsePositive"),
  ).length;

  if (wrongDirection > 0)
    lessons.push(
      "Reforçar DIRECTION_SANITY antes da entrada; houve loss que quase não andou a favor.",
    );
  if (badStop > 0)
    lessons.push(
      "Revisar buffer/invalidação estrutural em shadow; houve trade que andou >=1R antes do stop.",
    );
  if (badTarget > 0)
    lessons.push(
      "Revisar captura do runner por MFE; houve ganho com movimento muito além do colhido.",
    );
  if (falsePositive >= 2)
    lessons.push(
      "Bloquear repetição do mesmo setup na mesma fase após falha; exigir nova estrutura independente.",
    );

  const matrix = setupErrorMatrix(rollingTrades);
  const weakRows = matrix.filter((row) => row.total >= 8 && row.avgR <= 0);
  for (const row of weakRows.slice(0, 3)) {
    lessons.push(
      `Manter ${row.setupId} em shadow: média ${row.avgR.toFixed(2)}R em ${row.total} operações.`,
    );
  }

  const degraded = detectDegradedSetups(versionTrades)
    .filter((item) => item.degraded)
    .map((item) => item.setupId);
  for (const setupId of degraded.slice(0, 3))
    lessons.push(`Setup ${setupId} marcado DEGRADED; não ampliar exposição sem nova validação.`);

  if (dailyTrades.length === 0) {
    lessons.push(
      "Pregão observado sem operação: preservar como evidência de cobertura; não fabricar entrada para preencher frequência.",
    );
  }

  const uniqueLessons = [...new Set(lessons)];
  const candidateId =
    uniqueLessons.length > 0 ? `daily_${dateToken(input.tradingDate)}_${input.baseVersion}` : null;
  const candidate: TechniqueCandidateRecord | null = candidateId
    ? {
        id: candidateId,
        version: `${input.baseVersion}-LAB-${dateToken(input.tradingDate)}`,
        baseVersion: input.baseVersion,
        hypothesis: uniqueLessons.join(" "),
        status: "DISCOVERED",
        rules: {
          source: "T4_DAILY_LEARNING",
          tradingDate: input.tradingDate,
          immutableProduction: true,
          lessons: uniqueLessons,
          rolling: {
            sample: rolling.total,
            winRate: Number(rolling.winRate.toFixed(2)),
            profitFactor: finite(rolling.profitFactor),
            expectancyR: Number(rolling.expectancy.toFixed(3)),
            maxDrawdownR: Number(rolling.maxDrawdown.toFixed(3)),
          },
          qualityTargets: {
            minTradeDaysPerMonth: 12,
            minProfitFactor: 3,
            maxDrawdownR: 5,
            minRiskReward: 3,
          },
          requiredPath: ["BACKTESTING", "VALIDATION", "OOS", "WALK_FORWARD", "VALIDATED"],
        },
        createdAt: now,
        updatedAt: now,
      }
    : null;

  const report: DailyLearningReport = {
    id: `learn_${dateToken(input.tradingDate)}_${input.baseVersion}`,
    tradingDate: input.tradingDate,
    baseVersion: input.baseVersion,
    createdAt: now,
    daily: {
      trades: dailyStats.total,
      wins: dailyStats.wins,
      losses: dailyStats.losses,
      r: Number(dailyStats.cumulativeR.toFixed(3)),
      points: dailyPoints.netPoints,
    },
    rolling: {
      sample: rolling.total,
      winRate: Number(rolling.winRate.toFixed(2)),
      profitFactor: finite(rolling.profitFactor),
      expectancyR: Number(rolling.expectancy.toFixed(3)),
      maxDrawdownR: Number(rolling.maxDrawdown.toFixed(3)),
    },
    lessons: uniqueLessons,
    degradedSetups: degraded,
    candidateId,
    status: dailyTrades.length === 0 ? "NO_TRADE" : candidate ? "CANDIDATE_CREATED" : "LEARNED",
  };

  return { report, candidate };
}
