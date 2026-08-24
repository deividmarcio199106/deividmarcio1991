import { describe, expect, it } from "vitest";

import type { BacktestTrade } from "./backtestEngine";
import type { Candle, LiquidityCaptureResult, POI, SMSRead, TradePlan } from "./types";
import {
  CAUSAL_ORDER,
  evaluateCausalSequence,
  SEQUENCE_WINDOW_BARS,
  type CausalSequenceInput,
} from "./causalSequence";
import { classifyExcursion, measureReaction, volatilityContext } from "./marketBehavior";
import {
  detectDegradedSetups,
  DEGRADATION_MIN_RECENT,
  reviewTrade,
  setupErrorMatrix,
  statsByKey,
} from "./postTradeReview";
import {
  canPromoteToActive,
  canTransition,
  productionRules,
  type StrategyRule,
} from "./ruleLifecycle";
import { extractJsonObject } from "../jsonExtract";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

function fullSequenceInput(overrides: Partial<CausalSequenceInput> = {}): CausalSequenceInput {
  const capture = {
    valid: true,
    direction: "COMPRA",
    quality: 80,
    isAcceptedBreakoutOnly: false,
    detail: {
      side: "vendedora",
      at: NOW - 5 * MIN,
      closeConfirmed: true,
      status: "capturada_valida",
      price: 99,
    },
  } as unknown as LiquidityCaptureResult;
  const sms = {
    confirmed: true,
    direction: "COMPRA",
    label: "CHoCH altista",
    confidence: 70,
  } as unknown as SMSRead;
  const poi = {
    direction: "COMPRA",
    condition: "testado",
    lower: 99.5,
    upper: 100.5,
    originAt: NOW - 3 * MIN,
  } as unknown as POI;
  const plan = { entry: 100, stop: 99, target1: 102, target2: 103 } as unknown as TradePlan;
  return {
    direction: "COMPRA",
    capture,
    reactionConfirmed: true,
    sms,
    mainPoi: poi,
    plan,
    priceInEntryZone: true,
    price: 100,
    lastCandleAt: NOW,
    // A sequência COMPLETA destes casos é a ancorada em CAPTURA. Declarar a
    // família deixa isso explícito: antes ficava implícito porque o sweep era
    // pré-requisito de todas — e era esse pré-requisito indevido o defeito.
    family: "RANGE_SWEEP",
    ...overrides,
  };
}

// ---------- §131: sequência causal ----------
describe("motor de sequência causal (spec §23–§25, §131)", () => {
  it("sequência válida completa autoriza (todas as etapas met)", () => {
    const read = evaluateCausalSequence(fullSequenceInput());
    expect(read.complete).toBe(true);
    expect(read.missing).toHaveLength(0);
    expect(read.stages.map((s) => s.stage)).toEqual(CAUSAL_ORDER);
  });

  it("evento faltante = WAIT, apontando a primeira etapa ausente", () => {
    const read = evaluateCausalSequence(
      fullSequenceInput({
        sms: { confirmed: false, direction: null, label: "", confidence: 0 } as unknown as SMSRead,
      }),
    );
    expect(read.complete).toBe(false);
    expect(read.missing).toContain("structureShift");
    expect(read.label).toContain("WAIT");
  });

  it("ordem errada (POI anterior ao sweep) invalida a sequência", () => {
    const input = fullSequenceInput();
    (input.mainPoi as { originAt: number }).originAt = NOW - 20 * MIN; // antes do sweep
    (input.capture.detail as { at: number }).at = NOW - 5 * MIN;
    const read = evaluateCausalSequence(input);
    expect(read.orderViolated).toBe(true);
    expect(read.complete).toBe(false);
    expect(read.label).toContain("ordem causal");
  });

  it("sweep antigo demais (fora da janela) reinicia a sequência", () => {
    const input = fullSequenceInput();
    (input.capture.detail as { at: number }).at = NOW - (SEQUENCE_WINDOW_BARS + 5) * MIN;
    const read = evaluateCausalSequence(input);
    expect(read.staleSweep).toBe(true);
    expect(read.complete).toBe(false);
    expect(read.stages[0]!.met).toBe(false);
  });

  it("sequências sobrepostas: sweep do lado errado não serve para a direção", () => {
    const input = fullSequenceInput();
    (input.capture.detail as { side: string }).side = "compradora"; // sweep de topo em setup de compra
    const read = evaluateCausalSequence(input);
    expect(read.stages[0]!.met).toBe(false);
    expect(read.complete).toBe(false);
  });

  it("etapas em cascata: sem reação, nada depois conta", () => {
    const read = evaluateCausalSequence(fullSequenceInput({ reactionConfirmed: false }));
    expect(read.stages.filter((s) => s.met)).toHaveLength(1); // só o sweep
  });
});

// ---------- §132: falso breakout ----------
function excursionFixture(kind: "sweep" | "breakout"): Candle[] {
  const level = 100;
  const base: Candle[] = [];
  for (let i = 0; i < 5; i++) base.push({ t: i, o: 98, h: 99.5, l: 97, c: 98.5, v: 0 });
  if (kind === "sweep") {
    // Excursão acima com pavio dominante, fechamento aquém, retorno imediato.
    base.push({ t: 5, o: 99, h: level + 2, l: 98.5, c: 99.2, v: 0 });
    base.push({ t: 6, o: 99.2, h: 99.6, l: 97.5, c: 98, v: 0 });
  } else {
    // Fechamento além do nível com continuidade.
    base.push({ t: 5, o: 99, h: level + 2.5, l: 98.8, c: level + 1.8, v: 0 });
    base.push({ t: 6, o: level + 1.8, h: level + 3, l: level + 1, c: level + 2.5, v: 0 });
    base.push({ t: 7, o: level + 2.5, h: level + 4, l: level + 2, c: level + 3.4, v: 0 });
  }
  return base;
}

describe("detector de falso rompimento (spec §26, §132)", () => {
  it("pavio sem fechamento além + retorno rápido = LIQUIDITY_SWEEP", () => {
    const read = classifyExcursion(excursionFixture("sweep"), 100, "acima");
    expect(read.kind).toBe("LIQUIDITY_SWEEP");
    expect(read.closedBeyond).toBe(false);
  });

  it("fechamento além com continuidade = BREAKOUT", () => {
    const read = classifyExcursion(excursionFixture("breakout"), 100, "acima");
    expect(read.kind).toBe("BREAKOUT");
    expect(read.continuationBars).toBeGreaterThanOrEqual(1);
  });

  it("sem excursão além do nível = INDEFINIDO com evidência", () => {
    const flat: Candle[] = Array.from({ length: 5 }, (_, i) => ({
      t: i,
      o: 98,
      h: 99,
      l: 97,
      c: 98,
      v: 0,
    }));
    const read = classifyExcursion(flat, 100, "acima");
    expect(read.kind).toBe("INDEFINIDO");
    expect(read.evidences[0]).toContain("Nenhuma excursão");
  });
});

// ---------- §27: qualidade da reação ----------
describe("qualidade da reação (spec §27)", () => {
  it("mede amplitude, velocidade, barras até reação e continuidade em candles reais", () => {
    const window: Candle[] = [
      { t: 0, o: 100, h: 101, l: 99, c: 100, v: 0 }, // evento (índice 0)
      { t: 1, o: 100, h: 103, l: 99.8, c: 102.6, v: 0 },
      { t: 2, o: 102.6, h: 105, l: 102, c: 104.5, v: 0 },
      { t: 3, o: 104.5, h: 106, l: 104, c: 105.5, v: 0 },
    ];
    const read = measureReaction(window, 0, "COMPRA", 2)!;
    expect(read.reactionAmplitude).toBe(6); // 106 - 100
    expect(read.barsUntilReaction).toBe(1);
    expect(read.closeStrength).toBeGreaterThan(0.8);
    expect(read.continuationBars).toBe(2);
    expect(read.reactionAmplitudeAtr).toBe(3);
  });

  it("sem candles posteriores devolve null", () => {
    const single: Candle[] = [{ t: 0, o: 100, h: 101, l: 99, c: 100, v: 0 }];
    expect(measureReaction(single, 0, "COMPRA", 2)).toBeNull();
  });
});

// ---------- §30: volatilidade ----------
describe("filtro de volatilidade (spec §30)", () => {
  it("sinaliza (não bloqueia) candle com amplitude anormal vs mediana", () => {
    const normal: Candle[] = Array.from({ length: 20 }, (_, i) => ({
      t: i,
      o: 100,
      h: 101,
      l: 99,
      c: 100,
      v: 0,
    }));
    const calm = volatilityContext(normal)!;
    expect(calm.abnormal).toBe(false);
    const spiked = [...normal.slice(0, -1), { t: 99, o: 100, h: 108, l: 96, c: 107, v: 0 }];
    const wild = volatilityContext(spiked)!;
    expect(wild.abnormal).toBe(true);
    expect(wild.ratio).toBeGreaterThan(3);
  });
});

// ---------- §44–§46, §50–§51: pós-operação ----------
function tradeFixture(overrides: Partial<BacktestTrade>): BacktestTrade {
  return {
    id: "t1",
    setupId: "Acumulação|C",
    strategyVersion: "v4.0.0",
    asset: "WINFUT",
    rMultiple: 1.5,
    riskReward: 1.6,
    closedAt: NOW,
    mfePoints: null,
    maePoints: null,
    mfeR: null,
    maeR: null,
    ...overrides,
  } as BacktestTrade;
}

describe("autoavaliação pós-operação (spec §44–§46)", () => {
  it("perda sem andar a favor = wrongDirection; perda após 1R+ a favor = badStop", () => {
    const wrongDir = reviewTrade(tradeFixture({ rMultiple: -1, mfeR: 0.1, maeR: 1 }));
    expect(wrongDir.tags).toContain("wrongDirection");
    expect(wrongDir.tags).toContain("falsePositive");
    const badStop = reviewTrade(tradeFixture({ rMultiple: -1, mfeR: 1.4, maeR: 1 }));
    expect(badStop.tags).toContain("badStop");
  });

  it("sem MFE/MAE gravados a classificação fina é unknownDetail — nunca inventada", () => {
    const review = reviewTrade(tradeFixture({ rMultiple: -1 }));
    expect(review.tags).toContain("unknownDetail");
    expect(review.tags).not.toContain("wrongDirection");
  });

  it("ganho com MFE muito além do colhido marca badTarget (alvo curto)", () => {
    const review = reviewTrade(
      tradeFixture({ rMultiple: 1.6, riskReward: 1.6, mfeR: 4, maeR: 0.3 }),
    );
    expect(review.tags).toContain("goodCall");
    expect(review.tags).toContain("badTarget");
  });

  it("matriz de erros agrega por setup com contagens reais", () => {
    const rows = setupErrorMatrix([
      tradeFixture({ id: "a", rMultiple: -1, mfeR: 0.1, maeR: 1 }),
      tradeFixture({ id: "b", rMultiple: 1.6, mfeR: 1.8, maeR: 0.2 }),
      tradeFixture({ id: "c", setupId: "Distribuição|C", rMultiple: -1, mfeR: 1.2, maeR: 1 }),
    ]);
    const acum = rows.find((row) => row.setupId === "Acumulação|C")!;
    expect(acum.total).toBe(2);
    expect(acum.wrongDirection).toBe(1);
    const dist = rows.find((row) => row.setupId === "Distribuição|C")!;
    expect(dist.badStop).toBe(1);
  });

  it("DEGRADED só com amostra suficiente e queda real (§46)", () => {
    const trades: BacktestTrade[] = [];
    // histórico bom: 30 trades, 70% acerto
    for (let i = 0; i < 30; i++) {
      trades.push(
        tradeFixture({ id: `h${i}`, closedAt: NOW + i * MIN, rMultiple: i % 10 < 7 ? 1.5 : -1 }),
      );
    }
    // recente ruim: 15 trades, 20% acerto
    for (let i = 0; i < DEGRADATION_MIN_RECENT; i++) {
      trades.push(
        tradeFixture({
          id: `r${i}`,
          closedAt: NOW + (100 + i) * MIN,
          rMultiple: i % 5 === 0 ? 1.5 : -1,
        }),
      );
    }
    const reads = detectDegradedSetups(trades);
    expect(reads[0]!.degraded).toBe(true);
    // amostra pequena nunca marca DEGRADED
    const small = detectDegradedSetups(trades.slice(0, 10));
    expect(small[0]!.degraded).toBe(false);
    expect(small[0]!.reason).toContain("insuficiente");
  });

  it("estatística separada por ativo e por regime (§50–§51)", () => {
    const rows = statsByKey(
      [
        tradeFixture({ id: "a", asset: "WINFUT", rMultiple: 1 }),
        tradeFixture({ id: "b", asset: "WDOFUT", rMultiple: -1 }),
      ],
      (trade) => trade.asset,
    );
    expect(rows.map((row) => row.key).sort()).toEqual(["WDOFUT", "WINFUT"]);
  });
});

// ---------- §53, §117–§118: ciclo de vida ----------
describe("ciclo de vida de regras (spec §53, §116–§118)", () => {
  const approved: StrategyRule = {
    id: "r1",
    name: "Filtro X",
    state: "APPROVED",
    source: "material próprio",
    version: "1",
    shadow: true,
  };

  it("transições respeitam a ordem; nada pula direto para ACTIVE", () => {
    expect(canTransition("DISCOVERED", "EXTRACTED")).toBe(true);
    expect(canTransition("STRUCTURED", "ACTIVE")).toBe(false);
    expect(canTransition("APPROVED", "ACTIVE")).toBe(true);
    expect(canTransition("TESTING", "APPROVED")).toBe(false);
  });

  it("promoção exige APPROVED + amostra + não piorar o baseline (§69)", () => {
    const baseline = { sample: 100, winRate: 55, expectancy: 0.4 };
    expect(
      canPromoteToActive(approved, baseline, { sample: 10, winRate: 60, expectancy: 0.5 }).allowed,
    ).toBe(false);
    expect(
      canPromoteToActive(approved, baseline, { sample: 40, winRate: 58, expectancy: 0.3 }).allowed,
    ).toBe(false);
    expect(
      canPromoteToActive(approved, baseline, { sample: 40, winRate: 58, expectancy: 0.5 }).allowed,
    ).toBe(true);
    expect(
      canPromoteToActive({ ...approved, state: "TESTING" }, baseline, {
        sample: 40,
        winRate: 58,
        expectancy: 0.5,
      }).allowed,
    ).toBe(false);
  });

  it("produção nunca usa regra shadow ou fora de ACTIVE (§53)", () => {
    const rules: StrategyRule[] = [
      approved,
      { ...approved, id: "r2", state: "ACTIVE", shadow: true },
      { ...approved, id: "r3", state: "ACTIVE", shadow: false },
    ];
    expect(productionRules(rules).map((rule) => rule.id)).toEqual(["r3"]);
  });
});

// ---------- §92: extração robusta de JSON ----------
describe("extração robusta de JSON (spec §92)", () => {
  it("aceita JSON puro, com cercas markdown e com texto antes/depois", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(
      extractJsonObject('Claro! Aqui está:\n```json\n{"a":1}\n```\nEspero ter ajudado.'),
    ).toEqual({ a: 1 });
    expect(extractJsonObject('pensando... {"a":{"b":"tem { chave } na string"}} fim')).toEqual({
      a: { b: "tem { chave } na string" },
    });
  });

  it("sem objeto válido devolve null — nunca um palpite", () => {
    expect(extractJsonObject("não há json aqui")).toBeNull();
    expect(extractJsonObject('{"quebrado": ')).toBeNull();
    expect(extractJsonObject("")).toBeNull();
    expect(extractJsonObject("[1,2,3]")).toBeNull(); // array não é o objeto esperado
  });
});

// ---------- gates por FAMÍLIA: o conserto do "aguardando reação após o sweep" ----------
describe("sequência causal por família (§23–§25)", () => {
  /** Contexto de TENDÊNCIA: pullback defendido, sem nenhuma captura de liquidez. */
  function continuacaoSemSweep(overrides: Partial<CausalSequenceInput> = {}): CausalSequenceInput {
    const base = fullSequenceInput();
    return {
      ...base,
      family: "TREND_FIRST_PULLBACK",
      capture: {
        ...(base.capture as unknown as Record<string, unknown>),
        valid: false,
        detail: {
          side: "nenhuma",
          at: null,
          closeConfirmed: false,
          status: "sem_captura",
          price: null,
        },
      } as unknown as LiquidityCaptureResult,
      // A prova de fechamento da continuação é o fechamento além do nível.
      sms: {
        confirmed: false,
        direction: null,
        label: "",
        confidence: 0,
        closeConfirmed: true,
      } as unknown as SMSRead,
      ...overrides,
    };
  }

  it("TENDÊNCIA sem sweep NÃO fica presa em REACTION — o defeito que travava a técnica", () => {
    const read = evaluateCausalSequence(continuacaoSemSweep());
    const reaction = read.stages.find((s) => s.stage === "reaction")!;
    expect(reaction.met).toBe(true);
    expect(reaction.note).not.toContain("sweep");
    expect(read.missing).not.toContain("reaction");
  });

  it("a família de captura CONTINUA exigindo o sweep — a correção não afrouxou", () => {
    const read = evaluateCausalSequence(continuacaoSemSweep({ family: "RANGE_SWEEP" }));
    const reaction = read.stages.find((s) => s.stage === "reaction")!;
    expect(reaction.met).toBe(false);
    expect(read.missing).toContain("liquiditySweep");
    expect(read.complete).toBe(false);
  });

  it("sem reação confirmada, NENHUMA família avança — reação continua obrigatória", () => {
    for (const family of ["TREND_FIRST_PULLBACK", "RANGE_SWEEP", "HSS_CAPTURE"] as const) {
      const read = evaluateCausalSequence(
        continuacaoSemSweep({ family, reactionConfirmed: false }),
      );
      expect(read.stages.find((s) => s.stage === "reaction")!.met).toBe(false);
      expect(read.complete).toBe(false);
    }
  });

  it("sem fechamento provado, a continuação NÃO confirma — pavio não é candle", () => {
    const read = evaluateCausalSequence(
      continuacaoSemSweep({
        sms: {
          confirmed: false,
          direction: null,
          label: "",
          confidence: 0,
          closeConfirmed: false,
        } as unknown as SMSRead,
      }),
    );
    expect(read.stages.find((s) => s.stage === "confirmationClose")!.met).toBe(false);
    expect(read.complete).toBe(false);
  });

  it("a continuação completa a sequência quando a tese dela é cumprida", () => {
    const read = evaluateCausalSequence(continuacaoSemSweep());
    expect(read.complete).toBe(true);
    expect(read.missing).toHaveLength(0);
  });
});
