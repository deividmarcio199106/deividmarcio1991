import { describe, expect, it } from "vitest";

import { calibrateFromAnchors, calibrateRobust, type ScaleAnchor } from "../priceScale";

/**
 * O ESTADO OBSERVADO AO VIVO: "Escala não linear (R²=0.99178, desvio máx.
 * 18.3px)". R² de 0.99 é altíssimo para quase tudo — e reprovado aqui, com
 * razão: um eixo de preço é uma reta EXATA, e 18 pixels de desvio significam que
 * um rótulo foi lido na altura errada.
 *
 * Reprovar a leitura inteira por causa de um rótulo torto também é perda: os
 * outros estavam certos. O descarte procura o maior subconjunto consistente —
 * SEM afrouxar nenhum limiar.
 */

/** Eixo real e perfeito: 250 pontos a cada 400px. */
function reta(y: number): number {
  return 139_500 - (y - 100) * 0.625;
}

function ancora(y: number, price = reta(y)): ScaleAnchor {
  return { y, price, raw: String(price), source: "ocr", confidence: 0.95 };
}

describe("calibrateRobust", () => {
  it("um rótulo lido na altura errada não reprova os outros", () => {
    const bons = [ancora(100), ancora(400), ancora(700), ancora(1000)];
    // O terceiro rótulo veio deslocado ~30px — o suficiente para derrubar o R².
    const comErro = [...bons];
    comErro[2] = ancora(700, reta(730));

    expect(calibrateFromAnchors(comErro).usable).toBe(false);

    const robusta = calibrateRobust(comErro);
    expect(robusta.usable).toBe(true);
    expect(robusta.anchors.length).toBe(3);
    expect(robusta.reason).toContain("descartado");
  });

  it("NÃO descarta até passar: com 3 rótulos, reprovar continua reprovando", () => {
    // Esta é a regra que impede o descarte de virar afrouxamento. Sobrando 2
    // âncoras, qualquer reta passa pelos dois pontos e o R² é sempre 1 — o teste
    // de linearidade não testaria nada.
    const tres = [ancora(100), ancora(500), ancora(900, reta(830))];
    expect(calibrateFromAnchors(tres).usable).toBe(false);
    expect(calibrateRobust(tres).usable).toBe(false);
  });

  it("escala boa passa sem descartar nada", () => {
    const boas = [ancora(100), ancora(400), ancora(700), ancora(1000)];
    const robusta = calibrateRobust(boas);
    expect(robusta.usable).toBe(true);
    expect(robusta.anchors.length).toBe(4);
    expect(robusta.reason).not.toContain("descartado");
  });

  it("dois rótulos errados continuam reprovando — o descarte é de UM", () => {
    const doisErrados = [ancora(100), ancora(400, reta(450)), ancora(700, reta(640)), ancora(1000)];
    expect(calibrateRobust(doisErrados).usable).toBe(false);
  });
});
