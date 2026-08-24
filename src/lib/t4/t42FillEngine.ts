/**
 * MOTOR DE EXECUÇÃO DA T4.2-HYBRID_ENTRY — zona, TTL, fill e recálculo.
 *
 * ATÉ AQUI A T4.2 ERA UMA DECLARAÇÃO: `techniqueT42.ts` descreve a zona, o TTL
 * e os vetos, mas nenhuma linha CALCULAVA zona, RASTREAVA toque ou EMITIA
 * `EXPIRED_NO_FILL` (auditoria sênior de 23/08, achado nº 1). Este arquivo é o
 * motor — e `T42_EXECUTION` importada de `techniqueT42.ts` é a ÚNICA fonte dos
 * números: nenhum 0.5, 5, 3 ou 1 redigitado aqui. Mudar um número lá muda o
 * hash congelado e invalida a candidata; redigitar aqui criaria um segundo
 * lugar onde a técnica mora, que é o defeito que o congelamento existe para
 * impedir.
 *
 * PURO E DETERMINÍSTICO: mesmos candles, mesma decisão — no live, no replay,
 * no vídeo e no teste. Nenhum relógio, nenhum estado, nenhum fetch.
 *
 * O QUE ELE NÃO FAZ: setup. O E2 chega CONFIRMADO pelo caminho de sempre
 * (leitura estrutural + gates); aqui só se decide ONDE e SE a entrada executa.
 */

import type { BlockCode } from "./blockCodes";
import { T42_EXECUTION } from "./techniqueT42";
import { MIN_RISK_REWARD } from "@/lib/engines/strategy";

/** OHLC mínimo que o motor precisa — compatível com Candle e CandleOhlc. */
export interface OhlcLike {
  o: number;
  h: number;
  l: number;
  c: number;
}

export type T42Direction = "COMPRA" | "VENDA";

/* ------------------------------------------------------------------------ *
 * ZONA
 * ------------------------------------------------------------------------ */

export interface T42Zone {
  /** Borda mais PRÓXIMA do preço no momento do E2 (o close). */
  proximal: number;
  /** Borda mais FUNDA da zona (50% do range do E2, a favor do pullback). */
  distal: number;
  /** low/high em preço absoluto, já ao tick. */
  zoneLow: number;
  zoneHigh: number;
}

const TICK = T42_EXECUTION.tickSize;

/**
 * ARREDONDAMENTO PARA DENTRO, documentado e testado: a borda proximal
 * arredonda AFASTANDO-SE do lado de fora (floor na compra, ceil na venda) e a
 * distal arredonda ENCOLHENDO a profundidade. A zona resultante está sempre
 * CONTIDA na zona ideal — o motor nunca aceita um toque que a regra crua não
 * aceitaria. Se o range do E2 for tão pequeno que o arredondamento colapse as
 * bordas, a zona degenera para UM tick no fechamento — continua válida, só
 * exigente.
 */
export function computeZone(e2: OhlcLike, direction: T42Direction): T42Zone {
  const range = Math.max(0, e2.h - e2.l);
  const profundidade = range * T42_EXECUTION.zoneDepthOfE2Range;
  if (direction === "COMPRA") {
    // Zona ABAIXO do fechamento: o pullback volta para dentro do candle E2.
    const proximal = Math.floor(e2.c / TICK) * TICK;
    const distalIdeal = e2.c - profundidade;
    const distal = Math.min(proximal, Math.ceil(distalIdeal / TICK) * TICK);
    return { proximal, distal, zoneLow: distal, zoneHigh: proximal };
  }
  const proximal = Math.ceil(e2.c / TICK) * TICK;
  const distalIdeal = e2.c + profundidade;
  const distal = Math.max(proximal, Math.floor(distalIdeal / TICK) * TICK);
  return { proximal, distal, zoneLow: proximal, zoneHigh: distal };
}

/* ------------------------------------------------------------------------ *
 * FILL — primeiro toque dentro da zona em até TTL candles FECHADOS
 * ------------------------------------------------------------------------ */

export type T42FillResult =
  | {
      filled: true;
      /** Preço de execução JÁ com o slippage congelado contra a posição. */
      fillPrice: number;
      /** Preço cru do toque, antes do slippage — auditoria. */
      rawFillPrice: number;
      /** 1..TTL — em qual candle fechado após o E2 o toque aconteceu. */
      fillCandle: number;
      slippagePoints: number;
    }
  | {
      filled: false;
      code: Extract<BlockCode, "E2_OPEN_OR_UNKNOWN"> | "EXPIRED_NO_FILL";
      reason: string;
      /** Quantos candles fechados foram examinados. */
      candlesExaminados: number;
    };

/**
 * Rastreia o fill. `candlesFechadosAposE2` são SOMENTE candles comprovadamente
 * fechados, em ordem, começando no primeiro candle DEPOIS do E2. O motor
 * examina no máximo `ttlCandles`: um toque que só aconteça no candle TTL+1
 * NÃO executa — está testado, não é acaso de implementação.
 *
 * SEMÂNTICA DO TOQUE (determinística, conservadora):
 *   - abertura DENTRO da zona → preenche na abertura;
 *   - abertura fora e o candle alcança a proximal → preenche NA PROXIMAL;
 *   - gap que ATRAVESSA a zona inteira (abre além da distal) → preenche na
 *     PROXIMAL mesmo assim: uma limite descansando na proximal teria executado
 *     com melhora, mas o motor nunca assume melhora que não pode provar.
 * Slippage de `fillSlippageTicks` tick(s) é aplicado CONTRA a posição.
 */
export function trackFill(
  zone: T42Zone,
  direction: T42Direction,
  candlesFechadosAposE2: readonly OhlcLike[],
): T42FillResult {
  const ttl = T42_EXECUTION.ttlCandles;
  const slip = T42_EXECUTION.fillSlippageTicks * TICK;
  const compra = direction === "COMPRA";
  const examinar = candlesFechadosAposE2.slice(0, ttl);

  for (let i = 0; i < examinar.length; i++) {
    const candle = examinar[i]!;
    const dentroDaZona = candle.o >= zone.zoneLow && candle.o <= zone.zoneHigh;
    const alcancouProximal = compra ? candle.l <= zone.proximal : candle.h >= zone.proximal;
    if (!dentroDaZona && !alcancouProximal) continue;
    const raw = dentroDaZona ? candle.o : zone.proximal;
    const fillPrice = compra ? raw + slip : raw - slip;
    return {
      filled: true,
      fillPrice,
      rawFillPrice: raw,
      fillCandle: i + 1,
      slippagePoints: slip,
    };
  }

  return {
    filled: false,
    code: "EXPIRED_NO_FILL",
    reason: `Sem toque na zona [${zone.zoneLow}..${zone.zoneHigh}] em ${examinar.length}/${ttl} candles fechados após o E2.`,
    candlesExaminados: examinar.length,
  };
}

/* ------------------------------------------------------------------------ *
 * RECÁLCULO NO PREÇO REAL DO FILL — gates de novo, sobre o risco NOVO
 * ------------------------------------------------------------------------ */

export interface T42PlanAtFill {
  entry: number;
  /** O stop ESTRUTURAL do evento — imutável por regra. */
  stop: number;
  stopDistance: number;
  /** R:R medido do alvo 3R JÁ ARREDONDADO ao tick — pode cair de 3,00. */
  rr: number;
  target3R: number;
  target5R: number;
  /** Espaço até o obstáculo em múltiplos do risco NOVO. Null = sem obstáculo conhecido. */
  roomR: number | null;
}

export type T42Recalc =
  | { allowed: true; plan: T42PlanAtFill }
  | { allowed: false; code: BlockCode; reason: string; details: Record<string, unknown> };

/**
 * Reaplica os gates NO PREÇO REAL. O stop estrutural não se move; o risco é o
 * novo (|fill − stop|); alvos 3R/5R nascem do risco novo, ao tick; e o R:R
 * MEDIDO do alvo arredondado é o que passa no piso — 2,99 REPROVA, 3,00 passa.
 * Obstáculo conhecido antes dos 5R do risco novo também reprova. Obstáculo
 * DESCONHECIDO (null) não reprova aqui: espaço não-medido é responsabilidade
 * do gate de espaço do chamador, que já existe e continua soberano.
 */
export function recalcAtFill(input: {
  direction: T42Direction;
  fillPrice: number;
  stopEstrutural: number;
  obstaculo: number | null;
}): T42Recalc {
  const { direction, fillPrice, stopEstrutural, obstaculo } = input;
  const compra = direction === "COMPRA";

  const ladoCerto = compra ? stopEstrutural < fillPrice : stopEstrutural > fillPrice;
  if (!ladoCerto) {
    return {
      allowed: false,
      code: "STOP_TOO_SMALL",
      reason: `Stop estrutural ${stopEstrutural} do lado errado (ou colado) do fill ${fillPrice} numa ${direction}.`,
      details: { fillPrice, stopEstrutural, direction },
    };
  }

  const stopDistance = Math.abs(fillPrice - stopEstrutural);
  const dir = compra ? 1 : -1;
  const target3R =
    Math.round((fillPrice + dir * stopDistance * T42_EXECUTION.minRrAtFill) / TICK) * TICK;
  const target5R =
    Math.round((fillPrice + dir * stopDistance * T42_EXECUTION.requiredRoomR) / TICK) * TICK;
  const rr = Math.abs(target3R - fillPrice) / stopDistance;

  if (rr < MIN_RISK_REWARD) {
    return {
      allowed: false,
      code: "RR_LT_3",
      reason: `R:R ${rr.toFixed(2)} abaixo do mínimo ${MIN_RISK_REWARD} no preço real do fill (alvo ao tick).`,
      details: { fillPrice, stopDistance, target3R, rr },
    };
  }

  let roomR: number | null = null;
  if (obstaculo !== null) {
    const distancia = compra ? obstaculo - fillPrice : fillPrice - obstaculo;
    if (distancia <= 0) {
      return {
        allowed: false,
        code: "TARGET_5R_NO_ROOM",
        reason: `Obstáculo ${obstaculo} do lado errado do fill ${fillPrice} — espaço estrutural inexistente.`,
        details: { fillPrice, obstaculo, direction },
      };
    }
    roomR = distancia / stopDistance;
    if (roomR < T42_EXECUTION.requiredRoomR) {
      return {
        allowed: false,
        code: "TARGET_5R_NO_ROOM",
        reason: `Obstáculo a ${Math.round(distancia)} pontos (${roomR.toFixed(2)}R do risco novo) antes dos ${T42_EXECUTION.requiredRoomR}R.`,
        details: { fillPrice, obstaculo, stopDistance, roomR },
      };
    }
  }

  return {
    allowed: true,
    plan: {
      entry: fillPrice,
      stop: stopEstrutural,
      stopDistance,
      rr,
      target3R,
      target5R,
      roomR,
    },
  };
}

/* ------------------------------------------------------------------------ *
 * A FUNÇÃO ÚNICA — quem os três consumidores chamam
 * ------------------------------------------------------------------------ */

export type T42ExecutionOutcome =
  | { status: "AGUARDANDO_RETESTE"; zone: T42Zone; candlesVistos: number; ttl: number }
  | {
      status: "FILLED";
      zone: T42Zone;
      fill: Extract<T42FillResult, { filled: true }>;
      plan: T42PlanAtFill;
    }
  | { status: "EXPIRED_NO_FILL"; zone: T42Zone; reason: string }
  | {
      status: "BLOCKED";
      zone: T42Zone;
      code: BlockCode;
      reason: string;
      details: Record<string, unknown>;
    };

/**
 * Decide a execução T4.2 completa para um E2 confirmado.
 *
 * SEM PERSEGUIÇÃO, POR CONSTRUÇÃO: não existe parâmetro para ampliar a zona,
 * converter a mercado ou estender o TTL — as três proibições da candidata não
 * são checagens, são AUSÊNCIAS. Quem quiser perseguir preço não encontra a
 * alavanca aqui, e adicionar a alavanca muda o hash congelado.
 *
 * Com menos candles fechados que o TTL e ainda sem toque, o veredito é
 * AGUARDANDO_RETESTE — o chamador continua alimentando candles conforme
 * fecham; o motor nunca conta candle aberto.
 */
export function executeHybridEntry(input: {
  e2: OhlcLike;
  direction: T42Direction;
  stopEstrutural: number;
  obstaculo: number | null;
  candlesFechadosAposE2: readonly OhlcLike[];
}): T42ExecutionOutcome {
  const zone = computeZone(input.e2, input.direction);
  const fill = trackFill(zone, input.direction, input.candlesFechadosAposE2);

  if (!fill.filled) {
    if (fill.candlesExaminados < T42_EXECUTION.ttlCandles) {
      return {
        status: "AGUARDANDO_RETESTE",
        zone,
        candlesVistos: fill.candlesExaminados,
        ttl: T42_EXECUTION.ttlCandles,
      };
    }
    return { status: "EXPIRED_NO_FILL", zone, reason: fill.reason };
  }

  const recalc = recalcAtFill({
    direction: input.direction,
    fillPrice: fill.fillPrice,
    stopEstrutural: input.stopEstrutural,
    obstaculo: input.obstaculo,
  });
  if (!recalc.allowed) {
    return {
      status: "BLOCKED",
      zone,
      code: recalc.code,
      reason: recalc.reason,
      details: recalc.details,
    };
  }
  return { status: "FILLED", zone, fill, plan: recalc.plan };
}
