/**
 * RECONSTRUTOR DETERMINÍSTICO — do pixel ao candle, sem modelo de visão.
 *
 * TRÊS LEITURAS POR FRAME, todas verificáveis:
 *   1. CONTADOR DE CANDLES (caixa laranja na barra do gráfico): é o RELÓGIO.
 *      candle #1 = 09:00; candle #N = 09:00 + (N−1) min. Nos prints de março
 *      o contador 562 casa exato com 18:21 — 562 minutos após as 09:00.
 *   2. CAIXA DO PREÇO ATUAL (branco sobre escuro no eixo): junto com o y dela,
 *      é o par (y, preço) que calibra a régua por REGRESSÃO — nenhuma leitura
 *      de rótulo do eixo é necessária.
 *   3. COLUNAS DE CANDLE (corpo verde/vermelho + pavio cinza): OHLC em pixels,
 *      convertido a preço pela régua da regressão e ANCORADO no contador —
 *      o slot mais à direita é o candle corrente (número do contador).
 *
 * O QUE ESTE ARQUIVO NÃO FAZ: técnica. Ele produz série de candles; quem
 * decide é o mesmo motor de sempre.
 */

import type { PixelFrame } from "@/lib/capture/frameProcessor";
import { detectarLinhasDoEixo, detectarCaixaDePreco } from "./calibration";
import { lerNumero, type Templates } from "./ocrDigitos";

/* ------------------------------------------------------------------------ *
 * CONTADOR
 * ------------------------------------------------------------------------ */

/** Cor medida da caixa do contador no material real: laranja (216,88,40). */
function ehLaranja(r: number, g: number, b: number): boolean {
  return r > 170 && r < 255 && g > 55 && g < 140 && b < 90 && r - g > 70;
}

/**
 * Localiza a caixa laranja do contador na faixa do título do gráfico
 * (y 60..100) e lê o número branco dentro dela.
 */
export function lerContador(frame: PixelFrame, templates: Templates): number | null {
  const { data, width: W } = frame;
  const yIni = 60;
  const yFim = Math.min(frame.height, 105);
  let x0 = -1;
  let x1 = -1;
  let y0 = -1;
  let y1 = -1;
  for (let y = yIni; y < yFim; y++) {
    let corrida = 0;
    for (let x = 200; x < Math.min(W, 1100); x++) {
      const i = (y * W + x) * 4;
      if (ehLaranja(data[i]!, data[i + 1]!, data[i + 2]!)) {
        corrida++;
        if (corrida >= 12) {
          if (y0 < 0) y0 = y;
          y1 = y;
          const ini = x - corrida + 1;
          if (x0 < 0 || ini < x0) x0 = ini;
          if (x > x1) x1 = x;
        }
      } else corrida = 0;
    }
  }
  if (x0 < 0 || y1 - y0 < 6) return null;
  const n = lerNumero(
    frame,
    { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 },
    templates,
  );
  if (n === null || n < 1 || n > 700) return null;
  return n;
}

/* ------------------------------------------------------------------------ *
 * CAIXA DE PREÇO (par y→preço para a régua)
 * ------------------------------------------------------------------------ */

export interface LeituraDaCaixa {
  preco: number;
  y: number;
}

export function lerCaixaDePreco(frame: PixelFrame, templates: Templates): LeituraDaCaixa | null {
  const geo = detectarLinhasDoEixo(frame);
  if (geo.colunas === null) return null;
  const y = detectarCaixaDePreco(frame);
  if (y === null) return null;
  const [x0, x1] = geo.colunas;
  const preco = lerNumero(
    frame,
    { left: x0 - 2, top: Math.round(y) - 9, width: x1 - x0 + 6, height: 19 },
    templates,
  );
  if (preco === null) return null;
  return { preco, y };
}

/* ------------------------------------------------------------------------ *
 * RÉGUA POR REGRESSÃO — pares (y, preço) da caixa dentro de uma época
 * ------------------------------------------------------------------------ */

export interface ParDeRegua {
  segundoNoVideo: number;
  y: number;
  preco: number;
}

export interface Regua {
  /** preco = a·y + b */
  a: number;
  b: number;
  pares: number;
  /** Maior resíduo absoluto (pontos) dos pares usados. */
  residuoMax: number;
}

/**
 * Ajusta a régua local por mediana de inclinações par-a-par (robusto a um
 * outlier de OCR) + mediana dos interceptos. Exige movimento: pares com
 * |Δy| < 6 px não informam inclinação.
 */
export function ajustarRegua(pares: ParDeRegua[]): Regua | null {
  if (pares.length < 4) return null;
  const incl: number[] = [];
  for (let i = 0; i < pares.length; i++) {
    for (let j = i + 1; j < pares.length; j++) {
      const dy = pares[i]!.y - pares[j]!.y;
      if (Math.abs(dy) < 6) continue;
      incl.push((pares[i]!.preco - pares[j]!.preco) / dy);
    }
  }
  if (incl.length < 3) return null;
  incl.sort((p, q) => p - q);
  const a = incl[Math.floor(incl.length / 2)]!;
  if (!Number.isFinite(a) || a >= 0) return null; // y cresce para baixo ⇒ a < 0
  const bs = pares.map((p) => p.preco - a * p.y).sort((p, q) => p - q);
  const b = bs[Math.floor(bs.length / 2)]!;
  let residuoMax = 0;
  for (const p of pares) {
    const r = Math.abs(a * p.y + b - p.preco);
    if (r > residuoMax) residuoMax = r;
  }
  return { a, b, pares: pares.length, residuoMax };
}

/* ------------------------------------------------------------------------ *
 * CANDLES POR PIXEL
 * ------------------------------------------------------------------------ */

/** Cores medidas no material: corpo de alta (16..48, 150..255, 0..90),
 *  corpo de baixa (190..255, 0..90, 0..90). */
function corDeCorpo(r: number, g: number, b: number): "ALTA" | "BAIXA" | null {
  if (g > 140 && r < 110 && b < 110 && g - r > 60) return "ALTA";
  if (r > 170 && g < 110 && b < 110 && r - g > 80) return "BAIXA";
  return null;
}

/** Pavio/borda: cinza-escuro pouco saturado. Fundo do gráfico é claro. */
function ehPavio(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max < 150 && max - min < 35;
}

export interface CandleCru {
  /** Número do candle no dia (1 = 09:00), ancorado no contador. */
  indice: number;
  lado: "ALTA" | "BAIXA";
  yTopoCorpo: number;
  yFundoCorpo: number;
  yTopoPavio: number;
  yFundoPavio: number;
  xCentro: number;
}

export interface ParseCru {
  candles: CandleCru[];
  contador: number;
  espacamentoPx: number;
}

/**
 * FASE 1 — SÓ PIXELS. Roda no streaming (frame na mão, régua ainda não): a
 * conversão para preço acontece depois, quando a régua do dia inteiro existe.
 * Separar as fases evita segurar frames inteiros em memória e deixa a régua
 * usar pares do dia todo (passado E futuro do frame) sem look-ahead de
 * TÉCNICA — régua é medição de escala, não decisão de trade.
 */
export function parsearColunas(frame: PixelFrame, contador: number): ParseCru | null {
  const { data, width: W } = frame;
  const geo = detectarLinhasDoEixo(frame);
  if (geo.colunas === null) return null;
  const xFim = geo.colunas[0] - 4;
  const xIni = 8;
  const yIni = 96;
  const yFim = frame.height - 50;

  interface Col {
    topo: number;
    fundo: number;
    lado: "ALTA" | "BAIXA";
    n: number;
  }
  const cols: Array<Col | null> = [];
  for (let x = xIni; x < xFim; x++) {
    let topo = -1;
    let fundo = -1;
    let nAlta = 0;
    let nBaixa = 0;
    for (let y = yIni; y < yFim; y++) {
      const i = (y * W + x) * 4;
      const lado = corDeCorpo(data[i]!, data[i + 1]!, data[i + 2]!);
      if (lado !== null) {
        if (topo < 0) topo = y;
        fundo = y;
        if (lado === "ALTA") nAlta++;
        else nBaixa++;
      }
    }
    cols.push(
      topo < 0
        ? null
        : { topo, fundo, lado: nAlta >= nBaixa ? "ALTA" : "BAIXA", n: nAlta + nBaixa },
    );
  }

  interface Corpo {
    x0: number;
    x1: number;
    topo: number;
    fundo: number;
    lado: "ALTA" | "BAIXA";
  }
  const corpos: Corpo[] = [];
  let ini = -1;
  for (let x = 0; x <= cols.length; x++) {
    const tem = x < cols.length && cols[x] !== null;
    if (tem && ini < 0) ini = x;
    else if (!tem && ini >= 0) {
      const fatia = cols.slice(ini, x) as Col[];
      const topo = Math.min(...fatia.map((c) => c.topo));
      const fundo = Math.max(...fatia.map((c) => c.fundo));
      let alta = 0;
      let baixa = 0;
      for (const c of fatia) {
        if (c.lado === "ALTA") alta += c.n;
        else baixa += c.n;
      }
      corpos.push({
        x0: xIni + ini,
        x1: xIni + x - 1,
        topo,
        fundo,
        lado: alta >= baixa ? "ALTA" : "BAIXA",
      });
      ini = -1;
    }
  }
  if (corpos.length < 20) return null;

  const centros = corpos.map((c) => (c.x0 + c.x1) / 2);
  const deltas: number[] = [];
  for (let i = 1; i < centros.length; i++) deltas.push(centros[i]! - centros[i - 1]!);
  deltas.sort((a, b) => a - b);
  const passo = deltas[Math.floor(deltas.length / 2)]!;
  if (!Number.isFinite(passo) || passo < 2 || passo > 40) return null;

  const xUltimo = centros[centros.length - 1]!;
  const slotDe = (x: number) => contador - Math.round((xUltimo - x) / passo);

  const candles: CandleCru[] = [];
  for (const corpo of corpos) {
    const indice = slotDe((corpo.x0 + corpo.x1) / 2);
    if (indice < 1 || indice > contador) continue;
    const xc = Math.round((corpo.x0 + corpo.x1) / 2);
    let yTopoPavio = corpo.topo;
    let yFundoPavio = corpo.fundo;
    for (let y = Math.max(yIni, corpo.topo - 140); y < corpo.topo; y++) {
      const i = (y * W + xc) * 4;
      if (ehPavio(data[i]!, data[i + 1]!, data[i + 2]!)) yTopoPavio = Math.min(yTopoPavio, y);
    }
    for (let y = corpo.fundo + 1; y < Math.min(yFim, corpo.fundo + 140); y++) {
      const i = (y * W + xc) * 4;
      if (ehPavio(data[i]!, data[i + 1]!, data[i + 2]!)) yFundoPavio = Math.max(yFundoPavio, y);
    }
    candles.push({
      indice,
      lado: corpo.lado,
      yTopoCorpo: corpo.topo,
      yFundoCorpo: corpo.fundo,
      yTopoPavio,
      yFundoPavio,
      xCentro: xc,
    });
  }
  return { candles, contador, espacamentoPx: passo };
}

export interface CandleLido {
  indice: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/** FASE 2 — converte o parse cru em OHLC com a régua da época. */
export function converterParaPrecos(cru: CandleCru[], regua: Regua): CandleLido[] {
  const precoDe = (y: number) => regua.a * y + regua.b;
  return cru.map((k) => {
    const pTopo = precoDe(k.yTopoCorpo);
    const pFundo = precoDe(k.yFundoCorpo);
    const o = k.lado === "ALTA" ? pFundo : pTopo;
    const c = k.lado === "ALTA" ? pTopo : pFundo;
    const h = Math.max(precoDe(k.yTopoPavio), o, c);
    const l = Math.min(precoDe(k.yFundoPavio), o, c);
    return {
      indice: k.indice,
      o: Math.round(o),
      h: Math.round(h),
      l: Math.round(l),
      c: Math.round(c),
    };
  });
}
