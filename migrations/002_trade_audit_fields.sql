-- Migration incremental: campos consultáveis de auditoria do desfecho real.
ALTER TABLE trades ADD COLUMN entry REAL;
ALTER TABLE trades ADD COLUMN stop REAL;
ALTER TABLE trades ADD COLUMN partial REAL;
ALTER TABLE trades ADD COLUMN target REAL;
ALTER TABLE trades ADD COLUMN entry_hit_at INTEGER;
ALTER TABLE trades ADD COLUMN partial_hit_at INTEGER;
ALTER TABLE trades ADD COLUMN exit_at INTEGER;
ALTER TABLE trades ADD COLUMN exit_reason TEXT;
ALTER TABLE trades ADD COLUMN mfe REAL;
ALTER TABLE trades ADD COLUMN mae REAL;
ALTER TABLE trades ADD COLUMN ambiguous_intrabar INTEGER NOT NULL DEFAULT 0;
