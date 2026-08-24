import { describe, expect, it } from "vitest";

import { assessTradeRisk, MIN_RR, riscoAprovado, type RiskInput } from "../riskGate";

/**
 * O GATE DE RISCO EM TESTE (§22).
 *
 * A regra do operador é `operationReleased = setupConfirmed && riskApproved`.
 * O que este módulo garante é a segunda metade — e, sobretudo, que a AUSÊNCIA
 * de número nunca vire aprovação. `RISK_UNKNOWN` existe justamente para isso:
 * "faltou dado para julgar" não é "pode operar".
 *
 * Números do WINFUT: entrada 170.925, stop 170.700 (225 de risco).
 */

const ENTRADA = 170_925;
const STOP = 170_700;

function compra(over: Partial<RiskInput> = {}): RiskInput {
  return { side: "COMPRA", entry: ENTRADA, stop: STOP, target: 171_700, ...over };
}

describe("§22 — risco aprovado", () => {
  it("R:R acima do mínimo aprova, sem problema a relatar", () => {
    const r = assessTradeRisk(compra());
    expect(r.verdict).toBe("RISK_APPROVED");
    expect(riscoAprovado(r)).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.coherent).toBe(true);
    expect(r.riskPoints).toBe(225);
    expect(r.rewardPoints).toBe(775);
    expect(r.rr).toBeCloseTo(775 / 225, 6);
  });

  it("VENDA é simétrica — stop acima, alvo abaixo", () => {
    const r = assessTradeRisk({
      side: "VENDA",
      entry: ENTRADA,
      stop: 171_150,
      target: 170_150,
    });
    expect(r.verdict).toBe("RISK_APPROVED");
    expect(r.riskPoints).toBe(225);
    expect(r.rewardPoints).toBe(775);
  });

  it("exatamente no mínimo APROVA — o piso é inclusivo e explícito", () => {
    // Risco 225 × 1,5 = 337,5 de retorno.
    const r = assessTradeRisk(compra({ target: ENTRADA + 225 * MIN_RR }));
    expect(r.rr).toBeCloseTo(MIN_RR, 6);
    expect(r.verdict).toBe("RISK_APPROVED");
  });
});

describe("§22 — risco reprovado", () => {
  it("R:R abaixo do mínimo REPROVA e diz o número", () => {
    const r = assessTradeRisk(compra({ target: 171_025 })); // 100 de retorno
    expect(r.verdict).toBe("RISK_REJECTED");
    expect(riscoAprovado(r)).toBe(false);
    expect(r.rr).toBeCloseTo(100 / 225, 6);
    expect(r.problems.join(" ")).toContain("R:R");
  });

  it("stop do lado errado da entrada é incoerente — não é só R:R ruim", () => {
    // COMPRA com o stop ACIMA da entrada: isso não descreve operação nenhuma.
    const r = assessTradeRisk(compra({ stop: 171_100 }));
    expect(r.verdict).toBe("RISK_REJECTED");
    expect(r.coherent).toBe(false);
    expect(r.problems.length).toBeGreaterThan(0);
  });

  it("alvo do lado errado também é incoerente", () => {
    const r = assessTradeRisk(compra({ target: 170_500 }));
    expect(r.verdict).toBe("RISK_REJECTED");
    expect(r.coherent).toBe(false);
  });

  it("risco zero não vira divisão por zero — reprova com motivo", () => {
    const r = assessTradeRisk(compra({ stop: ENTRADA }));
    expect(r.verdict).toBe("RISK_REJECTED");
    expect(r.rr).toBeNull();
    expect(r.problems.length).toBeGreaterThan(0);
  });

  it("o mínimo é configurável — e o piso da casa NÃO fica redigitado aqui", () => {
    // R:R = 4: passa no piso da casa (3) e reprova num piso mais duro (5).
    const alvoFolgado = compra({ target: ENTRADA + 225 * 4 });
    expect(assessTradeRisk(alvoFolgado).verdict).toBe("RISK_APPROVED");
    expect(assessTradeRisk({ ...alvoFolgado, minRr: 5 }).verdict).toBe("RISK_REJECTED");
    // O piso da casa é o da TÉCNICA — se alguém redigitar 1,5 aqui, quebra.
    expect(MIN_RR).toBe(3);
  });
});

describe("§22 — ausência de número NUNCA é aprovação", () => {
  it("cada nível faltando produz RISK_UNKNOWN com o nome do que falta", () => {
    const casos: [string, RiskInput][] = [
      ["entrada", compra({ entry: null })],
      ["stop", compra({ stop: null })],
      ["alvo", compra({ target: null })],
    ];
    for (const [nome, entrada] of casos) {
      const r = assessTradeRisk(entrada);
      expect(r.verdict).toBe("RISK_UNKNOWN");
      expect(riscoAprovado(r)).toBe(false);
      expect(r.rr).toBeNull();
      expect(r.problems.join(" ")).toContain(nome);
    }
  });

  it("sem lado definido não há o que julgar", () => {
    const r = assessTradeRisk(compra({ side: "NEUTRO" }));
    expect(r.verdict).toBe("RISK_UNKNOWN");
    expect(riscoAprovado(r)).toBe(false);
    expect(r.problems.join(" ")).toContain("lado");
  });

  it("RISK_UNKNOWN e RISK_REJECTED são estados DIFERENTES — e a tela precisa dos dois", () => {
    // "alvo não identificado" manda o operador ler o gráfico; "R:R 0,44" manda
    // descartar a operação. Colapsar os dois em "bloqueado" perde a instrução.
    const semAlvo = assessTradeRisk(compra({ target: null }));
    const rrBaixo = assessTradeRisk(compra({ target: 171_025 }));
    expect(semAlvo.verdict).not.toBe(rrBaixo.verdict);
    expect(riscoAprovado(semAlvo)).toBe(false);
    expect(riscoAprovado(rrBaixo)).toBe(false);
  });

  it("todo veredito que não aprova tem problema dito — nunca lista vazia", () => {
    const bloqueados = [
      compra({ target: null }),
      compra({ side: "NEUTRO" }),
      compra({ target: 171_025 }),
      compra({ stop: ENTRADA }),
      compra({ stop: 171_100 }),
    ];
    for (const entrada of bloqueados) {
      const r = assessTradeRisk(entrada);
      expect(riscoAprovado(r)).toBe(false);
      expect(r.problems.length).toBeGreaterThan(0);
    }
  });
});
