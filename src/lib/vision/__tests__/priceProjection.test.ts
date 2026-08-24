import { describe, expect, it } from "vitest";

import { projectSeries, projectValue, projectionPlausible } from "../priceProjection";
import { calibrateFromAnchors, geometricCalibration, type ScaleAnchor } from "../priceScale";
import type { Candle } from "@/lib/engines/types";

/**
 * O DEFEITO QUE ESTES TESTES TRANCAM.
 *
 * O painel anunciava ESCALA PRONTA com R² 1.0000 e publicava, ao lado,
 * "ENTRADA 181.18 · STOP 233.33 · PREÇO ATUAL 194.00" para WINFUT — contrato
 * que negocia perto de 139.000 pontos. A escala tinha calibrado certo; os
 * candles é que continuavam em coordenada de pixel, porque a calibração nunca
 * chegava ao extrator.
 *
 * O agravante: enquanto a escala estava em calibração, a guarda apagava todo
 * número. No instante em que ela ficava pronta, a guarda DESLIGAVA — e os
 * mesmos pixels passavam a ser publicados como preço de mercado.
 */

const ALTURA = 1080;

/** Escala real de WINFUT lida do eixo: 139.500 no topo, 138.000 na base. */
function escalaReal() {
  const anchors: ScaleAnchor[] = [
    { y: 100, price: 139_500, raw: "139.500", source: "ocr", confidence: 0.95 },
    { y: 500, price: 138_750, raw: "138.750", source: "ocr", confidence: 0.95 },
    { y: 900, price: 138_000, raw: "138.000", source: "ocr", confidence: 0.95 },
  ];
  return calibrateFromAnchors(anchors);
}

/** Candle como o extrator produz: régua geométrica, valor = altura − y. */
function candleGeometrico(y: number): Candle {
  const valor = ALTURA - y;
  return { t: 1_770_000_000_000, o: valor, h: valor + 4, l: valor - 4, c: valor, v: 0 };
}

describe("projeção pixel → preço", () => {
  it("converte a régua geométrica no preço real do eixo", () => {
    const calibration = escalaReal();
    expect(calibration.usable).toBe(true);

    // Um candle desenhado exatamente na altura da âncora de 138.750 tem de sair
    // como 138.750 — não como 580 (que é o valor geométrico daquele pixel).
    const valorGeometrico = ALTURA - 500;
    const preco = projectValue(valorGeometrico, { baseHeight: ALTURA, calibration });

    expect(preco).not.toBeNull();
    expect(preco!).toBeCloseTo(138_750, 6);
    expect(preco).not.toBeCloseTo(valorGeometrico, 0);
  });

  it("a série inteira sai na faixa do contrato, não na faixa de pixel", () => {
    const calibration = escalaReal();
    const serie = [200, 400, 600, 800].map(candleGeometrico);
    const projetada = projectSeries(serie, { baseHeight: ALTURA, calibration });

    for (const candle of projetada) {
      expect(candle.c).toBeGreaterThan(137_000);
      expect(candle.c).toBeLessThan(141_000);
    }
    // E o que era 194.00 de pixel deixou de existir como "preço".
    expect(projetada.every((c) => c.c > 1_000)).toBe(true);
  });

  it("preserva a ordem alta/baixa depois da inversão do eixo", () => {
    const calibration = escalaReal();
    const [projetado] = projectSeries([candleGeometrico(400)], {
      baseHeight: ALTURA,
      calibration,
    });
    expect(projetado!.h).toBeGreaterThanOrEqual(projetado!.l);
  });

  it("sem calibração utilizável a série volta intacta, em unidade relativa", () => {
    const serie = [candleGeometrico(300)];
    const projetada = projectSeries(serie, {
      baseHeight: ALTURA,
      calibration: geometricCalibration(ALTURA),
    });
    expect(projetada[0]!.c).toBe(serie[0]!.c);
  });

  it("sem altura de referência não há conversão possível", () => {
    expect(projectValue(500, { baseHeight: 0, calibration: escalaReal() })).toBeNull();
  });
});

describe("plausibilidade — a rede de última instância", () => {
  it("recusa série que continuou em pixel, mesmo com escala dita pronta", () => {
    // Exatamente o estado observado: números de pixel com a escala PRONTA.
    const emPixel: Candle[] = [{ t: 1, o: 181.18, h: 194, l: 175, c: 194.0, v: 0 }];
    expect(projectionPlausible(emPixel, "WINFUT")).toBe(false);
  });

  it("aceita série já convertida para a faixa do contrato", () => {
    const emPreco: Candle[] = [{ t: 1, o: 138_900, h: 139_100, l: 138_800, c: 139_050, v: 0 }];
    expect(projectionPlausible(emPreco, "WINFUT")).toBe(true);
  });

  it("ativo sem faixa conhecida não é bloqueado por palpite", () => {
    expect(projectionPlausible([{ t: 1, o: 5, h: 6, l: 4, c: 5, v: 0 }], "PETR4")).toBe(true);
  });
});
