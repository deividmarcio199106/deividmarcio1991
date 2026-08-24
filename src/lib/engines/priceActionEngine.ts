/**
 * LEITURA VISUAL DE AÇÃO DO PREÇO.
 *
 * Nada aqui olha volume. Todas as métricas vêm da GEOMETRIA DO
 * CANDLE — corpo, pavios, amplitude, posição do fechamento, sequência — que é
 * exatamente o que uma captura de tela permite ler com honestidade.
 *
 * O QUE NÃO MUDA: a técnica. SOS, SOW, UT/UTAD, spring e teste continuam
 * precisando de uma medida de "esforço" e de "exaustão"; elas continuam
 * existindo, agora medidas por geometria em vez de volume inventado.
 *
 * Os nomes deixam explícito que existe somente leitura visual do preço.
 */

import type { Features } from "./marketFeatures";
import { clamp } from "./marketFeatures";
import type { Candle } from "./types";

export interface PriceActionRead {
  /** Pressão compradora pela posição do fechamento no range dos candles (0..100). */
  buyEffort: number;
  /** Pressão vendedora, complementar a buyEffort (0..100). */
  sellEffort: number;
  /** Força do impulso: deslocamento e momento, sem volume (0..100). */
  thrust: number;
  /** Aceleração do movimento (-100..100). */
  acceleration: number;
  /**
   * Estagnação: amplitude sendo percorrida sem o preço progredir — candles de
   * corpo pequeno com pavios grandes. Sucede o antigo "absorption", mas sem
   * afirmar quem absorveu (isso exigiria book real). (0..100)
   */
  stall: number;
  /**
   * Convicção do candle: corpo dominante e fechamento no extremo. Sucede o
   * antigo "aggression" — mede a decisão visível na vela, não agressão de tape.
   * (0..100)
   */
  conviction: number;
  /** Exaustão: esticado, pavios contra, divergência, sequência longa (0..100). */
  exhaustion: number;
  /** Desequilíbrio direcional pela geometria (-100..100, positivo = comprador). */
  imbalance: number;
  /** true quando a geometria aponta contra a tendência técnica vigente. */
  contrary: boolean;
  /** Timestamp do último candle FECHADO usado nesta leitura. */
  lastReadAt: number;
}

/**
 * Deriva a leitura de ação do preço de uma janela de candles fechados.
 *
 * Stateless e determinística: a mesma janela produz sempre o mesmo resultado —
 * requisito de confirmação estável.
 */
export function readPriceAction(window: Candle[], f: Features): PriceActionRead {
  const recent = window.slice(-12);
  if (recent.length === 0) {
    return {
      buyEffort: 50,
      sellEffort: 50,
      thrust: 0,
      acceleration: 0,
      stall: 0,
      conviction: 0,
      exhaustion: 0,
      imbalance: 0,
      contrary: false,
      lastReadAt: 0,
    };
  }

  // ESFORÇO COMPRADOR/VENDEDOR — média da posição do fechamento dentro do range
  // de cada candle. Fechar perto da máxima repetidamente é compra sustentada;
  // é uma medida puramente geométrica, sem volume.
  let closeLocationSum = 0;
  for (const c of recent) {
    const range = Math.max(c.h - c.l, 1e-9);
    closeLocationSum += (c.c - c.l) / range;
  }
  const meanCloseLocation = closeLocationSum / recent.length;
  const buyEffort = meanCloseLocation * 100;
  const sellEffort = 100 - buyEffort;

  // IMPULSO — deslocamento e momento visíveis.
  const thrust = Math.min(100, Math.abs(f.momentum) * 65 + f.displacement * 45);

  const acceleration = clamp(f.acceleration) * 100;

  // ESTAGNAÇÃO — o preço percorre amplitude sem fechar longe: corpo pequeno em
  // relação ao range, repetidamente.
  let bodyToRangeSum = 0;
  for (const c of recent) {
    const range = Math.max(c.h - c.l, 1e-9);
    bodyToRangeSum += Math.abs(c.c - c.o) / range;
  }
  const meanBodyRatio = bodyToRangeSum / recent.length;
  const stall = Math.min(
    100,
    (1 - meanBodyRatio) * 70 * (1 - Math.min(1, Math.abs(f.momentum) * 1.4)) +
      (1 - f.bodyRatio) * 30,
  );

  // CONVICÇÃO — corpo dominante do último candle com fechamento no extremo.
  const lastC = recent[recent.length - 1]!;
  const lastRange = Math.max(lastC.h - lastC.l, 1e-9);
  const closeExtreme = Math.abs((lastC.c - lastC.l) / lastRange - 0.5) * 2;
  const conviction = Math.min(100, f.bodyRatio * 60 + closeExtreme * 40);

  // EXAUSTÃO — idêntica à regra anterior; nenhum termo dela usava volume.
  const seq = Math.max(f.consecutiveUp, f.consecutiveDown);
  const wickAgainst = f.momentum > 0 ? f.upperWick : f.lowerWick;
  const exhaustion = Math.min(
    100,
    f.locationInTrend * 40 +
      wickAgainst * 30 +
      Math.abs(f.divergence) * 25 +
      Math.max(0, seq - 4) * 6,
  );

  const imbalance = clamp((buyEffort - sellEffort) / 50) * 100;

  const contrary =
    Math.abs(imbalance) > 20 && Math.sign(imbalance) !== Math.sign(f.trend) && f.trend !== 0;

  return {
    buyEffort,
    sellEffort,
    thrust,
    acceleration,
    stall,
    conviction,
    exhaustion,
    imbalance,
    contrary,
    lastReadAt: window[window.length - 1]!.t,
  };
}
