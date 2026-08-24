import { describe, expect, it } from "vitest";

import { createBacktestTrade } from "../backtestEngine";
import type { AnalysisResult } from "../types";

/**
 * CUSTOS LIGADOS NO FECHAMENTO (auditoria sênior, BLOCO 5).
 *
 * `liquidarOperacao` tinha teste verde e ZERO chamadas em runtime —
 * `costs_brl`/`result_brl`/`slippage_points` chegavam sempre null ao banco e
 * `netAfterCostsR` nunca saía do null. Agora a liquidação roda DENTRO de
 * `createBacktestTrade` (o funil único dos três criadores de trade: ao vivo,
 * replay de sessão e quant). O que se tranca:
 *
 *   1. WINFUT com risco conhecido ⇒ os quatro campos preenchidos com a CONTA
 *      da B3 (números derivados, não chutados);
 *   2. `rMultiple` permanece BRUTO — a mudança de semântica seria silenciosa
 *      e contaminaria toda estatística existente;
 *   3. ativo desconhecido ⇒ costR null e NENHUM campo de custo — custo
 *      desconhecido nunca vira zero.
 */

const T0 = Date.UTC(2026, 2, 2, 13, 0, 0);

/** Análise mínima congelada: só o que createBacktestTrade consome. */
function analise(): AnalysisResult {
  return {
    t: T0,
    strategyVersion: "T4.0.0",
    price: 169_600,
    direction: "COMPRA",
    plan: {
      direction: "COMPRA",
      entry: 169_500,
      stop: 169_300,
      target1: 170_100,
      target2: 170_500,
      riskReward: 3,
      riskRewardFinal: 5,
      riskRewardPlan: 3.5,
      stopDistance: 200,
      mode: "ENTRADA DIRETA PROVÁVEL",
      entryPoiId: null,
      targetLiquidityPrice: null,
    },
    t4: {
      setup: "TREND_FIRST_PULLBACK",
      quality: "A",
      productionReady: true,
      reasons: [],
      blockers: [],
    },
    regime: { regime: "TREND_UP" },
    wyckoff: { events: [], schema: "Acumulação", phase: "D" },
    marketState: "TENDÊNCIA",
    risk: { reversalRisk: 10 },
    mainPoi: null,
  } as unknown as AnalysisResult;
}

function tradeWinfut(asset = "WINFUT") {
  return createBacktestTrade({
    analysis: analise(),
    asset,
    sourceCaptureId: "teste",
    origin: "BACKTEST",
    closedAt: T0 + 600_000,
    exit: 170_100,
    result: "GANHO",
    rMultiple: 3,
    // DNA vazio de propósito: o assunto é a liquidação, não a classificação.
    dna: {},
  });
}

describe("liquidação no fechamento — a conta da B3, não null", () => {
  it("WINFUT: custos/resultado/slippage/costR preenchidos com a conta derivada", () => {
    const trade = tradeWinfut();
    expect(trade).not.toBeNull();
    /*
     * A conta, por extenso (3 contratos, cada um entra 1x e sai 1x = 2 pernas):
     *   corretagem   0,50 × 3 × 2 = 3,00
     *   emolumentos  0,77 × 3 × 2 = 4,62
     *   derrapagem   (1 spread + 1×2 slip) ticks × 5 pts × R$0,20 × 3 = 9,00
     *   total                                                        = 16,62
     *   risco: 200 pts × R$0,20 × 3 = R$ 120 ⇒ costR = 16,62/120 = 0,1385
     */
    expect(trade!.costsBrl).toBeCloseTo(16.62, 2);
    expect(trade!.costR).toBeCloseTo(0.1385, 4);
    expect(trade!.slippagePoints).toBe(15);
    // resultBrl é LÍQUIDO: (3R − 0,1385R) × R$120 = R$ 343,38.
    expect(trade!.resultBrl).toBeCloseTo(343.38, 2);
    expect(trade!.stopDistancePoints).toBe(200);
  });

  it("rMultiple permanece BRUTO — o líquido vive em costR/resultBrl", () => {
    const trade = tradeWinfut();
    expect(trade!.rMultiple).toBe(3);
  });

  it("ativo sem configuração: costR null e nenhum campo de custo — nunca zero", () => {
    const trade = tradeWinfut("ATIVO_INEXISTENTE");
    expect(trade).not.toBeNull();
    expect(trade!.costR).toBeNull();
    expect(trade!.costsBrl).toBeUndefined();
    expect(trade!.resultBrl).toBeUndefined();
    expect(trade!.slippagePoints).toBeUndefined();
  });

  it("determinismo: a mesma operação liquida sempre a mesma conta", () => {
    expect(tradeWinfut()).toEqual(tradeWinfut());
  });
});
