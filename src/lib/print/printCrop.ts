import { roiFromPixels, type ColumnProfile, type Roi } from "@/lib/vision/chartRoi";
import { estimateBackground, isInk } from "@/lib/vision/inkModel";
import type { PrintAnalysis } from "@/lib/vision/printAnalysis";

/**
 * AUTO-CROP + ZOOM EM DOIS PASSES (§13).
 *
 * O DEFEITO QUE ISTO ATACA: o operador compartilha a JANELA do Profit, e o
 * gráfico ocupa uma fração dela — barra de ferramentas, book, lista de ativos e
 * rodapé entram no print junto. O modelo multimodal reduz a imagem a uma
 * resolução fixa antes de olhar; quanto mais cromo houver, menos pixels sobram
 * para o candle. Daí os INCONCLUSIVO com "candles pequenos demais".
 *
 * DE ONDE VEM O GANHO, HONESTAMENTE: do RECORTE, não da ampliação. Interpolar
 * bitmap não cria detalhe nenhum — o que muda é a PROPORÇÃO: recortado, o
 * gráfico ocupa quase todo o orçamento de pixels do modelo em vez de um terço
 * dele. A ampliação existe só para o recorte não chegar minúsculo ao provedor.
 *
 * A RESTRIÇÃO QUE NÃO SE NEGOCIA: o eixo de PREÇO fica na borda direita e
 * NUNCA pode ser cortado. Ele é a régua — sem ele a calibração de escala não
 * roda, os níveis não viram linha na altura certa e o modelo perde a
 * referência numérica. Por isso o recorte apara a esquerda e as bordas
 * verticais, e vai SEMPRE até a borda direita da imagem.
 *
 * O segundo passe é CONDICIONAL e comparado: só roda quando a primeira leitura
 * sai fraca, e a leitura vencedora é escolhida por evidência contável
 * (`chooseBetterReading`), nunca por "a segunda deve ser melhor".
 */

/** Área a recortar, em frações 0–1 da imagem original. */
export interface CropWindow {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CropResult {
  /** A imagem recortada e ampliada, pronta para reanálise. */
  dataUrl: string;
  window: CropWindow;
  /** Quantas vezes o recorte foi ampliado ao ser redesenhado. */
  scale: number;
  roi: Roi;
}

/** Folga vertical em volta da faixa do gráfico: eixo de tempo e legenda entram. */
const MARGEM_VERTICAL = 0.04;
/**
 * Largura máxima que o recorte conserva, em fração da imagem.
 *
 * O que decide a entrada são os candles RECENTES, o eixo de preço, a linha de
 * entrada e a estrutura próxima. Num gráfico muito largo, metade da imagem é
 * histórico distante que só rouba pixels do que importa — então o recorte
 * ancora na DIREITA (onde o preço está agora) e apara o excesso à esquerda.
 *
 * Não é agressivo de propósito: 72% ainda carrega o contexto estrutural, e os
 * níveis horizontais (suporte/resistência/zonas) atravessam a largura inteira,
 * então nenhum deles se perde por este corte — some apenas o passado longínquo.
 */
const LARGURA_UTIL_MAXIMA = 0.72;
/** Abaixo disto o recorte não muda nada relevante e o segundo passe é desperdício. */
const GANHO_MINIMO_DE_AREA = 0.12;
/** Teto do lado maior da imagem ampliada — acima disso só cresce peso, não leitura. */
const LADO_MAXIMO = 2400;
/** Limite do server function (12 MB): a imagem sai abaixo disso ou não sai. */
const MAX_BYTES_APROX = 11_000_000;

/**
 * A janela de recorte a partir da ROI detectada.
 *
 * Apara o cromo da ESQUERDA e as bordas de cima/baixo; a direita fica intacta
 * porque é onde mora a escala de preço (a régua de todo o sistema).
 */
export function cropWindowFor(roi: Roi): CropWindow {
  // Ancorado na DIREITA: o eixo de preço e os candles recentes são o que
  // decide a entrada, e são eles que precisam sobreviver ao corte.
  const inicioDoGrafico = clamp01(roi.x);
  const x = Math.max(inicioDoGrafico, 1 - LARGURA_UTIL_MAXIMA);
  const y = clamp01(roi.y - MARGEM_VERTICAL);
  const bottom = clamp01(roi.y + roi.height + MARGEM_VERTICAL);
  return { x, y, width: 1 - x, height: Math.max(0, bottom - y) };
}

/** O recorte vale a chamada extra de IA? Área muito parecida com o original não vale. */
export function cropIsWorthIt(window: CropWindow): boolean {
  if (window.width <= 0 || window.height <= 0) return false;
  const area = window.width * window.height;
  // Área pequena demais é sinal de detecção errada — recortar ali esconderia
  // o gráfico em vez de destacá-lo.
  if (area < 0.15) return false;
  return area <= 1 - GANHO_MINIMO_DE_AREA;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/* ------------------------------------------------------------------------ *
 * QUANDO A LEITURA É FRACA — o gatilho do segundo passe.
 * ------------------------------------------------------------------------ */

export interface WeakReading {
  weak: boolean;
  /** Por que está fraca. Vazio quando não está. */
  motivos: string[];
}

/** Piso da leitura visual abaixo do qual vale tentar de novo, ampliado. */
export const CONFIANCA_FRACA = 60;

/**
 * Uma leitura é fraca quando a IMAGEM limitou a análise — nunca quando o
 * gráfico simplesmente não tem setup. "SEM_T4 com escala legível e preço lido"
 * é uma resposta boa e completa: reanalisar aquilo ampliado gastaria GPU para
 * reconfirmar o já sabido.
 */
export function readingIsWeak(analysis: PrintAnalysis): WeakReading {
  const motivos: string[] = [];
  if (analysis.status === "INCONCLUSIVO") motivos.push("status INCONCLUSIVO");
  if (analysis.confidence < CONFIANCA_FRACA) {
    motivos.push(`leitura visual ${analysis.confidence}%`);
  }
  for (const problema of analysis.imageIssues) motivos.push(`imagem: ${problema}`);
  // Sem a etiqueta do último preço a régua perde a âncora mais confiável.
  if (!analysis.currentPrice.visible) motivos.push("preço atual não legível");
  if (analysis.priceLevels.length === 0) motivos.push("nenhum nível de preço lido na escala");
  return { weak: motivos.length > 0, motivos };
}

/* ------------------------------------------------------------------------ *
 * QUAL DAS DUAS LEITURAS FICA — evidência contável, não preferência.
 * ------------------------------------------------------------------------ */

/**
 * Pontuação de EVIDÊNCIA de uma leitura: quantos números ela realmente leu.
 *
 * Confiança entra com peso baixo de propósito — ela é a autoavaliação do
 * modelo, e autoavaliação é justamente o que não se pode usar como juiz. Os
 * números legíveis e os níveis lidos na escala são fatos verificáveis.
 */
export function readingScore(analysis: PrintAnalysis): number {
  const legivel = (n: { value: number | null; visible: boolean }) =>
    n.visible && n.value !== null ? 1 : 0;
  const numeros =
    legivel(analysis.currentPrice) +
    legivel(analysis.entry) +
    legivel(analysis.stop) +
    (analysis.targets.some((t) => t.visible && t.value !== null) ? 1 : 0);
  return (
    numeros * 12 +
    Math.min(analysis.priceLevels.length, 8) * 4 +
    analysis.confidence * 0.4 -
    analysis.imageIssues.length * 8 -
    (analysis.status === "INCONCLUSIVO" ? 30 : 0)
  );
}

/** Margem que a segunda leitura precisa vencer para substituir a primeira. */
const MARGEM_DE_TROCA = 5;

export interface ReadingChoice {
  /** true quando a leitura do recorte ampliado venceu. */
  usarSegunda: boolean;
  motivo: string;
}

/**
 * Empate mantém a PRIMEIRA. Trocar por diferença mínima faria a análise
 * oscilar entre dois enquadramentos sem ganho real para o operador.
 */
export function chooseBetterReading(
  primeira: PrintAnalysis,
  segunda: PrintAnalysis,
): ReadingChoice {
  const a = readingScore(primeira);
  const b = readingScore(segunda);
  if (b > a + MARGEM_DE_TROCA) {
    return {
      usarSegunda: true,
      motivo: `2º passe (recorte ampliado) leu mais evidência: ${Math.round(b)} contra ${Math.round(a)}`,
    };
  }
  return {
    usarSegunda: false,
    motivo: `1º passe mantido: recorte não melhorou a leitura (${Math.round(b)} contra ${Math.round(a)})`,
  };
}

/* ------------------------------------------------------------------------ *
 * PERFIS DE COLUNA — a ponte entre pixels e o detector de ROI já existente.
 * ------------------------------------------------------------------------ */

/**
 * Converte uma grade de cinzas em perfis de coluna para `detectRoi`.
 *
 * O FUNDO É ESTIMADO POR LINHA (@/lib/vision/inkModel), e não por um tom
 * dominante único. A versão anterior media o desvio contra um só tom, o que
 * funciona em tema escuro chapado e falha no tema CLARO do Profit, que tem
 * gradiente: medido no print 001 da sessão de 20/08, o fundo vazio vai de luma
 * 252 no alto a 205 embaixo — 47 níveis contra um limiar de 26. O terço
 * inferior do gráfico vazio era contado como tinta, e com isso `detectRoi`
 * devolveu confiança 35 em 83 de 83 capturas reais.
 *
 * PURA de propósito: é o que permite testar a detecção sem canvas.
 */
export function columnProfilesFromGray(
  // ArrayLike e não number[]: a grade chega ora como Array, ora como
  // Float64Array vinda do canvas — e copiar 57 mil números só para satisfazer
  // o tipo seria trabalho puro de cerimônia.
  gray: ArrayLike<number>,
  cols: number,
  rows: number,
): ColumnProfile[] {
  if (cols <= 0 || rows <= 0 || gray.length < cols * rows) return [];

  const modelo = estimateBackground(gray, cols, rows);

  const perfis: ColumnProfile[] = [];
  for (let c = 0; c < cols; c += 1) {
    let ink = 0;
    let top: number | null = null;
    let bottom: number | null = null;
    for (let r = 0; r < rows; r += 1) {
      if (!isInk(Number(gray[r * cols + c]), modelo.byRow[r]!)) continue;
      ink += 1;
      const fracao = r / rows;
      if (top === null) top = fracao;
      bottom = fracao;
    }
    perfis.push({ ink, top, bottom });
  }
  return perfis;
}

/* ------------------------------------------------------------------------ *
 * O PASSO NO NAVEGADOR — canvas, recorte e ampliação.
 * ------------------------------------------------------------------------ */

/** Amostragem da grade: mais que isto não muda a ROI e custa CPU no cliente. */
const AMOSTRAS = 240;

function carregarImagem(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("print ilegível para recorte"));
    el.src = dataUrl;
  });
}

/** Grade de luminância amostrada do print, com a imagem já decodificada. */
interface AmostraDoPrint {
  imagem: HTMLImageElement;
  largura: number;
  altura: number;
  cinzas: number[];
  colunas: number;
  linhas: number;
}

/**
 * Decodifica o print e reduz a uma grade de luminância.
 *
 * Passo compartilhado por DOIS leitores — o recorte e a detecção de corte —
 * porque os dois fazem a mesma pergunta ao mesmo pixel. Null quando a imagem
 * não abre, é pequena demais para ter gráfico ou o canvas está indisponível.
 */
async function amostrarPrint(dataUrl: string): Promise<AmostraDoPrint | null> {
  let imagem: HTMLImageElement;
  try {
    imagem = await carregarImagem(dataUrl);
  } catch {
    return null;
  }

  const largura = imagem.naturalWidth;
  const altura = imagem.naturalHeight;
  if (largura < 200 || altura < 200) return null;

  const amostra = document.createElement("canvas");
  const colunas = Math.min(AMOSTRAS, largura);
  const linhas = Math.min(AMOSTRAS, altura);
  amostra.width = colunas;
  amostra.height = linhas;
  const ctxAmostra = amostra.getContext("2d", { willReadFrequently: true });
  if (!ctxAmostra) return null;
  ctxAmostra.drawImage(imagem, 0, 0, colunas, linhas);

  try {
    const pixels = ctxAmostra.getImageData(0, 0, colunas, linhas).data;
    const cinzas = new Array<number>(colunas * linhas);
    for (let i = 0; i < colunas * linhas; i += 1) {
      // Luminância perceptual: candle verde e candle vermelho têm brilhos
      // diferentes do fundo em qualquer tema.
      cinzas[i] = 0.299 * pixels[i * 4]! + 0.587 * pixels[i * 4 + 1]! + 0.114 * pixels[i * 4 + 2]!;
    }
    return { imagem, largura, altura, cinzas, colunas, linhas };
  } catch {
    // Canvas contaminado por imagem de outra origem: sem leitura, sem drama.
    return null;
  }
}

/**
 * Recorta o gráfico e devolve a versão ampliada, ou null quando não vale a
 * pena (ROI não confiável, recorte quase idêntico ao original, canvas
 * indisponível). Null é uma resposta: o chamador segue com a imagem inteira.
 */
export async function autoCropPrint(dataUrl: string): Promise<CropResult | null> {
  const amostra = await amostrarPrint(dataUrl);
  if (amostra === null) return null;
  const { imagem, largura, altura, cinzas, colunas, linhas } = amostra;

  /*
   * A ROI VEM DO BITMAP, não dos perfis de coluna.
   *
   * `detectRoi` deriva a faixa vertical do envelope da tinta (`min(top)` e
   * `max(bottom)`), e basta UMA coluna cruzando a barra de ferramentas para
   * prender o topo em zero. Medido nas 83 capturas de 20/08: confiança 35 —
   * inutilizável — em 83 delas, e continuou 35 depois de o modelo de tinta ser
   * corrigido, porque o gradiente era só metade do problema.
   *
   * `roiFromPixels` usa a MOLDURA, isto é, onde o cromo termina. É essa a
   * pergunta que o recorte precisa responder: até onde vai a janela do Profit,
   * não até onde chega o desenho.
   */
  const roi = roiFromPixels(cinzas, colunas, linhas);
  const janela = cropWindowFor(roi);
  if (!cropIsWorthIt(janela)) return null;

  const sx = Math.round(janela.x * largura);
  const sy = Math.round(janela.y * altura);
  const sw = Math.max(1, Math.round(janela.width * largura));
  const sh = Math.max(1, Math.round(janela.height * altura));

  // Ampliação: leva o lado maior ao teto, sem passar de 2× (acima disso o
  // arquivo cresce muito para um ganho que não existe — interpolação não
  // inventa candle).
  const escala = Math.min(2, Math.max(1, LADO_MAXIMO / Math.max(sw, sh)));
  const destino = document.createElement("canvas");
  destino.width = Math.round(sw * escala);
  destino.height = Math.round(sh * escala);
  const ctx = destino.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(imagem, sx, sy, sw, sh, 0, 0, destino.width, destino.height);

  let recorte = destino.toDataURL("image/png");
  if (recorte.length > MAX_BYTES_APROX) {
    // PNG grande demais para o limite do server function: JPEG de alta
    // qualidade preserva a leitura da escala e cabe.
    recorte = destino.toDataURL("image/jpeg", 0.94);
    if (recorte.length > MAX_BYTES_APROX) return null;
  }

  return { dataUrl: recorte, window: janela, scale: escala, roi };
}
