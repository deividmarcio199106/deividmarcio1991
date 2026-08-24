/**
 * OCR DETERMINÍSTICO DE DÍGITOS — templates aprendidos do próprio material.
 *
 * POR QUE EXISTE: a reconstrução dos meses novos não pode depender de modelo
 * de visão (GPU morta, ponte é operação manual). Os únicos textos de que o
 * pipeline precisa — caixa do preço atual e contador de candles — usam a fonte
 * do Profit, claro-sobre-escuro, invariável no dataset. Fonte fixa + verdade
 * conhecida (as 9.165 leituras de março gravadas na varredura) = OCR de
 * template treinável e VERIFICÁVEL, sem rede neural e sem rede.
 *
 * COMO: binariza o recorte pela polaridade declarada, segmenta glifos por
 * colunas vazias, normaliza cada glifo numa grade fixa e casa contra os
 * templates por distância de Hamming. Score ruim em QUALQUER glifo derruba a
 * leitura inteira — dígito inventado é pior que dígito ausente.
 */

import type { PixelFrame } from "@/lib/capture/frameProcessor";

/** Grade de normalização do glifo. */
export const GLIFO_W = 10;
export const GLIFO_H = 14;

export interface Glifo {
  /** Bitmap GLIFO_W×GLIFO_H, linha a linha, 0/1. */
  bits: Uint8Array;
  /** Largura original em px — desempata 1 vs ponto. */
  larguraPx: number;
}

export interface Templates {
  /** char → bitmaps de referência (média binarizada por cluster). */
  chars: Record<string, number[][]>;
}

export interface Regiao {
  left: number;
  top: number;
  width: number;
  height: number;
}

const luma = (d: Uint8Array | Uint8ClampedArray, i: number) =>
  0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;

/**
 * Binariza um recorte claro-sobre-escuro em DUAS etapas, porque o recorte
 * bruto mistura mundos: a caixa escura do texto vem cercada pelo fundo CLARO
 * do eixo, e um limiar global veria o fundo claro como "tinta".
 *
 *   1. Acha a CAIXA ESCURA dentro do recorte: linhas e colunas onde a maioria
 *      dos pixels é escura (< 140). É ali que o texto mora.
 *   2. DENTRO dela, tinta = pixel claramente claro (> 170) — os dígitos
 *      brancos sobre o fundo escuro/laranja.
 *
 * Fora da caixa escura nada é tinta, por definição.
 */
export function binarizar(
  frame: PixelFrame,
  regiao: Regiao,
): { grade: Uint8Array; w: number; h: number } {
  const { data, width: W } = frame;
  const w = regiao.width;
  const h = regiao.height;
  const lums = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      lums[y * w + x] = luma(data, ((regiao.top + y) * W + regiao.left + x) * 4);
    }
  }
  // Etapa 1 — banda escura por LINHA…
  const linhaEscura: boolean[] = [];
  for (let y = 0; y < h; y++) {
    let escuros = 0;
    for (let x = 0; x < w; x++) if (lums[y * w + x]! < 140) escuros++;
    linhaEscura.push(escuros >= Math.max(4, Math.floor(w * 0.35)));
  }
  let by0 = -1;
  let by1 = -1;
  for (let y = 0; y < h; y++) {
    if (linhaEscura[y]) {
      if (by0 < 0) by0 = y;
      by1 = y;
    }
  }
  if (by0 < 0) return { grade: new Uint8Array(w * h), w, h };
  // …e por COLUNA, dentro da banda de linhas.
  const colEscura: boolean[] = [];
  for (let x = 0; x < w; x++) {
    let escuros = 0;
    for (let y = by0; y <= by1; y++) if (lums[y * w + x]! < 140) escuros++;
    colEscura.push(escuros >= Math.max(2, Math.floor((by1 - by0 + 1) * 0.5)));
  }
  const grade = new Uint8Array(w * h);
  for (let y = by0; y <= by1; y++) {
    for (let x = 0; x < w; x++) {
      // Coluna clara = margem fora da caixa; nada ali é tinta. A checagem é
      // por coluna-com-fundo-escuro: colunas de dígito têm fundo escuro em
      // volta da tinta, então continuam "escuras" na maioria das linhas.
      if (!colEscura[x] && !(x > 0 && colEscura[x - 1]) && !(x + 1 < w && colEscura[x + 1])) {
        continue;
      }
      if (lums[y * w + x]! > 170) grade[y * w + x] = 1;
    }
  }
  return { grade, w, h };
}

/** Segmenta glifos por colunas sem tinta. Devolve caixas [x0,x1] com tinta. */
export function segmentar(grade: Uint8Array, w: number, h: number): Array<[number, number]> {
  const temTinta: boolean[] = [];
  for (let x = 0; x < w; x++) {
    let n = 0;
    for (let y = 0; y < h; y++) if (grade[y * w + x] === 1) n++;
    temTinta.push(n > 0);
  }
  const caixas: Array<[number, number]> = [];
  let ini = -1;
  for (let x = 0; x < w; x++) {
    if (temTinta[x] && ini < 0) ini = x;
    else if (!temTinta[x] && ini >= 0) {
      caixas.push([ini, x - 1]);
      ini = -1;
    }
  }
  if (ini >= 0) caixas.push([ini, w - 1]);
  return caixas;
}

/**
 * REFINA as caixas cruas da segmentação — os dois defeitos vistos no material:
 *
 *   1. BORDA DA CAIXA: a moldura vertical do box entra como "glifo" de 1-2 px
 *      de largura com tinta em quase toda a altura do recorte. Dígito nenhum
 *      ocupa a altura inteira — altura de tinta > 11 linhas = artefato, fora.
 *   2. DÍGITOS ENCOSTADOS: dois dígitos que se tocam por 1 px viram uma caixa
 *      de largura ~12-13. Largura ≥ 9 = par colado — divide na coluna de MENOR
 *      tinta do miolo, recursivamente.
 */
export function refinarCaixas(
  grade: Uint8Array,
  w: number,
  h: number,
  caixas: Array<[number, number]>,
): Array<[number, number]> {
  const alturaDeTinta = (x0: number, x1: number): number => {
    let yMin = h;
    let yMax = -1;
    for (let y = 0; y < h; y++) {
      for (let x = x0; x <= x1; x++) {
        if (grade[y * w + x] === 1) {
          if (y < yMin) yMin = y;
          if (y > yMax) yMax = y;
          break;
        }
      }
    }
    return yMax < yMin ? 0 : yMax - yMin + 1;
  };
  const dividir = (x0: number, x1: number, saida: Array<[number, number]>): void => {
    const largura = x1 - x0 + 1;
    if (largura < 9) {
      saida.push([x0, x1]);
      return;
    }
    let melhorX = -1;
    let menorTinta = Infinity;
    for (let x = x0 + 3; x <= x1 - 3; x++) {
      let tinta = 0;
      for (let y = 0; y < h; y++) if (grade[y * w + x] === 1) tinta++;
      if (tinta < menorTinta) {
        menorTinta = tinta;
        melhorX = x;
      }
    }
    if (melhorX < 0) {
      saida.push([x0, x1]);
      return;
    }
    dividir(x0, melhorX - 1, saida);
    dividir(melhorX + 1, x1, saida);
  };
  const refinadas: Array<[number, number]> = [];
  for (const [x0, x1] of caixas) {
    if (alturaDeTinta(x0, x1) > 11) continue; // moldura, não glifo
    dividir(x0, x1, refinadas);
  }
  return refinadas;
}

/** Normaliza o glifo [x0..x1] para a grade fixa por amostragem do vizinho. */
export function normalizar(grade: Uint8Array, w: number, h: number, x0: number, x1: number): Glifo {
  // Recorta verticalmente à tinta real do glifo.
  let y0 = h;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = x0; x <= x1; x++) {
      if (grade[y * w + x] === 1) {
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (y1 < y0) {
    return { bits: new Uint8Array(GLIFO_W * GLIFO_H), larguraPx: x1 - x0 + 1 };
  }
  const bits = new Uint8Array(GLIFO_W * GLIFO_H);
  const gw = x1 - x0 + 1;
  const gh = y1 - y0 + 1;
  for (let gy = 0; gy < GLIFO_H; gy++) {
    for (let gx = 0; gx < GLIFO_W; gx++) {
      const sx = x0 + Math.min(gw - 1, Math.round((gx * (gw - 1)) / (GLIFO_W - 1)));
      const sy = y0 + Math.min(gh - 1, Math.round((gy * (gh - 1)) / (GLIFO_H - 1)));
      bits[gy * GLIFO_W + gx] = grade[sy * w + sx]!;
    }
  }
  return { bits, larguraPx: gw };
}

function hamming(a: Uint8Array | number[], b: Uint8Array | number[]): number {
  let d = 0;
  for (let i = 0; i < GLIFO_W * GLIFO_H; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) d++;
  return d;
}

export interface LeituraOcr {
  texto: string;
  /** Pior score entre os glifos (0 = perfeito). */
  piorScore: number;
  glifos: number;
}

/** Score máximo tolerado por glifo — acima disso a leitura INTEIRA cai. */
export const SCORE_MAXIMO = 24;

/**
 * Lê um recorte claro-sobre-escuro contra os templates.
 * Devolve null se não houver glifos ou se QUALQUER glifo casar mal.
 */
export function lerTexto(
  frame: PixelFrame,
  regiao: Regiao,
  templates: Templates,
): LeituraOcr | null {
  const { grade, w, h } = binarizar(frame, regiao);
  const caixas = refinarCaixas(grade, w, h, segmentar(grade, w, h));
  if (caixas.length === 0) return null;
  let texto = "";
  let pior = 0;
  for (const [x0, x1] of caixas) {
    const glifo = normalizar(grade, w, h, x0, x1);
    // Glifo estreito demais é o separador de milhar (ponto): 1-3 px de largura
    // e tinta só na parte baixa.
    let melhorChar = "";
    let melhorScore = Infinity;
    for (const [ch, refs] of Object.entries(templates.chars)) {
      for (const ref of refs) {
        const d = hamming(glifo.bits, ref);
        if (d < melhorScore) {
          melhorScore = d;
          melhorChar = ch;
        }
      }
    }
    if (melhorChar === "" || melhorScore > SCORE_MAXIMO) return null;
    texto += melhorChar;
    if (melhorScore > pior) pior = melhorScore;
  }
  return { texto, piorScore: pior, glifos: caixas.length };
}

/** Lê um número no formato do Profit ("172.615" ⇒ 172615). */
export function lerNumero(frame: PixelFrame, regiao: Regiao, templates: Templates): number | null {
  const r = lerTexto(frame, regiao, templates);
  if (r === null) return null;
  const limpo = r.texto.replace(/\./g, "");
  if (!/^\d+$/.test(limpo)) return null;
  return Number(limpo);
}

/**
 * Variante para quem JÁ TEM a grade binarizada e as caixas — o passe de
 * validação guarda as grades e casa depois, sem rebinarizar.
 */
export function lerTextoDeGrade(
  grade: Uint8Array,
  w: number,
  h: number,
  caixas: Array<[number, number]>,
  templates: Templates,
): LeituraOcr | null {
  if (caixas.length === 0) return null;
  let texto = "";
  let pior = 0;
  for (const [x0, x1] of caixas) {
    const glifo = normalizar(grade, w, h, x0, x1);
    let melhorChar = "";
    let melhorScore = Infinity;
    for (const [ch, refs] of Object.entries(templates.chars)) {
      for (const ref of refs) {
        let d = 0;
        for (let i = 0; i < GLIFO_W * GLIFO_H; i++) if ((glifo.bits[i] ?? 0) !== (ref[i] ?? 0)) d++;
        if (d < melhorScore) {
          melhorScore = d;
          melhorChar = ch;
        }
      }
    }
    if (melhorChar === "" || melhorScore > SCORE_MAXIMO) return null;
    texto += melhorChar;
    if (melhorScore > pior) pior = melhorScore;
  }
  return { texto, piorScore: pior, glifos: caixas.length };
}
