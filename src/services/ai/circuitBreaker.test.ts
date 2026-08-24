import { describe, expect, it } from "vitest";

import { CircuitBreaker, CircuitOpenError } from "./circuitBreaker";

/** Relógio controlado — nenhum teste depende de tempo real. */
function clock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const fail = () => Promise.reject(new Error("GPU fora do ar"));
const ok = () => Promise.resolve("resposta");

describe("CircuitBreaker — abertura", () => {
  it("começa fechado", () => {
    expect(new CircuitBreaker().state).toBe("fechado");
  });

  it("falhas abaixo do limiar mantêm o circuito fechado", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
    await expect(cb.run(fail)).rejects.toThrow("GPU fora do ar");
    await expect(cb.run(fail)).rejects.toThrow("GPU fora do ar");
    expect(cb.state).toBe("fechado");
    expect(cb.consecutiveFailures).toBe(2);
  });

  it("no limiar de falhas o circuito abre", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
    for (let i = 0; i < 3; i++) await expect(cb.run(fail)).rejects.toThrow();
    expect(cb.state).toBe("aberto");
  });

  /**
   * O ponto do breaker: com o circuito aberto, a chamada falha na hora em vez de
   * ficar pendurada até o timeout de 2 min segurando conexão do servidor.
   */
  it("com o circuito aberto, a função protegida NÃO é chamada", async () => {
    const c = clock();
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000, now: c.now });
    await expect(cb.run(fail)).rejects.toThrow();

    let chamou = false;
    await expect(
      cb.run(() => {
        chamou = true;
        return ok();
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(chamou).toBe(false);
  });

  it("um sucesso zera o contador de falhas", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
    await expect(cb.run(fail)).rejects.toThrow();
    await expect(cb.run(fail)).rejects.toThrow();
    await expect(cb.run(ok)).resolves.toBe("resposta");
    expect(cb.consecutiveFailures).toBe(0);
    expect(cb.state).toBe("fechado");
  });
});

describe("CircuitBreaker — recuperação", () => {
  it("passado o resetTimeout, o circuito fica meio-aberto e permite uma sondagem", async () => {
    const c = clock();
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000, now: c.now });
    await expect(cb.run(fail)).rejects.toThrow();
    expect(cb.state).toBe("aberto");

    c.advance(1000);
    expect(cb.state).toBe("meio-aberto");
    await expect(cb.run(ok)).resolves.toBe("resposta");
    expect(cb.state).toBe("fechado");
  });

  it("sondagem que falha reabre o circuito e reinicia a contagem de espera", async () => {
    const c = clock();
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000, now: c.now });
    await expect(cb.run(fail)).rejects.toThrow();

    c.advance(1000);
    await expect(cb.run(fail)).rejects.toThrow("GPU fora do ar");
    expect(cb.state).toBe("aberto");
    expect(cb.retryInMs).toBe(1000);
  });

  it("retryInMs decresce com o tempo e chega a 0", async () => {
    const c = clock();
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000, now: c.now });
    await expect(cb.run(fail)).rejects.toThrow();
    expect(cb.retryInMs).toBe(1000);
    c.advance(400);
    expect(cb.retryInMs).toBe(600);
    c.advance(5000);
    expect(cb.retryInMs).toBe(0);
  });

  it("retryInMs é 0 com o circuito fechado", () => {
    expect(new CircuitBreaker().retryInMs).toBe(0);
  });

  it("só uma sondagem simultânea em meio-aberto — a volta da GPU não leva avalanche", async () => {
    const c = clock();
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000, now: c.now });
    await expect(cb.run(fail)).rejects.toThrow();
    c.advance(1000);

    let liberar: (v: string) => void = () => {};
    const lenta = cb.run(() => new Promise<string>((res) => (liberar = res)));
    // Segunda chamada enquanto a sondagem está em curso: rejeitada de imediato.
    await expect(cb.run(ok)).rejects.toBeInstanceOf(CircuitOpenError);

    liberar("resposta");
    await expect(lenta).resolves.toBe("resposta");
    expect(cb.state).toBe("fechado");
  });

  it("reset devolve o breaker ao estado inicial", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });
    await expect(cb.run(fail)).rejects.toThrow();
    cb.reset();
    expect(cb.state).toBe("fechado");
    expect(cb.consecutiveFailures).toBe(0);
  });
});

describe("CircuitOpenError e snapshot", () => {
  it("a mensagem diz quando tentar de novo, em segundos", () => {
    expect(new CircuitOpenError(30_000).message).toContain("30s");
    // Arredonda para cima: "0s" seria enganoso.
    expect(new CircuitOpenError(1).message).toContain("1s");
  });

  it("snapshot não expõe host, IP nem chave — vai para o health check e a UI", async () => {
    const c = clock();
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000, now: c.now });
    await expect(cb.run(fail)).rejects.toThrow();
    const snap = cb.snapshot();
    expect(Object.keys(snap).sort()).toEqual(["consecutiveFailures", "retryInMs", "state"]);
    expect(snap.state).toBe("aberto");
    expect(snap.consecutiveFailures).toBe(1);
  });
});
