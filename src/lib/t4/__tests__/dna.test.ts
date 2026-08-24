import { describe, expect, it } from "vitest";

import type { Candle } from "@/lib/engines/types";
import {
  classifyLocation,
  classifyPullback,
  classifySetupDna,
  classifyTrend,
  classifyTrigger,
  classifyVolatility,
  gradeFromQuality,
  measureImpulse,
  movementOrdinal,
  positionFor,
  type DnaClassifierInput,
} from "../dna";

const MIN = 60_000;
const T0 = Date.UTC(2026, 2, 13, 13, 0, 0); // 13/03/2026, meio do pregão

function candle(i: number, o: number, h: number, l: number, c: number): Candle {
  return { t: T0 + i * MIN, o, h, l, c, v: 0 };
}

/** Ruído lateral: range 1 ponto, sem deslocamento. */
function flat(count: number, from = 0, base = 100): Candle[] {
  return Array.from({ length: count }, (_, i) =>
    candle(from + i, base, base + 1, base, base + 0.5),
  );
}

/** Impulso de alta: 5 candles subindo 2 pontos cada (100 → 110). */
function impulseUp(from: number): Candle[] {
  return Array.from({ length: 5 }, (_, i) => {
    const open = 100 + i * 2;
    return candle(from + i, open, open + 2.2, open - 0.2, open + 2);
  });
}

function cenarioCompra(retrace: Candle[]): Candle[] {
  return [...flat(10), ...impulseUp(10), ...retrace];
}

describe("measureImpulse", () => {
  it("mede o impulso e a correção do cenário de compra", () => {
    const retrace = [
      candle(15, 109.5, 109.5, 108.5, 108.6),
      candle(16, 108.6, 108.6, 107.6, 107.7),
      candle(17, 107.7, 107.7, 106.9, 107.0),
    ];
    const read = measureImpulse(cenarioCompra(retrace), "COMPRA");
    expect(read).not.toBeNull();
    expect(read!.points).toBeGreaterThan(9);
    expect(read!.retraceBars).toBe(3);
    expect(read!.retraceFraction).toBeGreaterThan(0.25);
    expect(read!.retraceFraction).toBeLessThan(0.382);
  });

  it("lateralidade pura não vira impulso — devolve null em vez de classificar ruído", () => {
    expect(measureImpulse(flat(25), "COMPRA")).toBeNull();
  });

  it("extremo no primeiro candle não é impulso: sem perna anterior, devolve null", () => {
    // Reversão após queda longa: candle 0 é a máxima e todo o resto desce.
    const janela = [
      candle(0, 99, 100, 90, 91),
      ...Array.from({ length: 20 }, (_, i) => {
        const open = 90 - i * 2;
        return candle(1 + i, open, open + 0.5, open - 2.2, open - 2);
      }),
    ];
    // Sem a guarda, isto virava "impulso de compra" com retração de 600%.
    expect(measureImpulse(janela, "COMPRA")).toBeNull();
  });

  it("janela curta demais devolve null", () => {
    expect(measureImpulse(flat(3), "COMPRA")).toBeNull();
  });
});

describe("classifyPullback", () => {
  it("recuo raso e ordenado é LIMPO", () => {
    const retrace = [
      candle(15, 109.5, 109.5, 108.5, 108.6),
      candle(16, 108.6, 108.6, 107.6, 107.7),
      candle(17, 107.7, 107.7, 106.9, 107.0),
    ];
    const impulse = measureImpulse(cenarioCompra(retrace), "COMPRA");
    expect(classifyPullback(impulse, false).pullback).toBe("LIMPO");
  });

  it("devolver mais de 61,8% do impulso é PROFUNDO", () => {
    const retrace = [
      candle(15, 109, 109, 108, 108.2),
      candle(16, 106.5, 106.5, 105.5, 105.7),
      candle(17, 104, 104, 103, 103.0),
    ];
    const impulse = measureImpulse(cenarioCompra(retrace), "COMPRA");
    expect(impulse!.retraceFraction).toBeGreaterThanOrEqual(0.618);
    expect(classifyPullback(impulse, false).pullback).toBe("PROFUNDO");
  });

  it("correção com candles do tamanho do impulso devolvendo metade é AGRESSIVO", () => {
    const retrace = [
      candle(15, 110, 110.2, 108, 108.1),
      candle(16, 108.1, 108.2, 106, 106.1),
      candle(17, 106.1, 106.2, 104, 104.2),
    ];
    const impulse = measureImpulse(cenarioCompra(retrace), "COMPRA");
    expect(classifyPullback(impulse, false).pullback).toBe("AGRESSIVO");
  });

  it("seis candles sobrepostos são LATERAL, não pullback", () => {
    const retrace = Array.from({ length: 7 }, (_, i) => candle(15 + i, 108, 109, 108, 108.4));
    const impulse = measureImpulse(cenarioCompra(retrace), "COMPRA");
    expect(classifyPullback(impulse, false).pullback).toBe("LATERAL");
  });

  it("captura de liquidez detectada vence qualquer geometria: FALSO_ROMPIMENTO", () => {
    const retrace = [candle(15, 109.5, 109.5, 108.5, 108.6)];
    const impulse = measureImpulse(cenarioCompra(retrace), "COMPRA");
    expect(classifyPullback(impulse, true).pullback).toBe("FALSO_ROMPIMENTO");
  });

  it("sem impulso medível a classe é NAO_IDENTIFICADO — nunca um chute", () => {
    expect(classifyPullback(null, false).pullback).toBe("NAO_IDENTIFICADO");
  });
});

describe("classifyTrend / positionFor", () => {
  it("tendência instalada a favor: FORTE com evidência separada, NORMAL abaixo", () => {
    expect(classifyTrend("TREND_UP", 75, "COMPRA")).toBe("FORTE");
    expect(classifyTrend("TREND_UP", 40, "COMPRA")).toBe("NORMAL");
    expect(classifyTrend("TREND_DOWN", 75, "VENDA")).toBe("FORTE");
  });

  it("setup contra a tendência instalada é CONTRA, independente da força", () => {
    expect(classifyTrend("TREND_UP", 90, "VENDA")).toBe("CONTRA");
    expect(positionFor("CONTRA")).toBe("CONTRA_TENDENCIA");
    expect(positionFor("FORTE")).toBe("A_FAVOR");
  });

  it("RANGE/COMPRESSION viram LATERAL; EXPANSION/TRANSITION/UNCLEAR viram TRANSICAO", () => {
    expect(classifyTrend("RANGE", 50, "COMPRA")).toBe("LATERAL");
    expect(classifyTrend("COMPRESSION", 50, "VENDA")).toBe("LATERAL");
    expect(classifyTrend("TRANSITION", 50, "COMPRA")).toBe("TRANSICAO");
    expect(classifyTrend("UNCLEAR", 0, "COMPRA")).toBe("TRANSICAO");
  });
});

describe("classifyTrigger", () => {
  const zona = { upper: 108, lower: 106 };

  it("corpo que engolfa o candle contrário anterior é ENGOLFO", () => {
    const window = [
      ...flat(10),
      candle(10, 105, 105.5, 104, 104.2),
      candle(11, 104, 106.5, 103.8, 106.2),
    ];
    expect(classifyTrigger(window, "COMPRA", null)).toBe("ENGOLFO");
  });

  it("pavio de rejeição com 2× o corpo é REJEICAO", () => {
    const window = [...flat(10), candle(10, 105, 105.4, 102, 105.3)];
    expect(classifyTrigger(window, "COMPRA", null)).toBe("REJEICAO");
  });

  it("corpo cheio acima da amplitude típica é FORCA", () => {
    const window = [...flat(10), candle(10, 104, 106.6, 103.9, 106.5)];
    expect(classifyTrigger(window, "COMPRA", null)).toBe("FORCA");
  });

  it("fechar além da zona do POI é ROMPIMENTO; tocar e fechar a favor é RETESTE", () => {
    const rompeu = [...flat(10), candle(10, 107.5, 108.6, 107.4, 108.5)];
    expect(classifyTrigger(rompeu, "COMPRA", zona)).toBe("ROMPIMENTO");
    const retestou = [...flat(10), candle(10, 107.2, 107.8, 106.8, 107.6)];
    expect(classifyTrigger(retestou, "COMPRA", zona)).toBe("RETESTE");
  });

  it("candle fechado contra a direção não sustenta gatilho: NAO_IDENTIFICADO", () => {
    const window = [...flat(10), candle(10, 105, 105.2, 104, 104.1)];
    expect(classifyTrigger(window, "COMPRA", null)).toBe("NAO_IDENTIFICADO");
  });
});

describe("classifyVolatility", () => {
  it("mapeia razão de amplitude nas quatro classes do §30", () => {
    expect(classifyVolatility(0.4)).toBe("BAIXA");
    expect(classifyVolatility(1.0)).toBe("NORMAL");
    expect(classifyVolatility(2.0)).toBe("ALTA");
    expect(classifyVolatility(4.0)).toBe("EXTREMA");
  });

  it("sem leitura de volatilidade devolve null, nunca NORMAL por omissão", () => {
    expect(classifyVolatility(null)).toBeNull();
    expect(classifyVolatility(0)).toBeNull();
  });
});

describe("classifyLocation", () => {
  it("mapeia POIKind para localização preservando o kind cru", () => {
    expect(classifyLocation({ kind: "spring", upper: 1, lower: 0 }, "COMPRA")).toEqual({
      location: "SUPORTE",
      detail: "spring",
    });
    expect(classifyLocation({ kind: "utad", upper: 1, lower: 0 }, "VENDA").location).toBe(
      "RESISTENCIA",
    );
    expect(
      classifyLocation({ kind: "suporte_resistencia", upper: 1, lower: 0 }, "VENDA").location,
    ).toBe("RESISTENCIA");
    expect(classifyLocation({ kind: "extremo_range", upper: 1, lower: 0 }, "COMPRA").location).toBe(
      "MINIMA",
    );
    expect(
      classifyLocation({ kind: "rompimento_reteste", upper: 1, lower: 0 }, "COMPRA").location,
    ).toBe("ROMPIMENTO");
    expect(classifyLocation({ kind: "fvg", upper: 1, lower: 0 }, "COMPRA").location).toBe(
      "CONSOLIDACAO",
    );
  });

  it("sem POI a localização é NAO_IDENTIFICADO", () => {
    expect(classifyLocation(null, "COMPRA").location).toBe("NAO_IDENTIFICADO");
  });
});

describe("gradeFromQuality / movementOrdinal", () => {
  it("nota do motor mapeia direto; REJEITADA e ausência viram DESCARTADA", () => {
    expect(gradeFromQuality("A+")).toBe("A_PLUS");
    expect(gradeFromQuality("A")).toBe("A");
    expect(gradeFromQuality("B")).toBe("B");
    expect(gradeFromQuality("REJEITADA")).toBe("DESCARTADA");
    expect(gradeFromQuality(null)).toBe("DESCARTADA");
  });

  it("ordinal conta só setups DESDE o início do impulso; 4 = posterior", () => {
    const retrace = [candle(15, 109.5, 109.5, 108.5, 108.6)];
    const impulse = measureImpulse(cenarioCompra(retrace), "COMPRA");
    const start = impulse!.startAt;
    expect(movementOrdinal(impulse, [])).toBe(1);
    expect(movementOrdinal(impulse, [start - 5 * MIN])).toBe(1);
    expect(movementOrdinal(impulse, [start + MIN])).toBe(2);
    expect(movementOrdinal(impulse, [start + MIN, start + 2 * MIN])).toBe(3);
    expect(movementOrdinal(impulse, [start + MIN, start + 2 * MIN, start + 3 * MIN])).toBe(4);
  });

  it("sem movimento definível o ordinal é null", () => {
    expect(movementOrdinal(null, [T0])).toBeNull();
  });
});

describe("classifySetupDna", () => {
  const entrada: DnaClassifierInput = {
    id: "dna_teste_1",
    origin: "REPLAY",
    sourceId: "sessao_1303",
    asset: "WINFUT",
    timeframe: "1m",
    direction: "COMPRA",
    detectedAt: T0 + 17 * MIN,
    window: cenarioCompra([
      candle(15, 109.5, 109.5, 108.5, 108.6),
      candle(16, 108.6, 108.6, 107.6, 107.7),
      candle(17, 107.7, 107.7, 106.9, 107.0),
    ]),
    regime: { regime: "TREND_UP", strength: 72 },
    volatilityRatio: 1.1,
    t4Quality: "A+",
    liquidityCaptured: false,
    poi: { kind: "rompimento_reteste", upper: 108, lower: 106 },
    entry: 107.5,
    stop: 105.5,
    targets: [113.5, 117.5],
    rrAvailable: 3.0,
    priorSameDirectionAt: [],
    techniqueVersion: "T4.0.0",
  };

  it("gera o registro completo, classificado antes de existir qualquer resultado", () => {
    const dna = classifySetupDna(entrada);
    expect(dna.grade).toBe("A_PLUS");
    expect(dna.trend).toBe("FORTE");
    expect(dna.position).toBe("A_FAVOR");
    expect(dna.pullback).toBe("LIMPO");
    expect(dna.location).toBe("ROMPIMENTO");
    expect(dna.locationDetail).toBe("rompimento_reteste");
    expect(dna.volatility).toBe("NORMAL");
    expect(dna.movementOrdinal).toBe(1);
    expect(dna.stopDistancePoints).toBe(2);
    expect(dna.impulseR).not.toBeNull();
    expect(dna.tradingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(dna.hour).toBeGreaterThanOrEqual(0);
    expect(dna.hour).toBeLessThanOrEqual(23);
    // O registro nasce sem desfecho — o resultado chega depois, pelo trade.
    expect(dna.tradeId).toBeNull();
  });

  it("é determinístico: mesma entrada, mesmo DNA", () => {
    expect(classifySetupDna(entrada)).toEqual(classifySetupDna(entrada));
  });
});
