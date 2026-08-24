import { describe, expect, it } from "vitest";

import {
  evaluateDataGates,
  dataBlockReason,
  MAX_MARKET_DATA_AGE_MS,
  MAX_FRAME_AGE_MS,
} from "../dataGates";

/**
 * O PORTÃO EXISTIA E ESTAVA DESLIGADO.
 *
 * `evaluateOperation` tem o ramo "sem dado válido nada pode ser afirmado", e ele
 * era inalcançável porque o hook passava `dataReady: true` literal. Toda a
 * proteção contra decidir sobre dado morto estava escrita e desconectada.
 */

const NOW = Date.UTC(2026, 7, 11, 17, 0, 0);

function input(over: Partial<Parameters<typeof evaluateDataGates>[0]> = {}) {
  return {
    requested: true,
    usable: true,
    now: NOW,
    lastFrameAt: NOW - 500,
    lastClosedCandleAt: NOW - 30_000,
    closedCandles: 40,
    minimumCandles: 24,
    ...over,
  };
}

describe("gates de dado do pipeline visual", () => {
  it("dado fresco libera a técnica", () => {
    const r = evaluateDataGates(input());
    expect(r.dataReady).toBe(true);
    expect(r.stale).toBe(false);
  });

  it("candle fechado velho bloqueia, mesmo com a captura perfeita", () => {
    // A distinção que este gate existe para fazer: a imagem pode estar chegando
    // a 30fps enquanto a série está congelada há dez minutos.
    const r = evaluateDataGates(
      input({ lastFrameAt: NOW - 200, lastClosedCandleAt: NOW - 10 * 60_000 }),
    );
    expect(r.stale).toBe(true);
    expect(r.dataReady).toBe(false);
    expect(dataBlockReason(r)).toContain("DADO VELHO");
  });

  it("captura que parou de entregar frame é FAIL, não espera", () => {
    const r = evaluateDataGates(input({ lastFrameAt: NOW - MAX_FRAME_AGE_MS - 1_000 }));
    expect(r.dataReady).toBe(false);
    expect(dataBlockReason(r)).toContain("captura parou");
  });

  it("histórico insuficiente é PENDING, não FAIL — é coleta, não defeito", () => {
    const r = evaluateDataGates(input({ closedCandles: 10 }));
    expect(r.dataReady).toBe(false);
    expect(r.stale).toBe(false);
    expect(r.gates.find((g) => g.id === "STRUCTURE")?.status).toBe("PENDING");
  });

  it("mercado parado NÃO é dado velho enquanto o candle for recente", () => {
    // Candles iguais com o minuto corrente em dia: mercado sem negócio é
    // informação legítima, não falha.
    const r = evaluateDataGates(
      input({ lastClosedCandleAt: NOW - MAX_MARKET_DATA_AGE_MS + 5_000 }),
    );
    expect(r.stale).toBe(false);
    expect(r.dataReady).toBe(true);
  });

  it("leitura não iniciada não inventa gate reprovado", () => {
    const r = evaluateDataGates(input({ requested: false }));
    expect(r.dataReady).toBe(false);
    expect(r.gates.every((g) => g.status !== "FAIL")).toBe(true);
  });
});
