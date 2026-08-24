/**
 * DNA DA T4 — cada setup detectado vira um registro mensurável, ANTES do
 * desfecho.
 *
 * A regra que atravessa o arquivo: a classificação é calculada no instante da
 * decisão, com os dados que existiam ali, e NUNCA é reescrita depois que o
 * resultado aparece. Reclassificar um setup sabendo que ele perdeu é viés
 * retrospectivo — a estatística inteira passa a "descobrir" o que já sabia.
 * Por isso o registro DNA não tem campo de resultado: o desfecho vive no
 * trade e os dois se encontram por `tradeId`, preenchido depois.
 *
 * O QUE ESTE ARQUIVO NÃO FAZ, DE PROPÓSITO
 * Não cria indicador novo. Toda dimensão deriva do que o motor já lê em
 * produção: regime, volatilidade por amplitude real, POI, captura de liquidez,
 * geometria dos candles fechados. Classificar é dar nome ao que já foi medido —
 * não medir coisa nova.
 */

import type { Candle, Direction, POIKind } from "@/lib/engines/types";
import type { Regime } from "@/lib/engines/regimeEngine";
import type { T4Quality } from "@/lib/engines/t4Engine";

/* ------------------------------------------------------------------------ *
 * Vocabulário fechado. Nada fora destas listas entra no banco — é o que
 * permite segmentar por SQL sem normalizar texto livre depois.
 * ------------------------------------------------------------------------ */

export const DNA_GRADES = ["A_PLUS", "A", "B", "C", "DESCARTADA"] as const;
export type DnaGrade = (typeof DNA_GRADES)[number];

// NAO_IDENTIFICADO existe nas duas listas por uma razão: registro antigo ou
// importado pode não ter a dimensão medida, e o default substantivo ("a favor
// da tendência") afirmaria na estatística algo que ninguém observou.
export const DNA_TRENDS = [
  "FORTE",
  "NORMAL",
  "LATERAL",
  "TRANSICAO",
  "CONTRA",
  "NAO_IDENTIFICADO",
] as const;
export type DnaTrend = (typeof DNA_TRENDS)[number];

export const DNA_POSITIONS = ["A_FAVOR", "CONTRA_TENDENCIA", "NAO_IDENTIFICADO"] as const;
export type DnaPosition = (typeof DNA_POSITIONS)[number];

export const DNA_PULLBACKS = [
  "CURTO",
  "PROFUNDO",
  "LIMPO",
  "LATERAL",
  "AGRESSIVO",
  "FALSO_ROMPIMENTO",
  "NAO_IDENTIFICADO",
] as const;
export type DnaPullback = (typeof DNA_PULLBACKS)[number];

export const DNA_TRIGGERS = [
  "FECHAMENTO",
  "ROMPIMENTO",
  "REJEICAO",
  "ENGOLFO",
  "FORCA",
  "RETESTE",
  "NAO_IDENTIFICADO",
] as const;
export type DnaTrigger = (typeof DNA_TRIGGERS)[number];

export const DNA_VOLATILITIES = ["BAIXA", "NORMAL", "ALTA", "EXTREMA"] as const;
export type DnaVolatility = (typeof DNA_VOLATILITIES)[number];

export const DNA_LOCATIONS = [
  "SUPORTE",
  "RESISTENCIA",
  "VWAP",
  "MEDIA",
  "MAXIMA",
  "MINIMA",
  "ROMPIMENTO",
  "CONSOLIDACAO",
  "NAO_IDENTIFICADO",
] as const;
export type DnaLocation = (typeof DNA_LOCATIONS)[number];

export const DNA_ORIGINS = ["LIVE", "REPLAY", "PRINT"] as const;
export type DnaOrigin = (typeof DNA_ORIGINS)[number];

/** Rótulos para o painel — o banco guarda o código, a tela fala português. */
export const DNA_GRADE_LABEL: Record<DnaGrade, string> = {
  A_PLUS: "A+",
  A: "A",
  B: "B",
  C: "C",
  DESCARTADA: "DESCARTADA",
};

export interface SetupDna {
  id: string;
  origin: DnaOrigin;
  /** Sessão/print que originou a detecção. */
  sourceId: string;
  asset: string;
  timeframe: string;
  direction: "COMPRA" | "VENDA";
  /** Instante de MERCADO da decisão — nunca reescrito. */
  detectedAt: number;
  tradingDate: string | null;
  /** Hora local 0–23, para segmentação por faixa horária. */
  hour: number | null;
  techniqueVersion: string;

  grade: DnaGrade;
  trend: DnaTrend;
  position: DnaPosition;
  pullback: DnaPullback;
  /** Fração 0–1 do impulso devolvida pela correção. Null sem impulso medível. */
  pullbackDepth: number | null;
  pullbackBars: number | null;
  impulsePoints: number | null;
  /** Impulso em múltiplos do risco. Null sem stop definido. */
  impulseR: number | null;
  location: DnaLocation;
  /** O `POIKind` cru — a localização mapeada nunca apaga a origem. */
  locationDetail: string | null;
  triggerCandle: DnaTrigger;
  /** 1ª, 2ª, 3ª T4 do movimento; 4 = posterior. Null quando não computável. */
  movementOrdinal: 1 | 2 | 3 | 4 | null;
  volatility: DnaVolatility | null;
  volatilityRatio: number | null;

  stopDistancePoints: number | null;
  rrAvailable: number | null;
  entry: number | null;
  stop: number | null;
  targets: number[];

  /** Preenchidos DEPOIS, quando existirem. Nunca participam da classificação. */
  printId: string | null;
  tradeId: string | null;
}

/**
 * Entrada estreita de propósito: o classificador não recebe `AnalysisResult`
 * inteiro para que um teste consiga montar o cenário em dez linhas — e para
 * que fique explícito QUAIS leituras alimentam cada dimensão.
 */
export interface DnaClassifierInput {
  id: string;
  origin: DnaOrigin;
  sourceId: string;
  asset: string;
  timeframe: string;
  direction: "COMPRA" | "VENDA";
  detectedAt: number;
  /** Candles FECHADOS até o instante da decisão, do mais antigo ao mais novo. */
  window: Candle[];
  regime: { regime: Regime; strength: number };
  /** `VolatilityContext.ratio` — amplitude atual vs mediana recente. */
  volatilityRatio: number | null;
  /** Nota do motor T4. Null quando a origem é um print sem leitura do motor. */
  t4Quality: T4Quality | null;
  /** Sweep/captura de liquidez detectada na confirmação interna. */
  liquidityCaptured: boolean;
  poi: { kind: POIKind; upper: number; lower: number } | null;
  entry: number | null;
  stop: number | null;
  targets: number[];
  rrAvailable: number | null;
  /** Instantes dos setups anteriores na MESMA direção, no mesmo pregão. */
  priorSameDirectionAt: number[];
  techniqueVersion: string;
  printId?: string | null;
  /**
   * `detectedAt` é instante de MERCADO confiável?
   *
   * Em REPLAY sem leitura do eixo de tempo, a grade dos candles é ancorada no
   * relógio local: o instante existe e ordena a série corretamente, mas a DATA
   * e a HORA são do dia em que o vídeo rodou, não do pregão. Derivar
   * `tradingDate`/`hour` daí carimbaria um pregão de março com a data de
   * agosto — e essas duas colunas alimentam a faixa horária do painel, os
   * filtros de período e o corte treino/validação/OOS.
   *
   * Falso ⇒ tradingDate e hour saem NULL, ditos como não lidos. Ver
   * `marketStamp`/`MarketClock`, que já aplicam essa regra à série.
   */
  marketTimeTrusted?: boolean;
}

/* ------------------------------------------------------------------------ *
 * Impulso e correção — a geometria que sustenta pullback e ordinal.
 * ------------------------------------------------------------------------ */

export interface ImpulseRead {
  /** Índice do início do impulso na janela. */
  startIndex: number;
  startAt: number;
  /** Índice do extremo do impulso (máxima na compra, mínima na venda). */
  extremeIndex: number;
  extremeAt: number;
  /** Tamanho do impulso em pontos (sempre positivo). */
  points: number;
  /** Quanto da correção devolveu o impulso, 0–1 (pode passar de 1). */
  retraceFraction: number;
  /** Candles desde o extremo. */
  retraceBars: number;
  /** 0–1: quanto os candles da correção se sobrepõem (lateralidade). */
  overlapFraction: number;
  /** Amplitude média da correção vs amplitude média do impulso. */
  retraceRangeRatio: number;
}

const IMPULSE_LOOKBACK = 30;
/** Impulso menor que isto (vs amplitude média) não é impulso — é ruído. */
const MIN_IMPULSE_RANGES = 2;

function typicalRange(candles: Candle[]): number {
  if (candles.length === 0) return 0;
  const ranges = candles.map((c) => c.h - c.l).sort((a, b) => a - b);
  return ranges[Math.floor(ranges.length / 2)] ?? 0;
}

/**
 * Mede o último impulso na direção do setup e a correção desde o extremo.
 *
 * Determinístico e barato: extremo do lookback → início no extremo oposto
 * ANTERIOR a ele. Null quando o deslocamento não supera o ruído — dizer
 * "sem impulso medível" é mais honesto que classificar lateralidade como
 * pullback curto.
 */
export function measureImpulse(
  window: Candle[],
  direction: "COMPRA" | "VENDA",
): ImpulseRead | null {
  if (window.length < 5) return null;
  const recent = window.slice(-IMPULSE_LOOKBACK);
  const up = direction === "COMPRA";

  let extremeIndex = 0;
  for (let i = 1; i < recent.length; i += 1) {
    const better = up
      ? recent[i]!.h >= recent[extremeIndex]!.h
      : recent[i]!.l <= recent[extremeIndex]!.l;
    if (better) extremeIndex = i;
  }

  /*
   * EXTREMO NO PRIMEIRO CANDLE NÃO É IMPULSO.
   *
   * Com `extremeIndex === 0` não existe perna ANTERIOR ao extremo dentro da
   * janela: o "impulso" viraria a amplitude de um único candle e toda a
   * janela restante seria lida como correção. Numa reversão após queda longa
   * isso produzia retraceFraction de 6.0 e um impulseR absurdo — número
   * grande, plausível e falso. Sem perna medível, a resposta é null.
   */
  if (extremeIndex === 0) return null;

  // Início do impulso = extremo OPOSTO anterior ao extremo. Extremo no último
  // candle é legítimo: correção de zero barras (entrada no rompimento).
  let startIndex = 0;
  let startValue = up ? recent[0]!.l : recent[0]!.h;
  for (let i = 1; i < extremeIndex; i += 1) {
    const value = up ? recent[i]!.l : recent[i]!.h;
    const isNewStart = up ? value <= startValue : value >= startValue;
    if (isNewStart) {
      startValue = value;
      startIndex = i;
    }
  }

  const extreme = up ? recent[extremeIndex]!.h : recent[extremeIndex]!.l;
  const points = Math.abs(extreme - startValue);
  const noise = typicalRange(recent);
  if (points < noise * MIN_IMPULSE_RANGES) return null;

  const retrace = recent.slice(extremeIndex + 1);
  const current = recent[recent.length - 1]!.c;
  const retraceFraction =
    points > 0 ? Math.max(0, (up ? extreme - current : current - extreme) / points) : 0;

  let overlapFraction = 0;
  if (retrace.length >= 2) {
    let overlaps = 0;
    for (let i = 1; i < retrace.length; i += 1) {
      const a = retrace[i - 1]!;
      const b = retrace[i]!;
      const overlap = Math.min(a.h, b.h) - Math.max(a.l, b.l);
      const smaller = Math.min(a.h - a.l, b.h - b.l);
      if (smaller > 0 && overlap / smaller >= 0.5) overlaps += 1;
    }
    overlapFraction = overlaps / (retrace.length - 1);
  }

  const impulseLeg = recent.slice(startIndex, extremeIndex + 1);
  const impulseRange = typicalRange(impulseLeg);
  const retraceRange = typicalRange(retrace);
  const retraceRangeRatio = impulseRange > 0 ? retraceRange / impulseRange : 0;

  return {
    startIndex,
    startAt: recent[startIndex]!.t,
    extremeIndex,
    extremeAt: recent[extremeIndex]!.t,
    points,
    retraceFraction,
    retraceBars: retrace.length,
    overlapFraction,
    retraceRangeRatio,
  };
}

/* ------------------------------------------------------------------------ *
 * Dimensões individuais — cada uma é uma função pura com limiar documentado.
 * ------------------------------------------------------------------------ */

/** Regime + direção → classe de tendência DO PONTO DE VISTA do setup. */
export function classifyTrend(
  regime: Regime,
  strength: number,
  direction: "COMPRA" | "VENDA",
): DnaTrend {
  const trendUp = regime === "TREND_UP";
  const trendDown = regime === "TREND_DOWN";
  if (trendUp || trendDown) {
    const aligned = (trendUp && direction === "COMPRA") || (trendDown && direction === "VENDA");
    // Setup contra a tendência instalada é CONTRA — não importa a força dela.
    if (!aligned) return "CONTRA";
    // 60 é o corte do próprio regimeEngine para evidência bem separada.
    return strength >= 60 ? "FORTE" : "NORMAL";
  }
  if (regime === "RANGE" || regime === "COMPRESSION") return "LATERAL";
  // EXPANSION/TRANSITION/UNCLEAR: mercado trocando de estado.
  return "TRANSICAO";
}

export function positionFor(trend: DnaTrend): DnaPosition {
  return trend === "CONTRA" ? "CONTRA_TENDENCIA" : "A_FAVOR";
}

/**
 * Classe do pullback. Prioridade documentada: captura de liquidez vence tudo
 * (é o evento mais informativo), depois agressividade, profundidade,
 * lateralidade e por fim a forma limpa/curta.
 */
export function classifyPullback(
  impulse: ImpulseRead | null,
  liquidityCaptured: boolean,
): { pullback: DnaPullback; depth: number | null; bars: number | null } {
  if (liquidityCaptured) {
    return {
      pullback: "FALSO_ROMPIMENTO",
      depth: impulse?.retraceFraction ?? null,
      bars: impulse?.retraceBars ?? null,
    };
  }
  if (impulse === null) return { pullback: "NAO_IDENTIFICADO", depth: null, bars: null };

  const { retraceFraction, retraceBars, overlapFraction, retraceRangeRatio } = impulse;
  let pullback: DnaPullback;
  if (retraceRangeRatio >= 0.9 && retraceFraction >= 0.5) {
    // Correção com candles do tamanho do impulso devolvendo mais da metade:
    // o outro lado entrou com força, não é recuo técnico.
    pullback = "AGRESSIVO";
  } else if (retraceFraction >= 0.618) {
    pullback = "PROFUNDO";
  } else if (retraceBars >= 6 && overlapFraction >= 0.6) {
    pullback = "LATERAL";
  } else if (retraceFraction <= 0.382) {
    // Curto E ordenado é o recuo limpo clássico; curto e sobreposto é só curto.
    pullback = retraceBars <= 5 && overlapFraction < 0.5 ? "LIMPO" : "CURTO";
  } else {
    pullback = "CURTO";
  }
  return { pullback, depth: retraceFraction, bars: retraceBars };
}

/**
 * Candle gatilho — a forma do ÚLTIMO candle fechado, com limiares fixos.
 * Prioridade: engolfo > rejeição > força > rompimento > reteste > fechamento.
 */
export function classifyTrigger(
  window: Candle[],
  direction: "COMPRA" | "VENDA",
  poi: { upper: number; lower: number } | null,
): DnaTrigger {
  const last = window[window.length - 1];
  const previous = window[window.length - 2];
  if (!last) return "NAO_IDENTIFICADO";

  const up = direction === "COMPRA";
  const body = Math.abs(last.c - last.o);
  const range = last.h - last.l;
  const closedInFavor = up ? last.c > last.o : last.c < last.o;

  if (previous) {
    const engulfs =
      closedInFavor &&
      Math.min(last.o, last.c) <= Math.min(previous.o, previous.c) &&
      Math.max(last.o, last.c) >= Math.max(previous.o, previous.c) &&
      body > Math.abs(previous.c - previous.o);
    const previousAgainst = up ? previous.c < previous.o : previous.c > previous.o;
    if (engulfs && previousAgainst) return "ENGOLFO";
  }

  // Pavio contra a direção >= 2× o corpo: o nível rejeitou o outro lado.
  const rejectionWick = up ? Math.min(last.o, last.c) - last.l : last.h - Math.max(last.o, last.c);
  if (range > 0 && closedInFavor && body > 0 && rejectionWick >= body * 2) return "REJEICAO";

  const typical = typicalRange(window.slice(-20));
  if (range > 0 && closedInFavor && body / range >= 0.7 && range >= typical * 1.2) return "FORCA";

  if (poi !== null) {
    const brokeOut = up ? last.c > poi.upper : last.c < poi.lower;
    if (brokeOut && closedInFavor) return "ROMPIMENTO";
    const touchedZone = last.l <= poi.upper && last.h >= poi.lower;
    if (touchedZone && closedInFavor) return "RETESTE";
  }

  return closedInFavor ? "FECHAMENTO" : "NAO_IDENTIFICADO";
}

/** Amplitude atual vs mediana recente → classe. Cortes alinhados ao §30. */
export function classifyVolatility(ratio: number | null): DnaVolatility | null {
  if (ratio === null || !Number.isFinite(ratio) || ratio <= 0) return null;
  if (ratio < 0.6) return "BAIXA";
  if (ratio <= 1.6) return "NORMAL";
  if (ratio <= 3) return "ALTA";
  return "EXTREMA";
}

/**
 * POI → localização. VWAP e MÉDIA não existem no motor (não usamos
 * indicadores); esses valores só entram via análise de print, onde a IA vê o
 * que está desenhado no gráfico do operador.
 */
export function classifyLocation(
  poi: { kind: POIKind; upper: number; lower: number } | null,
  direction: "COMPRA" | "VENDA",
): { location: DnaLocation; detail: string | null } {
  if (poi === null) return { location: "NAO_IDENTIFICADO", detail: null };
  const detail = poi.kind;
  switch (poi.kind) {
    case "spring":
    case "test":
    case "lps":
      return { location: "SUPORTE", detail };
    case "ut":
    case "utad":
    case "lpsy":
      return { location: "RESISTENCIA", detail };
    case "suporte_resistencia":
      return { location: direction === "COMPRA" ? "SUPORTE" : "RESISTENCIA", detail };
    case "rompimento_reteste":
      return { location: "ROMPIMENTO", detail };
    case "extremo_range":
      return { location: direction === "COMPRA" ? "MINIMA" : "MAXIMA", detail };
    case "fvg":
    case "origem_deslocamento":
      // Zona de origem/desequilíbrio no meio do movimento — consolidação da
      // perna, não um extremo nem um nível horizontal clássico.
      return { location: "CONSOLIDACAO", detail };
    default:
      return { location: "NAO_IDENTIFICADO", detail };
  }
}

/** Nota do motor → nota DNA. C é reservada à análise de print. */
export function gradeFromQuality(quality: T4Quality | null): DnaGrade {
  switch (quality) {
    case "A+":
      return "A_PLUS";
    case "A":
      return "A";
    case "B":
      return "B";
    case "REJEITADA":
      return "DESCARTADA";
    default:
      return "DESCARTADA";
  }
}

/**
 * Ordinal do setup no movimento: conta os anteriores na mesma direção DESDE o
 * início do impulso atual. Sem impulso medível não há "movimento" definível e
 * o ordinal fica null — nunca um chute.
 */
export function movementOrdinal(
  impulse: ImpulseRead | null,
  priorSameDirectionAt: number[],
): 1 | 2 | 3 | 4 | null {
  if (impulse === null) return null;
  const inMovement = priorSameDirectionAt.filter((at) => at >= impulse.startAt).length;
  const ordinal = inMovement + 1;
  if (ordinal <= 3) return ordinal as 1 | 2 | 3;
  return 4;
}

/** `2026-03-13` local do instante — mesma convenção do resto do projeto. */
function tradingDateOf(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * O classificador completo. Puro: mesma entrada, mesmo DNA — é isso que torna
 * o registro auditável e o replay reproduzível.
 */
export function classifySetupDna(input: DnaClassifierInput): SetupDna {
  const impulse = measureImpulse(input.window, input.direction);
  const trend = classifyTrend(input.regime.regime, input.regime.strength, input.direction);
  const { pullback, depth, bars } = classifyPullback(impulse, input.liquidityCaptured);
  const { location, detail } = classifyLocation(input.poi, input.direction);
  const stopDistance =
    input.entry !== null && input.stop !== null ? Math.abs(input.entry - input.stop) : null;

  return {
    id: input.id,
    origin: input.origin,
    sourceId: input.sourceId,
    asset: input.asset,
    timeframe: input.timeframe,
    direction: input.direction,
    detectedAt: input.detectedAt,
    // Sem relógio de mercado confiável, DATA e HORA não são afirmadas: null é
    // a resposta honesta, e o painel escreve "não lido" em vez de exibir o dia
    // em que o replay rodou como se fosse o pregão.
    tradingDate: input.marketTimeTrusted === false ? null : tradingDateOf(input.detectedAt),
    hour: input.marketTimeTrusted === false ? null : new Date(input.detectedAt).getHours(),
    techniqueVersion: input.techniqueVersion,

    grade: gradeFromQuality(input.t4Quality),
    trend,
    position: positionFor(trend),
    pullback,
    pullbackDepth: depth,
    pullbackBars: bars,
    impulsePoints: impulse?.points ?? null,
    impulseR:
      impulse !== null && stopDistance !== null && stopDistance > 0
        ? Number((impulse.points / stopDistance).toFixed(3))
        : null,
    location,
    locationDetail: detail,
    triggerCandle: classifyTrigger(input.window, input.direction, input.poi),
    movementOrdinal: movementOrdinal(impulse, input.priorSameDirectionAt),
    volatility: classifyVolatility(input.volatilityRatio),
    volatilityRatio: input.volatilityRatio,

    stopDistancePoints: stopDistance,
    rrAvailable: input.rrAvailable,
    entry: input.entry,
    stop: input.stop,
    targets: input.targets,

    printId: input.printId ?? null,
    tradeId: null,
  };
}

/* ------------------------------------------------------------------------ *
 * Adaptador para o AnalysisResult do motor.
 * ------------------------------------------------------------------------ */

/**
 * Subconjunto ESTRUTURAL do `AnalysisResult` que o DNA consome. Declarado
 * aqui, e não importado, para que um teste monte o cenário sem carregar o
 * motor inteiro — e para deixar explícito o que realmente alimenta o DNA.
 */
export interface AnalysisForDna {
  /** Instante de MERCADO da leitura — é ele que carimba `detectedAt`. */
  t: number;
  direction: Direction;
  regime: { regime: Regime; strength: number };
  volatility: { ratio: number } | null;
  t4: { quality: T4Quality };
  internalConfirmation: { capture: { valid: boolean } };
  mainPoi: { kind: POIKind; upper: number; lower: number; condition: string } | null;
  plan: {
    entry: number;
    stop: number;
    target1: number;
    target2: number;
    riskReward: number;
  } | null;
}

export interface DnaAnalysisContext {
  id: string;
  origin: DnaOrigin;
  sourceId: string;
  asset: string;
  timeframe?: string;
  /** Candles fechados até o instante da decisão. Vazio = geometria honesta
   * indisponível (pullback/gatilho saem NAO_IDENTIFICADO, nunca inventados). */
  window: Candle[];
  priorSameDirectionAt: number[];
  techniqueVersion: string;
  printId?: string | null;
  /** Ver `DnaClassifierInput.marketTimeTrusted`. Falso ⇒ data/hora não afirmadas. */
  marketTimeTrusted?: boolean;
}

/**
 * DNA a partir da análise do motor, no instante da decisão.
 *
 * Devolve null para direção NEUTRA: sem lado não há setup para classificar.
 * `detectedAt` vem de `analysis.t` — tempo de MERCADO, nunca `Date.now()`,
 * pela mesma regra que proíbe o relógio local de carimbar candle (sourceMode).
 */
export function dnaFromAnalysis(
  analysis: AnalysisForDna,
  context: DnaAnalysisContext,
): SetupDna | null {
  if (analysis.direction !== "COMPRA" && analysis.direction !== "VENDA") return null;
  const poi =
    analysis.mainPoi !== null && analysis.mainPoi.condition !== "invalidado"
      ? {
          kind: analysis.mainPoi.kind,
          upper: analysis.mainPoi.upper,
          lower: analysis.mainPoi.lower,
        }
      : null;
  return classifySetupDna({
    id: context.id,
    origin: context.origin,
    sourceId: context.sourceId,
    asset: context.asset,
    timeframe: context.timeframe ?? "1m",
    direction: analysis.direction,
    detectedAt: analysis.t,
    window: context.window,
    regime: analysis.regime,
    volatilityRatio: analysis.volatility?.ratio ?? null,
    t4Quality: analysis.t4.quality,
    liquidityCaptured: analysis.internalConfirmation.capture.valid === true,
    poi,
    entry: analysis.plan?.entry ?? null,
    stop: analysis.plan?.stop ?? null,
    targets: analysis.plan ? [analysis.plan.target1, analysis.plan.target2] : [],
    rrAvailable: analysis.plan?.riskReward ?? null,
    priorSameDirectionAt: context.priorSameDirectionAt,
    techniqueVersion: context.techniqueVersion,
    printId: context.printId ?? null,
    marketTimeTrusted: context.marketTimeTrusted,
  });
}
