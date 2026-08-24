import { describe, expect, it } from "vitest";

import type { FrameRoi } from "../frameHash";
import {
  DUPLICATE_MAX_DISTANCE,
  DUPLICATE_RETRY_LIMIT,
  framesAreDuplicate,
  cellDistance,
  lumaFromRgba,
  perceptualHash,
} from "../frameHash";

/**
 * A ASSINATURA DE FRAME EM TESTE (§3 e §40).
 *
 * A pergunta é uma só — "este frame é novo?" — e ela erra de dois jeitos com
 * custos muito diferentes:
 *   • dizer NOVO para uma imagem parada: gasta uma inferência de GPU à toa;
 *   • dizer DUPLICADO para uma imagem que mudou: PERDE a operação.
 * O segundo é o que não se negocia, e é o que estes testes atacam primeiro.
 *
 * Os frames são construídos no tamanho real de uma captura (1920×1080) porque
 * a pergunta do §40 é justamente sobre PROPORÇÃO: um candle de poucos pixels
 * numa tela grande. Testar num retângulo de brinquedo responderia outra coisa.
 */

const LARGURA = 1920;
const ALTURA = 1080;

/** Cinza do fundo do gráfico no tema escuro do Profit. */
const FUNDO = [18, 18, 22] as const;
const VERDE = [60, 200, 120] as const;
const CLARO = [210, 210, 210] as const;
/** Vermelho: a barra do teste muda pixel mesmo caindo sobre um candle verde. */
const VERMELHO = [220, 40, 40] as const;

interface Barra {
  x: number;
  largura: number;
  topo: number;
  altura: number;
  cor: readonly [number, number, number];
}

/**
 * Um "gráfico" sintético: fundo escuro e uma sequência de candles finos.
 *
 * `extras` permite acrescentar UM elemento — a barra nova, o relógio, o
 * cursor — sem mexer no resto, que é exatamente a comparação que interessa.
 */
function frame(candles: number, extras: Barra[] = []): Uint8ClampedArray {
  const d = new Uint8ClampedArray(LARGURA * ALTURA * 4);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = FUNDO[0];
    d[i + 1] = FUNDO[1];
    d[i + 2] = FUNDO[2];
    d[i + 3] = 255;
  }
  const pinta = (b: Barra) => {
    for (let x = b.x; x < b.x + b.largura && x < LARGURA; x += 1) {
      for (let y = b.topo; y < b.topo + b.altura && y < ALTURA; y += 1) {
        const p = (y * LARGURA + x) * 4;
        d[p] = b.cor[0];
        d[p + 1] = b.cor[1];
        d[p + 2] = b.cor[2];
      }
    }
  };
  // Candles de 6 px a cada 12 px — densidade típica de um 1-min com zoom médio.
  for (let c = 0; c < candles; c += 1) {
    pinta({
      x: 100 + c * 12,
      largura: 6,
      topo: 300 + ((c * 53) % 200),
      altura: 200 + ((c * 37) % 400),
      cor: VERDE,
    });
  }
  for (const extra of extras) pinta(extra);
  return d;
}

const hashDe = (d: Uint8ClampedArray, roi?: FrameRoi) =>
  perceptualHash(lumaFromRgba(d, LARGURA, ALTURA), roi);

/**
 * A ÁREA DO GRÁFICO — o recorte que a captura real entrega (§4).
 *
 * Exclui a faixa superior (abas, título, cronômetro do candle) e a coluna da
 * direita (eixo de preço, book). É esse recorte que faz o relógio piscando
 * ficar de fora da assinatura sem precisar afrouxar limiar nenhum — afrouxar
 * seria a solução errada, porque a mesma folga engoliria uma barra curta.
 */
const AREA_DO_GRAFICO: FrameRoi = { x: 0, y: 0.08, width: 0.9, height: 0.86 };

describe("hash perceptual do frame", () => {
  it("a MESMA imagem produz o mesmo hash", () => {
    expect(hashDe(frame(120))).toBe(hashDe(frame(120)));
    expect(framesAreDuplicate(hashDe(frame(120)), hashDe(frame(120)))).toBe(true);
  });

  it("a assinatura tem uma célula por posição da grade", () => {
    // 32×36 células × 2 dígitos hex.
    expect(hashDe(frame(120))).toHaveLength(32 * 36 * 2);
  });

  it("grade vazia devolve string vazia, e vazio nunca é 'duplicado'", () => {
    expect(perceptualHash({ luma: [], width: 0, height: 0 })).toBe("");
    expect(framesAreDuplicate("", hashDe(frame(120)))).toBe(false);
    expect(framesAreDuplicate(null, "abc")).toBe(false);
    expect(framesAreDuplicate("abc", null)).toBe(false);
  });

  it("hashes de tamanhos diferentes não são comparáveis — distância −1", () => {
    expect(cellDistance("abcd", "abcdef")).toBe(-1);
    expect(cellDistance("zzzz", "abcd")).toBe(-1);
    expect(framesAreDuplicate("abcd", "abcdef")).toBe(false);
  });

  it("a distância conta CÉLULAS alteradas, não bits", () => {
    // Duas células por assinatura (4 dígitos hex). A primeira muda de 0x00
    // para 0xff — mudança grande; a segunda não muda.
    expect(cellDistance("00ff", "ffff")).toBe(1);
    expect(cellDistance("ffff", "ffff")).toBe(0);
    // Variação abaixo do limiar não conta: é ruído de codificação.
    expect(cellDistance("8080", "8281")).toBe(0);
    // Assinatura de tamanho ímpar não é comparável — célula tem 2 dígitos.
    expect(cellDistance("abc", "abd")).toBe(-1);
  });
});

/**
 * §40 — O QUE A ASSINATURA PRECISA ENXERGAR E O QUE PRECISA IGNORAR.
 *
 * Estes são os casos que o operador nomeou. Eles medem a fronteira real entre
 * "movimento de mercado" e "ruído de interface".
 */
describe("§40 — movimento real x ruído de interface", () => {
  const base = hashDe(frame(120));

  /** Um candle novo, no fim da série — o caso mais comum e o mais crítico. */
  const CANDLE_NOVO: Barra = {
    x: 100 + 120 * 12,
    largura: 6,
    topo: 380,
    altura: 260,
    cor: VERMELHO,
  };

  it("UM candle novo NÃO pode ser lido como duplicado", () => {
    const comCandle = hashDe(frame(120, [CANDLE_NOVO]));
    const distancia = cellDistance(base, comCandle);
    expect(distancia).toBeGreaterThan(DUPLICATE_MAX_DISTANCE);
    expect(framesAreDuplicate(base, comCandle)).toBe(false);
  });

  it("e isso vale em qualquer posição horizontal — não existe coluna cega", () => {
    /*
     * O defeito clássico de assinatura por amostragem: com passo fixo, sempre
     * as mesmas colunas são lidas e uma barra entre elas fica invisível.
     *
     * A série base ocupa só a metade esquerda; a barra de teste é desenhada
     * sobre FUNDO, varrendo a metade direita. É o caso real — candle novo
     * aparece na borda direita, onde antes não havia nada.
     *
     * Onze posições, e não quarenta: cada uma constrói e hasheia um frame
     * 1920×1080 inteiro (2 milhões de pixels), e a propriedade que se quer
     * provar — nenhuma coluna é cega — fica igualmente provada com o passo
     * largo. O tempo extra é explícito porque este teste é caro por natureza;
     * escondê-lo num frame de brinquedo responderia outra pergunta.
     */
    const serieCurta = hashDe(frame(50));
    for (let x = 750; x < LARGURA - 60; x += 100) {
      const comCandle = hashDe(frame(50, [{ ...CANDLE_NOVO, x }]));
      expect(framesAreDuplicate(serieCurta, comCandle)).toBe(false);
    }
  }, 30_000);

  it("o relógio piscando FORA do gráfico não entra na assinatura", () => {
    /*
     * O cronômetro do candle e o relógio do Windows vivem fora da área do
     * gráfico. A defesa correta é o RECORTE, não a tolerância: uma folga
     * grande o bastante para engolir o relógio engoliria também uma barra
     * curta — foi assim que a versão anterior deixou passar um candle novo.
     */
    const relogio: Barra = { x: LARGURA - 120, largura: 90, topo: 20, altura: 26, cor: CLARO };
    const baseRecortada = hashDe(frame(120), AREA_DO_GRAFICO);
    const comRelogio = hashDe(frame(120, [relogio]), AREA_DO_GRAFICO);
    expect(framesAreDuplicate(baseRecortada, comRelogio)).toBe(true);
    // E sem o recorte ele SERIA contado — é o recorte que resolve, dito aqui.
    expect(framesAreDuplicate(base, hashDe(frame(120, [relogio])))).toBe(false);
  });

  it("o cursor do mouse CONTA como frame novo — e isso é deliberado", () => {
    /*
     * MUDOU DEPOIS DA SESSÃO REAL DE 20/08 (§45). Antes o cursor era absorvido
     * pela folga de 3 células; a mesma folga absorveu um candle de verdade nos
     * prints 031→032 e o frame foi descartado.
     *
     * Cursor e candle são objetos de tamanho parecido: separá-los por contagem
     * de células é uma aposta que a sessão real perdeu. Então a folga foi a
     * zero, e o cursor passou para o lado dos falsos-novos — que custam uma
     * inferência de GPU, enquanto um falso-duplicado custa a operação.
     */
    const cursor: Barra = { x: 900, largura: 12, topo: 500, altura: 18, cor: CLARO };
    expect(framesAreDuplicate(base, hashDe(frame(120, [cursor])))).toBe(false);
  });

  it("frame IDÊNTICO continua sendo duplicata — é para isso que a folga zero serve", () => {
    /*
     * A captura congelada entrega o MESMO bitmap: o hash lê `getImageData` cru
     * do canvas, sem JPEG no meio, então células idênticas dão distância 0.
     * Com folga zero isso ainda é duplicata, que é o caso do §3.
     */
    expect(cellDistance(base, hashDe(frame(120)))).toBe(0);
    expect(framesAreDuplicate(base, hashDe(frame(120)))).toBe(true);
  });

  it("uma mudança de DUAS células já é frame novo — a medida da sessão real", () => {
    /*
     * §45, prints 031 (10:11) e 032 (10:12) da sessão de 20/08/2026: o candle
     * avançou 185 pontos de máxima e moveu exatamente DUAS células da grade,
     * com deltas 18 e 11. Com o limiar antigo de 3 o frame virava duplicata e
     * a extensão se perdia. Esta é a regressão que tranca aquele caso.
     */
    const duasCelulas = "0000".padEnd(64, "8");
    const iguais = "0000".padEnd(64, "8");
    expect(cellDistance(iguais, duasCelulas)).toBe(0);
    // Duas células adiante do limiar de DELTA_CELULA (6): 0x00 -> 0x12 = 18.
    const mudouDuas = "1211" + duasCelulas.slice(4);
    expect(cellDistance(duasCelulas, mudouDuas)).toBe(2);
    expect(framesAreDuplicate(duasCelulas, mudouDuas)).toBe(false);
  });

  it("movimento real pequeno — meio candle a mais — já é frame novo", () => {
    const meioCandle: Barra = { ...CANDLE_NOVO, altura: 130 };
    expect(framesAreDuplicate(base, hashDe(frame(120, [meioCandle])))).toBe(false);
  });

  it("o gráfico rolando um candle inteiro é, obviamente, frame novo", () => {
    // Todos os candles deslocados: é o que acontece na virada do minuto.
    const rolado = new Uint8ClampedArray(frame(120));
    expect(framesAreDuplicate(base, hashDe(frame(121)))).toBe(false);
    expect(rolado.length).toBe(LARGURA * ALTURA * 4);
  });

  it("os limites são explícitos e coerentes entre si", () => {
    // Zero desde a sessao real de 20/08: a folga que absorvia cursor tambem
    // absorvia candle. Ver a justificativa em frameHash.ts.
    expect(DUPLICATE_MAX_DISTANCE).toBe(0);
    expect(DUPLICATE_RETRY_LIMIT).toBe(3);
  });
});
