import { describe, expect, it } from "vitest";

import { podeDesenharAnotacao, type Annotation } from "@/lib/vision/printAnalysis";

/**
 * REGRESSÃO ENCONTRADA EM AUDITORIA (19/08): a seta "✓ CONFIRMOU" sobrevivia
 * na análise quando o PRINT provava a confirmação mas a MÁQUINA de setup ainda
 * não liberava (o preço não tinha tocado a linha roxa). O gráfico gritava
 * "aqui entrou" enquanto o card dizia AGUARDANDO CONFIRMAÇÃO — e diante da
 * contradição o operador obedece ao gráfico.
 *
 * A regra vale em QUATRO superfícies (traço SVG, rótulo HTML, PNG exportado e
 * a lista de CAMADAS) e é sempre a mesma: sem `entrySide` — que por contrato
 * significa "entrada confirmada" — a marcação não é desenhada.
 *
 * O teste importa `podeDesenharAnotacao` de produção de propósito: uma cópia
 * local do predicado passaria mesmo com as quatro superfícies apagadas, e o
 * defeito original nasceu exatamente de assimetria entre superfícies.
 */

const desenhavel = podeDesenharAnotacao;

const marca: Annotation = {
  kind: "CONFIRMATION_CANDLE",
  x1: 0.72,
  y1: 0.38,
  x2: null,
  y2: null,
  label: "candle que confirmou",
  index: null,
  reason: "fechou acima do rompimento",
};

const linhaDeEntrada: Annotation = {
  kind: "ENTRY_LINE",
  x1: 0,
  y1: 0.5,
  x2: 1,
  y2: 0.5,
  label: "ENTRAR SE TOCAR AQUI · 169.500",
  index: null,
  reason: "",
};

describe("seta de confirmação × entrada liberada", () => {
  it("sem lado confirmado a seta NÃO é desenhada", () => {
    expect(desenhavel(marca, null)).toBe(false);
  });

  it("com entrada confirmada a seta aparece nos dois lados", () => {
    expect(desenhavel(marca, "COMPRA")).toBe(true);
    expect(desenhavel(marca, "VENDA")).toBe(true);
  });

  it("a linha roxa da entrada continua visível ANTES da confirmação", () => {
    // Ela diz ONDE entraria, não que se deve entrar — é legítima como viés.
    expect(desenhavel(linhaDeEntrada, null)).toBe(true);
  });

  it("nenhuma outra marcação é afetada pela regra", () => {
    const outras: Annotation["kind"][] = [
      "SUPPORT",
      "RESISTANCE",
      "STOP",
      "TARGET",
      "T4_PAST",
      "SCENARIO_ARROW",
      "NOTE",
    ];
    for (const kind of outras) {
      expect(desenhavel({ ...marca, kind }, null)).toBe(true);
    }
  });
});
