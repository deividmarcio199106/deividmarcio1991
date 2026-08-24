import { analyzeHSS } from "./hssEngine";
import { buildCaptureResult } from "./liquidityCaptureGate";
import { buildLiquidityMap } from "./liquidityEngine";
import { assessDataQuality, extractFeatures, type Features } from "./marketFeatures";
import { detectMarketState } from "./marketStateEngine";
import { buildPOIs, selectMainPoi } from "./poiEngine";
import { readPriceAction } from "./priceActionEngine";
import { assessRisk, buildPlan } from "./riskEngine";
import { analyzeSMS } from "./smsEngine";
import { detectRegime } from "./regimeEngine";
import { buildContradictions } from "./contradictionEngine";
import { evaluateCausalSequence } from "./causalSequence";
import { volatilityContext } from "./marketBehavior";
import { detectOrderedPullback } from "./orderedPullback";
import { orderedPullbackConfigCongelada } from "./newSetup04.frozen";
import { evaluateT4 } from "./t4Engine";
import {
  DEFAULT_RISK_PARAMS,
  MAX_REVERSAL_RISK,
  MIN_RISK_REWARD_FINAL,
  MIN_RISK_REWARD_PARTIAL,
  MIN_RISK_REWARD_PLAN,
  POI_CONFIG,
  STRATEGY_VERSION,
  type RiskParams,
} from "./strategy";
import type {
  AnalysisResult,
  Candle,
  Direction,
  LiquidityMap,
  ReadingState,
  TechnicalEvidence,
  TechnicalEvidenceState,
  WyckoffRead,
} from "./types";
import { analyzeWyckoff } from "./wyckoffAnalyzer";

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function stateFromQuality(quality: number, invalidated = false): TechnicalEvidenceState {
  if (invalidated) return "invalidada";
  if (quality >= 70) return "confirmada";
  if (quality > 0) return "parcial";
  return "ausente";
}

function evidence(
  input: Omit<TechnicalEvidence, "state"> & { state?: TechnicalEvidenceState },
): TechnicalEvidence {
  return { ...input, state: input.state ?? stateFromQuality(input.measuredValue ?? 0) };
}

function isReactionConfirmedFor(
  direction: Direction,
  priceAction: ReturnType<typeof readPriceAction>,
): boolean {
  if (direction === "COMPRA") {
    return priceAction.imbalance >= 10 && priceAction.conviction >= 35;
  }
  if (direction === "VENDA") {
    return priceAction.imbalance <= -10 && priceAction.conviction >= 35;
  }
  return false;
}

function deriveDirection(
  f: Features,
  wyckoff: WyckoffRead,
  captureDirection: Direction | null,
): Direction {
  if (captureDirection && captureDirection !== "NEUTRO") return captureDirection;
  if (wyckoff.confidence >= 0.35) {
    if (wyckoff.schema === "Acumulação") return "COMPRA";
    if (wyckoff.schema === "Distribuição") return "VENDA";
  }
  if (f.trend >= 0.35) return "COMPRA";
  if (f.trend <= -0.35) return "VENDA";
  return "NEUTRO";
}

/** Liquidez-alvo correta: compra mira liquidez acima; venda mira liquidez abaixo. */
export function pickTargetLiquidity(
  liquidity: LiquidityMap,
  direction: Direction,
  price: number,
): number | null {
  if (direction === "COMPRA") {
    const candidates = liquidity.levels
      .filter((level) => level.kind === "compradora" && level.price > price)
      .sort((a, b) => a.price - b.price);
    return candidates[0]?.price ?? null;
  }
  if (direction === "VENDA") {
    const candidates = liquidity.levels
      .filter((level) => level.kind === "vendedora" && level.price < price)
      .sort((a, b) => b.price - a.price);
    return candidates[0]?.price ?? null;
  }
  return null;
}

function contextQuality(f: Features, wyckoff: WyckoffRead, direction: Direction): number {
  if (direction === "NEUTRO") return 0;
  const schemaAligned =
    (direction === "COMPRA" && wyckoff.schema === "Acumulação") ||
    (direction === "VENDA" && wyckoff.schema === "Distribuição");
  const locationQuality =
    direction === "COMPRA" ? (1 - f.positionInRange) * 100 : f.positionInRange * 100;
  return clamp(wyckoff.confidence * 65 + locationQuality * 0.25 + (schemaAligned ? 10 : 0));
}

/**
 * Bloqueio EXCLUSIVO de preço: a estrutura foi lida, o setup pode estar
 * formado, mas os níveis exatos dependem da escala calibrada. Nunca significa
 * "não analisar" — significa "aguardando preço".
 */
export const PRICE_SCALE_BLOCKER =
  "Preços exatos indisponíveis: escala de preços ainda em calibração automática.";

function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

/**
 * Análise técnica baseada em fatos observáveis. O motor produz fatos, evidências e gates
 * objetivos; a autorização operacional é feita depois pelo motor histórico.
 */
export function analyze(
  window: Candle[],
  options: { reading: ReadingState; riskParams?: RiskParams },
): AnalysisResult | null {
  const closedWindow = window.slice().sort((a, b) => a.t - b.t);
  const f = extractFeatures(closedWindow);
  if (!f) return null;

  const lastAt = closedWindow[closedWindow.length - 1]!.t;
  const priceAction = readPriceAction(closedWindow, f);
  const wyckoff = analyzeWyckoff(closedWindow, f, priceAction);
  const marketState = detectMarketState(f, priceAction, wyckoff);
  const dataQuality = assessDataQuality(closedWindow);
  const liquidity = buildLiquidityMap(closedWindow, f);
  const preliminaryPois = buildPOIs(closedWindow, f, wyckoff, priceAction, liquidity);
  const hss = analyzeHSS(closedWindow, f, liquidity, preliminaryPois);
  const capture = buildCaptureResult(liquidity, hss, f);
  const direction = deriveDirection(f, wyckoff, capture.direction);
  const pois = buildPOIs(closedWindow, f, wyckoff, priceAction, liquidity);
  const mainPoi = selectMainPoi(pois, f.price, direction);
  const sms = analyzeSMS(closedWindow, f, priceAction, hss);
  const regime = detectRegime(f, priceAction);
  const risk = assessRisk(f, priceAction, wyckoff, direction, liquidity, mainPoi, dataQuality);
  const targetLiquidityPrice = pickTargetLiquidity(liquidity, direction, f.price);
  /*
   * POR QUE O PLANO NÃO EXISTE — coletado do próprio `buildPlan`.
   *
   * "Plano técnico indisponível." é um fato, não um motivo: o operador não
   * consegue separar "a estrutura não comporta a operação" de "o motor quebrou".
   * `buildPlan` recusa por razões distintas (obstáculo antes do alvo final,
   * stop estrutural fora dos limites configurados, risco zero após o tick) e
   * cada uma manda o operador fazer uma coisa diferente. Elas viajam por este
   * array até os blockers da análise, que é onde a tela lê.
   */
  const planBlockers: string[] = [];
  const plan = buildPlan(
    f,
    priceAction,
    risk,
    direction,
    mainPoi,
    sms,
    targetLiquidityPrice,
    options.riskParams ?? DEFAULT_RISK_PARAMS,
    planBlockers,
  );

  const contradictions = buildContradictions({
    direction,
    regime: regime.regime,
    f,
    priceAction,
    capture,
    mainPoi,
    plan,
    sms,
    targetLiquidityPrice,
    lastCandleAt: lastAt,
  });

  const reactionConfirmed = isReactionConfirmedFor(direction, priceAction);
  const volatility = volatilityContext(closedWindow);
  if (volatility?.abnormal) {
    contradictions.push({
      id: "volatilidade-anormal",
      severity: "informativa",
      description: volatility.note,
      evidence: `ratio=${volatility.ratio.toFixed(1)}x mediana`,
      region: "candle atual",
      candleAt: lastAt,
    });
  }

  const structureQuality = clamp(
    wyckoff.confidence * 45 +
      Math.abs(f.trend) * 25 +
      priceAction.conviction * 0.2 +
      (sms.confirmed && sms.direction === direction ? 10 : 0),
  );
  const ctxQuality = contextQuality(f, wyckoff, direction);
  const priceInEntryZone =
    plan !== null &&
    (plan.mode === "ENTRADA DIRETA PROVÁVEL" ||
      (mainPoi !== null && f.price >= mainPoi.lower && f.price <= mainPoi.upper));

  /*
   * NEW_SETUP_04 LIGADO NO RUNTIME — era código morto (auditoria sênior): o
   * detector tinha teste verde e ZERO chamadas fora de teste, e o ramo
   * ORDERED_PULLBACK_TREND do roteador nunca recebia a leitura.
   *
   * A PROVA DE FECHAMENTO vem do contrato que já existe: a janela do
   * `analyze()` só contém candles FECHADOS (strategy.ts — "leitura causal em
   * candle fechado; replay e ao vivo usam o MESMO analyze()"), e
   * `reading.lastCandleClosed` é a declaração do chamador de que o último
   * está fechado. Sem a declaração → `lastClosedIndex: null` → o detector
   * BLOQUEIA com E2_OPEN_OR_UNKNOWN; ele nunca opina sobre candle que ainda
   * pode virar, e o corte interno impede T+1 por construção.
   */
  const orderedPullback = detectOrderedPullback(
    closedWindow,
    direction,
    f.trend,
    orderedPullbackConfigCongelada(),
    { lastClosedIndex: options.reading.lastCandleClosed ? closedWindow.length - 1 : null },
  );

  const t4 = evaluateT4({
    windowLength: closedWindow.length,
    direction,
    f,
    priceAction,
    regime,
    capture,
    mainPoi,
    sms,
    plan,
    risk,
    contradictions,
    orderedPullback,
  });

  /*
   * O ROTEADOR RODA ANTES DA SEQUÊNCIA — e não o contrário, como era.
   *
   * A sequência causal precisa saber QUAL família está sendo avaliada para
   * cobrar os pré-requisitos certos: captura de liquidez só de quem opera
   * captura. Enquanto ela era calculada primeiro, aplicava a regra da captura a
   * TODAS as famílias e travava as de continuação — o "aguardando reação após o
   * sweep" que aparecia em plena tendência.
   *
   * A inversão é segura porque `evaluateT4` não lê a sequência: não há
   * dependência circular, e conferi que nenhum campo do roteador vem dela.
   */
  const sequence = evaluateCausalSequence({
    direction,
    capture,
    reactionConfirmed,
    sms,
    mainPoi,
    plan,
    priceInEntryZone,
    price: f.price,
    lastCandleAt: lastAt,
    family: t4.setup,
  });

  // Sem escala calibrada a qualidade visual é a qualidade GEOMÉTRICA dos
  // candles — a calibração não deve zerar a leitura estrutural.
  const visualQuality = options.reading.priceScaleReady
    ? Math.min(options.reading.calibrationConfidence, options.reading.candleQuality)
    : options.reading.candleQuality;
  const riskQuality = plan
    ? clamp((plan.riskRewardPlan / MIN_RISK_REWARD_PLAN) * 70 + (risk.stopQuality / 100) * 30)
    : 0;

  const evidences: TechnicalEvidence[] = [
    evidence({
      id: "estrutura",
      label: "Estrutura e reação do candle",
      group: "estrutura",
      measuredValue: structureQuality,
      occurredAt: lastAt,
      chartRegion: "candles fechados recentes",
      visualQuality,
      justification: reactionConfirmed
        ? "Estrutura e reação do preço alinhadas no candle fechado."
        : "Aguardando reação suficiente no candle fechado.",
    }),
    evidence({
      id: "captura-liquidez",
      label: "Captura de liquidez",
      group: "captura_liquidez",
      measuredValue: capture.valid ? capture.quality : null,
      occurredAt: capture.detail.at,
      chartRegion: capture.detail.side === "compradora" ? "liquidez acima" : "liquidez abaixo",
      visualQuality,
      state:
        capture.detail.status === "invalidada"
          ? "invalidada"
          : capture.valid
            ? "confirmada"
            : "ausente",
      justification: capture.valid
        ? "Varredura, rejeição e deslocamento confirmados."
        : "A sequência de captura de liquidez ainda não foi confirmada.",
    }),
    evidence({
      id: "poi-reteste",
      label: "POI e reteste",
      group: "poi_reteste",
      measuredValue: mainPoi?.strength ?? null,
      occurredAt: mainPoi?.originAt ?? null,
      chartRegion: mainPoi
        ? `${mainPoi.lower.toFixed(2)}–${mainPoi.upper.toFixed(2)}`
        : "sem POI válido",
      visualQuality,
      state: !mainPoi
        ? "ausente"
        : mainPoi.condition === "invalidado"
          ? "invalidada"
          : stateFromQuality(mainPoi.strength),
      justification: mainPoi
        ? `POI ${mainPoi.kind.replace(/_/g, " ")} em estado ${mainPoi.condition}.`
        : "Nenhum POI válido e alinhado foi encontrado.",
    }),
    evidence({
      id: "contexto-wyckoff",
      label: "Contexto Wyckoff e localização",
      group: "contexto_wyckoff",
      measuredValue: ctxQuality,
      occurredAt: lastAt,
      chartRegion: "faixa e estrutura visíveis",
      visualQuality,
      justification:
        wyckoff.schema === "Indefinido"
          ? "Contexto Wyckoff ainda indefinido."
          : `${wyckoff.label}; eventos: ${wyckoff.events.join(", ") || "nenhum confirmado"}.`,
    }),
    evidence({
      id: "risco-retorno",
      label: "Risco, stop e espaço até o alvo",
      group: "risco_retorno",
      measuredValue: plan ? riskQuality : null,
      occurredAt: lastAt,
      chartRegion: "entrada, invalidação e liquidez-alvo",
      visualQuality,
      state: plan ? "confirmada" : "ausente",
      justification: plan
        ? `Parcial ${plan.riskReward.toFixed(2)}R, alvo ${plan.riskRewardFinal.toFixed(2)}R e plano ${plan.riskRewardPlan.toFixed(2)}R.`
        : "Sem plano tecnicamente válido.",
    }),
  ];

  const blockers: string[] = [...options.reading.issues];
  if (!options.reading.sufficient) blockers.push("Leitura visual insuficiente.");
  // A escala bloqueia SOMENTE a decisão (preços exatos), nunca a leitura.
  if (!options.reading.priceScaleReady) {
    blockers.push(PRICE_SCALE_BLOCKER);
  }
  if (!options.reading.timeframeConfirmed) blockers.push("Gráfico de 1 minuto não confirmado.");
  if (!options.reading.lastCandleClosed) {
    blockers.push("Último candle ainda está em formação.");
    /*
     * O MESMO fato, agora com CÓDIGO. A frase acima é para o operador; o
     * código estável abaixo é o que log, teste e homologação comparam — e ele
     * vem do DETECTOR (que recebeu `lastClosedIndex: null` e recusou), não de
     * uma segunda regra local. Só o caso sem-prova entra aqui de propósito:
     * as demais recusas do detector (janela curta, tendência fraca) são da
     * família de laboratório e não mudam `technicalReady` de produção.
     */
    for (const recusaFechamento of orderedPullback.blocks.filter(
      (b) => b.code === "E2_OPEN_OR_UNKNOWN",
    )) {
      blockers.push(`NEW_SETUP_04 BLOQUEADA E2_OPEN_OR_UNKNOWN: ${recusaFechamento.reason}`);
    }
  }
  if (direction === "NEUTRO") blockers.push("Direção técnica ainda indefinida.");
  // T4 usa um roteador por regime. Tendência não precisa inventar sweep; range/reversão
  // continuam exigindo captura/estrutura. Isso é o que aumenta cobertura sem abrir gate genérico.
  blockers.push(...t4.blockers);
  for (const contradiction of contradictions.filter((item) => item.severity === "bloqueia")) {
    blockers.push(contradiction.description);
  }
  if (!plan) {
    blockers.push("Plano técnico indisponível.");
    // O motivo VEM JUNTO. Um NO_TRADE sem motivo na tela é indistinguível de bug.
    blockers.push(...planBlockers);
  } else {
    if (plan.riskReward < MIN_RISK_REWARD_PARTIAL)
      blockers.push(`Parcial abaixo de ${MIN_RISK_REWARD_PARTIAL}R.`);
    if (plan.riskRewardFinal < MIN_RISK_REWARD_FINAL)
      blockers.push(`Alvo final abaixo de ${MIN_RISK_REWARD_FINAL}R.`);
    if (plan.riskRewardPlan < MIN_RISK_REWARD_PLAN)
      blockers.push(`Plano completo abaixo de ${MIN_RISK_REWARD_PLAN}R.`);
  }
  if (risk.reversalRisk > MAX_REVERSAL_RISK) {
    blockers.push(`Risco de reversão ${Math.round(risk.reversalRisk)}% acima do limite.`);
  }

  const uniqueBlockers = unique(blockers);
  const technicalReady = uniqueBlockers.length === 0;
  const explanation = [
    `T4 ${t4.quality} · ${t4.setup}. ${t4.reasons.join(" ")}`,
    wyckoff.label,
    capture.valid
      ? `Captura de liquidez confirmada em ${capture.detail.price?.toFixed(2) ?? "nível identificado"}.`
      : "Captura de liquidez ainda pendente.",
    mainPoi
      ? `POI ${mainPoi.kind.replace(/_/g, " ")} ${mainPoi.condition}, força visual ${mainPoi.strength}/100.`
      : "Nenhum POI válido alinhado.",
    plan
      ? `Entrada ${plan.entry.toFixed(2)}, stop ${plan.stop.toFixed(2)}, parcial ${plan.target1.toFixed(2)} e alvo ${plan.target2.toFixed(2)}.`
      : "Sem plano operacional válido.",
  ].join(" ");

  return {
    t: lastAt,
    strategyVersion: STRATEGY_VERSION,
    price: f.price,
    direction,
    technicalReady,
    reason: t4.productionReady
      ? `T4 ${t4.quality} · ${t4.setup} — ${t4.reasons.join(" ")}`
      : evidences
          .filter((item) => item.state === "confirmada")
          .map((item) => item.label)
          .join(" • ") || "Aguardando evidências técnicas confirmadas.",
    blockers: uniqueBlockers,
    reading: options.reading,
    priceAction,
    wyckoff,
    marketState,
    regime,
    contradictions,
    sequence,
    volatility,
    t4,
    versions: { strategyVersion: STRATEGY_VERSION },
    risk,
    plan,
    liquidity,
    mainPoi,
    pois,
    internalConfirmation: { capture, sms },
    evidences,
    explanation,
  };
}
