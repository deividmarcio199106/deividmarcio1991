import type { Contradiction } from "./contradictionEngine";
import type { Features } from "./marketFeatures";
import type { PriceActionRead } from "./priceActionEngine";
import type { RegimeRead } from "./regimeEngine";
import type { Direction, LiquidityCaptureResult, POI, RiskRead, SMSRead, TradePlan } from "./types";
import type { OrderedPullbackRead } from "./orderedPullback";
import { canPromoteNewSetup04 } from "./newSetup04.frozen";
import { MIN_RISK_REWARD_PARTIAL } from "./strategy";

export type T4SetupId =
  | "TREND_FIRST_PULLBACK"
  | "RANGE_SWEEP"
  | "FAILED_BREAKOUT"
  | "PHASE_RESET"
  | "EXPANSION_RETEST"
  | "HSS_CAPTURE"
  /**
   * NEW_SETUP_04 — família de LABORATÓRIO. Está no type porque o motor precisa
   * saber nomeá-la, não porque ela opera: enquanto `canPromoteNewSetup04` disser
   * não, ela sai com `productionReady: false`.
   */
  | "ORDERED_PULLBACK_TREND"
  | "NONE";

export type T4Quality = "A+" | "A" | "B" | "REJEITADA";

export interface T4Read {
  setup: T4SetupId;
  quality: T4Quality;
  productionReady: boolean;
  reasons: string[];
  blockers: string[];
}

export interface T4Input {
  windowLength: number;
  direction: Direction;
  f: Features;
  priceAction: PriceActionRead;
  regime: RegimeRead;
  capture: LiquidityCaptureResult;
  mainPoi: POI | null;
  sms: SMSRead;
  plan: TradePlan | null;
  risk: RiskRead;
  contradictions: Contradiction[];
  /**
   * Leitura do detector NEW_SETUP_04. Opcional e `null` por padrão: sem ela o
   * roteador se comporta EXATAMENTE como antes, e nenhuma frente que ainda não
   * chama o detector muda de resultado.
   */
  orderedPullback?: OrderedPullbackRead | null;
}

function alignedWithTrend(direction: Direction, trend: number): boolean {
  return (direction === "COMPRA" && trend > 0) || (direction === "VENDA" && trend < 0);
}

function reactionAligned(direction: Direction, pa: PriceActionRead): boolean {
  return direction === "COMPRA"
    ? pa.imbalance >= 8 && pa.conviction >= 30
    : direction === "VENDA"
      ? pa.imbalance <= -8 && pa.conviction >= 30
      : false;
}

function poiRetested(poi: POI | null, f: Features): boolean {
  if (!poi || poi.condition === "invalidado") return false;
  if (poi.condition === "testado" || poi.condition === "mitigado") return true;
  return f.price >= poi.lower && f.price <= poi.upper;
}

function hasRealThreeR(plan: TradePlan | null): boolean {
  return Boolean(
    plan &&
    plan.stopDistance > 0 &&
    plan.riskReward >= MIN_RISK_REWARD_PARTIAL &&
    plan.riskRewardFinal >= MIN_RISK_REWARD_PARTIAL &&
    plan.riskRewardPlan >= MIN_RISK_REWARD_PARTIAL,
  );
}

function qualityFor(input: T4Input, setup: T4SetupId): T4Quality {
  if (setup === "NONE") return "REJEITADA";
  const strongPoi = (input.mainPoi?.strength ?? 0) >= 70;
  const strongReaction = input.priceAction.conviction >= 55 && input.priceAction.thrust >= 45;
  const lowReversal = input.risk.reversalRisk <= 25;
  const completeStructure = input.sms.confirmed || input.capture.valid;
  if (strongPoi && strongReaction && lowReversal && completeStructure) return "A+";
  return "A";
}

/**
 * Router T4. Diferente do motor antigo, não exige sweep em TODO contexto.
 * Cada regime usa a sequência causal apropriada. Isso preserva frequência sem
 * transformar setup genérico em autorização.
 */
export function evaluateT4(input: T4Input): T4Read {
  const blockers: string[] = [];
  const reasons: string[] = [];
  const { direction, f, priceAction: pa, regime, capture, mainPoi, sms, plan, risk } = input;

  if (direction === "NEUTRO") blockers.push("T4: direção técnica indefinida.");
  if (!plan) blockers.push("T4: plano estrutural indisponível.");
  if (!hasRealThreeR(plan)) blockers.push("T4: espaço técnico real abaixo de 3R.");
  if (!mainPoi || mainPoi.condition === "invalidado")
    blockers.push("T4: POI válido não encontrado.");
  if (f.locationInTrend > 0.82) blockers.push("T4: OVEREXTENSION BLOCK — movimento já esticado.");
  if (risk.reversalRisk > 45) blockers.push("T4: risco de reversão acima do limite global.");
  if (input.contradictions.some((item) => item.severity === "bloqueia")) {
    blockers.push("T4: contradição estrutural bloqueante.");
  }
  if (input.windowLength < 14) blockers.push("T4: histórico fechado insuficiente.");
  if (blockers.length > 0) {
    return { setup: "NONE", quality: "REJEITADA", productionReady: false, reasons, blockers };
  }

  const retest = poiRetested(mainPoi, f) || f.retestingLevel !== null;
  const reaction = reactionAligned(direction, pa);
  const trendAligned = alignedWithTrend(direction, f.trend);
  const smsAligned = sms.confirmed && sms.direction === direction;
  const captureAligned = capture.valid && capture.direction === direction;
  const breakoutFailed =
    capture.detail.type === "falso_rompimento" ||
    (capture.detail.status === "capturada_valida" && pa.contrary);

  let setup: T4SetupId = "NONE";

  // 1) Tendência: First Pullback/LPS-LPSY. Sweep não é obrigatório.
  if (
    (regime.regime === "TREND_UP" || regime.regime === "TREND_DOWN") &&
    trendAligned &&
    Math.abs(f.trend) >= 0.4 &&
    retest &&
    reaction &&
    pa.exhaustion < 75 &&
    risk.reversalRisk <= 35
  ) {
    setup = "TREND_FIRST_PULLBACK";
    reasons.push("Tendência alinhada + correção/reteste defendido + reação no candle fechado.");
  }

  // 2) Range/transition: operar borda/sweep, nunca o meio do range.
  const atRangeEdge =
    direction === "COMPRA" ? f.positionInRange <= 0.34 : f.positionInRange >= 0.66;
  if (
    setup === "NONE" &&
    (regime.regime === "RANGE" || regime.regime === "TRANSITION") &&
    atRangeEdge &&
    captureAligned &&
    smsAligned &&
    retest &&
    risk.reversalRisk <= 30
  ) {
    setup = "RANGE_SWEEP";
    reasons.push("Borda do range + sweep + mudança estrutural + reteste.");
  }

  // 3) Failed breakout: rompe, falha e volta para dentro com estrutura oposta.
  if (
    setup === "NONE" &&
    (regime.regime === "RANGE" || regime.regime === "TRANSITION") &&
    atRangeEdge &&
    breakoutFailed &&
    smsAligned &&
    retest &&
    reaction &&
    risk.reversalRisk <= 30
  ) {
    setup = "FAILED_BREAKOUT";
    reasons.push("Rompimento falhou, preço retornou ao valor e confirmou estrutura contrária.");
  }

  // 4) Phase Reset: direção anterior perde estrutura e uma nova fase nasce.
  if (
    setup === "NONE" &&
    regime.regime === "TRANSITION" &&
    smsAligned &&
    reaction &&
    retest &&
    (captureAligned || Math.abs(f.momentum) >= 0.2) &&
    risk.reversalRisk <= 35
  ) {
    setup = "PHASE_RESET";
    reasons.push("TRANSITION + CHOCH/SMS + deslocamento/reação + reteste: nova fase válida.");
  }

  // 5) Expansão: não persegue o candle; exige retorno/reteste depois do deslocamento.
  const expansionDirection =
    (direction === "COMPRA" && (f.brokeHigh || f.momentum > 0)) ||
    (direction === "VENDA" && (f.brokeLow || f.momentum < 0));
  if (
    setup === "NONE" &&
    regime.regime === "EXPANSION" &&
    expansionDirection &&
    f.displacement >= 0.55 &&
    pa.conviction >= 50 &&
    retest &&
    f.locationInTrend <= 0.72 &&
    risk.reversalRisk <= 30
  ) {
    setup = "EXPANSION_RETEST";
    reasons.push("Expansão confirmada + primeiro retorno útil; entrada tardia bloqueada.");
  }

  // 6) HSS é complemento, não gatilho isolado: captura + estrutura + retorno ao POI.
  if (
    setup === "NONE" &&
    captureAligned &&
    smsAligned &&
    retest &&
    reaction &&
    risk.reversalRisk <= 25
  ) {
    setup = "HSS_CAPTURE";
    reasons.push("Captura HSS completa + estrutura + reteste; HSS isolado não opera.");
  }

  /*
   * 7) NEW_SETUP_04 — ORDERED_PULLBACK_TREND (LABORATÓRIO).
   *
   * Entra POR ÚLTIMO e só quando `setup` ainda é "NONE": ela é continuação de
   * tendência, mesmo território de TREND_FIRST_PULLBACK, e uma família nova não
   * pode roubar contexto de uma família de produção já validada. Se o contexto
   * era do First Pullback, ele já levou — e este ramo nem é avaliado.
   */
  if (
    setup === "NONE" &&
    trendAligned &&
    input.orderedPullback?.present === true &&
    input.orderedPullback.direction === direction
  ) {
    setup = "ORDERED_PULLBACK_TREND";
    reasons.push(
      `Pullback ordenado de ${input.orderedPullback.pullbackCandles} candles com pivô preservado e E2 fechada (NEW_SETUP_04, laboratório).`,
    );
  }

  if (setup === "NONE") {
    return {
      setup,
      quality: "B",
      productionReady: false,
      reasons: ["T4 reconheceu contexto, mas nenhuma família A/A+ completou sua sequência."],
      blockers: ["T4: aguardando setup A/A+; configuração B permanece somente em laboratório."],
    };
  }

  /*
   * REGRA DE OURO DA FAMÍLIA NOVA: reconhecer não é autorizar.
   *
   * Mesmo com a sequência inteira fechada, ORDERED_PULLBACK_TREND sai com
   * `productionReady: false` e qualidade "B" (laboratório) enquanto o portão de
   * congelamento disser não — e ele diz não hoje, porque não existe OOS, nem
   * walk-forward, nem ledger conferido, e vários limiares ainda estão sem origem
   * declarada. É isto que impede a família de virar sinal ao vivo por engano.
   *
   * A chamada é sem evidência de propósito: nenhuma dessas provas existe no
   * T4Input. Quando existirem, elas passam a ser lidas de onde forem produzidas
   * e entram aqui como argumento — não como default silencioso.
   */
  if (setup === "ORDERED_PULLBACK_TREND") {
    const promocao = canPromoteNewSetup04();
    if (!promocao.promotable) {
      return {
        setup,
        quality: "B",
        productionReady: false,
        reasons,
        blockers: [
          "T4: ORDERED_PULLBACK_TREND (NEW_SETUP_04) é família de laboratório e não emite sinal de produção.",
          ...promocao.reasons.map((motivo) => `NEW_SETUP_04: ${motivo}`),
        ],
      };
    }
  }

  const quality = qualityFor(input, setup);
  return {
    setup,
    quality,
    productionReady: quality === "A+" || quality === "A",
    reasons,
    blockers: [],
  };
}
