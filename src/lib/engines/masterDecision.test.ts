import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetAssetValidations, setAssetValidation } from "@/lib/t4/assets";

import type { BacktestTrade } from "./backtestEngine";
import {
  assessDrift,
  computeRecommendedContracts,
  decide,
  dedupeTrades,
  EntryStateMachine,
  tradeSignature,
  type DecisionObject,
} from "./backtestDecisionEngine";
import {
  decayHealth,
  evaluateEvidence,
  monteCarlo,
  splitChronological,
  walkForward,
} from "./evidenceValidation";
import { findSimilarCases, similarityBetween, type SimilarityQuery } from "./historicalSimilarity";
import { resolveInstrument } from "./instruments";
import { STRATEGY_VERSION } from "./strategy";
import type { AnalysisResult } from "./types";

function makeTrade(i: number, overrides: Partial<BacktestTrade> = {}): BacktestTrade {
  const win = (i * 7) % 10 < 6; // 60% determinístico
  return {
    id: `t${i}`,
    setupId: "acumulacao|spring",
    strategyVersion: STRATEGY_VERSION,
    asset: "WINFUT",
    timeframe: "1m",
    openedAt: 1_700_000_000_000 + i * 3_600_000,
    closedAt: 1_700_000_000_000 + i * 3_600_000 + 600_000,
    direction: "COMPRA",
    setup: "spring",
    context: "acumulacao",
    entry: 130_000 + i * 10,
    stop: 129_800 + i * 10,
    target1: 130_320 + i * 10,
    target2: 130_560 + i * 10,
    riskReward: 1.6,
    reversalRisk: 30,
    exit: win ? 130_560 + i * 10 : 129_800 + i * 10,
    result: win ? "GANHO" : "PERDA",
    rMultiple: win ? 1.6 : -1,
    mfePoints: null,
    maePoints: null,
    mfeR: null,
    maeR: null,
    hour: 10,
    wyckoffPhase: "spring",
    poiKind: "order_block",
    regime: "RANGE",
    ...overrides,
  } as BacktestTrade;
}

const query: SimilarityQuery = {
  asset: "WINFUT",
  direction: "COMPRA",
  setup: "spring",
  wyckoffSchema: "acumulacao",
  wyckoffPhase: "spring",
  regime: "RANGE",
  poiKind: "order_block",
  hour: 10,
  riskReward: 1.6,
};

function makeAnalysis(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    t: 1_700_100_000_000,
    price: 131_000,
    direction: "COMPRA",
    technicalReady: true,
    strategyVersion: STRATEGY_VERSION,
    blockers: [],
    contradictions: [],
    regime: { regime: "RANGE", evidences: [], strength: 60 },
    wyckoff: { schema: "acumulacao", phase: "spring" },
    mainPoi: { kind: "order_block" },
    // t4 neutro (setup NONE): a consulta de similaridade cai no fallback
    // wyckoff ("spring"), que é o setup dos trades da base destes testes.
    t4: { setup: "NONE", quality: "REJEITADA", productionReady: false, reasons: [], blockers: [] },
    plan: {
      direction: "COMPRA",
      entry: 131_000,
      stop: 130_800,
      target1: 131_320,
      target2: 131_560,
      riskReward: 1.6,
      riskRewardPlan: 2.1,
      stopDistance: 200,
    },
    ...overrides,
  } as unknown as AnalysisResult;
}

// ---------- similaridade (§30–§31) ----------
describe("similaridade histórica", () => {
  it("compara por vetor de features, não só pelo nome da técnica", () => {
    const same = similarityBetween(query, makeTrade(1));
    expect(same.similarity).toBeGreaterThan(0.9);
    const otherRegime = similarityBetween(query, makeTrade(2, { regime: "TREND_DOWN", hour: 15 }));
    expect(otherRegime.similarity).toBeLessThan(same.similarity);
    const otherDirection = similarityBetween(query, makeTrade(3, { direction: "VENDA" }));
    expect(otherDirection.similarity).toBe(0);
  });

  it("filtra por ativo e ordena por similaridade", () => {
    const trades = [makeTrade(1), makeTrade(2, { asset: "WDOFUT" }), makeTrade(3, { hour: 15 })];
    const cases = findSimilarCases(query, trades);
    expect(cases.every((c) => c.trade.asset === "WINFUT")).toBe(true);
    expect(cases[0]!.similarity).toBeGreaterThanOrEqual(cases[cases.length - 1]!.similarity);
  });
});

// ---------- validação estatística (§36–§43) ----------
describe("validação estatística da evidência", () => {
  const sample = Array.from({ length: 80 }, (_, i) => makeTrade(i));

  it("split cronológico 60/20/20 sem vazamento", () => {
    const split = splitChronological(sample);
    expect(split.train.length + split.validation.length + split.test.length).toBe(80);
    const lastTrain = split.train[split.train.length - 1]!.openedAt;
    expect(split.test.every((t) => t.openedAt > lastTrain)).toBe(true);
  });

  it("walk-forward avalia janelas futuras e detecta estabilidade", () => {
    const wf = walkForward(sample);
    expect(wf.windows.length).toBeGreaterThan(0);
    expect(wf.stable).toBe(true);
    const losing = Array.from({ length: 80 }, (_, i) =>
      makeTrade(i, { rMultiple: -1, result: "PERDA" }),
    );
    expect(walkForward(losing).stable).toBe(false);
  });

  it("Monte Carlo é determinístico com semente fixa", () => {
    const a = monteCarlo(sample, 300, 42)!;
    const b = monteCarlo(sample, 300, 42)!;
    expect(a).toEqual(b);
    expect(a.p95DrawdownR).toBeGreaterThan(0);
    expect(monteCarlo(sample.slice(0, 10))).toBeNull();
  });

  it("§35: win rate alto com expectância ruim = WEAK", () => {
    // 90% de vitórias minúsculas, 10% de perdas enormes.
    const bad = Array.from({ length: 60 }, (_, i) =>
      makeTrade(
        i,
        i % 10 === 0 ? { rMultiple: -9.5, result: "PERDA" } : { rMultiple: 0.2, result: "GANHO" },
      ),
    );
    const report = evaluateEvidence(bad);
    expect(report.stats.winRate).toBeGreaterThan(85);
    expect(report.confidence).toBe("WEAK");
  });

  it("decadência exige amostra e compara recente vs base", () => {
    const decayed = [
      ...Array.from({ length: 60 }, (_, i) => makeTrade(i)),
      ...Array.from({ length: 20 }, (_, i) =>
        makeTrade(60 + i, { rMultiple: -1, result: "PERDA" }),
      ),
    ];
    const health = decayHealth(decayed);
    expect(["DECAYING", "SUSPENDED"]).toContain(health.health);
    expect(decayHealth(decayed.slice(0, 10)).health).toBe("WATCH");
  });
});

// ---------- motor de decisão (§29, §74–§75, §99) ----------
describe("BacktestDecisionEngine", () => {
  // PRODUCAO agora exige ativo VALIDADO para a versao da tecnica em vigor: a
  // evidencia do WIN nao descreve o WDO, e reaproveita-la e a forma mais
  // silenciosa de operar sem base. Estes testes medem a logica de EVIDENCIA, e
  // por isso concedem a validacao explicitamente.
  beforeEach(() => setAssetValidation("WINFUT", "VALIDATED_FOR_PRODUCTION", STRATEGY_VERSION));
  afterEach(() => resetAssetValidations());

  const instrument = resolveInstrument("WINFUT");
  const riskConfig = {
    accountBalance: 10_000,
    maxRiskPercent: 1,
    maxRiskMoney: 0,
    contractsLimit: 5,
  };

  it("§75: sem evidência = WAIT com motivos, preços nulos, nada inventado", () => {
    const decision = decide({
      analysis: makeAnalysis(),
      asset: "WINFUT",
      trades: [],
      instrument,
      riskConfig,
    });
    expect(decision.decision).toBe("WAIT");
    expect(decision.entryPrice).toBeNull();
    expect(decision.recommendedContracts).toBeNull();
    expect(decision.rejectionReasons.some((r) => r.includes("insuficiente"))).toBe(true);
  });

  it("backtest discovery constrói evidência do zero sem afrouxar gates técnicos", () => {
    const decision = decide({
      analysis: makeAnalysis(),
      asset: "WINFUT",
      trades: [],
      instrument,
      riskConfig,
      mode: "BACKTEST_DISCOVERY",
    });
    expect(decision.decision).toBe("ENTER_LONG");
    expect(decision.sampleSize).toBe(0);
    expect(decision.entryPrice).toBe(131_000);
    expect(decision.stopPrice).toBe(130_800);
    expect(decision.recommendedContracts).toBeNull();
    expect(decision.decisionReasons.some((r) => r.includes("BACKTEST_DISCOVERY"))).toBe(true);
  });

  it("backtest discovery continua bloqueando setup tecnicamente incompleto", () => {
    const analysis = makeAnalysis({ technicalReady: false, plan: null });
    const decision = decide({
      analysis,
      asset: "WINFUT",
      trades: [],
      instrument,
      riskConfig,
      mode: "BACKTEST_DISCOVERY",
    });
    expect(decision.decision).toBe("WAIT");
    expect(decision.entryPrice).toBeNull();
  });

  it("evidência forte confirma ENTER_LONG com preços reais do plano e motivos", () => {
    const trades = Array.from({ length: 80 }, (_, i) => makeTrade(i));
    const decision = decide({
      analysis: makeAnalysis(),
      asset: "WINFUT",
      trades,
      instrument,
      riskConfig,
    });
    expect(decision.decision).toBe("ENTER_LONG");
    expect(decision.entryPrice).toBe(131_000);
    expect(decision.stopPrice).toBe(130_800);
    expect(decision.sampleSize).toBeGreaterThanOrEqual(30);
    expect(decision.decisionReasons.some((r) => r.includes("ocorrências semelhantes"))).toBe(true);
    // WIN: 200 pts × R$0,20 = R$40/contrato; risco R$100 => 2 contratos.
    expect(decision.recommendedContracts).toBe(2);
  });

  it("contradição bloqueante = REJECT com motivos; evidência boa não salva", () => {
    const trades = Array.from({ length: 80 }, (_, i) => makeTrade(i));
    const decision = decide({
      analysis: makeAnalysis({
        contradictions: [
          {
            id: "contra-regime",
            severity: "bloqueia",
            description: "Setup contra o regime.",
            evidence: "",
            region: "",
            candleAt: 1,
          },
        ] as AnalysisResult["contradictions"],
      }),
      asset: "WINFUT",
      trades,
      instrument,
      riskConfig,
    });
    expect(decision.decision).toBe("REJECT");
    expect(decision.rejectionReasons[0]).toContain("contra o regime");
  });

  it("mercado fora da distribuição da base = WAIT (§42)", () => {
    const trades = Array.from({ length: 80 }, (_, i) => makeTrade(i));
    const drifted = decide({
      analysis: makeAnalysis({
        regime: { regime: "TREND_DOWN", evidences: [], strength: 60 },
        wyckoff: { schema: "distribuicao", phase: "utad" },
      } as unknown as Partial<AnalysisResult>),
      asset: "WINFUT",
      trades,
      instrument,
      riskConfig,
    });
    expect(["WAIT", "REJECT"]).toContain(drifted.decision);
    expect(drifted.entryPrice).toBeNull();
  });

  it("assessDrift responde OUT_OF_DISTRIBUTION quando não há casos", () => {
    const trades = Array.from({ length: 40 }, (_, i) => makeTrade(i));
    expect(assessDrift([], trades)).toBe("OUT_OF_DISTRIBUTION");
  });
});

// ---------- RiskSizingEngine (§62) ----------
describe("dimensionamento exclusivamente por risco financeiro", () => {
  const instrument = resolveInstrument("WINFUT");

  it("sem configuração financeira devolve null (AGUARDANDO DADOS)", () => {
    const sizing = computeRecommendedContracts({
      direction: "COMPRA",
      entry: 131_000,
      stop: 130_800,
      instrument,
      config: { accountBalance: 0, maxRiskPercent: 0, maxRiskMoney: 0, contractsLimit: 5 },
      currentDrawdownR: 0,
      dailyLossR: 0,
    });
    expect(sizing.recommendedContracts).toBeNull();
  });

  it("perda diária no limite zera contratos; drawdown reduz pela metade", () => {
    const config = {
      accountBalance: 10_000,
      maxRiskPercent: 2,
      maxRiskMoney: 0,
      contractsLimit: 5,
    };
    const base = {
      direction: "COMPRA" as const,
      entry: 131_000,
      stop: 130_800,
      instrument,
      config,
    };
    expect(
      computeRecommendedContracts({ ...base, currentDrawdownR: 0, dailyLossR: 0 })
        .recommendedContracts,
    ).toBe(5);
    expect(
      computeRecommendedContracts({ ...base, currentDrawdownR: 0, dailyLossR: -2 })
        .recommendedContracts,
    ).toBe(0);
    expect(
      computeRecommendedContracts({ ...base, currentDrawdownR: -5, dailyLossR: 0 })
        .recommendedContracts,
    ).toBe(2);
  });
});

// ---------- EntryStateMachine (§55–§56) ----------
describe("máquina de estados da entrada", () => {
  const enterDecision = (): DecisionObject =>
    ({
      decisionId: "d1",
      candidateId: "c1",
      decision: "ENTER_LONG",
      strategyVersion: STRATEGY_VERSION,
      timestamp: 1,
      entryPrice: 131_000,
      stopPrice: 130_800,
      partialPrice: 131_320,
      targetPrice: 131_560,
    }) as unknown as DecisionObject;
  const waitDecision = (): DecisionObject =>
    ({ decisionId: "d2", candidateId: "c1", decision: "WAIT" }) as unknown as DecisionObject;

  it("congela preços ao confirmar e ignora desconfirmações por análise (§55–§56)", () => {
    const machine = new EntryStateMachine();
    machine.onDecision(enterDecision());
    expect(machine.current()).toBe("CONFIRMED");
    const frozen = machine.frozenEntry()!;
    machine.onDecision(waitDecision()); // nova análise hesitou — NÃO desconfirma
    expect(machine.current()).toBe("CONFIRMED");
    expect(machine.frozenEntry()).toBe(frozen);
  });

  it("somente regra objetiva invalida: fechamento além do stop congelado", () => {
    const machine = new EntryStateMachine();
    machine.onDecision(enterDecision());
    machine.onPrice(130_900, "COMPRA"); // tocou entrada => MANAGING
    expect(machine.current()).toBe("MANAGING");
    machine.onPrice(130_700, "COMPRA"); // fechou abaixo do stop
    expect(machine.current()).toBe("INVALIDATED");
  });
});

// ---------- dedupe de operações (§25, §81) ----------
describe("detector de operações duplicadas", () => {
  it("regravar o mesmo período não duplica trades (assinatura estável)", () => {
    const first = Array.from({ length: 5 }, (_, i) => makeTrade(i));
    const rerecorded = Array.from({ length: 5 }, (_, i) =>
      makeTrade(i, { id: `re${i}`, openedAt: 9_999 }),
    );
    const { unique, duplicates } = dedupeTrades(first, rerecorded);
    expect(unique).toHaveLength(0);
    expect(duplicates).toHaveLength(5);
  });

  it("operações genuinamente novas passam", () => {
    const first = Array.from({ length: 3 }, (_, i) => makeTrade(i));
    const fresh = [makeTrade(50, { entry: 140_000, stop: 139_800, target1: 140_320 })];
    const { unique } = dedupeTrades(first, fresh);
    expect(unique).toHaveLength(1);
    expect(tradeSignature(fresh[0]!)).not.toBe(tradeSignature(first[0]!));
  });
});
