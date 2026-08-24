/**
 * VISUAL MARKET STATE — a memória do que a T4 já viu.
 *
 * A diferença que este arquivo existe para criar:
 *
 *   ERRADO   capturar imagem → analisar → esquecer → repetir
 *   CERTO    estado anterior + movimento atual → atualizar leitura
 *
 * Um trader olhando a tela não recomeça do zero a cada piscada. Ele sabe que o
 * topo das 10:14 ainda não foi rompido, que o fundo anterior segurou duas
 * vezes, que o impulso começou há seis minutos. Sem memória, cada leitura vira
 * uma opinião isolada sobre o candle da vez, e nenhuma estrutura é detectável —
 * BOS, CHOCH, sweep e failed breakout SÓ existem em relação ao passado.
 *
 * Por isso `update()` recebe o estado anterior e devolve o próximo. Nada aqui
 * reinicia sozinho, e o histórico de pivôs sobrevive a leituras ruins.
 *
 * CONFIANÇA SEPARADA POR CAMADA
 * A leitura estrutural não pode morrer porque o OCR errou um número. São
 * confianças independentes: dá para saber com certeza que houve rompimento de
 * estrutura e ao mesmo tempo não saber o preço exato. Nesse caso a T4 mostra o
 * setup e diz que o preço não é confiável, em vez de calar ou inventar.
 */

export type Trend = "ALTA" | "BAIXA" | "LATERAL" | "INDEFINIDA";
export type Regime = "TENDENCIA" | "RANGE" | "EXPANSAO" | "CONTRACAO" | "INDEFINIDO";
export type Phase = "IMPULSO" | "CORRECAO" | "PULLBACK" | "RETESTE" | "EXAUSTAO" | "NEUTRO";
export type Direction = "COMPRA" | "VENDA" | null;

/** Pivô confirmado. `confirmedAt` é tempo de MERCADO, nunca do relógio local. */
export interface Pivot {
  kind: "TOPO" | "FUNDO";
  price: number | null;
  /** Posição horizontal no gráfico, em fração 0–1. Sobrevive à falta de preço. */
  x: number;
  confirmedAt: number | null;
  /** Quantas vezes o preço voltou a testar este nível. */
  tests: number;
  /** true quando o nível foi rompido e o preço não voltou. */
  broken: boolean;
}

export interface StructureEvent {
  kind: "BOS" | "CHOCH" | "SWEEP" | "FAILED_BREAKOUT" | "REJEICAO" | "RETESTE";
  direction: Direction;
  at: number;
  price: number | null;
  detail: string;
}

export interface Confidence {
  /** A imagem está legível: gráfico enquadrado, candles distinguíveis. */
  visual: number;
  /** A estrutura foi lida: pivôs, tendência, rompimentos. */
  structure: number;
  /** Liquidez e zonas identificadas. */
  liquidity: number;
  /** O setup candidato está formado. */
  setup: number;
  /** Os NÚMEROS são confiáveis. Independente das anteriores de propósito. */
  price: number;
  /** O relógio do gráfico foi lido. */
  time: number;
}

export interface VisualMarketState {
  /** Instante de mercado da última atualização (do relógio do gráfico). */
  marketTime: number | null;
  /** Posição no vídeo, para reproduzir a decisão depois. */
  videoTime: number | null;
  updatedAt: number;
  /** Quantas atualizações este estado acumulou — memória, não amostra. */
  updates: number;

  trend: Trend;
  regime: Regime;
  phase: Phase;

  /** Pivôs mais recentes primeiro. Limitado, mas nunca zerado. */
  pivots: Pivot[];
  highs: number[];
  lows: number[];
  /** Sequência de estrutura: HH, HL, LH, LL. */
  swings: ("HH" | "HL" | "LH" | "LL")[];

  support: number | null;
  resistance: number | null;
  rangeTop: number | null;
  rangeBottom: number | null;

  /** Eventos estruturais recentes, do mais novo para o mais velho. */
  events: StructureEvent[];

  probableDirection: Direction;
  /** Zona onde a entrada é esperada, quando já dá para dizer. */
  probableZone: { min: number; max: number } | null;
  pendingTrigger: string | null;
  invalidation: number | null;
  /** Espaço até a liquidez seguinte, em múltiplos de risco. */
  spaceR: number | null;

  confidence: Confidence;
  /** Motivo pelo qual a leitura não avança. Nunca vazio quando travada. */
  blockReason: string | null;
}

export const EMPTY_CONFIDENCE: Confidence = {
  visual: 0,
  structure: 0,
  liquidity: 0,
  setup: 0,
  price: 0,
  time: 0,
};

export const EMPTY_STATE: VisualMarketState = {
  marketTime: null,
  videoTime: null,
  updatedAt: 0,
  updates: 0,
  trend: "INDEFINIDA",
  regime: "INDEFINIDO",
  phase: "NEUTRO",
  pivots: [],
  highs: [],
  lows: [],
  swings: [],
  support: null,
  resistance: null,
  rangeTop: null,
  rangeBottom: null,
  events: [],
  probableDirection: null,
  probableZone: null,
  pendingTrigger: null,
  invalidation: null,
  spaceR: null,
  confidence: EMPTY_CONFIDENCE,
  blockReason: "aguardando primeira leitura",
};

/** Quanto histórico estrutural sobrevive. Memória, não amostra. */
const MAX_PIVOTS = 40;
const MAX_EVENTS = 60;

/**
 * Uma observação da visão. Campos ausentes são NULOS, e nulo significa
 * "não consegui ler" — nunca zero, nunca o valor anterior repetido em silêncio.
 */
export interface VisionObservation {
  marketTime: number | null;
  videoTime: number | null;
  at: number;
  /** Pivôs detectados nesta leitura, se houver. */
  pivots?: Pivot[];
  lastPrice?: number | null;
  visualConfidence: number;
  priceConfidence: number;
  timeConfidence: number;
  /** Motivo quando a leitura não pôde ser feita. */
  problem?: string | null;
}

function classifySwings(pivots: Pivot[]): ("HH" | "HL" | "LH" | "LL")[] {
  const swings: ("HH" | "HL" | "LH" | "LL")[] = [];
  const topos = pivots.filter((p) => p.kind === "TOPO" && p.price !== null);
  const fundos = pivots.filter((p) => p.kind === "FUNDO" && p.price !== null);

  for (let i = 1; i < topos.length; i += 1) {
    const previous = topos[i - 1]!.price!;
    const current = topos[i]!.price!;
    swings.push(current > previous ? "HH" : "LH");
  }
  for (let i = 1; i < fundos.length; i += 1) {
    const previous = fundos[i - 1]!.price!;
    const current = fundos[i]!.price!;
    swings.push(current > previous ? "HL" : "LL");
  }
  return swings;
}

/**
 * Tendência pela sequência de pivôs, não pelo candle da vez.
 * Um candle grande contra a estrutura não inverte a leitura sozinho — é isso
 * que separa tendência de reação.
 */
export function classifyTrend(swings: ("HH" | "HL" | "LH" | "LL")[]): Trend {
  if (swings.length < 2) return "INDEFINIDA";
  const recent = swings.slice(-4);
  const alta = recent.filter((s) => s === "HH" || s === "HL").length;
  const baixa = recent.filter((s) => s === "LH" || s === "LL").length;
  if (alta >= 3) return "ALTA";
  if (baixa >= 3) return "BAIXA";
  return "LATERAL";
}

/**
 * Atualiza o estado com uma observação nova.
 *
 * A regra que atravessa a função: uma leitura ruim NUNCA apaga o que já era
 * conhecido. Ela reduz a confiança e registra o motivo — a estrutura anterior
 * continua valendo até ser contradita por uma leitura boa.
 */
export function updateVisualState(
  previous: VisualMarketState,
  observation: VisionObservation,
): VisualMarketState {
  // Leitura ilegível: preserva tudo, baixa a confiança visual e diz o porquê.
  if (observation.visualConfidence < 30) {
    return {
      ...previous,
      updatedAt: observation.at,
      updates: previous.updates + 1,
      confidence: { ...previous.confidence, visual: observation.visualConfidence },
      blockReason: observation.problem ?? "imagem ilegível — leitura anterior preservada",
    };
  }

  const incoming = observation.pivots ?? [];
  // Pivôs novos entram na frente; o histórico segue vivo abaixo deles.
  const pivots =
    incoming.length > 0 ? [...incoming, ...previous.pivots].slice(0, MAX_PIVOTS) : previous.pivots;

  const swings = classifySwings([...pivots].reverse());
  const trend = classifyTrend(swings);

  const topos = pivots.filter((p) => p.kind === "TOPO" && p.price !== null).map((p) => p.price!);
  const fundos = pivots.filter((p) => p.kind === "FUNDO" && p.price !== null).map((p) => p.price!);

  const resistance = topos.length > 0 ? Math.max(...topos.slice(0, 5)) : previous.resistance;
  const support = fundos.length > 0 ? Math.min(...fundos.slice(0, 5)) : previous.support;

  return {
    ...previous,
    marketTime: observation.marketTime ?? previous.marketTime,
    videoTime: observation.videoTime ?? previous.videoTime,
    updatedAt: observation.at,
    updates: previous.updates + 1,
    trend,
    swings,
    pivots,
    highs: topos.slice(0, 10),
    lows: fundos.slice(0, 10),
    support,
    resistance,
    rangeTop: resistance,
    rangeBottom: support,
    confidence: {
      ...previous.confidence,
      visual: observation.visualConfidence,
      // A estrutura só é confiável com pivôs suficientes para comparar.
      structure: swings.length >= 2 ? Math.min(100, 40 + swings.length * 12) : 20,
      price: observation.priceConfidence,
      time: observation.timeConfidence,
    },
    blockReason: null,
  };
}

/** Registra um evento estrutural sem perder os anteriores. */
export function recordEvent(state: VisualMarketState, event: StructureEvent): VisualMarketState {
  return { ...state, events: [event, ...state.events].slice(0, MAX_EVENTS) };
}

/**
 * Retrocesso no vídeo (seek/replay): descarta o que é posterior ao instante
 * alvo e mantém o passado. Reconstruir sem isso deixaria a leitura contaminada
 * por informação futura — o lookahead que o projeto proíbe.
 */
export function rewindTo(state: VisualMarketState, marketTime: number): VisualMarketState {
  return {
    ...state,
    marketTime,
    pivots: state.pivots.filter((p) => p.confirmedAt === null || p.confirmedAt <= marketTime),
    events: state.events.filter((e) => e.at <= marketTime),
    blockReason: "reconstruindo contexto após retrocesso",
  };
}

/**
 * A estrutura é utilizável mesmo com preço ilegível?
 *
 * Esta é a pergunta que separa "não dá para analisar" de "dá para analisar mas
 * não dá para dizer o número". A T4 precisa poder armar um setup na segunda
 * situação.
 */
export function structureUsable(state: VisualMarketState): boolean {
  return state.confidence.visual >= 50 && state.confidence.structure >= 50;
}

export function priceTrustworthy(state: VisualMarketState): boolean {
  return state.confidence.price >= 60;
}
