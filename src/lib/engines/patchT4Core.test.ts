/**
 * NÚCLEO DE RISCO T4 — as invariantes que o motor não pode perder de novo.
 *
 * Cada teste aqui existe porque o comportamento oposto já esteve no código e
 * produzia número plausível na tela:
 * - o stop encurtado por teto de ATR (a invalidação estrutural virava 2,4 ATR);
 * - o alvo final puxado pela liquidez (3,4R de espaço apresentado como o alvo
 *   de 5R da técnica);
 * - `tickSize` 0 em produção (níveis fora do tick do contrato);
 * - `analyze()` chamado com parâmetros diferentes no ao vivo, no backtest e no
 *   replay (a mesma série produzindo planos diferentes).
 */

import { describe, expect, it } from "vitest";

import { analyze } from "./analysisPipeline";
import type { Features } from "./marketFeatures";
import { assessRisk, buildPlan } from "./riskEngine";
import { DEFAULT_RISK_PARAMS, riskParamsForAsset, type RiskParams } from "./strategy";
import type {
  Candle,
  DataQuality,
  LiquidityMap,
  POI,
  PriceActionRead,
  RiskRead,
  SMSRead,
  WyckoffRead,
} from "./types";
import { buildReadingState } from "@/lib/t4/readingState";
import { evaluateT4Gates } from "@/lib/t4/gates";
import { evaluateOperation } from "@/lib/t4/preEntry";
import { captureVisionReplay, replayTechnique } from "@/lib/vision/techniqueReplay";

// ---------------------------------------------------------------- fixtures

function features(overrides: Partial<Features> = {}): Features {
  return {
    price: 100,
    atr: 10,
    ema9: 100,
    ema21: 100,
    ema50: 100,
    slope: 0,
    trend: 0.4,
    locationInTrend: 0.4,
    swingHigh: 110,
    swingLow: 90,
    rangeHigh: 112,
    rangeLow: 88,
    rangeWidth: 60,
    positionInRange: 0.5,
    bodyRatio: 0.6,
    upperWick: 0.2,
    lowerWick: 0.2,
    momentum: 0.2,
    acceleration: 0,
    brokeHigh: false,
    brokeLow: false,
    displacement: 0.3,
    retestingLevel: null,
    distanceToLevel: 1,
    consecutiveUp: 0,
    consecutiveDown: 0,
    divergence: 0,
    ...overrides,
  };
}

function priceAction(overrides: Partial<PriceActionRead> = {}): PriceActionRead {
  return {
    buyEffort: 55,
    sellEffort: 45,
    thrust: 30,
    acceleration: 0,
    stall: 20,
    conviction: 40,
    exhaustion: 20,
    imbalance: 12,
    contrary: false,
    lastReadAt: 1000,
    ...overrides,
  };
}

function smsRead(overrides: Partial<SMSRead> = {}): SMSRead {
  return {
    confirmed: false,
    pending: false,
    direction: null,
    brokenLevel: null,
    displacement: 0,
    closeConfirmed: false,
    liquidityDefended: false,
    reactionConfirmed: false,
    structureFormed: false,
    retestExpected: false,
    confidence: 0,
    invalidation: null,
    ...overrides,
  } as SMSRead;
}

function wyckoff(): WyckoffRead {
  return {
    schema: "Indefinido",
    phase: null,
    events: [],
    confidence: 0.2,
    label: "Contexto indefinido",
  };
}

function dataQuality(): DataQuality {
  return { quality: 100, issues: [] };
}

/** Mapa vazio: sem liquidez, `assessRisk` cai na referência estrutural de sempre. */
function liquidityVazia(): LiquidityMap {
  return { levels: [], nearestBuy: null, nearestSell: null, lastEvent: null, events: [] };
}

/** `buildPlan` não lê `risk`; existe só para satisfazer a assinatura. */
function riskVazio(): RiskRead {
  return {
    reversalRisk: 0,
    stopQuality: 0,
    targetRoom: 0,
    riskReward: 0,
    factors: [],
    qualityFactors: [],
  };
}

function poiInvalido(): POI | null {
  return null;
}

// ------------------------------------------------- 1) o stop não é encurtado

describe("stop estrutural: ATR é PISO, nunca TETO", () => {
  /*
   * Cenário: invalidação estrutural a 4 ATR do preço. O teto antigo
   * (`atr * 1.8` sem POI) devolvia 1,8 ATR — 55% do risco real. Nenhuma linha
   * do gráfico mudava; só o número que o operador via.
   */
  it("assessRisk mantém 4 ATR de stop (não corta para 1,8 ATR)", () => {
    const atr = 10;
    // ref = swingLow − atr·0.2 = 60 ⇒ |price − ref| = 40 = 4 ATR.
    const f = features({ price: 100, atr, swingLow: 62, rangeHigh: 112 });
    const read = assessRisk(
      f,
      priceAction(),
      wyckoff(),
      "COMPRA",
      liquidityVazia(),
      poiInvalido(),
      dataQuality(),
    );

    // Sem liquidez, o obstáculo é `max(rangeHigh, price + 2·atr)` = 120 ⇒ 20 de
    // espaço. `riskReward` é espaço/stop, então o stop é recuperável dele.
    const stopDistance = 20 / read.riskReward;
    expect(stopDistance).toBeCloseTo(4 * atr, 9);
    expect(stopDistance).not.toBeCloseTo(1.8 * atr, 3);

    // A penalidade de "stop excessivo" só faz sentido se o stop excessivo
    // CHEGAR até ela — com o teto, ela era sempre zero por construção.
    const excessivo = read.qualityFactors.find((item) => item.label === "Stop excessivo");
    expect(excessivo?.value).toBe(Math.round((4 - 1.8) * 60));
  });

  it("buildPlan mantém 4 ATR de stop e projeta os alvos sobre ele", () => {
    const atr = 10;
    const entradaEsperada = 100 + atr * 0.12; // reteste do nível: 101.2
    const f = features({
      price: 100,
      atr,
      retestingLevel: 100,
      // ref = swingLow − atr·0.2 ⇒ |entry − ref| = 40 = 4 ATR.
      swingLow: entradaEsperada - 4 * atr + atr * 0.2,
    });

    const plan = buildPlan(
      f,
      priceAction(),
      riskVazio(),
      "COMPRA",
      poiInvalido(),
      smsRead(),
      null,
      DEFAULT_RISK_PARAMS,
    );

    expect(plan).not.toBeNull();
    expect(plan!.entry).toBeCloseTo(entradaEsperada, 9);
    expect(plan!.stopDistance).toBeCloseTo(4 * atr, 9);
    expect(plan!.stopDistance).not.toBeCloseTo(1.8 * atr, 3);
    // Alvos projetados sobre a distância REAL, não sobre a encurtada.
    expect(plan!.target1 - plan!.entry).toBeCloseTo(3 * 4 * atr, 9);
    expect(plan!.target2 - plan!.entry).toBeCloseTo(5 * 4 * atr, 9);
  });
});

// --------------------------------------- 2 e 3) obstáculo antes do alvo final

describe("obstáculo antes do alvo de 5R bloqueia o plano", () => {
  const atr = 10;
  const entradaEsperada = 100 + atr * 0.12;
  const stopEsperado = 4 * atr;

  function cenario(): Features {
    return features({
      price: 100,
      atr,
      retestingLevel: 100,
      swingLow: entradaEsperada - stopEsperado + atr * 0.2,
    });
  }

  it("liquidez a 4R devolve null E escreve o motivo nos blockers", () => {
    const blockers: string[] = [];
    const liquidezA4R = entradaEsperada + 4 * stopEsperado;

    const plan = buildPlan(
      cenario(),
      priceAction(),
      riskVazio(),
      "COMPRA",
      poiInvalido(),
      smsRead(),
      liquidezA4R,
      DEFAULT_RISK_PARAMS,
      blockers,
    );

    // Antes, este caso devolvia um PLANO com target2 puxado para 4R e o campo
    // continuava se chamando alvo final. Agora é NO_TRADE declarado.
    expect(plan).toBeNull();
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("4.00R");
    expect(blockers[0]).toContain("plano bloqueado");
  });

  it("o motivo do bloqueio chega aos blockers da análise, não morre no motor", () => {
    // `analyze()` é quem a tela lê. Um NO_TRADE sem motivo lá é indistinguível
    // de bug, então o canal precisa estar ligado ponta a ponta.
    const serie = serieWin();
    const resultado = analyze(serie, {
      reading: leituraCompleta(serie.length),
      // maxStopDistance de 1 ponto: nenhum stop estrutural do WIN cabe nele, e
      // o motivo tem de aparecer escrito.
      riskParams: { ...riskParamsForAsset("WINFUT"), maxStopDistance: 1 },
    });

    expect(resultado).not.toBeNull();
    expect(resultado!.plan).toBeNull();
    expect(resultado!.blockers).toContain("Plano técnico indisponível.");
    expect(resultado!.blockers.some((item) => item.includes("stop estrutural"))).toBe(true);
  });

  it("liquidez além de 5R não bloqueia e o alvo final continua exatamente 5R", () => {
    const blockers: string[] = [];
    const liquidezA6R = entradaEsperada + 6 * stopEsperado;

    const plan = buildPlan(
      cenario(),
      priceAction(),
      riskVazio(),
      "COMPRA",
      poiInvalido(),
      smsRead(),
      liquidezA6R,
      DEFAULT_RISK_PARAMS,
      blockers,
    );

    expect(plan).not.toBeNull();
    expect(blockers).toHaveLength(0);
    expect(plan!.stopDistance).toBeCloseTo(stopEsperado, 9);
    expect(plan!.target2 - plan!.entry).toBeCloseTo(5 * plan!.stopDistance, 9);
    expect(plan!.riskRewardFinal).toBeCloseTo(5, 9);
    // O alvo é o da TÉCNICA; a liquidez distante não o move para lugar nenhum.
    expect(plan!.target2).toBeLessThan(liquidezA6R);
  });
});

// ------------------------------------------------ 4 e 5) riskParamsForAsset

describe("riskParamsForAsset: o tick do contrato entra no plano", () => {
  const atr = 200;
  const precoWin = 139_000;
  const entradaEsperada = precoWin + atr * 0.12; // 139.024 — fora do tick de 5

  function cenarioWin(): Features {
    return features({
      price: precoWin,
      atr,
      retestingLevel: precoWin,
      swingHigh: precoWin + 400,
      swingLow: entradaEsperada - 4 * atr + atr * 0.2,
      rangeHigh: precoWin + 600,
      rangeLow: precoWin - 1200,
    });
  }

  it("WINFUT: entrada, stop, parcial e alvo saem TODOS múltiplos de 5", () => {
    const plan = buildPlan(
      cenarioWin(),
      priceAction(),
      riskVazio(),
      "COMPRA",
      poiInvalido(),
      smsRead(),
      null,
      riskParamsForAsset("WINFUT"),
    );

    expect(plan).not.toBeNull();
    for (const nivel of [plan!.entry, plan!.stop, plan!.target1, plan!.target2]) {
      expect(nivel % 5).toBe(0);
    }
  });

  it("sem riskParamsForAsset o mesmo plano sai FORA do tick — o defeito que ela impede", () => {
    const plan = buildPlan(
      cenarioWin(),
      priceAction(),
      riskVazio(),
      "COMPRA",
      poiInvalido(),
      smsRead(),
      null,
      DEFAULT_RISK_PARAMS,
    );

    expect(plan).not.toBeNull();
    // tickSize 0 ⇒ `roundToTick` devolve o preço cru: 139.024 não existe no WIN.
    expect(plan!.entry % 5).not.toBe(0);
  });

  it("ativo desconhecido devolve a base INALTERADA (nunca inventa tick)", () => {
    expect(riskParamsForAsset("XPTO")).toBe(DEFAULT_RISK_PARAMS);

    const base: RiskParams = {
      stopMethod: "somente_atr",
      tickSize: 0.25,
      minStopDistance: 7,
      maxStopDistance: 90,
      partialTargetMultiple: 2,
      finalTargetMultiple: 4,
    };
    expect(riskParamsForAsset("XPTO", base)).toBe(base);
    // E com ativo conhecido só o tick muda; o resto da base é preservado.
    expect(riskParamsForAsset("WINFUT", base)).toEqual({ ...base, tickSize: 5 });
  });
});

// ------------------------------------------------------ 6) paridade replay/live

/** Série sintética em faixa de WIN: tendência com pullback, tick de 5. */
function serieWin(): Candle[] {
  const candles: Candle[] = [];
  let close = 139_000;
  for (let i = 0; i < 80; i++) {
    // Impulso de alta com respiro a cada 7 candles — determinístico de propósito.
    const passo = i % 7 === 6 ? -60 : 45;
    const open = close;
    close = open + passo;
    const high = Math.max(open, close) + 25;
    const low = Math.min(open, close) - 25;
    candles.push({
      t: 1_700_000_000_000 + i * 60_000,
      o: open,
      h: high,
      l: low,
      c: close,
      v: 0,
    });
  }
  return candles;
}

function leituraCompleta(closedCandles: number) {
  return buildReadingState({
    closedCandles,
    quality: 100,
    priceScaleReady: true,
    calibrationConfidence: 100,
  });
}

describe("paridade replay/live: mesma série + mesmo ativo ⇒ mesmo plano", () => {
  it("duas chamadas de analyze com o riskParams do ativo produzem plano idêntico", () => {
    const serie = serieWin();
    const reading = leituraCompleta(serie.length);

    const aoVivo = analyze(serie, { reading, riskParams: riskParamsForAsset("WINFUT") });
    const noReplay = analyze([...serie], {
      reading,
      riskParams: riskParamsForAsset("WINFUT"),
    });

    expect(aoVivo).not.toBeNull();
    expect(noReplay).not.toBeNull();
    expect(aoVivo!.direction).toBe(noReplay!.direction);
    expect(aoVivo!.technicalReady).toBe(noReplay!.technicalReady);
    expect(aoVivo!.blockers).toEqual(noReplay!.blockers);
    // Campo a campo: um plano só é "o mesmo plano" se os NÍVEIS forem os mesmos.
    expect(noReplay!.plan).toEqual(aoVivo!.plan);
  });

  it("o replay real reexecuta o bundle sem divergência", () => {
    const serie = serieWin();
    const reading = leituraCompleta(serie.length);
    const avaliadoEm = serie[serie.length - 1]!.t;

    const analise = analyze(serie, { reading, riskParams: riskParamsForAsset("WINFUT") });
    const gates = evaluateT4Gates(analise, true);
    const operation = evaluateOperation({
      dataReady: true,
      dataGates: [],
      t4Gates: gates,
      analysis: analise,
      decision: null,
      entryState: "SCANNING",
      previous: null,
      now: avaliadoEm,
    });

    const bundle = captureVisionReplay({
      sessionId: "teste-paridade",
      symbol: "WINFUT",
      // `SourceMode` é LIVE|REPLAY — o pipeline visual é o único que existe, e
      // por isso não é um MODO. "PROFIT_VISION" não pertence a este eixo.
      sourceMode: "LIVE",
      trigger: "teste",
      candles: serie,
      reading,
      priceScaleReady: true,
      evaluatedAt: avaliadoEm,
      entryState: "SCANNING",
      analysis: analise,
      decision: null,
      t4Gates: gates,
      operation,
      timeline: null,
      capturedAtMarket: avaliadoEm,
      capturedAtSystem: avaliadoEm,
    });

    const resultado = replayTechnique(bundle);
    expect(resultado.divergences).toEqual([]);
    expect(resultado.ok).toBe(true);
    expect(resultado.sameStrategyVersion).toBe(true);
  });

  it("o plano do WIN sai no tick nos DOIS caminhos, não só num deles", () => {
    const serie = serieWin();
    const reading = leituraCompleta(serie.length);
    const analise = analyze(serie, { reading, riskParams: riskParamsForAsset("WINFUT") });

    expect(analise).not.toBeNull();
    if (analise!.plan) {
      for (const nivel of [
        analise!.plan.entry,
        analise!.plan.stop,
        analise!.plan.target1,
        analise!.plan.target2,
      ]) {
        expect(nivel % 5).toBe(0);
      }
    }
  });
});
