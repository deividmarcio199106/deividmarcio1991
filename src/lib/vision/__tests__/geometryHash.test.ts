import { describe, expect, it } from "vitest";

import { geometryChanged, geometryHash, ScaleCache, type Geometry } from "../geometryHash";
import { REFERENCE_LAYOUT } from "../profitLayout";

function geometry(overrides: Partial<Geometry> = {}): Geometry {
  return {
    frameWidth: 1365,
    frameHeight: 767,
    roi: {
      x: REFERENCE_LAYOUT.plot.x,
      y: REFERENCE_LAYOUT.plot.y,
      width: REFERENCE_LAYOUT.plot.width,
      height: REFERENCE_LAYOUT.plot.height,
      confidence: 85,
      detail: "",
    },
    priceAxisFrom: REFERENCE_LAYOUT.priceAxis.from,
    symbol: "WINFUT",
    ...overrides,
  };
}

describe("identidade da geometria", () => {
  it("mesma janela produz o mesmo hash", () => {
    expect(geometryHash(geometry())).toBe(geometryHash(geometry()));
  });

  it("o gráfico rolar NÃO muda o hash", () => {
    // O ponto central: candles andam o pregao inteiro sem a escala mudar.
    // Se isso disparasse recalibracao, gastariamos 6-12s de GPU sem parar.
    const antes = geometryHash(geometry());
    const depois = geometryHash(geometry());
    expect(geometryChanged(antes, depois)).toBe(false);
  });

  it("mudar a resolução muda o hash", () => {
    const antes = geometryHash(geometry());
    const depois = geometryHash(geometry({ frameWidth: 1920, frameHeight: 1080 }));
    expect(geometryChanged(antes, depois)).toBe(true);
  });

  it("mudar a área do gráfico muda o hash", () => {
    const antes = geometryHash(geometry());
    const roi = { ...geometry().roi, height: 0.5 };
    expect(geometryChanged(antes, geometryHash(geometry({ roi })))).toBe(true);
  });

  it("mudar o ativo muda o hash — WIN e WDO não compartilham escala", () => {
    const antes = geometryHash(geometry());
    expect(geometryChanged(antes, geometryHash(geometry({ symbol: "WDOFUT" })))).toBe(true);
  });

  it("ruído de antialiasing não dispara recalibração", () => {
    // Meio pixel de borda nao pode custar uma chamada de 6 a 12 segundos.
    const antes = geometryHash(geometry());
    const roi = { ...geometry().roi, x: geometry().roi.x + 0.0002 };
    expect(geometryChanged(antes, geometryHash(geometry({ roi })))).toBe(false);
  });

  it("normaliza caixa do ativo", () => {
    expect(geometryHash(geometry({ symbol: " winfut " }))).toBe(geometryHash(geometry()));
  });
});

describe("cache de escala", () => {
  it("reaproveita a escala da mesma geometria", () => {
    const cache = new ScaleCache<string>();
    const hash = geometryHash(geometry());
    cache.set({
      sessionId: "s1",
      captureRevision: 1,
      geometryHash: hash,
      value: "escala",
      storedAt: 0,
    });

    // Recorte novo (revisao diferente), MESMA geometria: reaproveita.
    const encontrado = cache.get("s1", hash);
    expect(encontrado?.value).toBe("escala");
  });

  it("geometria diferente não reaproveita", () => {
    const cache = new ScaleCache<string>();
    cache.set({
      sessionId: "s1",
      captureRevision: 1,
      geometryHash: geometryHash(geometry()),
      value: "escala",
      storedAt: 0,
    });
    expect(cache.get("s1", geometryHash(geometry({ frameWidth: 800 })))).toBeNull();
  });

  it("sessão diferente não reaproveita — outra janela é outro gráfico", () => {
    const cache = new ScaleCache<string>();
    const hash = geometryHash(geometry());
    cache.set({
      sessionId: "s1",
      captureRevision: 1,
      geometryHash: hash,
      value: "escala",
      storedAt: 0,
    });
    expect(cache.get("s2", hash)).toBeNull();
  });

  it("descarta o mais antigo em vez de crescer sem limite", () => {
    const cache = new ScaleCache<number>(2);
    for (let i = 1; i <= 3; i += 1) {
      cache.set({
        sessionId: "s1",
        captureRevision: i,
        geometryHash: `g${i}`,
        value: i,
        storedAt: i,
      });
    }
    expect(cache.size).toBe(2);
    // Uma escala de meia hora atras nao pode voltar a vida.
    expect(cache.get("s1", "g1")).toBeNull();
    expect(cache.get("s1", "g3")?.value).toBe(3);
  });

  it("reescrever a mesma geometria atualiza em vez de duplicar", () => {
    const cache = new ScaleCache<string>();
    const hash = geometryHash(geometry());
    cache.set({
      sessionId: "s1",
      captureRevision: 1,
      geometryHash: hash,
      value: "antiga",
      storedAt: 0,
    });
    cache.set({
      sessionId: "s1",
      captureRevision: 2,
      geometryHash: hash,
      value: "nova",
      storedAt: 1,
    });
    expect(cache.size).toBe(1);
    expect(cache.get("s1", hash)?.value).toBe("nova");
  });

  it("encerrar a leitura zera o cache", () => {
    const cache = new ScaleCache<string>();
    cache.set({ sessionId: "s1", captureRevision: 1, geometryHash: "g", value: "x", storedAt: 0 });
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
