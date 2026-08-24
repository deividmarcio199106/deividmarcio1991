/**
 * O QUE É TINTA E O QUE É FUNDO — uma fonte só, para todo mundo que olha pixel.
 *
 * O DEFEITO QUE ISTO ENCERRA, MEDIDO NA SESSÃO REAL DE 20/08/2026.
 *
 * Três módulos independentes tinham a MESMA rotina copiada — histograma de 32
 * baldes, balde mais populoso vira "o fundo", desvio maior que 26 vira "tinta".
 * A rotina assume que o fundo é UM tom. O tema claro do Profit não é: ele tem
 * gradiente. Medido no print 001, em pontos VAZIOS do gráfico:
 *
 *     (900,150) luma 252      (500,300) luma 241
 *     (300,560) luma 211      (150,595) luma 205
 *
 * São 47 níveis de variação contra um limiar de 26. O resultado é que o terço
 * inferior do gráfico VAZIO era classificado como tinta, e as consequências
 * foram medidas nas 83 capturas:
 *
 *   • `detectRoi` devolveu confiança 35 (inutilizável) em 83 de 83;
 *   • `detectClipping` acusou "cortado no topo E no fundo" em 83 de 83, em
 *     gráficos com margem sobrando dos dois lados;
 *   • o recorte automático perdeu a referência da área do gráfico.
 *
 * A CORREÇÃO: o fundo passa a ser estimado POR LINHA, pela mediana da própria
 * linha. O gradiente do Profit é majoritariamente vertical, então a mediana de
 * cada linha o acompanha. Medido na mesma faixa vazia, em 20 prints: com fundo
 * global, 46% de tinta; com fundo por linha, 4%.
 *
 * A GUARDA QUE FAZ ISSO FUNCIONAR. Uma linha de CROMO (barra de ferramentas,
 * eixo de tempo, barra de tarefas) é majoritariamente não-fundo — a mediana
 * dela É a cor do cromo, e sem guarda o cromo deixaria de contar como tinta,
 * invertendo o problema. Quando a mediana da linha se afasta demais do tom
 * global, a linha é tratada como cromo e classificada pelo tom global.
 *
 * Medido com a guarda, em 20 prints (cobertura máxima de tinta por zona):
 *     barra/abas ........ 100%      gráfico vazio ....  4%
 *     eixo/rodapé ....... 100%      gráfico com candle 7% a 77%
 *
 * É essa separação que torna "encostou na borda" uma pergunta com resposta.
 */

/**
 * Distância do fundo que já conta como tinta.
 *
 * Continua sendo o mesmo número de antes — o que estava errado nunca foi o
 * limiar, e sim o fundo contra o qual ele era medido. Trocar o limiar teria
 * sido a correção fácil e errada: afrouxá-lo para engolir o gradiente engoliria
 * também um candle fino.
 */
export const INK_THRESHOLD = 26;

/** Quantos baldes o histograma usa para achar o tom dominante. */
const BALDES = 32;

export interface BackgroundModel {
  /** Tom dominante da imagem inteira. Usado como referência e nas linhas de cromo. */
  global: number;
  /** Tom de fundo de cada linha. É contra ele que a tinta é medida. */
  byRow: Float64Array;
  /** Quantas linhas foram classificadas como cromo (mediana longe do global). */
  chromeRows: number;
}

/** Tom dominante por histograma — a estimativa GLOBAL, mantida como referência. */
export function dominantTone(luma: ArrayLike<number>, count: number): number {
  const baldes = new Array<number>(BALDES).fill(0);
  const largura = 256 / BALDES;
  for (let i = 0; i < count; i += 1) {
    const g = Number(luma[i]);
    baldes[Math.min(BALDES - 1, Math.max(0, Math.floor(g / largura)))]! += 1;
  }
  let maior = 0;
  for (let i = 1; i < BALDES; i += 1) if (baldes[i]! > baldes[maior]!) maior = i;
  return maior * largura + largura / 2;
}

/** Mediana de um vetor pequeno. Ordena uma cópia — o original não é tocado. */
function mediana(valores: Float64Array): number {
  const copia = Float64Array.from(valores);
  copia.sort();
  return copia[copia.length >> 1]!;
}

/**
 * Estima o fundo linha a linha.
 *
 * Grade vazia devolve um modelo vazio em vez de lançar: quem não tem pixel não
 * tem fundo, e o chamador já precisa lidar com esse caso de qualquer forma.
 */
export function estimateBackground(
  luma: ArrayLike<number>,
  width: number,
  height: number,
): BackgroundModel {
  if (width <= 0 || height <= 0 || luma.length < width * height) {
    return { global: 0, byRow: new Float64Array(0), chromeRows: 0 };
  }
  const global = dominantTone(luma, width * height);
  const byRow = new Float64Array(height);
  const linha = new Float64Array(width);
  let chromeRows = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) linha[x] = Number(luma[y * width + x]);
    const med = mediana(linha);
    const ehCromo = Math.abs(med - global) > INK_THRESHOLD;
    if (ehCromo) chromeRows += 1;
    byRow[y] = ehCromo ? global : med;
  }
  return { global, byRow, chromeRows };
}

/** Este pixel é tinta, contra o fundo da linha dele? */
export function isInk(value: number, background: number): boolean {
  return Math.abs(value - background) > INK_THRESHOLD;
}

/**
 * Fração de cada LINHA coberta por tinta.
 *
 * É o perfil que separa cromo (faixa cheia colada na borda) de gráfico (tinta
 * esparsa, com buraco entre os candles).
 */
export function rowCoverage(
  luma: ArrayLike<number>,
  width: number,
  height: number,
  model: BackgroundModel,
): Float64Array {
  const cobertura = new Float64Array(height);
  if (width <= 0 || height <= 0 || model.byRow.length !== height) return cobertura;
  for (let y = 0; y < height; y += 1) {
    const fundo = model.byRow[y]!;
    let tinta = 0;
    for (let x = 0; x < width; x += 1) {
      if (isInk(Number(luma[y * width + x]), fundo)) tinta += 1;
    }
    cobertura[y] = tinta / width;
  }
  return cobertura;
}

/** Fração de cada COLUNA coberta por tinta, com o fundo da linha de cada pixel. */
export function columnCoverage(
  luma: ArrayLike<number>,
  width: number,
  height: number,
  model: BackgroundModel,
): Float64Array {
  const cobertura = new Float64Array(width);
  if (width <= 0 || height <= 0 || model.byRow.length !== height) return cobertura;
  for (let y = 0; y < height; y += 1) {
    const fundo = model.byRow[y]!;
    for (let x = 0; x < width; x += 1) {
      if (isInk(Number(luma[y * width + x]), fundo)) cobertura[x] += 1;
    }
  }
  for (let x = 0; x < width; x += 1) cobertura[x] /= height;
  return cobertura;
}
