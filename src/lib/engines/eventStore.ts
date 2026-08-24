/**
 * Event store + memória temporal (spec V5 §21–§23).
 *
 * Linha do tempo de eventos estruturais mantida no CÓDIGO (nunca na memória
 * interna da IA), com deduplicação semântica: BOS, CHoCH e "quebra estrutural"
 * derivados do mesmo movimento recebem o mesmo evidenceGroupId e contam UMA vez.
 */

export type MarketEventType =
  | "pivotHigh"
  | "pivotLow"
  | "liquiditySweep"
  | "spring"
  | "utad"
  | "BOS"
  | "CHOCH"
  | "quebraEstrutural"
  | "POI"
  | "retest"
  | "reaction"
  | "invalidation"
  | "ENTRY_CONFIRMED"
  | "ENTRY_HIT"
  | "PARTIAL_HIT"
  | "TARGET2_HIT"
  | "RUNNER_STOP"
  | "TARGET_HIT"
  | "STOP_HIT"
  | "SESSION_OPEN"
  | "SESSION_CLOSE";

/** Grupos semânticos: tipos do mesmo grupo no mesmo lugar = mesmo evento. */
const SEMANTIC_GROUP: Record<MarketEventType, string> = {
  pivotHigh: "pivo",
  pivotLow: "pivo",
  liquiditySweep: "captura_liquidez",
  spring: "captura_liquidez",
  utad: "captura_liquidez",
  BOS: "quebra_estrutural",
  CHOCH: "quebra_estrutural",
  quebraEstrutural: "quebra_estrutural",
  POI: "poi",
  retest: "reteste",
  reaction: "reacao",
  invalidation: "invalidacao",
  ENTRY_CONFIRMED: "gestao_confirmacao",
  ENTRY_HIT: "gestao_entrada",
  PARTIAL_HIT: "gestao_parcial",
  TARGET2_HIT: "gestao_alvo2",
  RUNNER_STOP: "gestao_runner",
  TARGET_HIT: "gestao_alvo",
  STOP_HIT: "gestao_stop",
  SESSION_OPEN: "sessao_abertura",
  SESSION_CLOSE: "sessao_fechamento",
};

export interface MarketEvent {
  eventId: string;
  instrument: string;
  timestamp: number;
  candleId: string;
  type: MarketEventType;
  price: number;
  region: string;
  evidence: string;
  /** Confiança visual 0..1 (padrão único do sistema — nunca 0–100 aqui). */
  confidenceVisual: number;
  sourceCaptureId: string;
  evidenceGroupId: string;
  sessionId?: string | null;
  segmentId?: string | null;
  direction?: string | null;
  source?: string | null;
  modelVersion?: string | null;
  techniqueVersion?: string | null;
}

export interface AddEventResult {
  event: MarketEvent;
  /** true quando caiu num grupo já existente — NÃO deve somar evidência de novo. */
  duplicated: boolean;
  evidenceGroupId: string;
}

export class EventStore {
  private events: MarketEvent[] = [];
  private groups = new Map<string, string>(); // chave semântica -> evidenceGroupId
  private sequence = 0;

  constructor(
    private readonly instrument: string,
    /** Balde de preço para dedupe: eventos do mesmo grupo a menos de isto de distância são o mesmo. */
    private priceBucket: number,
    private readonly maxEvents = 400,
    private readonly onEvent?: (event: MarketEvent) => void,
  ) {}

  /**
   * Ajusta o balde com uma medida REAL do mercado (ex.: metade da distância do
   * stop, que é derivada do ATR) — nunca um número mágico fixo para todo ativo.
   */
  setPriceBucket(value: number): void {
    if (Number.isFinite(value) && value > 0) this.priceBucket = value;
  }

  add(input: {
    timestamp: number;
    candleId: string;
    type: MarketEventType;
    price: number;
    region: string;
    evidence: string;
    confidenceVisual: number;
    sourceCaptureId: string;
    sessionId?: string | null;
    segmentId?: string | null;
    direction?: string | null;
    source?: string | null;
    modelVersion?: string | null;
    techniqueVersion?: string | null;
  }): AddEventResult {
    const bucketSize = this.priceBucket > 0 ? this.priceBucket : 1;
    const bucket = Math.round(input.price / bucketSize);
    const semanticKey = `${SEMANTIC_GROUP[input.type]}|${bucket}`;
    const existingGroup = this.groups.get(semanticKey);
    const duplicated = existingGroup !== undefined;
    const evidenceGroupId = existingGroup ?? `grp_${this.instrument}_${++this.sequence}`;
    if (!duplicated) this.groups.set(semanticKey, evidenceGroupId);

    const event: MarketEvent = {
      eventId: `evt_${this.instrument}_${input.timestamp}_${this.events.length}`,
      instrument: this.instrument,
      timestamp: input.timestamp,
      candleId: input.candleId,
      type: input.type,
      price: input.price,
      region: input.region,
      evidence: input.evidence,
      confidenceVisual: Math.max(0, Math.min(1, input.confidenceVisual)),
      sourceCaptureId: input.sourceCaptureId,
      evidenceGroupId,
      sessionId: input.sessionId ?? null,
      segmentId: input.segmentId ?? null,
      direction: input.direction ?? null,
      source: input.source ?? null,
      modelVersion: input.modelVersion ?? null,
      techniqueVersion: input.techniqueVersion ?? null,
    };
    this.events.push(event);
    this.onEvent?.(event);
    if (this.events.length > this.maxEvents)
      this.events.splice(0, this.events.length - this.maxEvents);
    return { event, duplicated, evidenceGroupId };
  }

  /** Linha do tempo completa, em ordem de inserção. */
  timeline(): readonly MarketEvent[] {
    return this.events;
  }

  /** Últimos N eventos — memória temporal para o contexto da IA. */
  recent(n = 12): MarketEvent[] {
    return this.events.slice(-n);
  }

  /** Quantidade de GRUPOS únicos — o que pode contar como evidência. */
  uniqueGroups(): number {
    return new Set(this.events.map((event) => event.evidenceGroupId)).size;
  }

  reset(): void {
    this.events = [];
    this.groups.clear();
    this.sequence = 0;
  }
}
