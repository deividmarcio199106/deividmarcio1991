import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { Candle } from "@/lib/engines/types";
import { runQuantBacktest } from "@/lib/research/quantBacktest";

/**
 * A MESMA FUNÇÃO DE DECISÃO NOS TRÊS CONSUMIDORES — a exigência central do
 * BLOCO 1. O defeito sênior era o "módulo órfão testado": motor com teste
 * verde e ZERO chamadas em runtime. Este arquivo tranca o contrário:
 *
 *   1) os três consumidores (setupTracker, pregao, quantBacktest) importam o
 *      motor DO MESMO módulo — não uma cópia, não uma reimplementação;
 *   2) o perfil padrão do quant permanece intocado (T4.1): sem `t42Events`,
 *      resultado byte a byte igual ao de antes do BLOCO 1;
 *   3) o perfil T42_HYBRID atravessa uma série inteira sem erro, devolve o
 *      ledger `t42Events` e é DETERMINÍSTICO.
 *
 * O que NÃO se afirma aqui: trade em série sintética. É regra da casa
 * (quantBacktest.test.ts): o motor quant não promete operação em série
 * fabricada — a semântica "EXPIRED_NO_FILL não é operação" está trancada em
 * setupTrackerT42.test.ts, onde a sequência confirmada é construível.
 */

const MOTOR = 'from "@/lib/t4/t42FillEngine"';
const CONSUMIDORES = [
  "src/lib/print/setupTracker.ts",
  "src/server/video/pregao.ts",
  "src/lib/research/quantBacktest.ts",
] as const;

describe("cadeia de import — um motor, três consumidores", () => {
  it("setupTracker chama executeHybridEntry do módulo canônico", () => {
    const fonte = readFileSync("src/lib/print/setupTracker.ts", "utf8");
    expect(fonte).toContain(MOTOR);
    expect(fonte).toContain("executeHybridEntry(");
  });

  it("quantBacktest chama executeHybridEntry do módulo canônico", () => {
    const fonte = readFileSync("src/lib/research/quantBacktest.ts", "utf8");
    expect(fonte).toContain(MOTOR);
    expect(fonte).toContain("executeHybridEntry(");
  });

  it("pregao alcança o motor ATRAVÉS do advanceSetup — um único ponto de decisão", () => {
    /*
     * O replay de vídeo não chama o motor direto de propósito: a máquina de
     * setup dele É o advanceSetup, e duplicar a chamada criaria DOIS pontos
     * de decisão no mesmo caminho. A cadeia provada: pregao → advanceSetup
     * (setupTracker) → executeHybridEntry (motor).
     */
    const pregao = readFileSync("src/server/video/pregao.ts", "utf8");
    expect(pregao).toContain('from "@/lib/print/setupTracker"');
    expect(pregao).toContain("advanceSetup(");
    // O contexto t42 é montado e entregue — sem ele o fork do motor não liga.
    expect(pregao).toContain("candlesFechadosAposE2: candlesT42");
    const tracker = readFileSync("src/lib/print/setupTracker.ts", "utf8");
    expect(tracker).toContain(MOTOR);
  });

  it("nenhum consumidor reimplementa zona/TTL/slippage — só o motor lê T42_EXECUTION", () => {
    // pregao e setupTracker não podem ler a config congelada diretamente:
    // quem interpreta os números é o motor. (O quant também não — ele só
    // repassa candles e lê o veredito.) A regex exige USO em código
    // (`T42_EXECUTION.campo`), não menção em comentário.
    for (const arquivo of CONSUMIDORES) {
      const fonte = readFileSync(arquivo, "utf8");
      expect(fonte).not.toMatch(/T42_EXECUTION\.[a-zA-Z]/);
    }
  });
});

const T0 = Date.UTC(2026, 2, 13, 13, 0, 0);
const MINUTO = 60_000;

/** Série pseudoaleatória determinística (LCG) — mesma receita do teste quant. */
function serie(n: number, seedInicial = 42): Candle[] {
  const out: Candle[] = [];
  let preco = 139_000;
  let seed = seedInicial;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    preco += ((seed % 240) - 118) / 2;
    const abertura = preco;
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    const fechamento = preco + ((seed % 160) - 80) / 2;
    out.push({
      t: T0 + i * MINUTO,
      o: abertura,
      h: Math.max(abertura, fechamento) + 15,
      l: Math.min(abertura, fechamento) - 15,
      c: fechamento,
      v: 100 + (i % 7),
    });
    preco = fechamento;
  }
  return out;
}

describe("quantBacktest — perfil T4.2 plugado sem tocar o padrão", () => {
  it("perfil padrão (T4.1) não ganha t42Events — produção intocada", () => {
    const resultado = runQuantBacktest(serie(240), { asset: "WINFUT" });
    expect("t42Events" in resultado).toBe(false);
  });

  it("T42_HYBRID atravessa a série inteira, devolve o ledger e é determinístico", () => {
    const a = runQuantBacktest(serie(240), { asset: "WINFUT", executionProfile: "T42_HYBRID" });
    const b = runQuantBacktest(serie(240), { asset: "WINFUT", executionProfile: "T42_HYBRID" });
    expect(Array.isArray(a.t42Events)).toBe(true);
    expect(a).toEqual(b);
  });

  it("T41 explícito e padrão implícito são o MESMO caminho", () => {
    const implicito = runQuantBacktest(serie(240), { asset: "WINFUT" });
    const explicito = runQuantBacktest(serie(240), {
      asset: "WINFUT",
      executionProfile: "T41_LIMIT_EXACT",
    });
    expect(explicito).toEqual(implicito);
  });
});
