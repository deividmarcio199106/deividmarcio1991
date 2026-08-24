import type { BacktestTrade, TradeOrigin } from "./backtestEngine";

/**
 * Filtro de origem da evidência (comando §28).
 *
 * Registros LEGACY_IMAGE (análise antiga por imagem isolada) ficam no banco
 * SOMENTE como histórico: por padrão NÃO entram na validação nem na decisão —
 * uma imagem isolada não carrega a sequência temporal que a técnica atual exige.
 * Inclusão só com opt-in explícito do usuário.
 */

/** Shape estrutural mínimo — compatível com BacktestRecord do storage. */
export interface EvidenceRecordLike {
  origin?: TradeOrigin;
  trades: BacktestTrade[];
}

export interface EvidenceFilterOptions {
  includeLegacyImage?: boolean;
}

export function filterEvidenceTrades(
  records: EvidenceRecordLike[],
  options: EvidenceFilterOptions = {},
): BacktestTrade[] {
  const includeLegacy = options.includeLegacyImage === true;
  return records
    .filter((record) => includeLegacy || (record.origin ?? "LEGACY_IMAGE") !== "LEGACY_IMAGE")
    .flatMap((record) => record.trades);
}
