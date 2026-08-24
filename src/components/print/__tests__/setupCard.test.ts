import { describe, expect, it } from "vitest";

import { rrDoSetup, textoEntrada } from "@/components/print/SetupCard";
import type { TrackedSetup } from "@/lib/print/setupTracker";
import {
  applyConfirmationGate,
  deriveEntryDecision,
  podeDesenharAnotacao,
  validatePrintAnalysis,
  type PrintAnalysis,
} from "@/lib/vision/printAnalysis";

/**
 * As regras de honestidade do card SETUP T4 em teste: R:R só existe com os
 * TRÊS níveis legíveis (dois números não fazem razão), risco zero nunca vira
 * divisão por zero, e entrada ausente é dita — nunca um traço nem um chute.
 */

const base: TrackedSetup = {
  setupId: "T4-2026-08-18-001",
  // Vocabulário canônico do §19: WAITING_BREAKOUT é o antigo PREPARADO — o
  // setup existe, os níveis estão lidos, e o rompimento ainda não aconteceu.
  stage: "WAITING_BREAKOUT",
  direction: "COMPRA",
  entryLevel: 169_500,
  entryZone: null,
  stop: 169_300,
  target: 169_900,
  createdAt: 0,
  updatedAt: 0,
  printsSeen: 1,
  touched: false,
  confirmedAt: null,
  reason: "nasceu de T4_EM_FORMACAO",
  // Setup em formação: gatilho lido, nenhuma versão nova, nenhum rompimento
  // observado, risco não avaliado — e portanto operação NÃO liberada.
  trigger: 169_500,
  triggerVersion: 1,
  triggerHistory: [],
  breakout: null,
  risk: null,
  operationReleased: false,
};

describe("rrDoSetup", () => {
  it("R:R com os três níveis legíveis: 400 de alvo / 200 de risco = 2", () => {
    expect(rrDoSetup(base)).toBeCloseTo(2, 6);
  });

  it("qualquer nível ausente derruba o R:R para null — nunca um chute", () => {
    expect(rrDoSetup({ ...base, entryLevel: null })).toBeNull();
    expect(rrDoSetup({ ...base, stop: null })).toBeNull();
    expect(rrDoSetup({ ...base, target: null })).toBeNull();
    expect(rrDoSetup(null)).toBeNull();
  });

  it("risco zero (stop em cima da entrada) não vira divisão por zero", () => {
    expect(rrDoSetup({ ...base, stop: 169_500 })).toBeNull();
  });
});

describe("textoEntrada", () => {
  it("zona ganha do nível único quando existe", () => {
    expect(textoEntrada({ ...base, entryZone: { min: 169_400, max: 169_600 } })).toBe(
      "169.400 – 169.600",
    );
  });

  it("nível único formatado pt-BR", () => {
    expect(textoEntrada(base)).toBe("169.500");
  });

  it("sem setup ou sem nível, a ausência é dita — NÃO IDENTIFICADO", () => {
    expect(textoEntrada({ ...base, entryLevel: null })).toBe("NÃO IDENTIFICADO");
    expect(textoEntrada(null)).toBe("NÃO IDENTIFICADO");
  });
});

/**
 * REGRESSÃO DE TELA (print #018 do operador): o painel de cima dizia
 * "VIÉS: NEUTRO" e o card do setup dizia "VIÉS: COMPRA" ao mesmo tempo.
 *
 * Nenhum dos dois estava lendo errado — eles liam CAMPOS DIFERENTES: o painel,
 * a direção do print atual (já vetada pelo auditor); o card, a direção com que
 * o setup nasceu. A contradição não era de lógica, era de rótulo ausente.
 */
describe("viés do setup × viés atual — uma fonte, dois rótulos quando divergem", () => {
  const CANDLE = {
    id: "candle_confirmacao",
    label: "Candle de confirmação fechado",
    met: true,
    detail: "",
  };

  function analiseVetada(): PrintAnalysis {
    // Auditor contradisse a direção: a trava zera o lado NA ORIGEM.
    const bruta = {
      status: "T4_EM_FORMACAO",
      direction: "COMPRA",
      confidence: 78,
      symbol: "WINFUT",
      timeframe: "1Min",
      // Campos do ciclo de vida do candle: o fixture-padrao nao le relogio nem
      // candle fechado — quem testa isso preenche explicitamente.
      chartClock: { date: null, time: null },
      lastClosedCandle: null,
      currentPrice: { value: 170_900, visible: true },
      entry: { value: 170_925, visible: true },
      entryZone: null,
      stop: { value: 170_700, visible: true },
      targets: [],
      invalidation: "",
      criteria: [CANDLE],
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
      confidences: { contexto: 70, estrutura: 68, t4: 60, entrada: 42 },
      audit: {
        approved: false,
        issues: ["topos e fundos descendentes contradizem a COMPRA"],
        checkedAt: 1,
        directionContradicted: true,
      },
    };
    const validada = validatePrintAnalysis(bruta).analysis!;
    applyConfirmationGate(validada);
    return validada;
  }

  it("o veto zera a direção do PRINT, mas o setup guarda o lado com que nasceu", () => {
    const analise = analiseVetada();
    // O print atual não sustenta mais COMPRA…
    expect(deriveEntryDecision(analise).bias).toBe("NEUTRO");
    // …e o setup histórico continua sendo o de COMPRA. As duas coisas são
    // verdadeiras ao mesmo tempo — é por isso que a tela precisa dos dois
    // rótulos, e não de um número escolhido a dedo.
    expect(base.direction).toBe("COMPRA");
  });

  it("com a direção vetada, NADA libera operação", () => {
    const decisao = deriveEntryDecision(analiseVetada());
    expect(decisao.entradaConfirmada).toBe(false);
    expect(decisao.status).toBe("AGUARDANDO");
    expect(decisao.auditorAprovou).toBe(false);
    expect(decisao.direcaoBloqueadaPeloAuditor).toBe(true);
  });

  it("nenhuma seta de entrada sobrevive ao veto", () => {
    const analise = analiseVetada();
    const seta = {
      kind: "CONFIRMATION_CANDLE" as const,
      x1: 0.7,
      y1: 0.4,
      x2: null,
      y2: null,
      label: "confirmou",
      index: null,
      reason: "",
    };
    // Sem lado liberado o desenho é recusado em todas as superfícies.
    expect(podeDesenharAnotacao(seta, deriveEntryDecision(analise).bias)).toBe(false);
  });

  it("os níveis observados PERMANECEM — vetar direção não apaga leitura", () => {
    const analise = analiseVetada();
    // Entrada e stop foram lidos no gráfico e continuam valendo como
    // observação; o que caiu foi a autorização, não o número.
    expect(analise.entry.value).toBe(170_925);
    expect(analise.stop.value).toBe(170_700);
  });
});
