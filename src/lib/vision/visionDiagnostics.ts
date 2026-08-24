/**
 * FONTE ÚNICA DE VERDADE do pipeline visual.
 *
 * O PROBLEMA QUE ISSO ENCERRA: existiam dois motores medindo o mesmo gráfico e
 * a UI lia o errado. O pipeline legado (`useLiveSession` → `CandleReconstructor`
 * → `live.diagnostics`) monta candles a partir de AMOSTRAS ao longo de minutos
 * reais; o novo (`useProfitVision` → `ChartTracker` → `extractCandlesFromPixels`)
 * reconstrói a série da geometria da tela e costura entre frames.
 *
 * Os dois discordam por construção, e a discordância aparecia como mentira no
 * painel: "esperar 14 minutos" enquanto 14 candles já estavam na tela,
 * CANDLES_PARSED=0 com candles visíveis, e PREGÃO com a data de hoje num replay
 * de março. Nenhum desses números era do motor que estava de fato rodando.
 *
 * Este módulo deriva TUDO do pipeline novo. Não lê `live.diagnostics`, não
 * conhece `CandleReconstructor`. Se um número aparece aqui, veio do que a
 * captura direta realmente observou.
 */

import type { AnalysisResult } from "@/lib/engines/types";
import type { TrackerState } from "./chartTracker";
import { MIN_CANDLES_FOR_ANALYSIS } from "./chartTracker";
import type { LivenessState } from "./streamLiveness";
import { isMoving, isUsable, streamLabel, visualLabel } from "./streamLiveness";
import type { VisualMarketState } from "./visualMarketState";
import type { PriceScaleState } from "./priceScaleTracker";
import { EMPTY_PRICE_SCALE } from "./priceScaleTracker";
import type { TimeAxis } from "./timeAxis";
import { EMPTY_TIME_AXIS } from "./timeAxis";
import type { T4Operation } from "@/lib/t4/preEntry";
import type { SetupTimeline } from "@/lib/t4/leadTime";
import { leadTimes } from "@/lib/t4/leadTime";
import {
  biasLabel,
  engineState,
  flowState,
  type T4EngineState,
  type T4FlowState,
} from "@/lib/t4/engineState";
import type { ScaleSessionState, ScaleCacheState } from "./priceScaleSession";
import { EMPTY_SCALE_SESSION } from "./priceScaleSession";
import type { ScaleRejectCode } from "./scaleReject";
import type { SourceMode } from "./sourceMode";
import type { LabelReading } from "./scaleLabels";
import {
  subsystemStatus,
  type CaptureStatus,
  type EngineStatus,
  type GpuStatus,
  type ScaleStatus,
} from "./subsystemStatus";

/** Identifica o motor, para o painel poder dizer de onde vêm os números. */
export const PIPELINE_NAME = "PROFIT VISION" as const;
export const SOURCE_OF_TRUTH = "ChartTracker" as const;

export interface VisionDiagnostics {
  pipeline: typeof PIPELINE_NAME;
  sourceOfTruth: typeof SOURCE_OF_TRUTH;

  captureActive: boolean;
  frameFlowing: boolean;
  pixelsChanging: boolean;
  fps: number;
  framesReceived: number;
  lastFrameAt: number | null;
  lastPixelChangeAt: number | null;
  staticForMs: number;
  captureLabel: string;
  chartLabel: string;

  candlesVisible: number;
  candlesParsed: number;
  closedCandlesAccepted: number;
  candlesSentToT4: number;
  bootstrapProgress: number;
  bootstrapRequired: number;
  rejectReason: string | null;

  /* ---- ANTIDUPLICAÇÃO ---- */
  /** Candles distintos na série — o número que a T4 de fato recebeu. */
  uniqueCandles: number;
  /** Frames recusados por tentarem reintroduzir história já conhecida. */
  duplicatesRejected: number;
  /** Frames idênticos ao anterior: idempotentes, e estado normal de gráfico parado. */
  identicalFrames: number;
  /** Candles fechados novos no último frame que mudou a série. */
  newClosedCandles: number;

  marketDate: string | null;
  marketDateTime: number | null;
  dateTrusted: boolean;
  timeTrusted: boolean;
  timeSource: string;

  priceScaleReady: boolean;
  priceScaleConfidence: number;
  anchors: number;
  scaleResidual: number | null;
  /** Qualidade do ajuste linear em vigor. 1.0000 é reta perfeita. */
  scaleR2: number | null;
  /**
   * POR QUE a escala não calibrou — código estável, nunca "CALIBRANDO" mudo.
   * Null quando está pronta.
   */
  scaleReject: ScaleRejectCode | null;
  scaleRejectDetail: string | null;
  scaleAttempts: number;
  /**
   * DE ONDE OS ROTULOS SE PERDERAM na ultima leitura.
   *
   * Sem isto, toda falha de escala vira "INSUFFICIENT_ANCHORS" e o operador nao
   * sabe se o modelo nao devolveu nada, devolveu com confianca baixa ou errou o
   * percentY — tres causas com tres consertos diferentes.
   */
  scaleLabels: string | null;
  /** Identidade da janela. Igual = escala reaproveitada, zero GPU. */
  geometryHash: string | null;
  cache: ScaleCacheState;
  ocrLatencyMs: number | null;
  ocrModel: string | null;
  /**
   * ONLINE só com calibração em vigor; OFFLINE quando o motivo é o serviço.
   * CALIBRANDO é estado legítimo — desde que acompanhado de `scaleReject`.
   */
  ocrState: "ONLINE" | "CALIBRANDO" | "OFFLINE";
  gpuStatus: GpuStatus;
  /** Estados INDEPENDENTES por subsistema. Um nao contamina o rotulo do outro. */
  captureStatus: CaptureStatus;
  scaleStatus: ScaleStatus;
  engineStatus: EngineStatus;
  /** Rotulos da ultima leitura da escala, com o motivo de cada descarte. */
  scaleReadings: LabelReading[];

  regime: string;
  pivots: number;
  visualUpdates: number;
  structure: string;
  liquidity: number;

  /** LIVE ou REPLAY: decide se o relógio do sistema pode carimbar mercado. */
  sourceMode: SourceMode;

  /**
   * O MOTOR está rodando? Pergunta diferente de "o setup está maduro?".
   * SETUP_MATURITY em 0% com ENGINE=ANALISANDO é um pregão sem oportunidade,
   * não um software parado.
   */
  t4Engine: T4EngineState;
  t4Flow: T4FlowState;
  /** Direção observada ANTES de haver sinal. Nunca é ordem. */
  bias: string;
  direction: string | null;
  t4State: string;
  t4Percent: number;
  candidateTime: number | null;
  preEntryTime: number | null;
  confirmationTime: number | null;
  candidateLeadTimeMs: number | null;
  preEntryLeadTimeMs: number | null;
  blockReason: string | null;

  /** Problema mais importante agora, em uma frase, ou null quando tudo anda. */
  headline: string | null;
}

export interface DiagnosticsInput {
  requested: boolean;
  liveness: LivenessState;
  tracker: TrackerState;
  visual: VisualMarketState;
  operation: T4Operation;
  analysis: AnalysisResult | null;
  priceScale?: PriceScaleState;
  timeAxis?: TimeAxis;
  timeline?: SetupTimeline | null;
  /** Ciclo de vida da escala: cache, tentativas e MOTIVO da recusa. */
  scale?: ScaleSessionState;
  sourceMode?: SourceMode;
  /** Alcancabilidade do servico de visao, medida por HTTP. Null = nao perguntado. */
  gpuReachable?: boolean | null;
}

/**
 * A frase que o operador lê primeiro.
 *
 * Ordem deliberada: o que impede a leitura vem antes do que impede a análise, e
 * este vem antes do que impede o preço. Anunciar "preço não confiável" enquanto
 * a captura está parada mandaria o operador consertar a coisa errada.
 */
function headlineFor(input: DiagnosticsInput, bootstrapProgress: number): string | null {
  const { liveness, tracker, requested } = input;
  if (!requested) return null;
  if (!isUsable(liveness)) return "A captura foi encerrada. Clique em INICIAR LEITURA DO PROFIT.";
  if (tracker.candlesVisible === 0) {
    return "Nenhuma coluna de candle encontrada — confira zoom, tema e se o gráfico está visível.";
  }
  if (tracker.candlesParsed === 0 && tracker.rejectReason !== null) {
    return `Candles visíveis, nenhum aproveitado: ${tracker.rejectReason}`;
  }
  if (bootstrapProgress < MIN_CANDLES_FOR_ANALYSIS) {
    return `Coletando histórico ${bootstrapProgress}/${MIN_CANDLES_FOR_ANALYSIS} — a T4 fala quando houver contexto.`;
  }
  // O preço vem por último de propósito: a leitura já anda sem ele, e anunciar
  // escala antes de captura mandaria consertar a coisa errada. Mas anunciar,
  // sim — com o motivo, nunca "CALIBRANDO" e ponto.
  const reject = input.scale?.reject ?? null;
  if (reject !== null && !(input.scale?.scale.priceScaleReady ?? false)) {
    return `Estrutura legível; preço ainda não. Escala recusada por ${reject.code}: ${reject.detail}`;
  }
  return null;
}

export function buildVisionDiagnostics(input: DiagnosticsInput): VisionDiagnostics {
  const { liveness, tracker, visual, operation, analysis } = input;
  const session = input.scale ?? EMPTY_SCALE_SESSION;
  // A escala pode chegar por duas portas: o ciclo completo (`scale`) ou um
  // estado avulso em teste. O ciclo manda quando existe.
  const priceScale = input.scale ? input.scale.scale : (input.priceScale ?? EMPTY_PRICE_SCALE);
  const axis = input.timeAxis ?? EMPTY_TIME_AXIS;
  const lead = input.timeline ? leadTimes(input.timeline) : null;

  const bootstrapProgress = Math.min(tracker.closedCandlesAccepted, MIN_CANDLES_FOR_ANALYSIS);

  const engine = engineState({
    requested: input.requested,
    reading: isUsable(liveness),
    closedCandles: tracker.closedCandlesAccepted,
    minimumCandles: MIN_CANDLES_FOR_ANALYSIS,
  });

  /*
   * OS QUATRO ESTADOS SAO INDEPENDENTES.
   *
   * O gpuStatus era DERIVADO do erro de escala: um eixo ilegivel marcava a GPU
   * como OFFLINE, e o operador ia reiniciar um tunel que funcionava. Agora ele
   * vem do health HTTP do servico, e de mais nada.
   */
  const rejectCode = session.reject?.code ?? null;
  const subsystems = subsystemStatus({
    requested: input.requested,
    gpuReachable: input.gpuReachable ?? null,
    captureUsable: isUsable(liveness),
    scaleReady: priceScale.priceScaleReady,
    scaleAttempts: session.attempts,
    scaleConsecutiveFailures: session.consecutiveFailures,
    engineAnalyzing: engine === "ANALISANDO",
  });
  const gpuStatus = subsystems.gpu;

  return {
    pipeline: PIPELINE_NAME,
    sourceOfTruth: SOURCE_OF_TRUTH,

    captureActive: input.requested && isUsable(liveness),
    // Frame chegando e pixel mudando sao coisas diferentes: grafico parado com
    // captura viva e estado valido, nao falha.
    frameFlowing: liveness.lastFrameAt !== null,
    pixelsChanging: isMoving(liveness),
    fps: liveness.fps,
    framesReceived: liveness.framesReceived,
    lastFrameAt: liveness.lastFrameAt,
    lastPixelChangeAt: liveness.lastChangeAt,
    staticForMs: liveness.staticForMs,
    captureLabel: streamLabel(liveness),
    chartLabel: visualLabel(liveness),

    candlesVisible: tracker.candlesVisible,
    candlesParsed: tracker.candlesParsed,
    closedCandlesAccepted: tracker.closedCandlesAccepted,
    // O que de fato chegou ao motor é a janela entregue, não uma contagem à parte.
    candlesSentToT4: analysis === null ? 0 : tracker.closedCandlesAccepted,
    bootstrapProgress,
    bootstrapRequired: tracker.bootstrapRequired,
    rejectReason: tracker.rejectReason,

    uniqueCandles: tracker.uniqueCandles,
    duplicatesRejected: tracker.duplicatesRejected,
    identicalFrames: tracker.identicalFrames,
    newClosedCandles: tracker.newClosedCandles,

    // PREGÃO vem do gráfico. Sem leitura confiável é null, e o painel escreve
    // NÃO CONFIÁVEL — nunca a data de hoje.
    marketDate: tracker.marketDate,
    marketDateTime: axis.trusted ? axis.originT : null,
    dateTrusted: tracker.marketDate !== null,
    timeTrusted: axis.trusted,
    timeSource: axis.trusted ? "eixo do gráfico" : "não lido",

    priceScaleReady: priceScale.priceScaleReady,
    priceScaleConfidence: priceScale.priceConfidence,
    anchors: priceScale.anchorCount,
    scaleResidual: priceScale.scaleResidual,
    scaleR2: priceScale.calibration.usable ? priceScale.calibration.r2 : null,
    // Sem escala E sem motivo é o estado que estamos eliminando: se não
    // calibrou, existe um código dizendo por quê.
    scaleReject: rejectCode,
    scaleRejectDetail: session.reject?.detail ?? null,
    scaleAttempts: session.attempts,
    scaleLabels:
      session.lastAudit === null
        ? null
        : `${session.lastAudit.kept}/${session.lastAudit.received} aproveitados · ` +
          `${session.lastAudit.invalidPercent} fora da régua · ` +
          `${session.lastAudit.lowConfidence} confiança baixa · ` +
          `${session.lastAudit.nonMonotonic} não monotônicos`,
    geometryHash: session.geometryHash,
    cache: session.cache,
    ocrLatencyMs: session.lastLatencyMs,
    ocrModel: session.model,
    ocrState: priceScale.priceScaleReady
      ? "ONLINE"
      : gpuStatus === "OFFLINE"
        ? "OFFLINE"
        : "CALIBRANDO",
    gpuStatus,
    captureStatus: subsystems.capture,
    scaleStatus: subsystems.scale,
    engineStatus: subsystems.engine,
    scaleReadings: session.lastLabels,

    regime: visual.regime,
    pivots: visual.pivots.length,
    visualUpdates: visual.updates,
    structure: analysis?.evidences.find((item) => item.group === "estrutura")?.state ?? "não lida",
    liquidity: analysis?.liquidity.levels.length ?? 0,

    sourceMode: input.sourceMode ?? "LIVE",

    t4Engine: engine,
    t4Flow: flowState(operation.stage, operation.maturity),
    bias: biasLabel(operation.direction),
    direction: operation.direction,
    t4State: operation.stage,
    t4Percent: operation.maturity,
    candidateTime: input.timeline?.candidateAt ?? null,
    preEntryTime: input.timeline?.preEntryAt ?? null,
    confirmationTime: input.timeline?.confirmedAt ?? null,
    candidateLeadTimeMs: lead?.candidateLeadTimeMs ?? null,
    preEntryLeadTimeMs: lead?.preEntryLeadTimeMs ?? null,
    blockReason: operation.blockReason,

    headline: headlineFor(input, bootstrapProgress),
  };
}

/**
 * Prova de que nenhum candle legado entra na cadeia.
 *
 * Serve de asserção viva: se algum dia alguém religar o `CandleReconstructor`
 * ao caminho visual, a contagem do painel deixa de bater com a do tracker e
 * este teste falha em vez de a UI mentir em silêncio.
 */
export function candlesComeFromTracker(
  diagnostics: VisionDiagnostics,
  tracker: TrackerState,
): boolean {
  return (
    diagnostics.candlesVisible === tracker.candlesVisible &&
    diagnostics.candlesParsed === tracker.candlesParsed &&
    diagnostics.closedCandlesAccepted === tracker.closedCandlesAccepted &&
    diagnostics.marketDate === tracker.marketDate
  );
}
