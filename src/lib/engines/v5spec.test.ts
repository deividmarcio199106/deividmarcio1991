import { describe, expect, it } from "vitest";

import type { Features } from "./marketFeatures";
import type {
  Candle,
  LiquidityCaptureResult,
  POI,
  PriceActionRead,
  SMSRead,
  TradePlan,
} from "./types";
import { alignToTick, resolveInstrument, validateProductionPrice } from "./instruments";
import {
  computeContractsByFinancialRisk,
  computeMfeMae,
  finalContracts,
  resolveMaxRiskMoney,
  riskPoints,
} from "./financialRisk";
import { detectRegime } from "./regimeEngine";
import { buildContradictions, type ContradictionInput } from "./contradictionEngine";
import { EventStore } from "./eventStore";
import { normalizeYPercent, validateYPercent, yPercentToPixel } from "../vision/yPercent";

// ---------- §81: bateria obrigatória do yPercent ----------
describe("yPercent (spec §12/§81)", () => {
  it("cobre todos os casos obrigatórios do spec", () => {
    expect(validateYPercent(-20).valid).toBe(false);
    expect(validateYPercent(-0.01).valid).toBe(false);
    expect(validateYPercent(0).valid).toBe(true);
    expect(validateYPercent(50).valid).toBe(true);
    expect(validateYPercent(100).valid).toBe(true);
    expect(validateYPercent(100.01).valid).toBe(false);
    expect(validateYPercent(150).valid).toBe(false);
    expect(validateYPercent(NaN).valid).toBe(false);
    expect(validateYPercent(Infinity).valid).toBe(false);
    expect(validateYPercent(undefined).valid).toBe(false);
  });

  it("normaliza pela fórmula do spec e rejeita cropHeight <= 0", () => {
    expect(normalizeYPercent(350, 100, 500).value).toBeCloseTo(50, 6);
    expect(normalizeYPercent(100, 100, 500).value).toBe(0);
    expect(normalizeYPercent(600, 100, 500).value).toBe(100);
    expect(normalizeYPercent(50, 100, 500).valid).toBe(false); // acima do recorte
    expect(normalizeYPercent(350, 100, 0).valid).toBe(false);
    expect(normalizeYPercent(350, 100, -5).valid).toBe(false);
  });

  it("yPercent nunca vira preço direto: só converte para pixel", () => {
    expect(yPercentToPixel(50, 800)).toBe(400);
    expect(yPercentToPixel(120, 800)).toBeNull();
    expect(yPercentToPixel(50, 0)).toBeNull();
  });
});

// ---------- §14/§15: instrumentos ----------
describe("instrumentos (spec §14/§15)", () => {
  it("resolve WIN/WDO com padrões reais e aceita sobrescrita", () => {
    const win = resolveInstrument("WINFUT")!;
    expect(win.tickSize).toBe(5);
    expect(win.pointValue).toBeCloseTo(0.2, 6);
    const custom = resolveInstrument("WINFUT", { pointValue: 0.25 })!;
    expect(custom.pointValue).toBe(0.25);
  });

  it("ativo desconhecido sem configuração completa devolve null (nunca inventa)", () => {
    expect(resolveInstrument("XPTO")).toBeNull();
    expect(resolveInstrument("XPTO", { tickSize: 1 })).toBeNull();
    expect(resolveInstrument("XPTO", { tickSize: 1, pointValue: 2, decimals: 0 })).not.toBeNull();
  });

  it("valida preço de produção por tick real, não por percentual arbitrário", () => {
    const win = resolveInstrument("WINFUT")!;
    expect(alignToTick(132483, win)).toBe(132485);
    expect(validateProductionPrice(132485, win).valid).toBe(true);
    expect(validateProductionPrice(132483, win).valid).toBe(false);
    expect(validateProductionPrice(-5, win).valid).toBe(false);
    expect(validateProductionPrice(NaN, win).valid).toBe(false);
  });
});

// ---------- §29–§32: risco financeiro ----------
describe("risco financeiro real (spec §29–§32)", () => {
  const win = resolveInstrument("WINFUT")!;

  it("riskPoints com direção explícita; stop do lado errado é inválido", () => {
    expect(riskPoints("COMPRA", 132500, 132300)).toBe(200);
    expect(riskPoints("VENDA", 132500, 132700)).toBe(200);
    expect(riskPoints("COMPRA", 132500, 132700)).toBeNull();
    expect(riskPoints("VENDA", 132500, 132300)).toBeNull();
  });

  it("sem configuração financeira NÃO inventa: pede para configurar", () => {
    const result = computeContractsByFinancialRisk("COMPRA", 132500, 132300, win, {
      accountBalance: 0,
      maxRiskPercent: 0,
      maxRiskMoney: 0,
      contractsLimit: 3,
    });
    expect(result.configured).toBe(false);
    expect(result.contracts).toBe(0);
    expect(result.reason).toContain("Configure o risco financeiro");
  });

  it("maxRiskMoney explícito tem prioridade sobre o percentual", () => {
    expect(
      resolveMaxRiskMoney({
        accountBalance: 10000,
        maxRiskPercent: 1,
        maxRiskMoney: 250,
        contractsLimit: 3,
      }),
    ).toBe(250);
    expect(
      resolveMaxRiskMoney({
        accountBalance: 10000,
        maxRiskPercent: 1,
        maxRiskMoney: 0,
        contractsLimit: 3,
      }),
    ).toBe(100);
  });

  it("contas do spec: floor(maxRiskMoney / (riskPoints × pointValue))", () => {
    // WIN: 200 pontos × R$0,20 = R$40/contrato. Risco máx R$100 → 2 contratos.
    const result = computeContractsByFinancialRisk("COMPRA", 132500, 132300, win, {
      accountBalance: 10000,
      maxRiskPercent: 1,
      maxRiskMoney: 0,
      contractsLimit: 5,
    });
    expect(result.riskPerContract).toBeCloseTo(40, 6);
    expect(result.contracts).toBe(2);
  });

  it("quantidade final respeita o risco calculado e o teto físico", () => {
    expect(finalContracts(2, 5)).toBe(2);
    expect(finalContracts(4, 5)).toBe(4);
    expect(finalContracts(4, 2)).toBe(2);
    expect(finalContracts(0, 5)).toBe(0);
  });
});

// ---------- §33–§34: MFE/MAE ----------
describe("MFE/MAE (spec §33–§34)", () => {
  const candles: Candle[] = [
    { t: 1, o: 100, h: 108, l: 97, c: 105, v: 0 },
    { t: 2, o: 105, h: 112, l: 103, c: 110, v: 0 },
  ];

  it("compra: MFE = maxHigh − entry; MAE = entry − minLow", () => {
    const result = computeMfeMae("COMPRA", 100, candles, 5)!;
    expect(result.mfePoints).toBe(12);
    expect(result.maePoints).toBe(3);
    expect(result.mfeR).toBeCloseTo(2.4, 6);
    expect(result.maeR).toBeCloseTo(0.6, 6);
  });

  it("venda: espelhado", () => {
    const result = computeMfeMae("VENDA", 110, candles, null)!;
    expect(result.mfePoints).toBe(13); // 110 - 97
    expect(result.maePoints).toBe(2); // 112 - 110
    expect(result.mfeR).toBeNull();
  });

  it("sem candles posteriores não estima nada", () => {
    expect(computeMfeMae("COMPRA", 100, [])).toBeNull();
  });
});

// ---------- fixtures compartilhadas ----------
function baseFeatures(overrides: Partial<Features> = {}): Features {
  return {
    price: 100,
    atr: 10,
    ema9: 100,
    ema21: 100,
    ema50: 100,
    slope: 0,
    trend: 0,
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
    momentum: 0,
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

function basePA(overrides: Partial<PriceActionRead> = {}): PriceActionRead {
  return {
    imbalance: 0,
    conviction: 40,
    thrust: 30,
    stall: 20,
    exhaustion: 20,
    buyEffort: 50,
    sellEffort: 50,
    ...overrides,
  } as unknown as PriceActionRead;
}

// ---------- §20: regime ----------
describe("detector de regime (spec §20)", () => {
  it("classifica tendências, range, compressão, expansão e transição por evidências", () => {
    expect(detectRegime(baseFeatures({ trend: 0.6 }), basePA()).regime).toBe("TREND_UP");
    expect(detectRegime(baseFeatures({ trend: -0.6 }), basePA()).regime).toBe("TREND_DOWN");
    expect(detectRegime(baseFeatures({ trend: 0.1, rangeWidth: 60 }), basePA()).regime).toBe(
      "RANGE",
    );
    expect(
      detectRegime(baseFeatures({ trend: 0.1, rangeWidth: 30, bodyRatio: 0.3 }), basePA()).regime,
    ).toBe("COMPRESSION");
    expect(
      detectRegime(baseFeatures({ displacement: 0.7, brokeHigh: true }), basePA({ conviction: 60 }))
        .regime,
    ).toBe("EXPANSION");
    expect(detectRegime(baseFeatures({ trend: 0.5, momentum: -0.4 }), basePA()).regime).toBe(
      "TRANSITION",
    );
    expect(detectRegime(baseFeatures({ trend: 0.33 }), basePA()).regime).toBe("UNCLEAR");
  });

  it("toda classificação carrega as evidências numéricas que a produziram", () => {
    const read = detectRegime(baseFeatures({ trend: 0.6 }), basePA());
    expect(read.evidences.length).toBeGreaterThan(0);
    expect(read.evidences[0]).toContain("trend=");
  });
});

// ---------- §18–§19: contradições ----------
function contradictionInput(overrides: Partial<ContradictionInput> = {}): ContradictionInput {
  const capture: LiquidityCaptureResult = {
    valid: true,
    quality: 75,
    direction: "COMPRA",
    detail: { status: "confirmada", side: "vendedora", price: 90, at: 1000 },
  } as unknown as LiquidityCaptureResult;
  const plan: TradePlan = {
    direction: "COMPRA",
    entry: 100,
    stop: 95,
    target1: 108,
    target2: 114,
    riskReward: 1.6,
    riskRewardFinal: 2.8,
    riskRewardPlan: 2.1,
    stopDistance: 5,
    mode: "AGUARDANDO RETESTE",
    entryPoiId: null,
    targetLiquidityPrice: null,
  } as unknown as TradePlan;
  const poi: POI = {
    id: "poi1",
    kind: "order_block",
    direction: "COMPRA",
    condition: "aguardando",
    lower: 96,
    upper: 99,
    invalidation: 94,
    strength: 70,
    originAt: 900,
  } as unknown as POI;
  const sms: SMSRead = {
    confirmed: false,
    direction: "NEUTRO",
    confidence: 0,
  } as unknown as SMSRead;
  return {
    direction: "COMPRA",
    regime: "RANGE",
    f: baseFeatures(),
    priceAction: basePA({ imbalance: 15, conviction: 40 }),
    capture,
    mainPoi: poi,
    plan,
    sms,
    targetLiquidityPrice: null,
    lastCandleAt: 2000,
    ...overrides,
  };
}

describe("motor adversarial (spec §18–§19)", () => {
  it("setup limpo não gera contradições bloqueantes", () => {
    const contradictions = buildContradictions(contradictionInput());
    expect(contradictions.filter((c) => c.severity === "bloqueia")).toHaveLength(0);
  });

  it("bloqueia contra-regime, liquidez antes da parcial e SMS contrário", () => {
    const contra = buildContradictions(contradictionInput({ regime: "TREND_DOWN" }));
    expect(contra.some((c) => c.id === "contra-regime" && c.severity === "bloqueia")).toBe(true);

    const liq = buildContradictions(contradictionInput({ targetLiquidityPrice: 104 }));
    expect(liq.some((c) => c.id === "liquidez-antes-da-parcial")).toBe(true);

    const sms = buildContradictions(
      contradictionInput({
        sms: { confirmed: true, direction: "VENDA", confidence: 70 } as unknown as SMSRead,
      }),
    );
    expect(sms.some((c) => c.id === "sms-contrario")).toBe(true);
  });

  it("é determinístico e classifica alertas sem converter em pontuação", () => {
    const input = contradictionInput({
      capture: {
        valid: true,
        quality: 40,
        direction: "COMPRA",
        detail: { status: "capturada_valida", side: "vendedora", price: 90, at: 1000 },
      } as unknown as LiquidityCaptureResult,
      priceAction: basePA({ imbalance: 0, conviction: 20 }),
      mainPoi: { ...contradictionInput().mainPoi!, strength: 50 },
      plan: { ...contradictionInput().plan!, stopDistance: 25 },
    });
    const a = buildContradictions(input);
    const b = buildContradictions(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.some((item) => item.severity === "alerta")).toBe(true);
    expect(a.every((item) => ["bloqueia", "alerta", "informativa"].includes(item.severity))).toBe(
      true,
    );
  });

  it("contradições nunca viram nota agregada: apenas bloqueiam, alertam ou informam", () => {
    const contradictions = buildContradictions(contradictionInput());
    expect(contradictions.filter((item) => item.severity === "bloqueia")).toHaveLength(0);
    expect(
      contradictions.every((item) => ["bloqueia", "alerta", "informativa"].includes(item.severity)),
    ).toBe(true);
  });
});

// ---------- §21–§23: event store ----------
describe("event store com dedupe semântico (spec §21–§23)", () => {
  it("BOS/CHoCH/quebra no mesmo nível compartilham evidenceGroupId e contam uma vez", () => {
    const storeEvents = new EventStore("WINFUT", 50);
    const base = {
      timestamp: 1000,
      candleId: "WINFUT:60000",
      price: 132500,
      region: "topo do range",
      evidence: "rompimento com corpo",
      confidenceVisual: 0.8,
      sourceCaptureId: "cap1",
    };
    const first = storeEvents.add({ ...base, type: "BOS" });
    const second = storeEvents.add({ ...base, type: "CHOCH", timestamp: 1060 });
    const third = storeEvents.add({ ...base, type: "quebraEstrutural", timestamp: 1120 });
    expect(first.duplicated).toBe(false);
    expect(second.duplicated).toBe(true);
    expect(third.duplicated).toBe(true);
    expect(second.evidenceGroupId).toBe(first.evidenceGroupId);
    expect(storeEvents.timeline()).toHaveLength(3);
    expect(storeEvents.uniqueGroups()).toBe(1);
  });

  it("mesmo tipo em níveis distantes forma grupos distintos", () => {
    const storeEvents = new EventStore("WINFUT", 50);
    const a = storeEvents.add({
      timestamp: 1,
      candleId: "a",
      type: "liquiditySweep",
      price: 132000,
      region: "fundo",
      evidence: "sweep",
      confidenceVisual: 0.9,
      sourceCaptureId: "cap1",
    });
    const b = storeEvents.add({
      timestamp: 2,
      candleId: "b",
      type: "spring",
      price: 133000,
      region: "fundo",
      evidence: "spring",
      confidenceVisual: 0.9,
      sourceCaptureId: "cap2",
    });
    expect(a.evidenceGroupId).not.toBe(b.evidenceGroupId);
    expect(storeEvents.uniqueGroups()).toBe(2);
  });

  it("memória temporal devolve os últimos N eventos", () => {
    const storeEvents = new EventStore("WINFUT", 50);
    for (let i = 0; i < 20; i++) {
      storeEvents.add({
        timestamp: i,
        candleId: `c${i}`,
        type: "pivotHigh",
        price: 130000 + i * 500,
        region: "pivô",
        evidence: "pivô",
        confidenceVisual: 0.7,
        sourceCaptureId: `cap${i}`,
      });
    }
    expect(storeEvents.recent(5)).toHaveLength(5);
    expect(storeEvents.recent(5)[4]!.timestamp).toBe(19);
  });
});
