import { drawSource, extractCandlesFromPixels } from "@/lib/capture/frameProcessor";
import type { ChartBounds } from "@/lib/vision/chartRoi";
import type { Calibration } from "@/lib/vision/priceScale";
import type { CandleOhlc } from "./candleLedger";

/**
 * O CANDLE FECHADO LIDO PELOS PIXELS — a segunda via, e hoje a única que responde.
 *
 * POR QUE ELA EXISTE, medido em produção em 20/08/2026. O contrato pede ao
 * modelo o OHLC do candle já fechado (`lastClosedCandle`). Em 25 análises reais
 * seguidas ele devolveu esse campo ZERO vezes — enquanto lia o relógio do
 * gráfico em 18 das mesmas 25. A diferença não é de esforço: relógio é ETIQUETA
 * DE TEXTO, e OHLC de candle é GEOMETRIA. O modelo é bom na primeira e ruim na
 * segunda; pixel é o contrário.
 *
 * A decisão do operador para este caso já estava dada: "se ele falhar ou
 * oscilar, não afrouxe a regra para liberar entrada — extraia o candle fechado
 * por geometria/pixels usando a lógica do ChartTracker".
 *
 * ISTO NÃO É UM EXTRATOR NOVO. `extractCandlesFromPixels` já existe, já é
 * testado e já sabe descartar o candle em formação (ele remove o cluster mais à
 * direita, POSICIONALMENTE). O que faltava era chamador no caminho do print.
 * Este módulo é só a cola: imagem → frame no espaço de coordenadas certo →
 * moldura medida → último candle fechado.
 *
 * O ESPAÇO DE COORDENADAS É A PARTE QUE SILENCIOSAMENTE ERRA. A calibração da
 * escala nasce do canvas de `drawSource`, com largura limitada a 1280. Um `y`
 * medido em qualquer outro tamanho, convertido por `priceAt`, devolve um preço
 * plausível e errado. Por isso o frame vem de `drawSource` e de mais nada.
 */

export interface ClosedCandleRead {
  ohlc: CandleOhlc;
  /** 0–100, como o extrator calcula: largura do cluster e massa do corpo. */
  quality: number;
  /** Quantos candles fechados o frame revelou. Um só já basta, mas conta-se. */
  candlesVisiveis: number;
}

/** Carrega a imagem do print. Rejeita em vez de devolver frame vazio. */
function carregar(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("print ilegível para extração geométrica"));
    el.src = dataUrl;
  });
}

/**
 * Lê o OHLC do último candle FECHADO do print, pela geometria.
 *
 * `null` em qualquer tropeço — imagem ilegível, régua inservível, moldura não
 * localizada, nenhum candle fechado visível. Null aqui significa "não consegui
 * medir", e quem consome trata isso mantendo a T4 sem confirmação. Nunca se
 * devolve um OHLC parcial: um fechamento pela metade é pior que fechamento
 * nenhum, porque parece prova.
 */
export async function lerCandleFechadoPorPixels(
  dataUrl: string,
  calibration: Calibration,
  bounds: ChartBounds | null,
  lastClosedAt: number,
): Promise<ClosedCandleRead | null> {
  let imagem: HTMLImageElement;
  try {
    imagem = await carregar(dataUrl);
  } catch {
    return null;
  }

  let frame;
  try {
    ({ frame } = drawSource(imagem));
  } catch {
    // Canvas indisponível ou imagem sem dimensões: sem medida, sem palpite.
    return null;
  }

  /*
   * A moldura chega em FRAÇÕES do frame capturado e é convertida para pixels
   * DESTE frame. As frações sobrevivem à mudança de resolução — foi para isso
   * que `detectChartBounds` devolve fração e não pixel.
   */
  const rect =
    bounds !== null && bounds.usable
      ? {
          left: Math.round(bounds.x * frame.width),
          right: Math.round((bounds.x + bounds.width) * frame.width),
          top: Math.round(bounds.y * frame.height),
          bottom: Math.round((bounds.y + bounds.height) * frame.height),
        }
      : null;

  const candles = extractCandlesFromPixels(frame, calibration, lastClosedAt, rect);
  const ultimo = candles[candles.length - 1];
  if (!ultimo) return null;

  const ohlc: CandleOhlc = { open: ultimo.o, high: ultimo.h, low: ultimo.l, close: ultimo.c };
  // Fechamento é o que prova; sem ele o resto não serve para nada.
  if (!Number.isFinite(ohlc.close as number)) return null;

  return { ohlc, quality: ultimo.quality, candlesVisiveis: candles.length };
}

/**
 * As duas leituras concordam?
 *
 * Existe porque, quando o modelo VOLTAR a responder, teremos duas fontes para o
 * mesmo número — e duas fontes que ninguém compara é como o sistema passa a ter
 * dois valores para o mesmo fato sem saber. A tolerância é o TICK: abaixo dele
 * a diferença é arredondamento de leitura, acima é discordância real.
 */
export function divergenciaDeFechamento(
  geometria: CandleOhlc | null,
  modelo: CandleOhlc | null,
  tick: number,
): number | null {
  const a = geometria?.close;
  const b = modelo?.close;
  if (typeof a !== "number" || typeof b !== "number") return null;
  const diferenca = Math.abs(a - b);
  return diferenca > tick ? diferenca : 0;
}
