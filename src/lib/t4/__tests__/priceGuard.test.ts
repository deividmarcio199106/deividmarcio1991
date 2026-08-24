import { describe, expect, it } from "vitest";

import {
  absolutePrice,
  guardDecision,
  guardNarration,
  guardOperation,
  PRICE_GUARD_LABEL,
} from "../priceGuard";
import { IDLE_OPERATION, type T4Operation } from "../preEntry";
import type { DecisionObject } from "@/lib/engines/backtestDecisionEngine";

/**
 * O DEFEITO QUE ESTES TESTES TRANCAM.
 *
 * Ao vivo, com a própria tela dizendo "escala ainda em calibração", o chat
 * publicou "Entrada 640.21 · stop 496.00 · parcial 1072.86 · alvo 1361.29".
 * Aqueles números são coordenadas de pixel do gráfico. Um operador que os
 * digitasse numa boleta de WINFUT estaria mandando ordem em cima de uma linha
 * da tela.
 */

/** Operação armada com níveis — em unidade de pixel, que é o caso perigoso. */
const ARMED: T4Operation = {
  ...IDLE_OPERATION,
  stage: "PREPARANDO_VENDA",
  direction: "VENDA",
  maturity: 90,
  entry: 640.21,
  entryZone: { min: 610, max: 670 },
  stop: 496,
  partial: 1072.86,
  target: 1361.29,
  riskPoints: 144.21,
  rewardPoints: 721.08,
  riskReward: 5,
  contracts: 2,
  invalidation: "rompimento de 496 — acima disso o setup deixa de valer",
  setupId: "VENDA:640.2:496.0",
};

describe("guardOperation", () => {
  it("apaga TODO nível absoluto quando a escala não está pronta", () => {
    const guarded = guardOperation(ARMED, false);

    expect(guarded.entry).toBeNull();
    expect(guarded.entryZone).toBeNull();
    expect(guarded.stop).toBeNull();
    expect(guarded.partial).toBeNull();
    expect(guarded.target).toBeNull();
    expect(guarded.riskPoints).toBeNull();
    expect(guarded.rewardPoints).toBeNull();
    expect(guarded.contracts).toBeNull();
  });

  it("preserva estágio, direção e maturidade — a pré-entrada continua nascendo", () => {
    const guarded = guardOperation(ARMED, false);

    // É este o comportamento pedido: SETUP ARMADO com PREÇO EM CALIBRAÇÃO.
    expect(guarded.stage).toBe("PREPARANDO_VENDA");
    expect(guarded.direction).toBe("VENDA");
    expect(guarded.maturity).toBe(90);
    expect(guarded.setupId).toBe(ARMED.setupId);
  });

  it("preserva R:R, que é razão e não muda com a unidade", () => {
    expect(guardOperation(ARMED, false).riskReward).toBe(5);
  });

  it("a invalidação deixa de citar um nível de pixel", () => {
    const guarded = guardOperation(ARMED, false);
    expect(guarded.invalidation).toContain(PRICE_GUARD_LABEL);
    expect(guarded.invalidation).not.toContain("496");
  });

  it("com escala validada, nada é alterado", () => {
    expect(guardOperation(ARMED, true)).toEqual(ARMED);
  });
});

describe("guardDecision", () => {
  const decision = {
    entryPrice: 640.21,
    stopPrice: 496,
    partialPrice: 1072.86,
    targetPrice: 1361.29,
    riskPoints: 144.21,
    rewardPoints: 721.08,
    riskRewardRatio: 5,
    recommendedContracts: 2,
    decision: "ENTER_SHORT",
  } as DecisionObject;

  it("nenhum preço absoluto sobrevive sem escala", () => {
    const guarded = guardDecision(decision, false)!;
    expect(guarded.entryPrice).toBeNull();
    expect(guarded.stopPrice).toBeNull();
    expect(guarded.partialPrice).toBeNull();
    expect(guarded.targetPrice).toBeNull();
    expect(guarded.recommendedContracts).toBeNull();
    // A decisão em si NÃO é alterada: a técnica decidiu o que decidiu.
    expect(guarded.decision).toBe("ENTER_SHORT");
    expect(guarded.riskRewardRatio).toBe(5);
  });

  it("com escala validada, a decisão passa inteira", () => {
    expect(guardDecision(decision, true)).toEqual(decision);
  });
});

describe("guardNarration", () => {
  it("substitui números de preço dentro de frases", () => {
    const line = "PREPARANDO_VENDA · entrada 640.21 · stop 496.00 · alvo 1361.29";
    const guarded = guardNarration(line, false);

    expect(guarded).not.toContain("640.21");
    expect(guarded).not.toContain("496.00");
    expect(guarded).not.toContain("1361.29");
    expect(guarded).toContain(PRICE_GUARD_LABEL);
    // O que não é preço continua legível.
    expect(guarded).toContain("PREPARANDO_VENDA");
  });

  it("com escala validada, a frase passa intacta", () => {
    const line = "entrada 138500 · stop 138200";
    expect(guardNarration(line, true)).toBe(line);
  });
});

describe("absolutePrice", () => {
  it("devolve null em produção em vez do valor cru", () => {
    // Em DEV a mesma chamada estoura, o que é o objetivo: pegar o caminho novo
    // no teste e não na tela do operador.
    const guarded = () => absolutePrice(640.21, false, "teste");
    if (import.meta.env?.DEV) {
      expect(guarded).toThrow(/sem escala validada/);
    } else {
      expect(guarded()).toBeNull();
    }
  });

  it("deixa passar quando a escala está validada", () => {
    expect(absolutePrice(138_500, true, "teste")).toBe(138_500);
  });

  it("valor ausente continua ausente", () => {
    expect(absolutePrice(null, true, "teste")).toBeNull();
    expect(absolutePrice(Number.NaN, true, "teste")).toBeNull();
  });
});

/**
 * O BURACO QUE A AUDITORIA ENCONTROU EM PRODUÇÃO.
 *
 * A guarda cobria campos numéricos e deixava passar o preço formatado DENTRO de
 * texto. Na tela ao vivo, com "escala em calibração" anunciada, apareciam:
 *   gate STOP_VALID    "stop 496.0032958984375 · distância 144.21"
 *   motor adversarial  "liquidez=295.00 entre entrada 303.00 e parcial 141.74"
 */
describe("vazamento por TEXTO — o caminho que escapou da primeira guarda", () => {
  it("o detail do gate STOP_VALID não chega ao card com o preço", () => {
    const comRazoes: T4Operation = {
      ...ARMED,
      reasons: [
        "STOP_VALID: stop 496.0032958984375 · distância 144.21",
        "RISK_REWARD: menor R:R 5.00",
      ],
      missing: ["T4_SIGNAL: setup A/A+ não configurado"],
      blockReason: "CONFIRMATION_CANDLE: aguardando fechamento acima de 640.21",
    };
    const guarded = guardOperation(comRazoes, false);

    expect(guarded.reasons.join(" ")).not.toContain("496.00");
    expect(guarded.reasons.join(" ")).not.toContain("496.0032958984375");
    expect(guarded.blockReason).not.toContain("640.21");
    // O motivo do bloqueio continua legível — só o número sai.
    expect(guarded.blockReason).toContain("CONFIRMATION_CANDLE");
    expect(guarded.reasons.join(" ")).toContain("RISK_REWARD");
  });

  it("a evidência do motor adversarial não publica níveis em pixel", () => {
    const evidencia = "liquidez=295.00 entre entrada 303.00 e parcial 141.74";
    const guardada = guardNarration(evidencia, false);

    expect(guardada).not.toContain("295.00");
    expect(guardada).not.toContain("303.00");
    expect(guardada).not.toContain("141.74");
    expect(guardada).toContain(PRICE_GUARD_LABEL);
  });

  it("com escala validada, razões e evidências passam intactas", () => {
    const comRazoes: T4Operation = {
      ...ARMED,
      reasons: ["STOP_VALID: stop 139250 · distância 250"],
    };
    expect(guardOperation(comRazoes, true).reasons[0]).toContain("139250");
  });
});
