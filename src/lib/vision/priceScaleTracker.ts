import { DEFAULT_RISK_PARAMS } from "@/lib/engines/strategy";
/**
 * ESCALA AUTOMÁTICA — pixel vertical → preço real, sem clique em âncora.
 *
 * A regressão, os portões e o parser de rótulo brasileiro já existem em
 * `priceScale.ts`. O que faltava era o CICLO em volta: quando reler o eixo,
 * quando aceitar, quando desconfiar e quando recalibrar sozinho.
 *
 * O QUE DISPARA RECALIBRAÇÃO
 * Zoom, redimensionamento da janela, arrasto do gráfico, mudança da escala
 * vertical e troca de ativo. Todos têm o mesmo sintoma observável: os rótulos
 * do eixo passam a cair em alturas diferentes das previstas pela reta atual.
 * Em vez de tentar detectar cada gesto, medimos o DESVIO — que é o efeito
 * comum a todos e não depende de adivinhar a causa.
 *
 * POR QUE NÃO BASTA "DEU CERTO UMA VEZ"
 * Uma escala calibrada às 10h e não revalidada é pior que nenhuma: ela produz
 * números plausíveis e errados durante o pregão inteiro. Por isso a reta é
 * confrontada com rótulos novos a cada leitura, e `priceScaleReady` cai sozinho
 * quando o confronto falha.
 */

import {
  calibrateFromAnchors,
  calibrationDrift,
  emptyCalibration,
  priceAt,
  type Calibration,
  type ScaleAnchor,
} from "./priceScale";

export interface PriceScaleState {
  calibration: Calibration;
  /** true só quando múltiplos rótulos concordam dentro da tolerância. */
  priceScaleReady: boolean;
  /** 0–100. */
  priceConfidence: number;
  /** Preço por pixel vertical. Negativo: y cresce para baixo, preço desce. */
  pricePerPixel: number | null;
  /** Maior erro de ajuste, em pixels. */
  scaleResidual: number | null;
  lastScaleUpdate: number | null;
  /** Quantos rótulos sustentam a reta atual. */
  anchorCount: number;
  /** Por que a escala não está pronta, quando não está. */
  blockReason: string | null;
}

export const EMPTY_PRICE_SCALE: PriceScaleState = {
  calibration: emptyCalibration(),
  priceScaleReady: false,
  priceConfidence: 0,
  pricePerPixel: null,
  scaleResidual: null,
  lastScaleUpdate: null,
  anchorCount: 0,
  blockReason: "escala ainda não lida",
};

export const SCALE_TRACKER_CONFIG = {
  /** Releitura de rotina, mesmo com tudo estável. */
  refreshMs: 30_000,
  /** Desvio acima disto invalida a reta na hora. */
  maxDriftPx: 5,
  /** Confirmação exige mais rótulos que o mínimo da regressão. */
  minAnchorsForReady: 3,
} as const;

/**
 * Constrói o estado a partir de âncoras lidas do eixo.
 *
 * A exigência de 3 âncoras para `priceScaleReady` é deliberadamente mais dura
 * que o mínimo de 2 da regressão: com dois pontos qualquer reta passa
 * perfeitamente pelos dois, e o resíduo é sempre zero — ou seja, o teste de
 * qualidade não testa nada. O terceiro rótulo é o primeiro que pode discordar.
 */
export function buildPriceScale(anchors: ScaleAnchor[], now: number): PriceScaleState {
  const calibration = calibrateFromAnchors(anchors);

  if (!calibration.usable) {
    return {
      ...EMPTY_PRICE_SCALE,
      calibration,
      anchorCount: anchors.length,
      blockReason:
        anchors.length < 2
          ? `apenas ${anchors.length} rótulo(s) de preço legível(is) no eixo`
          : "os rótulos lidos não formam uma escala linear coerente",
    };
  }

  const ready = anchors.length >= SCALE_TRACKER_CONFIG.minAnchorsForReady;
  return {
    calibration,
    priceScaleReady: ready,
    priceConfidence: calibration.confidence,
    pricePerPixel: calibration.slope,
    scaleResidual: calibration.maxResidualPx,
    lastScaleUpdate: now,
    anchorCount: anchors.length,
    blockReason: ready
      ? null
      : `escala provável, mas sustentada por só ${anchors.length} rótulos — aguardando confirmação`,
  };
}

/**
 * Confronta a reta atual com rótulos recém-lidos.
 *
 * É aqui que zoom, arrasto e mudança de escala vertical são pegos: qualquer um
 * deles faz o rótulo aparecer numa altura que a reta antiga não prevê.
 */
export function revalidate(
  state: PriceScaleState,
  freshAnchors: ScaleAnchor[],
  now: number,
): PriceScaleState {
  if (!state.calibration.usable || freshAnchors.length === 0) {
    return buildPriceScale(freshAnchors, now);
  }

  const drift = calibrationDrift(state.calibration, freshAnchors);
  if (drift.stale) {
    // Não tentamos consertar a reta antiga: recalibramos do zero com o que
    // está na tela agora. Ajustar uma escala que já mentiu é apostar que ela
    // mentiu pouco.
    return {
      ...buildPriceScale(freshAnchors, now),
      blockReason: `escala mudou (desvio ${drift.maxDriftPx.toFixed(1)}px) — recalibrando`,
    };
  }

  return { ...state, lastScaleUpdate: now };
}

/**
 * Releitura de rotina, sem esperar o eixo mudar.
 *
 * O INTERVALO É PARÂMETRO, e isso não é generalidade gratuita: os dois
 * caminhos que usam esta régua têm cadências incompatíveis. O caminho ao vivo
 * recebe vários frames por segundo e revalida a cada 30s sem custo perceptível;
 * o caminho do PRINT roda uma vez por minuto e cada revalidação é uma
 * INFERÊNCIA de visão inteira sobre o eixo de preço. Com 30s ali, `needsRefresh`
 * seria verdadeiro em todo print e o cache não existiria — que é exatamente o
 * estado que o operador mandou consertar.
 */
export function needsRefresh(
  state: PriceScaleState,
  now: number,
  refreshMs: number = SCALE_TRACKER_CONFIG.refreshMs,
): boolean {
  if (state.lastScaleUpdate === null) return true;
  return now - state.lastScaleUpdate > refreshMs;
}

/** Troca de ativo zera tudo: WIN e WDO não compartilham escala. */
export function resetScale(): PriceScaleState {
  return EMPTY_PRICE_SCALE;
}

/**
 * Converte um nível em unidade de pixel para preço real.
 *
 * Devolve null quando a escala não está pronta — e é isso que faz a T4 dizer
 * "SETUP ARMADO, PREÇO NÃO CONFIÁVEL" em vez de publicar um número que parece
 * preço e não é.
 */
export function toRealPrice(state: PriceScaleState, y: number): number | null {
  if (!state.priceScaleReady) return null;
  return priceAt(state.calibration, y);
}

export interface PricedLevels {
  entryZoneMin: number | null;
  entryZoneMax: number | null;
  stop: number | null;
  target3R: number | null;
  target5R: number | null;
  currentPrice: number | null;
}

export const NO_PRICES: PricedLevels = {
  entryZoneMin: null,
  entryZoneMax: null,
  stop: null,
  target3R: null,
  target5R: null,
  currentPrice: null,
};

/**
 * Níveis da PRÉ-ENTRADA em preço real.
 *
 * O ponto inteiro desta função: os níveis precisam existir ANTES da
 * confirmação, senão o operador descobre a zona quando o gatilho já disparou e
 * não sobra tempo de posicionar ordem nenhuma.
 *
 * 3R e 5R são derivados do risco do próprio setup — a distância entrada-stop —
 * e não de um alvo arbitrário. Sem stop não há R, e então não há alvo: devolver
 * um número aqui seria inventar.
 */
export function priceLevels(
  state: PriceScaleState,
  levels: {
    entryY: number | null;
    stopY: number | null;
    zoneMinY: number | null;
    zoneMaxY: number | null;
    currentY: number | null;
  },
): PricedLevels {
  if (!state.priceScaleReady) return NO_PRICES;

  const entry = levels.entryY === null ? null : priceAt(state.calibration, levels.entryY);
  const stop = levels.stopY === null ? null : priceAt(state.calibration, levels.stopY);
  const zoneMin = levels.zoneMinY === null ? null : priceAt(state.calibration, levels.zoneMinY);
  const zoneMax = levels.zoneMaxY === null ? null : priceAt(state.calibration, levels.zoneMaxY);
  const current = levels.currentY === null ? null : priceAt(state.calibration, levels.currentY);

  let target3R: number | null = null;
  let target5R: number | null = null;
  if (entry !== null && stop !== null) {
    const risk = entry - stop;
    if (risk !== 0) {
      target3R = entry + risk * DEFAULT_RISK_PARAMS.partialTargetMultiple;
      target5R = entry + risk * DEFAULT_RISK_PARAMS.finalTargetMultiple;
    }
  }

  return {
    entryZoneMin: zoneMin === null || zoneMax === null ? null : Math.min(zoneMin, zoneMax),
    entryZoneMax: zoneMin === null || zoneMax === null ? null : Math.max(zoneMin, zoneMax),
    stop,
    target3R,
    target5R,
    currentPrice: current,
  };
}

/** Distância do preço atual até a zona, em pontos. Negativa = já passou. */
export function distanceToZone(prices: PricedLevels): number | null {
  if (
    prices.currentPrice === null ||
    prices.entryZoneMin === null ||
    prices.entryZoneMax === null
  ) {
    return null;
  }
  if (prices.currentPrice < prices.entryZoneMin) return prices.entryZoneMin - prices.currentPrice;
  if (prices.currentPrice > prices.entryZoneMax) return prices.currentPrice - prices.entryZoneMax;
  return 0;
}
