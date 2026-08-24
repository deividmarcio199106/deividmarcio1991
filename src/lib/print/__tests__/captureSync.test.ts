import { describe, expect, it } from "vitest";

import { ATRASO_MAXIMO_MS } from "@/lib/capture/marketMonitor";
import { classificarAtraso, medirLatencias, resultadoGovernaTela } from "../captureSync";

/**
 * O DEFEITO QUE ESTES TESTES TRANCAM: análise #73 aparecendo sobre a imagem
 * #74. Com a GPU lenta, a leitura do candle anterior termina depois de o
 * candle novo já estar na tela — e antes desta regra ela reescrevia as
 * linhas, a ação e o congelamento do print mais recente.
 */

describe("latest-wins — resultado antigo não governa a tela", () => {
  it("resultado da captura ATUAL governa", () => {
    expect(resultadoGovernaTela({ captureId: "cap_74" }, "cap_74")).toBe(true);
  });

  it("resultado de captura ANTERIOR NÃO governa", () => {
    expect(resultadoGovernaTela({ captureId: "cap_73" }, "cap_74")).toBe(false);
  });

  it("imagem colada pelo operador (sem captura) sempre governa", () => {
    // Ela é a decisão explícita dele naquele instante, fora do ciclo de 60s.
    expect(resultadoGovernaTela({ captureId: null }, "cap_74")).toBe(true);
  });

  it("sem captura na tela ainda, o primeiro resultado governa", () => {
    expect(resultadoGovernaTela({ captureId: "cap_01" }, null)).toBe(true);
  });

  it("a regra é identidade, não ordem alfabética nem tempo", () => {
    // Um id "maior" continua não governando se não for o exibido.
    expect(resultadoGovernaTela({ captureId: "cap_999" }, "cap_74")).toBe(false);
  });
});

describe("classificação do atraso da captura", () => {
  it("logo após a virada é SINCRONIZADO", () => {
    expect(classificarAtraso(900)).toBe("SINCRONIZADO");
    expect(classificarAtraso(0)).toBe("SINCRONIZADO");
  });

  it("no limite ainda é SINCRONIZADO; acima dele, ATRASADO", () => {
    expect(classificarAtraso(ATRASO_MAXIMO_MS)).toBe("SINCRONIZADO");
    expect(classificarAtraso(ATRASO_MAXIMO_MS + 1)).toBe("ATRASADO");
  });

  it("captura no meio do candle é ATRASADO — não se finge tempo real", () => {
    expect(classificarAtraso(32_000)).toBe("ATRASADO");
  });
});

describe("latências medidas, ausência declarada", () => {
  const candleTime = Date.UTC(2026, 7, 19, 13, 45, 0);

  it("captura→imagem e captura→análise saem em milissegundos reais", () => {
    const l = medirLatencias({
      candleTime,
      capturedAt: candleTime + 900,
      analiseConcluidaEm: candleTime + 900 + 4_200,
    });
    expect(l.ateImagemMs).toBe(900);
    expect(l.ateAnaliseMs).toBe(4_200);
  });

  it("análise ainda rodando é null, NUNCA zero", () => {
    // Zero se leria como "instantâneo", que é o oposto de "não medido".
    const l = medirLatencias({
      candleTime,
      capturedAt: candleTime + 900,
      analiseConcluidaEm: null,
    });
    expect(l.ateAnaliseMs).toBeNull();
  });

  it("print sem candle (colado/histórico) não inventa latência de imagem", () => {
    const l = medirLatencias({ candleTime: null, capturedAt: 1_000, analiseConcluidaEm: 3_000 });
    expect(l.ateImagemMs).toBeNull();
    expect(l.ateAnaliseMs).toBe(2_000);
  });
});
