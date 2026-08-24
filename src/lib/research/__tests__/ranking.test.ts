import { describe, expect, it } from "vitest";

import { DEFAULT_MIN_TRADES, rankVersions, type VersionMetrics } from "../ranking";

/** Versão equilibrada de referência: PF modesto, DD contido, OOS e WF ok. */
const EQUILIBRADA: VersionMetrics = {
  version: "T4.1",
  trades: 120,
  winRate: 0.52,
  expectancyR: 0.35,
  profitFactor: 1.9,
  maxDrawdownR: 8,
  oosExpectancyR: 0.3,
  walkForwardStable: true,
};

describe("rankVersions", () => {
  it("PF alto montado em drawdown gigante PERDE para a alternativa equilibrada", () => {
    const pfBonitoDdMonstro: VersionMetrics = {
      version: "T4.2",
      trades: 110,
      winRate: 0.7,
      expectancyR: 0.6,
      profitFactor: 5,
      maxDrawdownR: 60, // o "lucro" mora em cima de um buraco de 60R
      oosExpectancyR: 0.5,
      walkForwardStable: true,
    };
    const out = rankVersions([pfBonitoDdMonstro, EQUILIBRADA]);
    expect(out[0]!.version).toBe("T4.1");
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
    expect(out[0]!.eligible).toBe(true);
    expect(out[1]!.eligible).toBe(true);
  });

  it("amostra pequena NUNCA vence — nem com métricas espetaculares", () => {
    const milagreDe8Trades: VersionMetrics = {
      version: "T4.3",
      trades: 8,
      winRate: 0.9,
      expectancyR: 2,
      profitFactor: 9,
      maxDrawdownR: 2,
      oosExpectancyR: 1.5,
      walkForwardStable: true,
    };
    const out = rankVersions([milagreDe8Trades, EQUILIBRADA]);
    // Score bruto do milagre é maior — e mesmo assim ele fica ATRÁS.
    expect(out[1]!.version).toBe("T4.3");
    expect(out[1]!.score).toBeGreaterThan(out[0]!.score);
    expect(out[1]!.eligible).toBe(false);
    expect(out[1]!.note).toContain("amostra insuficiente — conclusão NÃO autorizada");
    expect(out[0]!.version).toBe("T4.1");
  });

  it("corte default é 30 trades; minTrades customizado é respeitado", () => {
    const com29 = { ...EQUILIBRADA, version: "T4.4", trades: DEFAULT_MIN_TRADES - 1 };
    const com30 = { ...EQUILIBRADA, version: "T4.5", trades: DEFAULT_MIN_TRADES };
    const out = rankVersions([com29, com30]);
    expect(out.find((v) => v.version === "T4.4")!.eligible).toBe(false);
    expect(out.find((v) => v.version === "T4.5")!.eligible).toBe(true);
    // Com corte 10, os mesmos 29 trades passam a ser elegíveis.
    expect(rankVersions([com29], 10)[0]!.eligible).toBe(true);
  });

  it("OOS ausente REBAIXA o score e a note diz o porquê", () => {
    const semOos = { ...EQUILIBRADA, version: "T4.6", oosExpectancyR: null };
    const comOosZero = { ...EQUILIBRADA, version: "T4.7", oosExpectancyR: 0 };
    const out = rankVersions([semOos, comOosZero]);
    const rebaixada = out.find((v) => v.version === "T4.6")!;
    const referencia = out.find((v) => v.version === "T4.7")!;
    // OOS = 0 soma nada; OOS ausente cobra penalidade — a diferença é só ela.
    expect(rebaixada.score).toBeLessThan(referencia.score);
    expect(rebaixada.note).toContain("sem OOS");
    expect(referencia.note).not.toContain("sem OOS");
  });

  it("walk-forward: instável penaliza, não avaliado apenas anota", () => {
    const instavel = { ...EQUILIBRADA, version: "T4.8", walkForwardStable: false };
    const naoAvaliado = { ...EQUILIBRADA, version: "T4.9", walkForwardStable: null };
    const out = rankVersions([instavel, naoAvaliado, EQUILIBRADA]);
    const scores = Object.fromEntries(out.map((v) => [v.version, v.score]));
    expect(scores["T4.1"]!).toBeGreaterThan(scores["T4.9"]!);
    expect(scores["T4.9"]!).toBeGreaterThan(scores["T4.8"]!);
    expect(out.find((v) => v.version === "T4.8")!.note).toContain("INSTÁVEL");
    expect(out.find((v) => v.version === "T4.9")!.note).toContain("walk-forward não avaliado");
  });

  it("PF Infinity (nenhuma perda) entra pelo TETO com nota, nunca cru", () => {
    const semPerdas = { ...EQUILIBRADA, version: "T4.10", profitFactor: Number.POSITIVE_INFINITY };
    const out = rankVersions([semPerdas]);
    expect(Number.isFinite(out[0]!.score)).toBe(true);
    expect(out[0]!.note).toContain("teto aplicado");
  });

  it("métrica não numérica sai da disputa com motivo declarado", () => {
    const podre = { ...EQUILIBRADA, version: "T4.11", expectancyR: Number.NaN };
    const out = rankVersions([podre, EQUILIBRADA]);
    expect(out[1]!.version).toBe("T4.11");
    expect(out[1]!.eligible).toBe(false);
    expect(out[1]!.note).toContain("métrica não numérica");
  });
});
