-- Referência da migration 8. O runtime aplica a mesma estrutura de forma
-- idempotente em src/server/tradingRepository.ts (migrate()).
--
-- AUTORIZAÇÃO DE PRODUÇÃO POR ATIVO. Antes, a liberação de um ativo vivia num
-- Map em memória (src/lib/t4/assets.ts): reiniciar o servidor devolvia o WIN ao
-- estado semeado e a autorização conquistada sumia sem registro. O comando é o
-- oposto — a autorização precisa sobreviver ao reinício E ser auditável.
--
-- O QUE IMPEDE ISSO DE VIRAR PERMISSÃO ETERNA, que era a razão boa para não
-- persistir: a linha só vale junto com `technique_version`. Quem decide é
-- validatedForProduction(), que compara a versão gravada com a de produção — ao
-- subir a técnica, toda linha antiga para de valer sozinha, sem ninguém
-- precisar lembrar de revogar.
--
-- APPEND-ONLY. Cada concessão e cada revogação é uma LINHA NOVA; o evento
-- anterior recebe `revoked_at` e permanece. Revogar por DELETE apagaria a prova
-- de que a permissão existiu e de quando deixou de existir — exatamente o que
-- uma trilha de auditoria serve para responder. Vigente = revoked_at IS NULL.
CREATE TABLE IF NOT EXISTS asset_authorizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,   -- evento, não ativo: a trilha cresce
  symbol TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK(status IN ('VALIDATED_FOR_PRODUCTION','IN_VALIDATION','LAB_ONLY')),
  technique_version TEXT,                 -- versão da técnica sob a qual valeu
  evidence_ref TEXT,                      -- id do relatório/execução que sustenta
  granted_at INTEGER NOT NULL,
  granted_by TEXT NOT NULL,               -- quem (ou o quê) concedeu
  revoked_at INTEGER,                     -- NULL = é o evento vigente
  -- ÚLTIMA LINHA DE DEFESA. A regra também é aplicada em assets.ts, mas o banco
  -- é o que sobra quando alguém grava por outro caminho: liberar produção sem
  -- versão ou sem evidência é recusado aqui dentro.
  CHECK(
    status <> 'VALIDATED_FOR_PRODUCTION'
    OR (technique_version IS NOT NULL AND evidence_ref IS NOT NULL)
  )
);

-- ÍNDICE DEPOIS DAS COLUNAS, SEMPRE (mesma lição da migration 007).
CREATE INDEX IF NOT EXISTS idx_asset_auth_symbol ON asset_authorizations(symbol, granted_at);
CREATE INDEX IF NOT EXISTS idx_asset_auth_active ON asset_authorizations(revoked_at, symbol);
