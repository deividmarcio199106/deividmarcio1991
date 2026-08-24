-- Referência da migration 7. O runtime aplica a mesma estrutura de forma
-- idempotente em src/server/tradingRepository.ts (migrate()).
--
-- SETUPS PERSISTENTES (§21): a máquina de setup vive no NAVEGADOR
-- (src/lib/print/setupTracker.ts). Reiniciar o backend perdia o setup ativo, e
-- um setup CONFIRMADO nunca fechava sozinho. Esta tabela é a cópia servidora do
-- ciclo FORMACAO → CONFIRMADO → WIN | LOSS | EXPIRADO | INVALIDADO, fechada
-- automaticamente por sweepSetupOutcomes() contra as etiquetas de preço já
-- gravadas em prints.current_price (amostras de 60s).
--
-- REGRA CONSERVADORA (a mesma das previsões de print): alvo E stop
-- atravessados entre duas observações = stop primeiro, marcado ambiguous.
CREATE TABLE IF NOT EXISTS setups (
  setup_id TEXT PRIMARY KEY,        -- T4-AAAA-MM-DD-XXX, gerado pelo tracker
  asset TEXT NOT NULL,
  timeframe TEXT,
  direction TEXT NOT NULL,          -- COMPRA | VENDA
  stage TEXT NOT NULL,              -- estágio da máquina no último print
  entry REAL,
  stop REAL,
  target REAL,
  entry_zone_min REAL,
  entry_zone_max REAL,
  confirmed_at INTEGER,             -- NULL enquanto não confirmado
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  outcome TEXT NOT NULL DEFAULT 'ABERTO'
    CHECK(outcome IN ('ABERTO','WIN','LOSS','EXPIRADO','INVALIDADO')),
  outcome_at INTEGER,
  outcome_reason TEXT,
  ambiguous INTEGER NOT NULL DEFAULT 0,
  dna_id TEXT,
  print_id TEXT,
  -- TRAVA DE APRENDIZADO: a memória recebe o resultado de cada setup UMA vez.
  -- learnFromClosedSetups() só olha learned=0 e marca learned=1 na MESMA
  -- transação; listMemoryCases() só enxerga setups com learned=1.
  learned INTEGER NOT NULL DEFAULT 0
);

-- ÍNDICES DEPOIS DAS COLUNAS, SEMPRE. CREATE INDEX sobre coluna que ainda não
-- existe LANÇA e derruba a migração inteira num banco antigo — foi assim que
-- os índices do DNA quase levaram todos os endpoints /api/trading/* embora.
CREATE INDEX IF NOT EXISTS idx_setups_asset_outcome ON setups(asset, outcome);
CREATE INDEX IF NOT EXISTS idx_setups_learn ON setups(outcome, learned);

-- METADADO DOS 2 PASSES DO AUTO-CROP (§13) no print que já existe: motivo do
-- segundo passe, escolha e score de cada leitura. É SÓ metadado — não duplica
-- aprendizado nem cria segundo registro de print.
ALTER TABLE prints ADD COLUMN passes_json TEXT;
