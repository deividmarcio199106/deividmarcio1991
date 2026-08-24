/**
 * AGENDADOR DO OCR — a IA enriquece a leitura, nunca a atrasa.
 *
 * A regra que este arquivo existe para tornar impossível de violar:
 *
 *   PROIBIDO   pixels → esperar OCR → rodar T4
 *   CORRETO    pixels → tracker → T4        (imediato)
 *              pixels → OCR → preço/hora    (em paralelo, quando chegar)
 *
 * Se o OCR virasse pré-requisito, a pré-entrada herdaria a latência do modelo —
 * e o estágio inteiro existe para GANHAR tempo antes do gatilho. Um aviso que
 * chega meio minuto atrasado não é aviso.
 *
 * RESPOSTA VELHA É PIOR QUE RESPOSTA NENHUMA
 * Entre o envio do recorte e a volta do modelo, o gráfico rolou, o zoom pode ter
 * mudado e a janela pode ter sido redimensionada. Aplicar uma escala lida numa
 * geometria que não existe mais produz preços plausíveis e errados — o pior
 * resultado possível. Por isso cada pedido carrega a `captureRevision` do
 * momento em que o recorte foi tirado, e a resposta é DESCARTADA se a revisão
 * mudou.
 */

export type OcrKind = "PRICE_SCALE" | "CLOCK";

export interface OcrRequest {
  kind: OcrKind;
  requestId: string;
  /** Identidade da geometria no instante do recorte. */
  captureRevision: number;
  sessionId: string;
  /** Posição no vídeo, para reproduzir a decisão depois. */
  videoTimestamp: number | null;
  sentAt: number;
}

export type OcrOutcome =
  | "APLICADA"
  /** Chegou depois de a geometria mudar: não pode ser aplicada. */
  | "DESCARTADA_OBSOLETA"
  /** Chegou depois de outra resposta mais nova do mesmo tipo. */
  | "DESCARTADA_TARDIA"
  | "TIMEOUT"
  | "ERRO";

export interface OcrState {
  inFlight: Record<OcrKind, OcrRequest | null>;
  lastSuccessAt: Record<OcrKind, number | null>;
  lastLatencyMs: Record<OcrKind, number | null>;
  lastOutcome: Record<OcrKind, OcrOutcome | null>;
  /** Revisão da última resposta aceita, por tipo. */
  appliedRevision: Record<OcrKind, number | null>;
  failures: Record<OcrKind, number>;
}

export const EMPTY_OCR_STATE: OcrState = {
  inFlight: { PRICE_SCALE: null, CLOCK: null },
  lastSuccessAt: { PRICE_SCALE: null, CLOCK: null },
  lastLatencyMs: { PRICE_SCALE: null, CLOCK: null },
  lastOutcome: { PRICE_SCALE: null, CLOCK: null },
  appliedRevision: { PRICE_SCALE: null, CLOCK: null },
  failures: { PRICE_SCALE: 0, CLOCK: 0 },
};

export const OCR_CONFIG = {
  /**
   * Além disto a resposta não interessa mais. Generoso porque o Qwen leva de 6
   * a 12 segundos por leitura mesmo numa RTX 5090 — medido, não estimado.
   */
  timeoutMs: 45_000,
  /**
   * REVALIDAÇÃO ESPAÇADA, não timer curto.
   *
   * A escala de preço não muda com o tempo: muda quando a JANELA muda, e isso é
   * detectado pelo `geometryHash` sem gastar IA nenhuma. Este intervalo é
   * apenas rede de segurança para uma mudança que o hash não capture.
   *
   * Estava em 30s, o que teria consumido 6 a 12 segundos de GPU a cada meio
   * minuto para reconfirmar uma reta que não mudou.
   */
  priceRefreshMs: 10 * 60_000,
  /**
   * O relógio anda sozinho por interpolação entre leituras; a OCR só corrige a
   * deriva acumulada, não conta o tempo.
   */
  clockRefreshMs: 5 * 60_000,
  /** Recuo após falhas seguidas, para não martelar um endpoint morto. */
  backoffBaseMs: 5_000,
  maxBackoffMs: 120_000,
} as const;

/** Um pedido por tipo de cada vez: enfileirar recortes só produz respostas velhas. */
export function canDispatch(state: OcrState, kind: OcrKind, now: number): boolean {
  const current = state.inFlight[kind];
  if (current === null) return true;
  // Pedido preso além do timeout libera a vaga.
  return now - current.sentAt > OCR_CONFIG.timeoutMs;
}

export function backoffFor(failures: number): number {
  if (failures === 0) return 0;
  return Math.min(
    OCR_CONFIG.maxBackoffMs,
    OCR_CONFIG.backoffBaseMs * Math.pow(2, Math.min(failures - 1, 5)),
  );
}

/**
 * Está na hora de pedir de novo?
 *
 * `geometryChanged` tem prioridade sobre qualquer intervalo: zoom, arraste e
 * redimensionamento invalidam a escala na hora, e esperar o próximo ciclo
 * deixaria preços errados na tela nesse meio-tempo.
 */
export function shouldRequest(
  state: OcrState,
  kind: OcrKind,
  now: number,
  options: { geometryChanged: boolean; confidenceLow: boolean },
): boolean {
  if (!canDispatch(state, kind, now)) return false;

  const failures = state.failures[kind];
  const last = state.lastSuccessAt[kind];
  if (failures > 0 && last !== null && now - last < backoffFor(failures)) return false;

  if (last === null) return true;
  if (options.geometryChanged) return true;
  if (options.confidenceLow) return true;

  const interval = kind === "PRICE_SCALE" ? OCR_CONFIG.priceRefreshMs : OCR_CONFIG.clockRefreshMs;
  return now - last > interval;
}

export function dispatch(state: OcrState, request: OcrRequest): OcrState {
  return { ...state, inFlight: { ...state.inFlight, [request.kind]: request } };
}

/**
 * Decide o destino de uma resposta que voltou.
 *
 * Três formas de a resposta ser inútil, e todas precisam ser distinguidas no
 * diagnóstico: obsoleta (geometria mudou), tardia (outra já foi aplicada) e
 * expirada (demorou demais). Tratar as três como "erro" esconderia que o
 * problema pode ser cadência, não o modelo.
 */
export function resolve(
  state: OcrState,
  response: { kind: OcrKind; requestId: string; captureRevision: number; ok: boolean },
  currentRevision: number,
  now: number,
): { state: OcrState; outcome: OcrOutcome } {
  const { kind } = response;
  const pending = state.inFlight[kind];
  const latency = pending === null ? null : now - pending.sentAt;

  const finish = (
    outcome: OcrOutcome,
    success: boolean,
  ): { state: OcrState; outcome: OcrOutcome } => ({
    state: {
      ...state,
      inFlight: { ...state.inFlight, [kind]: null },
      lastOutcome: { ...state.lastOutcome, [kind]: outcome },
      lastLatencyMs: { ...state.lastLatencyMs, [kind]: latency },
      lastSuccessAt: success ? { ...state.lastSuccessAt, [kind]: now } : state.lastSuccessAt,
      appliedRevision: success
        ? { ...state.appliedRevision, [kind]: response.captureRevision }
        : state.appliedRevision,
      failures: success
        ? { ...state.failures, [kind]: 0 }
        : { ...state.failures, [kind]: state.failures[kind] + 1 },
    },
    outcome,
  });

  if (pending !== null && pending.requestId !== response.requestId) {
    // Outro pedido mais novo já ocupou a vaga: esta resposta perdeu a corrida.
    return { state, outcome: "DESCARTADA_TARDIA" };
  }
  if (!response.ok) return finish("ERRO", false);
  if (latency !== null && latency > OCR_CONFIG.timeoutMs) return finish("TIMEOUT", false);
  if (response.captureRevision !== currentRevision) {
    // A tela mudou enquanto o modelo pensava. Aplicar seria calibrar com uma
    // geometria que não existe mais.
    return finish("DESCARTADA_OBSOLETA", false);
  }
  return finish("APLICADA", true);
}

/** Pedido que nunca voltou libera a vaga por tempo. */
export function expire(state: OcrState, now: number): OcrState {
  let next = state;
  for (const kind of ["PRICE_SCALE", "CLOCK"] as OcrKind[]) {
    const pending = next.inFlight[kind];
    if (pending !== null && now - pending.sentAt > OCR_CONFIG.timeoutMs) {
      next = {
        ...next,
        inFlight: { ...next.inFlight, [kind]: null },
        lastOutcome: { ...next.lastOutcome, [kind]: "TIMEOUT" },
        failures: { ...next.failures, [kind]: next.failures[kind] + 1 },
      };
    }
  }
  return next;
}

/** Rótulo para o painel: ONLINE só com sucesso recente. */
export function ocrStatus(
  state: OcrState,
  kind: OcrKind,
  now: number,
): "ONLINE" | "LENTO" | "OFFLINE" {
  const last = state.lastSuccessAt[kind];
  if (last === null) return state.failures[kind] > 0 ? "OFFLINE" : "LENTO";
  const interval = kind === "PRICE_SCALE" ? OCR_CONFIG.priceRefreshMs : OCR_CONFIG.clockRefreshMs;
  // Sem sucesso por três ciclos, o serviço não está entregando.
  if (now - last > interval * 3) return "OFFLINE";
  return "ONLINE";
}
