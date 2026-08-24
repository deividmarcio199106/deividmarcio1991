import {
  classifyFrame,
  emptyFreshnessMemory,
  type FrameFreshness,
  type FreshnessMemory,
} from "./frameFreshness";
import { cropLuma, type FrameRoi, lumaFromRgba, perceptualHash } from "./frameHash";
import { detectClipping, type ClippingReport } from "@/lib/vision/viewportChange";
import { detectChartBounds, type ChartBounds } from "@/lib/vision/chartRoi";
import { screenCaptureManager } from "./screenCaptureManager";

/**
 * A ÁREA DO GRÁFICO dentro do frame capturado (§4).
 *
 * Frações conservadoras: 8% do topo e 10% da direita ficam de fora. É onde
 * vivem abas, título, cronômetro do candle, eixo de preço e book — tudo que
 * muda sem que uma barra se mexa. Recortar aqui é o que torna a comparação
 * uma pergunta sobre o MERCADO, e não sobre a interface.
 */
const AREA_DO_GRAFICO: FrameRoi = { x: 0, y: 0.08, width: 0.9, height: 0.86 };

/**
 * MONITOR OCULTO DE MERCADO — um print real por minuto, OBRIGATORIAMENTE.
 *
 * DECISÃO DO OPERADOR (18/08, depois de testar o modo por evento no replay):
 * a captura é por CADÊNCIA FIXA de 60s, independente de o gráfico ter mudado.
 * A lógica de "capturar só quando houver mudança relevante" foi REMOVIDA —
 * não escondida por flag: removida. O contrato é
 *
 *   selecionar 1x → stream contínuo oculto → 60s → capturar → analisar →
 *   marcar → continuar → 60s → repetir indefinidamente.
 *
 * POR QUE UM SINGLETON FORA DO REACT
 * O ciclo não pode morrer porque uma página desmontou. O vídeo já vive no
 * `screenCaptureManager` (elemento de processamento fora do DOM visível,
 * com play() após srcObject — nada aqui cria um segundo vídeo, que seria a
 * doença dos dois motores). Este módulo é o dono do RESTO: scheduler,
 * heartbeat, fila e estado — refs de módulo, imunes a re-render, com um
 * timer de cada tipo no máximo (begin() limpa antes de criar).
 *
 * SCHEDULER ANCORADO NO CANDLE, NÃO NUM CRONÔMETRO
 * O alvo de cada ciclo é a VIRADA DO MINUTO seguinte (+ uma folga curta para o
 * Profit desenhar a barra nova), recalculado do relógio a cada disparo. Somar
 * 60s ao alvo anterior — como era antes — parece equivalente e não é: qualquer
 * atraso de um ciclo (GPU lenta, aba em segundo plano) deslocava TODOS os
 * seguintes, e o print passava a cair no meio do candle em vez de logo após a
 * virada. Ancorado no relógio, um ciclo atrasado não contamina o próximo.
 *
 * UM PRINT POR CANDLE
 * A chave é o `candleTime` (piso do minuto). Dois disparos dentro do mesmo
 * minuto produzem UMA captura principal; o segundo é contado como duplicata
 * ignorada e dito no estado. Trocar de ativo/timeframe reseta a referência.
 *
 * FILA DE UM SLOT
 * A IA pode demorar mais que um minuto. O minuto seguinte CAPTURA normalmente
 * (o print existe, entra na contagem e na tela), mas só o pendente MAIS
 * RECENTE espera a vez — nunca duas requests simultâneas, nunca analisar
 * foto velha tendo uma mais nova.
 */

export const CAPTURE_PERIOD_MS = 60_000;

/**
 * ATRASO MÍNIMO APÓS A VIRADA DO MINUTO.
 *
 * Capturar exatamente em :00 pega o Profit no meio do redesenho — o candle
 * novo ainda não existe no pixel. Esta folga é o tempo de o gráfico renderizar
 * a barra nova; é curta de propósito, porque cada milissegundo aqui é atraso
 * entre o que o operador vê no Profit e o que o Analisador leu.
 */
export const RENDER_DELAY_MS = 900;

/**
 * Acima disto a captura não representa mais o "agora" do candle.
 *
 * Um print tirado a 20s da virada ainda descreve o mesmo candle, mas já não é
 * o instante da decisão — e a tela precisa DIZER isso em vez de fingir tempo
 * real. Não é erro: é sincronismo perdido, recuperável no próximo candle.
 */
export const ATRASO_MAXIMO_MS = 15_000;

/**
 * Estado de sincronismo entre a virada do candle e a captura.
 *
 * `AGUARDANDO_FRAME` é o do §5: a captura aconteceu na hora certa, mas trouxe
 * a MESMA imagem. Sincronismo de relógio sem imagem nova não é sincronismo —
 * e era esse o rótulo que a tela mostrava durante as dez capturas congeladas.
 */
export type SyncState = "SINCRONIZADO" | "ATRASADO" | "PROCESSANDO" | "AGUARDANDO_FRAME";

/**
 * O instante em que o candle DESTA captura abriu.
 *
 * Piso do minuto: capturando logo após a virada, o minuto corrente É o candle
 * corrente. Uma captura atrasada (fila ocupada) continua pertencendo ao candle
 * em que ela realmente aconteceu — jamais ao candle que ela "deveria" ter
 * pego, porque a imagem mostra o mercado do momento do clique, não do alvo.
 */
export function candleTimeOf(at: number, periodMs = CAPTURE_PERIOD_MS): number {
  return Math.floor(at / periodMs) * periodMs;
}

/** O alvo da próxima captura: a virada do minuto seguinte + a folga de render. */
export function nextCandleDueAt(now: number, periodMs = CAPTURE_PERIOD_MS): number {
  return Math.floor(now / periodMs) * periodMs + periodMs + RENDER_DELAY_MS;
}

/** Batida do heartbeat/contador. Só observa — NUNCA chama IA. */
const HEARTBEAT_MS = 1_000;
/** Vídeo vivo mas currentTime parado além disto = stream congelado. */
const FROZEN_AFTER_MS = 5_000;
/** Trava de segurança: análise pendurada além disto libera a fila. */
/**
 * Teto de espera por UMA análise. Exportado porque o teste de deadlock precisa
 * avançar o relógio exatamente até aqui — redigitar 180_000 no teste criaria o
 * segundo número que este arquivo existe para impedir.
 */
export const ANALYSIS_TIMEOUT_MS = 180_000;

export type MonitorStage =
  "OCIOSO" | "MONITORANDO" | "CAPTURANDO" | "ANALISANDO" | "PAUSADO" | "ENCERRADO";

export interface CaptureMeta {
  reason: string;
  code: "CICLO_60S" | "MANUAL";
  /** Instante da captura. Mantido pelo nome antigo por compatibilidade. */
  at: number;
  /**
   * IDENTIDADE DA CAPTURA — a chave que amarra imagem, análise e tela.
   *
   * Sem ela era possível (e aconteceu) exibir a imagem #74 com a análise #73:
   * a análise antiga terminava depois e sobrescrevia o estado visual do print
   * mais novo. Todo resultado carrega o `captureId` de origem, e a UI só
   * aplica o que pertence à captura que ela está exibindo.
   */
  captureId: string;
  capturedAt: number;
  /** Início do candle a que esta captura pertence. */
  candleTime: number;
  /** capturedAt − candleTime. Quanto o print está atrás da virada. */
  captureDelayMs: number;
  sync: SyncState;
  /**
   * §7 — enquadramento cortado nesta captura. TELEMETRIA, não gate.
   *
   * Viaja com a captura porque foi medido nos pixels DELA, na mesma faixa
   * geométrica do hash. Quem consome decide o que fazer — hoje, registrar.
   */
  clipping: ClippingReport;
  /** Moldura do gráfico e dimensões do frame — §4 do operador. */
  chartBounds: ChartBounds;
  rawWidth: number;
  rawHeight: number;
  normalizedWidth: number;
  normalizedHeight: number;
  devicePixelRatio: number | null;
}

export interface MarketMonitorState {
  stage: MonitorStage;
  /** Track viva e frames fluindo (heartbeat: live + advancing + dimensões). */
  streamOk: boolean;
  frozen: boolean;
  /** Segundos até a próxima captura automática. Null fora do ciclo. */
  secondsToNext: number | null;
  lastCaptureAt: number | null;
  lastReason: string | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  /** Prints REAIS gerados (validação passou). Falha de captura não conta. */
  captures: number;
  analysisBusy: boolean;
  needsReselect: boolean;
  /** Candle da última captura, e o quanto ela ficou atrás da virada. */
  lastCandleTime: number | null;
  lastCaptureDelayMs: number | null;
  lastCaptureId: string | null;
  sync: SyncState;
  /** Capturas ignoradas por já existir print daquele candle (§8). */
  duplicatesSkipped: number;
  /** Frescor da última captura (§5). Null antes da primeira. */
  freshness: FrameFreshness | null;
  /** Capturas descartadas por serem a MESMA imagem (§3). */
  duplicateFrames: number;
}

const IDLE: MarketMonitorState = {
  stage: "OCIOSO",
  streamOk: false,
  frozen: false,
  secondsToNext: null,
  lastCaptureAt: null,
  lastReason: null,
  lastLatencyMs: null,
  lastError: null,
  captures: 0,
  analysisBusy: false,
  lastCandleTime: null,
  lastCaptureDelayMs: null,
  lastCaptureId: null,
  sync: "SINCRONIZADO",
  duplicatesSkipped: 0,
  freshness: null,
  duplicateFrames: 0,
  needsReselect: false,
};

/**
 * O rótulo de sincronismo que a tela mostra (§7).
 *
 * PROCESSANDO é estado da FILA, não da captura — por isso é derivado aqui e
 * não gravado no estado: guardá-lo apagaria o `sync` real da última captura, e
 * o operador perderia a informação de que o print veio atrasado assim que a
 * análise seguinte começasse.
 */
export function syncLabel(state: MarketMonitorState): SyncState {
  /*
   * §5 — IMAGEM REPETIDA NUNCA É "SINCRONIZADO".
   *
   * Vem ANTES do PROCESSANDO: com a fonte congelada, o operador precisa saber
   * que parou de chegar gráfico novo, e não que "está processando" — uma
   * espera que nunca termina com cara de trabalho em curso é pior que erro
   * nenhum. Este é o ponto único de derivação do rótulo, então a regra vale
   * para toda a UI de uma vez.
   */
  if (state.freshness !== null && state.freshness.captureStatus !== "FRESH") {
    return "AGUARDANDO_FRAME";
  }
  if (state.analysisBusy) return "PROCESSANDO";
  return state.sync;
}

export type CaptureResult =
  | {
      ok: true;
      dataUrl: string;
      frameHash: string | null;
      /** §7 — telemetria de enquadramento. NÃO é gate; ver captureFrameFromManager. */
      clipping: ClippingReport;
      /** A moldura do gráfico neste frame — a régua usa como sinal de mudança. */
      chartBounds: ChartBounds;
      /*
       * AS DIMENSÕES, CRUAS E NORMALIZADAS, SEPARADAS.
       *
       * Medido na sessão de 20/08: a captura alternou 1366×720 e 1968×1440
       * TRINTA E UMA vezes em 83 frames. Com a resolução do screenshot como
       * assinatura de viewport, aquilo vira 31 mudanças de enquadramento — e
       * o portão de estabilidade suspenderia a confirmação quase o pregão
       * inteiro. A mudança REAL se mede pela moldura do gráfico; a resolução
       * fica registrada para o diagnóstico saber de onde veio o ruído.
       */
      rawWidth: number;
      rawHeight: number;
      normalizedWidth: number;
      normalizedHeight: number;
      devicePixelRatio: number | null;
    }
  | { ok: false; problem: string };

/**
 * Congela o frame atual do vídeo oculto, com as validações do contrato:
 * readyState>=2, dimensões reais, track viva, imagem não uniforme (preta/
 * vazia) e blob plausível. Resolução NATIVA do vídeo — a escala e os candles
 * precisam continuar legíveis para o OCR; só rebaixa se estourar o limite de
 * upload do servidor.
 */
export function captureFrameFromManager(): CaptureResult {
  const video = screenCaptureManager.videoRef.current;
  const track = screenCaptureManager.stream()?.getVideoTracks()[0] ?? null;
  if (!video) return { ok: false, problem: "vídeo indisponível" };
  if (track === null || track.readyState !== "live") {
    return { ok: false, problem: "track de vídeo não está viva" };
  }
  if (video.readyState < 2) return { ok: false, problem: "vídeo ainda sem dados (readyState < 2)" };
  if (!video.videoWidth || !video.videoHeight) {
    return { ok: false, problem: "vídeo com dimensão 0x0" };
  }

  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return { ok: false, problem: "canvas 2D indisponível" };
  context.drawImage(video, 0, 0, canvas.width, canvas.height);

  // Frame preto/vazio: variância de luminância ~zero em amostra espalhada.
  const sample = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let i = 0; i < sample.length; i += 997 * 4) {
    const luma = 0.299 * sample[i]! + 0.587 * sample[i + 1]! + 0.114 * sample[i + 2]!;
    sum += luma;
    sumSq += luma * luma;
    n += 1;
  }
  const mean = sum / Math.max(1, n);
  if (sumSq / Math.max(1, n) - mean * mean < 4) {
    return { ok: false, problem: "frame uniforme (preto/vazio)" };
  }

  let dataUrl = canvas.toDataURL("image/jpeg", 0.92);
  // O server function recusa >12 MB; um 4K muito denso pode passar disso.
  // Rebaixar para 1920 mantém candles/escala legíveis e cabe com folga.
  if (dataUrl.length > 11_000_000 && video.videoWidth > 1920) {
    const scale = 1920 / video.videoWidth;
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const smaller = canvas.getContext("2d");
    if (smaller) {
      smaller.drawImage(video, 0, 0, canvas.width, canvas.height);
      dataUrl = canvas.toDataURL("image/jpeg", 0.9);
    }
  }
  if (dataUrl.length < 20_000) return { ok: false, problem: "blob de captura implausível" };

  /*
   * §3 — A ASSINATURA SAI DESTA MESMA LEITURA DE PIXELS.
   *
   * `sample` já é o `getImageData` do frame inteiro, lido acima para a
   * variância de luminância. Hashear aqui não custa uma segunda passada pelo
   * bitmap — e é o que permite ao ciclo saber, ANTES de gastar 6 a 12 segundos
   * de GPU, que esta captura é a mesma fotografia da anterior.
   *
   * O recorte exclui a faixa superior (abas, título, cronômetro do candle) e a
   * coluna da direita (eixo de preço, book): é ali que mora o que muda sem o
   * mercado mudar. Mascarar é a defesa correta — tolerância grande o bastante
   * para engolir o relógio engoliria também uma barra curta.
   */
  const grade = lumaFromRgba(sample, canvas.width, canvas.height);
  const frameHash = perceptualHash(grade, AREA_DO_GRAFICO);

  /*
   * §7 — CORTE DE ENQUADRAMENTO, MEDIDO NA MESMA FAIXA.
   *
   * A faixa é GEOMÉTRICA (uma fração fixa da janela compartilhada), e é isso
   * que a torna utilizável aqui. A tentativa anterior media dentro da ROI
   * detectada por tinta — e essa é vacuosa por construção: a ROI é o envelope
   * da tinta, então a tinta encosta na borda dela sempre, em todo gráfico.
   *
   * O LIMIAR AINDA NÃO FOI VALIDADO contra a janela real do operador. Por isso
   * `detectClipping` devolve `avaliavel`, e por isso o resultado viaja como
   * TELEMETRIA: quem decide se ele vira gate é a sessão real do §45, contando
   * quantas vezes ele acusa num pregão em que nada foi cortado.
   */
  /*
   * A MOLDURA DO GRÁFICO, medida no frame INTEIRO.
   *
   * Não no recorte: `detectChartBounds` existe justamente para achar onde o
   * cromo termina, e entregar a ele um recorte já feito por fração fixa seria
   * pedir que ele confirmasse um palpite. Do frame inteiro ele responde a
   * pergunta de verdade — e a resposta é o sinal barato que diz à régua
   * quando a janela mudou, sem gastar uma leitura de eixo.
   */
  const chartBounds = detectChartBounds(grade.luma, grade.width, grade.height);
  const clipping = detectClipping(grade.luma, grade.width, grade.height);
  return {
    ok: true,
    dataUrl,
    frameHash,
    clipping,
    chartBounds,
    rawWidth: video.videoWidth,
    rawHeight: video.videoHeight,
    normalizedWidth: canvas.width,
    normalizedHeight: canvas.height,
    devicePixelRatio: typeof window === "undefined" ? null : (window.devicePixelRatio ?? null),
  };
}

interface StreamProbe {
  live: boolean;
  /** currentTime do vídeo — o "advancing" do heartbeat compara duas leituras. */
  videoTime: number | null;
  validDims: boolean;
  ended: boolean;
}

function probeManager(): StreamProbe {
  const video = screenCaptureManager.videoRef.current;
  const track = screenCaptureManager.stream()?.getVideoTracks()[0] ?? null;
  return {
    live: track?.readyState === "live",
    videoTime: video?.currentTime ?? null,
    validDims: Boolean(video?.videoWidth && video?.videoHeight),
    ended: screenCaptureManager.getState().status === "sem-fonte",
  };
}

export interface MonitorDeps {
  captureFrame: () => CaptureResult;
  probe: () => StreamProbe;
}

type Analyzer = (dataUrl: string, meta: CaptureMeta) => Promise<boolean>;

export class MarketMonitor {
  private state: MarketMonitorState = { ...IDLE };
  private readonly listeners = new Set<() => void>();
  private readonly deps: MonitorDeps;

  private analyzer: Analyzer | null = null;
  private cycleTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private nextDueAt = 0;
  private active = false;
  private paused = false;
  private busy = false;
  private pending: { dataUrl: string; meta: CaptureMeta } | null = null;
  private lastVideoTime: number | null = null;
  private lastVideoAdvanceAt = 0;
  /** Candle já capturado pelo ciclo automático — a trava do §8. */
  private lastCandleTime: number | null = null;
  /** ativo|timeframe: trocar de série RESETA a referência de candle. */
  private seriesKey = "";
  private captureSeq = 0;
  /**
   * Memória de frescor entre capturas (§5).
   *
   * Fora do estado publicado de propósito: ela é acumulativa (hash do último
   * frame ÚNICO, sequência de repetições, amostras de offset) e não deve
   * provocar render por si. O que a tela mostra é o `freshness` do passo.
   */
  private freshnessMemory: FreshnessMemory = emptyFreshnessMemory();
  private onCapture: ((dataUrl: string, meta: CaptureMeta) => void) | null = null;

  constructor(deps?: Partial<MonitorDeps>) {
    this.deps = {
      captureFrame: deps?.captureFrame ?? captureFrameFromManager,
      probe: deps?.probe ?? probeManager,
    };
  }

  getState(): MarketMonitorState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * A rota registra o fluxo completo de análise (IA→validação→histórico→DNA).
   * Aceita null para DESREGISTRAR no unmount (B8): sem isso, a closure da
   * tela morta continuava recebendo capturas e analisando para ninguém.
   */
  setAnalyzer(analyzer: Analyzer | null): void {
    this.analyzer = analyzer;
  }

  /**
   * Aviso IMEDIATO de captura — dispara ANTES da fila, sempre.
   *
   * É o que separa "a imagem apareceu" de "a análise terminou". Com a GPU
   * lenta, a análise anterior ainda está rodando quando o candle novo chega;
   * sem este gancho a tela ficava presa no print velho até a fila girar, que é
   * exatamente o atraso que o operador via. Agora a imagem entra na hora e a
   * análise alcança depois.
   */
  setOnCapture(handler: ((dataUrl: string, meta: CaptureMeta) => void) | null): void {
    this.onCapture = handler;
  }

  /**
   * Declara a série observada. Trocar de ativo ou timeframe RESETA a
   * referência de candle: o candle 10:45 do WINFUT 1min não é o candle 10:45
   * de outra série, e manter a trava atravessando a troca engoliria a primeira
   * captura da série nova como se fosse duplicata.
   */
  setSeries(asset: string, timeframe: string): void {
    const chave = `${asset}|${timeframe}`;
    if (chave === this.seriesKey) return;
    this.seriesKey = chave;
    this.lastCandleTime = null;
  }

  private patch(partial: Partial<MarketMonitorState>): void {
    this.state = { ...this.state, ...partial };
    /*
     * CADA ASSINANTE NO SEU try/catch (auditoria sênior, B8). Um subscriber
     * que lança não pode: (1) impedir os DEMAIS assinantes de ver o estado;
     * (2) estourar para dentro do monitor — um patch() dentro do finally de
     * runAnalysis que lançasse pularia o `busy = false` e congelaria a fila
     * para sempre. Tela quebrada é defeito da tela; o ciclo não morre por ela.
     */
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (problem) {
        console.error(`[marketMonitor] assinante lançou no patch: ${String(problem)}`);
      }
    }
  }

  /**
   * Liga o ciclo — a SELEÇÃO da janela é do chamador (é gesto do operador).
   * Idempotente: chamar com o ciclo vivo só reancora a contagem; nunca
   * existe segundo timer (o buraco clássico do re-render com setInterval).
   */
  begin(): void {
    this.clearTimers();
    this.active = true;
    this.paused = false;
    this.pending = null;
    // Estado de lock SEMPRE zerado no começo (B8): um begin() depois de um
    // stop() no meio de uma análise não pode herdar busy=true — a sessão
    // nova nasceria com a fila já "ocupada" por um trabalho que morreu.
    this.busy = false;
    this.nextDueAt = nextCandleDueAt(Date.now());
    this.patch({
      ...IDLE,
      stage: "MONITORANDO",
      secondsToNext: Math.round(CAPTURE_PERIOD_MS / 1000),
    });
    this.scheduleCycle();
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
  }

  pause(): void {
    if (!this.active) return;
    this.paused = true;
    if (this.cycleTimer) clearTimeout(this.cycleTimer);
    this.cycleTimer = null;
    this.patch({ stage: "PAUSADO", secondsToNext: null });
  }

  resume(): void {
    if (!this.active) return;
    this.paused = false;
    // Contagem recomeça CHEIA: retomar não é disparar.
    this.nextDueAt = nextCandleDueAt(Date.now());
    this.patch({ stage: this.busy ? "ANALISANDO" : "MONITORANDO" });
    this.scheduleCycle();
  }

  /** Captura imediata SEM tocar no ciclo automático — o alvo de 60s fica onde está. */
  analyzeNow(): void {
    if (!this.active) return;
    this.captureCycle({ reason: "análise manual solicitada pelo operador", code: "MANUAL" });
  }

  stop(reason: MonitorStage = "ENCERRADO"): void {
    this.active = false;
    this.paused = false;
    this.pending = null;
    // O lock morre com a sessão (B8). A análise em voo, se existir, ainda
    // termina — mas encontra active=false e não desova em tela nenhuma.
    this.busy = false;
    this.clearTimers();
    this.patch({ stage: reason, secondsToNext: null, streamOk: false, frozen: false });
  }

  /** O compartilhamento morreu por fora (onended) — parar e pedir nova seleção. */
  streamEnded(): void {
    if (!this.active) return;
    this.stop();
    this.patch({ needsReselect: true, lastError: null });
  }

  private clearTimers(): void {
    if (this.cycleTimer) clearTimeout(this.cycleTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.cycleTimer = null;
    this.heartbeatTimer = null;
  }

  private scheduleCycle(): void {
    if (this.cycleTimer) clearTimeout(this.cycleTimer);
    const delay = Math.max(0, this.nextDueAt - Date.now());
    this.cycleTimer = setTimeout(() => this.fireCycle(), delay);
  }

  private fireCycle(): void {
    if (!this.active || this.paused) return;
    /*
     * REANCORAR E REAGENDAR MORAM NUM finally (B8): uma exceção dentro do
     * ciclo de captura (dependência de frame, assinante hostil) não pode
     * matar o AGENDAMENTO — sem o finally, o timer nunca renasceria e o
     * monitor viraria um cadáver com stage "MONITORANDO" na tela.
     */
    try {
      this.captureCycle({ reason: "virada de candle", code: "CICLO_60S" });
    } catch (problem) {
      this.patch({
        lastError: `ciclo falhou: ${problem instanceof Error ? problem.message : String(problem)}`,
      });
    } finally {
      // Reancorado no RELÓGIO, não somado ao alvo anterior: um ciclo atrasado
      // não empurra os seguintes para o meio do candle.
      this.nextDueAt = nextCandleDueAt(Date.now());
      this.scheduleCycle();
    }
  }

  private captureCycle(base: Pick<CaptureMeta, "reason" | "code">): void {
    const agora = Date.now();
    const candleTime = candleTimeOf(agora);

    /*
     * §8 — UM print principal por candle. Um segundo disparo automático dentro
     * do mesmo minuto (timer reagendado, aba voltando do background) não gera
     * print: ele é contado como duplicata e DITO, nunca engolido em silêncio.
     * Captura manual não passa por aqui — ela é do operador, não do ciclo.
     */
    if (base.code === "CICLO_60S" && this.lastCandleTime === candleTime) {
      this.patch({ duplicatesSkipped: this.state.duplicatesSkipped + 1 });
      return;
    }

    this.patch({ stage: "CAPTURANDO" });
    const shot = this.deps.captureFrame();
    if (!shot.ok) {
      // Falha de captura NÃO é print: não conta, não vai à fila, e o motivo
      // fica na tela. O próximo candle tenta de novo — o ciclo não para.
      this.patch({
        stage: this.busy ? "ANALISANDO" : this.paused ? "PAUSADO" : "MONITORANDO",
        lastError: `captura falhou: ${shot.problem}`,
      });
      return;
    }

    const capturedAt = Date.now();

    /*
     * §3–§5 — FRAME QUE NÃO É NOVO NÃO VIRA ANÁLISE.
     *
     * Este é o ponto que faltava ligar: os módulos de assinatura e frescor
     * existiam, estavam testados, e ninguém os chamava. Sem esta trava, o
     * caso 031–040 da sessão de 19/08 se repete — dez capturas de uma janela
     * congelada viram dez inferências de 6 a 12 segundos, dez linhas de
     * histórico e dez chances de a máquina "evoluir" sobre um pixel parado.
     *
     * Captura MANUAL não passa por aqui, pela mesma razão de sempre: o botão
     * é gesto do operador, e engolir o pedido dele transformaria um botão em
     * silêncio.
     */
    const passoFrescor = classifyFrame(this.freshnessMemory, {
      capturedAt,
      // O horário do gráfico ainda não é lido no caminho da captura: sem ele,
      // a idade real não é afirmada (§6 trata isso como telemetria).
      marketFrameAt: null,
      frameHash: shot.frameHash,
      /*
       * O `frozen` do heartbeat NÃO entra aqui — de propósito.
       *
       * Ele mede o elemento de vídeo (currentTime parado), não a imagem. Um
       * vídeo de verdade congelado produz frames IDÊNTICOS, e a assinatura já
       * pega isso pela evidência direta, com o motivo certo. Somar os dois
       * sinais seria punir duas vezes o mesmo fato — e faria um engasgo de
       * meio segundo do navegador bloquear a análise de um gráfico que estava
       * mudando normalmente. O `frozen` continua no estado e na tela, como
       * diagnóstico do stream.
       */
      frozen: false,
    });
    this.freshnessMemory = passoFrescor.memory;
    const frescor = passoFrescor.freshness;

    if (base.code === "CICLO_60S" && !frescor.analisavel) {
      this.patch({
        freshness: frescor,
        duplicateFrames: this.state.duplicateFrames + 1,
        // Duplicata de CONTEÚDO soma no mesmo contador que a tela já mostra —
        // para o operador a pergunta é uma só: "quantas capturas não viraram
        // análise, e por quê". O `freshness` responde o porquê.
        duplicatesSkipped: this.state.duplicatesSkipped + 1,
        stage: this.busy ? "ANALISANDO" : this.paused ? "PAUSADO" : "MONITORANDO",
        lastError: null,
      });
      // O candle é marcado mesmo assim: sem isso, o mesmo minuto tentaria de
      // novo a cada reagendamento e o contador subiria sem parar.
      if (base.code === "CICLO_60S") this.lastCandleTime = candleTime;
      return;
    }

    const captureDelayMs = capturedAt - candleTime;
    this.captureSeq += 1;
    const meta: CaptureMeta = {
      ...base,
      at: capturedAt,
      capturedAt,
      candleTime,
      captureDelayMs,
      // PROCESSANDO é estado da FILA, não da captura: quem decide isso é o
      // ciclo de análise. Aqui só existe "peguei a tempo" ou "peguei tarde".
      sync: captureDelayMs > ATRASO_MAXIMO_MS ? "ATRASADO" : "SINCRONIZADO",
      captureId: `cap_${candleTime}_${this.captureSeq}`,
      clipping: shot.clipping,
      chartBounds: shot.chartBounds,
      rawWidth: shot.rawWidth,
      rawHeight: shot.rawHeight,
      normalizedWidth: shot.normalizedWidth,
      normalizedHeight: shot.normalizedHeight,
      devicePixelRatio: shot.devicePixelRatio,
    };
    if (base.code === "CICLO_60S") this.lastCandleTime = candleTime;

    const job = { dataUrl: shot.dataUrl, meta };
    this.patch({
      captures: this.state.captures + 1,
      lastCaptureAt: capturedAt,
      lastReason: meta.reason,
      lastError: null,
      lastCandleTime: candleTime,
      lastCaptureDelayMs: captureDelayMs,
      lastCaptureId: meta.captureId,
      sync: meta.sync,
      freshness: frescor,
    });

    /*
     * A IMAGEM VAI PARA A TELA AGORA — antes da fila, antes da IA.
     * Este é o ponto que elimina o print atrasado: o que o operador vê passa a
     * ser sempre a captura mais recente, e a análise chega depois carregando o
     * `captureId` que diz a qual imagem ela pertence.
     */
    this.onCapture?.(shot.dataUrl, meta);

    if (this.busy) {
      // Só o mais novo espera: analisar foto velha com uma nova na mão é
      // gastar GPU para descrever um mercado que já não existe.
      this.pending = job;
      return;
    }
    void this.runAnalysis(job);
  }

  private async runAnalysis(job: { dataUrl: string; meta: CaptureMeta }): Promise<void> {
    this.busy = true;
    this.patch({ stage: "ANALISANDO", analysisBusy: true });
    const started = Date.now();
    let ok = false;
    try {
      if (this.analyzer === null) {
        // Sem analisador registrado (tela do print fechada antes do registro):
        // o print existiu e foi contado; a análise é declarada indisponível.
        this.patch({ lastError: "análise indisponível — abra a tela Analisar Print" });
      } else {
        // Trava de segurança: uma análise pendurada não pode congelar a fila
        // para sempre. O timeout LIBERA o ciclo; o retry fica no fluxo da rota.
        // E quando a ANÁLISE vence a corrida, o timer de 180s é LIMPO (B8):
        // antes ele sobrevivia até estourar, um vazamento por análise que em
        // sessão longa vira um relógio fantasma acordando à toa a cada ciclo.
        let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
        try {
          ok = await Promise.race([
            this.analyzer(job.dataUrl, job.meta),
            new Promise<boolean>((resolve) => {
              timeoutTimer = setTimeout(() => resolve(false), ANALYSIS_TIMEOUT_MS);
            }),
          ]);
        } finally {
          if (timeoutTimer !== null) clearTimeout(timeoutTimer);
        }
      }
    } catch (problem) {
      this.patch({ lastError: problem instanceof Error ? problem.message : String(problem) });
    }
    // A LIBERAÇÃO DO LOCK MORA NUM finally. Antes ela ficava depois do catch:
    // uma exceção dentro do próprio tratamento deixaria busy=true para sempre
    // e a fila congelada — exatamente o deadlock que este monitor jura não
    // ter. Com o finally, aconteça o que acontecer, o ciclo respira.
    try {
      if (!ok && this.state.lastError === null) {
        // Falha declarada sem exceção (validação recusou, retry esgotou): a
        // mensagem específica está na tela da rota; aqui fica o fato.
        this.patch({ lastError: "análise não concluída — veja o erro na tela" });
      }
    } finally {
      this.patch({ lastLatencyMs: Date.now() - started, analysisBusy: false });
      this.busy = false;
    }

    const next = this.pending;
    this.pending = null;
    if (next && this.active) {
      void this.runAnalysis(next);
      return;
    }
    if (this.active) {
      this.patch({ stage: this.paused ? "PAUSADO" : "MONITORANDO" });
    }
  }

  /** Observa o stream e o relógio. NUNCA chama IA — contrato do heartbeat. */
  private heartbeat(): void {
    if (!this.active) return;
    const now = Date.now();
    const probe = this.deps.probe();

    if (probe.ended) {
      this.streamEnded();
      return;
    }

    if (probe.videoTime !== null && probe.videoTime !== this.lastVideoTime) {
      this.lastVideoTime = probe.videoTime;
      this.lastVideoAdvanceAt = now;
    }
    const advancing = now - this.lastVideoAdvanceAt <= FROZEN_AFTER_MS;
    const streamOk = probe.live && probe.validDims && advancing;
    const frozen = probe.live && !advancing && this.lastVideoAdvanceAt > 0;
    if (frozen) {
      // Recuperação barata: vídeo pausado pelo navegador volta com play().
      void screenCaptureManager.videoRef.current?.play().catch(() => undefined);
    }

    this.patch({
      streamOk,
      frozen,
      secondsToNext:
        this.paused || !this.active ? null : Math.max(0, Math.ceil((this.nextDueAt - now) / 1000)),
    });
  }

  /** Só para testes: zera tudo, inclusive contadores. */
  resetForTests(): void {
    this.stop();
    this.analyzer = null;
    this.onCapture = null;
    this.state = { ...IDLE };
    this.lastVideoTime = null;
    this.lastVideoAdvanceAt = 0;
    this.lastCandleTime = null;
    this.seriesKey = "";
    this.captureSeq = 0;
    this.freshnessMemory = emptyFreshnessMemory();
  }

  /**
   * Dispara o ciclo automático AGORA, sem mexer no agendamento.
   *
   * Existe para o teste conseguir simular o disparo duplicado dentro do mesmo
   * minuto (aba voltando do background, timer reagendado) — o caso exato que a
   * chave do candle precisa recusar. `analyzeNow` não serve: ele é captura
   * MANUAL, e manual de propósito não passa pela trava de duplicata.
   */
  forceCycleForTests(): void {
    this.captureCycle({ reason: "disparo forçado (teste)", code: "CICLO_60S" });
  }
}

/** A instância da sessão — viva enquanto a aba viver, como o capture manager. */
export const marketMonitor = new MarketMonitor();
