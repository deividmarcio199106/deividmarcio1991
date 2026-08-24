export type RecordingUiStatus =
  | "IDLE"
  | "STARTING"
  | "GRAVANDO"
  | "RECORDER_ERROR"
  | "ANALISE_ATIVA_GRAVACAO_FALHOU"
  | "FINALIZANDO"
  | "FINALIZADA"
  | "FALHOU";

export interface RecordingManagerState {
  sessionId: string | null;
  status: RecordingUiStatus;
  recorderState: RecordingState | "unavailable" | null;
  dbSessionCreated: boolean;
  firstChunkSaved: boolean;
  chunksSaved: number;
  bytesSaved: number;
  lastChunkAt: number | null;
  segment: number;
  error: string | null;
  startedAt: number | null;
}

const CHUNK_MS = 2_000;

/**
 * SCREEN RECORDING MANAGER — singleton global (comando §9).
 *
 * Vive fora do React, ao lado do ScreenCaptureManager. Ao iniciar a análise,
 * a página inicia SEPARADAMENTE: MediaStream (captura), T4 (análise),
 * MediaRecorder (este manager) e a sessão de gravação no banco.
 *
 * GRAVANDO só é verdadeiro quando os TRÊS fatos existem:
 *   MediaRecorder.state === "recording"
 *   + primeiro chunk realmente persistido no backend
 *   + sessão criada no banco.
 *
 * Chunks de ~2 s são enviados progressivamente (nunca o vídeo inteiro em RAM).
 * Se o recorder cair: RECORDER_ERROR, UMA tentativa de restart com o MESMO
 * sessionId em novo segmento, sem apagar os segmentos anteriores.
 */
class ScreenRecordingManager {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private uploadQueue: Promise<void> = Promise.resolve();
  private chunkIndex = 0;
  private chunkStartedAt = 0;
  private restartAttempted = false;
  private analysisActive = false;
  private stopResolvers: Array<() => void> = [];

  private state: RecordingManagerState = {
    sessionId: null,
    status: "IDLE",
    recorderState: null,
    dbSessionCreated: false,
    firstChunkSaved: false,
    chunksSaved: 0,
    bytesSaved: 0,
    lastChunkAt: null,
    segment: 0,
    error: null,
    startedAt: null,
  };
  private subscribers = new Set<() => void>();

  getState(): RecordingManagerState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  private setState(patch: Partial<RecordingManagerState>): void {
    this.state = { ...this.state, ...patch };
    // Regra do status visível: os três fatos reais, nunca otimismo de UI.
    // Estados TERMINAIS/finais nunca são recomputados de volta para GRAVANDO
    // por um chunk atrasado da fila.
    const recomputable =
      this.state.status === "STARTING" ||
      this.state.status === "GRAVANDO" ||
      this.state.status === "RECORDER_ERROR";
    if (recomputable) {
      const recording =
        this.state.recorderState === "recording" &&
        this.state.firstChunkSaved &&
        this.state.dbSessionCreated;
      if (recording) {
        this.state = { ...this.state, status: "GRAVANDO" };
      } else if (this.state.status === "GRAVANDO") {
        this.state = { ...this.state, status: "STARTING" };
      }
    }
    for (const listener of this.subscribers) listener();
  }

  setAnalysisActive(active: boolean): void {
    this.analysisActive = active;
  }

  async start(input: {
    stream: MediaStream;
    sessionId: string;
    liveSessionId?: string | null;
    asset?: string | null;
  }): Promise<void> {
    if (typeof MediaRecorder === "undefined") {
      this.setState({
        status: this.analysisActive ? "ANALISE_ATIVA_GRAVACAO_FALHOU" : "FALHOU",
        recorderState: "unavailable",
        error: "MediaRecorder não suportado neste navegador.",
      });
      return;
    }
    this.stop();
    this.stream = input.stream;
    this.chunkIndex = 0;
    this.restartAttempted = false;
    this.setState({
      sessionId: input.sessionId,
      status: "STARTING",
      recorderState: null,
      dbSessionCreated: false,
      firstChunkSaved: false,
      chunksSaved: 0,
      bytesSaved: 0,
      lastChunkAt: null,
      segment: 0,
      error: null,
      startedAt: Date.now(),
    });

    try {
      const response = await fetch("/api/recording/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: input.sessionId,
          liveSessionId: input.liveSessionId ?? null,
          asset: input.asset ?? null,
          mimeType: this.pickMimeType(),
          startedAt: Date.now(),
        }),
      });
      if (!response.ok) throw new Error(`Sessão de gravação HTTP ${response.status}`);
      this.setState({ dbSessionCreated: true });
    } catch (error) {
      this.fail(
        `Banco indisponível para a gravação: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    this.startRecorder(input.sessionId, 0);
  }

  private pickMimeType(): string {
    if (typeof MediaRecorder === "undefined") return "video/webm";
    const candidates = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    for (const candidate of candidates) {
      if (MediaRecorder.isTypeSupported?.(candidate)) return candidate;
    }
    return "video/webm";
  }

  private startRecorder(sessionId: string, segment: number): void {
    if (!this.stream) return;
    try {
      const recorder = new MediaRecorder(this.stream, { mimeType: this.pickMimeType() });
      this.recorder = recorder;
      this.chunkStartedAt = Date.now();
      // Guardas de recorder OBSOLETO: após um restart, os handlers do recorder
      // antigo ainda podem disparar (onstop tardio) — eles não podem derrubar
      // o estado do recorder novo.
      recorder.ondataavailable = (event) => {
        if (this.recorder === recorder) this.onChunk(sessionId, segment, event);
      };
      recorder.onerror = () => {
        if (this.recorder === recorder) this.onRecorderError(sessionId, segment);
      };
      recorder.onstop = () => {
        if (this.recorder === recorder) this.setState({ recorderState: "inactive" });
        for (const resolve of this.stopResolvers.splice(0)) resolve();
      };
      recorder.start(CHUNK_MS);
      this.setState({ recorderState: recorder.state, segment });
      void this.reportState({ recorderState: recorder.state, segment });
    } catch (error) {
      this.fail(
        `MediaRecorder falhou ao iniciar: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private onChunk(sessionId: string, segment: number, event: BlobEvent): void {
    const blob = event.data;
    const startedAt = this.chunkStartedAt;
    const endedAt = Date.now();
    this.chunkStartedAt = endedAt;
    if (!blob || blob.size === 0) return;
    const index = this.chunkIndex++;
    // Fila sequencial: preserva a ordem dos chunks e nunca acumula o vídeo em RAM.
    this.uploadQueue = this.uploadQueue
      .then(async () => {
        const send = async () => {
          const query = new URLSearchParams({
            sessionId,
            index: String(index),
            segment: String(segment),
            startedAt: String(startedAt),
            endedAt: String(endedAt),
            mimeType: blob.type || this.pickMimeType(),
          });
          const response = await fetch(`/api/recording/chunks?${query.toString()}`, {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: blob,
          });
          if (!response.ok) throw new Error(`chunk HTTP ${response.status}`);
        };
        try {
          await send();
        } catch {
          // UMA retentativa antes de desistir: uma oscilação de rede não pode
          // abrir buraco no manifesto silenciosamente.
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          await send();
        }
        this.setState({
          firstChunkSaved: true,
          chunksSaved: this.state.chunksSaved + 1,
          bytesSaved: this.state.bytesSaved + blob.size,
          lastChunkAt: endedAt,
        });
      })
      .catch((error) => {
        this.setState({
          error: `Falha ao persistir chunk ${index} (retentado 1x): ${error instanceof Error ? error.message : String(error)}`,
        });
      });
  }

  private onRecorderError(sessionId: string, segment: number): void {
    this.setState({ status: "RECORDER_ERROR", error: "MediaRecorder reportou erro." });
    void this.reportState({ status: "RECORDER_ERROR", error: "MediaRecorder reportou erro." });
    if (!this.restartAttempted && this.stream?.active) {
      // UMA tentativa de restart: mesmo sessionId, novo segmento, chunks
      // anteriores preservados em disco.
      this.restartAttempted = true;
      this.startRecorder(sessionId, segment + 1);
      return;
    }
    this.fail("Gravador caiu e o restart único também falhou.");
  }

  private fail(message: string): void {
    this.setState({
      status: this.analysisActive ? "ANALISE_ATIVA_GRAVACAO_FALHOU" : "FALHOU",
      error: message,
    });
    if (this.state.sessionId) {
      void this.reportState({ status: "FAILED", error: message, recorderState: "inactive" });
    }
  }

  private async reportState(patch: {
    recorderState?: string;
    status?: string;
    error?: string | null;
    segment?: number;
  }): Promise<void> {
    if (!this.state.sessionId) return;
    try {
      await fetch("/api/recording/state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: this.state.sessionId, ...patch }),
      });
    } catch {
      // Estado é best-effort; o manifesto de chunks continua sendo a verdade.
    }
  }

  /** Evento T4 sincronizado (tempo real + tempo do gráfico) na sessão atual. */
  logEvent(type: string, chartTimestamp: number | null, payload: unknown): void {
    const sessionId = this.state.sessionId;
    if (!sessionId || !this.state.dbSessionCreated) return;
    void fetch("/api/recording/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        realTimestamp: Date.now(),
        chartTimestamp,
        type,
        payload,
      }),
    }).catch(() => undefined);
  }

  /** STOP: força o último dataavailable, drena a fila e valida bytes>0 no backend. */
  async finish(): Promise<void> {
    const sessionId = this.state.sessionId;
    const recorder = this.recorder;
    if (!sessionId) return;
    this.setState({ status: "FINALIZANDO" });
    if (recorder && recorder.state !== "inactive") {
      const stopped = new Promise<void>((resolve) => this.stopResolvers.push(resolve));
      try {
        recorder.requestData();
        recorder.stop();
      } catch {
        // recorder já morto — segue para a finalização com o que foi salvo.
      }
      await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, 4_000))]);
    }
    await this.uploadQueue;
    try {
      const response = await fetch("/api/recording/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, endedAt: Date.now() }),
      });
      const payload = (await response.json()) as { status?: string; error?: string | null };
      this.setState({
        status: payload.status === "COMPLETED" ? "FINALIZADA" : "FALHOU",
        error: payload.error ?? null,
      });
    } catch (error) {
      this.setState({
        status: "FALHOU",
        error: `Falha ao finalizar gravação: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    this.recorder = null;
    this.stream = null;
  }

  /** Aborta sem finalizar (ex.: troca de fonte). Não apaga nada já salvo. */
  stop(): void {
    if (this.recorder && this.recorder.state !== "inactive") {
      try {
        this.recorder.stop();
      } catch {
        // já parado
      }
    }
    this.recorder = null;
  }
}

export const screenRecordingManager = new ScreenRecordingManager();
