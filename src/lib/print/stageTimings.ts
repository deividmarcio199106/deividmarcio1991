/**
 * CRONÔMETRO POR ESTÁGIO — para o atraso ter endereço.
 *
 * O DEFEITO DE MEDIÇÃO QUE ISTO CORRIGE (achado com o vídeo do operador):
 * o relógio começava quando a análise SAÍA DA FILA, não quando o print foi
 * capturado. O operador mede da captura; o sistema media do início da
 * inferência. A diferença — a espera na fila — não aparecia em lugar nenhum,
 * e ela é justamente a que EXPLODE quando uma análise passa de 60s: o candle
 * seguinte é capturado, fica esperando, e o próximo espera ainda mais. Um
 * ciclo lento contamina os seguintes, e o número que o operador vê cresce
 * enquanto o número que o sistema registra continua pequeno.
 *
 * Agora a origem é `capturedAt`. `totalUntilUiMs` mede exatamente o que o
 * operador cronometra: da captura até o painel preenchido.
 *
 * As outras leis do módulo:
 * — estágio que NÃO rodou fica `null`, nunca 0 (o oposto de "não medido" não
 *   é "rápido");
 * — `totalUntilUiMs` é o CAMINHO CRÍTICO e `totalBackgroundMs` inclui o que
 *   roda depois da tela pronta — somá-los esconderia que metade do tempo
 *   acontece com o painel já preenchido;
 * — a conta FECHA: `decompor()` denuncia qualquer resíduo sem estágio.
 */

export type StageName =
  | "queue"
  | "capture"
  | "prepare"
  | "crop"
  | "candle"
  | "vision1"
  | "vision2"
  | "audit"
  | "validation"
  | "scale"
  | "persist"
  | "memory";

/** Instantes absolutos de cada marco — o que o operador pediu para correlacionar. */
export interface StageMarks {
  capturedAt: number;
  analysisStartedAt: number | null;
  uiCommitRequestedAt: number | null;
  /** Quando o navegador de fato PINTOU — medido por frame, não por setState. */
  uiRenderedAt: number | null;
  finishedAt: number | null;
}

export interface StageTimings {
  /** Da captura até a análise começar. Fila/lock — o tempo que faltava. */
  queueWaitMs: number | null;
  captureMs: number | null;
  prepareMs: number | null;
  cropMs: number | null;
  /** §: custo de extrair o candle fechado por geometria. */
  candleMs: number | null;
  vision1Ms: number | null;
  vision2Ms: number | null;
  auditMs: number | null;
  validationMs: number | null;
  /** Régua da escala. Fora do caminho crítico, mas medida. */
  scaleMs: number | null;
  persistMs: number | null;
  memoryMs: number | null;
  /** Da CAPTURA até o painel preenchido. É esta que o operador cronometra. */
  totalUntilUiMs: number | null;
  totalBackgroundMs: number | null;
  callsIA: number;
  /** Re-prompts por resposta fora do contrato. */
  retryCount: number;
  coldStart: boolean | null;
  marks: StageMarks;
}

const CAMPO: Record<StageName, keyof StageTimings> = {
  queue: "queueWaitMs",
  capture: "captureMs",
  prepare: "prepareMs",
  crop: "cropMs",
  candle: "candleMs",
  vision1: "vision1Ms",
  vision2: "vision2Ms",
  audit: "auditMs",
  validation: "validationMs",
  scale: "scaleMs",
  persist: "persistMs",
  memory: "memoryMs",
};

/** Estágios que consomem inferência — o que faz o tempo, e o que se conta. */
const PESADOS: ReadonlySet<StageName> = new Set(["vision1", "vision2", "audit", "scale"]);

/** Estágios que compõem o CAMINHO CRÍTICO (até a tela). */
const NO_CAMINHO_CRITICO: ReadonlySet<StageName> = new Set([
  "queue",
  "capture",
  "prepare",
  "crop",
  "candle",
  "vision1",
  "vision2",
  "audit",
  "validation",
]);

/**
 * Coletor de tempos. Recebe o instante da CAPTURA e o relógio por parâmetro —
 * o relógio injetado é o que permite provar a aritmética no teste em vez de
 * confiar nela.
 */
export class StageClock {
  private readonly t: StageTimings;
  private readonly agora: () => number;

  constructor(capturedAt: number, agora: () => number = () => Date.now()) {
    this.agora = agora;
    this.t = {
      queueWaitMs: null,
      captureMs: null,
      prepareMs: null,
      cropMs: null,
      candleMs: null,
      vision1Ms: null,
      vision2Ms: null,
      auditMs: null,
      validationMs: null,
      scaleMs: null,
      persistMs: null,
      memoryMs: null,
      totalUntilUiMs: null,
      totalBackgroundMs: null,
      callsIA: 0,
      retryCount: 0,
      coldStart: null,
      marks: {
        capturedAt,
        analysisStartedAt: null,
        uiCommitRequestedAt: null,
        uiRenderedAt: null,
        finishedAt: null,
      },
    };
  }

  /**
   * A análise começou. Fecha a espera de fila — o intervalo entre a captura e
   * este instante é exatamente o tempo que a versão anterior não media.
   */
  marcarInicioDaAnalise(): void {
    const at = this.agora();
    this.t.marks.analysisStartedAt = at;
    this.t.queueWaitMs = at - this.t.marks.capturedAt;
  }

  /** Mede um trecho e devolve o valor dele — sem alterar o fluxo do chamador. */
  async medir<T>(estagio: StageName, executar: () => Promise<T>): Promise<T> {
    const comeco = this.agora();
    try {
      return await executar();
    } finally {
      this.registrar(estagio, this.agora() - comeco);
    }
  }

  /** Registra um tempo já medido (estágios que acontecem no servidor). */
  registrar(estagio: StageName, ms: number | null): void {
    if (ms === null) return;
    const campo = CAMPO[estagio];
    // Estágio repetido SOMA: um 2º passe de visão não apaga o 1º.
    const anterior = this.t[campo];
    (this.t[campo] as number) = typeof anterior === "number" ? anterior + ms : ms;
    if (PESADOS.has(estagio)) this.t.callsIA += 1;
  }

  contarRetry(quantidade = 1): void {
    this.t.retryCount += quantidade;
  }

  /** A UI foi PEDIDA (setState). Ainda não pintou. */
  marcarUiSolicitada(): void {
    if (this.t.marks.uiCommitRequestedAt !== null) return;
    const at = this.agora();
    this.t.marks.uiCommitRequestedAt = at;
    this.t.totalUntilUiMs = at - this.t.marks.capturedAt;
  }

  /**
   * A UI PINTOU. Medido por frame do navegador, não por setState: entre
   * pedir e pintar existe o trabalho de render, e é ele que o operador vê.
   */
  marcarUiPintada(): void {
    if (this.t.marks.uiRenderedAt !== null) return;
    this.t.marks.uiRenderedAt = this.agora();
  }

  marcarFim(): void {
    const at = this.agora();
    this.t.marks.finishedAt = at;
    this.t.totalBackgroundMs = at - this.t.marks.capturedAt;
  }

  setColdStart(frio: boolean): void {
    this.t.coldStart = frio;
  }

  snapshot(): StageTimings {
    return { ...this.t, marks: { ...this.t.marks } };
  }
}

/**
 * DECOMPOSIÇÃO FECHADA — nenhum tempo pode ficar como "outros" sem nome.
 *
 * `totalUntilUiMs` menos a soma dos estágios do caminho crítico é o resíduo.
 * Grande demais significa que existe etapa que ninguém cronometra — foi assim
 * que a espera de fila e a régua da escala ficaram escondidas.
 */
export interface Decomposicao {
  totalUntilUiMs: number | null;
  somaDosEstagiosMs: number;
  residuoMs: number | null;
  residuoSuspeito: boolean;
  /** Entre pedir a UI e ela pintar. Null enquanto não pintou. */
  renderMs: number | null;
}

/** Acima disto o resíduo deixa de ser overhead e vira etapa não medida. */
export const RESIDUO_TOLERAVEL_MS = 2_000;

export function decompor(t: StageTimings): Decomposicao {
  let somaDosEstagiosMs = 0;
  for (const estagio of NO_CAMINHO_CRITICO) {
    somaDosEstagiosMs += (t[CAMPO[estagio]] as number | null) ?? 0;
  }
  const renderMs =
    t.marks.uiRenderedAt !== null && t.marks.uiCommitRequestedAt !== null
      ? t.marks.uiRenderedAt - t.marks.uiCommitRequestedAt
      : null;
  if (t.totalUntilUiMs === null) {
    return {
      totalUntilUiMs: null,
      somaDosEstagiosMs,
      residuoMs: null,
      residuoSuspeito: false,
      renderMs,
    };
  }
  const residuoMs = t.totalUntilUiMs - somaDosEstagiosMs;
  return {
    totalUntilUiMs: t.totalUntilUiMs,
    somaDosEstagiosMs,
    residuoMs,
    residuoSuspeito: residuoMs > RESIDUO_TOLERAVEL_MS,
    renderMs,
  };
}

const hora = (at: number | null): string =>
  at === null ? "—" : new Date(at).toISOString().slice(11, 23);

/** Uma linha legível de log/telemetria — o formato que vai para o console. */
export function formatarTempos(captureId: string, t: StageTimings): string {
  const n = (v: number | null) => (v === null ? "—" : `${v}ms`);
  const c = decompor(t);
  return [
    `[t4] ${captureId}`,
    `capturadoEm=${hora(t.marks.capturedAt)}`,
    `analiseEm=${hora(t.marks.analysisStartedAt)}`,
    `uiPedidaEm=${hora(t.marks.uiCommitRequestedAt)}`,
    `uiPintadaEm=${hora(t.marks.uiRenderedAt)}`,
    `totalUI=${n(t.totalUntilUiMs)}`,
    `fila=${n(t.queueWaitMs)}`,
    `visao1=${n(t.vision1Ms)}`,
    `visao2=${n(t.vision2Ms)}`,
    `auditor=${n(t.auditMs)}`,
    `crop=${n(t.cropMs)}`,
    `validacao=${n(t.validationMs)}`,
    `render=${n(c.renderMs)}`,
    `residuo=${n(c.residuoMs)}`,
    `regua=${n(t.scaleMs)}`,
    `memoria=${n(t.memoryMs)}`,
    `total=${n(t.totalBackgroundMs)}`,
    `chamadasIA=${t.callsIA}`,
    `retries=${t.retryCount}`,
    `coldStart=${t.coldStart === null ? "—" : t.coldStart}`,
  ].join(" ");
}

/**
 * ORÇAMENTO DE TEMPO DO CICLO.
 *
 * O ciclo é de 60s. Iniciar uma inferência nova quando já não cabe é comprar
 * atraso para o candle seguinte — e, pior, alimentar a cascata de fila: uma
 * análise que ultrapassa o ciclo faz o próximo print esperar, e o seguinte
 * esperar mais ainda.
 */
export const RESERVA_DO_CICLO_MS = 20_000;

export function cabeOutraInferencia(args: {
  decorridoMs: number;
  cicloMs: number;
  duracaoEstimadaMs: number;
  reservaMs?: number;
}): boolean {
  const reserva = args.reservaMs ?? RESERVA_DO_CICLO_MS;
  const restante = args.cicloMs - args.decorridoMs - reserva;
  return restante >= args.duracaoEstimadaMs;
}
