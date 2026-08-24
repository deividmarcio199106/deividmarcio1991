-- Referência da migration 9. O runtime aplica a mesma estrutura de forma
-- idempotente em src/server/tradingRepository.ts (migrate()).
--
-- VALIDAÇÕES OPENAI POR CAPTURA. Luna lê cada print; Terra desafia quando há
-- possível entrada; o combinador determinístico decide. Cada validação vira UMA
-- linha e a linha nunca é reescrita: (image_hash, candle_time) é única e o
-- INSERT usa OR IGNORE — reprocessar um replay é idempotente por construção.
--
-- POR QUE NUNCA SOBRESCREVER: esta trilha é o insumo da auditoria offline
-- (Sol). Uma linha regravada seria a IA "mudando de ideia" retroativamente —
-- exatamente o tipo de contaminação que a auditoria existe para pegar.
CREATE TABLE IF NOT EXISTS ai_validations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_hash TEXT NOT NULL,
  capture_id TEXT NOT NULL,
  candle_time INTEGER NOT NULL,
  t4_decision_json TEXT NOT NULL,     -- decisão determinística no instante
  luna_json TEXT,                     -- NULL = sem resposta VÁLIDA da Luna
  terra_json TEXT,                    -- NULL = não chamado ou inválido
  latency_ms INTEGER NOT NULL,
  tokens INTEGER NOT NULL,
  cost_usd REAL,                      -- NULL quando a tabela de preço não é conhecida
  status TEXT NOT NULL,               -- CONFIRMADO | AGUARDAR | AI_INDISPONIVEL
  created_at INTEGER NOT NULL,
  UNIQUE(image_hash, candle_time)
);
CREATE INDEX IF NOT EXISTS idx_ai_validations_candle ON ai_validations(candle_time);
