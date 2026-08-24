import { describe, expect, it } from "vitest";

import type { Candle } from "../types";
import {
  buildOrderedPullbackPlan,
  detectOrderedPullback,
  type OrderedPullbackConfig,
} from "../orderedPullback";
import type { RiskParams } from "../strategy";

/**
 * E2 SÓ EXISTE EM CANDLE FECHADO — e agora isso é contrato de assinatura, não
 * promessa de comentário. Estes testes provam as três coisas que o comando
 * exige: candle aberto/indeterminado bloqueia com código; o fechado anterior
 * decide; e o veredito de T é IDÊNTICO com ou sem os candles de T+1 na janela.
 */

const CONFIG: OrderedPullbackConfig = {
  minPullbackCandles: 3,
  maxPullbackCandles: 5,
  invalidationCandles: 7,
  pivotLookback: 10,
  minTrendStrength: 0.3,
  maxCorrectionBodyRatio: 0.6,
  neutralBodyRatio: 0.25,
  stopBufferTicks: 1,
};

const PARAMS: RiskParams = {
  stopMethod: "combinado",
  tickSize: 5,
  minStopDistance: 10,
  maxStopDistance: 1_000,
  partialTargetMultiple: 3,
  finalTargetMultiple: 5,
};

const c = (o: number, h: number, l: number, cl: number, i: number): Candle => ({
  t: i * 60_000,
  o,
  h,
  l,
  c: cl,
  v: 0,
});

/**
 * Série de COMPRA com pullback ordenado válido:
 * 0..12 base lateral (pivô ~995) · 13..15 impulso verde · 16..18 correção
 * pequena · 19 = E2 verde fechando acima da máxima anterior.
 */
function serieValida(): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i <= 12; i += 1) out.push(c(1_000, 1_005, 995, 1_000, i));
  out.push(c(1_000, 1_032, 998, 1_030, 13));
  out.push(c(1_030, 1_062, 1_028, 1_060, 14));
  out.push(c(1_060, 1_092, 1_058, 1_090, 15));
  out.push(c(1_090, 1_091, 1_080, 1_082, 16));
  out.push(c(1_082, 1_083, 1_072, 1_074, 17));
  out.push(c(1_074, 1_083, 1_064, 1_066, 18));
  out.push(c(1_066, 1_095, 1_065, 1_092, 19));
  return out;
}

describe("detectOrderedPullback — fechamento é contrato", () => {
  it("lastClosedIndex null (candle aberto ou desconhecido) BLOQUEIA com código", () => {
    const read = detectOrderedPullback(serieValida(), "COMPRA", 0.6, CONFIG, {
      lastClosedIndex: null,
    });
    expect(read.present).toBe(false);
    expect(read.blocks[0]!.code).toBe("E2_OPEN_OR_UNKNOWN");
    expect(read.blockers[0]!.length).toBeGreaterThan(0);
  });

  it("com o E2 comprovadamente fechado o setup arma", () => {
    const janela = serieValida();
    const read = detectOrderedPullback(janela, "COMPRA", 0.6, CONFIG, {
      lastClosedIndex: janela.length - 1,
    });
    expect(read.present).toBe(true);
    expect(read.confirmationClosed).toBe(true);
    expect(read.pullbackCandles).toBe(3);
    expect(read.blocks).toHaveLength(0);
  });

  it("T NÃO VÊ T+1: candles após o último fechado não mudam NADA no veredito", () => {
    const janela = serieValida();
    const fechado = detectOrderedPullback(janela, "COMPRA", 0.6, CONFIG, {
      lastClosedIndex: janela.length - 1,
    });
    // T+1 é um crash de 100 pontos — se qualquer linha o enxergasse, o
    // veredito mudaria. A janela estendida DEVE produzir leitura idêntica.
    const comFuturo = [...janela, c(1_092, 1_093, 990, 992, 20), c(992, 995, 900, 905, 21)];
    const mesmoInstante = detectOrderedPullback(comFuturo, "COMPRA", 0.6, CONFIG, {
      lastClosedIndex: janela.length - 1,
    });
    expect(mesmoInstante).toEqual(fechado);
  });

  it("quando o último fechado é um candle do pullback, E2 não confirma — sem olhar adiante", () => {
    // Um candle-base a mais na frente para a janela truncada continuar com os
    // 20 candles mínimos — o corte anti-T+1 reduz a janela ao fechado.
    const janela = [c(1_000, 1_005, 995, 1_000, -1), ...serieValida()];
    const read = detectOrderedPullback(janela, "COMPRA", 0.6, CONFIG, {
      lastClosedIndex: janela.length - 2,
    });
    expect(read.present).toBe(false);
    expect(read.blocks[0]!.code).toBe("E2_NOT_CONFIRMED");
  });

  it("índice inválido bloqueia como desconhecido, nunca lança", () => {
    const read = detectOrderedPullback(serieValida(), "COMPRA", 0.6, CONFIG, {
      lastClosedIndex: -3,
    });
    expect(read.present).toBe(false);
    expect(read.blocks[0]!.code).toBe("E2_OPEN_OR_UNKNOWN");
  });

  it("tendência fraca bloqueia com TREND_WEAK", () => {
    const janela = serieValida();
    const read = detectOrderedPullback(janela, "COMPRA", 0.1, CONFIG, {
      lastClosedIndex: janela.length - 1,
    });
    expect(read.blocks[0]!.code).toBe("TREND_WEAK");
  });

  it("correção de 6 candles fica FORA da faixa sem invalidar; de 8, invalida", () => {
    const base = serieValida();
    // Injeta candles corretivos extras antes da E2.
    const seis = [
      ...base.slice(0, 19),
      c(1_066, 1_067, 1_058, 1_060, 19),
      c(1_060, 1_061, 1_052, 1_054, 20),
      c(1_054, 1_055, 1_046, 1_048, 21),
      c(1_048, 1_096, 1_047, 1_094, 22),
    ];
    const readSeis = detectOrderedPullback(seis, "COMPRA", 0.6, CONFIG, {
      lastClosedIndex: seis.length - 1,
    });
    expect(readSeis.pullbackCandles).toBe(6);
    expect(readSeis.invalidatedByLength).toBe(false);
    expect(readSeis.blocks[0]!.code).toBe("PULLBACK_LENGTH");

    const oito = [
      ...base.slice(0, 19),
      c(1_066, 1_067, 1_058, 1_060, 19),
      c(1_060, 1_061, 1_052, 1_054, 20),
      c(1_054, 1_055, 1_046, 1_048, 21),
      c(1_048, 1_049, 1_040, 1_042, 22),
      c(1_042, 1_043, 1_034, 1_036, 23),
      c(1_036, 1_098, 1_035, 1_096, 24),
    ];
    const readOito = detectOrderedPullback(oito, "COMPRA", 0.6, CONFIG, {
      lastClosedIndex: oito.length - 1,
    });
    expect(readOito.pullbackCandles).toBe(8);
    expect(readOito.invalidatedByLength).toBe(true);
    expect(readOito.blocks[0]!.code).toBe("PULLBACK_LENGTH");
  });
});

describe("buildOrderedPullbackPlan — sem null mudo", () => {
  const janela = serieValida();
  const read = detectOrderedPullback(janela, "COMPRA", 0.6, CONFIG, {
    lastClosedIndex: janela.length - 1,
  });

  it("caminho feliz devolve o plano com R:R no piso ou acima", () => {
    const r = buildOrderedPullbackPlan(janela, read, PARAMS, null, CONFIG);
    expect(r.allowed).toBe(true);
    if (r.allowed) {
      expect(r.value.riskReward).toBeGreaterThanOrEqual(3);
      expect(r.value.entry % PARAMS.tickSize).toBe(0);
      expect(r.value.stop % PARAMS.tickSize).toBe(0);
    }
  });

  it("read bloqueado propaga o CÓDIGO da causa raiz — não null", () => {
    const bloqueado = detectOrderedPullback(janela, "COMPRA", 0.6, CONFIG, {
      lastClosedIndex: null,
    });
    const r = buildOrderedPullbackPlan(janela, bloqueado, PARAMS, null, CONFIG);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.code).toBe("E2_OPEN_OR_UNKNOWN");
  });

  it("tick inválido é PRICE_UNRELIABLE", () => {
    const r = buildOrderedPullbackPlan(janela, read, { ...PARAMS, tickSize: 0 }, null, CONFIG);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.code).toBe("PRICE_UNRELIABLE");
  });

  it("stop fora dos limites nomeia o lado: pequeno e grande", () => {
    const pequeno = buildOrderedPullbackPlan(
      janela,
      read,
      { ...PARAMS, minStopDistance: 10_000 },
      null,
      CONFIG,
    );
    expect(pequeno.allowed).toBe(false);
    if (!pequeno.allowed) expect(pequeno.code).toBe("STOP_TOO_SMALL");

    const grande = buildOrderedPullbackPlan(
      janela,
      read,
      { ...PARAMS, maxStopDistance: 5 },
      null,
      CONFIG,
    );
    expect(grande.allowed).toBe(false);
    if (!grande.allowed) expect(grande.code).toBe("STOP_TOO_LARGE");
  });

  it("obstáculo antes dos 5R é TARGET_5R_NO_ROOM com a distância no motivo", () => {
    // Entrada ~1090, stop ~1055 → 5R = 175 pontos; obstáculo a 50.
    const r = buildOrderedPullbackPlan(janela, read, PARAMS, 1_140, CONFIG);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.code).toBe("TARGET_5R_NO_ROOM");
      expect(r.reason).toMatch(/\d/);
    }
  });
});
