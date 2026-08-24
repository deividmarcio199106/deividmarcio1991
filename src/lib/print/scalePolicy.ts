import type { ChartBounds } from "@/lib/vision/chartRoi";
import { needsRefresh, type PriceScaleState } from "@/lib/vision/priceScaleTracker";

/**
 * QUANDO RECALIBRAR A RÉGUA DO EIXO DE PREÇO — a decisão do operador (20/08).
 *
 *   "Não recalibraria OCR completo cegamente a cada print, nem reutilizaria
 *    para sempre. Manter a calibração enquanto a assinatura do viewport/escala
 *    continuar igual. Recalibrar imediatamente se detectar zoom, scroll
 *    vertical, mudança dos preços visíveis, resize, mudança de DPI/resolução,
 *    mudança da área do gráfico ou inconsistência entre preço previsto e
 *    posição Y."
 *
 * O DEFEITO QUE ISTO ENCERRA. O caminho do print calibrava DO ZERO em toda
 * análise, sem cache e sem comparar com a anterior — uma inferência de visão
 * por print, e nenhuma verificação de que a reta nova concorda com a velha.
 * Medido na sessão de 20/08, a linha "ENTRAR SE TOCAR AQUI" caiu fora do lugar
 * em todos os prints em que foi possível conferir:
 *
 *   print 050 · rótulo 170.245 · linha em 169.841 · erro −404 pontos
 *   print 053 · rótulo 170.250 · linha em 169.972 · erro −278
 *   print 054 · rótulo 170.250 · linha em 169.917 · erro −333
 *   print 070 · rótulo 170.925 · linha em 171.699 · erro +774
 *   print 071 · rótulo 170.925 · linha em 170.804 · erro −121
 *   print 082 · rótulo 170.925 · linha em 170.517 · erro −408
 *
 * Os prints 070, 071 e 082 têm o MESMO nível e o MESMO intervalo visível
 * (168.710–171.510), e a linha saiu em três alturas diferentes — 1.180 pontos
 * de dispersão. No 070 ela foi parar fora da área de plotagem, sobre o menu do
 * Profit. Não é viés de calibração: é uma reta refeita do zero a cada print,
 * sem ninguém conferir se ela ainda descreve o mesmo eixo.
 *
 * A POLÍTICA, EM UMA FRASE: geometria é barata e decide na hora; a leitura do
 * eixo é cara e só roda quando a geometria mudou ou o prazo venceu.
 */

/**
 * Releitura de rotina no caminho do print.
 *
 * Cinco minutos, e não os 30 segundos do caminho ao vivo: aqui cada
 * revalidação custa uma inferência inteira sobre o eixo, e o gesto que
 * realmente invalida a régua (zoom, arrasto, resize) já é pego de graça pela
 * moldura. O prazo existe como rede de segurança para o que a moldura não vê —
 * o operador arrastar a escala vertical sem mudar o tamanho do gráfico.
 */
export const REVALIDACAO_DE_ROTINA_MS = 5 * 60_000;

/**
 * Quanto a moldura pode variar sem contar como mudança.
 *
 * A detecção sai de um bitmap amostrado, então ela treme um pouco entre frames
 * mesmo com a janela parada. Medido nas 83 capturas de 20/08, a moldura ficou
 * entre y 0,113–0,133 e altura 0,592–0,779 com o operador mexendo no zoom; com
 * a janela quieta a variação é bem menor que isto. O limiar precisa ignorar o
 * tremor e pegar o gesto.
 */
export const TOLERANCIA_DE_MOLDURA = 0.02;

export interface ScaleContext {
  /** Moldura do gráfico neste frame. Null quando a captura não pôde medir. */
  chartBounds: ChartBounds | null;
  /** Ativo lido. Trocar de ativo zera a régua: WIN e WDO não compartilham eixo. */
  asset: string | null;
}

export interface ScaleMemory {
  state: PriceScaleState;
  /** A moldura contra a qual a régua vigente foi calibrada. */
  bounds: ChartBounds | null;
  asset: string | null;
  /** Altura em pixels do frame que gerou a calibração — a régua depende dela. */
  frameHeight: number;
}

export type ScaleDecision =
  | "PRIMEIRA_CALIBRACAO"
  | "REUSA_CACHE"
  | "RECALIBRA_ATIVO_TROCOU"
  | "RECALIBRA_MOLDURA_MUDOU"
  | "RECALIBRA_SEM_MOLDURA"
  | "RECALIBRA_PRAZO"
  | "RECALIBRA_ESCALA_INVALIDA";

export interface ScalePlan {
  decision: ScaleDecision;
  /** Vai gastar uma leitura de eixo neste print? */
  recalibrate: boolean;
  /** Sempre preenchido, inclusive quando reusa — nada acontece em silêncio. */
  reason: string;
}

function moldurasDiferem(a: ChartBounds, b: ChartBounds): boolean {
  return (
    Math.abs(a.x - b.x) > TOLERANCIA_DE_MOLDURA ||
    Math.abs(a.y - b.y) > TOLERANCIA_DE_MOLDURA ||
    Math.abs(a.width - b.width) > TOLERANCIA_DE_MOLDURA ||
    Math.abs(a.height - b.height) > TOLERANCIA_DE_MOLDURA
  );
}

/**
 * Decide, ANTES de gastar a inferência, se a régua vigente ainda serve.
 *
 * PURA: recebe memória, contexto e o instante; devolve a decisão e o motivo.
 * Nenhum relógio é lido aqui dentro, que é o que torna a política reproduzível
 * no teste e no replay.
 */
export function planScale(
  memory: ScaleMemory | null,
  context: ScaleContext,
  now: number,
): ScalePlan {
  if (memory === null || memory.state.lastScaleUpdate === null) {
    return {
      decision: "PRIMEIRA_CALIBRACAO",
      recalibrate: true,
      reason: "primeira leitura do eixo nesta sessão",
    };
  }

  if (context.asset !== null && memory.asset !== null && context.asset !== memory.asset) {
    return {
      decision: "RECALIBRA_ATIVO_TROCOU",
      recalibrate: true,
      reason: `ativo mudou de ${memory.asset} para ${context.asset} — a escala anterior é de outro papel`,
    };
  }

  /*
   * ESCALA INVÁLIDA NÃO SE REUSA. Reaproveitar uma reta que já foi recusada
   * seria manter na tela um número que o próprio sistema declarou não confiável
   * — e a linha roxa sai desse número.
   */
  if (!memory.state.priceScaleReady) {
    return {
      decision: "RECALIBRA_ESCALA_INVALIDA",
      recalibrate: true,
      reason: memory.state.blockReason ?? "escala vigente não está pronta",
    };
  }

  /*
   * SEM MOLDURA, SEM SINAL DE MUDANÇA. Se a captura não conseguiu localizar o
   * gráfico neste frame, não dá para afirmar que a janela continua a mesma —
   * e reusar a régua nesse escuro é justamente o que produz linha 400 pontos
   * fora do lugar. Quem não sabe, relê.
   */
  if (context.chartBounds === null || !context.chartBounds.usable) {
    return {
      decision: "RECALIBRA_SEM_MOLDURA",
      recalibrate: true,
      reason: "moldura do gráfico não localizada neste frame — sem sinal de que a janela é a mesma",
    };
  }

  if (memory.bounds !== null && moldurasDiferem(memory.bounds, context.chartBounds)) {
    return {
      decision: "RECALIBRA_MOLDURA_MUDOU",
      recalibrate: true,
      reason: "a área do gráfico mudou de tamanho ou posição (zoom, arrasto ou redimensionamento)",
    };
  }

  if (needsRefresh(memory.state, now, REVALIDACAO_DE_ROTINA_MS)) {
    return {
      decision: "RECALIBRA_PRAZO",
      recalibrate: true,
      reason: `revalidação de rotina (${Math.round(REVALIDACAO_DE_ROTINA_MS / 60_000)} min desde a última leitura do eixo)`,
    };
  }

  return {
    decision: "REUSA_CACHE",
    recalibrate: false,
    reason: `régua reaproveitada (confiança ${memory.state.priceConfidence}%, ${memory.state.anchorCount} rótulos)`,
  };
}

/**
 * O QUE A SESSÃO REAL PRECISA REGISTRAR SOBRE A RÉGUA — a lista do operador.
 *
 * Um objeto por análise, para a sessão de 20–30 min poder ser CONTADA depois em
 * vez de lembrada. Todo campo aceita null, e null aqui significa "não medido
 * neste print", nunca zero.
 */
export interface ScaleTelemetry {
  priceScale: number | null;
  priceScaleConfidence: number | null;
  scaleDrift: number | null;
  lastCalibrationAt: number | null;
  needsRefresh: boolean;
  decision: ScaleDecision;
  reason: string;
  chartBounds: { x: number; y: number; width: number; height: number } | null;
  roiStatus: string;
  clippingStatus: string;
}
