import { describe, expect, it } from "vitest";

import { EMPTY_DIAGNOSTICS, candleParseError, type PipelineDiagnostics } from "../diagnostics";
import { computeT4Progress } from "../progress";
import { createSignalSnapshot } from "../signalSnapshot";
import type { AnalysisResult, Candle } from "@/lib/engines/types";

const candle: Candle = { t: 1_700_000_000_000, o: 100, h: 105, l: 99, c: 104, v: 0 };

function diagnostics(overrides: Partial<PipelineDiagnostics>): PipelineDiagnostics {
  return { ...EMPTY_DIAGNOSTICS, ...overrides };
}

/**
 * Análise COMPLETA o bastante para os degraus de estrutura e liquidez.
 *
 * O mapa de liquidez precisa ter nível: a etapa LIQUIDEZ passou a exigir mapa
 * NÃO VAZIO. Antes a condição era `levels.length >= 0` — sempre verdadeira —, e
 * a etapa acendia verde exatamente no caso em que o gate LIQUIDITY reprova, com
 * o mapa vazio. Dois indicadores da mesma coisa discordando na mesma tela.
 *
 * Uma fixture sem nível nenhum não descreve "análise completa"; descreve uma
 * leitura que ainda não mapeou liquidez.
 */
function fakeAnalysis(): AnalysisResult {
  return {
    evidences: [{ group: "estrutura", state: "parcial" }],
    liquidity: { levels: [{ price: 104, kind: "topo" }] },
    contradictions: [],
    blockers: ["T4: aguardando setup A/A+."],
  } as unknown as AnalysisResult;
}

function snapshot() {
  return createSignalSnapshot({
    asset: "WINFUT",
    chartTimestamp: candle.t,
    direction: "COMPRA",
    entry: 100,
    initialStop: 95,
    threeR: 115,
    fiveR: 125,
    setup: "TREND_FIRST_PULLBACK",
    confirmationCandle: candle,
  });
}

describe("progresso T4 0–100 (comando §6)", () => {
  it("0% quando a sessão não iniciou — nunca timer fake", () => {
    const progress = computeT4Progress({
      sessionActive: false,
      diagnostics: EMPTY_DIAGNOSTICS,
      analysis: null,
      decisionEvaluated: false,
      snapshot: null,
    });
    expect(progress.percent).toBe(0);
    expect(progress.status).toBe("AGUARDAR");
  });

  it("degraus são monotônicos: gráfico detectado sem Profit não pula etapas", () => {
    const progress = computeT4Progress({
      sessionActive: true,
      diagnostics: diagnostics({ CAPTURE_ACTIVE: true, GRAPH_DETECTED: true }),
      analysis: null,
      decisionEvaluated: false,
      snapshot: null,
    });
    expect(progress.percent).toBe(10); // PROFIT_DETECTED=false trava em 10
  });

  it("50% exige chartClock válido OU fallback declarado com motivo", () => {
    const base = {
      sessionActive: true,
      analysis: null,
      decisionEvaluated: false,
      snapshot: null,
    };
    const withoutClock = computeT4Progress({
      ...base,
      diagnostics: diagnostics({
        CAPTURE_ACTIVE: true,
        PROFIT_DETECTED: true,
        GRAPH_DETECTED: true,
        PRICE_AXIS: true,
        CHART_CLOCK: "UNAVAILABLE",
        chartClockReason: null,
      }),
    });
    expect(withoutClock.percent).toBe(40);
    const withFallback = computeT4Progress({
      ...base,
      diagnostics: diagnostics({
        CAPTURE_ACTIVE: true,
        PROFIT_DETECTED: true,
        GRAPH_DETECTED: true,
        PRICE_AXIS: true,
        CHART_CLOCK: "FALLBACK_REALTIME",
        chartClockReason: "chartClock ilegível",
      }),
    });
    expect(withFallback.percent).toBe(50);
  });

  it("90% com análise+gates avaliados e 100% somente com snapshot/signalId", () => {
    const diag = diagnostics({
      CAPTURE_ACTIVE: true,
      PROFIT_DETECTED: true,
      GRAPH_DETECTED: true,
      PRICE_AXIS: true,
      CHART_CLOCK: "VALID",
    });
    const ninety = computeT4Progress({
      sessionActive: true,
      diagnostics: diag,
      analysis: fakeAnalysis(),
      decisionEvaluated: true,
      snapshot: null,
    });
    expect(ninety.percent).toBe(90);
    expect(ninety.status).toBe("ANALISANDO");
    expect(ninety.blockers).toContain("T4: aguardando setup A/A+.");

    const hundred = computeT4Progress({
      sessionActive: true,
      diagnostics: diag,
      analysis: fakeAnalysis(),
      decisionEvaluated: true,
      snapshot: snapshot(),
    });
    expect(hundred.percent).toBe(100);
    expect(hundred.status).toBe("CONFIRMADO");
    expect(hundred.stages.ENTRADA).toBe(true);
  });

  it("sem decisão avaliada nunca chega a 90 mesmo com análise completa", () => {
    const progress = computeT4Progress({
      sessionActive: true,
      diagnostics: diagnostics({
        CAPTURE_ACTIVE: true,
        PROFIT_DETECTED: true,
        GRAPH_DETECTED: true,
        PRICE_AXIS: true,
        CHART_CLOCK: "VALID",
      }),
      analysis: fakeAnalysis(),
      decisionEvaluated: false,
      snapshot: null,
    });
    expect(progress.percent).toBe(80);
  });
});

describe("erro específico de parsing (comando §5)", () => {
  it("gráfico visível com candles=0 tem erro específico, nunca genérico", () => {
    expect(
      candleParseError({ GRAPH_DETECTED: true, CANDLES_VISIBLE: 0, CANDLES_PARSED: 0 }),
    ).toContain("NENHUMA COLUNA");
    expect(
      candleParseError({ GRAPH_DETECTED: true, CANDLES_VISIBLE: 12, CANDLES_PARSED: 0 }),
    ).toContain("NENHUM FOI PARSEADO");
    expect(
      candleParseError({ GRAPH_DETECTED: true, CANDLES_VISIBLE: 12, CANDLES_PARSED: 20 }),
    ).toBeNull();
    expect(
      candleParseError({ GRAPH_DETECTED: false, CANDLES_VISIBLE: 0, CANDLES_PARSED: 0 }),
    ).toBeNull();
  });
});
