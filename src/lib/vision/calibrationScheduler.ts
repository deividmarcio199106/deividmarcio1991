/**
 * CALIBRAÇÃO DE PREÇOS COMO TAREFA PARALELA.
 *
 * REGRA ABSOLUTA: o gráfico visível manda na análise; a calibração é um
 * processo lateral que só habilita a conversão pixel→preço. Este agendador
 * concentra tudo o que antes travava o analisador:
 *
 * - backoff leve entre tentativas (não sobrecarrega o Qwen-VL);
 * - retentativa imediata quando a ROI/imagem muda de forma relevante;
 * - autoajuste da ROI da escala quando a mesma região falha repetidamente;
 * - estado CONSOLIDADO para a interface e para o chat (uma linha que atualiza,
 *   em vez de uma mensagem de erro por minuto).
 *
 * Nada aqui bloqueia captura, leitura estrutural ou registro de eventos.
 */

export type PriceCalibrationStatus = "SEARCHING" | "CALIBRATED" | "INVALIDATED";

/**
 * Candidatas de ROI lateral (fração da largura onde a escala começa).
 * O Profit do fluxo real deixa os preços colados à borda direita; começamos
 * estreito para reduzir candles/números intrusos e abrimos a região se o OCR
 * não achar âncoras suficientes.
 */
export const ROI_CANDIDATES = [0.9, 0.84, 0.76, 0.94, 0.68, 0.6] as const;

export const CALIBRATION_SCHEDULE = {
  /** Espera mínima entre tentativas. */
  baseDelayMs: 4_000,
  /** Teto do backoff — nunca para de tentar, só desacelera. */
  maxDelayMs: 20_000,
  /** Falhas na mesma ROI antes de procurar outra região. */
  failuresPerRoi: 3,
} as const;

export interface CalibrationSchedulerState {
  status: PriceCalibrationStatus;
  attempts: number;
  consecutiveFailures: number;
  lastAttemptAt: number | null;
  lastReason: string | null;
  /** Melhor número de âncoras já lido — alimenta "Âncoras válidas: 1/2". */
  bestAnchors: number;
  roiIndex: number;
  roiFraction: number;
  roiAdjustments: number;
}

export class CalibrationScheduler {
  private status: PriceCalibrationStatus = "SEARCHING";
  private attempts = 0;
  private failures = 0;
  private failuresOnRoi = 0;
  private lastAttemptAt: number | null = null;
  private lastReason: string | null = null;
  private bestAnchors = 0;
  private roiIndex = 0;
  private roiAdjustments = 0;
  private manualRoi: number | null = null;

  /** Fração horizontal da ROI a usar na próxima tentativa. */
  roi(): number {
    return this.manualRoi ?? ROI_CANDIDATES[this.roiIndex % ROI_CANDIDATES.length]!;
  }

  /** Fallback manual: "AJUSTAR REGIÃO DA ESCALA". Nunca afeta a análise. */
  setManualRoi(fraction: number | null): void {
    this.manualRoi = fraction === null ? null : Math.min(0.94, Math.max(0.4, fraction));
    this.failuresOnRoi = 0;
  }

  private delay(): number {
    const grown = CALIBRATION_SCHEDULE.baseDelayMs * Math.pow(1.6, Math.min(this.failures, 6));
    return Math.min(CALIBRATION_SCHEDULE.maxDelayMs, Math.round(grown));
  }

  /**
   * Deve tentar calibrar agora? Já calibrada não tenta; mudança relevante da
   * imagem (zoom, nova janela, ROI alterada) fura o backoff.
   */
  shouldAttempt(now: number, relevantChange = false): boolean {
    if (this.status === "CALIBRATED") return false;
    if (this.lastAttemptAt === null) return true;
    if (relevantChange) return true;
    return now - this.lastAttemptAt >= this.delay();
  }

  markAttempt(now: number): void {
    this.attempts++;
    this.lastAttemptAt = now;
  }

  /** Tentativa não concluída — NÃO é erro fatal, apenas mais uma volta. */
  fail(reason: string, anchorsFound = 0): CalibrationSchedulerState {
    this.failures++;
    this.failuresOnRoi++;
    this.lastReason = reason;
    this.bestAnchors = Math.max(this.bestAnchors, anchorsFound);
    if (this.status !== "CALIBRATED") this.status = "SEARCHING";
    // Mesma região falhando: procurar a escala em outra faixa lateral.
    if (this.failuresOnRoi >= CALIBRATION_SCHEDULE.failuresPerRoi && this.manualRoi === null) {
      this.failuresOnRoi = 0;
      this.roiIndex++;
      this.roiAdjustments++;
    }
    return this.state();
  }

  succeed(anchorsFound: number): CalibrationSchedulerState {
    this.status = "CALIBRATED";
    this.failures = 0;
    this.failuresOnRoi = 0;
    this.lastReason = null;
    this.bestAnchors = Math.max(this.bestAnchors, anchorsFound);
    return this.state();
  }

  /** Zoom/resolução mudou: a escala anterior morreu, a análise continua. */
  invalidate(reason: string): CalibrationSchedulerState {
    this.status = "INVALIDATED";
    this.lastReason = reason;
    this.failures = 0;
    this.failuresOnRoi = 0;
    this.lastAttemptAt = null;
    return this.state();
  }

  state(): CalibrationSchedulerState {
    return {
      status: this.status,
      attempts: this.attempts,
      consecutiveFailures: this.failures,
      lastAttemptAt: this.lastAttemptAt,
      lastReason: this.lastReason,
      bestAnchors: this.bestAnchors,
      roiIndex: this.roiIndex % ROI_CANDIDATES.length,
      roiFraction: this.roi(),
      roiAdjustments: this.roiAdjustments,
    };
  }
}

/** Linha ÚNICA e consolidada para a interface e para o chat da IA. */
export function calibrationSummary(state: CalibrationSchedulerState): string {
  if (state.status === "CALIBRATED") {
    return "Escala calibrada — preços exatos disponíveis.";
  }
  const attempt = state.lastAttemptAt
    ? new Date(state.lastAttemptAt).toLocaleTimeString("pt-BR")
    : "—";
  const parts = [
    state.status === "INVALIDATED"
      ? "Escala invalidada (zoom/resolução mudou); recalibração automática em andamento."
      : "Calibração automática de preços em andamento — análise estrutural continua ativa.",
    `Tentativas: ${state.attempts}`,
    `Última: ${attempt}`,
    `Âncoras válidas: ${Math.min(state.bestAnchors, 2)}/2`,
  ];
  if (state.roiAdjustments > 0) {
    parts.push(`Região da escala reajustada ${state.roiAdjustments}×`);
  }
  return `${parts.join(" · ")}.`;
}
