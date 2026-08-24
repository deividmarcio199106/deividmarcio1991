import { describe, expect, it } from "vitest";

import {
  buildPriceScale,
  distanceToZone,
  EMPTY_PRICE_SCALE,
  needsRefresh,
  NO_PRICES,
  priceLevels,
  resetScale,
  revalidate,
  toRealPrice,
} from "../priceScaleTracker";
import type { ScaleAnchor } from "../priceScale";

const NOW = 1_700_000_000_000;

/**
 * Âncoras no formato do print real: eixo de 172.200 a 172.410, passo 0,015,
 * y crescendo para baixo enquanto o preço desce.
 */
function anchor(y: number, price: number, confidence = 0.95): ScaleAnchor {
  return { y, price, raw: String(price), source: "ocr", confidence };
}

const TRES_ROTULOS = [anchor(110, 172410), anchor(300, 172320), anchor(490, 172230)];

describe("escala automática de preço", () => {
  it("três rótulos coerentes liberam a escala", () => {
    const state = buildPriceScale(TRES_ROTULOS, NOW);
    expect(state.priceScaleReady).toBe(true);
    expect(state.pricePerPixel).toBeLessThan(0); // y desce, preço sobe
    expect(state.lastScaleUpdate).toBe(NOW);
    expect(state.blockReason).toBeNull();
  });

  it("dois rótulos NÃO bastam — com dois pontos o resíduo é sempre zero", () => {
    // O teste de qualidade nao testaria nada: qualquer reta passa por 2 pontos.
    const state = buildPriceScale([anchor(110, 172410), anchor(490, 172230)], NOW);
    expect(state.priceScaleReady).toBe(false);
    expect(state.blockReason).toContain("aguardando confirmação");
  });

  it("um rótulo só não produz escala nenhuma", () => {
    const state = buildPriceScale([anchor(110, 172410)], NOW);
    expect(state.priceScaleReady).toBe(false);
    expect(state.calibration.usable).toBe(false);
    expect(state.blockReason).toContain("1 rótulo");
  });

  it("rótulos incoerentes são recusados em vez de aceitos com erro embutido", () => {
    const state = buildPriceScale(
      [anchor(110, 172410), anchor(300, 172320), anchor(490, 180000)],
      NOW,
    );
    expect(state.priceScaleReady).toBe(false);
  });

  it("converte pixel em preço só quando pronta", () => {
    const pronta = buildPriceScale(TRES_ROTULOS, NOW);
    const preco = toRealPrice(pronta, 300);
    expect(preco).not.toBeNull();
    expect(Math.abs(preco! - 172320)).toBeLessThan(2);

    // Sem escala, null — nunca um numero que parece preco e nao e.
    expect(toRealPrice(EMPTY_PRICE_SCALE, 300)).toBeNull();
  });

  it("zoom ou arrasto derruba a escala e recalibra sozinho", () => {
    const antes = buildPriceScale(TRES_ROTULOS, NOW);
    // Mesmos precos em alturas bem diferentes = a escala vertical mudou.
    const depois = revalidate(
      antes,
      [anchor(110, 172300), anchor(300, 172250), anchor(490, 172200)],
      NOW + 1000,
    );
    expect(depois.blockReason).toContain("recalibrando");
  });

  it("rótulos coerentes com a reta atual apenas renovam o carimbo", () => {
    const antes = buildPriceScale(TRES_ROTULOS, NOW);
    const depois = revalidate(antes, TRES_ROTULOS, NOW + 1000);
    expect(depois.priceScaleReady).toBe(true);
    expect(depois.lastScaleUpdate).toBe(NOW + 1000);
  });

  it("relê por rotina mesmo com tudo estável", () => {
    const state = buildPriceScale(TRES_ROTULOS, NOW);
    expect(needsRefresh(state, NOW + 10_000)).toBe(false);
    expect(needsRefresh(state, NOW + 40_000)).toBe(true);
    expect(needsRefresh(EMPTY_PRICE_SCALE, NOW)).toBe(true);
  });

  it("troca de ativo zera a escala — WIN e WDO não compartilham", () => {
    expect(resetScale().priceScaleReady).toBe(false);
  });
});

describe("níveis da pré-entrada em preço real", () => {
  const pronta = buildPriceScale(TRES_ROTULOS, NOW);

  it("entrega zona, stop e alvos ANTES da confirmação", () => {
    const precos = priceLevels(pronta, {
      entryY: 300,
      stopY: 360,
      zoneMinY: 290,
      zoneMaxY: 310,
      currentY: 320,
    });
    expect(precos.entryZoneMin).not.toBeNull();
    expect(precos.entryZoneMax).not.toBeNull();
    expect(precos.stop).not.toBeNull();
    expect(precos.target3R).not.toBeNull();
    expect(precos.target5R).not.toBeNull();
    // Ordem correta: zona min sempre abaixo da max.
    expect(precos.entryZoneMin!).toBeLessThan(precos.entryZoneMax!);
  });

  it("alvos saem do risco do próprio setup, não de número arbitrário", () => {
    const precos = priceLevels(pronta, {
      entryY: 300,
      stopY: 360,
      zoneMinY: null,
      zoneMaxY: null,
      currentY: null,
    });
    const risco = precos.stop === null ? 0 : Math.abs(172320 - precos.stop);
    expect(Math.abs(precos.target3R! - precos.target5R!)).toBeCloseTo(risco * 2, 0);
  });

  it("sem stop não há R, e sem R não há alvo", () => {
    const precos = priceLevels(pronta, {
      entryY: 300,
      stopY: null,
      zoneMinY: null,
      zoneMaxY: null,
      currentY: null,
    });
    expect(precos.target3R).toBeNull();
    expect(precos.target5R).toBeNull();
  });

  it("escala não pronta não publica nível nenhum", () => {
    const precos = priceLevels(EMPTY_PRICE_SCALE, {
      entryY: 300,
      stopY: 360,
      zoneMinY: 290,
      zoneMaxY: 310,
      currentY: 320,
    });
    expect(precos).toEqual(NO_PRICES);
  });

  it("mede a distância até a zona, e zero quando já está dentro", () => {
    const dentro = distanceToZone({
      ...NO_PRICES,
      currentPrice: 100,
      entryZoneMin: 90,
      entryZoneMax: 110,
    });
    expect(dentro).toBe(0);

    const abaixo = distanceToZone({
      ...NO_PRICES,
      currentPrice: 80,
      entryZoneMin: 90,
      entryZoneMax: 110,
    });
    expect(abaixo).toBe(10);

    const acima = distanceToZone({
      ...NO_PRICES,
      currentPrice: 130,
      entryZoneMin: 90,
      entryZoneMax: 110,
    });
    expect(acima).toBe(20);
  });

  it("sem preço atual não há distância", () => {
    expect(distanceToZone(NO_PRICES)).toBeNull();
  });
});
