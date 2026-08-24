import { describe, expect, it } from "vitest";

import type { PrintAnalysis } from "@/lib/vision/printAnalysis";
import { advanceSetup, type SetupUpdate, type TrackedSetup } from "../setupTracker";

/**
 * T4.2-HYBRID_ENTRY NO RASTREADOR — o consumidor de tela do MESMO motor
 * (t4/t42FillEngine) usado pelo quantBacktest e pelo replay de vídeo.
 *
 * O que se tranca aqui NÃO é a matemática da zona (essa vive nos 22 testes do
 * motor): é o CONTRATO do rastreador com a candidata congelada —
 *   1) confirmação técnica com T4.2 ativa NUNCA libera operação no rompimento;
 *   2) sem OHLC provado do E2 a execução é impossível e o setup morre dizendo
 *      E2_OPEN_OR_UNKNOWN, não fica pendurado;
 *   3) TTL vencido sem toque ⇒ EXPIRED_NO_FILL no razão do setup, e NENHUM
 *      passo do caminho liberou operação — expiração não é operação;
 *   4) toque na zona ⇒ fill com slippage CONTRA, e a operação só nasce depois
 *      de os gates da casa reaprovarem NO PREÇO REAL do fill;
 *   5) obstáculo antes dos 5R do risco novo ⇒ RISK_REJECTED, nunca operação.
 */

const T0 = Date.UTC(2026, 7, 19, 13, 0, 0);
const MIN = 60_000;
const num = (value: number) => ({ value, visible: true });

const CANDLE_FECHADO = {
  id: "candle_confirmacao",
  label: "Candle de confirmação fechado",
  met: true,
  detail: "fechou acima do rompimento",
};

const APROVADO = { approved: true, issues: [], checkedAt: T0, directionContradicted: false };

function analise(overrides: Partial<PrintAnalysis> = {}): PrintAnalysis {
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

/**
 * O E2 da sequência: candle que fechou além do gatilho (169.500) em 169.600
 * com range 200. Zona T4.2 (COMPRA): proximal = 169.600, distal = 169.500 —
 * ambos já múltiplos do tick 5, então o arredondamento é neutro AQUI (a regra
 * de arredondamento em si está trancada nos testes do motor).
 */
const E2 = { o: 169_500, h: 169_650, l: 169_450, c: 169_600 };
/** Nunca volta à zona: mínima 169.650 > proximal 169.600. */
const SEM_TOQUE = { o: 169_700, h: 169_800, l: 169_650, c: 169_750 };
/** Abre DENTRO da zona (169.550): fill na abertura + 5 de slippage = 169.555. */
const TOQUE = { o: 169_550, h: 169_700, l: 169_500, c: 169_650 };

type T42Ctx = {
  e2: { o: number; h: number; l: number; c: number } | null;
  candlesFechadosAposE2: ReadonlyArray<{ o: number; h: number; l: number; c: number }>;
  obstaculo: number | null;
};

/** A sequência mínima que confirma (§14–§16), com a execução T4.2 ligada. */
function confirmadaComT42(t42: T42Ctx): { setup: TrackedSetup; passo: SetupUpdate } {
  const confirmando = { status: "ENTRADA_CONFIRMADA" as const, audit: APROVADO };
  const p1 = advanceSetup(null, analise({ status: "PRE_ENTRADA" }), T0, 1, {
    candle: fechado(169_400, T0),
    t42,
  });
  const p2 = advanceSetup(
    p1.setup,
    analise({ status: "PRE_ENTRADA", currentPrice: num(169_500) }),
    T0 + MIN,
    2,
    { candle: fechado(169_500, T0 + MIN), t42 },
  );
  const p3 = advanceSetup(
    p2.setup,
    analise({ ...confirmando, currentPrice: num(169_600) }),
    T0 + 2 * MIN,
    3,
    { candle: fechado(169_600, T0 + 2 * MIN), t42 },
  );
  const p4 = advanceSetup(
    p3.setup,
    analise({ ...confirmando, currentPrice: num(169_650) }),
    T0 + 3 * MIN,
    4,
    { candle: fechado(169_650, T0 + 3 * MIN), t42 },
  );
  return { setup: p4.setup!, passo: p4 };
}

/** Um passo pós-confirmação: o razão entrega mais um candle FECHADO ao motor. */
function seguir(setup: TrackedSetup, t42: T42Ctx, passoN: number): SetupUpdate {
  return advanceSetup(
    setup,
    analise({ status: "ENTRADA_CONFIRMADA", audit: APROVADO, currentPrice: num(169_700) }),
    T0 + (3 + passoN) * MIN,
    4 + passoN,
    { candle: fechado(169_700, T0 + (3 + passoN) * MIN), t42 },
  );
}

describe("setupTracker × T4.2 — confirmação NÃO é operação", () => {
  it("com t42 ativo, a confirmação entra CONFIRMED aguardando reteste e NÃO libera", () => {
    const { setup, passo } = confirmadaComT42({
      e2: E2,
      candlesFechadosAposE2: [],
      obstaculo: null,
    });
    expect(setup.stage).toBe("CONFIRMED");
    expect(passo.event).toBe("CONFIRMED");
    expect(passo.operacaoLiberada).toBe(false);
    expect(setup.operationReleased).toBe(false);
    expect(setup.t42).toEqual({ e2: E2, fillPrice: null, fillCandle: null });
  });

  it("confirmação SEM OHLC provado do E2 morre com E2_OPEN_OR_UNKNOWN — nunca pendura", () => {
    const { setup, passo } = confirmadaComT42({
      e2: null,
      candlesFechadosAposE2: [],
      obstaculo: null,
    });
    expect(setup.stage).toBe("EXPIRED");
    expect(setup.reason).toContain("E2_OPEN_OR_UNKNOWN");
    expect(passo.operacaoLiberada).toBe(false);
  });
});

describe("setupTracker × T4.2 — TTL sem toque", () => {
  it("3 candles fechados longe da zona ⇒ EXPIRED_NO_FILL no razão, e NENHUM passo liberou", () => {
    const { setup } = confirmadaComT42({ e2: E2, candlesFechadosAposE2: [], obstaculo: null });

    const f1 = seguir(setup, { e2: E2, candlesFechadosAposE2: [SEM_TOQUE], obstaculo: null }, 1);
    expect(f1.setup!.stage).toBe("CONFIRMED");
    expect(f1.headline).toContain("1/3");
    expect(f1.operacaoLiberada).toBe(false);

    const f2 = seguir(
      f1.setup!,
      { e2: E2, candlesFechadosAposE2: [SEM_TOQUE, SEM_TOQUE], obstaculo: null },
      2,
    );
    expect(f2.setup!.stage).toBe("CONFIRMED");
    expect(f2.headline).toContain("2/3");
    expect(f2.operacaoLiberada).toBe(false);

    const f3 = seguir(
      f2.setup!,
      { e2: E2, candlesFechadosAposE2: [SEM_TOQUE, SEM_TOQUE, SEM_TOQUE], obstaculo: null },
      3,
    );
    // A expiração aparece NO RAZÃO do setup — auditável — e não é operação.
    expect(f3.setup!.stage).toBe("EXPIRED");
    expect(f3.setup!.reason).toContain("EXPIRED_NO_FILL");
    expect(f3.operacaoLiberada).toBe(false);
    expect(f3.setup!.operationReleased).toBe(false);
  });
});

describe("setupTracker × T4.2 — fill real", () => {
  it("toque na zona ⇒ fill 169.555 (abertura 169.550 + slippage CONTRA), gates reaprovados, operação liberada", () => {
    const { setup } = confirmadaComT42({ e2: E2, candlesFechadosAposE2: [], obstaculo: null });
    const f1 = seguir(setup, { e2: E2, candlesFechadosAposE2: [TOQUE], obstaculo: null }, 1);

    expect(f1.event).toBe("T42_FILLED");
    expect(f1.operacaoLiberada).toBe(true);
    expect(f1.setup!.operationReleased).toBe(true);
    // A operação nasce NO PREÇO DO FILL, não no gatilho do rompimento.
    expect(f1.setup!.entryLevel).toBe(169_555);
    expect(f1.setup!.t42).toMatchObject({ fillPrice: 169_555, fillCandle: 1 });
    // Alvo 3R sobre o risco NOVO (|169.555 − 169.300| = 255): 169.555 + 765.
    expect(f1.setup!.target).toBe(170_320);
  });

  it("obstáculo antes dos 5R do risco novo ⇒ RISK_REJECTED com TARGET_5R_NO_ROOM — nunca operação", () => {
    const { setup } = confirmadaComT42({ e2: E2, candlesFechadosAposE2: [], obstaculo: null });
    const f1 = seguir(setup, { e2: E2, candlesFechadosAposE2: [TOQUE], obstaculo: 169_700 }, 1);

    expect(f1.setup!.stage).toBe("RISK_REJECTED");
    expect(f1.event).toBe("RISK_REJECTED");
    expect(f1.operacaoLiberada).toBe(false);
    expect(f1.setup!.reason).toContain("TARGET_5R_NO_ROOM");
  });
});
