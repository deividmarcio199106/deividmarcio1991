import { FrameProcessor, type FrameRead } from "./frameProcessor";
import { startScreenCapture, type CaptureHandle } from "./screenCapture";

export type ChartCaptureStatus = "sem-fonte" | "aguardando-confirmacao" | "capturando" | "pausado";

export interface CaptureManagerState {
  status: ChartCaptureStatus;
  fps: number;
  resolution: string | null;
  lastFrameAt: number | null;
  error: string | null;
  sourceLabel: string | null;
}

const VISION_INTERVAL_MS = 500;

/**
 * SCREEN CAPTURE MANAGER — singleton GLOBAL, fora do ciclo de vida do React.
 *
 * O MediaStream, o elemento <video> de processamento e o loop de frames vivem
 * neste módulo, não em nenhuma página. Trocar de rota
 * (/ /backtest /operacao-ao-vivo /gerenciamento /aprendizado /biblioteca
 * /configuracoes) não para a captura, não zera candles/contexto e não reinicia
 * o T4 — os consumidores apenas se inscrevem/desinscrevem dos frames.
 *
 * Latest-frame-wins: o loop amostra sempre o frame ATUAL do <video>; frames
 * visuais intermediários/atrasados são naturalmente descartados (e frames
 * idênticos são deduplicados por hash no FrameProcessor). A ordem dos candles
 * fechados é preservada pelos reconstrutores, nunca pelo frame.
 *
 * Sem coordenadas fixas: todo o processamento downstream usa frações da
 * largura/altura do frame, então Profit movido/redimensionado/maximizado e
 * zoom 50–125% continuam legíveis.
 */
class ScreenCaptureManager {
  /** Compatível com RefObject<HTMLVideoElement>: consumidores usam .current. */
  readonly videoRef: { current: HTMLVideoElement | null } = { current: null };

  private capture: CaptureHandle | null = null;
  private processor: FrameProcessor | null = null;
  /** Remove os listeners da track ATUAL — preenchido a cada selectSource. */
  private trackCleanup: (() => void) | null = null;
  private visionTimer: ReturnType<typeof setInterval> | null = null;
  private fpsTimer: ReturnType<typeof setInterval> | null = null;
  private frameCounter = 0;
  private processingFrame = false;
  private mutedPause = false;

  private state: CaptureManagerState = {
    status: "sem-fonte",
    fps: 0,
    resolution: null,
    lastFrameAt: null,
    error: null,
    sourceLabel: null,
  };

  private frameSubscribers = new Set<(read: FrameRead) => void>();
  private stateSubscribers = new Set<() => void>();

  getState(): CaptureManagerState {
    return this.state;
  }

  subscribeState(listener: () => void): () => void {
    this.stateSubscribers.add(listener);
    return () => this.stateSubscribers.delete(listener);
  }

  subscribeFrames(listener: (read: FrameRead) => void): () => void {
    this.frameSubscribers.add(listener);
    return () => this.frameSubscribers.delete(listener);
  }

  private setState(patch: Partial<CaptureManagerState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.stateSubscribers) listener();
  }

  private ensureVideo(): HTMLVideoElement | null {
    if (typeof document === "undefined") return null;
    if (!this.videoRef.current) {
      // Elemento de PROCESSAMENTO, não de preview: nunca entra no DOM visível,
      // então nenhuma página consegue destruí-lo ao desmontar.
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      this.videoRef.current = video;
    }
    return this.videoRef.current;
  }

  private clearTimers(): void {
    if (this.visionTimer) clearInterval(this.visionTimer);
    if (this.fpsTimer) clearInterval(this.fpsTimer);
    this.visionTimer = null;
    this.fpsTimer = null;
  }

  private tick = (): void => {
    const video = this.videoRef.current;
    const processor = this.processor;
    if (!video || !processor || this.processingFrame) return;
    // latest-frame-wins: se um tick ainda está processando, o frame atual é
    // simplesmente pulado — o próximo tick lê o frame mais novo do vídeo.
    this.processingFrame = true;
    try {
      const read = processor.process(video);
      if (!read) return;
      this.frameCounter++;
      this.setState({ lastFrameAt: read.t, resolution: `${read.width}×${read.height}` });
      for (const listener of this.frameSubscribers) listener(read);
    } finally {
      this.processingFrame = false;
    }
  };

  private beginProcessing(): void {
    this.clearTimers();
    this.visionTimer = setInterval(this.tick, VISION_INTERVAL_MS);
    this.fpsTimer = setInterval(() => {
      this.setState({ fps: this.frameCounter });
      this.frameCounter = 0;
    }, 1000);
    this.setState({ status: "capturando", error: null });
  }

  async selectSource(): Promise<void> {
    this.setState({ error: null });
    try {
      const handle = await startScreenCapture();
      // Reseleção: os listeners da track ANTIGA saem junto com ela (B8).
      this.trackCleanup?.();
      this.trackCleanup = null;
      this.capture?.stop();
      this.clearTimers();
      this.capture = handle;
      this.processor = new FrameProcessor();
      const track = handle.stream.getVideoTracks()[0];
      this.setState({ sourceLabel: track?.label || "Janela compartilhada" });

      const video = this.ensureVideo();
      if (video) {
        video.srcObject = handle.stream;
        await video.play();
      }
      /*
       * LISTENERS NOMEADOS E REMOVÍVEIS (auditoria sênior, B8). As closures
       * anônimas ficavam presas à track VELHA depois do stop(): um "ended"
       * tardio da track antiga chamava this.stop() em cima da SESSÃO NOVA
       * (switchSource) e derrubava um compartilhamento saudável. Agora cada
       * seleção registra os seus e o stop() os remove — evento de track morta
       * não alcança mais o estado vivo.
       */
      const aoEncerrar = () =>
        this.stop("O compartilhamento foi encerrado. Selecione novamente a janela do gráfico.");
      const aoMutar = () => {
        this.mutedPause = true;
        this.clearTimers();
        this.setState({
          status: "pausado",
          error: "A janela deixou de fornecer frames. Restaure-a ou selecione novamente.",
        });
      };
      // Janela restaurada volta a fornecer frames: a pausa causada pelo mute
      // se desfaz sozinha (a mensagem de erro prometia exatamente isso).
      const aoDesmutar = () => {
        if (this.mutedPause && this.capture) {
          this.mutedPause = false;
          this.beginProcessing();
        }
      };
      track?.addEventListener("ended", aoEncerrar);
      track?.addEventListener("mute", aoMutar);
      track?.addEventListener("unmute", aoDesmutar);
      this.trackCleanup = () => {
        track?.removeEventListener("ended", aoEncerrar);
        track?.removeEventListener("mute", aoMutar);
        track?.removeEventListener("unmute", aoDesmutar);
      };
      this.setState({ status: "aguardando-confirmacao" });
    } catch (error) {
      this.setState({
        error: error instanceof Error ? error.message : "Falha ao iniciar a captura.",
        status: "sem-fonte",
      });
    }
  }

  confirmPreview(): void {
    if (!this.capture) return;
    this.beginProcessing();
  }

  async switchSource(): Promise<void> {
    this.stop();
    await this.selectSource();
  }

  pause(): void {
    if (!this.capture) return;
    this.clearTimers();
    this.setState({ status: "pausado" });
  }

  resume(): void {
    if (!this.capture) return;
    this.beginProcessing();
  }

  stop(reason?: string): void {
    this.clearTimers();
    // Os listeners da track saem ANTES de a track morrer: evento póstumo da
    // sessão encerrada não pode alcançar a próxima (B8).
    this.trackCleanup?.();
    this.trackCleanup = null;
    this.capture?.stop();
    this.capture = null;
    this.processor = null;
    if (this.videoRef.current) this.videoRef.current.srcObject = null;
    this.frameCounter = 0;
    this.setState({
      status: "sem-fonte",
      fps: 0,
      resolution: null,
      lastFrameAt: null,
      sourceLabel: null,
      error: reason ?? null,
    });
  }

  /** O MediaStream ativo — usado pela gravação (MediaRecorder). */
  stream(): MediaStream | null {
    return this.capture?.stream ?? null;
  }
}

export const screenCaptureManager = new ScreenCaptureManager();
