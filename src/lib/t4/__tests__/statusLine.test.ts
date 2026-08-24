import { describe, expect, it } from "vitest";

import { statusLine } from "../diagnostics";

/**
 * A linha de status NUNCA é só "aguardando": todo campo aparece sempre, e
 * bloqueio carrega código + motivo lado a lado. Determinística de propósito —
 * é comparável em teste e grepável em produção.
 */
describe("statusLine", () => {
  it("mostra todos os campos mesmo quando vazios — ausência é dita, não omitida", () => {
    const linha = statusLine({
      setupId: null,
      candleTime: null,
      lastClosed: null,
      estado: "SEM_SETUP",
      gate: null,
      blockCode: null,
      reason: null,
      rr: null,
      busy: false,
      pending: false,
    });
    for (const campo of [
      "setup=",
      "candle=",
      "fechado=",
      "estado=",
      "gate=",
      "bloqueio=",
      "motivo=",
      "rr=",
      "busy=",
      "pendente=",
    ]) {
      expect(linha).toContain(campo);
    }
    expect(linha.toLowerCase()).not.toBe("aguardando");
  });

  it("bloqueio aparece com código E motivo, RR com duas casas", () => {
    const linha = statusLine({
      setupId: "T4-2026-03-02-001",
      candleTime: Date.UTC(2026, 2, 2, 14, 46, 0),
      lastClosed: Date.UTC(2026, 2, 2, 14, 45, 0),
      estado: "ARMED",
      gate: "RISK_REWARD",
      blockCode: "RR_LT_3",
      reason: "R:R 2.99 abaixo do mínimo 3",
      rr: 2.99,
      busy: true,
      pending: false,
    });
    expect(linha).toContain("setup=T4-2026-03-02-001");
    expect(linha).toContain("estado=ARMED");
    expect(linha).toContain("bloqueio=RR_LT_3");
    expect(linha).toContain("motivo=R:R 2.99 abaixo do mínimo 3");
    expect(linha).toContain("rr=2.99");
    expect(linha).toContain("busy=S");
    expect(linha).toContain("candle=14:46:00");
    expect(linha).toContain("fechado=14:45:00");
  });

  it("é determinística: mesma entrada, mesma string", () => {
    const entrada = {
      setupId: "s",
      candleTime: 1_700_000_000_000,
      lastClosed: 1_700_000_000_000,
      estado: "FORMING",
      gate: null,
      blockCode: null,
      reason: null,
      rr: 3,
      busy: false,
      pending: true,
    };
    expect(statusLine(entrada)).toBe(statusLine(entrada));
  });
});
