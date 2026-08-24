/**
 * HORÁRIO REAL DO GRÁFICO — posição horizontal → instante de mercado.
 *
 * O que isto substitui: uma grade artificial que assumia "cada coluna = 60
 * segundos, sem buracos". Essa suposição é falsa em leilão, pausa, virada de
 * pregão e em qualquer replay acelerado — e um horário errado envenena tudo que
 * mede idade em barras: o mapa de liquidez, a sequência causal, e a própria
 * medida de antecedência da pré-entrada.
 *
 * A REGRA QUE ATRAVESSA O ARQUIVO
 * `Date.now()` NUNCA representa horário de mercado. Se o eixo não foi lido, o
 * horário não é confiável, e isso viaja junto com o dado em vez de virar um
 * número bonito e falso.
 *
 * INTERPOLAR SIM, EXTRAPOLAR COM RESSALVA
 * Entre dois rótulos lidos, interpolar é legítimo: o eixo é linear por
 * construção. Fora do intervalo lido, a confiança cai com a distância — e é
 * exatamente na borda direita (o candle mais novo, o que interessa) que a
 * extrapolação acontece.
 */

export interface TimeLabel {
  /** Posição horizontal em fração 0–1 da área do gráfico. */
  x: number;
  /** Texto lido, como apareceu. */
  raw: string;
  /** Instante resolvido, em ms epoch. */
  t: number;
  /** 0–1, confiança do OCR neste rótulo. */
  confidence: number;
}

export interface TimeAxis {
  /** Milissegundos por unidade de x (fração da largura). */
  msPerX: number;
  /** Instante em x = 0. */
  originT: number;
  /** Âncoras usadas, ordenadas por x. */
  anchors: TimeLabel[];
  /** 0–100. */
  confidence: number;
  /** Maior erro de ajuste, em ms. */
  residualMs: number;
  /** Passo detectado entre rótulos, em ms. */
  labelStepMs: number | null;
  trusted: boolean;
  detail: string;
}

export const EMPTY_TIME_AXIS: TimeAxis = {
  msPerX: 0,
  originT: 0,
  anchors: [],
  confidence: 0,
  residualMs: 0,
  labelStepMs: null,
  trusted: false,
  detail: "eixo de tempo ainda não lido",
};

/** Abaixo disto o horário não pode ser chamado de confiável. */
export const TIME_CONFIG = {
  minAnchors: 2,
  /** Separação horizontal mínima entre a primeira e a última âncora. */
  minSpanX: 0.15,
  /** Erro de ajuste acima disso significa eixo não linear ou leitura ruim. */
  maxResidualMs: 20_000,
  minConfidence: 60,
  /** Confiança individual mínima do OCR para a âncora entrar. */
  minLabelConfidence: 0.6,
} as const;

/**
 * Interpreta `HH:MM` ou `HH:MM:SS` do eixo do Profit.
 *
 * Devolve minutos desde a meia-noite, não um instante: a data vem de outro
 * lugar. Rótulo de data ("10/ago") é reconhecido e recusado aqui de propósito —
 * misturar as duas leituras produziria um horário absurdo.
 */
export function parseClockLabel(raw: string): number | null {
  const text = raw.trim();
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = match[3] === undefined ? 0 : Number(match[3]);
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return hours * 3_600_000 + minutes * 60_000 + seconds * 1000;
}

/** Combina o dia de negociação com o horário lido no eixo. */
export function resolveInstant(tradingDayStart: number, msSinceMidnight: number): number {
  return tradingDayStart + msSinceMidnight;
}

/**
 * Ajusta a reta x → tempo por mínimos quadrados ponderados pela confiança.
 *
 * O eixo do Profit é linear enquanto o zoom não muda, então uma reta basta. O
 * resíduo é a defesa: se o gráfico rolou entre a leitura de dois rótulos, o
 * ajuste piora e o eixo é recusado em vez de aceito com erro embutido.
 */
export function fitTimeAxis(labels: TimeLabel[]): TimeAxis {
  const usable = labels
    .filter((label) => label.confidence >= TIME_CONFIG.minLabelConfidence)
    .filter((label) => Number.isFinite(label.x) && Number.isFinite(label.t))
    .sort((a, b) => a.x - b.x);

  if (usable.length < TIME_CONFIG.minAnchors) {
    return {
      ...EMPTY_TIME_AXIS,
      detail: `apenas ${usable.length} rótulo(s) de horário legível(is)`,
    };
  }

  const spanX = usable[usable.length - 1]!.x - usable[0]!.x;
  if (spanX < TIME_CONFIG.minSpanX) {
    return {
      ...EMPTY_TIME_AXIS,
      anchors: usable,
      detail: "rótulos de horário concentrados demais para definir a escala",
    };
  }

  let sumW = 0;
  let sumX = 0;
  let sumT = 0;
  let sumXX = 0;
  let sumXT = 0;
  for (const label of usable) {
    const w = Math.max(0.05, label.confidence);
    sumW += w;
    sumX += w * label.x;
    sumT += w * label.t;
    sumXX += w * label.x * label.x;
    sumXT += w * label.x * label.t;
  }
  const denominator = sumW * sumXX - sumX * sumX;
  if (denominator === 0) {
    return { ...EMPTY_TIME_AXIS, anchors: usable, detail: "rótulos degenerados" };
  }
  const msPerX = (sumW * sumXT - sumX * sumT) / denominator;
  const originT = (sumT - msPerX * sumX) / sumW;

  if (msPerX <= 0) {
    // Tempo correndo para trás significa leitura invertida, não mercado.
    return { ...EMPTY_TIME_AXIS, anchors: usable, detail: "eixo de tempo não é crescente" };
  }

  let residualMs = 0;
  for (const label of usable) {
    residualMs = Math.max(residualMs, Math.abs(originT + msPerX * label.x - label.t));
  }

  const steps: number[] = [];
  for (let i = 1; i < usable.length; i += 1) {
    steps.push(usable[i]!.t - usable[i - 1]!.t);
  }
  const labelStepMs = steps.length > 0 ? Math.min(...steps) : null;

  const meanConfidence = usable.reduce((sum, l) => sum + l.confidence, 0) / usable.length;
  const fitPenalty = Math.min(1, residualMs / TIME_CONFIG.maxResidualMs);
  const confidence = Math.round(meanConfidence * 100 * (1 - fitPenalty * 0.6));
  const trusted =
    residualMs <= TIME_CONFIG.maxResidualMs && confidence >= TIME_CONFIG.minConfidence;

  return {
    msPerX,
    originT,
    anchors: usable,
    confidence,
    residualMs,
    labelStepMs,
    trusted,
    detail: trusted
      ? `${usable.length} rótulos · resíduo ${Math.round(residualMs / 1000)}s`
      : `ajuste fraco: resíduo ${Math.round(residualMs / 1000)}s, confiança ${confidence}%`,
  };
}

/** Instante de mercado numa posição horizontal. */
export function timeAt(axis: TimeAxis, x: number): number | null {
  if (!axis.trusted) return null;
  return Math.round(axis.originT + axis.msPerX * x);
}

/**
 * Confiança no instante de UMA posição.
 *
 * Dentro do intervalo lido a confiança é a do ajuste. Fora dele cai com a
 * distância — e a borda direita, que é justamente o candle mais recente, está
 * sempre fora. Fingir a mesma confiança nos dois casos esconderia que o dado
 * mais importante é o menos garantido.
 */
export function confidenceAt(axis: TimeAxis, x: number): number {
  if (!axis.trusted || axis.anchors.length === 0) return 0;
  const first = axis.anchors[0]!.x;
  const last = axis.anchors[axis.anchors.length - 1]!.x;
  if (x >= first && x <= last) return axis.confidence;
  const distance = x < first ? first - x : x - last;
  const span = Math.max(0.01, last - first);
  const decay = Math.min(1, distance / span);
  return Math.round(axis.confidence * (1 - decay * 0.5));
}

export type SessionAnomaly = "GAP" | "SESSAO_NOVA" | "RETROCESSO" | null;

/**
 * O intervalo entre dois candles bate com o timeframe?
 *
 * Um buraco não é erro de leitura — é leilão, pausa ou virada de pregão, e
 * precisa ser tratado como fato do mercado. O que NÃO pode acontecer é o
 * sistema fingir que os candles são consecutivos e medir idade errada.
 */
export function detectAnomaly(
  previousT: number,
  currentT: number,
  timeframeMs: number,
): SessionAnomaly {
  const delta = currentT - previousT;
  if (delta < 0) return "RETROCESSO";
  // Mais de 4 horas de silêncio é outro pregão, não um buraco.
  if (delta >= 4 * 3_600_000) return "SESSAO_NOVA";
  if (delta > timeframeMs * 1.5) return "GAP";
  return null;
}

/**
 * O eixo precisa ser relido?
 *
 * Zoom, arrasto e redimensionamento mudam a reta. Reler a cada frame gastaria
 * OCR à toa; nunca reler deixaria o horário congelado num eixo que mudou.
 */
export function axisNeedsRefresh(
  axis: TimeAxis,
  observed: { x: number; t: number } | null,
  now: number,
  lastReadAt: number,
): boolean {
  if (!axis.trusted) return true;
  // Uma leitura por minuto sustenta a reta sem pesar.
  if (now - lastReadAt > 60_000) return true;
  if (observed === null) return false;
  const expected = timeAt(axis, observed.x);
  if (expected === null) return true;
  return Math.abs(expected - observed.t) > TIME_CONFIG.maxResidualMs;
}
