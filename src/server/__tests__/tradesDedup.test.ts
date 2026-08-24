import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { BacktestRecord } from "@/lib/storage";
import { resetTradingRepositoryForTests, upsertBacktest } from "../tradingRepository";

/**
 * "REPLAY REPETIDO NÃO AUMENTA N" (auditoria sênior, BLOCO 4).
 *
 * O defeito: cada reexecução do mesmo material criava ids de sessão novos e o
 * MESMO evento de mercado virava mais uma linha de `trades` — a amostra
 * "crescia" sem trade novo existir, e era essa amostra que alimentava a
 * estatística de homologação. O que se tranca aqui:
 *
 *   1. o mesmo record upsertado duas vezes ⇒ N idêntico;
 *   2. os MESMOS trades sob um backtest_id NOVO (rerun com container novo)
 *      ⇒ N idêntico — o conflito de id RECLAMA a linha, nunca duplica e
 *      nunca faz ROLLBACK do upsert inteiro (o defeito antigo);
 *   3. o MESMO EVENTO com id de trade DIFERENTE (linha legada de id de
 *      relógio) ⇒ N idêntico — o índice único de evento recusa a cópia;
 *   4. a migração deduplica um banco já contaminado mantendo a linha original.
 */

let workingDir: string | null = null;

function freshDatabase(): string {
  resetTradingRepositoryForTests();
  const dir = mkdtempSync(join(tmpdir(), "analisador-dedup-"));
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

/** Conta as linhas REAIS da tabela — é nela que a estatística de DNA lê. */
function contarTrades(dir: string): number {
  resetTradingRepositoryForTests();
  const database = new DatabaseSync(join(dir, "analisador.sqlite"));
  try {
    const row = database.prepare("SELECT COUNT(*) AS n FROM trades").get() as { n: number };
    return row.n;
  } finally {
    database.close();
  }
}

const T0 = 1_772_000_000_000;

function trade(id: string, openedAt: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    setupId: "T4|TREND_FIRST_PULLBACK|TREND_UP",
    strategyVersion: "T4.0.0",
    asset: "WINFUT",
    timeframe: "1m",
    openedAt,
    closedAt: openedAt + 300_000,
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
    sourceCaptureId: "tela_compartilhada_obs_WINFUT",
    // Sem sessão de pregão criada neste harness — a FK aceita null.
    tradingSessionId: null,
    tradingDate: "02/03/2026",
    origin: "VIDEO_REPLAY",
    frozenAnalysis: {},
    ...overrides,
  };
}

function record(id: string, trades: unknown[]): BacktestRecord {
  return {
    id,
    strategyVersion: "T4.0.0",
    asset: "WINFUT",
    timeframe: "1m",
    createdAt: T0,
    sourceCaptureId: "tela_compartilhada_obs_WINFUT",
    origin: "VIDEO_REPLAY",
    trades,
  } as unknown as BacktestRecord;
}

describe.sequential("dedup de trades — replay repetido não aumenta N", () => {
  it("o mesmo record upsertado duas vezes mantém N", () => {
    const dir = freshDatabase();
    const r = record("obs_obs_WINFUT_02/03/2026", [
      trade("trade_1_a", T0),
      trade("trade_1_b", T0 + 600_000),
    ]);
    upsertBacktest(r);
    upsertBacktest(r);
    expect(contarTrades(dir)).toBe(2);
  });

  it("os MESMOS trades sob backtest_id NOVO não duplicam nem derrubam o upsert", () => {
    const dir = freshDatabase();
    const trades = [trade("trade_2_a", T0), trade("trade_2_b", T0 + 600_000)];
    upsertBacktest(record("corrida_antiga", trades));
    // O defeito antigo: isto estourava a PK de id e o ROLLBACK descartava tudo.
    expect(() => upsertBacktest(record("corrida_nova", trades))).not.toThrow();
    expect(contarTrades(dir)).toBe(2);
  });

  it("o MESMO EVENTO com id de trade diferente é recusado pelo índice único", () => {
    const dir = freshDatabase();
    upsertBacktest(record("corrida_a", [trade("trade_relogio_111", T0)]));
    // Linha legada: outro id (relógio), mesmo evento (data+abertura+direção+setup).
    upsertBacktest(record("corrida_b", [trade("trade_relogio_222", T0)]));
    expect(contarTrades(dir)).toBe(1);
  });

  it("eventos DIFERENTES continuam entrando — o índice não recusa trade novo", () => {
    const dir = freshDatabase();
    upsertBacktest(record("corrida_a", [trade("t_a", T0)]));
    upsertBacktest(
      record("corrida_b", [
        trade("t_b", T0 + 60_000),
        trade("t_c", T0, { direction: "VENDA", stop: 169_700, target1: 168_900, exit: 168_900 }),
      ]),
    );
    expect(contarTrades(dir)).toBe(3);
  });

  it("a migração deduplica banco já contaminado mantendo a linha original", () => {
    const dir = freshDatabase();
    // Contamina DIRETO na tabela, contornando o índice: simula o banco antigo.
    upsertBacktest(record("corrida_a", [trade("dup_original", T0)]));
    resetTradingRepositoryForTests();
    const database = new DatabaseSync(join(dir, "analisador.sqlite"));
    database.exec("DROP INDEX idx_trades_evento_unico");
    database.exec(`
      INSERT INTO trades(id, backtest_id, origin, symbol, trading_date, timeframe,
        direction, setup, strategy_version, opened_at, closed_at, result_r,
        ambiguous_intrabar, payload_json, created_at)
      SELECT 'dup_copia', backtest_id, origin, symbol, trading_date, timeframe,
        direction, setup, strategy_version, opened_at, closed_at, result_r,
        ambiguous_intrabar, payload_json, created_at + 1
      FROM trades WHERE id='dup_original'
    `);
    database.close();
    // Reabrir o repositório roda migrate() → dedup + índice de volta.
    upsertBacktest(record("corrida_b", []));
    resetTradingRepositoryForTests();
    const verificacao = new DatabaseSync(join(dir, "analisador.sqlite"));
    const restantes = verificacao.prepare("SELECT id FROM trades ORDER BY id").all() as Array<{
      id: string;
    }>;
    verificacao.close();
    expect(restantes.map((row) => row.id)).toEqual(["dup_original"]);
  });
});
