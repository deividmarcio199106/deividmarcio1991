import type { Candle, Direction } from "@/lib/engines/types";
import { STRATEGY_VERSION } from "@/lib/engines/strategy";
import type { T4SetupId } from "@/lib/engines/t4Engine";

/**
 * SNAPSHOT IMUTÁVEL DO SINAL CONFIRMADO (comando §7).
 *
 * No instante em que o estado vira CONFIRMADO, os níveis são congelados aqui e
 * NUNCA recalculados/oscilados por análises seguintes: direção, entrada, stop
 * inicial, 3R e 5R são fixos. Apenas o `currentStop` da GESTÃO T4 existente
 * (proteção 3,5R, lock +0,25R, trailing do runner a partir de 5R) evolui — e
 * ele vive no rastreador de outcome, não neste snapshot.
 */
export interface TradeSignalSnapshot {
  signalId: string;
  version: string;
  asset: string;
  /** Tempo oficial do gráfico (marketClock) no instante da confirmação. */
  chartTimestamp: number;
  direction: Exclude<Direction, "NEUTRO">;
  entry: number;
  initialStop: number;
  threeR: number;
  fiveR: number;
  /** Stop inicial do runner estrutural (3º contrato) — igual ao stop inicial. */
  runnerInitial: number;
  setup: T4SetupId;
  /** Candle fechado que confirmou o sinal. */
  confirmationCandle: Candle;
}

export function createSignalSnapshot(input: {
  asset: string;
  chartTimestamp: number;
  direction: Exclude<Direction, "NEUTRO">;
  entry: number;
  initialStop: number;
  threeR: number;
  fiveR: number;
  setup: T4SetupId;
  confirmationCandle: Candle;
}): TradeSignalSnapshot {
  const snapshot: TradeSignalSnapshot = {
    signalId: `sig_${input.asset}_${input.chartTimestamp}_${input.direction}`,
    version: STRATEGY_VERSION,
    asset: input.asset,
    chartTimestamp: input.chartTimestamp,
    direction: input.direction,
    entry: input.entry,
    initialStop: input.initialStop,
    threeR: input.threeR,
    fiveR: input.fiveR,
    runnerInitial: input.initialStop,
    setup: input.setup,
    confirmationCandle: Object.freeze({ ...input.confirmationCandle }),
  };
  // Imutabilidade real: qualquer tentativa de reescrever falha em modo estrito.
  return Object.freeze(snapshot);
}
