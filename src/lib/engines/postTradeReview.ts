import type { BacktestTrade } from "./backtestEngine";

/**
 * Folga em R além do alvo colhido a partir da qual a revisão marca "alvo
 * curto". NÃO é gate de operação — é heurística de pós-trade. Nomeada para
 * nunca ser confundida com um mínimo de R:R (o mínimo da casa mora em
 * strategy.MIN_RISK_REWARD e vale 3).
 */
const TARGET_SHORT_EXCESS_R = 1.5;

/**
 * AUTOAVALIAÇÃO PÓS-OPERAÇÃO (spec finalíssimo §44–§46, §50–§51).
 *
 * Compara o que o sistema esperava com o que ocorreu, usando SOMENTE dados
 * reais gravados no trade (resultado, R, MFE/MAE). Sem MFE/MAE gravados, a
 * classificação fina fica UNKNOWN — nunca inventada.
 */

export type OutcomeTag =
  "falsePositive" | "wrongDirection" | "badStop" | "badTarget" | "goodCall" | "unknownDetail";

export interface TradeReview {
  tradeId: string;
  setupId: string;
  tags: OutcomeTag[];
  notes: string[];
}

export function reviewTrade(trade: BacktestTrade): TradeReview {
  const tags: OutcomeTag[] = [];
  const notes: string[] = [];
  const win = trade.rMultiple > 0;
  const hasExcursions = trade.mfeR !== null && trade.maeR !== null;

  if (win) {
    tags.push("goodCall");
    // Alvo curto: o mercado foi MUITO além do que o plano colheu.
    if (trade.mfeR !== null && trade.mfeR >= trade.riskReward + TARGET_SHORT_EXCESS_R) {
      tags.push("badTarget");
      notes.push(
        `MFE ${trade.mfeR.toFixed(1)}R muito além do colhido (${trade.rMultiple.toFixed(1)}R) — alvo possivelmente curto.`,
      );
    }
  } else {
    // Trade registrado que perdeu = falso positivo da configuração candidata.
    tags.push("falsePositive");
    if (!hasExcursions) {
      tags.push("unknownDetail");
      notes.push("Sem MFE/MAE gravados — impossível separar direção errada de stop/alvo ruins.");
    } else {
      if (trade.mfeR! < 0.3) {
        // Nunca andou a favor: direção errada.
        tags.push("wrongDirection");
        notes.push(`MFE ${trade.mfeR!.toFixed(1)}R — o preço praticamente não andou a favor.`);
      } else if (trade.mfeR! >= 1) {
        // Andou 1R+ a favor e ainda perdeu: gestão/stop.
        tags.push("badStop");
        notes.push(
          `MFE ${trade.mfeR!.toFixed(1)}R antes do stop — entrada certa, gestão/stop ruins.`,
        );
      }
    }
  }
  return { tradeId: trade.id, setupId: trade.setupId, tags, notes };
}

export interface SetupErrorRow {
  setupId: string;
  total: number;
  wins: number;
  winRate: number;
  falsePositives: number;
  wrongDirection: number;
  badStop: number;
  badTarget: number;
  avgR: number;
}

/** §45 — matriz de erros por setup (Spring, UTAD, SOS, SOW, Sweep, Retest…). */
export function setupErrorMatrix(trades: BacktestTrade[]): SetupErrorRow[] {
  const map = new Map<string, BacktestTrade[]>();
  for (const trade of trades) {
    if (!map.has(trade.setupId)) map.set(trade.setupId, []);
    map.get(trade.setupId)!.push(trade);
  }
  return [...map.entries()]
    .map(([setupId, list]) => {
      const reviews = list.map(reviewTrade);
      const count = (tag: OutcomeTag) =>
        reviews.filter((review) => review.tags.includes(tag)).length;
      const wins = list.filter((trade) => trade.rMultiple > 0).length;
      return {
        setupId,
        total: list.length,
        wins,
        winRate: (wins / list.length) * 100,
        falsePositives: count("falsePositive"),
        wrongDirection: count("wrongDirection"),
        badStop: count("badStop"),
        badTarget: count("badTarget"),
        avgR: list.reduce((sum, trade) => sum + trade.rMultiple, 0) / list.length,
      };
    })
    .sort((a, b) => b.total - a.total);
}

export interface DegradationRead {
  setupId: string;
  degraded: boolean;
  historicalWinRate: number;
  recentWinRate: number;
  recentSample: number;
  reason: string;
}

/** Amostra mínima recente antes de qualquer marcação (§46: nunca com amostra pequena). */
export const DEGRADATION_MIN_RECENT = 15;
export const DEGRADATION_DROP_PP = 20; // queda em pontos percentuais

/**
 * §46 — marca DEGRADED quando a performance recente cai muito abaixo da
 * histórica COM amostra suficiente. Nunca desativa nada automaticamente:
 * apenas sinaliza.
 */
export function detectDegradedSetups(
  trades: BacktestTrade[],
  recentCount = DEGRADATION_MIN_RECENT,
): DegradationRead[] {
  const bySetup = new Map<string, BacktestTrade[]>();
  for (const trade of trades) {
    if (!bySetup.has(trade.setupId)) bySetup.set(trade.setupId, []);
    bySetup.get(trade.setupId)!.push(trade);
  }
  const out: DegradationRead[] = [];
  for (const [setupId, list] of bySetup) {
    const ordered = [...list].sort((a, b) => a.closedAt - b.closedAt);
    const recent = ordered.slice(-recentCount);
    const historical = ordered.slice(0, -recentCount);
    if (recent.length < recentCount || historical.length < recentCount) {
      out.push({
        setupId,
        degraded: false,
        historicalWinRate: 0,
        recentWinRate: 0,
        recentSample: recent.length,
        reason: `Amostra insuficiente para avaliar degradação (${recent.length}/${recentCount} recentes).`,
      });
      continue;
    }
    const rate = (subset: BacktestTrade[]) =>
      (subset.filter((trade) => trade.rMultiple > 0).length / subset.length) * 100;
    const historicalWinRate = rate(historical);
    const recentWinRate = rate(recent);
    const degraded = historicalWinRate - recentWinRate >= DEGRADATION_DROP_PP;
    out.push({
      setupId,
      degraded,
      historicalWinRate,
      recentWinRate,
      recentSample: recent.length,
      reason: degraded
        ? `DEGRADED: acerto caiu de ${historicalWinRate.toFixed(0)}% para ${recentWinRate.toFixed(0)}% nas últimas ${recent.length} operações.`
        : "Performance recente compatível com a histórica.",
    });
  }
  return out;
}

/** §50–§51 — agrupamento genérico por chave real do trade (ativo, regime, hora…). */
export function statsByKey(
  trades: BacktestTrade[],
  key: (trade: BacktestTrade) => string,
): { key: string; total: number; winRate: number; avgR: number }[] {
  const map = new Map<string, BacktestTrade[]>();
  for (const trade of trades) {
    const k = key(trade);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(trade);
  }
  return [...map.entries()]
    .map(([k, list]) => ({
      key: k,
      total: list.length,
      winRate: (list.filter((trade) => trade.rMultiple > 0).length / list.length) * 100,
      avgR: list.reduce((sum, trade) => sum + trade.rMultiple, 0) / list.length,
    }))
    .sort((a, b) => b.total - a.total);
}
