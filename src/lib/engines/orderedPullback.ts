/**
 * NEW_SETUP_04 — ORDERED_PULLBACK_TREND (detector determinístico).
 *
 * A leitura do dono: dentro de tendência estabelecida, o preço corrige de forma
 * ORDENADA — poucos candles, corpos menores que os do impulso, sem devolver o
 * pivô estrutural — e volta a andar num candle de confirmação (E2). Correção
 * ordenada é continuação; correção agressiva é distribuição disfarçada.
 *
 * CAUSALIDADE — a regra que manda em tudo aqui: este detector só enxerga
 * candles FECHADOS até T, e o FECHAMENTO NÃO É MAIS UM CONTRATO VERBAL.
 *
 * A versão anterior dizia no comentário "quem chama é responsável por nunca
 * incluir o candle em formação" — e confiava. Confiança não é verificável: um
 * chamador que passasse a janela com o candle aberto na ponta ganharia uma E2
 * confirmada com um candle que ainda podia virar, e o live confirmaria o que o
 * replay negaria. Agora o chamador DECLARA `lastClosedIndex`, e:
 *
 *   - `null` (não sabe qual candle está fechado) → E2_OPEN_OR_UNKNOWN. Não
 *     saber se o candle fechou é o mesmo que ele estar aberto.
 *   - qualquer coisa APÓS `lastClosedIndex` é CORTADA da janela antes de
 *     qualquer conta. Não existe caminho de código que leia T+1 — nem aqui,
 *     nem num refactor futuro, porque os candles simplesmente não estão lá.
 *
 * Os limiares numéricos NÃO moram aqui: vêm de `newSetup04.frozen.ts`, com
 * proveniência declarada por parâmetro. Detector sem número próprio é detector
 * que não pode ser ajustado "só para esse caso passar".
 */

import { block, type Block, type Decision } from "@/lib/t4/blockCodes";
import { blendedR, activeManagement } from "@/lib/t4/management";
import { MIN_RISK_REWARD, roundToTick, type RiskParams } from "./strategy";
import type { Candle, Direction, TradePlan } from "./types";

export interface OrderedPullbackConfig {
  /** Mínimo de candles corretivos para ARMAR (técnica declarada: 3). */
  minPullbackCandles: number;
  /** Máximo de candles corretivos para ARMAR (técnica declarada: 5). */
  maxPullbackCandles: number;
  /**
   * Acima deste número de candles corretivos o setup está INVALIDADO — não é
   * mais pullback, é mudança de comportamento. Entre `maxPullbackCandles` e
   * este valor existe uma faixa que NÃO arma e NÃO invalida: a técnica não
   * congelou o que fazer com 6 e 7 candles, e inventar regra ali seria criar
   * técnica nova por conta própria.
   */
  invalidationCandles: number;
  pivotLookback: number;
  minTrendStrength: number;
  maxCorrectionBodyRatio: number;
  neutralBodyRatio: number;
  stopBufferTicks: number;
}

/**
 * O que o chamador SABE sobre fechamento. Obrigatório de propósito: não existe
 * default que faça a pergunta desaparecer. Live e replay respondem a MESMA
 * pergunta com o MESMO campo — é isso que os torna comparáveis.
 */
export interface CandleClosure {
  /**
   * Índice do último candle COMPROVADAMENTE fechado dentro de `window`.
   * `null` = não sei / o último está em formação → o detector bloqueia.
   */
  lastClosedIndex: number | null;
}

export interface OrderedPullbackRead {
  present: boolean;
  direction: Direction;
  /** Número REAL de candles corretivos contados — inclusive quando passa do teto. */
  pullbackCandles: number;
  /**
   * true quando a correção passou de `invalidationCandles`. Distinto de "fora
   * da faixa 3–5": aqui o setup está MORTO, não apenas desarmado.
   */
  invalidatedByLength: boolean;
  pullbackStartIndex: number | null;
  confirmationIndex: number | null;
  pullbackExtreme: number | null;
  priorPivot: number | null;
  averageImpulseBody: number | null;
  averagePullbackBody: number | null;
  correctionBodyRatio: number | null;
  pivotPreserved: boolean;
  confirmationClosed: boolean;
  reasons: string[];
  /** Frases humanas — derivadas de `blocks`, mantidas para a tela. */
  blockers: string[];
  /** As MESMAS recusas, com código estável. Vazio SÓ quando `present`. */
  blocks: Block[];
}

const absBody = (c: Candle) => Math.abs(c.c - c.o);
const range = (c: Candle) => Math.max(1e-9, c.h - c.l);

/**
 * Candle corretivo: contra a direção da tendência OU indeciso.
 * Indecisão conta como correção porque a técnica lê "o preço parou de andar",
 * não "o preço voltou" — um doji dentro do pullback não quebra a contagem.
 */
function corrective(c: Candle, direction: Direction, neutralBodyRatio: number): boolean {
  const neutral = absBody(c) / range(c) <= neutralBodyRatio;
  if (neutral) return true;
  if (direction === "COMPRA") return c.c <= c.o;
  if (direction === "VENDA") return c.c >= c.o;
  return false;
}

function alignedBody(c: Candle, direction: Direction): boolean {
  return direction === "COMPRA" ? c.c > c.o : direction === "VENDA" ? c.c < c.o : false;
}

export function detectOrderedPullback(
  fullWindow: Candle[],
  direction: Direction,
  trendStrength: number,
  config: OrderedPullbackConfig,
  closure: CandleClosure,
): OrderedPullbackRead {
  const blocks: Block[] = [];
  const reasons: string[] = [];
  const empty: OrderedPullbackRead = {
    present: false,
    direction,
    pullbackCandles: 0,
    invalidatedByLength: false,
    pullbackStartIndex: null,
    confirmationIndex: null,
    pullbackExtreme: null,
    priorPivot: null,
    averageImpulseBody: null,
    averagePullbackBody: null,
    correctionBodyRatio: null,
    pivotPreserved: false,
    confirmationClosed: false,
    reasons,
    blockers: [],
    blocks,
  };
  /** Snapshot do estado de recusa NO INSTANTE do retorno — nada de getter vivo. */
  const finish = (partial: Partial<OrderedPullbackRead>): OrderedPullbackRead => ({
    ...empty,
    ...partial,
    blocks,
    blockers: blocks.map((b) => b.reason),
  });

  /*
   * FECHAMENTO PRIMEIRO. Antes de qualquer leitura de estrutura, a janela é
   * reduzida ao que está comprovadamente fechado. Bloquear aqui não é falha de
   * setup — é o detector se recusando a opinar sobre um candle que ainda pode
   * virar. `BLOCKED_E2_OPEN_OR_UNKNOWN` na tela significa: espere a virada.
   */
  const { lastClosedIndex } = closure;
  if (lastClosedIndex === null) {
    blocks.push(
      block(
        "E2_OPEN_OR_UNKNOWN",
        "Último candle em formação ou fechamento não comprovado — E2 só existe em candle fechado.",
      ),
    );
    return finish({});
  }
  if (!Number.isInteger(lastClosedIndex) || lastClosedIndex < 0) {
    blocks.push(
      block("E2_OPEN_OR_UNKNOWN", `lastClosedIndex=${lastClosedIndex} inválido para a janela.`),
    );
    return finish({});
  }
  // O CORTE anti-T+1: daqui para baixo os candles após o último fechado NÃO
  // EXISTEM. O veredito de T é idêntico com ou sem os candles que vieram depois
  // porque nenhuma linha consegue alcançá-los.
  const window = fullWindow.slice(0, Math.min(lastClosedIndex + 1, fullWindow.length));

  if (direction === "NEUTRO") {
    blocks.push(block("TREND_WEAK", "Direção neutra — sem tendência não há pullback a favor."));
    return finish({});
  }
  if (window.length < Math.max(20, config.pivotLookback + 10)) {
    blocks.push(
      block(
        "E2_OPEN_OR_UNKNOWN",
        `Janela fechada insuficiente (${window.length} candles) para ler estrutura.`,
      ),
    );
    return finish({});
  }
  if (Math.abs(trendStrength) < config.minTrendStrength) {
    blocks.push(
      block(
        "TREND_WEAK",
        `Tendência ${trendStrength.toFixed(2)} abaixo do limiar congelado ${config.minTrendStrength}.`,
      ),
    );
    return finish({});
  }

  // E2 é o ÚLTIMO candle FECHADO. Nunca window[i + 1]: eles foram cortados.
  const confirmationIndex = window.length - 1;
  const confirmation = window[confirmationIndex]!;
  const previous = window[confirmationIndex - 1]!;
  const confirmationClosed =
    alignedBody(confirmation, direction) &&
    (direction === "COMPRA" ? confirmation.c > previous.h : confirmation.c < previous.l);
  if (!confirmationClosed) {
    blocks.push(
      block(
        "E2_NOT_CONFIRMED",
        "E2 ainda não confirmou no candle fechado (corpo contra ou sem romper o extremo anterior).",
      ),
    );
    return finish({ confirmationIndex, confirmationClosed: false });
  }

  /*
   * CONTAGEM DO PULLBACK — conta até o fim da sequência corretiva, sem parar no
   * teto. Parar em `maxPullbackCandles` faria 6, 7 e 15 candles virarem o mesmo
   * número, e a técnica trata os três casos de forma diferente: 3–5 arma, 6 e 7
   * ficam de fora sem invalidar, acima de 7 o setup está morto. Sem o número
   * real, o motor não sabe qual dos três é.
   */
  let count = 0;
  let i = confirmationIndex - 1;
  while (i >= 0 && corrective(window[i]!, direction, config.neutralBodyRatio)) {
    count++;
    i--;
  }

  if (count > config.invalidationCandles) {
    blocks.push(
      block(
        "PULLBACK_LENGTH",
        `Setup INVALIDADO: correção de ${count} candles passou de ${config.invalidationCandles} — deixou de ser pullback.`,
      ),
    );
    return finish({
      confirmationIndex,
      confirmationClosed: true,
      pullbackCandles: count,
      invalidatedByLength: true,
    });
  }
  if (count < config.minPullbackCandles || count > config.maxPullbackCandles) {
    blocks.push(
      block(
        "PULLBACK_LENGTH",
        `Pullback de ${count} candles fora da faixa que arma (${config.minPullbackCandles}-${config.maxPullbackCandles}); a técnica não congelou regra para esta contagem.`,
      ),
    );
    return finish({
      confirmationIndex,
      confirmationClosed: true,
      pullbackCandles: count,
    });
  }

  const pullbackStartIndex = confirmationIndex - count;
  const pullback = window.slice(pullbackStartIndex, confirmationIndex);
  const impulseStart = Math.max(0, pullbackStartIndex - count);
  const impulse = window.slice(impulseStart, pullbackStartIndex);
  if (impulse.length < config.minPullbackCandles) {
    blocks.push(
      block("IMPULSE_INVALID", "Impulso anterior insuficiente para comparação com o pullback."),
    );
    return finish({
      confirmationIndex,
      confirmationClosed: true,
      pullbackCandles: count,
      pullbackStartIndex,
    });
  }

  const impulseNet = impulse[impulse.length - 1]!.c - impulse[0]!.o;
  const impulseAligned = direction === "COMPRA" ? impulseNet > 0 : impulseNet < 0;
  if (!impulseAligned)
    blocks.push(block("IMPULSE_INVALID", "Impulso anterior não está alinhado à tendência."));

  const avgImpulse = impulse.reduce((s, c) => s + absBody(c), 0) / impulse.length;
  const avgPullback = pullback.reduce((s, c) => s + absBody(c), 0) / pullback.length;
  const bodyRatio = avgImpulse > 0 ? avgPullback / avgImpulse : Number.POSITIVE_INFINITY;
  if (bodyRatio > config.maxCorrectionBodyRatio) {
    blocks.push(
      block(
        "CORRECTION_AGGRESSIVE",
        `Correção agressiva: bodyRatio=${bodyRatio.toFixed(2)} acima de ${config.maxCorrectionBodyRatio}.`,
      ),
    );
  }

  const pivotWindow = window.slice(Math.max(0, impulseStart - config.pivotLookback), impulseStart);
  if (pivotWindow.length === 0) {
    blocks.push(
      block("PIVOT_BROKEN", "Pivô anterior não mensurável — sem janela antes do impulso."),
    );
    return finish({
      confirmationIndex,
      confirmationClosed: true,
      pullbackCandles: count,
      pullbackStartIndex,
      averageImpulseBody: avgImpulse,
      averagePullbackBody: avgPullback,
      correctionBodyRatio: bodyRatio,
    });
  }

  const priorPivot =
    direction === "COMPRA"
      ? Math.min(...pivotWindow.map((c) => c.l))
      : Math.max(...pivotWindow.map((c) => c.h));
  const pullbackExtreme =
    direction === "COMPRA"
      ? Math.min(...pullback.map((c) => c.l))
      : Math.max(...pullback.map((c) => c.h));
  const pivotPreserved =
    direction === "COMPRA" ? pullbackExtreme > priorPivot : pullbackExtreme < priorPivot;
  if (!pivotPreserved) blocks.push(block("PIVOT_BROKEN", "Pivô estrutural rompido pelo pullback."));

  if (blocks.length === 0) {
    reasons.push(
      `Pullback ordenado ${count} candles + pivô preservado + E2 fechada; bodyRatio=${bodyRatio.toFixed(2)}.`,
    );
  }

  return {
    present: blocks.length === 0,
    direction,
    pullbackCandles: count,
    invalidatedByLength: false,
    pullbackStartIndex,
    confirmationIndex,
    pullbackExtreme,
    priorPivot,
    averageImpulseBody: avgImpulse,
    averagePullbackBody: avgPullback,
    correctionBodyRatio: bodyRatio,
    pivotPreserved,
    confirmationClosed: true,
    reasons,
    blockers: blocks.map((b) => b.reason),
    blocks,
  };
}

function floorTick(value: number, tick: number): number {
  return tick > 0 ? Math.floor(value / tick) * tick : value;
}
function ceilTick(value: number, tick: number): number {
  return tick > 0 ? Math.ceil(value / tick) * tick : value;
}

/**
 * Do read ao plano — SEM `return null`.
 *
 * Cada recusa sai com código e números. `null` mudava de significado conforme a
 * linha que o devolvia ("sem setup", "tick inválido", "stop colapsado", "sem
 * espaço de 5R") e a tela mostrava a mesma coisa para todos: nada.
 */
export function buildOrderedPullbackPlan(
  window: Candle[],
  read: OrderedPullbackRead,
  params: RiskParams,
  targetLiquidityPrice: number | null,
  config: OrderedPullbackConfig,
): Decision<TradePlan> {
  if (!read.present || read.confirmationIndex === null || read.pullbackExtreme === null) {
    // A recusa do detector viaja com o plano: o primeiro bloco é a causa raiz.
    const origem = read.blocks[0];
    return origem ?? block("E2_NOT_CONFIRMED", "Setup não presente — leitura sem confirmação.");
  }
  if (params.tickSize <= 0) {
    return block(
      "PRICE_UNRELIABLE",
      `tickSize=${params.tickSize} — escala de preço não confiável.`,
    );
  }

  const confirmation = window[read.confirmationIndex]!;
  const dir = read.direction === "COMPRA" ? 1 : -1;

  /*
   * OS QUATRO NÍVEIS SAEM ARREDONDADOS AO TICK — e a matemática do R:R é refeita
   * sobre os valores arredondados, como `riskEngine.ts` já faz.
   *
   * Alvo não arredondado é preço que não existe no book: o operador digitaria
   * outro número e viveria um R:R diferente do que a tela prometeu. Então o
   * arredondamento vem primeiro e o R:R vem DELE.
   *
   * O stop usa piso/teto (não o tick mais próximo) porque arredondar o stop
   * "para dentro" o colocaria em cima do extremo do pullback, encostando na
   * invalidação estrutural. O buffer de 1 tick da técnica é somado depois.
   */
  const entry = roundToTick(confirmation.c, params.tickSize);
  const stop =
    dir > 0
      ? floorTick(read.pullbackExtreme, params.tickSize) - config.stopBufferTicks * params.tickSize
      : ceilTick(read.pullbackExtreme, params.tickSize) + config.stopBufferTicks * params.tickSize;

  // Distância real DEPOIS do arredondamento: é ela que o operador vive.
  const stopDistance = Math.abs(entry - stop);
  if (stopDistance <= 0 || stopDistance < params.minStopDistance) {
    return block(
      "STOP_TOO_SMALL",
      `Stop de ${stopDistance} pontos abaixo do mínimo ${params.minStopDistance} — arredondamento colapsou entrada e invalidação.`,
    );
  }
  if (stopDistance > params.maxStopDistance) {
    return block(
      "STOP_TOO_LARGE",
      `Stop de ${stopDistance} pontos acima do máximo ${params.maxStopDistance}.`,
    );
  }

  const target1 = roundToTick(
    entry + dir * stopDistance * params.partialTargetMultiple,
    params.tickSize,
  );
  const target2 = roundToTick(
    entry + dir * stopDistance * params.finalTargetMultiple,
    params.tickSize,
  );

  // A gestão declarada é 3R/5R. Obstáculo antes de 5R BLOQUEIA; nunca puxa o alvo para 3.x/4.xR.
  if (targetLiquidityPrice !== null) {
    const room = dir > 0 ? targetLiquidityPrice - entry : entry - targetLiquidityPrice;
    if (room > 0 && room < stopDistance * params.finalTargetMultiple) {
      return block(
        "TARGET_5R_NO_ROOM",
        `Obstáculo a ${Math.round(room)} pontos (${(room / stopDistance).toFixed(2)}R) antes dos ${params.finalTargetMultiple}R do plano.`,
      );
    }
  }

  // R:R MEDIDO dos níveis que serão enviados, não a constante do perfil: a
  // constante descreve a intenção, o nível arredondado descreve o resultado.
  // 2,99 REPROVA e 3,00 passa — o arredondamento ao tick pode roubar o
  // centésimo, e um plano abaixo do piso da casa não sai daqui "quase certo".
  const riskReward = Math.abs(target1 - entry) / stopDistance;
  const riskRewardFinal = Math.abs(target2 - entry) / stopDistance;
  if (riskReward < MIN_RISK_REWARD) {
    return block(
      "RR_LT_3",
      `R:R ${riskReward.toFixed(2)} abaixo do mínimo ${MIN_RISK_REWARD} após arredondamento ao tick.`,
    );
  }
  const riskRewardPlan = blendedR(activeManagement(), [riskReward, riskRewardFinal]) ?? riskReward;

  return {
    allowed: true,
    value: {
      direction: read.direction,
      entry,
      stop,
      target1,
      target2,
      riskReward,
      riskRewardFinal,
      riskRewardPlan,
      stopDistance,
      mode: "ENTRADA DIRETA PROVÁVEL",
      entryPoiId: null,
      targetLiquidityPrice,
    },
  };
}
