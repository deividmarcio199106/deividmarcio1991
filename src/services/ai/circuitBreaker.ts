/**
 * Circuit breaker do AI Gateway.
 *
 * Se a GPU cair, o analisador NÃO pode travar junto: sem o breaker, cada
 * pedido de IA ficaria pendurado até o timeout (2 min por padrão), segurando
 * conexões do servidor e a interface. Depois de N falhas seguidas o circuito
 * abre e as chamadas seguintes falham na hora, com mensagem clara, até a
 * janela de espera passar.
 *
 * Módulo puro e sem dependências: é testável sem rede e sem GPU.
 */

export type BreakerState = "fechado" | "aberto" | "meio-aberto";

export interface CircuitBreakerOptions {
  /** Falhas consecutivas que abrem o circuito. */
  failureThreshold: number;
  /** Tempo com o circuito aberto antes de permitir uma tentativa de sondagem. */
  resetTimeoutMs: number;
  /** Relógio injetável — os testes não dependem de tempo real. */
  now?: () => number;
}

export const DEFAULT_BREAKER_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 3,
  resetTimeoutMs: 30_000,
};

export class CircuitOpenError extends Error {
  constructor(public readonly retryInMs: number) {
    super(
      `IA temporariamente indisponível (circuito aberto). Nova tentativa em ${Math.ceil(
        retryInMs / 1000,
      )}s.`,
    );
    this.name = "CircuitOpenError";
  }
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  /** Só uma sondagem por vez em meio-aberto — evita avalanche na volta da GPU. */
  private probing = false;
  private readonly opts: Required<CircuitBreakerOptions>;

  constructor(options: Partial<CircuitBreakerOptions> = {}) {
    this.opts = {
      ...DEFAULT_BREAKER_OPTIONS,
      now: () => Date.now(),
      ...options,
    } as Required<CircuitBreakerOptions>;
  }

  get state(): BreakerState {
    if (this.openedAt === null) return "fechado";
    const elapsed = this.opts.now() - this.openedAt;
    return elapsed >= this.opts.resetTimeoutMs ? "meio-aberto" : "aberto";
  }

  /** Milissegundos restantes até a próxima sondagem (0 quando não está aberto). */
  get retryInMs(): number {
    if (this.openedAt === null) return 0;
    const remaining = this.opts.resetTimeoutMs - (this.opts.now() - this.openedAt);
    return Math.max(0, remaining);
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  /** Executa `fn` sob proteção. Lança `CircuitOpenError` sem chamar `fn` se aberto. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.state;
    if (state === "aberto") throw new CircuitOpenError(this.retryInMs);
    if (state === "meio-aberto" && this.probing) throw new CircuitOpenError(0);

    // `owns` evita que uma chamada rejeitada limpe a sondagem de outra em curso.
    const owns = state === "meio-aberto";
    if (owns) this.probing = true;

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (e) {
      this.recordFailure();
      throw e;
    } finally {
      if (owns) this.probing = false;
    }
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
  }

  recordFailure(): void {
    this.failures++;
    if (this.failures >= this.opts.failureThreshold) this.openedAt = this.opts.now();
  }

  /** Volta ao estado inicial — usado por testes e por reconfiguração manual. */
  reset(): void {
    this.failures = 0;
    this.openedAt = null;
    this.probing = false;
  }

  /** Resumo seguro para health check e tela de status (sem host, IP ou chave). */
  snapshot(): { state: BreakerState; consecutiveFailures: number; retryInMs: number } {
    return {
      state: this.state,
      consecutiveFailures: this.failures,
      retryInMs: this.retryInMs,
    };
  }
}
