import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createBacktestTrade } from "@/lib/engines/backtestEngine";
import { LiveOutcomeTracker } from "@/lib/engines/liveOutcome";
import type { AnalysisResult, Candle } from "@/lib/engines/types";
import { advanceSetup, type TrackedSetup } from "@/lib/print/setupTracker";
import type { PrintAnalysis } from "@/lib/vision/printAnalysis";
import { validatePrintWithOpenAI, type DeterministicSnapshot } from "../openai/printValidation";
import {
  resetTradingRepositoryForTests,
  upsertBacktest,
  verifyT42Freeze,
} from "../tradingRepository";

/**
 * A CADEIA COMPLETA, DE PONTA A PONTA (comando de correção, etapa FINAL):
 *
 *   print → T4 → PRE_ALERTA/ARMADO → E2 FECHADO → zona T4.2 → reteste →
 *   FILL → Luna → Terra → CONFIRMADO → freeze verificado → gestão →
 *   fechamento → ledger COM CUSTOS (e dedup).
 *
 * Tudo com os módulos REAIS — a única substituição é o `fetchImpl` da OpenAI
 * (declarada: rede não entra em teste), respondendo os schemas verdadeiros.
 * O que este teste NÃO afirma: prontidão operacional. Zero flag de veredito
 * nasce aqui — a cadeia funcionar é pré-condição, não homologação.
 */

let workingDir: string | null = null;

function freshDatabase(): string {
  resetTradingRepositoryForTests();
  const dir = mkdtempSync(join(tmpdir(), "analisador-e2e-"));
  workingDir = dir;
  process.env.DATA_DIR = dir;
  delete process.env.DATABASE_PATH;
  process.env.OPENAI_API_KEY = "sk-teste-nunca-logar";
  return dir;
}

afterEach(() => {
  resetTradingRepositoryForTests();
  if (workingDir) rmSync(workingDir, { recursive: true, force: true });
  workingDir = null;
  delete process.env.DATA_DIR;
  delete process.env.DATABASE_PATH;
  delete process.env.OPENAI_API_KEY;
});

/* ---------- fixtures da máquina de setup (mesma receita da suíte) ---------- */

const T0 = Date.UTC(2026, 2, 2, 13, 0, 0);
const MIN = 60_000;
const num = (value: number) => ({ value, visible: true });
const APROVADO = { approved: true, issues: [], checkedAt: T0, directionContradicted: false };

function base(overrides: Partial<PrintAnalysis> = {}): PrintAnalysis {
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
    criteria: [
      {
        id: "candle_confirmacao",
        label: "Candle de confirmação fechado",
        met: true,
        detail: "fechou acima do rompimento",
      },
    ],
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

const E2 = { o: 169_500, h: 169_650, l: 169_450, c: 169_600 };
const TOQUE = { o: 169_550, h: 169_700, l: 169_500, c: 169_650 };
const T42 = (candles: Array<{ o: number; h: number; l: number; c: number }>) => ({
  e2: E2,
  candlesFechadosAposE2: candles,
  obstaculo: null,
});

/* ---------- fixtures da IA (schemas reais, fetch declarado) ---------- */

const lunaPass = {
  captureId: "cap_e2e",
  candleTime: T0 + 4 * MIN,
  direction: "COMPRA",
  regime: "TENDENCIA_ALTA",
  t4Present: true,
  entryVisible: true,
  entry: 169_555,
  stopVisible: true,
  stop: 169_300,
  targetVisible: true,
  target3R: 170_320,
  target5R: 170_830,
  confirmationCandleClosed: true,
  pullbackCandles: 3,
  pivotPreserved: true,
  structureAligned: true,
  obstacleBefore5R: false,
  confidences: { visual: 90, structure: 85, t4: 80, entry: 75 },
  contradictions: [],
  evidence: ["zona do E2 retestada"],
  verdict: "PASS",
};

const terraAprova = {
  approved: true,
  contradictions: [],
  criticalIssue: null,
  evidence: ["sem furo"],
  verdict: "APPROVE",
};

function respostaOk(payload: unknown): Response {
  return new Response(
    JSON.stringify({
      output_text: JSON.stringify(payload),
      usage: { input_tokens: 100, output_tokens: 50 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe.sequential("cadeia completa print→fill→IA→gestão→ledger", () => {
  it("atravessa inteira, com custos no ledger e sem declarar prontidão", async () => {
    const dir = freshDatabase();

    /* 0. FREEZE VERIFICADO — a candidata congelada está íntegra no banco. */
    const freeze = verifyT42Freeze();
    expect(freeze.ok).toBe(true);

    /* 1. print → T4 → toque → rompimento → E2 FECHADO → CONFIRMED com zona T4.2. */
    const confirmando = { status: "ENTRADA_CONFIRMADA" as const, audit: APROVADO };
    const p1 = advanceSetup(null, base({ status: "PRE_ENTRADA" }), T0, 1, {
      candle: fechado(169_400, T0),
      t42: T42([]),
    });
    const p2 = advanceSetup(
      p1.setup,
      base({ status: "PRE_ENTRADA", currentPrice: num(169_500) }),
      T0 + MIN,
      2,
      { candle: fechado(169_500, T0 + MIN), t42: T42([]) },
    );
    const p3 = advanceSetup(
      p2.setup,
      base({ ...confirmando, currentPrice: num(169_600) }),
      T0 + 2 * MIN,
      3,
      { candle: fechado(169_600, T0 + 2 * MIN), t42: T42([]) },
    );
    const p4 = advanceSetup(
      p3.setup,
      base({ ...confirmando, currentPrice: num(169_650) }),
      T0 + 3 * MIN,
      4,
      { candle: fechado(169_650, T0 + 3 * MIN), t42: T42([]) },
    );
    const confirmado = p4.setup as TrackedSetup;
    expect(confirmado.stage).toBe("CONFIRMED");
    expect(confirmado.provaFechamento).toBe("PROVADA");
    expect(p4.operacaoLiberada).toBe(false); // T4.2: confirmação NÃO é operação.

    /* 2. reteste na zona → FILL com slippage → gates reaprovados no preço real. */
    const f1 = advanceSetup(
      confirmado,
      base({ ...confirmando, currentPrice: num(169_700) }),
      T0 + 4 * MIN,
      5,
      { candle: fechado(169_700, T0 + 4 * MIN), t42: T42([TOQUE]) },
    );
    expect(f1.event).toBe("T42_FILLED");
    expect(f1.operacaoLiberada).toBe(true);
    const preenchido = f1.setup as TrackedSetup;
    expect(preenchido.entryLevel).toBe(169_555);
    expect(preenchido.target).toBe(170_320);

    /* 3. Luna → Terra → CONFIRMADO final (persistido na trilha idempotente). */
    let chamadasIa = 0;
    const deterministic: DeterministicSnapshot = {
      pass: true,
      e2Closed: true,
      rr: 3,
      rrOk: true,
      entry: preenchido.entryLevel,
      stop: preenchido.stop,
      levelsValid: true,
      stage: "CONFIRMED",
      blockCode: null,
      blockReason: null,
    };
    const validacao = await validatePrintWithOpenAI({
      imageDataUrl: "data:image/png;base64,QUJD",
      imageHash: "hash_e2e_1",
      captureId: "cap_e2e",
      candleTime: T0 + 4 * MIN,
      deterministic,
      fetchImpl: async () => {
        chamadasIa += 1;
        return respostaOk(chamadasIa === 1 ? lunaPass : terraAprova);
      },
    });
    expect(validacao.final.confirmado).toBe(true);
    expect(chamadasIa).toBe(2); // Luna e Terra — a segunda validação rodou.

    /* 4. gestão 3 contratos (parcial 3R → alvo 5R → runner) até o fechamento. */
    const gestor = new LiveOutcomeTracker(
      "COMPRA",
      preenchido.entryLevel!,
      preenchido.stop!,
      170_320,
      170_830,
      20,
      { threeContractRunner: true },
    );
    const candle = (i: number, o: number, h: number, l: number, c: number): Candle => ({
      t: T0 + (5 + i) * MIN,
      o,
      h,
      l,
      c,
      v: 100,
    });
    gestor.push(candle(0, 169_560, 169_600, 169_540, 169_580)); // executa a entrada
    gestor.push(candle(1, 169_580, 170_350, 169_570, 170_300)); // parcial 3R
    gestor.push(candle(2, 170_300, 170_900, 170_290, 170_850)); // alvo 5R
    // O runner sai no trailing: quedas sucessivas até o stop dinâmico ceder.
    let desfecho = gestor.current();
    for (let i = 3; i < 12 && !desfecho.done; i += 1) {
      const topo = 170_900 - (i - 2) * 300;
      desfecho = gestor.push(candle(i, topo - 50, topo, topo - 400, topo - 350));
    }
    expect(desfecho.filled).toBe(true);
    expect(desfecho.done).toBe(true);
    expect(desfecho.result).toBe("GANHO");
    expect(desfecho.rMultiple).toBeGreaterThan(0);

    /* 5. ledger COM CUSTOS — e idempotente (replay repetido não aumenta N). */
    const analiseCongelada = {
      t: T0 + 4 * MIN,
      strategyVersion: "T4.0.0",
      price: 169_650,
      direction: "COMPRA",
      plan: {
        direction: "COMPRA",
        entry: preenchido.entryLevel,
        stop: preenchido.stop,
        target1: 170_320,
        target2: 170_830,
        riskReward: 3,
        riskRewardFinal: 5,
        riskRewardPlan: 3.5,
        stopDistance: 255,
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
    const trade = createBacktestTrade({
      analysis: analiseCongelada,
      asset: "WINFUT",
      sourceCaptureId: "cap_e2e",
      origin: "VIDEO_REPLAY",
      closedAt: desfecho.exitAt ?? T0 + 9 * MIN,
      exitAt: desfecho.exitAt,
      exit: desfecho.exit ?? 169_950,
      result: "GANHO",
      rMultiple: desfecho.rMultiple!,
      tradingDate: "02/03/2026",
      dna: {},
    });
    expect(trade).not.toBeNull();
    expect(trade!.costsBrl).toBeGreaterThan(0);
    expect(trade!.costR).toBeGreaterThan(0);
    expect(trade!.resultBrl).toBeGreaterThan(0);

    const record = {
      id: "e2e_backtest",
      strategyVersion: "T4.0.0",
      asset: "WINFUT",
      timeframe: "1m",
      createdAt: T0,
      sourceCaptureId: "cap_e2e",
      origin: "VIDEO_REPLAY",
      trades: [{ ...trade!, tradingSessionId: null }],
    } as never;
    upsertBacktest(record);
    upsertBacktest(record); // replay repetido
    resetTradingRepositoryForTests();
    const database = new DatabaseSync(join(dir, "analisador.sqlite"));
    const linhas = database.prepare("SELECT costs_brl, result_brl FROM trades").all() as Array<{
      costs_brl: number;
      result_brl: number;
    }>;
    const trilhaIa = database.prepare("SELECT COUNT(*) AS n FROM ai_validations").get() as {
      n: number;
    };
    database.close();
    expect(linhas).toHaveLength(1); // dedup
    expect(linhas[0]!.costs_brl).toBeGreaterThan(0);
    expect(linhas[0]!.result_brl).toBeGreaterThan(0);
    expect(trilhaIa.n).toBe(1); // Luna/Terra persistidas, uma linha, idempotente
  });
});
