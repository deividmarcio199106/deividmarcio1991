import { describe, expect, it } from "vitest";

import type { PrintAnalysis } from "@/lib/vision/printAnalysis";
import { advanceSetup } from "../setupTracker";

/**
 * A ENTRADA POR REGIÃO, nos dois lados — e os gates que a seguram.
 *
 * É o contrato do funil de vídeo: o scanner é permissivo, quem decide é a
 * máquina, e a máquina só confirma no toque quando TODOS os hard gates fecham
 * — direção, zona tocada, stop técnico, alvo com espaço provado, R:R mínimo.
 * Cada teste aqui derruba (ou fecha) uma perna e verifica o efeito. A simetria
 * COMPRA/VENDA é testada de propósito: um viés que impedisse VENDA passaria
 * despercebido numa suíte que só compra.
 */

const T0 = Date.UTC(2026, 7, 22, 13, 0, 0);
const num = (value: number) => ({ value, visible: true });

/** Um print que chegou na REGIÃO: zona lida, níveis coerentes, preço dentro. */
function printNaRegiao(overrides: Partial<PrintAnalysis> = {}): PrintAnalysis {
  return {
    status: "T4_EM_FORMACAO",
    direction: "COMPRA",
    confidence: 80,
    symbol: "WINFUT",
    timeframe: "1Min",
    chartClock: { date: null, time: null },
    lastClosedCandle: null,
    // Dentro da zona de compra 169.400–169.600, entrada de referência 169.500.
    currentPrice: num(169_450),
    entry: num(169_500),
    entryZone: { min: num(169_400), max: num(169_600) },
    stop: num(169_300),
    // 3R sobre risco de 200 pontos — o piso da técnica (riskGate.MIN_RR = 3).
    targets: [num(170_100)],
    invalidation: "",
    criteria: [],
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

describe("entrada por região com prova de fechamento dispensada", () => {
  it("COMPRA confirma quando o preço está na zona e todos os gates fecham", () => {
    const passo = advanceSetup(null, printNaRegiao(), T0, 1, { exigirCandleFechado: false });
    expect(passo.entradaConfirmada).toBe(true);
    expect(passo.operacaoLiberada).toBe(true);
    expect(passo.setup?.stage).toBe("CONFIRMED");
    expect(passo.headline).toContain("TOQUE");
    // O desconto de prova viaja declarado — nunca como leitura plena.
    expect(passo.avisos.join(" ")).toContain("sem candle fechado");
  });

  it("VENDA confirma simetricamente — sem viés de lado", () => {
    const passo = advanceSetup(
      null,
      printNaRegiao({
        direction: "VENDA",
        currentPrice: num(169_550),
        entry: num(169_500),
        entryZone: { min: num(169_400), max: num(169_600) },
        stop: num(169_700),
        targets: [num(168_900)], // 3R abaixo
      }),
      T0,
      1,
      { exigirCandleFechado: false },
    );
    expect(passo.entradaConfirmada).toBe(true);
    expect(passo.setup?.stage).toBe("CONFIRMED");
    expect(passo.setup?.direction).toBe("VENDA");
  });

  it("R:R abaixo do piso NÃO confirma nem no toque — hard gate", () => {
    const passo = advanceSetup(
      null,
      // Alvo a 1,5R: era exatamente o desvio que o gate unificado fechou.
      printNaRegiao({ targets: [num(169_800)] }),
      T0,
      1,
      { exigirCandleFechado: false },
    );
    expect(passo.entradaConfirmada).toBe(false);
    expect(passo.setup?.stage).not.toBe("CONFIRMED");
  });

  it("sem alvo (espaço não provado) o setup SEGUE VIVO sem confirmar", () => {
    /*
     * É o desenho do funil: espaço insuficiente recusa o ALVO, não o
     * candidato. O setup existe, acompanha, e RISK_UNKNOWN — nunca aprovação
     * — o segura até uma releitura provar espaço.
     */
    const passo = advanceSetup(null, printNaRegiao({ targets: [] }), T0, 1, {
      exigirCandleFechado: false,
    });
    expect(passo.entradaConfirmada).toBe(false);
    expect(passo.setup).not.toBeNull();
    expect(["FORMING", "ARMED", "WAITING_BREAKOUT", "PRE_ALERT", "APPROACHING"]).toContain(
      passo.setup!.stage,
    );
  });

  it("fora da zona não é toque: acompanha sem confirmar", () => {
    const passo = advanceSetup(
      null,
      printNaRegiao({ currentPrice: num(169_950) }), // longe da zona
      T0,
      1,
      { exigirCandleFechado: false },
    );
    expect(passo.entradaConfirmada).toBe(false);
    expect(passo.setup).not.toBeNull();
  });

  it("com exigência de candle fechado, o mesmo print na zona NÃO confirma", () => {
    // O modo TRACK do vídeo usa exatamente esta trava: dado velho não decide.
    const passo = advanceSetup(null, printNaRegiao(), T0, 1, { exigirCandleFechado: true });
    expect(passo.entradaConfirmada).toBe(false);
  });
});
