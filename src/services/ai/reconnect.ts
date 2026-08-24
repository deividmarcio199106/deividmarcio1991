/**
 * Backoff progressivo de reconexão da IA (comando §3).
 *
 * Sequência exigida: 1s → 2s → 5s → 10s → 30s (e permanece em 30s).
 * Ao reconectar, o agendador reseta e sinaliza `reconnected` UMA vez, para a
 * interface mostrar "IA GPU: RECONECTADA" sem repetir o aviso a cada poll.
 * Determinístico: sem aleatoriedade, mesmo histórico ⇒ mesmos intervalos.
 */

export const RECONNECT_STEPS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export class ReconnectBackoff {
  private failures = 0;
  private wasDown = false;

  /** Informe o resultado de cada verificação; devolve o próximo intervalo e o evento. */
  record(connected: boolean): { nextDelayMs: number; reconnected: boolean } {
    if (connected) {
      const reconnected = this.wasDown;
      this.failures = 0;
      this.wasDown = false;
      // Conectada: volta ao ritmo normal de monitoramento (30s).
      return { nextDelayMs: RECONNECT_STEPS_MS[RECONNECT_STEPS_MS.length - 1]!, reconnected };
    }
    this.wasDown = true;
    const step = Math.min(this.failures, RECONNECT_STEPS_MS.length - 1);
    this.failures++;
    return { nextDelayMs: RECONNECT_STEPS_MS[step]!, reconnected: false };
  }

  reset(): void {
    this.failures = 0;
    this.wasDown = false;
  }
}
