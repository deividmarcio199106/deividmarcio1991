/**
 * UM ÚNICO `ReadingState` PARA REPLAY, BACKTEST E AO VIVO.
 *
 * O DEFEITO: cada caminho construía o seu, com regras diferentes para o MESMO
 * conceito. O ao vivo exigia `MIN_CANDLES_FOR_ANALYSIS` = 24; o backtest exigia
 * `READING_GATES.minClosedCandles` = 14. `analyze()` trata `reading.sufficient`
 * como portão, então a MESMA série de 18 candles produzia leitura suficiente num
 * caminho e insuficiente no outro.
 *
 * Isso sozinho impede "mesmo input + mesma versão = mesmo resultado". Não é
 * divergência de exibição: é divergência de GATE, e ela decide se a técnica
 * chega a rodar.
 *
 * O mínimo agora é um só, declarado aqui. Elevar o do backtest para 24 é a
 * escolha conservadora: 14 candles descrevem menos contexto do que a técnica
 * assume ao vivo, e alinhar para baixo tornaria o backtest mais permissivo que
 * a produção — construindo evidência histórica sobre leituras que o ao vivo
 * nunca teria feito.
 */

import type { ReadingState } from "@/lib/engines/types";

/**
 * Mínimo de candles fechados para a técnica dizer qualquer coisa.
 *
 * É o mesmo número que `MIN_CANDLES_FOR_ANALYSIS` do tracker — declarado aqui
 * porque é uma regra da TÉCNICA, não da captura. O tracker o reexporta.
 */
export const MIN_CLOSED_CANDLES = 24;

export interface ReadingInput {
  closedCandles: number;
  /** 0–100. Qualidade da leitura visual do frame. */
  quality: number;
  /**
   * Conversão pixel→preço CONFIRMADA. Não é "a escala calibrou": é a série ter
   * de fato saído em preço real e passado na checagem de faixa do contrato.
   */
  priceScaleReady: boolean;
  calibrationConfidence: number;
  /** Problemas adicionais do caminho (integridade da série, lacunas). */
  extraIssues?: string[];
}

/**
 * Constrói o estado de leitura.
 *
 * A ESCALA NÃO ENTRA EM `issues`, de propósito, nos dois caminhos: gráfico
 * visível é leitura ativa. Ela vive em `priceScaleReady`, que governa apenas a
 * publicação de preço exato — nunca se a técnica roda.
 */
export function buildReadingState(input: ReadingInput): ReadingState {
  const issues: string[] = [...(input.extraIssues ?? [])];
  if (input.closedCandles < MIN_CLOSED_CANDLES) {
    issues.push(`Aguardando candles: ${input.closedCandles}/${MIN_CLOSED_CANDLES}.`);
  }
  return {
    sufficient: issues.length === 0,
    timeframeConfirmed: true,
    priceScaleReady: input.priceScaleReady,
    calibrationConfidence: input.calibrationConfidence,
    candleQuality: input.quality,
    closedCandles: input.closedCandles,
    lastCandleClosed: input.closedCandles > 0,
    issues,
    label: issues.length === 0 ? "LEITURA SUFICIENTE" : "LEITURA INSUFICIENTE",
  };
}
