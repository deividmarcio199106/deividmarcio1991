/**
 * O ELO QUE FALTAVA ENTRE A ESCALA CALIBRADA E OS CANDLES.
 *
 * O DEFEITO, VISTO AO VIVO: o painel anunciava ESCALA PRONTA com R² 1.0000 e,
 * ao lado, publicava "ENTRADA 181.18 · STOP 233.33 · PREÇO ATUAL 194.00" para
 * WINFUT — um contrato que negocia perto de 139.000 pontos. A escala tinha
 * calibrado corretamente; os candles é que nunca souberam disso.
 *
 * A CAUSA: `frameProcessor` extrai os candles SEMPRE com
 * `geometricCalibration(frame.height)` — uma régua de pixel, onde o preço é
 * apenas a altura invertida. A calibração real vivia no `PriceScaleSession` e
 * jamais chegava até lá. Enquanto `priceScaleReady` era falso isso não
 * machucava, porque a guarda apagava todo número. No instante em que a escala
 * ficava pronta, a guarda DESLIGAVA — e os mesmos pixels passavam a ser
 * publicados como preço de mercado. O estado mais perigoso do sistema.
 *
 * A CORREÇÃO, E POR QUE AQUI E NÃO NO EXTRATOR
 * Trocar a régua dentro do extrator quebraria a costura: o `CandleStitcher`
 * compara frames consecutivos, e uma troca de unidade no meio do caminho faria
 * a série inteira parecer outro gráfico. A extração e a costura continuam em
 * unidade GEOMÉTRICA, que é estável frame a frame — e a conversão acontece na
 * SAÍDA, quando a série vai para o motor e para a tela.
 *
 * A transformação é exata e sem perda: as duas réguas são lineares.
 *
 *   geométrica:  valor = H − y        ⇒   y = H − valor
 *   real:        preço = b + a·y      ⇒   preço = b + a·(H − valor)
 *
 * onde H é a altura do frame que produziu a série. Nada é estimado.
 */

import { plausiblePriceRange } from "@/lib/engines/instruments";
import type { Candle } from "@/lib/engines/types";
import { priceAt, type Calibration } from "./priceScale";

export interface Projection {
  /** Altura do frame que originou a série, em pixels. */
  baseHeight: number;
  calibration: Calibration;
}

/**
 * Converte UM valor da régua geométrica para preço real.
 *
 * Devolve `null` quando a calibração não é utilizável: sem régua não existe
 * conversão, e devolver o valor cru seria exatamente o defeito que este módulo
 * corrige.
 */
export function projectValue(value: number, projection: Projection): number | null {
  const { baseHeight, calibration } = projection;
  if (!calibration.usable || baseHeight <= 0 || !Number.isFinite(value)) return null;
  const y = baseHeight - value;
  return priceAt(calibration, y);
}

/**
 * Converte a série inteira.
 *
 * Devolve a série ORIGINAL quando não há como converter. O chamador continua
 * sabendo o que tem em mãos por `priceScaleReady` — e é ele quem decide se
 * publica número ou não.
 */
export function projectSeries(candles: Candle[], projection: Projection): Candle[] {
  const { calibration, baseHeight } = projection;
  if (!calibration.usable || baseHeight <= 0) return candles;

  return candles.map((candle) => {
    const o = projectValue(candle.o, projection);
    const h = projectValue(candle.h, projection);
    const l = projectValue(candle.l, projection);
    const c = projectValue(candle.c, projection);
    if (o === null || h === null || l === null || c === null) return candle;
    return {
      ...candle,
      o,
      // A régua real inverte o eixo (o preço CAI quando y cresce), então a
      // máxima geométrica vira a máxima de preço — mas o par alto/baixo precisa
      // ser reordenado explicitamente em vez de assumido.
      h: Math.max(h, l),
      l: Math.min(h, l),
      c,
    };
  });
}

/**
 * A conversão é plausível para este contrato?
 *
 * Rede de segurança de última instância. Se a série convertida cair fora da
 * faixa do ativo, alguma coisa está errada na régua — e publicar seria repetir
 * o defeito com outro número. Preferimos recusar e continuar em unidade
 * relativa, com a guarda de preço ligada.
 */
export function projectionPlausible(candles: Candle[], asset: string): boolean {
  if (candles.length === 0) return false;
  // A faixa vem do registro de instrumentos — terceira cópia desta tabela,
  // agora eliminada. IND e DOL, que faltavam aqui, passam a ser cobertos.
  const faixa = plausiblePriceRange(asset);
  if (faixa === null) return true;

  const ultimo = candles[candles.length - 1]!;
  return ultimo.c >= faixa.min && ultimo.c <= faixa.max;
}
