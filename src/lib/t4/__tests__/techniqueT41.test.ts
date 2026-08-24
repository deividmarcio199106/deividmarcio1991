import { describe, expect, it } from "vitest";

import { T4_PRODUCTION_VERSION } from "../version";
import { T41_CANDIDATE_ID, t41Candidate, t41Rules } from "../techniqueT41";

describe("candidata T4.1-REGIME_ADAPTIVE", () => {
  const rec = t41Candidate(1_700_000_000_000);

  it("é registrada com o id e a base exigidos", () => {
    expect(rec.id).toBe("T4.1-REGIME_ADAPTIVE");
    expect(T41_CANDIDATE_ID).toBe("T4.1-REGIME_ADAPTIVE");
    expect(rec.baseVersion).toBe("T4.0.0");
    expect(rec.baseVersion).toBe(T4_PRODUCTION_VERSION);
  });

  it("entra em VALIDATION — nunca já validada", () => {
    expect(rec.status).toBe("VALIDATION");
  });

  it("não altera a técnica de produção", () => {
    expect(rec.version).not.toBe(T4_PRODUCTION_VERSION);
  });

  it("o snapshot carrega os três regimes com o que cada um autoriza", () => {
    const regimes = t41Rules()["regimes"] as Record<string, Record<string, unknown>>;
    expect(Object.keys(regimes)).toEqual([
      "REGIME_A_TENDENCIA",
      "REGIME_B_LATERALIDADE",
      "REGIME_C_GAP_VOLATILIDADE",
    ]);
    expect(regimes["REGIME_A_TENDENCIA"]!["alvosR"]).toEqual([3, 5, "runner"]);
    expect(regimes["REGIME_B_LATERALIDADE"]!["alvosR"]).toEqual([1.5, 2.5]);
    expect(regimes["REGIME_B_LATERALIDADE"]!["runner"]).toBe("PROIBIDO");
    expect(regimes["REGIME_C_GAP_VOLATILIDADE"]!["cooldownCandles"]).toBe(20);
  });

  it("o snapshot carrega runner na MME 9, break-even e relógio B3", () => {
    const rules = t41Rules();
    const gestao = rules["gestao"] as Record<string, unknown>;
    expect(gestao["parcialR"]).toBe(3);
    expect(gestao["alvo2R"]).toBe(5);
    expect(JSON.stringify(gestao["runner"])).toContain("MME 9");
    expect(JSON.stringify(gestao["breakEvenAposParcial"])).toContain("+10 pontos");

    const relogio = rules["relogioB3"] as Record<string, string>;
    expect(Object.keys(relogio)).toEqual(["09:00-09:20", "09:55-10:15", "10:30-10:45", "16:30+"]);
    expect(relogio["16:30+"]).toContain("17:30");
  });

  it("o snapshot declara custo líquido obrigatório", () => {
    const custos = t41Rules()["custos"] as Record<string, unknown>;
    expect(custos["taxasB3PorContratoPorPerna"]).toBe(0.77);
    expect(custos["slippageTicks"]).toEqual({ entrada: 1, stop: 1 });
  });

  it("o snapshot é serializável — é assim que ele vira rules_json", () => {
    const json = JSON.stringify(t41Rules());
    expect(JSON.parse(json)).toEqual(t41Rules());
  });

  it("dois snapshots do mesmo código são idênticos — congelamento é reprodutível", () => {
    expect(JSON.stringify(t41Rules())).toBe(JSON.stringify(t41Rules()));
  });
});
