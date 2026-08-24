import { describe, expect, it } from "vitest";

import { buildReadingState } from "@/lib/t4/readingState";
import { analyze } from "../analysisPipeline";
import { evaluateT4, type T4Input } from "../t4Engine";
import type { OrderedPullbackRead } from "../orderedPullback";
import type { Candle } from "../types";

/**
 * NEW_SETUP_04 NO RUNTIME — o fim do detector órfão (auditoria sênior).
 *
 * `detectOrderedPullback` tinha teste verde e ZERO chamadas fora de teste.
 * Estes testes provam a CADEIA VIVA, não o detector (que já tem os seus):
 *
 *   1. `analyze()` CHAMA o detector — a prova é comportamental: sem
 *      `lastCandleClosed`, o blocker com o texto que SÓ o detector emite
 *      aparece no resultado. Não há segunda regra local que produza a frase.
 *   2. O código estável viaja: "NEW_SETUP_04 BLOQUEADA E2_OPEN_OR_UNKNOWN"
 *      é o que log/homologação comparam — a prosa é para o operador.
 *   3. Com a prova de fechamento presente, NENHUM blocker novo aparece —
 *      ligar o detector não pode mudar `technicalReady` de produção.
 *   4. O roteador consome a leitura: present=true e direção alinhada viram
 *      ORDERED_PULLBACK_TREND — SEMPRE `productionReady:false` (laboratório);
 *      leitura ausente ou direção contrária seguem em NONE.
 */

const T0 = Date.UTC(2026, 2, 13, 13, 0, 0);
const MINUTO = 60_000;

/** Série pseudoaleatória determinística (LCG) — a mesma receita do quant. */
function serie(n: number, seedInicial = 42): Candle[] {
  const out: Candle[] = [];
  let preco = 139_000;
  let seed = seedInicial;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    preco += ((seed % 240) - 118) / 2;
    const abertura = preco;
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    const fechamento = preco + ((seed % 160) - 80) / 2;
    out.push({
      t: T0 + i * MINUTO,
      o: abertura,
      h: Math.max(abertura, fechamento) + 15,
      l: Math.min(abertura, fechamento) - 15,
      c: fechamento,
      v: 100 + (i % 7),
    });
    preco = fechamento;
  }
  return out;
}

const READING = buildReadingState({
  closedCandles: 80,
  quality: 100,
  priceScaleReady: true,
  calibrationConfidence: 100,
});

describe("analyze() × detectOrderedPullback — a cadeia viva", () => {
  it("sem prova de fechamento, o blocker sai COM CÓDIGO — e vem do detector", () => {
    const resultado = analyze(serie(80), {
      reading: { ...READING, lastCandleClosed: false },
    });
    expect(resultado).not.toBeNull();
    // A frase pré-existente do pipeline continua (o operador a conhece)...
    expect(resultado!.blockers).toContain("Último candle ainda está em formação.");
    // ...e o CÓDIGO estável viaja junto, com o motivo emitido pelo detector.
    const comCodigo = resultado!.blockers.find((b) =>
      b.startsWith("NEW_SETUP_04 BLOQUEADA E2_OPEN_OR_UNKNOWN"),
    );
    expect(comCodigo).toBeDefined();
    expect(comCodigo).toContain("candle");
  });

  it("com prova de fechamento, ligar o detector NÃO acrescenta blocker de produção", () => {
    const resultado = analyze(serie(80), { reading: READING });
    expect(resultado).not.toBeNull();
    expect(resultado!.blockers.join(" ")).not.toContain("E2_OPEN_OR_UNKNOWN");
  });

  it("determinismo preservado: duas execuções idênticas com o detector ligado", () => {
    const a = analyze(serie(80), { reading: READING });
    const b = analyze(serie(80), { reading: READING });
    expect(a).toEqual(b);
  });
});

/**
 * T4Input mínimo que atravessa os gates gerais e NÃO completa nenhuma família
 * de produção: regime RANGE fora da borda, sem captura, sem SMS — o roteador
 * chega ao ramo 7 (NEW_SETUP_04) com `setup === "NONE"` e tendência alinhada.
 */
function inputSemFamiliaDeProducao(op: OrderedPullbackRead | null | undefined): T4Input {
  return {
    windowLength: 60,
    direction: "COMPRA",
    f: {
      trend: 0.5,
      locationInTrend: 0.5,
      price: 169_500,
      positionInRange: 0.5,
      momentum: 0,
      brokeHigh: false,
      brokeLow: false,
      displacement: 0,
      retestingLevel: null,
    } as T4Input["f"],
    priceAction: {
      imbalance: 0,
      conviction: 40,
      exhaustion: 10,
      thrust: 10,
      contrary: false,
    } as T4Input["priceAction"],
    regime: { regime: "RANGE" } as T4Input["regime"],
    capture: {
      valid: false,
      direction: null,
      detail: { type: "nenhuma", status: "sem_captura", price: null },
    } as unknown as T4Input["capture"],
    mainPoi: {
      condition: "intacto",
      strength: 50,
      lower: 169_000,
      upper: 169_400,
    } as unknown as T4Input["mainPoi"],
    sms: { confirmed: false, direction: "NEUTRO" } as unknown as T4Input["sms"],
    plan: {
      stopDistance: 200,
      riskReward: 3,
      riskRewardFinal: 5,
      riskRewardPlan: 3.5,
    } as T4Input["plan"],
    risk: { reversalRisk: 20 } as T4Input["risk"],
    contradictions: [],
    orderedPullback: op,
  };
}

/** Leitura armada do detector — só os campos que o roteador consome. */
function leituraArmada(direction: "COMPRA" | "VENDA"): OrderedPullbackRead {
  return {
    present: true,
    direction,
    pullbackCandles: 4,
    invalidatedByLength: false,
    pullbackStartIndex: 40,
    confirmationIndex: 45,
    pullbackExtreme: 169_300,
    priorPivot: 169_100,
    averageImpulseBody: 60,
    averagePullbackBody: 20,
    correctionBodyRatio: 0.33,
    pivotPreserved: true,
    confirmationClosed: true,
    reasons: ["Pullback ordenado 4 candles + pivô preservado + E2 fechada."],
    blockers: [],
    blocks: [],
  };
}

describe("evaluateT4 × leitura NEW_SETUP_04 — o ramo consome, nunca promove", () => {
  it("leitura armada e alinhada vira ORDERED_PULLBACK_TREND — laboratório, nunca produção", () => {
    const verdict = evaluateT4(inputSemFamiliaDeProducao(leituraArmada("COMPRA")));
    expect(verdict.setup).toBe("ORDERED_PULLBACK_TREND");
    expect(verdict.productionReady).toBe(false);
    expect(verdict.quality).toBe("B");
    expect(verdict.blockers.join(" ")).toContain("laboratório");
  });

  it("sem leitura, o mesmo contexto segue NONE — o ramo exige o detector", () => {
    expect(evaluateT4(inputSemFamiliaDeProducao(null)).setup).toBe("NONE");
    expect(evaluateT4(inputSemFamiliaDeProducao(undefined)).setup).toBe("NONE");
  });

  it("direção da leitura contrária à do contexto NÃO arma", () => {
    expect(evaluateT4(inputSemFamiliaDeProducao(leituraArmada("VENDA"))).setup).toBe("NONE");
  });
});
