import { describe, expect, it } from "vitest";

import type { Candle } from "@/lib/engines/types";
import { buildSegments, CandleStitcher } from "./candleStitcher";

function candle(i: number, base = 100, drift = 1): Candle {
  const open = base + i * drift;
  const close = open + drift;
  return {
    t: 1_700_000_000_000 + i * 60_000,
    o: open,
    h: Math.max(open, close) + 0.5,
    l: Math.min(open, close) - 0.5,
    c: close,
    v: 0,
  };
}

function series(from: number, count: number, base = 100, drift = 1): Candle[] {
  return Array.from({ length: count }, (_, i) => candle(from + i, base, drift));
}

// ---------- costura e retrocesso (§9–§10, §45) ----------
describe("costura cronológica das janelas do gráfico", () => {
  it("arraste lento e rápido: anexa só os candles novos, sem perder ordem", () => {
    const stitcher = new CandleStitcher();
    stitcher.ingest(series(0, 10));
    const slow = stitcher.ingest(series(1, 10)); // andou 1 candle
    expect(slow.appended).toBe(1);
    const fast = stitcher.ingest(series(6, 10)); // andou 5 de uma vez
    expect(fast.appended).toBe(5);
    expect(stitcher.sequence()).toHaveLength(16);
    expect(stitcher.sequence()[15]!.c).toBeCloseTo(series(6, 10)[9]!.c, 6);
  });

  it("frame idêntico/contido não adiciona nada", () => {
    const stitcher = new CandleStitcher();
    stitcher.ingest(series(0, 10));
    const contained = stitcher.ingest(series(0, 10));
    expect(contained.appended).toBe(0);
    expect(contained.discontinuity).toBe(false);
  });

  it("autoescala geométrica: reconhece o mesmo trecho sob transformação afim e anexa só o candle novo", () => {
    const raw: Candle[] = [
      { t: 0, o: 100, h: 106, l: 98, c: 104, v: 0 },
      { t: 0, o: 104, h: 105, l: 99, c: 101, v: 0 },
      { t: 0, o: 101, h: 110, l: 100, c: 108, v: 0 },
      { t: 0, o: 108, h: 112, l: 103, c: 105, v: 0 },
      { t: 0, o: 105, h: 109, l: 101, c: 107, v: 0 },
      { t: 0, o: 107, h: 108, l: 96, c: 99, v: 0 },
      { t: 0, o: 99, h: 104, l: 97, c: 103, v: 0 },
      { t: 0, o: 103, h: 111, l: 102, c: 109, v: 0 },
      { t: 0, o: 109, h: 110, l: 104, c: 106, v: 0 },
      { t: 0, o: 106, h: 115, l: 105, c: 113, v: 0 },
      { t: 0, o: 113, h: 116, l: 108, c: 110, v: 0 },
    ];
    const transform = (items: Candle[], scale: number, offset: number): Candle[] =>
      items.map((item) => ({
        ...item,
        o: item.o * scale + offset,
        h: item.h * scale + offset,
        l: item.l * scale + offset,
        c: item.c * scale + offset,
      }));

    const stitcher = new CandleStitcher();
    stitcher.ingest(transform(raw.slice(0, 10), 2.1, 340), { allowAffine: true });
    const shifted = stitcher.ingest(transform(raw.slice(1, 11), 0.73, 82), { allowAffine: true });

    expect(shifted.discontinuity).toBe(false);
    expect(shifted.appended).toBe(1);
    expect(stitcher.sequence()).toHaveLength(11);
  });

  it("transformação de autoescala não é aceita no modo de preço real", () => {
    const raw: Candle[] = [
      { t: 0, o: 100, h: 106, l: 98, c: 104, v: 0 },
      { t: 0, o: 104, h: 105, l: 99, c: 101, v: 0 },
      { t: 0, o: 101, h: 110, l: 100, c: 108, v: 0 },
      { t: 0, o: 108, h: 112, l: 103, c: 105, v: 0 },
      { t: 0, o: 105, h: 109, l: 101, c: 107, v: 0 },
      { t: 0, o: 107, h: 108, l: 96, c: 99, v: 0 },
    ];
    const transform = (items: Candle[], scale: number, offset: number): Candle[] =>
      items.map((item) => ({
        ...item,
        o: item.o * scale + offset,
        h: item.h * scale + offset,
        l: item.l * scale + offset,
        c: item.c * scale + offset,
      }));

    const stitcher = new CandleStitcher();
    stitcher.ingest(transform(raw, 2.1, 340));
    const rescaled = stitcher.ingest(transform(raw, 0.73, 82));

    expect(rescaled.discontinuity).toBe(true);
  });

  it("retrocesso: voltar no histórico encerra o segmento, nunca cria sequência falsa (§10)", () => {
    const stitcher = new CandleStitcher();
    stitcher.ingest(series(0, 10));
    stitcher.ingest(series(5, 10)); // avançou até o candle 14
    const back = stitcher.ingest(series(0, 8)); // usuário arrastou de volta ao início
    expect(back.discontinuity).toBe(true);
    expect(back.reason).toContain("RETROCESSO");
    expect(stitcher.currentSegment()).toBe(1);
  });

  it("salto de período (dados sem relação) também abre novo segmento", () => {
    const stitcher = new CandleStitcher();
    stitcher.ingest(series(0, 10, 100, 1));
    const jump = stitcher.ingest(series(0, 10, 5000, 3)); // outro nível de preço
    expect(jump.discontinuity).toBe(true);
    expect(stitcher.currentSegment()).toBe(1);
  });

  it("buildSegments separa segmentos e atribui tempos sintéticos ordenados", () => {
    const frames = [series(0, 10), series(3, 10), series(0, 6, 5000, 3), series(2, 6, 5000, 3)];
    const { segments, discontinuities } = buildSegments(frames);
    expect(segments).toHaveLength(2);
    expect(discontinuities).toHaveLength(1);
    for (const segment of segments) {
      for (let i = 1; i < segment.length; i++) {
        expect(segment[i]!.t).toBeGreaterThan(segment[i - 1]!.t);
      }
    }
  });
});

/**
 * AUTOESCALA DO PROFIT — o mesmo mercado, outros números.
 *
 * Quando o Profit reajusta o eixo vertical, o MESMO trecho de gráfico passa a
 * ocupar outros valores de pixel. O casamento afim reconhece isso, e é para
 * isso que ele existe. O que faltava era a volta: os candles novos vinham na
 * escala NOVA e eram anexados a uma série na escala ANTIGA.
 *
 * O resultado era um degrau de preço que o mercado nunca teve, exatamente na
 * emenda — e ele contamina tudo o que é medido sobre a série (estrutura,
 * rompimento, regime), além de degradar o casamento seguinte.
 */
describe("CandleStitcher — reajuste de escala entre frames", () => {
  const passo = (i: number) => 100 + Math.sin(i * 1.7) * 12 + i * 0.6;

  function janela(from: number, count: number, escala = 1, desloc = 0): Candle[] {
    return Array.from({ length: count }, (_, i) => {
      const o = passo(from + i) * escala + desloc;
      const c = passo(from + i + 1) * escala + desloc;
      return {
        t: (from + i) * 60_000,
        o,
        h: Math.max(o, c) + 1 * escala,
        l: Math.min(o, c) - 1 * escala,
        c,
        v: 10,
      } as Candle;
    });
  }

  it("candle novo entra no sistema da série, sem degrau artificial", () => {
    const stitcher = new CandleStitcher();
    stitcher.ingest(janela(0, 30));

    // Mesmo mercado, um candle a mais, com o eixo reajustado: tudo multiplicado
    // por 2 e deslocado em 500 — é o que a autoescala faz com os pixels.
    stitcher.ingest(janela(1, 30, 2, 500), { allowAffine: true });

    const serie = stitcher.sequence();
    expect(serie.length).toBe(31);

    const novo = serie[serie.length - 1]!;
    const anterior = serie[serie.length - 2]!;
    // Sem a conversão, o novo candle chegaria perto de 2×100+500 = ~700,
    // enquanto a série vive perto de 100: um salto de ~600 do nada.
    const salto = Math.abs(novo.c - anterior.c);
    const amplitudeTipica = Math.abs(serie[10]!.c - serie[9]!.c);
    expect(salto).toBeLessThan(amplitudeTipica * 6);
    expect(novo.c).toBeGreaterThan(60);
    expect(novo.c).toBeLessThan(160);
  });

  it("sem reajuste de escala o valor é preservado exatamente", () => {
    const stitcher = new CandleStitcher();
    stitcher.ingest(janela(0, 30));
    stitcher.ingest(janela(1, 30), { allowAffine: true });

    const serie = stitcher.sequence();
    const esperado = janela(1, 30)[29]!;
    expect(serie[serie.length - 1]!.c).toBeCloseTo(esperado.c, 6);
  });
});
