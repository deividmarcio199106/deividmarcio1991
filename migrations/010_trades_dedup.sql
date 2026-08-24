-- Referência da migration 10. O runtime aplica a mesma estrutura de forma
-- idempotente em src/server/tradingRepository.ts (migrateTradesDedup()).
--
-- O MESMO EVENTO DE MERCADO NÃO VIRA DUAS LINHAS DE trades (auditoria sênior,
-- BLOCO 4). Cada replay do mesmo material criava ids de sessão novos (relógio
-- da máquina) e os MESMOS trades entravam de novo sob outro backtest_id — N
-- crescia a cada reexecução sem nenhum trade novo existir.
--
-- A identidade real de um trade é o evento: (trading_date, opened_at,
-- direction, setup). Ordem obrigatória: dedup primeiro (mantém a linha MAIS
-- ANTIGA — o registro original; as removidas são cópias de replay), índice
-- único depois. `trading_date IS NOT NULL` nos dois passos porque SQLite trata
-- NULL como distinto em UNIQUE: linha sem data não é dedupável pelo índice, e
-- dedupá-la aqui criaria regra que o banco não sustenta.

DELETE FROM trades WHERE trading_date IS NOT NULL AND rowid NOT IN (
  SELECT MIN(rowid) FROM trades WHERE trading_date IS NOT NULL
  GROUP BY trading_date, opened_at, direction, setup
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_evento_unico
  ON trades(trading_date, opened_at, direction, setup);
