import { describe, expect, it } from "vitest";

import { simulateEntry, SIMULATION_WARNING } from "../simulation";
import { guardOperation } from "../priceGuard";
import type { AnalysisResult } from "@/lib/engines/types";

/**
 * O botão de entrada simulada existe para provar que a técnica decide e que a
 * tela reage ANTES de um setup real aparecer. Estes testes trancam as três
 * coisas que ele nunca pode fazer: virar sinal, inventar plano e vazar preço.
 */

const NOW = Date.UTC(2026, 7, 11, 16, 30, 0);

function analysis(over: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    plan: {
      direction: "VENDA",
      entry: 139_000,
      stop: 139_250,
      target1: 138_500,
      target2: 138_000,
      riskReward: 4,
      riskRewardFinal: 4,
      riskRewardPlan: 4,
      stopDistance: 250,
      mode: "AGUARDANDO RETESTE",
      entryPoiId: null,
      targetLiquidityPrice: null,
    },
    regime: { regime: "RANGE" },
    wyckoff: { phase: "B" },
    t4: { setup: "T4-A", quality: 82 },
    sequence: { label: "sequência parcial" },
    ...over,
  } as AnalysisResult;
}

describe("simulateEntry", () => {
  it("marca a operação como simulação, sempre", () => {
    const result = simulateEntry({ analysis: analysis(), now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // É este campo que impede uma simulação de passar por sinal em qualquer tela.
    expect(result.operation.simulated).toBe(true);
    expect(SIMULATION_WARNING).toContain("não é sinal");
  });

  it("usa o plano REAL da leitura, não números inventados", () => {
    const result = simulateEntry({ analysis: analysis(), now: NOW });
    if (!result.ok) throw new Error("deveria simular");
    expect(result.operation.entry).toBe(139_000);
    expect(result.operation.stop).toBe(139_250);
    expect(result.operation.direction).toBe("VENDA");
    expect(result.operation.directionFromReading).toBe(true);
  });

  it("deriva 3R e 5R do risco do próprio plano", () => {
    const result = simulateEntry({ analysis: analysis(), now: NOW });
    if (!result.ok) throw new Error("deveria simular");
    // risco = 139000 - 139250 = -250 (venda). 3R e 5R descem na mesma direção.
    expect(result.operation.target3R).toBe(139_000 + -250 * 3);
    expect(result.operation.target5R).toBe(139_000 + -250 * 5);
  });

  it("recusa quando não há leitura — em vez de inventar uma entrada bonita", () => {
    const semAnalise = simulateEntry({ analysis: null, now: NOW });
    expect(semAnalise.ok).toBe(false);
    if (semAnalise.ok) return;
    expect(semAnalise.reason).toContain("Nenhuma análise");
  });

  it("recusa quando a leitura não produziu plano estrutural", () => {
    const semPlano = simulateEntry({ analysis: analysis({ plan: null }), now: NOW });
    expect(semPlano.ok).toBe(false);
    if (semPlano.ok) return;
    expect(semPlano.reason).toContain("plano estrutural");
  });

  it("direção forçada é marcada como arbitrada, não como leitura", () => {
    const result = simulateEntry({ analysis: analysis(), direction: "COMPRA", now: NOW });
    if (!result.ok) throw new Error("deveria simular");
    expect(result.operation.direction).toBe("COMPRA");
    expect(result.operation.directionFromReading).toBe(false);
  });

  it("a simulação passa pela MESMA guarda de preço da entrada real", () => {
    const result = simulateEntry({ analysis: analysis(), now: NOW });
    if (!result.ok) throw new Error("deveria simular");
    const guardada = guardOperation(result.operation, false);

    // Se a guarda falhasse aqui, falharia na entrada real — que é o ponto de
    // exercitar o caminho inteiro antes de ele valer dinheiro.
    expect(guardada.entry).toBeNull();
    expect(guardada.stop).toBeNull();
    expect(guardada.entryZone).toBeNull();
    // O que a simulação prova continua visível: direção e estágio.
    expect(guardada.direction).toBe("VENDA");
    expect(guardada.stage).toBe("ENTRADA_CONFIRMADA");
  });
});
