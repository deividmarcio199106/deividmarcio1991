import type { MarketClockSource } from "@/lib/vision/marketClock";

/**
 * DIAGNÓSTICO REAL DO PIPELINE (comando §5).
 *
 * Cada campo reflete o estado VERDADEIRO de uma etapa:
 * FRAME → PROFIT → CHART_CLOCK → CANDLES → CONTEXTO → T4.
 * Nada aqui é derivado de timer ou de score inventado. Se o gráfico está
 * visível mas nenhum candle foi parseado, o erro específico aparece em
 * `parseError` — nunca um genérico "AGUARDANDO GRÁFICO".
 */
export interface PipelineDiagnostics {
  CAPTURE_ACTIVE: boolean;
  PROFIT_DETECTED: boolean;
  GRAPH_DETECTED: boolean;
  PRICE_AXIS: boolean;
  TIME_AXIS: boolean;
  CHART_CLOCK: "VALID" | "FALLBACK_REALTIME" | "UNAVAILABLE";
  chartClockSource: MarketClockSource;
  chartClockReason: string | null;
  CANDLES_VISIBLE: number;
  CANDLES_PARSED: number;
  CANDLES_SENT_TO_T4: number;
  LAST_FRAME: number | null;
  LAST_CANDLE: number | null;
  /** Latência captura→leitura do último frame processado (ms). */
  LATENCY: number | null;
  T4_STATE: string;
  BLOCK_REASON: string | null;
  OLLAMA_STATUS: string;
  /** Erro específico quando gráfico visível e candles=0. */
  parseError: string | null;
}

export const EMPTY_DIAGNOSTICS: PipelineDiagnostics = {
  CAPTURE_ACTIVE: false,
  PROFIT_DETECTED: false,
  GRAPH_DETECTED: false,
  PRICE_AXIS: false,
  TIME_AXIS: false,
  CHART_CLOCK: "UNAVAILABLE",
  chartClockSource: "REALTIME_FALLBACK",
  chartClockReason: "captura não iniciada",
  CANDLES_VISIBLE: 0,
  CANDLES_PARSED: 0,
  CANDLES_SENT_TO_T4: 0,
  LAST_FRAME: null,
  LAST_CANDLE: null,
  LATENCY: null,
  T4_STATE: "IDLE",
  BLOCK_REASON: null,
  OLLAMA_STATUS: "DESCONHECIDO",
  parseError: null,
};

/** Erro específico exigido pelo comando quando gráfico visível e candles=0. */
export function candleParseError(diag: {
  GRAPH_DETECTED: boolean;
  CANDLES_VISIBLE: number;
  CANDLES_PARSED: number;
}): string | null {
  if (!diag.GRAPH_DETECTED) return null;
  if (diag.CANDLES_VISIBLE === 0) {
    return "GRÁFICO DETECTADO, MAS NENHUMA COLUNA DE CANDLE COLORIDA FOI ENCONTRADA — verifique zoom/cores do Profit.";
  }
  if (diag.CANDLES_PARSED === 0) {
    return "CANDLES VISÍVEIS, MAS NENHUM FOI PARSEADO PARA A SÉRIE — reconstrução rejeitando amostras (veja o motivo da última rejeição).";
  }
  return null;
}

/* ------------------------------------------------------------------------ *
 * LINHA DE STATUS ÚNICA — nunca só "aguardando"
 * ------------------------------------------------------------------------ */

/**
 * Tudo que a linha de status precisa dizer, sempre. O contrato é: cada campo
 * aparece MESMO quando é null — "setup=—" é informação ("não há setup"),
 * omitir o campo é ruído ("esqueceram de mostrar?"). E quando algo está
 * bloqueado, o CÓDIGO aparece ao lado do motivo: o operador filtra log por
 * código, e lê o motivo para agir.
 */
export interface StatusLineInput {
  setupId: string | null;
  /** Início do candle corrente (ms) — o mesmo `candleTime` da captura. */
  candleTime: number | null;
  /** Último candle COMPROVADAMENTE fechado (ms). */
  lastClosed: number | null;
  /** Estado da máquina de setup (FORMING/ARMED/CONFIRMED/…). */
  estado: string;
  /** Gate em avaliação ou que reprovou. */
  gate: string | null;
  /** Código estável do bloqueio (blockCodes.ts), quando houver. */
  blockCode: string | null;
  reason: string | null;
  rr: number | null;
  busy: boolean;
  pending: boolean;
}

const hhmmss = (ms: number | null) =>
  ms === null ? "—" : new Date(ms).toISOString().slice(11, 19);

/**
 * A linha que vai para tela e log. Determinística: mesma entrada, mesma
 * string — dá para testar com igualdade, e dá para grepar em produção.
 */
export function statusLine(s: StatusLineInput): string {
  return [
    `setup=${s.setupId ?? "—"}`,
    `candle=${hhmmss(s.candleTime)}`,
    `fechado=${hhmmss(s.lastClosed)}`,
    `estado=${s.estado}`,
    `gate=${s.gate ?? "—"}`,
    `bloqueio=${s.blockCode ?? "—"}`,
    `motivo=${s.reason ?? "—"}`,
    `rr=${s.rr === null ? "—" : s.rr.toFixed(2)}`,
    `busy=${s.busy ? "S" : "N"}`,
    `pendente=${s.pending ? "S" : "N"}`,
  ].join(" | ");
}
