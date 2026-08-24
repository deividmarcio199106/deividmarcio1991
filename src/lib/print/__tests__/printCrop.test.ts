import { describe, expect, it } from "vitest";

import type { PrintAnalysis } from "@/lib/vision/printAnalysis";
import type { Roi } from "@/lib/vision/chartRoi";
import {
  chooseBetterReading,
  columnProfilesFromGray,
  cropIsWorthIt,
  cropWindowFor,
  readingIsWeak,
  readingScore,
} from "../printCrop";

/**
 * O auto-crop tem uma restrição que vale mais que a economia de pixels: o
 * EIXO DE PREÇO, na borda direita, é a régua de todo o sistema. Estes testes
 * trancam isso, e trancam também que o 2º passe só roda quando a IMAGEM
 * limitou a leitura — nunca porque o gráfico não tinha setup.
 */

const num = (value: number) => ({ value, visible: true });
const ILEGIVEL = { value: null, visible: false };

function analise(overrides: Partial<PrintAnalysis> = {}): PrintAnalysis {
  return {
    status: "T4_EM_FORMACAO",
    direction: "COMPRA",
    confidence: 78,
    symbol: "WINFUT",
    timeframe: "1Min",
    // Campos do ciclo de vida do candle: o fixture-padrao nao le relogio nem
    // candle fechado — quem testa isso preenche explicitamente.
    chartClock: { date: null, time: null },
    lastClosedCandle: null,
    currentPrice: num(169_600),
    entry: ILEGIVEL,
    entryZone: null,
    stop: ILEGIVEL,
    targets: [],
    invalidation: "",
    criteria: [],
    annotations: [],
    scenarios: [],
    pastOccurrences: 0,
    explanation: "",
    missingCriteria: [],
    imageIssues: [],
    nextScreenshot: null,
    conditionalPlans: [],
    priceLevels: [
      { kind: "SUPORTE", label: "Fundo anterior", priceMin: num(169_200), priceMax: null },
    ],
    dna: null,
    audit: null,
    confidences: null,
    ...overrides,
  } as PrintAnalysis;
}

function roi(over: Partial<Roi> = {}): Roi {
  return { x: 0.2, y: 0.1, width: 0.6, height: 0.7, confidence: 80, detail: "", ...over };
}

describe("janela de recorte", () => {
  it("NUNCA corta a borda direita — é onde mora a escala de preço", () => {
    const janela = cropWindowFor(roi());
    expect(janela.x + janela.width).toBe(1);
  });

  it("apara a esquerda e deixa folga vertical para eixo de tempo e legenda", () => {
    const janela = cropWindowFor(roi({ x: 0.25, y: 0.2, height: 0.5 }));
    expect(janela.x).toBeCloseTo(0.28, 6); // ancorado na direita: 1 − 0,72
    expect(janela.y).toBeCloseTo(0.16, 6); // 0,20 − 0,04 de margem
    expect(janela.y + janela.height).toBeCloseTo(0.74, 6); // 0,70 + 0,04
  });

  it("prioriza os candles RECENTES: gráfico largo é ancorado na direita", () => {
    // Gráfico ocupando a imagem quase inteira: o passado distante à esquerda
    // sai para os candles recentes e o eixo de preço ganharem pixels.
    const janela = cropWindowFor(roi({ x: 0.02, width: 0.96 }));
    expect(janela.width).toBeCloseTo(0.72, 6);
    expect(janela.x + janela.width).toBe(1);
  });

  it("gráfico já estreito NÃO é cortado além do cromo — nada de perder contexto à toa", () => {
    const janela = cropWindowFor(roi({ x: 0.45 }));
    expect(janela.x).toBeCloseTo(0.45, 6);
    expect(janela.width).toBeCloseTo(0.55, 6);
  });

  it("não estoura os limites da imagem quando a ROI encosta nas bordas", () => {
    const janela = cropWindowFor(roi({ x: 0, y: 0, width: 1, height: 1 }));
    expect(janela.y).toBe(0);
    expect(janela.y + janela.height).toBeLessThanOrEqual(1);
  });
});

describe("vale a pena recortar?", () => {
  it("recorte que quase não muda nada não paga uma segunda chamada de IA", () => {
    expect(cropIsWorthIt({ x: 0, y: 0, width: 1, height: 0.97 })).toBe(false);
  });

  it("recorte que tira o cromo lateral vale", () => {
    expect(cropIsWorthIt(cropWindowFor(roi()))).toBe(true);
  });

  it("área minúscula é detecção errada, não recorte bom", () => {
    expect(cropIsWorthIt({ x: 0.8, y: 0.8, width: 0.2, height: 0.2 })).toBe(false);
  });
});

describe("quando a leitura é fraca", () => {
  it("leitura completa e nítida NÃO dispara segundo passe", () => {
    expect(readingIsWeak(analise()).weak).toBe(false);
  });

  it("SEM_T4 com escala legível continua sendo leitura boa", () => {
    // A ausência de setup é uma resposta; reanalisar ampliado seria gastar
    // GPU para reconfirmar o já sabido.
    expect(readingIsWeak(analise({ status: "SEM_T4", direction: "NEUTRO" })).weak).toBe(false);
  });

  it("INCONCLUSIVO, confiança baixa, problema de imagem e escala ilegível disparam", () => {
    expect(readingIsWeak(analise({ status: "INCONCLUSIVO" })).weak).toBe(true);
    expect(readingIsWeak(analise({ confidence: 41 })).weak).toBe(true);
    expect(readingIsWeak(analise({ imageIssues: ["candles pequenos demais"] })).weak).toBe(true);
    expect(readingIsWeak(analise({ currentPrice: ILEGIVEL })).weak).toBe(true);
    expect(readingIsWeak(analise({ priceLevels: [] })).weak).toBe(true);
  });

  it("o motivo é dito, nunca um 'melhorou' silencioso", () => {
    const fraca = readingIsWeak(analise({ confidence: 30, imageIssues: ["borrado"] }));
    expect(fraca.motivos.join(" ")).toContain("30%");
    expect(fraca.motivos.join(" ")).toContain("borrado");
  });
});

describe("qual leitura fica", () => {
  it("empate mantém a primeira — trocar por nada faria a tela oscilar", () => {
    const escolha = chooseBetterReading(analise(), analise());
    expect(escolha.usarSegunda).toBe(false);
    expect(escolha.motivo).toContain("1º passe mantido");
  });

  it("recorte que leu níveis que faltavam vence", () => {
    const primeira = analise({ status: "INCONCLUSIVO", confidence: 35, priceLevels: [] });
    const segunda = analise({
      confidence: 80,
      entry: num(169_500),
      stop: num(169_300),
      targets: [num(169_900)],
    });
    const escolha = chooseBetterReading(primeira, segunda);
    expect(escolha.usarSegunda).toBe(true);
    expect(escolha.motivo).toContain("2º passe");
  });

  it("recorte que leu MENOS é descartado — segundo passe não vence por ser segundo", () => {
    const primeira = analise({ entry: num(169_500), stop: num(169_300) });
    const segunda = analise({ status: "INCONCLUSIVO", confidence: 20, priceLevels: [] });
    expect(chooseBetterReading(primeira, segunda).usarSegunda).toBe(false);
  });

  it("confiança sozinha não vira leitura melhor: número lido pesa mais que autoavaliação", () => {
    const comNumeros = analise({ confidence: 60, entry: num(169_500), stop: num(169_300) });
    const soConfiante = analise({ confidence: 99 });
    expect(readingScore(comNumeros)).toBeGreaterThan(readingScore(soConfiante));
  });
});

describe("perfis de coluna a partir de cinzas", () => {
  /** Grade sintética: cromo chapado à esquerda, candles no meio-direita. */
  function grade(cols: number, rows: number): number[] {
    const g = new Array<number>(cols * rows).fill(20); // fundo escuro dominante
    for (let c = Math.floor(cols * 0.3); c < cols; c += 1) {
      const altura = 4 + ((c * 7) % Math.max(1, Math.floor(rows / 2)));
      const meio = Math.floor(rows / 2);
      for (let r = meio - altura; r <= meio + altura; r += 1) {
        if (r >= 0 && r < rows) g[r * cols + c] = 220;
      }
    }
    return g;
  }

  it("encontra a faixa do gráfico e ignora a área chapada", () => {
    const cols = 60;
    const rows = 40;
    const perfis = columnProfilesFromGray(grade(cols, rows), cols, rows);
    expect(perfis).toHaveLength(cols);
    // Colunas do cromo não têm tinta; as do gráfico têm.
    expect(perfis[2]!.ink).toBe(0);
    expect(perfis[2]!.top).toBeNull();
    expect(perfis[50]!.ink).toBeGreaterThan(0);
    expect(perfis[50]!.top).not.toBeNull();
  });

  it("tema claro funciona igual: o fundo é o tom DOMINANTE, não uma cor fixa", () => {
    const cols = 60;
    const rows = 40;
    // Inverte: fundo claro (230), candles escuros (20).
    const invertida = grade(cols, rows).map((v) => (v === 20 ? 230 : 20));
    const perfis = columnProfilesFromGray(invertida, cols, rows);
    expect(perfis[2]!.ink).toBe(0);
    expect(perfis[50]!.ink).toBeGreaterThan(0);
  });

  it("grade inconsistente devolve lista vazia em vez de perfil inventado", () => {
    expect(columnProfilesFromGray([1, 2, 3], 10, 10)).toEqual([]);
    expect(columnProfilesFromGray([], 0, 0)).toEqual([]);
  });
});
