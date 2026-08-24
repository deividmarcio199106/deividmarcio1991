import { afterEach, describe, expect, it } from "vitest";

import {
  assetAuthorization,
  assetConfig,
  resetAssetValidations,
  setAssetValidation,
  validatedForProduction,
  validationBlockReason,
} from "../assets";
import { operationCost, netR } from "../costs";
import { T4_PRODUCTION_VERSION } from "../version";

afterEach(() => resetAssetValidations());

/**
 * DOIS DEFEITOS QUE ESTES TESTES TRANCAM.
 *
 * 1. Parâmetros eram GLOBAIS: trocar o ativo na tela mantinha tick e valor do
 *    ponto do anterior. Um WDO analisado com o tick do WIN produz stop, alvo e
 *    tamanho de posição errados, sem nenhum erro aparecer.
 * 2. O backtest media resultado BRUTO. Uma técnica com expectância de +0,15R
 *    pode ser negativa depois de corretagem, emolumentos e derrapagem — e é da
 *    expectância que sai a decisão de operar.
 */

describe("configuração por ativo", () => {
  it("cada ativo tem os SEUS parâmetros — nada é herdado do vizinho", () => {
    const win = assetConfig("WINFUT")!;
    const wdo = assetConfig("WDOFUT")!;
    expect(win.instrument.tickSize).not.toBe(wdo.instrument.tickSize);
    expect(win.instrument.pointValue).not.toBe(wdo.instrument.pointValue);
  });

  it("ativo desconhecido devolve null em vez de emprestar configuração", () => {
    expect(assetConfig("PETR4")).toBeNull();
  });

  it("nenhum ativo nasce liberado para produção", () => {
    for (const symbol of ["WINFUT", "WDOFUT", "INDFUT", "DOLFUT"]) {
      expect(validatedForProduction(assetConfig(symbol), T4_PRODUCTION_VERSION)).toBe(false);
    }
  });

  it("validar um ativo NÃO valida os outros", () => {
    setAssetValidation("WINFUT", "VALIDATED_FOR_PRODUCTION", T4_PRODUCTION_VERSION);
    expect(validatedForProduction(assetConfig("WINFUT"), T4_PRODUCTION_VERSION)).toBe(true);
    expect(validatedForProduction(assetConfig("WDOFUT"), T4_PRODUCTION_VERSION)).toBe(false);
    expect(validationBlockReason(assetConfig("WDOFUT"), "WDOFUT", T4_PRODUCTION_VERSION)).toContain(
      "LAB ONLY",
    );
  });

  it("a validação morre quando a técnica muda de versão", () => {
    setAssetValidation("WINFUT", "VALIDATED_FOR_PRODUCTION", "T4.0.0");
    expect(validatedForProduction(assetConfig("WINFUT"), "T4.1.0")).toBe(false);
    expect(validationBlockReason(assetConfig("WINFUT"), "WINFUT", "T4.1.0")).toContain("Revalidar");
  });

  it("validar para produção sem versão é recusado", () => {
    expect(() => setAssetValidation("WINFUT", "VALIDATED_FOR_PRODUCTION", null)).toThrow(
      /exige a versão/,
    );
  });

  /*
   * NÃO-REGRESSÃO DA PERSISTÊNCIA. A autorização por ativo passou a poder ser
   * gravada, mas por INJEÇÃO: sem store ligado — que é o caso do navegador e de
   * todo teste que não abre banco — o comportamento tem de ser byte a byte o de
   * antes. Estes três casos existem para que ligar a persistência no servidor
   * não mude a decisão de bloqueio no cliente.
   */
  it("sem persistência ligada, conceder não exige trilha — caminho do cliente intacto", () => {
    expect(() =>
      setAssetValidation("WINFUT", "VALIDATED_FOR_PRODUCTION", T4_PRODUCTION_VERSION),
    ).not.toThrow();
    expect(validatedForProduction(assetConfig("WINFUT"), T4_PRODUCTION_VERSION)).toBe(true);
    expect(assetAuthorization("WINFUT")?.evidenceRef).toBeNull();
  });

  it("sem persistência ligada, a autorização morre no reset — segue marca temporária", () => {
    setAssetValidation("WINFUT", "VALIDATED_FOR_PRODUCTION", T4_PRODUCTION_VERSION);
    resetAssetValidations();
    expect(assetConfig("WINFUT")?.validation).toBe("IN_VALIDATION");
    expect(validatedForProduction(assetConfig("WINFUT"), T4_PRODUCTION_VERSION)).toBe(false);
  });

  it("a trilha registra versão, autor e evidência declarados mesmo sem banco", () => {
    setAssetValidation("WINFUT", "VALIDATED_FOR_PRODUCTION", "T4.0.0", {
      evidenceRef: "execucao_42",
      grantedBy: "AUDITORIA",
      at: 1_234,
    });
    expect(assetAuthorization("WINFUT")).toMatchObject({
      symbol: "WINFUT",
      techniqueVersion: "T4.0.0",
      evidenceRef: "execucao_42",
      grantedBy: "AUDITORIA",
      grantedAt: 1_234,
      revokedAt: null,
    });
  });
});

describe("custo operacional", () => {
  const win = () => assetConfig("WINFUT")!;

  it("custo existe e é positivo — backtest não mede mais bruto", () => {
    const c = operationCost({
      config: win(),
      stopDistancePoints: 200,
      contracts: 3,
      exitLegs: 3,
    });
    expect(c.totalMoney).toBeGreaterThan(0);
    expect(c.brokerage).toBeGreaterThan(0);
    expect(c.exchangeFees).toBeGreaterThan(0);
    expect(c.slippage).toBeGreaterThan(0);
  });

  it("cada perna paga: 3 saídas custam mais que 1", () => {
    const base = { config: win(), stopDistancePoints: 200, contracts: 3 };
    const umaSaida = operationCost({ ...base, exitLegs: 1 });
    const tresSaidas = operationCost({ ...base, exitLegs: 3 });
    expect(tresSaidas.totalMoney).toBeGreaterThan(umaSaida.totalMoney);
  });

  it("STOP CURTO É ONDE O CUSTO ENGANA: pesa muito mais em R", () => {
    const curto = operationCost({
      config: win(),
      stopDistancePoints: 50,
      contracts: 3,
      exitLegs: 3,
    });
    const longo = operationCost({
      config: win(),
      stopDistancePoints: 400,
      contracts: 3,
      exitLegs: 3,
    });
    // O custo em dinheiro é o mesmo; em R, o stop curto é muito mais caro.
    expect(curto.totalMoney).toBeCloseTo(longo.totalMoney, 6);
    expect(curto.costR!).toBeGreaterThan(longo.costR! * 4);
  });

  it("resultado líquido é menor que o bruto, e diz que é líquido", () => {
    const c = operationCost({ config: win(), stopDistancePoints: 200, contracts: 3, exitLegs: 3 });
    const r = netR(3, c);
    expect(r.liquido).toBe(true);
    expect(r.r).toBeLessThan(3);
  });

  it("sem risco conversível o custo é declarado indisponível, não zero", () => {
    const c = operationCost({ config: win(), stopDistancePoints: 0, contracts: 3, exitLegs: 3 });
    expect(c.costR).toBeNull();
    const r = netR(3, c);
    expect(r.liquido).toBe(false);
    expect(r.r).toBe(3);
  });
});
