/**
 * FONTE ÚNICA DAS VERSÕES DA T4.
 *
 * Antes existia só `STRATEGY_VERSION`, e ela respondia a três perguntas
 * diferentes ao mesmo tempo: qual técnica está em produção, qual motor a
 * executou e com qual gestão. Quando qualquer uma das três muda, um resultado
 * gravado com a combinação antiga deixa de ser comparável — e sem separá-las não
 * há como saber QUAL delas mudou.
 *
 * É isso que torna Replay = Ao Vivo verificável: as duas execuções só podem ser
 * comparadas quando as três versões batem. Diferindo, o relatório diz que é
 * COMPARAÇÃO, não reprodução.
 *
 * Nenhuma tela pode declarar versão própria. Quem precisar carimbar uma decisão
 * usa `t4Versions()`.
 */

import { STRATEGY_VERSION } from "@/lib/engines/strategy";

/** Técnica em produção. Muda quando a REGRA de leitura muda. */
export const T4_PRODUCTION_VERSION = STRATEGY_VERSION;

/**
 * Motor que executa a técnica. Muda quando a IMPLEMENTAÇÃO muda de resultado —
 * correção de gate, mudança de pipeline, ajuste de detector.
 *
 * Subiu para 1.1.0 quando a escala calibrada passou a chegar aos candles: até
 * então o motor lia coordenada de pixel como se fosse preço, e nenhum resultado
 * anterior a isso é comparável com os de agora.
 */
export const T4_ENGINE_VERSION = "engine-1.1.0";

/** Gestão da operação. Muda quando o número de contratos ou os alvos mudam. */
export const T4_MANAGEMENT_VERSION = "mgmt-3C-3R5R-runner-1.0.0";

export interface T4Versions {
  production: string;
  engine: string;
  management: string;
}

/** Carimbo completo. Vai em toda decisão, evento e trade gravado. */
export function t4Versions(): T4Versions {
  return {
    production: T4_PRODUCTION_VERSION,
    engine: T4_ENGINE_VERSION,
    management: T4_MANAGEMENT_VERSION,
  };
}

/** Duas execuções só são reprodução uma da outra se as três versões batem. */
export function sameVersions(a: T4Versions, b: T4Versions): boolean {
  return a.production === b.production && a.engine === b.engine && a.management === b.management;
}

/** Rótulo curto para a interface: `NEXUS T4 · T4.0.0`. */
export const T4_UI_LABEL = `NEXUS T4 · ${T4_PRODUCTION_VERSION}` as const;
