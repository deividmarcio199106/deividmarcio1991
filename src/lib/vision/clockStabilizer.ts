import type { ChartClockRead } from "./chartClock";

/**
 * Estabilização temporal do OCR de data (comando §6–§7).
 *
 * OCR erra. Uma leitura isolada NUNCA muda o pregão: a data só é CONFIRMADA
 * após N leituras consecutivas iguais e com confiança mínima. Quando a data
 * confirmada muda, o estabilizador sinaliza a troca de pregão (SESSION_CLOSE
 * do anterior + SESSION_OPEN do novo) exatamente uma vez.
 *
 * Determinístico e independente de relógio — só depende da sequência de
 * leituras recebidas.
 */

export const CLOCK_CONFIRMATIONS_REQUIRED = 3;
export const CLOCK_MIN_CONFIDENCE = 0.6;

export interface ClockStabilizerState {
  candidateDate: string | null;
  candidateCount: number;
  confirmedDate: string | null;
  observations: number;
}

export interface ClockPushResult {
  state: ClockStabilizerState;
  /** true SOMENTE no push que confirma uma data diferente da anterior. */
  sessionChanged: boolean;
  previousDate: string | null;
}

export class ClockStabilizer {
  private candidateDate: string | null = null;
  private candidateCount = 0;
  private confirmedDate: string | null = null;
  private observations = 0;

  constructor(private readonly required = CLOCK_CONFIRMATIONS_REQUIRED) {}

  snapshot(): ClockStabilizerState {
    return {
      candidateDate: this.candidateDate,
      candidateCount: this.candidateCount,
      confirmedDate: this.confirmedDate,
      observations: this.observations,
    };
  }

  push(read: ChartClockRead): ClockPushResult {
    this.observations++;
    const noChange: ClockPushResult = {
      state: this.snapshot(),
      sessionChanged: false,
      previousDate: this.confirmedDate,
    };
    // Leitura sem data ou abaixo da confiança mínima: ignorada por completo —
    // não zera o candidato (ruído não pode apagar progresso legítimo).
    if (!read.date || read.confidence < CLOCK_MIN_CONFIDENCE) return noChange;

    if (read.date === this.confirmedDate) {
      // Data já confirmada continuou aparecendo: reseta qualquer candidato ruidoso.
      this.candidateDate = null;
      this.candidateCount = 0;
      return { ...noChange, state: this.snapshot() };
    }

    if (read.date === this.candidateDate) {
      this.candidateCount++;
    } else {
      this.candidateDate = read.date;
      this.candidateCount = 1;
    }

    if (this.candidateCount >= this.required) {
      const previousDate = this.confirmedDate;
      this.confirmedDate = this.candidateDate;
      this.candidateDate = null;
      this.candidateCount = 0;
      return {
        state: this.snapshot(),
        // Primeira confirmação da sessão abre pregão; troca posterior fecha o
        // anterior e abre o novo.
        sessionChanged: true,
        previousDate,
      };
    }
    return { ...noChange, state: this.snapshot() };
  }

  reset(): void {
    this.candidateDate = null;
    this.candidateCount = 0;
    this.confirmedDate = null;
    this.observations = 0;
  }
}
