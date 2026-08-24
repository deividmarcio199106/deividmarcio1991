import type { BacktestTrade } from "./backtestEngine";

export interface PerformanceStats {
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  payoff: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdown: number;
  maxWinStreak: number;
  maxLossStreak: number;
  cumulativeR: number;
  equity: { i: number; r: number }[];
}

export function computeStats(trades: BacktestTrade[]): PerformanceStats {
  const wins = trades.filter((t) => t.rMultiple > 0);
  const losses = trades.filter((t) => t.rMultiple <= 0);
  const grossWin = wins.reduce((a, t) => a + t.rMultiple, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.rMultiple, 0));

  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;

  let peak = 0;
  let equity = 0;
  let maxDrawdown = 0;
  const curve: { i: number; r: number }[] = [];
  let winStreak = 0;
  let lossStreak = 0;
  let maxWinStreak = 0;
  let maxLossStreak = 0;

  trades.forEach((t, i) => {
    equity += t.rMultiple;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    curve.push({ i: i + 1, r: Number(equity.toFixed(3)) });
    if (t.rMultiple > 0) {
      winStreak++;
      lossStreak = 0;
      maxWinStreak = Math.max(maxWinStreak, winStreak);
    } else {
      lossStreak++;
      winStreak = 0;
      maxLossStreak = Math.max(maxLossStreak, lossStreak);
    }
  });

  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;

  return {
    total: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    payoff: avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    expectancy: trades.length ? equity / trades.length : 0,
    maxDrawdown,
    maxWinStreak,
    maxLossStreak,
    cumulativeR: equity,
    equity: curve,
  };
}

export function groupBy<T extends string | number>(
  trades: BacktestTrade[],
  key: (t: BacktestTrade) => T,
): { key: T; total: number; winRate: number; r: number }[] {
  const map = new Map<T, BacktestTrade[]>();
  for (const t of trades) {
    const k = key(t);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(t);
  }
  return [...map.entries()]
    .map(([k, list]) => ({
      key: k,
      total: list.length,
      winRate: (list.filter((t) => t.rMultiple > 0).length / list.length) * 100,
      r: list.reduce((a, t) => a + t.rMultiple, 0),
    }))
    .sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

export type DailyResultStatus = "GAIN" | "LOSS" | "EMPATE" | "SEM_OPERACAO";

export interface DailyPerformanceRow {
  tradingDate: string;
  status: DailyResultStatus;
  trades: number;
  gains: number;
  losses: number;
  points: number;
  r: number;
}

/**
 * Pontos realizados equivalentes da operação, incluindo a parcial.
 * O LiveOutcomeTracker já calcula rMultiple ponderando a fração parcial;
 * multiplicar R pela distância inicial do stop devolve o resultado em pontos
 * equivalentes sem fingir que toda a posição saiu no preço final.
 */
export function realizedPoints(trade: BacktestTrade): number {
  const riskPoints = Math.abs(trade.entry - trade.stop);
  if (!Number.isFinite(riskPoints) || riskPoints <= 0 || !Number.isFinite(trade.rMultiple))
    return 0;
  return Number((trade.rMultiple * riskPoints).toFixed(2));
}

export interface PointPerformanceStats {
  pointsWon: number;
  pointsLost: number;
  netPoints: number;
  profitFactorPoints: number;
  maxDrawdownPoints: number;
  averageMfePoints: number | null;
  averageMaePoints: number | null;
}

export function computePointStats(trades: BacktestTrade[]): PointPerformanceStats {
  let pointsWon = 0;
  let pointsLost = 0;
  let equity = 0;
  let peak = 0;
  let maxDrawdownPoints = 0;
  const mfe: number[] = [];
  const mae: number[] = [];

  for (const trade of [...trades].sort((a, b) => a.openedAt - b.openedAt)) {
    const points = realizedPoints(trade);
    if (points > 0) pointsWon += points;
    if (points < 0) pointsLost += Math.abs(points);
    equity += points;
    peak = Math.max(peak, equity);
    maxDrawdownPoints = Math.max(maxDrawdownPoints, peak - equity);
    if (trade.mfePoints !== null && Number.isFinite(trade.mfePoints)) mfe.push(trade.mfePoints);
    if (trade.maePoints !== null && Number.isFinite(trade.maePoints)) mae.push(trade.maePoints);
  }

  const average = (values: number[]) =>
    values.length
      ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2))
      : null;

  return {
    pointsWon: Number(pointsWon.toFixed(2)),
    pointsLost: Number(pointsLost.toFixed(2)),
    netPoints: Number((pointsWon - pointsLost).toFixed(2)),
    profitFactorPoints: pointsLost > 0 ? pointsWon / pointsLost : pointsWon > 0 ? Infinity : 0,
    maxDrawdownPoints: Number(maxDrawdownPoints.toFixed(2)),
    averageMfePoints: average(mfe),
    averageMaePoints: average(mae),
  };
}

/**
 * Fecha cada pregão pelo resultado líquido das operações daquele dia. Datas
 * observadas sem trade continuam aparecendo como SEM_OPERACAO.
 */
export function computeDailyPerformance(
  trades: BacktestTrade[],
  analyzedDates: readonly string[] = [],
): DailyPerformanceRow[] {
  const dates = new Set(analyzedDates.filter(Boolean));
  for (const trade of trades) if (trade.tradingDate) dates.add(trade.tradingDate);

  const dateKey = (value: string) => {
    const [day, month, year] = value.split("/").map(Number);
    return Number.isFinite(day) && Number.isFinite(month) && Number.isFinite(year)
      ? year * 10_000 + month * 100 + day
      : Number.MAX_SAFE_INTEGER;
  };

  return [...dates]
    .sort((a, b) => dateKey(a) - dateKey(b) || a.localeCompare(b))
    .map((tradingDate) => {
      const list = trades.filter((trade) => trade.tradingDate === tradingDate);
      const points = list.reduce((sum, trade) => sum + realizedPoints(trade), 0);
      const r = list.reduce((sum, trade) => sum + trade.rMultiple, 0);
      const status: DailyResultStatus =
        list.length === 0 ? "SEM_OPERACAO" : points > 0 ? "GAIN" : points < 0 ? "LOSS" : "EMPATE";
      return {
        tradingDate,
        status,
        trades: list.length,
        gains: list.filter((trade) => trade.rMultiple > 0).length,
        losses: list.filter((trade) => trade.rMultiple < 0).length,
        points: Number(points.toFixed(2)),
        r: Number(r.toFixed(3)),
      };
    });
}
