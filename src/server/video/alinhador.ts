/**
 * ALINHADOR DE REPLAY — entre dois frames consecutivos, quantos candles entraram?
 *
 * POR QUE O COSTURADOR DO AO VIVO NÃO SERVE AQUI — medido, não suposto. O
 * `CandleStitcher` casa sequências por ÍNDICE e pressupõe que o mesmo candle
 * vira o mesmo elemento do array em frames seguidos. Isso é verdade com o
 * gráfico parado (ao vivo) e falso quando ele ROLA. Na gravação acelerada de
 * março (candles de 1–2 px, passo ~7 px, muitos dojis), o extrator — que exige
 * 4 pixels coloridos por coluna — descarta ~30% dos candles, e QUAIS são
 * descartados muda a cada frame com o anti-aliasing da rolagem. Medido: 69
 * descontinuidades em 180 frames; no melhor alinhamento, metade dos candles
 * bate em ≤2 px e 40% diverge >16 px — duas populações, não ruído.
 *
 * O QUE ESTE MÓDULO FAZ, e só isso: estima o DESLOCAMENTO HORIZONTAL (px)
 * entre os dois frames — procurando o Δ que maximiza a fração de candles que
 * casam por posição E por forma (após ajuste afim vertical) — e converte em
 * candles novos pelo passo da grade. Ele não decide nada e não reconstrói
 * série: o núcleo T4 vê a janela do frame, como o operador vê a tela.
 *
 * A concordância é reportada. Abaixo do mínimo é DESCONTINUIDADE (salto de
 * período), e o chamador trata como tal. O número de candles novos é uma
 * ESTIMATIVA declarada como tal — ela alimenta o relógio e o acompanhamento de
 * desfecho, e o relatório diz que é estimativa.
 */

import type { ExtractedCandleWithX } from "@/lib/capture/frameProcessor";

export interface ResultadoDoAlinhamento {
  /** Candles novos estimados desde o frame anterior. 0 no primeiro frame. */
  novos: number;
  /** Deslocamento horizontal estimado, em pixels. */
  deltaPx: number;
  /** true quando nenhum deslocamento explica o frame (salto de período). */
  descontinuidade: boolean;
  /** Fração de candles pareados que casaram dentro da tolerância. */
  concordancia: number;
  /** Resíduo médio (px) após o ajuste afim, nos pareados. */
  residuoPx: number;
  /** Passo da grade em pixels neste frame. */
  passoPx: number | null;
  /** Escala vertical entre frames (autoescala do Profit). 1 = sem mudança. */
  escala: number;
}

export interface OpcoesDoAlinhador {
  /** Máximo deslocamento considerado, em pixels. */
  maxDeltaPx?: number;
  /** Passo da busca, em pixels. */
  passoBuscaPx?: number;
  /** Tolerância por campo OHLC após o ajuste afim, em pixels. */
  toleranciaPx?: number;
  /** Concordância mínima para aceitar o alinhamento. */
  concordanciaMinima?: number;
  /** Mínimo de candles pareados para o alinhamento valer. */
  minimoPareados?: number;
}

type C = ExtractedCandleWithX;

function mediana(v: number[]): number | null {
  if (v.length === 0) return null;
  const o = [...v].sort((a, b) => a - b);
  return o[Math.floor(o.length / 2)]!;
}

/** Passo da grade: mediana das distâncias entre vizinhos — robusta a buracos. */
export function passoDaGrade(candles: C[]): number | null {
  if (candles.length < 3) return null;
  const difs: number[] = [];
  for (let i = 1; i < candles.length; i++) difs.push(candles[i]!.x - candles[i - 1]!.x);
  const m = mediana(difs);
  return m !== null && m > 1 ? m : null;
}

export class AlinhadorDeReplay {
  private anterior: C[] | null = null;
  private passoAnterior: number | null = null;
  private readonly maxDelta: number;
  private readonly passoBusca: number;
  private readonly tol: number;
  private readonly concMin: number;
  private readonly minPareados: number;

  constructor(opcoes: OpcoesDoAlinhador = {}) {
    this.maxDelta = opcoes.maxDeltaPx ?? 320;
    this.passoBusca = opcoes.passoBuscaPx ?? 0.5;
    this.tol = opcoes.toleranciaPx ?? 4;
    this.concMin = opcoes.concordanciaMinima ?? 0.3;
    this.minPareados = opcoes.minimoPareados ?? 30;
  }

  reset(): void {
    this.anterior = null;
    this.passoAnterior = null;
  }

  alinhar(atual: C[]): ResultadoDoAlinhamento {
    const passo = passoDaGrade(atual);
    const vazio: ResultadoDoAlinhamento = {
      novos: 0,
      deltaPx: 0,
      descontinuidade: false,
      concordancia: 0,
      residuoPx: Number.POSITIVE_INFINITY,
      passoPx: passo,
      escala: 1,
    };
    if (passo === null) {
      const tinha = this.anterior !== null;
      this.anterior = null;
      return { ...vazio, descontinuidade: tinha };
    }
    const prev = this.anterior;
    const passoPrev = this.passoAnterior;
    this.anterior = atual;
    this.passoAnterior = passo;
    if (prev === null || passoPrev === null) return vazio;
    if (Math.abs(passo - passoPrev) / passoPrev > 0.25) return { ...vazio, descontinuidade: true };

    const raioX = Math.max(2, passo * 0.38);
    let melhor = { delta: 0, conc: -1, res: Number.POSITIVE_INFINITY, a: 1, pares: 0 };

    for (let delta = 0; delta <= this.maxDelta; delta += this.passoBusca) {
      // Pareia cada candle anterior com o atual mais próximo de x − Δ.
      const pares: Array<[C, C]> = [];
      let j = 0;
      for (const p of prev) {
        const alvo = p.x - delta;
        while (j < atual.length - 1 && atual[j + 1]!.x <= alvo) j++;
        let q = atual[j]!;
        if (j + 1 < atual.length && Math.abs(atual[j + 1]!.x - alvo) < Math.abs(q.x - alvo)) {
          q = atual[j + 1]!;
        }
        if (Math.abs(q.x - alvo) <= raioX) pares.push([p, q]);
      }
      if (pares.length < this.minPareados) continue;

      // Ajuste afim vertical pelos fechamentos (autoescala do Profit).
      const n = pares.length;
      let sx = 0;
      let sy = 0;
      for (const [p, q] of pares) {
        sx += p.c;
        sy += q.c;
      }
      const mx = sx / n;
      const my = sy / n;
      let cov = 0;
      let vx = 0;
      for (const [p, q] of pares) {
        cov += (p.c - mx) * (q.c - my);
        vx += (p.c - mx) ** 2;
      }
      const a = vx > 1e-9 ? cov / vx : 1;
      if (!Number.isFinite(a) || a < 0.5 || a > 2) continue;
      const b = my - a * mx;

      let ok = 0;
      let soma = 0;
      for (const [p, q] of pares) {
        const d = Math.max(
          Math.abs(a * p.o + b - q.o),
          Math.abs(a * p.h + b - q.h),
          Math.abs(a * p.l + b - q.l),
          Math.abs(a * p.c + b - q.c),
        );
        soma += d;
        if (d <= this.tol) ok++;
      }
      const conc = ok / n;
      const res = soma / n;
      if (conc > melhor.conc || (conc === melhor.conc && res < melhor.res)) {
        melhor = { delta, conc, res, a, pares: n };
      }
    }

    if (melhor.conc < this.concMin) {
      return {
        ...vazio,
        descontinuidade: true,
        concordancia: Math.max(0, melhor.conc),
        residuoPx: melhor.res,
        escala: melhor.a,
      };
    }
    return {
      novos: Math.max(0, Math.round(melhor.delta / passo)),
      deltaPx: melhor.delta,
      descontinuidade: false,
      concordancia: melhor.conc,
      residuoPx: melhor.res,
      passoPx: passo,
      escala: melhor.a,
    };
  }
}
