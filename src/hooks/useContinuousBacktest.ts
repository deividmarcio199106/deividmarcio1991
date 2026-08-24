import { carregarProvider, PROVIDER_DESCONHECIDO } from "@/lib/ai/providerCache";
import { buildReadingState } from "@/lib/t4/readingState";
import { evaluateT4Gates } from "@/lib/t4/gates";
import { evaluateOperation, type T4Operation } from "@/lib/t4/preEntry";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";

import { calibratePriceScale } from "@/lib/calibration.functions";
import {
  capturePriceScaleImage,
  captureTimeAxisImage,
  extractVisibleCandles,
  type FrameRead,
} from "@/lib/capture/frameProcessor";
import { readChartClock } from "@/lib/chartClock.functions";
import { getAssistantProviders } from "@/lib/analyst.functions";
import { analyze } from "@/lib/engines/analysisPipeline";
import { createBacktestTrade, type BacktestTrade } from "@/lib/engines/backtestEngine";
import { dnaFromAnalysis, dnaTradeFields } from "@/lib/engines/dnaExtractor";
import {
  decide,
  EntryStateMachine,
  type DecisionObject,
} from "@/lib/engines/backtestDecisionEngine";
import { EventStore } from "@/lib/engines/eventStore";
import { evaluateEvidence } from "@/lib/engines/evidenceValidation";
import { filterEvidenceTrades } from "@/lib/engines/evidenceFilter";
import { resolveInstrument } from "@/lib/engines/instruments";
import { LiveOutcomeTracker, type LiveOperationResult } from "@/lib/engines/liveOutcome";
import { READING_GATES, riskParamsForAsset, STRATEGY_VERSION } from "@/lib/engines/strategy";
import type { AnalysisResult, Candle, ChatEntry, ReadingState } from "@/lib/engines/types";
import { CandleStitcher } from "@/lib/replay/candleStitcher";
import { chronologicalFrontiers } from "@/lib/replay/chronologicalFrontier";
import { store, type MarketEventRecord } from "@/lib/storage";
import { reportError } from "@/lib/errors/errorReporter";
import {
  EMPTY_DIAGNOSTICS,
  candleParseError,
  type PipelineDiagnostics,
} from "@/lib/t4/diagnostics";
import { createSignalSnapshot, type TradeSignalSnapshot } from "@/lib/t4/signalSnapshot";
import { playConfirmationOnce } from "@/lib/t4/signalSound";
import { ClockStabilizer } from "@/lib/vision/clockStabilizer";
import {
  assetScaleIssue,
  calibrateFromAnchors,
  calibrationDrift,
  emptyCalibration,
  geometricCalibration,
  normalizeScaleAnchorsForAsset,
  type Calibration,
} from "@/lib/vision/priceScale";
import {
  CalibrationScheduler,
  calibrationSummary,
  type CalibrationSchedulerState,
} from "@/lib/vision/calibrationScheduler";

import { useContinuousChartCapture } from "./useContinuousChartCapture";

const MINUTE_MS = 60_000;
// A captura roda a ~2 fps. Com ROI inferior pequena, ler o relógio a cada
// ~2 s permite confirmar 3 leituras em ~6 s — rápido o bastante para o usuário
// arrastar dias no Profit sem manter o pregão anterior por dezenas de segundos.
const CLOCK_EVERY_FRAMES = 4;
const ANALYSIS_WINDOW = 160;
// O Profit pode autoajustar a escala ao navegar pelo histórico sem alterar a
// resolução da janela. Revalidamos a régua periodicamente para não carregar
// uma conversão pixel→preço antiga para outro trecho/pregão.
const CALIBRATION_REFRESH_MS = 8_000;

export type BacktestPhase = "idle" | "observando" | "pausado" | "encerrado";

export interface BacktestTimelineEntry {
  id: string;
  t: number;
  marketTime: string | null;
  label: string;
  detail: string | null;
  tone: "info" | "warn" | "alert" | "bull" | "bear";
}

export interface BacktestCounters {
  sessionsAnalyzed: number;
  analyzedMinutes: number;
  framesCaptured: number;
  framesAnalyzed: number;
  framesIgnored: number;
  events: number;
  setups: number;
  trades: number;
  segments: number;
}

const EMPTY_COUNTERS: BacktestCounters = {
  sessionsAnalyzed: 0,
  analyzedMinutes: 0,
  framesCaptured: 0,
  framesAnalyzed: 0,
  framesIgnored: 0,
  events: 0,
  setups: 0,
  trades: 0,
  segments: 0,
};

/**
 * A escala NÃO entra em `issues`: gráfico visível = leitura ativa. Ela vive em
 * `priceScaleReady`, que só governa a publicação de preços exatos.
 */
function reading(calibration: Calibration, quality: number, closed: number): ReadingState {
  /*
   * MESMO construtor do ao vivo.
   *
   * Este caminho exigia `READING_GATES.minClosedCandles` = 14 e o ao vivo exigia
   * 24. A MESMA série de 18 candles produzia leitura suficiente aqui e
   * insuficiente lá — e `reading.sufficient` é portão dentro de `analyze()`.
   * Não é divergência de exibição: é divergência de GATE, e ela decide se a
   * técnica chega a rodar. Sozinha, impedia Replay = Live.
   *
   * Alinhado para o mínimo MAIOR: o backtest mais permissivo que a produção
   * construiria evidência histórica sobre leituras que o ao vivo nunca faria.
   */
  return buildReadingState({
    closedCandles: closed,
    quality,
    priceScaleReady: calibration.usable,
    calibrationConfidence: calibration.confidence,
  });
}

/**
 * BACKTEST POR OBSERVAÇÃO CONTÍNUA DA MESMA TELA COMPARTILHADA.
 *
 * Usa exatamente a engine visual da operação ao vivo (ContinuousChartCapture):
 * o mesmo seletor de janela, o mesmo <video> exibido no analisador e o mesmo
 * loop de frames. A diferença é apenas o USO dos dados — aqui o gráfico é
 * histórico e o usuário navega nele, então cada frame novo revela candles que
 * são costurados numa sequência cronológica, decididos em T (sem ver o futuro)
 * e verificados somente com o que aparecer depois de T. Tudo é persistido
 * progressivamente no banco; nada de vídeo gravado nem upload.
 */
export function useContinuousBacktest(asset: string) {
  const calibrateScale = useServerFn(calibratePriceScale);
  const readClock = useServerFn(readChartClock);
  const loadProviders = useServerFn(getAssistantProviders);

  const phaseRef = useRef<BacktestPhase>("idle");
  const stitcherRef = useRef(new CandleStitcher());
  const sequenceRef = useRef<Candle[]>([]);
  const segmentBaseRef = useRef(Date.now());
  const segmentIndexRef = useRef(0);
  const eventStoreRef = useRef<EventStore | null>(null);
  const entryMachineRef = useRef(new EntryStateMachine());
  /** Estagio T4 anterior — o backtest agora percorre o MESMO fluxo do ao vivo. */
  const previousOperationRef = useRef<T4Operation | null>(null);
  const schedulerRef = useRef(new CalibrationScheduler());
  const calibrationLogRef = useRef<string | null>(null);
  const trackerRef = useRef<LiveOutcomeTracker | null>(null);
  const frozenAnalysisRef = useRef<AnalysisResult | null>(null);
  /** DNA classificado no ARMAMENTO, com a janela daquele instante — a prova
   * de que a nota não conheceu o resultado é ser congelada junto da análise. */
  const frozenDnaRef = useRef<Partial<BacktestTrade> | null>(null);
  /** Detecções anteriores da sessão, para o ordinal (1ª/2ª/3ª T4 do movimento). */
  const priorDnaRef = useRef<{ direction: string; detectedAt: number }[]>([]);
  const calibrationRef = useRef<Calibration>(emptyCalibration());
  const calibratingRef = useRef(false);
  const lastCalibrationTryRef = useRef(0);
  const lastCalibrationRefreshRef = useRef(0);
  const clockRef = useRef(new ClockStabilizer());
  const clockBusyRef = useRef(false);
  const framesSinceClockRef = useRef(0);
  const qualitySumRef = useRef(0);
  const qualityCountRef = useRef(0);
  const countersRef = useRef<BacktestCounters>({ ...EMPTY_COUNTERS });
  const tradesRef = useRef<BacktestTrade[]>([]);
  const tradingSessionIdRef = useRef<string | null>(null);
  const tradingDateRef = useRef<string | null>(null);
  const marketTimeRef = useRef<string | null>(null);
  const segmentIdRef = useRef<string | null>(null);
  const discontinuitiesRef = useRef<string[]>([]);
  /*
   * ID DE SESSÃO DETERMINÍSTICO (auditoria sênior, B4). Era `obs_${Date.now()}`
   * — e o relógio contaminava TODO id derivado: sessão de pregão
   * (`_day_{data}`), DNA, eventos, segmentos, sourceCaptureId. Reobservar o
   * mesmo gráfico gerava ids novos e o mesmo evento entrava de novo no banco;
   * N crescia sem trade novo existir. O ancor de conteúdo disponível é o
   * ATIVO: com ele, `{sessionId}_day_{data}` identifica o MESMO pregão em
   * qualquer reexecução, e o DNA `dna_{sessionId}_{t}_{direcao}` identifica a
   * MESMA detecção. Duas observações do mesmo pregão convergem para as mesmas
   * linhas (os upserts por id fazem o resto). O custo declarado: segmentos de
   * data DESCONHECIDA do mesmo ativo colidem entre gravações — dado degradado,
   * preferível a N inflado.
   */
  const sessionIdRef = useRef<string>(`obs_${asset}`);
  const startedAtRef = useRef<number>(Date.now());
  const sessionDatesRef = useRef<Set<string>>(new Set());
  const techniqueRef = useRef<string>(STRATEGY_VERSION);
  const lastStatusRef = useRef<string | null>(null);

  const lastReadRef = useRef<FrameRead | null>(null);
  const lastClockAtRef = useRef(0);
  const snapshotRef = useRef<TradeSignalSnapshot | null>(null);
  const analysisStateRef = useRef<AnalysisResult | null>(null);

  const [phase, setPhase] = useState<BacktestPhase>("idle");
  const [signalSnapshot, setSignalSnapshot] = useState<TradeSignalSnapshot | null>(null);
  const [diagnostics, setDiagnostics] = useState<PipelineDiagnostics>(EMPTY_DIAGNOSTICS);
  const [calibration, setCalibration] = useState<Calibration>(emptyCalibration());
  const [calibrationError, setCalibrationError] = useState<string | null>(null);
  const [calibrationState, setCalibrationState] = useState<CalibrationSchedulerState>(() =>
    schedulerRef.current.state(),
  );
  const [counters, setCounters] = useState<BacktestCounters>({ ...EMPTY_COUNTERS });
  const [candles, setCandles] = useState<Candle[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [decision, setDecision] = useState<DecisionObject | null>(null);
  const [entryState, setEntryState] = useState("SCANNING");
  const [operation, setOperation] = useState<LiveOperationResult | null>(null);
  const [timeline, setTimeline] = useState<BacktestTimelineEntry[]>([]);
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [tradingDate, setTradingDate] = useState<string | null>(null);
  const [marketTime, setMarketTime] = useState<string | null>(null);
  const [segmentLabel, setSegmentLabel] = useState(0);
  const [storageReady, setStorageReady] = useState(store.isHydrated());
  const [aiProvider, setAIProvider] = useState({ configured: false, model: "", provider: "" });

  const appendLog = useCallback((text: string, tone: ChatEntry["tone"] = "info") => {
    setChat((previous) => [...previous, { t: Date.now(), text, tone }].slice(-120));
  }, []);

  const pushTimeline = useCallback(
    (label: string, detail: string | null, tone: BacktestTimelineEntry["tone"] = "info") => {
      const entry: BacktestTimelineEntry = {
        id: `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        t: Date.now(),
        marketTime: marketTimeRef.current,
        label,
        detail,
        tone,
      };
      setTimeline((previous) => [...previous, entry].slice(-200));
    },
    [],
  );

  const bumpCounters = useCallback((patch: Partial<BacktestCounters>) => {
    countersRef.current = { ...countersRef.current, ...patch };
    setCounters({ ...countersRef.current });
  }, []);

  /** Diagnóstico real do pipeline do replay — mesma semântica da operação ao vivo. */
  const refreshDiagnostics = useCallback(() => {
    const read = lastReadRef.current;
    const observing = phaseRef.current === "observando";
    const captureActive = observing || phaseRef.current === "pausado";
    const profitDetected = read !== null && read.bullMass + read.bearMass > 0.0004;
    const graphDetected = profitDetected && (read?.candleColumns ?? 0) > 0;
    const parsed = sequenceRef.current.length;
    const clockFresh = Date.now() - lastClockAtRef.current < 3 * 60_000;
    const analysisNow = analysisStateRef.current;
    setDiagnostics({
      CAPTURE_ACTIVE: captureActive,
      PROFIT_DETECTED: profitDetected,
      GRAPH_DETECTED: graphDetected,
      PRICE_AXIS: calibrationRef.current.usable,
      TIME_AXIS: clockFresh,
      CHART_CLOCK:
        marketTimeRef.current && clockFresh
          ? "VALID"
          : captureActive
            ? "FALLBACK_REALTIME"
            : "UNAVAILABLE",
      chartClockSource: marketTimeRef.current && clockFresh ? "CHART_CLOCK" : "REALTIME_FALLBACK",
      chartClockReason:
        marketTimeRef.current && clockFresh
          ? null
          : "OCR do eixo de tempo ainda não confirmou o horário do gráfico.",
      CANDLES_VISIBLE: read?.candleColumns ?? 0,
      CANDLES_PARSED: parsed,
      CANDLES_SENT_TO_T4: analysisNow ? Math.min(parsed, ANALYSIS_WINDOW) : 0,
      LAST_FRAME: read?.t ?? null,
      LAST_CANDLE: parsed ? sequenceRef.current[parsed - 1]!.t : null,
      LATENCY: read ? Math.max(0, Date.now() - read.t) : null,
      T4_STATE: snapshotRef.current
        ? "CONFIRMADO"
        : analysisNow
          ? analysisNow.t4.setup === "NONE"
            ? "AGUARDANDO SETUP"
            : `${analysisNow.t4.setup} · ${analysisNow.t4.quality}`
          : observing
            ? "LENDO CONTEXTO"
            : "IDLE",
      BLOCK_REASON: analysisNow?.blockers[0] ?? null,
      OLLAMA_STATUS: aiProvider.configured ? aiProvider.model || "CONFIGURADO" : "NÃO CONFIGURADO",
      parseError: observing
        ? candleParseError({
            GRAPH_DETECTED: graphDetected,
            CANDLES_VISIBLE: read?.candleColumns ?? 0,
            CANDLES_PARSED: parsed,
          })
        : null,
    });
  }, [aiProvider.configured, aiProvider.model]);

  useEffect(() => {
    let active = true;
    void store
      .hydrate()
      .then(() => active && setStorageReady(true))
      .catch(() => active && setStorageReady(false));
    // Compartilhado com a leitura ao vivo: mesma pergunta, uma requisição.
    void carregarProvider(() => loadProviders({}))
      .then((provider) => active && setAIProvider(provider))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [loadProviders]);

  /** Persiste o estado atual da sessão de observação (progressivo, §banco). */
  const persistSession = useCallback(
    (status: string, endedAt: number | null) => {
      const now = Date.now();
      store.saveReplaySession({
        sessionId: sessionIdRef.current,
        createdAt: startedAtRef.current,
        symbol: asset,
        timeframe: "1m",
        durationMs: (endedAt ?? now) - startedAtRef.current,
        frameCount: countersRef.current.framesCaptured,
        usefulFrames: countersRef.current.framesAnalyzed,
        dedupedFrames: countersRef.current.framesIgnored,
        calibrationVersions: 1,
        strategyVersion: techniqueRef.current,
        status,
        discontinuities: discontinuitiesRef.current,
        tradeCount: tradesRef.current.length,
        candleCount: countersRef.current.analyzedMinutes,
      });
      if (tradingSessionIdRef.current) {
        store.upsertTradingSession({
          id: tradingSessionIdRef.current,
          source: "VIDEO_REPLAY",
          symbol: asset,
          tradingDate: tradingDateRef.current,
          timeframe: "1m",
          techniqueVersion: techniqueRef.current,
          startedAt: startedAtRef.current,
          endedAt,
          segmentCount: segmentIndexRef.current + 1,
          eventCount: countersRef.current.events,
          tradeCount: tradesRef.current.filter(
            (trade) => trade.tradingSessionId === tradingSessionIdRef.current,
          ).length,
          createdAt: startedAtRef.current,
        });
      }
    },
    [asset],
  );

  const persistTrades = useCallback(() => {
    store.upsertBacktest({
      /*
       * ID POR PREGÃO, não por sessão de app (B4): `upsertBacktest` APAGA e
       * regrava os trades do id que recebe. Com o sessionId agora
       * determinístico por ativo, um id sem a data apagaria os pregões
       * anteriores a cada novo dia observado. Com a data no id, reobservar o
       * MESMO pregão converge para as mesmas linhas (ids de trade
       * determinísticos + índice único de evento) — e nunca toca outro dia.
       */
      id: `obs_${sessionIdRef.current}_${tradingDateRef.current ?? "sem_data"}`,
      strategyVersion: techniqueRef.current,
      asset,
      timeframe: "1m",
      createdAt: startedAtRef.current,
      sourceCaptureId: `tela_compartilhada_${sessionIdRef.current}`,
      origin: "VIDEO_REPLAY",
      // Só os trades DESTE pregão: mandar os de outro dia para o container
      // atual os "reclamaria" (ON CONFLICT id) para fora do container certo.
      trades: tradesRef.current.filter(
        (trade) => (trade.tradingDate ?? null) === (tradingDateRef.current ?? null),
      ),
    });
  }, [asset]);

  const persistEvent = useCallback((event: MarketEventRecord) => {
    store.saveMarketEvent({ ...event, id: event.eventId });
    countersRef.current.events++;
  }, []);

  /** Abre um pregão (sessão de mercado) confirmado pelo OCR da data. */
  const openTradingSession = useCallback(
    (date: string | null, reason: string) => {
      const now = Date.now();
      const previous = tradingSessionIdRef.current;
      if (previous) {
        persistEvent({
          eventId: `${previous}_close_${now}`,
          sessionId: previous,
          segmentId: segmentIdRef.current,
          timestamp: now,
          marketTime: marketTimeRef.current,
          type: "SESSION_CLOSE",
          source: "VIDEO_REPLAY",
          techniqueVersion: techniqueRef.current,
          evidence: reason,
        });
        persistSession("IN_PROGRESS", null);
        pushTimeline("PREGÃO ENCERRADO", tradingDateRef.current, "warn");
      }
      const id = date
        ? `${sessionIdRef.current}_day_${date}`
        : `${sessionIdRef.current}_unknown_${segmentIndexRef.current}`;
      tradingSessionIdRef.current = id;
      tradingDateRef.current = date;
      setTradingDate(date);
      if (date) sessionDatesRef.current.add(date);
      bumpCounters({ sessionsAnalyzed: sessionDatesRef.current.size });
      persistEvent({
        eventId: `${id}_open_${now}`,
        sessionId: id,
        segmentId: segmentIdRef.current,
        timestamp: now,
        marketTime: marketTimeRef.current,
        type: "SESSION_OPEN",
        source: "VIDEO_REPLAY",
        techniqueVersion: techniqueRef.current,
        evidence: reason,
      });
      persistSession("IN_PROGRESS", null);
      pushTimeline("PREGÃO ABERTO", date ?? "data ainda não confirmada pelo OCR", "info");
    },
    [bumpCounters, persistEvent, persistSession, pushTimeline],
  );

  /** Novo segmento — o usuário arrastou/pulou e a história não é contínua. */
  const openSegment = useCallback(
    (reason: string, resetStitcher = false) => {
      const now = Date.now();
      if (segmentIdRef.current) {
        persistEvent({
          eventId: `${segmentIdRef.current}_close_${now}`,
          sessionId: tradingSessionIdRef.current,
          segmentId: segmentIdRef.current,
          timestamp: now,
          type: "SEGMENT_CLOSE",
          source: "VIDEO_REPLAY",
          techniqueVersion: techniqueRef.current,
          evidence: reason,
        });
        store.saveSegment({
          id: segmentIdRef.current,
          sessionId: tradingSessionIdRef.current,
          startedAt: segmentBaseRef.current,
          endedAt: now,
          reason,
          tradingDate: tradingDateRef.current,
          createdAt: now,
        });
      }
      segmentIndexRef.current++;
      segmentBaseRef.current = Date.now();
      segmentIdRef.current = `${sessionIdRef.current}_segment_${segmentIndexRef.current}`;
      setSegmentLabel(segmentIndexRef.current);
      bumpCounters({ segments: segmentIndexRef.current + 1 });
      persistEvent({
        eventId: `${segmentIdRef.current}_open_${now}`,
        sessionId: tradingSessionIdRef.current,
        segmentId: segmentIdRef.current,
        timestamp: now,
        type: "SEGMENT_OPEN",
        source: "VIDEO_REPLAY",
        techniqueVersion: techniqueRef.current,
        evidence: reason,
      });
      store.saveSegment({
        id: segmentIdRef.current,
        sessionId: tradingSessionIdRef.current,
        startedAt: segmentBaseRef.current,
        endedAt: null,
        reason,
        tradingDate: tradingDateRef.current,
        createdAt: now,
      });
      // A sequência anterior não pode se misturar com a nova.
      if (resetStitcher) stitcherRef.current = new CandleStitcher();
      sequenceRef.current = [];
      trackerRef.current = null;
      frozenAnalysisRef.current = null;
      frozenDnaRef.current = null;
      entryMachineRef.current.reset();
      snapshotRef.current = null;
      setSignalSnapshot(null);
      setOperation(null);
      setEntryState("SCANNING");
    },
    [bumpCounters, persistEvent],
  );

  /** Calibração pela escala da MESMA tela compartilhada — sem print, sem upload. */
  const tryCalibrate = useCallback(
    async (video: HTMLVideoElement, manual = false) => {
      if (calibratingRef.current) return;
      calibratingRef.current = true;
      lastCalibrationTryRef.current = Date.now();
      const previousCalibration = calibrationRef.current;
      const scheduler = schedulerRef.current;
      scheduler.markAttempt(Date.now());
      try {
        const snapshot = capturePriceScaleImage(video, scheduler.roi());
        const response = await calibrateScale({
          data: { imageDataUrl: snapshot.imageDataUrl, frameHeight: snapshot.frameHeight },
        });
        if (response.error) throw new Error(response.error);
        const normalizedAnchors = normalizeScaleAnchorsForAsset(asset, response.anchors);
        const next = calibrateFromAnchors(normalizedAnchors);
        if (!next.usable) throw new Error(next.reason);
        const issue = assetScaleIssue(asset, normalizedAnchors);
        if (issue) throw new Error(issue);
        const drift = previousCalibration.usable
          ? calibrationDrift(previousCalibration, normalizedAnchors)
          : { stale: true, maxDriftPx: Number.POSITIVE_INFINITY };
        calibrationRef.current = next;
        setCalibration(next);
        setCalibrationError(null);
        setCalibrationState(scheduler.succeed(next.anchors.length));
        lastCalibrationRefreshRef.current = Date.now();
        // Primeira calibração ou autoescala/zoom realmente diferente: preço
        // real vale DAQUI PARA FRENTE e o segmento é reiniciado. Uma simples
        // revalidação estável não fragmenta o backtest.
        if (!previousCalibration.usable) {
          openSegment("escala_calibrada", true);
        } else if (drift.stale) {
          openSegment("escala_do_profit_alterada", true);
          pushTimeline(
            "ESCALA ATUALIZADA",
            `Autoescala/zoom detectado · desvio ${drift.maxDriftPx.toFixed(1)} px`,
            "warn",
          );
        }
        calibrationLogRef.current = "CALIBRATED";
        if (!previousCalibration.usable || drift.stale || manual) {
          appendLog(
            `Escala calibrada na tela compartilhada: ${next.anchors.map((a) => a.raw).join(" → ")}. Preços exatos disponíveis.`,
            "info",
          );
        }
      } catch (raised) {
        const message = raised instanceof Error ? raised.message : "Falha ao ler a escala.";
        // Falha de REFRESH não derruba uma calibração que continua sendo a
        // última conhecida; falha inicial continua visível e nunca bloqueia a
        // análise estrutural.
        if (!previousCalibration.usable) setCalibrationError(message);
        const state = scheduler.fail(message);
        setCalibrationState(state);
        // Linha consolidada: só avisa em transição de estado ou pedido manual.
        if (manual || calibrationLogRef.current !== state.status) {
          calibrationLogRef.current = state.status;
          appendLog(calibrationSummary(state), "warn");
        }
      } finally {
        calibratingRef.current = false;
      }
    },
    [appendLog, asset, calibrateScale, openSegment, pushTimeline],
  );

  const closeTrade = useCallback(
    (progressed: LiveOperationResult, lastCandle: Candle) => {
      const frozen = frozenAnalysisRef.current;
      const frozenDna = frozenDnaRef.current;
      trackerRef.current = null;
      frozenAnalysisRef.current = null;
      frozenDnaRef.current = null;
      entryMachineRef.current.reset();
      snapshotRef.current = null;
      setSignalSnapshot(null);
      setEntryState("SCANNING");
      if (!frozen) return;
      if (!progressed.filled || !progressed.result || progressed.rMultiple === null) {
        // O setup expirou SEM operação — mas a detecção já está no setup_dna,
        // que é exatamente o que separa "quantas apareceram" de "quantas
        // executaram".
        pushTimeline("SETUP EXPIRADO", progressed.detail, "warn");
        return;
      }
      const trade = createBacktestTrade({
        analysis: frozen,
        // DNA do ARMAMENTO, com a janela daquele instante — não uma extração
        // tardia sem geometria.
        dna: frozenDna ?? undefined,
        asset,
        sourceCaptureId: `tela_compartilhada_${sessionIdRef.current}`,
        segmentId: segmentIdRef.current,
        tradingSessionId: tradingSessionIdRef.current,
        tradingDate: tradingDateRef.current,
        origin: "VIDEO_REPLAY",
        closedAt: progressed.exitAt ?? lastCandle.t,
        entryHitAt: progressed.entryHitAt,
        partialHitAt: progressed.partialHitAt,
        exitAt: progressed.exitAt,
        exit: progressed.exit ?? frozen.price,
        result: progressed.result,
        rMultiple: progressed.rMultiple,
        mfeMae:
          progressed.mfePoints !== null && progressed.maePoints !== null
            ? {
                mfePoints: progressed.mfePoints,
                maePoints: progressed.maePoints,
                mfeR: progressed.mfeR,
                maeR: progressed.maeR,
              }
            : null,
        exitReason: progressed.exitReason,
        ambiguousIntrabar: progressed.ambiguousIntrabar,
        productionTechniqueVersion: techniqueRef.current,
      });
      if (!trade) return;
      tradesRef.current = [...tradesRef.current, trade];
      bumpCounters({ trades: tradesRef.current.length });
      persistEvent({
        eventId: `${trade.id}_exit`,
        sessionId: tradingSessionIdRef.current,
        segmentId: segmentIdRef.current,
        timestamp: trade.exitAt ?? trade.closedAt,
        marketTime: marketTimeRef.current,
        type:
          trade.exitReason === "stop"
            ? "STOP_HIT"
            : trade.exitReason === "alvo"
              ? "TARGET_HIT"
              : "TRADE_CLOSED",
        direction: trade.direction,
        price: trade.exit,
        source: "VIDEO_REPLAY",
        techniqueVersion: trade.strategyVersion,
        evidence: trade.exitReason ?? null,
      });
      persistTrades();
      persistSession("IN_PROGRESS", null);
      pushTimeline(
        `OPERAÇÃO ${progressed.result}`,
        `${trade.direction} · ${progressed.rMultiple.toFixed(2)}R · ${progressed.detail}`,
        progressed.rMultiple >= 0 ? "bull" : "bear",
      );
      appendLog(
        `Operação simulada encerrada: ${progressed.result} (${progressed.rMultiple.toFixed(2)}R). Nenhuma ordem foi enviada.`,
        progressed.rMultiple >= 0 ? "info" : "warn",
      );
    },
    [appendLog, asset, bumpCounters, persistEvent, persistSession, persistTrades, pushTimeline],
  );

  /**
   * Processa UMA fronteira temporal por vez.
   *
   * Mesmo que o frame do Profit mostre 100 candles, esta função é chamada
   * cronologicamente para cada candle novo. A decisão de T enxerga somente
   * `history`, que termina exatamente em `currentCandle`. O candle seguinte só
   * pode avançar o outcome de uma decisão já congelada — nunca reescrever T.
   */
  const runFrontier = useCallback(
    (history: Candle[], currentCandle: Candle, closedCount: number) => {
      const calibrated = calibrationRef.current.usable;
      const quality =
        qualityCountRef.current > 0
          ? Math.round(qualitySumRef.current / qualityCountRef.current)
          : 0;

      // PRIMEIRO: se já existia decisão congelada antes deste candle, T+1 pode
      // apenas avançar o desfecho. Isso impede usar o candle atual para criar a
      // decisão e, no mesmo passo, dizer que a entrada/stop/alvo já aconteceu.
      const tracker = trackerRef.current;
      const hadTrackerAtOpen = tracker !== null;
      if (tracker) {
        const progressed = tracker.push(currentCandle);
        setOperation(progressed);
        const frozen = frozenAnalysisRef.current;
        if (progressed.status !== lastStatusRef.current) {
          lastStatusRef.current = progressed.status;
          const type =
            progressed.status === "ENTRADA ATINGIDA"
              ? "ENTRY_HIT"
              : progressed.status === "PARCIAL ATINGIDA"
                ? "PARTIAL_HIT"
                : progressed.status === "RUNNER ATIVO"
                  ? "TARGET2_HIT"
                  : progressed.status === "RUNNER ENCERRADO"
                    ? "RUNNER_STOP"
                    : progressed.status === "ALVO ATINGIDO"
                      ? "TARGET_HIT"
                      : progressed.status === "STOP ATINGIDO"
                        ? "STOP_HIT"
                        : null;
          if (type && frozen) {
            persistEvent({
              eventId: `${sessionIdRef.current}_${type}_${currentCandle.t}`,
              sessionId: tradingSessionIdRef.current,
              segmentId: segmentIdRef.current,
              timestamp: currentCandle.t,
              marketTime: marketTimeRef.current,
              type,
              direction: frozen.direction,
              price: progressed.exit ?? frozen.price,
              source: "VIDEO_REPLAY",
              techniqueVersion: techniqueRef.current,
              evidence: progressed.detail,
            });
            pushTimeline(type.replace("_", " "), progressed.detail, "warn");
          }
        }
        if (progressed.done) closeTrade(progressed, currentCandle);
        setEntryState(entryMachineRef.current.current());
      }

      // A análise estrutural continua em TODO candle, inclusive enquanto existe
      // operação em curso. Ela usa somente a janela encerrada em T.
      /*
       * MESMOS PARÂMETROS DE RISCO DO AO VIVO — agora de verdade.
       *
       * HISTÓRICO: este caminho passava `store.riskParams()` (ajustes do
       * usuário) enquanto o ao vivo e o replay chamavam `analyze()` SEM
       * `riskParams`. Unificou-se removendo a fonte do usuário — mas os três
       * caminhos passaram a cair em `DEFAULT_RISK_PARAMS`, cujo `tickSize` é 0.
       * Iguais entre si e errados nos três: `roundToTick` devolvia o preço cru,
       * e a evidência histórica era construída sobre níveis fora do tick do
       * contrato.
       *
       * O QUE VALE AGORA: a fonte é a TÉCNICA (`DEFAULT_RISK_PARAMS`) com o
       * tick do ATIVO por cima, via `riskParamsForAsset(asset)` — exatamente a
       * mesma chamada do ao vivo (`useProfitVision`) e do replay
       * (`techniqueReplay`). Backtest e produção medem o mesmo plano.
       */
      const result = analyze(history, {
        reading: reading(calibrationRef.current, quality, closedCount),
        riskParams: riskParamsForAsset(asset),
      });
      if (!result) return;
      setAnalysis(result);
      analysisStateRef.current = result;
      const events = eventStoreRef.current;
      if (events && result.plan) events.setPriceBucket(result.plan.stopDistance / 2);

      const captureId = `obs_${result.t}`;
      const register = (
        type: Parameters<EventStore["add"]>[0]["type"],
        price: number,
        region: string,
        evidence: string,
        confidence: number,
      ) => {
        // Enquanto a escala é geométrica, a leitura existe mas o preço não é
        // confiável. Não persistimos preço "inventado" no banco.
        if (!events || !calibrated) return;
        events.add({
          timestamp: result.t,
          candleId: `${asset}:${result.t}`,
          type,
          price,
          region,
          evidence,
          confidenceVisual: confidence,
          sourceCaptureId: captureId,
          sessionId: tradingSessionIdRef.current,
          segmentId: segmentIdRef.current,
          source: "VIDEO_REPLAY",
          techniqueVersion: techniqueRef.current,
          direction: result.direction,
        });
        pushTimeline(type.toUpperCase(), `${region} · ${evidence}`, "info");
      };

      const capture = result.internalConfirmation.capture;
      if (capture.valid && capture.detail.price !== null) {
        register(
          "liquiditySweep",
          capture.detail.price,
          capture.detail.side === "compradora" ? "liquidez acima" : "liquidez abaixo",
          `captura qualidade ${Math.round(capture.quality)}`,
          Math.min(1, result.reading.candleQuality / 100),
        );
      }
      const sms = result.internalConfirmation.sms;
      if (sms.confirmed && sms.brokenLevel !== null) {
        register(
          "CHOCH",
          sms.brokenLevel,
          "estrutura interna",
          sms.label,
          Math.min(1, sms.confidence / 100),
        );
      }
      if (result.mainPoi) {
        register(
          "POI",
          (result.mainPoi.lower + result.mainPoi.upper) / 2,
          `${result.mainPoi.lower.toFixed(2)}–${result.mainPoi.upper.toFixed(2)}`,
          `POI ${result.mainPoi.kind} força ${result.mainPoi.strength}`,
          Math.min(1, result.mainPoi.strength / 100),
        );
      }
      setCounters({ ...countersRef.current });

      // Se havia operação antes deste candle, ele foi reservado ao outcome.
      // Mesmo que ela feche aqui, não permitimos reentrada no mesmo candle.
      if (hadTrackerAtOpen) return;

      // Sem escala calibrada: estrutura continua ativa, mas nenhum nível exato
      // nem decisão operacional é publicado/salvo.
      if (!calibrated) return;

      /*
       * O BACKTEST PASSA PELOS GATES T4 — como o ao vivo.
       *
       * Ele ia de `analyze()` direto para `decide()`. `evaluateT4Gates` e
       * `evaluateOperation` só existiam no caminho visual, então o backtest
       * media a TÉCNICA sem passar pelo FLUXO: gravava como evidência histórica
       * candidatos que, ao vivo, os gates teriam segurado.
       *
       * Uma base construída assim é otimista por construção — e é essa base que
       * autoriza operação real.
       *
       * `now` é o instante do CANDLE, nunca o relógio da máquina: reexecutar o
       * mesmo trecho tem de dar o mesmo estágio, e um `Date.now()` aqui
       * quebraria a paridade que acabou de ser estabelecida.
       */
      const backtestGates = evaluateT4Gates(result, true);

      const settings = store.settings();
      const instrument = resolveInstrument(asset, {
        tickSize: settings.tickSize > 0 ? settings.tickSize : undefined,
        pointValue: settings.pointValue > 0 ? settings.pointValue : undefined,
      });
      const decided = decide({
        analysis: result,
        asset,
        trades: filterEvidenceTrades(store.backtests()),
        techniqueSnapshot: techniqueRef.current,
        instrument,
        riskConfig: {
          accountBalance: settings.accountBalance,
          maxRiskPercent: settings.maxRiskPercent,
          maxRiskMoney: settings.maxRiskMoney,
          contractsLimit: settings.maxContracts,
        },
        // Backtest precisa construir a amostra do zero. A técnica e todos os
        // gates são avaliados como se estivesse ao vivo em T, mas a ausência
        // de 30 casos prévios não bloqueia o registro do candidato histórico.
        mode: "BACKTEST_DISCOVERY",
      });
      setDecision(decided);

      const state = entryMachineRef.current.onDecision(decided);
      setEntryState(state);

      /*
       * A OPERAÇÃO É AVALIADA COM A DECISÃO REAL — e depois da máquina andar,
       * exatamente como ao vivo (useProfitVision: decide → onDecision →
       * evaluateOperation). Esta chamada ficava ANTES de `decide()`, com
       * `decision: null`: como `entry`/`stop` só nascem da decisão
       * (preEntry.ts:214-215) e `confirmed: true` exige os dois
       * (preEntry.ts:261), `operation.confirmed` era falso em toda iteração e o
       * portão logo abaixo nunca abria — o backtest por observação jamais
       * registrou um trade. O instante continua sendo o do CANDLE.
       */
      const operation = evaluateOperation({
        dataReady: true,
        dataGates: [],
        t4Gates: backtestGates,
        analysis: result,
        decision: decided,
        entryState: state,
        previous: previousOperationRef.current,
        now: currentCandle.t,
      });
      previousOperationRef.current = operation;

      /*
       * O ESTÁGIO T4 É PORTÃO AQUI TAMBÉM.
       *
       * Antes bastava `state === "CONFIRMED"` da máquina de entrada, que só olha
       * a decisão. Ao vivo, um candidato ainda precisa dos gates técnicos — e
       * era essa diferença que deixava a base histórica mais permissiva que a
       * produção que ela autoriza.
       */
      if (
        state === "CONFIRMED" &&
        operation.confirmed &&
        result.plan &&
        result.direction !== "NEUTRO"
      ) {
        frozenAnalysisRef.current = structuredClone(result);
        /*
         * DNA CONGELADO AQUI, no armamento — nunca no fechamento. É o que
         * garante POR CONSTRUÇÃO que a classificação (nota, tendência,
         * pullback, gatilho, ordinal…) não conheceu o desfecho (§1). A
         * detecção sobe para o setup_dna imediatamente; o vínculo com o
         * trade chega depois, se ele existir. Setup que expira sem execução
         * continua registrado — DESCARTADAS também são estatística.
         */
        const dna = dnaFromAnalysis(result, {
          id: `dna_${sessionIdRef.current}_${result.t}_${result.direction}`,
          origin: "REPLAY",
          sourceId: sessionIdRef.current,
          asset,
          window: history,
          priorSameDirectionAt: priorDnaRef.current
            .filter((prior) => prior.direction === result.direction)
            .map((prior) => prior.detectedAt),
          techniqueVersion: techniqueRef.current,
          // A grade de tempo do replay é ancorada no relógio local enquanto o
          // OCR do eixo não confirma o pregão: o instante ordena a série, mas
          // a DATA é do dia em que o vídeo rodou. Sem data confirmada, o DNA
          // não afirma tradingDate/hour — mesma regra que o trade vizinho já
          // segue ao gravar tradingDate null.
          marketTimeTrusted: tradingDateRef.current !== null,
        });
        if (dna !== null) {
          frozenDnaRef.current = dnaTradeFields(dna);
          priorDnaRef.current = [
            ...priorDnaRef.current,
            { direction: dna.direction, detectedAt: dna.detectedAt },
          ].slice(-200);
          store.saveSetupDna(dna as unknown as Record<string, unknown>);
        } else {
          frozenDnaRef.current = null;
        }
        // Paridade replay=ao vivo: mesmo snapshot congelado e mesmo som único
        // por signalId no momento da confirmação (comando §2, §7, §8).
        const snapshot = createSignalSnapshot({
          asset,
          chartTimestamp: currentCandle.t,
          direction: result.direction,
          entry: result.plan.entry,
          initialStop: result.plan.stop,
          threeR: result.plan.target1,
          fiveR: result.plan.target2,
          setup: result.t4.setup,
          confirmationCandle: currentCandle,
        });
        snapshotRef.current = snapshot;
        setSignalSnapshot(snapshot);
        playConfirmationOnce(snapshot.signalId, result.direction, store.settings().sound);
        lastStatusRef.current = null;
        trackerRef.current = new LiveOutcomeTracker(
          result.direction,
          result.plan.entry,
          result.plan.stop,
          result.plan.target1,
          result.plan.target2,
          10,
          { threeContractRunner: true },
        );
        countersRef.current.setups++;
        setCounters({ ...countersRef.current });
        persistEvent({
          eventId: `${sessionIdRef.current}_confirmed_${result.t}`,
          sessionId: tradingSessionIdRef.current,
          segmentId: segmentIdRef.current,
          timestamp: result.t,
          marketTime: marketTimeRef.current,
          type: "ENTRY_CONFIRMED",
          direction: result.direction,
          price: result.plan.entry,
          source: "VIDEO_REPLAY",
          techniqueVersion: techniqueRef.current,
          evidence: result.wyckoff.events.join("+") || result.wyckoff.schema,
        });
        pushTimeline(
          "SETUP CONFIRMADO — DECISÃO CONGELADA EM T",
          `${result.direction} entrada ${result.plan.entry.toFixed(2)} · stop ${result.plan.stop.toFixed(2)} · alvo ${result.plan.target2.toFixed(2)}`,
          "alert",
        );
        appendLog(
          "Decisão congelada: candles posteriores só podem atualizar o desfecho; nunca recalculam esta decisão.",
          "alert",
        );
      }
    },
    [appendLog, asset, closeTrade, persistEvent, pushTimeline],
  );

  const handleFrame = useCallback(
    (read: FrameRead) => {
      lastReadRef.current = read;
      countersRef.current.framesCaptured++;
      if (phaseRef.current !== "observando") {
        setCounters({ ...countersRef.current });
        refreshDiagnostics();
        return;
      }
      const video = chartRef.current?.videoRef.current;
      if (!video?.videoWidth) {
        countersRef.current.framesIgnored++;
        setCounters({ ...countersRef.current });
        return;
      }

      // Calibração continua tentando na própria tela compartilhada; falhar num
      // frame nunca interrompe o backtest.
      if (
        !calibrationRef.current.usable &&
        !calibratingRef.current &&
        schedulerRef.current.shouldAttempt(Date.now())
      ) {
        void tryCalibrate(video);
      } else if (
        calibrationRef.current.usable &&
        !calibratingRef.current &&
        Date.now() - lastCalibrationRefreshRef.current >= CALIBRATION_REFRESH_MS
      ) {
        // Revalidação leve da régua: no Profit a autoescala muda ao arrastar
        // o histórico mesmo com a janela exatamente do mesmo tamanho.
        lastCalibrationRefreshRef.current = Date.now();
        void tryCalibrate(video);
      }

      // Escala pendente = leitura geométrica (unidades relativas). A estrutura
      // é a mesma; só os preços exatos ficam indisponíveis.
      const anchor = calibrationRef.current.usable
        ? calibrationRef.current
        : geometricCalibration(read.height || video.videoHeight || 720);
      const extracted = extractVisibleCandles(video, anchor, 0);
      if (extracted.length < 3) {
        countersRef.current.framesIgnored++;
        setCounters({ ...countersRef.current });
        return;
      }
      qualitySumRef.current += read.quality * 100;
      qualityCountRef.current++;

      const stitched = stitcherRef.current.ingest(extracted, {
        // Antes da calibração o mesmo candle muda de Y quando o Profit
        // autoescala. A costura usa comparação afim somente nesse modo.
        allowAffine: !calibrationRef.current.usable,
      });
      if (stitched.discontinuity) {
        discontinuitiesRef.current = [...discontinuitiesRef.current, stitched.reason].slice(-200);
        openSegment(stitched.reason);
        pushTimeline("DESCONTINUIDADE", stitched.reason, "warn");
      }

      // Leitura assíncrona da FAIXA DE TEMPO inferior — nunca bloqueia a
      // captura. Antes era enviado o recorte da escala de PREÇO, que no Profit
      // real quase nunca contém a data/horário de navegação.
      if (++framesSinceClockRef.current >= CLOCK_EVERY_FRAMES && !clockBusyRef.current) {
        framesSinceClockRef.current = 0;
        clockBusyRef.current = true;
        try {
          const imageDataUrl = captureTimeAxisImage(video, null);
          void readClock({ data: { imageDataUrl } })
            .then((clock) => {
              if (!clock.read) {
                if (clock.error) reportError("CHART_CLOCK", clock.error, { severity: "WARNING" });
                return;
              }
              if (clock.read.time) {
                lastClockAtRef.current = Date.now();
                marketTimeRef.current = clock.read.time;
                setMarketTime(clock.read.time);
              }
              const stabilized = clockRef.current.push(clock.read);
              if (stabilized.sessionChanged && stabilized.state.confirmedDate) {
                openTradingSession(stabilized.state.confirmedDate, "clock_confirmed_date_change");
              }
            })
            .catch((error) =>
              reportError("CHART_CLOCK", error instanceof Error ? error.message : String(error), {
                severity: "WARNING",
              }),
            )
            .finally(() => {
              clockBusyRef.current = false;
            });
        } catch {
          clockBusyRef.current = false;
        }
      }

      if (stitched.appended === 0) {
        countersRef.current.framesIgnored++;
        setCounters({ ...countersRef.current });
        return;
      }
      countersRef.current.framesAnalyzed++;

      const base = segmentBaseRef.current;
      const sequence = stitcherRef.current
        .sequence()
        .map((candle, index) => ({ ...candle, t: base + index * MINUTE_MS }));
      const previousLength = sequenceRef.current.length;
      const frontiers = chronologicalFrontiers(sequence, previousLength, ANALYSIS_WINDOW);
      sequenceRef.current = sequence;
      countersRef.current.analyzedMinutes += frontiers.length;
      setCandles(sequence.slice(-400));

      // CRÍTICO: processa todo lote revelado candle a candle. Um frame pode
      // conter 10:30..12:00; a decisão de 10:30 recebe somente o prefixo até
      // 10:30, e assim por diante. Isso elimina look-ahead do gráfico inteiro.
      for (const frontier of frontiers) {
        runFrontier(frontier.history, frontier.candle, frontier.index + 1);
      }

      setCounters({ ...countersRef.current });
      persistSession("IN_PROGRESS", null);
      refreshDiagnostics();
    },
    [
      openSegment,
      openTradingSession,
      persistSession,
      pushTimeline,
      readClock,
      refreshDiagnostics,
      runFrontier,
      tryCalibrate,
    ],
  );

  const chart = useContinuousChartCapture(handleFrame);
  const chartRef = useRef(chart);
  chartRef.current = chart;

  /** MESMO botão da operação ao vivo: seleciona a janela e mostra o gráfico. */
  const selectScreen = useCallback(async () => {
    await chart.selectSource();
    chart.confirmPreview();
    const video = chart.videoRef.current;
    // Não espera o Qwen para começar: gráfico selecionado = observação pode
    // iniciar já; calibração segue em paralelo.
    if (video?.videoWidth) void tryCalibrate(video, true);
    return Boolean(video?.srcObject);
  }, [chart, tryCalibrate]);

  const switchScreen = useCallback(async () => {
    await chart.switchSource();
    chart.confirmPreview();
    const video = chart.videoRef.current;
    if (phaseRef.current === "observando" || phaseRef.current === "pausado") {
      openSegment("janela_do_profit_trocada", true);
    }
    if (video?.videoWidth) void tryCalibrate(video, true);
    return Boolean(video?.srcObject);
  }, [chart, openSegment, tryCalibrate]);

  const start = useCallback((): string[] => {
    const errors: string[] = [];
    const hasSource = Boolean(chart.videoRef.current?.srcObject);
    if (!hasSource) errors.push("Compartilhe a janela do gráfico do Profit.");
    if (!storageReady) errors.push("Banco persistente ainda não disponível.");
    if (errors.length) return errors;
    if (chart.status !== "capturando") chart.confirmPreview();

    // Mesmo ancor determinístico do mount — nunca o relógio (B4).
    sessionIdRef.current = `obs_${asset}`;
    startedAtRef.current = Date.now();
    techniqueRef.current = store.productionTechnique()?.version ?? STRATEGY_VERSION;
    stitcherRef.current = new CandleStitcher();
    sequenceRef.current = [];
    segmentIndexRef.current = -1;
    segmentBaseRef.current = Date.now();
    tradesRef.current = [];
    discontinuitiesRef.current = [];
    sessionDatesRef.current = new Set();
    clockRef.current = new ClockStabilizer();
    entryMachineRef.current.reset();
    trackerRef.current = null;
    frozenAnalysisRef.current = null;
    frozenDnaRef.current = null;
    priorDnaRef.current = [];
    qualitySumRef.current = 0;
    qualityCountRef.current = 0;
    countersRef.current = { ...EMPTY_COUNTERS };
    eventStoreRef.current = new EventStore(asset, 1, 400, (event) => {
      store.saveMarketEvent({ ...event, id: event.eventId });
      countersRef.current.events++;
    });
    setCounters({ ...EMPTY_COUNTERS });
    setCandles([]);
    setAnalysis(null);
    setDecision(null);
    setOperation(null);
    setTimeline([]);
    segmentIdRef.current = null;
    tradingSessionIdRef.current = null;
    openSegment("backtest_start");
    openTradingSession(null, "backtest_start");
    phaseRef.current = "observando";
    setPhase("observando");
    appendLog(
      "Backtest iniciado sobre a tela compartilhada. Navegue o histórico no Profit — a IA acompanha, decide em T e nunca vê o futuro.",
      "info",
    );
    return [];
  }, [appendLog, asset, chart, openSegment, openTradingSession, storageReady]);

  const pause = useCallback(() => {
    phaseRef.current = "pausado";
    setPhase("pausado");
    chart.pause();
    persistSession("PAUSED", null);
    appendLog("Backtest pausado. Nada é perdido — tudo já observado está no banco.", "warn");
  }, [appendLog, chart, persistSession]);

  const resume = useCallback(() => {
    phaseRef.current = "observando";
    setPhase("observando");
    chart.resume();
    appendLog("Backtest retomado.", "info");
  }, [appendLog, chart]);

  const finish = useCallback(() => {
    phaseRef.current = "encerrado";
    setPhase("encerrado");
    const now = Date.now();
    if (segmentIdRef.current) {
      store.saveSegment({
        id: segmentIdRef.current,
        sessionId: tradingSessionIdRef.current,
        startedAt: segmentBaseRef.current,
        endedAt: now,
        reason: "backtest_end",
        tradingDate: tradingDateRef.current,
        createdAt: now,
      });
    }
    if (tradingSessionIdRef.current) {
      persistEvent({
        eventId: `${tradingSessionIdRef.current}_close_${now}`,
        sessionId: tradingSessionIdRef.current,
        segmentId: segmentIdRef.current,
        timestamp: now,
        type: "SESSION_CLOSE",
        source: "VIDEO_REPLAY",
        techniqueVersion: techniqueRef.current,
        evidence: "backtest_end",
      });
    }
    persistTrades();
    persistSession("COMPLETED", now);
    // T4 aprende em TODO pregão observado. A rotina roda depois da fila de
    // persistência dos trades e só cria hipóteses de laboratório.
    for (const date of sessionDatesRef.current) {
      store.runDailyLearning(date, techniqueRef.current);
    }
    chart.stop();
    appendLog(
      "Backtest encerrado. Base histórica atualizada — o Laboratório já pode usar estes dados.",
      "info",
    );
    pushTimeline(
      "BACKTEST ENCERRADO",
      `${tradesRef.current.length} operação(ões) registrada(s)`,
      "info",
    );
  }, [appendLog, chart, persistEvent, persistSession, persistTrades, pushTimeline]);

  const evidence = useMemo(
    () => evaluateEvidence(filterEvidenceTrades(store.backtests())),
    // recalculado quando novas operações entram na base
    [counters.trades],
  );

  return {
    chart,
    phase,
    signalSnapshot,
    diagnostics,
    calibration,
    calibrationError,
    calibrationState,
    calibrationSummary: calibrationSummary(calibrationState),
    priceScaleReady: calibration.usable,
    adjustScaleRegion: (fraction: number | null) => {
      schedulerRef.current.setManualRoi(fraction);
      setCalibrationState(schedulerRef.current.state());
    },
    counters,
    candles,
    analysis,
    decision,
    entryState,
    operation,
    frozenEntry: entryMachineRef.current.frozenEntry(),
    timeline,
    chat,
    aiProvider,
    tradingDate,
    marketTime,
    segmentIndex: segmentLabel,
    storageReady,
    evidence,
    trades: tradesRef.current,
    selectScreen,
    switchScreen,
    start,
    pause,
    resume,
    finish,
    recalibrate: () => {
      const video = chart.videoRef.current;
      if (video?.videoWidth) void tryCalibrate(video, true);
    },
  };
}
