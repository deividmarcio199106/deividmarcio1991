import { describe, expect, it } from "vitest";

import type { PrintAnalysis } from "@/lib/vision/printAnalysis";
import { advanceSetup } from "../setupTracker";

/**
 * O RASTRO DA PROVA DE FECHAMENTO (BLOCO 2 da auditoria sênior).
 *
 * O bypass `exigirCandleFechado: false` NÃO foi removido — ele existe por
 * decisão do dono da técnica para a leitura de vídeo. O que muda: a linha
 * confirmada carrega para SEMPRE um campo MÁQUINA-LEGÍVEL dizendo COMO a
 * confirmação provou o fechamento:
 *
 *   - toque com prova dispensada  → provaFechamento: "DISPENSADA"
 *   - técnica completa (candle fechado + sustentação) → "PROVADA"
 *
 * A homologação EXCLUI as "DISPENSADA" por padrão (homologacao-final.mjs):
 * entrada no toque não é a mesma técnica, e a estatística de uma não pode
 * vestir o nome da outra. O aviso em prosa continua — mas prosa não filtra
 * relatório; campo filtra.
 */

const T0 = Date.UTC(2026, 7, 22, 13, 0, 0);
const num = (value: number) => ({ value, visible: true });
const APROVADO = { approved: true, issues: [], checkedAt: T0, directionContradicted: false };

const CANDLE_FECHADO = {
  id: "candle_confirmacao",
  label: "Candle de confirmação fechado",
  met: true,
  detail: "fechou acima do rompimento",
};

function base(overrides: Partial<PrintAnalysis> = {}): PrintAnalysis {
  return {
    status: "T4_EM_FORMACAO",
    direction: "COMPRA",
    confidence: 80,
    symbol: "WINFUT",
    timeframe: "1Min",
    chartClock: { date: null, time: null },
    lastClosedCandle: null,
    currentPrice: num(169_400),
    entry: num(169_500),
    entryZone: null,
    stop: num(169_300),
    targets: [num(170_200)],
    invalidation: "",
    criteria: [CANDLE_FECHADO],
    annotations: [],
    scenarios: [],
    pastOccurrences: 0,
    explanation: "",
    missingCriteria: [],
    imageIssues: [],
    nextScreenshot: null,
    conditionalPlans: [],
    priceLevels: [],
    dna: null,
    audit: null,
    confidences: { contexto: 82, estrutura: 80, t4: 76, entrada: 72 },
    ...overrides,
  } as PrintAnalysis;
}

function fechado(close: number, candleTime: number) {
  return {
    close,
    candleTime,
    at: candleTime + 900,
    phase: "CLOSED" as const,
    closeSource: "MODELO" as const,
  };
}

describe("provaFechamento — o bypass deixa rastro", () => {
  it("entrada no toque (exigirCandleFechado:false) confirma com DISPENSADA", () => {
    const passo = advanceSetup(
      null,
      base({
        // Print na região: zona lida, preço dentro, níveis com 3R.
        currentPrice: num(169_450),
        entryZone: { min: num(169_400), max: num(169_600) },
        targets: [num(170_100)],
        criteria: [],
      }),
      T0,
      1,
      { exigirCandleFechado: false },
    );
    expect(passo.entradaConfirmada).toBe(true);
    expect(passo.setup?.stage).toBe("CONFIRMED");
    expect(passo.setup?.provaFechamento).toBe("DISPENSADA");
  });

  it("a técnica completa (candle fechado + sustentação) confirma com PROVADA", () => {
    const confirmando = { status: "ENTRADA_CONFIRMADA" as const, audit: APROVADO };
    const p1 = advanceSetup(null, base({ status: "PRE_ENTRADA" }), T0, 1, {
      candle: fechado(169_400, T0),
    });
    const p2 = advanceSetup(
      p1.setup,
      base({ status: "PRE_ENTRADA", currentPrice: num(169_500) }),
      T0 + 60_000,
      2,
      { candle: fechado(169_500, T0 + 60_000) },
    );
    const p3 = advanceSetup(
      p2.setup,
      base({ ...confirmando, currentPrice: num(169_600) }),
      T0 + 120_000,
      3,
      { candle: fechado(169_600, T0 + 120_000) },
    );
    const p4 = advanceSetup(
      p3.setup,
      base({ ...confirmando, currentPrice: num(169_650) }),
      T0 + 180_000,
      4,
      { candle: fechado(169_650, T0 + 180_000) },
    );
    expect(p4.setup?.stage).toBe("CONFIRMED");
    expect(p4.entradaConfirmada).toBe(true);
    expect(p4.setup?.provaFechamento).toBe("PROVADA");
  });

  it("setup que NUNCA confirmou não ganha rastro — ausência não vira PROVADA", () => {
    const passo = advanceSetup(null, base({ status: "PRE_ENTRADA" }), T0, 1, {
      candle: fechado(169_400, T0),
    });
    expect(passo.setup?.stage).not.toBe("CONFIRMED");
    expect(passo.setup?.provaFechamento ?? null).toBeNull();
  });
});
