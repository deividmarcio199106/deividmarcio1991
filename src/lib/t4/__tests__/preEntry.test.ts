import { describe, expect, it } from "vitest";

import {
  entryZoneFor,
  evaluateOperation,
  justArmed,
  IDLE_OPERATION,
  type OperationInput,
  type T4Operation,
} from "../preEntry";
import type { GateResult } from "@/lib/t4/gates";
import type { DecisionObject } from "@/lib/engines/backtestDecisionEngine";

const NOW = Date.UTC(2026, 7, 10, 13, 45, 0);

const ALL_T4 = [
  "CONTEXT",
  "STRUCTURE",
  "LOCATION",
  "LIQUIDITY",
  "REACTION",
  "STRUCTURE_SHIFT",
  "POI_RETEST",
  "CONFIRMATION_CANDLE",
  "STOP_VALID",
  "RISK_REWARD",
  "T4_SIGNAL",
];

/** Gates com os ids informados em PASS e o resto em PENDING. */
function gates(passing: string[]): GateResult[] {
  return ALL_T4.map((id) => ({
    id,
    status: passing.includes(id) ? "PASS" : "PENDING",
    detail: passing.includes(id) ? "ok" : "aguardando",
  })) as GateResult[];
}

function failing(id: string, passing: string[]): GateResult[] {
  return gates(passing).map((gate) =>
    gate.id === id ? { ...gate, status: "FAIL" as const, detail: "estrutura perdida" } : gate,
  );
}

function decision(overrides: Partial<DecisionObject> = {}): DecisionObject {
  return {
    decision: "ENTER_SHORT",
    entryPrice: 179600,
    stopPrice: 179850,
    partialPrice: 179350,
    targetPrice: 178950,
    riskPoints: 250,
    rewardPoints: 650,
    riskRewardRatio: 2.6,
    recommendedContracts: 2,
    ...overrides,
  } as DecisionObject;
}

function input(overrides: Partial<OperationInput> = {}): OperationInput {
  return {
    dataReady: true,
    dataGates: [],
    t4Gates: gates([]),
    analysis: null,
    decision: decision(),
    entryState: "SCANNING",
    previous: null,
    now: NOW,
    ...overrides,
  };
}

const ARMADO = [
  "CONTEXT",
  "STRUCTURE",
  "LOCATION",
  "LIQUIDITY",
  "REACTION",
  "STRUCTURE_SHIFT",
  "POI_RETEST",
  "STOP_VALID",
  "RISK_REWARD",
];

describe("estágio operacional da T4", () => {
  it("sem dado válido fica AGUARDANDO e não mostra nível nenhum", () => {
    const op = evaluateOperation(
      input({
        dataReady: false,
        // Gate de DADO genérico: o pipeline visual não tem mais gates de feed
        // nomeados, mas `evaluateOperation` continua respeitando qualquer
        // reprovação de dado que o chamador reporte.
        dataGates: [
          {
            id: "CONTEXT",
            label: "Leitura",
            status: "FAIL",
            detail: "captura parada há 12s",
          } as GateResult,
        ],
      }),
    );
    expect(op.stage).toBe("AGUARDANDO");
    expect(op.confirmed).toBe(false);
    // Nivel antigo com feed morto seria uma ordem sugerida sobre dado que nao existe.
    expect(op.entry).toBeNull();
    expect(op.stop).toBeNull();
    expect(op.blockReason).toContain("captura parada");
  });

  it("contexto incompleto fica OBSERVANDO com o próximo passo nomeado", () => {
    const op = evaluateOperation(input({ t4Gates: gates(["CONTEXT"]) }));
    expect(op.stage).toBe("OBSERVANDO");
    expect(op.maturity).toBeLessThan(50);
    expect(op.blockReason).toContain("STRUCTURE");
  });

  it("tudo válido menos o gatilho vira PREPARANDO — antes da entrada", () => {
    const op = evaluateOperation(input({ t4Gates: gates(ARMADO) }));
    expect(op.stage).toBe("PREPARANDO_VENDA");
    expect(op.direction).toBe("VENDA");
    expect(op.maturity).toBe(90);
    // O ponto inteiro do estagio: nivel na tela, sem chamar de confirmado.
    expect(op.entry).toBe(179600);
    expect(op.stop).toBe(179850);
    expect(op.confirmed).toBe(false);
    expect(op.provisional).toBe(true);
    expect(op.armedAt).toBe(NOW);
  });

  it("direção de compra produz PREPARANDO_COMPRA", () => {
    const op = evaluateOperation(
      input({ t4Gates: gates(ARMADO), decision: decision({ decision: "ENTER_LONG" }) }),
    );
    expect(op.stage).toBe("PREPARANDO_COMPRA");
    expect(op.direction).toBe("COMPRA");
  });

  it("candle de confirmação fechado sobe para GATILHO_PROXIMO", () => {
    const op = evaluateOperation(input({ t4Gates: gates(ARMADO.concat(["CONFIRMATION_CANDLE"])) }));
    expect(op.stage).toBe("GATILHO_PROXIMO");
    expect(op.confirmed).toBe(false);
    expect(op.maturity).toBe(96);
  });

  it("só com o gatilho completo vira ENTRADA_CONFIRMADA", () => {
    const op = evaluateOperation(input({ t4Gates: gates(ALL_T4) }));
    expect(op.stage).toBe("ENTRADA_CONFIRMADA");
    expect(op.confirmed).toBe(true);
    expect(op.provisional).toBe(false);
    expect(op.maturity).toBe(100);
  });

  it("nenhum estágio anterior à confirmação marca confirmed", () => {
    // A regra que impede previsao virar sinal.
    const estagios: T4Operation[] = [
      evaluateOperation(input({ t4Gates: gates([]) })),
      evaluateOperation(input({ t4Gates: gates(["CONTEXT"]) })),
      evaluateOperation(input({ t4Gates: gates(ARMADO) })),
      evaluateOperation(input({ t4Gates: gates(ARMADO.concat(["CONFIRMATION_CANDLE"])) })),
    ];
    for (const op of estagios) {
      expect(op.confirmed).toBe(false);
      expect(op.provisional).toBe(true);
    }
  });

  it("setup armado que perde um gate vira INVALIDADA e apaga os níveis", () => {
    const armado = evaluateOperation(input({ t4Gates: gates(ARMADO) }));
    const morto = evaluateOperation(
      input({ t4Gates: failing("STRUCTURE", ARMADO), previous: armado }),
    );
    expect(morto.stage).toBe("INVALIDADA");
    expect(morto.blockReason).toContain("STRUCTURE");
    // Manter ordem sugerida de setup morto seria o pior erro do painel.
    expect(morto.entry).toBeNull();
    expect(morto.stop).toBeNull();
    expect(morto.setupId).toBeNull();
  });

  it("invalidação preserva a direção para o registro", () => {
    const armado = evaluateOperation(input({ t4Gates: gates(ARMADO) }));
    const morto = evaluateOperation(
      input({ t4Gates: failing("LIQUIDITY", ARMADO), previous: armado }),
    );
    expect(morto.direction).toBe("VENDA");
  });

  it("armar mantém o instante original enquanto o setup for o mesmo", () => {
    const primeiro = evaluateOperation(input({ t4Gates: gates(ARMADO) }));
    const depois = evaluateOperation(
      input({ t4Gates: gates(ARMADO), previous: primeiro, now: NOW + 30_000 }),
    );
    expect(depois.armedAt).toBe(NOW);
  });

  it("plano diferente é setup diferente", () => {
    const primeiro = evaluateOperation(input({ t4Gates: gates(ARMADO) }));
    const outro = evaluateOperation(
      input({
        t4Gates: gates(ARMADO),
        decision: decision({ entryPrice: 179000, stopPrice: 179250 }),
        previous: primeiro,
        now: NOW + 60_000,
      }),
    );
    expect(outro.setupId).not.toBe(primeiro.setupId);
    expect(outro.armedAt).toBe(NOW + 60_000);
  });

  it("alerta dispara uma vez por setup", () => {
    const armado = evaluateOperation(input({ t4Gates: gates(ARMADO) }));
    expect(justArmed(null, armado)).toBe(true);
    expect(justArmed(armado, armado)).toBe(false);

    const outro = evaluateOperation(
      input({
        t4Gates: gates(ARMADO),
        decision: decision({ entryPrice: 178000, stopPrice: 178250 }),
      }),
    );
    expect(justArmed(armado, outro)).toBe(true);
  });

  it("observando não dispara alerta", () => {
    const op = evaluateOperation(input({ t4Gates: gates(["CONTEXT"]) }));
    expect(justArmed(null, op)).toBe(false);
  });

  it("faixa de entrada sai do risco do próprio setup", () => {
    // 250 pontos de risco -> tolerancia de 50 para cada lado.
    expect(entryZoneFor(179600, 179850)).toEqual({ min: 179550, max: 179650 });
  });

  it("sem stop não há faixa — não se inventa tolerância", () => {
    expect(entryZoneFor(179600, null)).toBeNull();
    expect(entryZoneFor(null, 179850)).toBeNull();
    expect(entryZoneFor(179600, 179600)).toBeNull();
  });

  it("estado ocioso não afirma nada", () => {
    expect(IDLE_OPERATION.confirmed).toBe(false);
    expect(IDLE_OPERATION.entry).toBeNull();
    expect(IDLE_OPERATION.maturity).toBe(0);
  });

  it("maturidade é monotônica conforme os gates caem", () => {
    const nada = evaluateOperation(input({ t4Gates: gates([]) })).maturity;
    const ctx = evaluateOperation(
      input({ t4Gates: gates(["CONTEXT", "STRUCTURE", "LOCATION"]) }),
    ).maturity;
    const armado = evaluateOperation(input({ t4Gates: gates(ARMADO) })).maturity;
    const confirmado = evaluateOperation(input({ t4Gates: gates(ALL_T4) })).maturity;
    expect(nada).toBeLessThan(ctx);
    expect(ctx).toBeLessThan(armado);
    expect(armado).toBeLessThan(confirmado);
  });
  /*
   * A CAUSA RAIZ DO BACKTEST QUE NUNCA REGISTRAVA TRADE.
   *
   * `entry` e `stop` nascem EXCLUSIVAMENTE de `decision`; sem ela, o ramo do
   * gatilho não pode retornar `confirmed: true` NEM COM OS ONZE GATES EM PASS.
   * Os dois motores de backtest passavam `decision: null` aqui e por isso
   * jamais armaram um setup — nenhum trade, em nenhuma série. Este par de casos
   * tranca a regra nos dois sentidos: com decisão confirma, sem decisão não.
   */
  it("sem decisão não existe confirmação, mesmo com todos os gates em PASS", () => {
    const op = evaluateOperation(input({ t4Gates: gates(ALL_T4), decision: null }));
    expect(op.confirmed).toBe(false);
    expect(op.stage).not.toBe("ENTRADA_CONFIRMADA");
    expect(op.entry).toBeNull();
    expect(op.stop).toBeNull();
  });

  it("a mesma janela com decisão real confirma — a decisão é o que faltava", () => {
    const semDecisao = evaluateOperation(input({ t4Gates: gates(ALL_T4), decision: null }));
    const comDecisao = evaluateOperation(input({ t4Gates: gates(ALL_T4) }));
    expect(semDecisao.confirmed).toBe(false);
    expect(comDecisao.confirmed).toBe(true);
    expect(comDecisao.entry).not.toBeNull();
    expect(comDecisao.stop).not.toBeNull();
  });
});
