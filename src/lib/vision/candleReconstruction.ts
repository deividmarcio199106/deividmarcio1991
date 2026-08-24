/**
 * RECONSTRUÇÃO DE CANDLES DE 1 MINUTO A PARTIR DA CAPTURA VISUAL.
 *
 * Corrige a falha central da versão anterior: o agregador antigo criava candles
 * de 3 segundos com preço normalizado 0–1000 e reempilhava o histórico visual a
 * cada frame. Aqui cada candle tem identificação temporal única, o candle em
 * formação é separado do fechado, e um candle fechado NUNCA é reescrito.
 *
 * Todo preço que entra aqui já passou pela calibração da escala
 * (ver priceScale.ts). Nada é normalizado, nada é sintético.
 */

import type { Candle } from "@/lib/engines/types";

/** Um minuto em milissegundos — o único período operado pelo analisador. */
export const MINUTE_MS = 60_000;

export interface CandleSample {
  /** Instante da amostra (epoch ms). */
  t: number;
  /** Preço já convertido pela escala calibrada. */
  price: number;
  /** Qualidade da leitura visual desta amostra (0..1). */
  quality: number;
}

export interface ReconstructedCandle extends Candle {
  /** Identificação temporal única: `${ativo}:${inícioDoMinuto}`. */
  id: string;
  /** true quando o minuto já terminou e o candle está imutável. */
  closed: boolean;
  /** Amostras que formaram o candle — base da qualidade. */
  samples: number;
  /** Média da qualidade de leitura das amostras (0..100). */
  quality: number;
}

export interface IngestResult {
  /** Candles fechados, em ordem cronológica. Nunca contém o candle em formação. */
  closed: ReconstructedCandle[];
  /** Candle do minuto corrente, ainda mutável. */
  forming: ReconstructedCandle | null;
  /** Candle que fechou exatamente nesta ingestão (dispara a análise). */
  justClosed: ReconstructedCandle | null;
  /** Amostra recusada e por quê — auditoria, nunca silencioso. */
  rejected: string | null;
}

/** Início do minuto que contém `t`. */
export function minuteStart(t: number): number {
  return Math.floor(t / MINUTE_MS) * MINUTE_MS;
}

/** Identificação temporal única e estável de um candle. */
export function candleId(asset: string, bucketStart: number): string {
  return `${asset}:${bucketStart}`;
}

/**
 * O RECONSTRUTOR INCREMENTAL FOI REMOVIDO DESTE ARQUIVO.
 *
 * Ele montava candles a partir de AMOSTRAS colhidas ao longo de minutos reais —
 * um segundo motor medindo o mesmo gráfico que o `ChartTracker`, que reconstrói
 * a série da geometria da tela. Os dois discordavam por construção, e a
 * discordância chegava ao operador como número contraditório no painel.
 *
 * O que sobrou aqui é o que não pertencia a nenhum dos dois motores: a grade de
 * minuto e a verificação de ordem cronológica, usadas pelo pipeline visual.
 */

/** Confirma que a série está em ordem cronológica estrita e sem duplicatas. */
export function assertChronological(candles: readonly ReconstructedCandle[]): {
  ok: boolean;
  problem: string | null;
} {
  const seen = new Set<string>();
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    if (seen.has(c.id)) return { ok: false, problem: `Candle duplicado: ${c.id}` };
    seen.add(c.id);
    if (i > 0 && c.t <= candles[i - 1]!.t) {
      return { ok: false, problem: `Ordem cronológica quebrada em ${c.id}` };
    }
  }
  return { ok: true, problem: null };
}
