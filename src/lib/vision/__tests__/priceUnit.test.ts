import { describe, expect, it } from "vitest";

import { normalizePriceUnit } from "../priceUnit";

/**
 * A NOTAÇÃO DE MILHAR DA TELA, VISTA EM PRODUÇÃO EM 20/08/2026.
 *
 * Os números destes testes são os que o banco gravou: o histórico de gatilho
 * do setup T4-2026-08-20-008 tem `v2 = 170540`, `v3 = 170.52`, `v4 = 170570` —
 * duas unidades para o mesmo nível, dentro do mesmo setup. O 009 saiu inteiro
 * na notação errada.
 */

describe("preço na notação de milhar vira pontos", () => {
  it("os valores REAIS do setup 008 e 009", () => {
    for (const [lido, esperado] of [
      [170.52, 170_520],
      [170.68, 170_680],
      [170.685, 170_685],
      [170.43, 170_430],
    ] as const) {
      const r = normalizePriceUnit(lido, "WINFUT", "Gatilho");
      expect(r.value).toBe(esperado);
      expect(r.repair).not.toBeNull();
    }
  });

  it("o reparo NOMEIA o campo e diz o porquê", () => {
    const r = normalizePriceUnit(170.68, "WINFUT", "Gatilho");
    expect(r.repair).toContain("Gatilho");
    expect(r.repair).toContain("170680");
    expect(r.repair).toContain("tick");
  });

  it("preço que JÁ está em pontos fica intacto", () => {
    for (const bom of [170_570, 170_540, 132_485]) {
      const r = normalizePriceUnit(bom, "WINFUT", "Entrada");
      expect(r.value).toBe(bom);
      expect(r.repair).toBeNull();
    }
  });
});

describe("a correção é conservadora — e é isso que a torna segura", () => {
  it("número que não fecha de NENHUM dos dois jeitos fica INTACTO", () => {
    /*
     * 17,068 × 1000 = 17.068, que não é múltiplo do tick de 5. Não sabemos o
     * que é — e inventar unidade trocaria um erro visível por um escondido.
     */
    const r = normalizePriceUnit(17.068, "WINFUT", "Entrada");
    expect(r.value).toBe(17.068);
    expect(r.repair).toBeNull();
  });

  it("sem símbolo não existe régua, e nada é tocado", () => {
    expect(normalizePriceUnit(170.68, null, "Entrada").value).toBe(170.68);
    expect(normalizePriceUnit(170.68, "PETR4", "Entrada").value).toBe(170.68);
  });

  it("valor inválido ou não positivo passa reto", () => {
    expect(normalizePriceUnit(0, "WINFUT", "x").value).toBe(0);
    expect(normalizePriceUnit(-5, "WINFUT", "x").value).toBe(-5);
    expect(normalizePriceUnit(Number.NaN, "WINFUT", "x").repair).toBeNull();
  });

  it("funciona no WDO, que TEM casa decimal — a régua é o tick, não o formato", () => {
    // WDO tick 0,5: 5.4325 na tela é 5.432,5 pontos.
    const r = normalizePriceUnit(5.4325, "WDOFUT", "Entrada");
    expect(r.value).toBe(5432.5);
    // E um preço de WDO já correto não é mexido.
    expect(normalizePriceUnit(5432.5, "WDOFUT", "Entrada").repair).toBeNull();
  });
  /*
   * O ERRO DE DÍGITO DO OCR NÃO É NOTAÇÃO DE MILHAR.
   *
   * O tick sozinho não distingue os dois casos: no WINFUT (tick 5) qualquer
   * inteiro fora do múltiplo de 5 reprova, e ×1000 sempre devolve um múltiplo
   * de 5. Assim `170433` — um `170430` com um dígito lido errado — virava
   * `170.433.000`, mil vezes o preço real, com reparo declarado por cima.
   *
   * A assinatura da notação de milhar é o valor lido ficar ABAIXO da faixa do
   * contrato. `170433` já está DENTRO dela: não há milhar faltando.
   */
  it("preço já na ordem de grandeza certa fica INTACTO, mesmo desalinhado do tick", () => {
    const r = normalizePriceUnit(170_433, "WINFUT", "Preço atual");
    expect(r.value).toBe(170_433);
    expect(r.repair).toBeNull();
  });

  it("o WDO tem a mesma proteção, na faixa dele", () => {
    // 6505,3 é preço plausível de WDO (faixa 1.000-20.000) e não fecha com o
    // tick 0,5 — mas multiplicar por mil daria 6,5 milhões, um absurdo.
    const r = normalizePriceUnit(6505.3, "WDOFUT", "Preço atual");
    expect(r.value).toBe(6505.3);
    expect(r.repair).toBeNull();
  });

  it("símbolo de família desconhecida nunca é convertido", () => {
    const r = normalizePriceUnit(170.52, "PETR4", "Entrada");
    expect(r.value).toBe(170.52);
    expect(r.repair).toBeNull();
  });
});
