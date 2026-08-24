import { describe, expect, it } from "vitest";

import { comparePrintAnalyses } from "../printComparison";
import { validatePrintAnalysis, type PrintAnalysis } from "../printAnalysis";

/**
 * A COMPARAÇÃO É DETERMINÍSTICA E SÓ AFIRMA O QUE OS DOIS PRINTS SUSTENTAM.
 *
 * Nenhum modelo participa: modelo comparando inventaria mudanças plausíveis do
 * mesmo jeito que inventa preços. E elemento presente numa análise só não é
 * transição — é o modelo tendo avaliado listas diferentes.
 */

function analise(over: Partial<PrintAnalysis> = {}): PrintAnalysis {
  return {
    status: "T4_EM_FORMACAO",
    direction: "COMPRA",
    confidence: 70,
    symbol: "WIN",
    timeframe: "5m",
    // Campos do ciclo de vida do candle: o fixture-padrao nao le relogio nem
    // candle fechado — quem testa isso preenche explicitamente.
    chartClock: { date: null, time: null },
    lastClosedCandle: null,
    currentPrice: { value: null, visible: false },
    entry: { value: null, visible: false },
    entryZone: null,
    stop: { value: null, visible: false },
    targets: [],
    invalidation: "",
    criteria: [],
    annotations: [],
    scenarios: [],
    pastOccurrences: 0,
    explanation: "",
    missingCriteria: [],
    imageIssues: [],
    nextScreenshot: null,
    dna: null,
    audit: null,
    confidences: null,
    conditionalPlans: [],
    priceLevels: [],
    ...over,
  };
}

describe("comparação entre prints", () => {
  it("análises equivalentes dizem NÃO PRECISA ENVIAR OUTRO PRINT", () => {
    // A resposta que evita print desnecessário — regra explícita do fluxo.
    const r = comparePrintAnalyses(analise(), analise());
    expect(r.unchanged).toBe(true);
    expect(r.changes[0]!.text).toContain("NÃO PRECISA ENVIAR OUTRO PRINT");
  });

  it("avanço na escada é reportado com os dois estágios", () => {
    const r = comparePrintAnalyses(
      analise({ status: "APROXIMACAO_T4" }),
      analise({ status: "PRE_ENTRADA" }),
    );
    expect(r.unchanged).toBe(false);
    const avanco = r.changes.find((c) => c.kind === "AVANCO")!;
    expect(avanco.text).toContain("APROXIMAÇÃO T4");
    expect(avanco.text).toContain("PRÉ-ENTRADA");
  });

  it("invalidação domina a manchete", () => {
    const r = comparePrintAnalyses(
      analise({ status: "PRE_ENTRADA" }),
      analise({ status: "T4_INVALIDADA" }),
    );
    expect(r.headline).toContain("invalidou");
  });

  it("INCONCLUSIVO contamina a comparação inteira", () => {
    const r = comparePrintAnalyses(analise(), analise({ status: "INCONCLUSIVO" }));
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]!.text).toContain("MUDANÇA NÃO CONFIRMÁVEL");
    expect(r.changes[0]!.confirmable).toBe(false);
  });

  it("critério só vira transição quando avaliado NOS DOIS prints", () => {
    const antes = analise({
      criteria: [{ id: "candle", label: "Candle de confirmação", met: false, detail: "" }],
    });
    const depois = analise({
      criteria: [
        { id: "candle", label: "Candle de confirmação", met: true, detail: "" },
        { id: "novo", label: "Critério que só existe agora", met: true, detail: "" },
      ],
    });
    const r = comparePrintAnalyses(antes, depois);
    const ganhos = r.changes.filter((c) => c.kind === "CRITERIO_GANHO");
    // O "novo" não gera transição: nunca foi avaliado no anterior.
    expect(ganhos).toHaveLength(1);
    expect(ganhos[0]!.text).toContain("Candle de confirmação");
  });

  it("suporte que some da análise NÃO vira rompimento", () => {
    const antes = analise({
      annotations: [
        {
          kind: "SUPPORT",
          x1: 0,
          y1: 0.7,
          x2: null,
          y2: null,
          label: "Suporte",
          index: null,
          reason: "",
        },
      ],
    });
    const depois = analise();
    const r = comparePrintAnalyses(antes, depois);
    const naoConf = r.changes.find((c) => c.kind === "NAO_CONFIRMAVEL")!;
    expect(naoConf.confirmable).toBe(false);
    expect(naoConf.text).toContain("suporte");
  });

  it("rompimento identificado no novo print é afirmável — ele ESTÁ lá", () => {
    const depois = analise({
      annotations: [
        {
          kind: "BREAKOUT",
          x1: 0.5,
          y1: 0.4,
          x2: 0.7,
          y2: 0.5,
          label: "Rompimento",
          index: null,
          reason: "",
        },
      ],
    });
    const r = comparePrintAnalyses(analise(), depois);
    expect(r.changes.some((c) => c.kind === "ESTRUTURA" && c.confirmable)).toBe(true);
  });
});

describe("validação do próximo print", () => {
  it("requiredNow é alinhado ao status — contradição não chega à tela", () => {
    const r = validatePrintAnalysis({
      ...analise(),
      nextScreenshot: {
        requiredNow: true,
        status: "NAO_PRECISA",
        instruction: "x",
        preferredTiming: "ANY",
        triggers: [],
      },
    });
    expect(r.ok).toBe(true);
    expect(r.analysis!.nextScreenshot!.requiredNow).toBe(false);
    expect(r.repairs.join(" ")).toContain("requiredNow");
  });

  it("nível de gatilho invisível não carrega valor — mesma lei dos outros números", () => {
    const r = validatePrintAnalysis({
      ...analise(),
      nextScreenshot: {
        requiredNow: false,
        status: "ENVIAR_NO_GATILHO",
        instruction: "",
        preferredTiming: "AFTER_CANDLE_CLOSE",
        triggers: [
          {
            type: "SUPPORT_BREAK",
            label: "Enviar se perder o suporte",
            level: { value: 141_250, visible: false },
            priority: "HIGH",
            x: null,
            y: null,
          },
        ],
      },
    });
    expect(r.analysis!.nextScreenshot!.triggers[0]!.level!.value).toBeNull();
  });

  it("tipo de gatilho fora da lista recusa a resposta", () => {
    const r = validatePrintAnalysis({
      ...analise(),
      nextScreenshot: {
        requiredNow: false,
        status: "NAO_PRECISA",
        instruction: "",
        preferredTiming: "ANY",
        triggers: [{ type: "QUALQUER_COISA", label: "x", priority: "HIGH" }],
      },
    });
    expect(r.ok).toBe(false);
  });

  it("sem nextScreenshot a análise continua válida — ausência é declarada, não inventada", () => {
    const r = validatePrintAnalysis({ ...analise(), nextScreenshot: null });
    expect(r.ok).toBe(true);
    expect(r.analysis!.nextScreenshot).toBeNull();
  });
});
