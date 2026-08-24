/**
 * IDENTIDADE DO FRAME — dez capturas iguais são UMA análise, não dez (§3).
 *
 * O DEFEITO QUE ISTO ENCERRA (sessão de 19/08): os prints 012–016 eram
 * idênticos, 017–018 idênticos, e 031–040 ficaram congelados por dez capturas
 * seguidas. Cada um deles virou uma análise: dez chamadas de GPU descrevendo o
 * mesmo pixel, dez entradas de histórico, dez oportunidades de a máquina de
 * setup "evoluir" sobre um mercado que não se mexeu. Pior: um gráfico congelado
 * (Profit travado, stream pausado pelo navegador, RDP sem foco) é indistinguível
 * de um mercado parado quando a única evidência é a imagem.
 *
 * A PERGUNTA QUE ESTE MÓDULO RESPONDE: este frame é NOVO?
 *
 * COMO: uma grade fina de médias de luma sobre a REGIÃO DO GRÁFICO, e a
 * decisão pela CONTAGEM de células alteradas. É perceptual, e não
 * criptográfico, de propósito — compressão JPEG muda bytes sem mudar a
 * imagem, e um SHA de bytes marcaria como "novo" um frame visualmente
 * idêntico. Ver o bloco da grade abaixo para a medição que derrubou a versão
 * anterior (aHash 8×8) e para os números que fixam os limiares.
 *
 * O QUE NÃO ENTRA NA DECISÃO: relógio. Frame duplicado é duplicado às 10:05 e às
 * 15:40. O tempo entra depois, em ./frameFreshness, que é quem decide se a
 * repetição já virou captura ENVELHECIDA.
 */

/*
 * A GRADE — e por que ela deixou de ser 8×8.
 *
 * A versão anterior era um aHash de 64 bits: reduzia a tela a 8×8 células e
 * comparava cada uma com a média global. A ideia é boa para achar fotos
 * parecidas; para ESTA pergunta ela falha, e a medição é inequívoca.
 *
 * Num frame 1920×1080 com candles de 6 px, o teste `frameHash.test.ts` mede:
 *
 *     um candle NOVO  →  1 bit de 64 muda
 *     tolerância      →  4 bits
 *
 * Ou seja: o frame com a barra nova era classificado como DUPLICADO e
 * descartado. O sistema deixaria de analisar exatamente o print em que a
 * estrutura mudou — o oposto do que o §3 existe para fazer. Uma célula de
 * 240×135 px diluiu uma barra de 6 px até ela sumir na média.
 *
 * O QUE MUDA: a grade fica fina (32×36 = 1.152 células de ~60×30 px) e a
 * decisão deixa de ser "quanto a imagem mudou em média" para ser QUANTAS
 * CÉLULAS mudaram. É esse contador que separa mercado de interface:
 *
 *   • um candle é um traço ALTO — ocupa uma coluna e várias linhas: ~5 células
 *   • um cursor é um ponto — 1 célula
 *   • uma etiqueta/relógio é um retângulo baixo e largo — 2 células
 *
 * Intensidade média não separa esses casos (medido: candle novo move 0,09
 * níveis de cinza e um relógio piscando move 0,11 — o sinal é MENOR que o
 * ruído). Contagem de células separa, porque mede a FORMA do que mudou.
 */
const GRADE_COLUNAS = 32;
const GRADE_LINHAS = 36;

/**
 * Diferença de luma que faz uma célula contar como alterada.
 *
 * Abaixo disto é recompressão, antialiasing e variação de backlight. Um candle
 * de 6 px numa célula de 60 px cobre 10% da largura e move ~18 níveis; um
 * cursor cobre 3% e move ~11. O limiar fica bem abaixo dos dois — quem separa
 * os dois é a CONTAGEM, não a intensidade.
 */
const DELTA_CELULA = 6;

/**
 * Quantas células podem mudar e o frame ainda ser "o mesmo". ZERO.
 *
 * ESTE NÚMERO JÁ FOI 3, E 3 CUSTOU UM FRAME REAL (§45).
 *
 * A justificativa antiga dizia que 3 absorvia cursor e etiqueta "sem chegar
 * perto das ~5 células que a barra mais curta produz". As ~5 células vinham de
 * um frame SINTÉTICO, com barra de 6 px e 260 px de altura sobre fundo chapado.
 * A janela real do operador não é assim.
 *
 * MEDIDO na sessão de 20/08/2026, prints 031 (10:11) e 032 (10:12), capturas
 * reais do Profit em 1366×720:
 *   • o candle avançou de Fch 170.075 para Fch 170.180, e a máxima de 170.075
 *     para 170.260 — 185 pontos de extensão, escala inteira deslocada;
 *   • a célula da grade mede 38,4 × 17,2 px e o candle tem ~8 px de largura;
 *   • o hash VIU a mudança: células (22,15) e (22,16), deltas 18 e 11;
 *   • distância = 2 ≤ 3 ⇒ o frame foi declarado DUPLICADO.
 *
 * A tolerância para ruído estava maior que o sinal de um candle. É a mesma
 * classe de erro do aHash que este módulo substituiu: a representação melhorou
 * e o limiar continuou frouxo.
 *
 * POR QUE ZERO, E NÃO 1 OU 2. Os dois erros não custam o mesmo — está escrito
 * no cabeçalho dos testes: chamar de NOVO uma imagem parada gasta uma
 * inferência; chamar de DUPLICADA uma imagem que mudou PERDE A OPERAÇÃO. Com
 * zero, só a imagem cell-a-cell idêntica é duplicata — que é exatamente o que
 * uma captura congelada produz, já que o hash lê o `getImageData` cru do
 * canvas, sem passar por JPEG. Cursor movido volta a contar como frame novo,
 * DE PROPÓSITO: o preço dessa escolha é GPU, e o da escolha oposta é dinheiro.
 *
 * A defesa contra o que muda sem o mercado mudar continua sendo o RECORTE
 * (relógio, cronômetro, eixo de preço e paleta ficam fora), nunca a folga.
 */
export const DUPLICATE_MAX_DISTANCE = 0;

/**
 * Tentativas de recaptura antes de declarar a fonte parada (§3).
 *
 * Três, e não uma: um frame repetido pode ser o navegador atrasando o vídeo por
 * meio segundo. Repetido três vezes seguidas não é atraso — é a fonte parada, e
 * aí o sistema tem de PARAR de analisar em vez de continuar produzindo leituras
 * sobre um gráfico que não existe mais.
 */
export const DUPLICATE_RETRY_LIMIT = 3;

export interface LumaGrid {
  /** Luminâncias em ordem de varredura (linha a linha). */
  luma: Float64Array | number[];
  width: number;
  height: number;
}

/**
 * Luma de um buffer RGBA (o formato do `getImageData`).
 *
 * Separado do hash porque o hash precisa ser testável sem canvas: o navegador
 * entrega RGBA, o teste entrega um retângulo montado à mão, e os dois passam
 * pela MESMA redução.
 */
export function lumaFromRgba(data: ArrayLike<number>, width: number, height: number): LumaGrid {
  const luma = new Float64Array(width * height);
  for (let i = 0, p = 0; p < luma.length; i += 4, p += 1) {
    luma[p] = 0.299 * Number(data[i]) + 0.587 * Number(data[i + 1]) + 0.114 * Number(data[i + 2]);
  }
  return { luma, width, height };
}

/**
 * A REGIÃO DO GRÁFICO — o que entra na assinatura (§4).
 *
 * Frações de 0 a 1 sobre o frame. Existe para MASCARAR o que muda sem que o
 * mercado mude: relógio do Windows, barra de tarefas, menus do Profit,
 * cronômetro do candle, tooltips. Omitida, a assinatura usa o frame inteiro —
 * comportamento correto para um print já recortado.
 */
export interface FrameRoi {
  x: number;
  y: number;
  width: number;
  height: number;
}

const ROI_CHEIA: FrameRoi = { x: 0, y: 0, width: 1, height: 1 };

/**
 * Assinatura do frame: a média de luma de cada célula da grade, em hex.
 *
 * Dois dígitos por célula (0–255), varredura linha a linha. A média de BLOCO
 * — e não a amostragem de um pixel por célula — é o que garante que a barra
 * fina de um candle não desapareça por azar de alinhamento: qualquer pixel
 * pintado dentro da célula puxa a média dela.
 */
export function perceptualHash(grid: LumaGrid, roi: FrameRoi = ROI_CHEIA): string {
  const { luma, width, height } = grid;
  if (width <= 0 || height <= 0) return "";

  // Recorte em pixels, com as bordas presas ao frame: um ROI mal calculado
  // encolhe a área analisada, mas nunca lê fora do buffer.
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(roi.x * width)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(roi.y * height)));
  const x1 = Math.max(x0 + 1, Math.min(width, Math.ceil((roi.x + roi.width) * width)));
  const y1 = Math.max(y0 + 1, Math.min(height, Math.ceil((roi.y + roi.height) * height)));
  const larguraRoi = x1 - x0;
  const alturaRoi = y1 - y0;

  const celulas = new Float64Array(GRADE_COLUNAS * GRADE_LINHAS);
  const contagens = new Int32Array(GRADE_COLUNAS * GRADE_LINHAS);
  for (let y = y0; y < y1; y += 1) {
    const gy = Math.min(GRADE_LINHAS - 1, Math.floor(((y - y0) * GRADE_LINHAS) / alturaRoi));
    for (let x = x0; x < x1; x += 1) {
      const gx = Math.min(GRADE_COLUNAS - 1, Math.floor(((x - x0) * GRADE_COLUNAS) / larguraRoi));
      const celula = gy * GRADE_COLUNAS + gx;
      celulas[celula] += Number(luma[y * width + x]);
      contagens[celula] += 1;
    }
  }

  let hex = "";
  for (let i = 0; i < celulas.length; i += 1) {
    const media = contagens[i]! > 0 ? celulas[i]! / contagens[i]! : 0;
    const nivel = Math.max(0, Math.min(255, Math.round(media)));
    hex += nivel.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Quantas CÉLULAS mudaram materialmente entre duas assinaturas.
 *
 * Não é distância de Hamming: bits não descrevem forma, e forma é justamente o
 * que separa um candle (traço alto, várias células) de um cursor (um ponto).
 * Devolve −1 quando as assinaturas não são comparáveis — nunca 0, que seria
 * lido como "idênticas".
 */
export function cellDistance(a: string, b: string): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length || a.length % 2 !== 0) return -1;
  let alteradas = 0;
  for (let i = 0; i < a.length; i += 2) {
    const va = Number.parseInt(a.slice(i, i + 2), 16);
    const vb = Number.parseInt(b.slice(i, i + 2), 16);
    if (Number.isNaN(va) || Number.isNaN(vb)) return -1;
    if (Math.abs(va - vb) >= DELTA_CELULA) alteradas += 1;
  }
  return alteradas;
}

/**
 * Os dois frames são o mesmo?
 *
 * Hash ausente ou incomparável devolve `false` — "não sei" nunca é "é
 * duplicado", porque tratar o desconhecido como duplicado FARIA A T4 PARAR de
 * analisar por falta de evidência, que é o oposto do comportamento seguro aqui.
 */
export function framesAreDuplicate(
  previous: string | null,
  current: string | null,
  maxDistance = DUPLICATE_MAX_DISTANCE,
): boolean {
  if (previous === null || current === null) return false;
  const distancia = cellDistance(previous, current);
  return distancia >= 0 && distancia <= maxDistance;
}

/**
 * Recorta a grade de luma por um ROI, devolvendo uma grade nova.
 *
 * Existe porque o RECORTE e a GRADE são perguntas separadas: o hash reduz o
 * recorte a células, mas quem mede corte de enquadramento precisa dos pixels
 * do recorte, não da média deles. Bordas presas ao frame — ROI mal calculado
 * encolhe a área, nunca lê fora do buffer.
 */
export function cropLuma(grid: LumaGrid, roi: FrameRoi): LumaGrid {
  const { luma, width, height } = grid;
  if (width <= 0 || height <= 0) return { luma: [], width: 0, height: 0 };

  const x0 = Math.max(0, Math.min(width - 1, Math.floor(roi.x * width)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(roi.y * height)));
  const x1 = Math.max(x0 + 1, Math.min(width, Math.ceil((roi.x + roi.width) * width)));
  const y1 = Math.max(y0 + 1, Math.min(height, Math.ceil((roi.y + roi.height) * height)));
  const larguraRoi = x1 - x0;
  const alturaRoi = y1 - y0;

  const recorte = new Float64Array(larguraRoi * alturaRoi);
  for (let y = 0; y < alturaRoi; y += 1) {
    for (let x = 0; x < larguraRoi; x += 1) {
      recorte[y * larguraRoi + x] = Number(luma[(y0 + y) * width + (x0 + x)]);
    }
  }
  return { luma: recorte, width: larguraRoi, height: alturaRoi };
}
