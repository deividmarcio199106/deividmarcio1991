-- Referência da migration 6. O runtime aplica a mesma estrutura de forma
-- idempotente em src/server/tradingRepository.ts (migrate()).
--
-- MEMÓRIA T4: todo print analisado vira caso persistente; a imagem vai para
-- DATA_DIR/prints/{id}.jpg (nunca base64 em banco/código). Previsões com
-- critério PRÉ-definido (direção + stop + alvo legíveis no instante) fecham
-- veredito sozinhas pelas observações de preço dos prints seguintes
-- (etiqueta currentPrice, amostrada a cada 60s). Regra conservadora: alvo E
-- stop cruzados entre duas observações = stop primeiro, marcado ambiguous.
CREATE TABLE IF NOT EXISTS prints (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  asset TEXT NOT NULL,
  timeframe TEXT,
  captured_at INTEGER NOT NULL,
  image_path TEXT,
  status TEXT NOT NULL,
  direction TEXT NOT NULL,
  confidence INTEGER NOT NULL,
  current_price REAL,
  dna_id TEXT,
  capture_code TEXT,               -- CICLO_60S | MANUAL | COLADO
  analysis_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prints_asset_time ON prints(asset, captured_at);

CREATE TABLE IF NOT EXISTS print_predictions (
  print_id TEXT PRIMARY KEY,
  asset TEXT NOT NULL,
  direction TEXT NOT NULL,
  predicted_at INTEGER NOT NULL,
  entry REAL,
  stop REAL,
  target REAL,
  price_at_prediction REAL,
  verdict TEXT NOT NULL DEFAULT 'PENDENTE',   -- ACERTOU | ERROU | NEUTRO | INVALIDADO
  ambiguous INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  resolved_at INTEGER,
  dna_id TEXT,
  FOREIGN KEY(print_id) REFERENCES prints(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_predictions_pending ON print_predictions(asset, verdict);
