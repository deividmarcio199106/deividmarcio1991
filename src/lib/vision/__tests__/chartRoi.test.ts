import { describe, expect, it } from "vitest";

import {
  detectRoi,
  FULL_FRAME,
  roiChangedSignificantly,
  roiUsable,
  toRoiSpace,
  type ColumnProfile,
} from "../chartRoi";
import { candleCountPlausible, REFERENCE_LAYOUT } from "../profitLayout";

/**
 * Os perfis abaixo reproduzem o layout medido na captura real do operador:
 * Profit PRO 1365×767, WINFUT 1Min, 21 candles à esquerda, eixo de preço à
 * direita, eixo de tempo embaixo, barra de ferramentas vertical na borda.
 */
const COLUMNS = 200;

function empty(): ColumnProfile {
  return { ink: 0, top: null, bottom: null };
}

/** Coluna de candle: alcance vertical grande e variável. */
function candle(top: number, bottom: number): ColumnProfile {
  return { ink: Math.round((bottom - top) * 400), top, bottom };
}

/** Coluna de texto de eixo: tem tinta, mas alcance vertical curto. */
function axisText(): ColumnProfile {
  return { ink: 30, top: 0.5, bottom: 0.53 };
}

function profitLikeFrame(): ColumnProfile[] {
  const columns: ColumnProfile[] = [];
  for (let i = 0; i < COLUMNS; i += 1) {
    const fraction = i / COLUMNS;
    if (fraction < 0.006) {
      columns.push(empty());
    } else if (fraction < 0.47) {
      // Região dos candles: alturas variadas, como no print.
      const phase = Math.sin(i * 0.7);
      columns.push(candle(0.18 + phase * 0.06, 0.72 + phase * 0.05));
    } else if (fraction < 0.925) {
      // Área do gráfico ainda, porém sem candle desenhado (à direita do último).
      columns.push(empty());
    } else if (fraction < 0.974) {
      columns.push(axisText()); // eixo de preço
    } else {
      columns.push(empty()); // barra de ferramentas vertical
    }
  }
  return columns;
}

describe("detecção da área do gráfico", () => {
  it("encontra a região dos candles e ignora o eixo de preço", () => {
    const roi = detectRoi(profitLikeFrame());
    expect(roiUsable(roi)).toBe(true);
    // O eixo de preco comeca em 0.925; a area detectada nao pode alcanca-lo.
    expect(roi.x + roi.width).toBeLessThan(0.93);
    expect(roi.x).toBeLessThan(0.05);
  });

  it("a área encontrada bate com o layout medido na captura real", () => {
    const roi = detectRoi(profitLikeFrame());
    expect(roi.y).toBeGreaterThan(0.05);
    expect(roi.y).toBeLessThan(REFERENCE_LAYOUT.plot.y + 0.15);
    expect(roi.height).toBeGreaterThan(0.4);
  });

  it("texto de eixo não é confundido com candle", () => {
    // Texto tem alcance vertical curto; candle tem alcance grande. E isso — e
    // nao a cor — que separa os dois, para funcionar em tema claro ou escuro.
    const soTexto: ColumnProfile[] = Array.from({ length: 40 }, () => axisText());
    const roi = detectRoi(soTexto);
    // Sem variacao de alcance, nada se destaca: a deteccao nao deve afirmar area.
    expect(roi.confidence).toBeLessThan(70);
  });

  it("imagem estreita demais devolve o frame inteiro, sem inventar área", () => {
    const roi = detectRoi([candle(0.2, 0.8), empty()]);
    expect(roi).toEqual({ ...FULL_FRAME, detail: expect.any(String) });
    expect(roi.confidence).toBe(0);
  });

  it("sobrevive a mudança de resolução — as frações não mudam", () => {
    // Mesmo layout amostrado com o dobro de colunas: a ROI precisa bater.
    const dobro: ColumnProfile[] = [];
    for (const column of profitLikeFrame()) {
      dobro.push(column, column);
    }
    const original = detectRoi(profitLikeFrame());
    const redimensionado = detectRoi(dobro);
    expect(Math.abs(original.x - redimensionado.x)).toBeLessThan(0.02);
    expect(Math.abs(original.width - redimensionado.width)).toBeLessThan(0.02);
  });

  it("tolera ruído de antialiasing sem redetectar a toda hora", () => {
    const a = detectRoi(profitLikeFrame());
    const b = { ...a, x: a.x + 0.004, width: a.width - 0.006 };
    expect(roiChangedSignificantly(a, b)).toBe(false);

    const mudouDeVerdade = { ...a, x: a.x + 0.2 };
    expect(roiChangedSignificantly(a, mudouDeVerdade)).toBe(true);
  });

  it("converte coordenada da imagem para dentro da ROI", () => {
    const roi = { x: 0.1, y: 0.2, width: 0.8, height: 0.6, confidence: 80, detail: "" };
    expect(toRoiSpace(roi, 0.5, 0.5)).toEqual({ x: 0.5, y: 0.5 });
    expect(toRoiSpace(roi, 0.1, 0.2)).toEqual({ x: 0, y: 0 });
  });
});

describe("sanidade da contagem de candles", () => {
  it("aceita a contagem observada na captura real", () => {
    expect(candleCountPlausible(REFERENCE_LAYOUT.candlesVisible)).toBe(true);
  });

  it("recusa contagem que denuncia leitura quebrada", () => {
    // 3 colunas = a leitura falhou; 300 = algo fora do grafico virou candle.
    expect(candleCountPlausible(3)).toBe(false);
    expect(candleCountPlausible(300)).toBe(false);
  });
});
