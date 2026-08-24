CREATE TABLE IF NOT EXISTS daily_learning_reports (
  id TEXT PRIMARY KEY,
  trading_date TEXT NOT NULL,
  base_version TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_daily_learning_date ON daily_learning_reports(trading_date, created_at);
