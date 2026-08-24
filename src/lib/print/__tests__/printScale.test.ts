import { describe, expect, it } from "vitest";

import { buildPriceAnnotations, mergeCalibratedAnnotations, priceToFraction } from "../printScale";
import { calibrateFromAnchors, type ScaleAnchor } from "@/lib/vision/priceScale";
import type { Annotation } from "@/lib/vision/printAnalysis";

/**
 * A promessa deste módulo: nível na ALTURA DO PREÇO, vindo da régua — nunca
 * do palpite de pixel do modelo. Estes testes trancam a conversão, a lei do
 * `visible`, o vocabulário de zonas da leitura completa e a regra de fusão
 * (a régua só vence os kinds que ela mesma recalculou).
 */

// Escala sintética: 170.000 no topo (y=100), 169.000 na base (y=900) de um
// frame de 1000px — 1 ponto = 0,8px, linear como o eixo do Profit.
function calibracao() {
  const anchors: ScaleAnchor[] = [
    { y: 100, price: 170_000, raw: "170.000", source: "ocr", confidence: 0.9 },
    { y: 500, price: 169_500, raw: "169.500", source: "ocr", confidence: 0.9 },
    { y: 900, price: 169_000, raw: "169.000", source: "ocr", confidence: 0.9 },
  ];
  const calibration = calibrateFromAnchors(anchors);
  expect(calibration.usable).toBe(true);
  return calibration;
}

const num = (value: number) => ({ value, visible: true });
const ILEGIVEL = { value: null, visible: false };

function base() {
  return {
    entry: ILEGIVEL,
    entryZone: null,
    stop: ILEGIVEL,
    targets: [] as { value: number | null; visible: boolean }[],
    conditionalPlans: [] as never[],
    priceLevels: [] as never[],
  };
}

const cal = calibracao();
const paraFracao = (p: number) => priceToFraction(cal, 1000, p);

describe("priceToFraction", () => {
  it("converte preço em fração da altura pela reta da régua", () => {
    expect(priceToFraction(cal, 1000, 169_500)).toBeCloseTo(0.5, 2);
    expect(priceToFraction(cal, 1000, 170_000)).toBeCloseTo(0.1, 2);
  });

  it("preço fora do enquadramento devolve null — nada de linha voadora na borda", () => {
    expect(priceToFraction(cal, 1000, 172_000)).toBeNull();
    expect(priceToFraction(cal, 1000, 167_000)).toBeNull();
  });
});

describe("buildPriceAnnotations — níveis da operação", () => {
  it("entrada, zona, stop e alvos legíveis viram linhas na altura do preço", () => {
    const { annotations, replaceKinds } = buildPriceAnnotations(
      {
        ...base(),
        entry: num(169_500),
        entryZone: { min: num(169_400), max: num(169_600) },
        stop: num(169_200),
        targets: [num(169_800), num(169_900)],
      },
      paraFracao,
    );
    expect(annotations.map((m) => m.kind)).toEqual([
      "ENTRY_LINE",
      "ENTRY_ZONE",
      "STOP",
      "TARGET",
      "TARGET",
    ]);
    const entrada = annotations[0]!;
    expect(entrada.y1).toBeCloseTo(0.5, 2);
    expect(entrada.label).toContain("169.500");
    expect(entrada.reason).toContain("régua");
    expect(replaceKinds.has("ENTRY_LINE")).toBe(true);
    expect(replaceKinds.has("STOP")).toBe(true);
  });

  it("a lei do visible atravessa: nível ilegível NUNCA vira linha", () => {
    const { annotations } = buildPriceAnnotations(
      { ...base(), entry: { value: 169_500, visible: false } },
      paraFracao,
    );
    expect(annotations).toEqual([]);
  });

  it("nível fora do enquadramento é descartado, não espremido na borda", () => {
    const { annotations } = buildPriceAnnotations({ ...base(), stop: num(167_000) }, paraFracao);
    expect(annotations).toEqual([]);
  });
});

describe("buildPriceAnnotations — leitura completa (priceLevels)", () => {
  it("zona de venda com faixa vira banda SUPPLY_ZONE com o intervalo no rótulo", () => {
    const { annotations, replaceKinds } = buildPriceAnnotations(
      {
        ...base(),
        priceLevels: [
          {
            kind: "ZONA_VENDA",
            label: "Topo institucional / liquidez",
            priceMin: num(169_900),
            priceMax: num(169_950),
          },
        ] as never[],
      },
      paraFracao,
    );
    const zona = annotations[0]!;
    expect(zona.kind).toBe("SUPPLY_ZONE");
    expect(zona.y1).toBeLessThan(zona.y2!);
    expect(zona.label).toContain("Topo institucional");
    expect(zona.label).toContain("169.900");
    expect(zona.label).toContain("169.950");
    expect(replaceKinds.has("SUPPLY_ZONE")).toBe(true);
  });

  it("TOPO vira linha de resistência nomeada; PERDA_ESTRUTURAL vira invalidação", () => {
    const { annotations } = buildPriceAnnotations(
      {
        ...base(),
        priceLevels: [
          { kind: "TOPO", label: "Topo principal", priceMin: num(169_950), priceMax: null },
          {
            kind: "PERDA_ESTRUTURAL",
            label: "Perda estrutural",
            priceMin: num(169_300),
            priceMax: null,
          },
        ] as never[],
      },
      paraFracao,
    );
    expect(annotations[0]!.kind).toBe("RESISTANCE");
    expect(annotations[0]!.label).toContain("Topo principal");
    expect(annotations[1]!.kind).toBe("INVALIDATION");
  });

  it("gatilho do plano NÃO entra em replaceKinds — não apaga S/R estrutural do modelo", () => {
    const { annotations, replaceKinds } = buildPriceAnnotations(
      {
        ...base(),
        conditionalPlans: [
          {
            trigger: "fechamento acima do topo",
            triggerLevel: num(169_700),
            side: "COMPRA",
            entry: num(169_700),
            entryZone: null,
            stop: num(169_500),
            targets: [],
            invalidation: "",
            rationale: "",
          },
        ] as never[],
      },
      paraFracao,
    );
    const plano = annotations.find((m) => m.label.startsWith("PLANO:"))!;
    expect(plano.kind).toBe("RESISTANCE");
    expect(replaceKinds.has("RESISTANCE")).toBe(false);
  });
});

describe("mergeCalibratedAnnotations", () => {
  const doModelo: Annotation[] = [
    {
      kind: "ENTRY_LINE",
      x1: 0,
      y1: 0.7,
      x2: 1,
      y2: 0.7,
      label: "entrada (palpite)",
      index: null,
      reason: "",
    },
    {
      kind: "SUPPORT",
      x1: 0,
      y1: 0.8,
      x2: 1,
      y2: 0.8,
      label: "fundo anterior",
      index: null,
      reason: "",
    },
    { kind: "T4_PAST", x1: 0.2, y1: 0.3, x2: 0.25, y2: 0.4, label: "T4 #1", index: 1, reason: "" },
  ];

  it("kind recalculado SUBSTITUI o palpite; estrutura sem versão da régua fica", () => {
    const calibradas = {
      annotations: [
        {
          kind: "ENTRY_LINE",
          x1: 0,
          y1: 0.5,
          x2: 1,
          y2: 0.5,
          label: "ENTRADA 169.500",
          index: null,
          reason: "régua",
        } as Annotation,
      ],
      replaceKinds: new Set<Annotation["kind"]>(["ENTRY_LINE"]),
    };
    const fundidas = mergeCalibratedAnnotations(doModelo, calibradas);
    const entradas = fundidas.filter((a) => a.kind === "ENTRY_LINE");
    expect(entradas).toHaveLength(1);
    expect(entradas[0]!.label).toContain("169.500");
    expect(fundidas.some((a) => a.kind === "SUPPORT")).toBe(true);
    expect(fundidas.some((a) => a.kind === "T4_PAST")).toBe(true);
  });

  it("linha de plano com kind S/R não apaga o S/R estrutural do modelo", () => {
    const calibradas = {
      annotations: [
        {
          kind: "RESISTANCE",
          x1: 0,
          y1: 0.4,
          x2: 1,
          y2: 0.4,
          label: "PLANO: SE romper (169.700) → COMPRA",
          index: null,
          reason: "régua",
        } as Annotation,
      ],
      // Plano não recalcula S/R: replaceKinds vazio para esse kind.
      replaceKinds: new Set<Annotation["kind"]>(),
    };
    const fundidas = mergeCalibratedAnnotations(doModelo, calibradas);
    expect(fundidas.filter((a) => a.kind === "SUPPORT")).toHaveLength(1);
    expect(fundidas.some((a) => a.label.startsWith("PLANO:"))).toBe(true);
  });

  it("sem versão calibrada, o palpite do modelo permanece — nível sumido é pior", () => {
    const vazio = { annotations: [], replaceKinds: new Set<Annotation["kind"]>() };
    expect(mergeCalibratedAnnotations(doModelo, vazio)).toEqual(doModelo);
  });
});
