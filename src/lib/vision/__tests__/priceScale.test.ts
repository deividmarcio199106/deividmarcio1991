import { describe, expect, it } from "vitest";

import {
  assetScaleIssue,
  calibrateFromAnchors,
  calibrationDrift,
  decimalsOf,
  emptyCalibration,
  parsePriceLabel,
  priceAt,
  SCALE_CONFIG,
  visibleRange,
  yAt,
  type ScaleAnchor,
  calibrationGrade,
  normalizeScaleAnchorsForAsset,
} from "../priceScale";

function anchor(y: number, price: number, raw?: string, confidence = 0.95): ScaleAnchor {
  return { y, price, raw: raw ?? String(price), source: "ocr", confidence };
}

describe("assetScaleIssue — plausibilidade por ativo", () => {
  it("rejeita números de indicador usados como preço do WINFUT", () => {
    expect(assetScaleIssue("WINFUT", [anchor(100, 175, "175.00")])).toContain(
      "fora da faixa plausível",
    );
  });

  it("aceita escala plausível do WINFUT e não inventa regra para ativo desconhecido", () => {
    expect(assetScaleIssue("WINFUT", [anchor(100, 138_750, "138.750")])).toBeNull();
    expect(assetScaleIssue("PETR4", [anchor(100, 35.5, "35,50")])).toBeNull();
  });
});

describe("parsePriceLabel — formatos reais de escala", () => {
  it("lê formato brasileiro com vírgula decimal", () => {
    expect(parsePriceLabel("5.432,50")).toBe(5432.5);
    expect(parsePriceLabel("138.750,25")).toBe(138750.25);
  });

  it("lê formato internacional com ponto decimal", () => {
    expect(parsePriceLabel("138,750.25")).toBe(138750.25);
    expect(parsePriceLabel("5432.50")).toBe(5432.5);
  });

  it("trata separador único de 3 dígitos como milhar", () => {
    expect(parsePriceLabel("1.234")).toBe(1234);
    expect(parsePriceLabel("1,234")).toBe(1234);
  });

  it("lê decimais curtos sem ambiguidade", () => {
    expect(parsePriceLabel("132,5")).toBe(132.5);
    expect(parsePriceLabel("132.5")).toBe(132.5);
  });

  it("devolve null para texto não numérico em vez de inventar valor", () => {
    expect(parsePriceLabel("")).toBeNull();
    expect(parsePriceLabel("---")).toBeNull();
    expect(parsePriceLabel("WDO")).toBeNull();
  });
});

describe("decimalsOf", () => {
  it("reconhece casas decimais", () => {
    expect(decimalsOf("5432,50")).toBe(2);
    expect(decimalsOf("132,5")).toBe(1);
    expect(decimalsOf("5432")).toBe(0);
  });

  it("não confunde milhar com decimal", () => {
    expect(decimalsOf("1.234")).toBe(0);
    expect(decimalsOf("138.750,25")).toBe(2);
  });
});

describe("calibrateFromAnchors — gates obrigatórios", () => {
  it("REJEITA calibração com uma única âncora", () => {
    const cal = calibrateFromAnchors([anchor(100, 5000)]);
    expect(cal.usable).toBe(false);
    expect(cal.status).toBe("ancoras_insuficientes");
  });

  it("REJEITA âncoras concentradas em poucos pixels", () => {
    const cal = calibrateFromAnchors([anchor(100, 5000), anchor(110, 5001)]);
    expect(cal.usable).toBe(false);
    expect(cal.status).toBe("ancoras_insuficientes");
  });

  it("REJEITA escala não linear (logarítmica)", () => {
    // Espaçamento de pixel constante com preços em progressão geométrica.
    const cal = calibrateFromAnchors([
      anchor(0, 1000),
      anchor(100, 2000),
      anchor(200, 4000),
      anchor(300, 8000),
    ]);
    expect(cal.usable).toBe(false);
    expect(cal.status).toBe("escala_nao_linear");
  });

  it("REJEITA quando a confiança do OCR é baixa", () => {
    const cal = calibrateFromAnchors([
      anchor(0, 5100, "5100", 0.3),
      anchor(100, 5000, "5000", 0.3),
      anchor(200, 4900, "4900", 0.3),
    ]);
    expect(cal.usable).toBe(false);
    expect(cal.status).toBe("confianca_baixa");
    expect(cal.confidence).toBeLessThan(SCALE_CONFIG.minConfidence);
  });

  it("ACEITA escala linear com 3 âncoras e interpola corretamente", () => {
    const cal = calibrateFromAnchors([
      anchor(0, 5100, "5.100,00"),
      anchor(100, 5000, "5.000,00"),
      anchor(200, 4900, "4.900,00"),
    ]);
    expect(cal.usable).toBe(true);
    expect(cal.status).toBe("calibrada");
    // 1 pixel = 1 ponto, preço cai conforme y cresce.
    expect(cal.slope).toBeCloseTo(-1, 6);
    expect(priceAt(cal, 50)).toBeCloseTo(5050, 6);
    expect(priceAt(cal, 150)).toBeCloseTo(4950, 6);
  });

  it("aceita o mínimo de 2 âncoras, com confiança menor que com 3", () => {
    const duas = calibrateFromAnchors([anchor(0, 5100), anchor(200, 4900)]);
    const tres = calibrateFromAnchors([anchor(0, 5100), anchor(100, 5000), anchor(200, 4900)]);
    expect(duas.usable).toBe(true);
    expect(duas.confidence).toBeLessThan(tres.confidence);
  });

  it("detecta casas decimais e incremento da escala", () => {
    const cal = calibrateFromAnchors([
      anchor(0, 132.5, "132,50"),
      anchor(100, 132.0, "132,00"),
      anchor(200, 131.5, "131,50"),
    ]);
    expect(cal.decimals).toBe(2);
    expect(cal.tickSize).toBeCloseTo(0.5, 6);
  });

  it("priceAt e yAt são inversos", () => {
    const cal = calibrateFromAnchors([anchor(0, 5100), anchor(100, 5000), anchor(200, 4900)]);
    const y = yAt(cal, 5025);
    expect(y).not.toBeNull();
    expect(priceAt(cal, y!)).toBeCloseTo(5025, 6);
  });

  it("NÃO produz preço a partir de calibração inutilizável", () => {
    const cal = emptyCalibration();
    expect(priceAt(cal, 120)).toBeNull();
    expect(yAt(cal, 5000)).toBeNull();
    expect(visibleRange(cal, 400)).toBeNull();
  });

  it("expõe faixa visível de preços", () => {
    const cal = calibrateFromAnchors([anchor(0, 5100), anchor(100, 5000), anchor(200, 4900)]);
    const range = visibleRange(cal, 200);
    expect(range).toEqual({ min: 4900, max: 5100 });
  });

  it("é determinística: mesmas âncoras produzem a mesma calibração", () => {
    const input = [anchor(0, 5100), anchor(100, 5000), anchor(200, 4900)];
    const a = calibrateFromAnchors(input);
    const b = calibrateFromAnchors([...input].reverse());
    expect(a.slope).toBeCloseTo(b.slope, 12);
    expect(a.intercept).toBeCloseTo(b.intercept, 12);
    expect(a.confidence).toBe(b.confidence);
  });
});

describe("calibrationDrift — zoom e recalibração", () => {
  const base = calibrateFromAnchors([anchor(0, 5100), anchor(100, 5000), anchor(200, 4900)]);

  it("considera válida a calibração quando os rótulos não se moveram", () => {
    const drift = calibrationDrift(base, [anchor(100, 5000), anchor(200, 4900)]);
    expect(drift.stale).toBe(false);
  });

  it("marca como vencida após zoom que reposiciona os rótulos", () => {
    // Mesmo preço aparecendo 60px acima: o usuário deu zoom.
    const drift = calibrationDrift(base, [anchor(40, 5000), anchor(140, 4900)]);
    expect(drift.stale).toBe(true);
    expect(drift.maxDriftPx).toBeGreaterThan(SCALE_CONFIG.maxResidualPx);
  });

  it("trata calibração ausente como vencida", () => {
    expect(calibrationDrift(emptyCalibration(), [anchor(0, 5000)]).stale).toBe(true);
  });
});

describe("normalização de rótulos do Profit brasileiro", () => {
  it("interpreta 203.625 do WIN como 203625 pontos quando a IA devolve decimal", () => {
    const normalized = normalizeScaleAnchorsForAsset("WINFUT", [
      { y: 100, price: 203.625, raw: "203.625", source: "ocr", confidence: 0.95 },
      { y: 300, price: 203.125, raw: "203.125", source: "ocr", confidence: 0.95 },
    ]);
    expect(normalized.map((item) => item.price)).toEqual([203625, 203125]);
  });

  it("não multiplica valor que já está na faixa plausível", () => {
    const normalized = normalizeScaleAnchorsForAsset("WINFUT", [
      { y: 100, price: 203625, raw: "203.625", source: "ocr", confidence: 0.95 },
    ]);
    expect(normalized[0]!.price).toBe(203625);
  });
});

describe("grau de qualidade da calibração (spec V5 §11)", () => {
  const manual = (y: number, price: number) => ({
    y,
    price,
    raw: String(price),
    source: "manual" as const,
    confidence: 1,
  });

  it("3+ âncoras lineares com alta confiança = EXCELENTE", () => {
    const calibration = calibrateFromAnchors([
      manual(0, 132000),
      manual(200, 131000),
      manual(400, 130000),
    ]);
    expect(calibrationGrade(calibration).grade).toBe("EXCELENTE");
  });

  it("2 âncoras usáveis ficam abaixo de EXCELENTE", () => {
    const calibration = calibrateFromAnchors([manual(0, 132000), manual(400, 130000)]);
    expect(calibration.usable).toBe(true);
    expect(["BOA", "ACEITAVEL"]).toContain(calibrationGrade(calibration).grade);
  });

  it("calibração não usável = INSUFICIENTE, com métricas reais anexadas", () => {
    const result = calibrationGrade(emptyCalibration());
    expect(result.grade).toBe("INSUFICIENTE");
    expect(result.metrics.some((m) => m.startsWith("ancoras="))).toBe(true);
  });
});
