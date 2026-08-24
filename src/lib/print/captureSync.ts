import { ATRASO_MAXIMO_MS, type SyncState } from "@/lib/capture/marketMonitor";

/**
 * SINCRONISMO ENTRE O PROFIT E A TELA — as regras, em um lugar só.
 *
 * Duas perguntas moram aqui, e as duas eram respondidas por acidente antes:
 *
 *  1. "Este resultado ainda vale para o que está na tela?" — a análise do
 *     candle anterior pode terminar DEPOIS de o candle novo já ter sido
 *     capturado. Aplicá-la produz o defeito "imagem #74 com análise #73".
 *  2. "Este print representa o agora?" — capturar 20s depois da virada ainda
 *     descreve o mesmo candle, mas não é mais o instante da decisão, e a tela
 *     precisa DIZER isso em vez de fingir tempo real.
 *
 * Funções puras de propósito: é o que permite testar as duas sem navegador,
 * sem GPU e sem esperar um minuto de relógio.
 */

export interface ResultadoDeAnalise {
  /** Captura de onde a análise saiu. Null = imagem colada, fora do ciclo. */
  captureId: string | null;
}

/**
 * O resultado pode governar o estado visual?
 *
 * Só quando pertence à captura que está na tela. Fora disso ele continua
 * válido como REGISTRO — vai para histórico, DNA e memória —, mas não troca
 * linha, ação nem congelamento.
 *
 * Imagem colada (captureId null) não disputa com o ciclo: ela é a decisão
 * explícita do operador naquele instante, e é aplicada.
 */
export function resultadoGovernaTela(
  resultado: ResultadoDeAnalise,
  captureAtual: string | null,
): boolean {
  if (resultado.captureId === null) return true;
  if (captureAtual === null) return true;
  return resultado.captureId === captureAtual;
}

/**
 * Classifica o atraso da captura em relação à virada do candle (§7).
 *
 * PROCESSANDO não sai daqui: ele é estado da FILA, não da captura. Misturar os
 * dois apagaria a informação de que o print veio atrasado assim que a análise
 * seguinte começasse.
 */
export function classificarAtraso(
  captureDelayMs: number,
  limite = ATRASO_MAXIMO_MS,
): Extract<SyncState, "SINCRONIZADO" | "ATRASADO"> {
  return captureDelayMs > limite ? "ATRASADO" : "SINCRONIZADO";
}

/**
 * Latência de captura→imagem e captura→análise, para o painel de saúde.
 *
 * `null` quando a etapa ainda não aconteceu — nunca 0, que se leria como
 * "instantâneo" e é o oposto de "não medido".
 */
export interface LatenciasDoPrint {
  ateImagemMs: number | null;
  ateAnaliseMs: number | null;
}

export function medirLatencias(item: {
  candleTime: number | null;
  capturedAt: number;
  analiseConcluidaEm: number | null;
}): LatenciasDoPrint {
  return {
    ateImagemMs: item.candleTime === null ? null : item.capturedAt - item.candleTime,
    ateAnaliseMs:
      item.analiseConcluidaEm === null ? null : item.analiseConcluidaEm - item.capturedAt,
  };
}
