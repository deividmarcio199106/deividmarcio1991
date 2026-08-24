import { describe, expect, it } from "vitest";

import { B3_TAXAS_POR_CONTRATO_POR_PERNA, assetConfig } from "../assets";
import { liquidarOperacao, operationCost } from "../costs";

const WIN = assetConfig("WINFUT")!;

describe("taxas da B3", () => {
  it("emolumento + registro é R$ 0,77 por contrato por perna", () => {
    expect(WIN.costs.exchangeFeesPerContract).toBe(B3_TAXAS_POR_CONTRATO_POR_PERNA);
    expect(B3_TAXAS_POR_CONTRATO_POR_PERNA).toBe(0.77);
  });

  it("corretagem é separada do emolumento", () => {
    expect(WIN.costs.brokeragePerContract).toBeGreaterThan(0);
    expect(WIN.costs.brokeragePerContract).not.toBe(WIN.costs.exchangeFeesPerContract);
  });

  it("slippage mínimo de 1 tick na entrada e 1 na saída", () => {
    expect(WIN.costs.spreadTicks).toBeGreaterThanOrEqual(1);
    expect(WIN.costs.slippageTicks).toBeGreaterThanOrEqual(1);
  });

  it("a taxa cobra por perna: 3 saídas custam mais que 1", () => {
    const base = { config: WIN, stopDistancePoints: 100, contracts: 3 };
    const uma = operationCost({ ...base, exitLegs: 1 });
    const tres = operationCost({ ...base, exitLegs: 3 });
    expect(tres.exchangeFees).toBeGreaterThan(uma.exchangeFees);
    expect(tres.exchangeFees).toBeCloseTo(B3_TAXAS_POR_CONTRATO_POR_PERNA * 3 * 4, 6);
  });
});

describe("liquidarOperacao", () => {
  const base = { config: WIN, stopDistancePoints: 100, contracts: 3, exitLegs: 3 };

  it("o R líquido é sempre menor que o bruto quando há custo", () => {
    const l = liquidarOperacao({ ...base, grossR: 3 });
    expect(l.liquido).toBe(true);
    expect(l.netR).toBeLessThan(3);
    expect(l.cost.costR).toBeGreaterThan(0);
  });

  it("result_brl sai do R LÍQUIDO, nunca do bruto", () => {
    const l = liquidarOperacao({ ...base, grossR: 3 });
    const riscoEmReais = 100 * WIN.instrument.pointValue * 3;
    expect(l.resultBrl).toBeCloseTo(l.netR * riscoEmReais, 6);
    expect(l.resultBrl!).toBeLessThan(3 * riscoEmReais);
  });

  it("costs_brl e slippage_points vêm preenchidos", () => {
    const l = liquidarOperacao({ ...base, grossR: 3 });
    expect(l.costsBrl).toBeGreaterThan(0);
    expect(l.slippagePoints).toBeGreaterThan(0);
    expect(l.slippagePoints % WIN.instrument.tickSize).toBeCloseTo(0, 9);
  });

  it("uma perda fica MAIS negativa depois do custo", () => {
    const l = liquidarOperacao({ ...base, grossR: -1 });
    expect(l.netR).toBeLessThan(-1);
    expect(l.resultBrl!).toBeLessThan(0);
  });

  it("sem stop conhecido o R$ líquido é null — nunca o bruto disfarçado", () => {
    const l = liquidarOperacao({ ...base, stopDistancePoints: 0, grossR: 3 });
    expect(l.resultBrl).toBeNull();
    expect(l.liquido).toBe(false);
    expect(l.netR).toBe(3);
  });

  it("stop curto sofre MAIS em R que stop longo, com o mesmo custo em R$", () => {
    const curto = liquidarOperacao({ ...base, stopDistancePoints: 50, grossR: 3 });
    const longo = liquidarOperacao({ ...base, stopDistancePoints: 400, grossR: 3 });
    expect(curto.costsBrl).toBeCloseTo(longo.costsBrl, 6);
    expect(curto.netR).toBeLessThan(longo.netR);
  });
});
