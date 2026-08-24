import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LedgerDeLeituras, sha256 } from "../leituraLedger";

/**
 * O contrato do ledger: mesma imagem + mesmo prompt ⇒ exatamente a resposta
 * gravada; leitura nova em experimento vai para o OVERLAY, nunca para o base.
 * É o que transforma "H1 vs baseline" em regra-contra-regra, não
 * percepção-contra-percepção.
 */
describe("LedgerDeLeituras", () => {
  let pasta: string;
  beforeEach(() => {
    pasta = mkdtempSync(join(tmpdir(), "ledger-"));
  });
  afterEach(() => {
    rmSync(pasta, { recursive: true, force: true });
  });

  const registro = (valor: unknown) => ({
    tipo: "niveis",
    imageHash: sha256("imagem-a"),
    promptHash: sha256("prompt-a"),
    provider: "ollama",
    model: "qwen3.5:35b",
    parametros: { think: false },
    respostaBrutaHash: sha256("bruto"),
    valor,
    tentativa: 1,
    latenciaMs: 1234,
  });

  it("grava e reproduz byte a byte, entre instâncias", () => {
    const base = join(pasta, "leituras.jsonl");
    const gravador = new LedgerDeLeituras({ base });
    expect(gravador.consultar(sha256("imagem-a"), sha256("prompt-a"))).toBeNull();
    gravador.registrar(registro({ entry: 198200, stop: 198400, obstaculo: null }));

    // Outra instância — como um experimento dias depois.
    const leitor = new LedgerDeLeituras({ base });
    const hit = leitor.consultar(sha256("imagem-a"), sha256("prompt-a"));
    expect(hit).not.toBeNull();
    expect(hit!.valor).toEqual({ entry: 198200, stop: 198400, obstaculo: null });
    expect(hit!.respostaEstruturadaHash).toBe(
      sha256(JSON.stringify({ entry: 198200, stop: 198400, obstaculo: null })),
    );
    expect(leitor.resumo().hits).toBe(1);
  });

  it("em experimento, leitura nova vai para o overlay — o base fica intocado", () => {
    const base = join(pasta, "leituras.jsonl");
    const novas = join(pasta, "leituras-h1.jsonl");
    new LedgerDeLeituras({ base }).registrar(registro("resposta-do-baseline"));
    const antesDoBase = readFileSync(base, "utf8");

    const experimento = new LedgerDeLeituras({ base, novas });
    // O que o baseline já viu: HIT, sem tocar o modelo.
    expect(experimento.consultar(sha256("imagem-a"), sha256("prompt-a"))?.valor).toBe(
      "resposta-do-baseline",
    );
    // O que o baseline nunca perguntou: gravado no overlay.
    experimento.registrar({
      ...registro("leitura-nova-do-experimento"),
      imageHash: sha256("imagem-b"),
    });
    expect(readFileSync(base, "utf8")).toBe(antesDoBase);
    expect(readFileSync(novas, "utf8")).toContain("leitura-nova-do-experimento");
    expect(experimento.resumo()).toMatchObject({ hits: 1, misses: 1 });

    // Uma terceira corrida do MESMO experimento reaproveita o overlay também.
    const repeticao = new LedgerDeLeituras({ base, novas });
    expect(repeticao.consultar(sha256("imagem-b"), sha256("prompt-a"))?.valor).toBe(
      "leitura-nova-do-experimento",
    );
  });

  it("linha corrompida por gravação interrompida não derruba o índice", () => {
    const base = join(pasta, "leituras.jsonl");
    new LedgerDeLeituras({ base }).registrar(registro("integra"));
    // Simula um crash no meio do append.
    appendFileSync(base, '{"tipo":"niveis","imageHash":"trunc');
    const leitor = new LedgerDeLeituras({ base });
    expect(leitor.consultar(sha256("imagem-a"), sha256("prompt-a"))?.valor).toBe("integra");
  });
});
