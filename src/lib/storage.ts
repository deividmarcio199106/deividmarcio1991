import type { BacktestTrade, TradeOrigin } from "@/lib/engines/backtestEngine";
import { DEFAULT_RISK_PARAMS, type RiskParams, type StopMethod } from "@/lib/engines/strategy";
import type { AnalysisResult, Candle } from "@/lib/engines/types";
import type { DailyLearningReport } from "@/lib/engines/dailyLearning";

export interface LiveSessionRecord {
  id: string;
  asset: string;
  strategyVersion: string;
  startedAt: number;
  endedAt: number | null;
  status: "ativa" | "encerrada";
  finalAnalysis: AnalysisResult | null;
}

export interface BacktestRecord {
  id: string;
  strategyVersion: string;
  asset: string;
  timeframe: "1m";
  createdAt: number;
  sourceCaptureId: string;
  origin: TradeOrigin;
  trades: BacktestTrade[];
}

export interface Settings {
  sound: boolean;
  asset: string;
  maxContracts: number;
  maxRiskPerTradePoints: number;
  accountBalance: number;
  maxRiskPercent: number;
  maxRiskMoney: number;
  pointValue: number;
  stopMethod: StopMethod;
  tickSize: number;
  minStopDistancePoints: number;
  maxStopDistancePoints: number;
  partialTargetMultiple: number;
  finalTargetMultiple: number;
}

export interface AIMemoryMessage {
  role: "user" | "assistant";
  content: string;
  savedAt: number;
}

export const DEFAULT_SETTINGS: Settings = {
  sound: true,
  asset: "WINFUT",
  maxContracts: 3,
  maxRiskPerTradePoints: 500,
  accountBalance: 0,
  maxRiskPercent: 0,
  maxRiskMoney: 0,
  pointValue: 0,
  stopMethod: DEFAULT_RISK_PARAMS.stopMethod,
  tickSize: DEFAULT_RISK_PARAMS.tickSize,
  minStopDistancePoints: DEFAULT_RISK_PARAMS.minStopDistance,
  maxStopDistancePoints: 1_000_000,
  partialTargetMultiple: DEFAULT_RISK_PARAMS.partialTargetMultiple,
  finalTargetMultiple: DEFAULT_RISK_PARAMS.finalTargetMultiple,
};

/** Registro persistido de uma gravação de replay do Profit. */
export interface ReplayRecordingRecord {
  sessionId: string;
  createdAt: number;
  symbol: string;
  timeframe: "1m";
  durationMs: number;
  frameCount: number;
  usefulFrames: number;
  dedupedFrames: number;
  calibrationVersions: number;
  strategyVersion: string;
  status: string;
  discontinuities: string[];
  tradeCount: number;
  candleCount: number;
}

/** Snapshot temporário para recuperação da captura atual. Não é base histórica oficial. */
export interface PendingReplaySnapshot {
  sessionId: string;
  asset: string;
  startedAt: number;
  savedAt: number;
  series: Candle[][];
}

/** Pregão como unidade persistente de estudo. */
export interface TradingSessionRecord {
  id: string;
  source: "VIDEO_REPLAY" | "LIVE_REPLAY" | "LIVE";
  symbol: string;
  tradingDate: string | null;
  timeframe: "1m";
  startedAt: number;
  endedAt: number | null;
  techniqueVersion?: string | null;
  segmentCount: number;
  eventCount: number;
  tradeCount: number;
  createdAt: number;
}

export interface TechniqueRecord {
  version: string;
  status: "PRODUCTION" | "ARCHIVED";
  rules: Record<string, unknown>;
  createdAt: number;
  promotedAt: number | null;
}

export type TechniqueCandidateStatus =
  "DISCOVERED" | "BACKTESTING" | "VALIDATION" | "OOS" | "WALK_FORWARD" | "VALIDATED" | "REJECTED";

export interface TechniqueCandidateRecord {
  id: string;
  version: string;
  baseVersion: string;
  hypothesis: string;
  status: TechniqueCandidateStatus;
  rules: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface MarketEventRecord {
  id?: string;
  eventId: string;
  sessionId?: string | null;
  segmentId?: string | null;
  timestamp: number;
  marketTime?: string | null;
  type: string;
  direction?: string | null;
  price?: number | null;
  source?: string | null;
  modelVersion?: string | null;
  techniqueVersion?: string | null;
  evidence?: string | null;
}

export interface SegmentRecord {
  id: string;
  sessionId: string | null;
  startedAt: number;
  endedAt: number | null;
  reason: string | null;
  tradingDate: string | null;
  createdAt: number;
}

export type AIMemoryScope = "backtest" | "aprendizado";

interface PersistentSnapshot {
  liveSessions: LiveSessionRecord[];
  tradingSessions: TradingSessionRecord[];
  backtests: BacktestRecord[];
  replaySessions: ReplayRecordingRecord[];
  lastDecision: unknown | null;
  productionTechnique: TechniqueRecord | null;
  techniqueCandidates: TechniqueCandidateRecord[];
  dailyLearningReports: DailyLearningReport[];
}

const cache: PersistentSnapshot = {
  liveSessions: [],
  tradingSessions: [],
  backtests: [],
  replaySessions: [],
  lastDecision: null,
  productionTechnique: null,
  techniqueCandidates: [],
  dailyLearningReports: [],
};
let hydrated = false;
let hydrationPromise: Promise<void> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

const LOCAL_KEYS = {
  settings: "dt.settings.ui",
  aiBacktest: "dt.ai.backtest.ui",
  aiLearning: "dt.ai.learning.ui",
  replayPending: "dt.replay.pending.temporary",
} as const;

function localRead<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function localWrite(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Preferências locais não devem derrubar a aplicação.
  }
}

function sessionRead<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function sessionWrite(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Snapshot temporário; sem impacto na base persistente.
  }
}

async function api(
  path: string,
  method: "GET" | "POST" = "GET",
  payload?: unknown,
): Promise<Response> {
  const response = await fetch(path, {
    method,
    headers: payload === undefined ? undefined : { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Persistência HTTP ${response.status} em ${path}`);
  return response;
}

function persist(path: string, payload: unknown): void {
  if (typeof window === "undefined") return;
  // Escritas oficiais seguem uma fila única. Além de preservar a ordem temporal,
  // isso impede que um trade tente referenciar uma sessão ainda não persistida.
  writeQueue = writeQueue
    .then(async () => {
      await api(path, "POST", payload);
    })
    .catch((error) => {
      console.error("Falha ao persistir dados do analisador:", error);
    });
}

export const store = {
  isHydrated: () => hydrated,
  async hydrate(force = false): Promise<void> {
    if (typeof window === "undefined") return;
    if (hydrated && !force) return;
    if (hydrationPromise && !force) return hydrationPromise;
    hydrationPromise = (async () => {
      const response = await api("/api/trading/snapshot");
      const snapshot = (await response.json()) as PersistentSnapshot;
      cache.liveSessions = snapshot.liveSessions ?? [];
      cache.tradingSessions = snapshot.tradingSessions ?? [];
      cache.backtests = snapshot.backtests ?? [];
      cache.replaySessions = snapshot.replaySessions ?? [];
      cache.lastDecision = snapshot.lastDecision ?? null;
      cache.productionTechnique = snapshot.productionTechnique ?? null;
      cache.techniqueCandidates = snapshot.techniqueCandidates ?? [];
      cache.dailyLearningReports = snapshot.dailyLearningReports ?? [];
      hydrated = true;
    })().finally(() => {
      hydrationPromise = null;
    });
    return hydrationPromise;
  },
  sessions: () => cache.liveSessions,
  tradingSessions: () => cache.tradingSessions,
  upsertTradingSession(record: TradingSessionRecord) {
    cache.tradingSessions = [
      ...cache.tradingSessions.filter((item) => item.id !== record.id),
      record,
    ].slice(-2000);
    persist("/api/trading/trading-sessions", record);
  },
  productionTechnique: () => cache.productionTechnique,
  techniqueCandidates: () => cache.techniqueCandidates,
  dailyLearningReports: () => cache.dailyLearningReports,
  runDailyLearning(tradingDate: string, baseVersion: string) {
    // Usa a mesma fila das escritas de trades: o servidor só aprende depois de
    // receber os desfechos daquele pregão.
    if (typeof window === "undefined") return;
    writeQueue = writeQueue
      .then(async () => {
        const response = await api("/api/trading/learning-daily", "POST", {
          tradingDate,
          baseVersion,
        });
        const payload = (await response.json()) as { report?: DailyLearningReport };
        if (payload.report) {
          cache.dailyLearningReports = [
            payload.report,
            ...cache.dailyLearningReports.filter((item) => item.id !== payload.report!.id),
          ].slice(0, 500);
        }
      })
      .catch((error) => console.error("Falha no aprendizado diário T4:", error));
  },
  saveTechniqueCandidate(record: TechniqueCandidateRecord) {
    cache.techniqueCandidates = [
      ...cache.techniqueCandidates.filter((item) => item.id !== record.id),
      record,
    ].slice(-500);
    persist("/api/trading/technique-candidates", record);
  },
  lastDecision: <T>() => cache.lastDecision as T | null,
  saveLastDecision<T>(decision: T) {
    cache.lastDecision = decision;
    persist("/api/trading/decision", decision);
  },
  saveSession(session: LiveSessionRecord) {
    cache.liveSessions = [
      ...cache.liveSessions.filter((item) => item.id !== session.id),
      session,
    ].slice(-500);
    persist("/api/trading/live-sessions", session);
  },
  backtests: () => cache.backtests,
  saveBacktest(record: BacktestRecord) {
    cache.backtests = [...cache.backtests, record].slice(-1000);
    persist("/api/trading/backtests", record);
  },
  upsertBacktest(record: BacktestRecord) {
    cache.backtests = [...cache.backtests.filter((item) => item.id !== record.id), record].slice(
      -1000,
    );
    persist("/api/trading/backtests", record);
  },
  allTrades: (): BacktestTrade[] => cache.backtests.flatMap((record) => record.trades),
  saveReplayBatch(batch: {
    tradingSessions: TradingSessionRecord[];
    segments: SegmentRecord[];
    marketEvents: MarketEventRecord[];
    backtest: BacktestRecord | null;
    replaySession: ReplayRecordingRecord;
  }) {
    for (const record of batch.tradingSessions) {
      cache.tradingSessions = [
        ...cache.tradingSessions.filter((item) => item.id !== record.id),
        record,
      ].slice(-2000);
    }
    if (batch.backtest) {
      cache.backtests = [
        ...cache.backtests.filter((item) => item.id !== batch.backtest!.id),
        batch.backtest,
      ].slice(-1000);
    }
    cache.replaySessions = [
      ...cache.replaySessions.filter((item) => item.sessionId !== batch.replaySession.sessionId),
      batch.replaySession,
    ].slice(-1000);
    persist("/api/trading/replay-batch", batch);
  },
  saveMarketEvent(event: Record<string, unknown>) {
    persist("/api/trading/events", event);
  },
  saveSegment(segment: SegmentRecord) {
    persist("/api/trading/segments", segment);
  },
  /** Print analisado vira caso persistente da memória T4 (imagem vai ao disco do servidor). */
  savePrint(record: Record<string, unknown>) {
    persist("/api/trading/prints", record);
  },
  /** Detecção DNA sobe no ARMAMENTO — o vínculo com o trade chega depois. */
  saveSetupDna(dna: Record<string, unknown>) {
    persist("/api/trading/dna", dna);
  },
  aiMessages(scope: AIMemoryScope): AIMemoryMessage[] {
    const key = scope === "backtest" ? LOCAL_KEYS.aiBacktest : LOCAL_KEYS.aiLearning;
    return localRead<AIMemoryMessage[]>(key, []).slice(-30);
  },
  saveAIMessages(scope: AIMemoryScope, messages: AIMemoryMessage[]) {
    const key = scope === "backtest" ? LOCAL_KEYS.aiBacktest : LOCAL_KEYS.aiLearning;
    localWrite(key, messages.slice(-30));
  },
  settings: (): Settings => ({
    ...DEFAULT_SETTINGS,
    ...localRead<Partial<Settings>>(LOCAL_KEYS.settings, {}),
  }),
  saveSettings(settings: Settings) {
    localWrite(LOCAL_KEYS.settings, settings);
  },
  replaySessions: () => cache.replaySessions,
  saveReplaySession(record: ReplayRecordingRecord) {
    cache.replaySessions = [
      ...cache.replaySessions.filter((item) => item.sessionId !== record.sessionId),
      record,
    ].slice(-1000);
    persist("/api/trading/replay-sessions", record);
  },
  pendingReplay: (): PendingReplaySnapshot | null =>
    sessionRead<PendingReplaySnapshot | null>(LOCAL_KEYS.replayPending, null),
  savePendingReplay(snapshot: PendingReplaySnapshot) {
    sessionWrite(LOCAL_KEYS.replayPending, { ...snapshot, series: snapshot.series.slice(-400) });
  },
  clearPendingReplay() {
    if (typeof window !== "undefined") window.sessionStorage.removeItem(LOCAL_KEYS.replayPending);
  },
  riskParams(): RiskParams {
    const settings = store.settings();
    return {
      stopMethod: settings.stopMethod,
      tickSize: settings.tickSize,
      minStopDistance: settings.minStopDistancePoints,
      maxStopDistance: settings.maxStopDistancePoints,
      // T4 congela a gestão estudada; preferências antigas 1.6R/2.8R não
      // podem alterar o replay nem a sessão ao vivo.
      partialTargetMultiple: DEFAULT_RISK_PARAMS.partialTargetMultiple,
      finalTargetMultiple: DEFAULT_RISK_PARAMS.finalTargetMultiple,
    };
  },
};
