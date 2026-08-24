-- Referência da migration 5. O runtime aplica a mesma estrutura de forma
-- idempotente em src/server/tradingRepository.ts (migrate()).
--
-- setup_dna: TODA T4 detectada vira registro mensurável, COM ou SEM operação.
-- Setups DESCARTADOS e análises de print também entram — a estatística de
-- "quantas A+ apareceram" não pode contar só as que executaram. O registro é
-- IMUTÁVEL após a criação (classificação antes do desfecho, nunca reescrita);
-- o único campo atualizável é trade_id, quando a detecção vira operação.
CREATE TABLE IF NOT EXISTS setup_dna (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,              -- 'LIVE' | 'REPLAY' | 'PRINT'
  source_id TEXT NOT NULL,           -- sessão/print que originou a detecção
  print_id TEXT,
  trade_id TEXT,                     -- preenchido quando vira operação
  asset TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  direction TEXT NOT NULL,           -- 'COMPRA' | 'VENDA'
  detected_at INTEGER NOT NULL,      -- instante de MERCADO da decisão
  trading_date TEXT,
  hour INTEGER,
  technique_version TEXT NOT NULL,
  grade TEXT NOT NULL,               -- 'A_PLUS' | 'A' | 'B' | 'C' | 'DESCARTADA'
  trend TEXT NOT NULL,               -- 'FORTE' | 'NORMAL' | 'LATERAL' | 'TRANSICAO' | 'CONTRA'
  position TEXT NOT NULL,            -- 'A_FAVOR' | 'CONTRA_TENDENCIA'
  pullback TEXT NOT NULL,            -- ver src/lib/t4/dna.ts
  pullback_depth REAL,               -- fração 0-1 do impulso devolvida
  pullback_bars INTEGER,
  impulse_points REAL,
  impulse_r REAL,                    -- impulso ÷ distância do stop
  location TEXT NOT NULL,
  location_detail TEXT,              -- POIKind cru
  trigger_candle TEXT NOT NULL,
  movement_ordinal INTEGER,          -- 1|2|3|4 (4 = posterior); NULL = não computável
  volatility TEXT,                   -- 'BAIXA' | 'NORMAL' | 'ALTA' | 'EXTREMA'; NULL = sem leitura
  volatility_ratio REAL,
  stop_distance_points REAL,
  rr_available REAL,
  entry REAL,
  stop REAL,
  targets_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_setup_dna_date ON setup_dna(trading_date, detected_at);
CREATE INDEX IF NOT EXISTS idx_setup_dna_grade ON setup_dna(grade, direction);
CREATE INDEX IF NOT EXISTS idx_setup_dna_trade ON setup_dna(trade_id);

-- lab_experiments: quantas variações/hipóteses foram testadas sobre cada
-- versão-base. É o denominador da proteção contra overfitting (§8): a
-- exigência de validação fora da amostra CRESCE com o número de tentativas.
CREATE TABLE IF NOT EXISTS lab_experiments (
  id TEXT PRIMARY KEY,
  base_version TEXT NOT NULL,
  candidate_id TEXT,
  hypothesis TEXT NOT NULL,
  variation_json TEXT NOT NULL,      -- regra adicionada/removida + motivo
  dataset_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(candidate_id) REFERENCES technique_candidates(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_lab_experiments_base ON lab_experiments(base_version, created_at);

-- datasets: recortes DECLARADOS de treino/validação/fora-da-amostra.
-- frozen=1 torna o recorte imutável: dataset usado numa validação não muda.
CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('TREINO','VALIDACAO','OOS')),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  trade_count INTEGER NOT NULL DEFAULT 0,
  frozen INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
