/**
 * CALIBRAÇÃO DE PREÇO NO VÍDEO — híbrida: valores por OCR, posições por GEOMETRIA.
 *
 * O DEFEITO MEDIDO QUE DEFINIU ESTE DESENHO. A primeira versão pedia ao modelo
 * de visão valor E posição de cada rótulo do eixo. Medido contra a verdade do
 * pixel (a caixa do preço atual, detectada em y=384 valendo 194.609), o preço
 * projetado errava 1.215 pontos — 243 ticks — com R² = 1,0. A inclinação saía
 * quase certa; o OFFSET errava ~59 px. O modelo lê NÚMERO muito bem e lê
 * POSIÇÃO mal. Então cada um faz o que sabe: o OCR entrega os valores, a
 * geometria entrega onde cada valor está.
 *
 * O SEGUNDO FATO QUE DEFINIU O DESENHO: o eixo muda em 99% dos frames. Numa
 * gravação acelerada do pregão, a autoescala do Profit acompanha o preço o
 * tempo todo, e "OCR sempre que o eixo mudar" custaria 4–9 s por frame em
 * dezenas de milhares de frames. Por isso a calibração se PROPAGA entre duas
 * leituras: a grade do Profit é uniforme por construção (rótulos a intervalos
 * iguais de preço), então, com o passo conhecido, uma linha que entra pela
 * borda vale `vizinha ± passo`. Isso NÃO é estimar preço — é ler uma grade cujo
 * intervalo foi lido. E é vigiado: o passo em pixels é medido a cada frame
 * (mudou = zoom/rescale = invalida e força OCR), a reta é reajustada a cada
 * frame com os portões de R²/resíduo, e toda OCR nova revalida o que a
 * propagação afirmou — a discordância é CONTADA. Se esse contador subir, o
 * método está errado e o relatório vai dizer.
 *
 * O QUE É REUSADO DO AO VIVO, sem cópia: `normalizeScaleAnchorsForAsset`,
 * `assetScaleIssue`, `calibrateRobust`, `plausiblePriceRange`. Duas réguas
 * divergiriam no primeiro ajuste.
 *
 * NUNCA ESTIMA. Toda saída é ou uma régua provada ou uma recusa com motivo.
 */

import type { PixelFrame } from "@/lib/capture/frameProcessor";
import { plausiblePriceRange } from "@/lib/engines/instruments";
import {
  assetScaleIssue,
  calibrateRobust,
  geometricCalibration,
  normalizeScaleAnchorsForAsset,
  parsePriceLabel,
  priceAt,
  type Calibration,
  type ScaleAnchor,
} from "@/lib/vision/priceScale";
import { aiConfig } from "@/services/ai/config";
import { recorteAmpliado } from "./frames";
import { sha256, type LedgerDeLeituras } from "./leituraLedger";

/** Frações da largura onde a faixa do eixo pode começar — a lista do ao vivo. */
export const FAIXAS_DO_EIXO = [0.9, 0.84, 0.76, 0.94, 0.68, 0.6] as const;

/** Motivo pelo qual a escala não está pronta. Código estável, não frase. */
export type MotivoSemEscala =
  | "NUNCA_TENTADA"
  | "OCR_VAZIO"
  | "ROTULOS_INSUFICIENTES"
  | "GRADE_NAO_ENCONTRADA"
  | "CASAMENTO_INSUFICIENTE"
  | "GRADE_IRREGULAR"
  | "FORA_DA_FAIXA"
  | "RETA_RUIM"
  | "ESCALA_INVERTIDA"
  | "PASSO_MUDOU"
  | "GPU_INDISPONIVEL";

export interface LinhaDaGrade {
  /** Centro vertical da linha de texto, em pixels do frame. */
  y: number;
  /** Preço da linha. Null = linha detectada mas ainda sem valor. */
  price: number | null;
  /** "OCR" = lido pelo modelo neste frame; "PROPAGADO" = herdado da grade. */
  origem: "OCR" | "PROPAGADO";
}

export interface EstadoDaCalibracao {
  calibracao: Calibration;
  /** true só quando o preço produzido é preço de mercado. */
  utilizavel: boolean;
  motivo: MotivoSemEscala | null;
  /** De onde veio a régua em vigor. */
  origem: "NENHUMA" | "OCR" | "PROPAGADA";
  /** A grade em vigor — linhas com valor. */
  grade: LinhaDaGrade[];
  /** Passo da grade em pixels. Null enquanto não conhecido. */
  passoPx: number | null;
  /**
   * Diferença de preço entre dois RÓTULOS vizinhos do eixo — não entre duas
   * linhas da grade. O Profit desenha várias linhas por rótulo (medido no
   * vídeo de março: 5 linhas de 22 px para cada rótulo de 650 pontos).
   */
  passoPreco: number | null;
  /**
   * Diferença de preço entre duas LINHAS vizinhas da grade.
   *
   * ESTE CAMPO EXISTE PORQUE A FALTA DELE QUEBRAVA A PROPAGAÇÃO. A propagação
   * preenche linha a linha e usava `passoPreco` como se fosse o passo de UMA
   * linha. Com 5 linhas por rótulo ela andava 5× rápido demais e montava uma
   * grade em dente de serra: medido no vídeo de março, o R² caía de 0,999994
   * para 0,17 já no primeiro frame propagado, e o portão de qualidade —
   * corretamente — reprovava com RETA_RUIM.
   *
   * A consequência era silenciosa e cara: 409 de 430 frames varridos ficaram
   * sem escala, obrigando OCR em praticamente todo frame aproveitável (21 OCRs
   * em 43 s de vídeo) e jogando fora 95% da leitura de preço.
   *
   * Vem da RETA ajustada, não de contagem de rótulos: preço por pixel × passo
   * em pixels. Assim independe de quantas linhas o Profit desenha por rótulo.
   */
  passoPrecoPorLinha: number | null;
  rotulosOcr: number;
  linhasDetectadas: number;
  casados: number;
  /** Viés de posição do OCR encontrado no casamento (px). Diagnóstico. */
  deslocamentoOcrPx: number | null;
  r2: number;
  desvioMaxPx: number;
  confianca: number;
  /** Pontos de preço por pixel. */
  precoPorPixel: number | null;
  /** Contadores da sessão. */
  ocrChamadas: number;
  ocrFalhas: number;
  propagacoes: number;
  /** Vezes em que a OCR discordou do que a propagação afirmava. */
  propagacaoCorrigida: number;
  /**
   * OCRs recusadas por quebrarem a CONTINUIDADE DO PREÇO — ver `lerPorOcr`.
   * Contador alto aqui é sinal de leitor de rótulo instável, não de mercado.
   */
  ocrRecusadasPorSalto: number;
  /** Trocas de régua aceitas só depois de uma segunda OCR concordar. */
  ocrConfirmadas: number;
  /** Segundo de vídeo da última OCR bem-sucedida. */
  ultimaOcrEmSeg: number | null;
  ultimaMensagem: string;
}

export function estadoInicial(alturaFrame: number): EstadoDaCalibracao {
  return {
    calibracao: geometricCalibration(alturaFrame),
    utilizavel: false,
    motivo: "NUNCA_TENTADA",
    origem: "NENHUMA",
    grade: [],
    passoPx: null,
    passoPreco: null,
    passoPrecoPorLinha: null,
    rotulosOcr: 0,
    linhasDetectadas: 0,
    casados: 0,
    deslocamentoOcrPx: null,
    r2: 0,
    desvioMaxPx: Number.POSITIVE_INFINITY,
    confianca: 0,
    precoPorPixel: null,
    ocrChamadas: 0,
    ocrFalhas: 0,
    propagacoes: 0,
    propagacaoCorrigida: 0,
    ocrRecusadasPorSalto: 0,
    ocrConfirmadas: 0,
    ultimaOcrEmSeg: null,
    ultimaMensagem: "Escala ainda não lida.",
  };
}

/* ------------------------------------------------------------------------ *
 * GEOMETRIA: onde estão as linhas de texto do eixo
 * ------------------------------------------------------------------------ */

/** Margem da borda direita ocupada pela barra de ferramentas do Profit. */
const MARGEM_TOOLBAR = 0.025;
/** Faixa vertical útil: fora da toolbar do topo e das abas de baixo. */
const Y_MIN = 0.1;
const Y_MAX = 0.88;

function luma(d: Uint8ClampedArray, i: number): number {
  return d[i]! * 0.299 + d[i + 1]! * 0.587 + d[i + 2]! * 0.114;
}

/** Pixel de texto do eixo: cinza médio e POUCO saturado. Candle é saturado. */
function ehTextoCinza(d: Uint8ClampedArray, i: number): boolean {
  const r = d[i]!;
  const g = d[i + 1]!;
  const b = d[i + 2]!;
  const l = r * 0.299 + g * 0.587 + b * 0.114;
  if (l <= 90 || l >= 205) return false;
  return Math.max(r, g, b) - Math.min(r, g, b) < 40;
}

export interface LinhasDoEixo {
  /** Centros das linhas de texto, crescentes. */
  linhas: number[];
  /** Passo mediano entre linhas vizinhas (px). Null com menos de 3 linhas. */
  passoPx: number | null;
  /** Colunas do bloco de rótulos, em pixels do frame. */
  colunas: [number, number] | null;
}

/**
 * Detecta as linhas de texto do eixo de preços, por pixel.
 *
 * Varre da direita para a esquerda: pula a toolbar, acha o bloco contíguo de
 * colunas com densidade de texto cinza, e dentro dele conta texto por linha.
 * Bandas de linhas viram centros; o filtro de grade mantém só as que têm uma
 * vizinha a ~um passo — ícone de toolbar e a caixa do preço (texto branco em
 * fundo preto, fora da faixa de cinza) ficam de fora.
 */
export function detectarLinhasDoEixo(frame: PixelFrame): LinhasDoEixo {
  const { data, width: W, height: H } = frame;
  const yIni = Math.floor(H * Y_MIN);
  const yFim = Math.ceil(H * Y_MAX);
  const xToolbar = W - Math.round(W * MARGEM_TOOLBAR);
  const xMin = Math.floor(W * 0.6);

  // Densidade de texto por coluna, da direita para a esquerda.
  const linhasUteis = Math.max(1, yFim - yIni);
  const densidade = (x: number): number => {
    let n = 0;
    for (let y = yIni; y < yFim; y++) if (ehTextoCinza(data, (y * W + x) * 4)) n++;
    return n / linhasUteis;
  };

  /*
   * Bloco de rótulos: o primeiro trecho contíguo denso vindo da direita.
   *
   * O FUNDO NÃO É ZERO. O gradiente do Profit deixa ~11% de pixels "cinza"
   * em qualquer coluna, então um limiar de 10% nunca encerrava o bloco e ele
   * invadia o gráfico inteiro (medido: bloco de 500 colunas, grade
   * irregular, calibração nunca encontrada). O limiar de pertencimento fica
   * acima do fundo (15%), com tolerância a até 3 colunas fracas — o espaço
   * entre dígitos — e o bloco é recusado se sair do tamanho de um eixo.
   */
  let x1 = -1;
  let x0 = -1;
  let vazias = 0;
  for (let x = xToolbar - 1; x >= xMin; x--) {
    const dens = densidade(x);
    if (x1 < 0) {
      if (dens >= 0.15) x1 = x;
      continue;
    }
    if (dens >= 0.15) {
      vazias = 0;
      x0 = x;
    } else if (++vazias >= 3) {
      break;
    }
  }
  if (x1 < 0 || x0 < 0 || x1 - x0 < W * 0.02 || x1 - x0 > W * 0.1) {
    return { linhas: [], passoPx: null, colunas: null };
  }

  // Texto por linha dentro do bloco.
  const largura = x1 - x0 + 1;
  const limiarLinha = Math.max(3, Math.round(largura * 0.12));
  const bandas: number[] = [];
  let ini = -1;
  for (let y = yIni; y <= yFim; y++) {
    let n = 0;
    if (y < yFim) for (let x = x0; x <= x1; x++) if (ehTextoCinza(data, (y * W + x) * 4)) n++;
    const tem = y < yFim && n >= limiarLinha;
    if (tem && ini < 0) ini = y;
    else if (!tem && ini >= 0) {
      if (y - ini >= 3) bandas.push((ini + y - 1) / 2);
      ini = -1;
    }
  }
  if (bandas.length < 2) return { linhas: bandas, passoPx: null, colunas: [x0, x1] };

  // Passo mediano e filtro de grade.
  const difs = bandas.slice(1).map((b, i) => b - bandas[i]!);
  const ord = [...difs].sort((a, b) => a - b);
  const passo = ord[Math.floor(ord.length / 2)]!;
  if (!(passo > 4)) return { linhas: bandas, passoPx: null, colunas: [x0, x1] };

  // Une bandas que são a mesma linha partida (mais perto que meio passo).
  const unidas: number[] = [];
  for (const b of bandas) {
    const ult = unidas[unidas.length - 1];
    if (ult !== undefined && b - ult < passo * 0.5) unidas[unidas.length - 1] = (ult + b) / 2;
    else unidas.push(b);
  }
  // Mantém só quem tem vizinha a ~um passo.
  const grade = unidas.filter((b, i) => {
    const ant = unidas[i - 1];
    const prox = unidas[i + 1];
    const ok = (d: number) => d > passo * 0.7 && d < passo * 1.3;
    return (ant !== undefined && ok(b - ant)) || (prox !== undefined && ok(prox - b));
  });
  const difs2 = grade
    .slice(1)
    .map((b, i) => b - grade[i]!)
    .filter((d) => d < passo * 1.3);
  const ord2 = [...difs2].sort((a, b) => a - b);
  const passoFinal = ord2.length > 0 ? ord2[Math.floor(ord2.length / 2)]! : passo;

  return { linhas: grade, passoPx: passoFinal, colunas: [x0, x1] };
}

/* ------------------------------------------------------------------------ *
 * CASAMENTO: valores do OCR ↔ posições da geometria
 * ------------------------------------------------------------------------ */

interface Casamento {
  casados: ScaleAnchor[];
  deslocamentoPx: number;
}

/**
 * Encontra o deslocamento vertical que melhor alinha as posições do OCR às
 * linhas medidas e devolve as âncoras híbridas: y da GEOMETRIA, preço do OCR.
 */
function casarOcrComLinhas(ocr: ScaleAnchor[], linhas: number[], passoPx: number): Casamento {
  const tol = Math.max(4, passoPx * 0.4);
  const maisProxima = (y: number): { linha: number; dist: number } => {
    let melhor = linhas[0]!;
    let dist = Math.abs(y - melhor);
    for (const l of linhas) {
      const d = Math.abs(y - l);
      if (d < dist) {
        dist = d;
        melhor = l;
      }
    }
    return { linha: melhor, dist };
  };

  let melhorS = 0;
  let melhorScore = -1;
  let melhorSoma = Number.POSITIVE_INFINITY;
  for (let s = -160; s <= 160; s++) {
    let score = 0;
    let soma = 0;
    for (const a of ocr) {
      const { dist } = maisProxima(a.y + s);
      if (dist <= tol) {
        score++;
        soma += dist;
      }
    }
    if (score > melhorScore || (score === melhorScore && soma < melhorSoma)) {
      melhorScore = score;
      melhorSoma = soma;
      melhorS = s;
    }
  }

  // Um rótulo por linha: em empate fica o mais próximo.
  const porLinha = new Map<number, { a: ScaleAnchor; dist: number }>();
  for (const a of ocr) {
    const { linha, dist } = maisProxima(a.y + melhorS);
    if (dist > tol) continue;
    const atual = porLinha.get(linha);
    if (!atual || dist < atual.dist) porLinha.set(linha, { a, dist });
  }
  const casados: ScaleAnchor[] = [...porLinha.entries()]
    .map(([linha, { a }]) => ({ ...a, y: linha }))
    .sort((p, q) => p.y - q.y);
  return { casados, deslocamentoPx: melhorS };
}

/** A grade é uniforme: Δpreço/Δy constante entre vizinhas (tolerância 6%). */
function gradeUniforme(ancoras: ScaleAnchor[]): { ok: boolean; passoPreco: number | null } {
  if (ancoras.length < 2) return { ok: false, passoPreco: null };
  const razoes: number[] = [];
  const passos: number[] = [];
  for (let i = 1; i < ancoras.length; i++) {
    const dy = ancoras[i]!.y - ancoras[i - 1]!.y;
    const dp = ancoras[i - 1]!.price - ancoras[i]!.price;
    if (dy <= 0) return { ok: false, passoPreco: null };
    razoes.push(dp / dy);
    passos.push(dp);
  }
  const ord = [...razoes].sort((a, b) => a - b);
  const med = ord[Math.floor(ord.length / 2)]!;
  if (!(med > 0)) return { ok: false, passoPreco: null };
  const ok = razoes.every((r) => Math.abs(r - med) / med <= 0.06);
  // Passo de preço = menor diferença positiva entre vizinhas (linhas
  // intermediárias sem rótulo fazem diferenças múltiplas aparecerem).
  const passoPreco = Math.min(...passos.filter((p) => p > 0));
  return { ok, passoPreco: Number.isFinite(passoPreco) ? passoPreco : null };
}

/* ------------------------------------------------------------------------ *
 * O CALIBRADOR — OCR quando precisa, propagação quando pode
 * ------------------------------------------------------------------------ */

/**
 * Quanto o preço da caixa do eixo pode mudar entre duas leituras VIZINHAS sem
 * que isso denuncie erro de régua. Um frame da varredura densa vale ~1,2 min
 * de pregão; 400 pontos de WINFUT nesse intervalo já é movimento forte.
 */
const SALTO_BASE = 400;
/** Folga adicional por segundo de vídeo sem OCR — o mercado anda no meio. */
const SALTO_POR_SEGUNDO = 250;

export interface OpcoesDoCalibrador {
  /** Segundos de vídeo entre OCRs de revalidação. */
  intervaloOcrSeg?: number;
  /** Espera mínima entre tentativas de OCR após falha (segundos de vídeo). */
  recuoAposFalhaSeg?: number;
  /**
   * Ledger de percepção: cada leitura de rótulo passa por ele — gravada no
   * baseline, REPRODUZIDA nos experimentos. Ausente = comportamento antigo.
   */
  ledger?: LedgerDeLeituras;
}

/**
 * LÊ UM ÚNICO RÓTULO DO EIXO, AMPLIADO, NA POSIÇÃO QUE A GEOMETRIA MEDIU.
 *
 * Um rótulo do Profit tem ~9 px de altura numa captura de 1366×768: nesse
 * tamanho o leitor visual troca dígito. Ampliado 6× por vizinho mais próximo
 * — que preserva a forma da fonte em vez de borrá-la —, é lido sem esforço, e
 * é UM número, não uma régua inteira: a chamada é curta e barata.
 */
const PROMPT_DO_ROTULO =
  "Esta imagem mostra UM rótulo numérico do eixo de preços de um gráfico. " +
  "Responda APENAS o número exatamente como está escrito, sem texto nenhum.";

async function lerRotuloNaLinha(
  frame: PixelFrame,
  y: number,
  colunas: [number, number] | null,
  ativo: string,
  ledger?: LedgerDeLeituras,
): Promise<number | null> {
  if (colunas === null) return null;
  const [x0, x1] = colunas;
  const url = recorteAmpliado(
    frame,
    { left: x0 - 3, top: y - 10, width: x1 - x0 + 8, height: 21 },
    6,
  );
  if (url === null) return null;

  const config = aiConfig();
  if (!config.baseUrl || !config.visionModel) return null;
  const base64 = url.split(",")[1];
  if (base64 === undefined) return null;

  /*
   * PERCEPÇÃO CONGELADA: o recorte ampliado identifica a pergunta — mesma
   * imagem, mesmo prompt ⇒ mesma resposta, sem tocar o modelo. O valor
   * gravado é o rótulo VALIDADO (faixa do ativo aplicada), porque a validação
   * é determinística e faz parte da leitura, não da regra.
   */
  const imageHash = sha256(url);
  const promptHash = sha256(`rotulo-do-eixo@1|${config.visionModel}|${PROMPT_DO_ROTULO}`);
  const congelada = ledger?.consultar(imageHash, promptHash);
  if (congelada !== undefined && congelada !== null) {
    return congelada.valor as number | null;
  }
  const t0 = Date.now();

  try {
    const resposta = await fetch(`${config.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.visionModel,
        stream: false,
        think: false,
        messages: [{ role: "user", content: PROMPT_DO_ROTULO, images: [base64] }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!resposta.ok) return null;
    const json = (await resposta.json()) as { message?: { content?: string } };
    const bruto = (json.message?.content ?? "").trim();
    const gravar = (lido: number | null): number | null => {
      ledger?.registrar({
        tipo: "rotulo",
        imageHash,
        promptHash,
        provider: "ollama",
        model: config.visionModel,
        parametros: { think: false, timeoutMs: 60_000 },
        respostaBrutaHash: sha256(bruto),
        valor: lido,
        tentativa: 1,
        latenciaMs: Date.now() - t0,
      });
      return lido;
    };
    const valor = parsePriceLabel(bruto);
    if (valor === null || !Number.isFinite(valor) || valor <= 0) return gravar(null);

    /*
     * A FAIXA DO CONTRATO É A REDE. "197.140" pode voltar como 197,14 quando o
     * ponto de milhar é lido como decimal; o valor certo é o que cai na faixa
     * do ativo. Nenhum dos candidatos servindo, a leitura é descartada — nunca
     * "ajustada" para caber.
     */
    const faixa = plausiblePriceRange(ativo);
    if (faixa === null) return gravar(valor);
    return gravar(
      [valor, valor * 1000, valor * 10].find((c) => c >= faixa.min && c <= faixa.max) ?? null,
    );
  } catch {
    // Falha de rede/timeout NÃO é percepção: não grava, tenta de novo na próxima.
    return null;
  }
}

/**
 * Escolhe quais linhas ler: os DOIS EXTREMOS e o meio.
 *
 * Os extremos são obrigatórios porque uma reta ajustada num pedaço curto do
 * eixo é extrapolada para o resto — e é no resto que ficam os alvos. O meio
 * entra como terceira âncora, para o ajuste robusto ter o que descartar.
 */
function linhasParaLer(linhas: number[], quantas = 3): number[] {
  if (linhas.length <= quantas) return [...linhas];
  const ordenadas = [...linhas].sort((a, b) => a - b);
  const escolhidas = new Set<number>([ordenadas[0]!, ordenadas[ordenadas.length - 1]!]);
  for (let i = 1; i < quantas - 1; i++) {
    escolhidas.add(ordenadas[Math.round((ordenadas.length - 1) * (i / (quantas - 1)))]!);
  }
  return [...escolhidas].sort((a, b) => a - b);
}

export class CalibradorDeVideo {
  private estado: EstadoDaCalibracao | null = null;
  private faixa: number = FAIXAS_DO_EIXO[0];
  private ultimaTentativaSeg: number | null = null;
  /**
   * A OCR que foi recusada por salto e espera uma segunda opinião.
   *
   * Guarda o PREÇO que ela atribuía à caixa do eixo. Uma segunda OCR que
   * chegue perto desse mesmo preço confirma que a régua mudou de verdade; uma
   * que volte a concordar com a régua em vigor derruba a suspeita.
   */
  private ocrEmQuarentena: { precoDaCaixa: number; emSeg: number } | null = null;
  /** Força OCR no próximo frame, sem esperar recuo — há suspeita aberta. */
  private confirmacaoPendente = false;
  private readonly intervaloOcr: number;
  private readonly recuoFalha: number;

  private readonly opcoesDoLedger: LedgerDeLeituras | undefined;

  constructor(
    private readonly ativo: string,
    opcoes: OpcoesDoCalibrador = {},
  ) {
    this.intervaloOcr = opcoes.intervaloOcrSeg ?? 8;
    this.recuoFalha = opcoes.recuoAposFalhaSeg ?? 2;
    this.opcoesDoLedger = opcoes.ledger;
  }

  snapshot(alturaFrame: number): EstadoDaCalibracao {
    return this.estado ?? estadoInicial(alturaFrame);
  }

  /**
   * Atualiza a régua para este frame. Decide sozinho entre propagar e ler.
   *
   * Ordem: (1) medir a grade por geometria — sempre; (2) se há régua em vigor
   * e o passo não mudou, propagar e validar; (3) se não há régua, ou a
   * propagação reprovou, ou venceu o intervalo de revalidação: OCR.
   */
  async atualizar(frame: PixelFrame, segundoNoVideo: number): Promise<EstadoDaCalibracao> {
    const anterior = this.snapshot(frame.height);
    const geo = detectarLinhasDoEixo(frame);

    let estado = anterior;
    let precisaOcr = !anterior.utilizavel || this.confirmacaoPendente;

    if (anterior.utilizavel) {
      const propagado = this.propagar(anterior, geo, frame.height);
      estado = propagado;
      if (!propagado.utilizavel) precisaOcr = true;
      if (
        anterior.ultimaOcrEmSeg !== null &&
        segundoNoVideo - anterior.ultimaOcrEmSeg >= this.intervaloOcr
      ) {
        precisaOcr = true;
      }
    }

    if (precisaOcr) {
      const podeTentar =
        this.confirmacaoPendente || // a segunda opinião é imediata, por definição
        this.ultimaTentativaSeg === null ||
        segundoNoVideo - this.ultimaTentativaSeg >= this.recuoFalha ||
        estado.utilizavel; // revalidação agendada não espera recuo
      if (podeTentar) {
        this.ultimaTentativaSeg = segundoNoVideo;
        const lido = await this.lerPorOcr(frame, geo, estado, segundoNoVideo);
        // Se a OCR falhou mas a propagação estava válida, a propagação segue.
        estado =
          lido.utilizavel || !estado.utilizavel
            ? lido
            : { ...estado, ocrChamadas: lido.ocrChamadas, ocrFalhas: lido.ocrFalhas };
      }
    }

    this.estado = estado;
    return estado;
  }

  /** Propaga a grade conhecida para as linhas medidas neste frame. */
  private propagar(
    ant: EstadoDaCalibracao,
    geo: LinhasDoEixo,
    alturaFrame: number,
  ): EstadoDaCalibracao {
    const base = { ...ant, linhasDetectadas: geo.linhas.length };
    if (
      geo.passoPx === null ||
      geo.linhas.length < 4 ||
      ant.passoPx === null ||
      ant.passoPrecoPorLinha === null
    ) {
      return this.semEscala(
        base,
        "GRADE_NAO_ENCONTRADA",
        "Grade do eixo não encontrada neste frame.",
        alturaFrame,
      );
    }
    // Zoom/rescale muda o passo em pixels: a régua antiga não descreve mais o eixo.
    if (Math.abs(geo.passoPx - ant.passoPx) / ant.passoPx > 0.1) {
      return this.semEscala(
        base,
        "PASSO_MUDOU",
        `Passo da grade mudou (${ant.passoPx.toFixed(1)}→${geo.passoPx.toFixed(1)}px): recalibrar.`,
        alturaFrame,
      );
    }

    const tol = geo.passoPx * 0.45;
    const conhecidas = ant.grade.filter((g) => g.price !== null);
    // 1. Linhas conhecidas que continuam visíveis: seguem, com o novo y.
    const nova: LinhaDaGrade[] = [];
    for (const l of geo.linhas) {
      let melhor: LinhaDaGrade | null = null;
      let dist = Number.POSITIVE_INFINITY;
      for (const g of conhecidas) {
        const d = Math.abs(g.y - l);
        if (d < dist) {
          dist = d;
          melhor = g;
        }
      }
      nova.push(
        melhor !== null && dist <= tol
          ? { y: l, price: melhor.price, origem: "PROPAGADO" }
          : { y: l, price: null, origem: "PROPAGADO" },
      );
    }
    // 2. Linhas novas nas bordas recebem vizinha ± passo (grade uniforme).
    const preencher = (): boolean => {
      let mudou = false;
      for (let i = 0; i < nova.length; i++) {
        if (nova[i]!.price !== null) continue;
        const ant1 = nova[i - 1];
        const prox = nova[i + 1];
        if (ant1 && ant1.price !== null && Math.abs(nova[i]!.y - ant1.y - geo.passoPx!) <= tol) {
          nova[i]!.price = ant1.price - ant.passoPrecoPorLinha!;
          mudou = true;
        } else if (
          prox &&
          prox.price !== null &&
          Math.abs(prox.y - nova[i]!.y - geo.passoPx!) <= tol
        ) {
          nova[i]!.price = prox.price + ant.passoPrecoPorLinha!;
          mudou = true;
        }
      }
      return mudou;
    };
    while (preencher()) {
      /* propaga até estabilizar */
    }

    const ancoras: ScaleAnchor[] = nova
      .filter((g) => g.price !== null)
      .map((g) => ({
        y: g.y,
        price: g.price!,
        raw: String(g.price),
        source: "ocr" as const,
        confidence: 0.8,
      }));
    return this.fechar(base, ancoras, nova, geo, "PROPAGADA", alturaFrame, ant.propagacoes + 1);
  }

  /** Lê o eixo pelo modelo e casa com a geometria. */
  private async lerPorOcr(
    frame: PixelFrame,
    geo: LinhasDoEixo,
    ant: EstadoDaCalibracao,
    segundoNoVideo: number,
  ): Promise<EstadoDaCalibracao> {
    const base = { ...ant, ocrChamadas: ant.ocrChamadas + 1, linhasDetectadas: geo.linhas.length };
    const alturaFrame = frame.height;
    if (geo.passoPx === null || geo.linhas.length < 4) {
      return this.semEscala(
        { ...base, ocrFalhas: base.ocrFalhas + 1 },
        "GRADE_NAO_ENCONTRADA",
        "Grade do eixo não encontrada — OCR não tem onde ancorar.",
        alturaFrame,
      );
    }

    /*
     * LEITURA RÓTULO A RÓTULO — cada par (y, preço) já nasce ligado.
     *
     * O QUE ISTO SUBSTITUI, e por que a substituição foi obrigatória. Antes a
     * régua inteira ia numa leitura só e depois eu tentava casar os valores
     * com as linhas medidas. Não funciona, e a razão é estrutural: as duas
     * sequências são PERIÓDICAS — rótulos a um passo de preço constante (450
     * pontos), linhas a um passo de pixel constante (22,0 px). Qualquer
     * deslocamento inteiro entre elas produz um ajuste perfeito. Medido: a
     * calibração "aprovou" com R² = 1,00000 e projetou 202.295 onde a verdade
     * de pixel era 194.609 — 7.700 pontos de erro com selo de aprovação.
     *
     * Lendo UM rótulo por vez o problema deixa de existir: a POSIÇÃO vem da
     * geometria, que é exata, e o VALOR vem de uma leitura curta sobre a
     * imagem ampliada daquela linha. Não há casamento — e onde não há
     * casamento não há ambiguidade. Medido: 1,1–1,5 s por rótulo, três
     * rótulos reconstruindo a reta com ~7 px de erro contra a referência.
     */
    // QUATRO rótulos: o mínimo da reta é 4 e `calibrateRobust` precisa de uma
    // sobra para descartar o que não pertencer à linha.
    const alvos = linhasParaLer(geo.linhas, 4);
    const lidos: ScaleAnchor[] = [];
    for (const y of alvos) {
      const preco = await lerRotuloNaLinha(frame, y, geo.colunas, this.ativo, this.opcoesDoLedger);
      if (preco === null) continue;
      lidos.push({ y, price: preco, raw: String(preco), source: "ocr", confidence: 0.95 });
    }
    if (lidos.length < 2) {
      return this.semEscala(
        { ...base, ocrFalhas: base.ocrFalhas + 1, rotulosOcr: lidos.length },
        "OCR_VAZIO",
        `Só ${lidos.length} rótulo(s) do eixo puderam ser lidos.`,
        alturaFrame,
      );
    }

    const normalizados = normalizeScaleAnchorsForAsset(this.ativo, lidos);
    const problema = assetScaleIssue(this.ativo, normalizados);
    if (problema !== null) {
      return this.semEscala(
        { ...base, ocrFalhas: base.ocrFalhas + 1, rotulosOcr: normalizados.length },
        "FORA_DA_FAIXA",
        problema,
        alturaFrame,
      );
    }

    const casados = [...normalizados].sort((a, b) => a.y - b.y);
    const deslocamentoPx = 0;
    /*
     * QUEM JULGA O AJUSTE É `calibrateRobust`, não um teste próprio.
     *
     * Havia aqui um teste de uniformidade da grade que barrava a calibração
     * ANTES do ajuste: bastava um rótulo destoante para a razão entre vizinhos
     * estourar a tolerância. Era um portão frágil na frente de um robusto —
     * `calibrateRobust` faz regressão ponderada, descarta o rótulo fora da
     * reta e só aprova com R² ≥ 0,9995 e desvio ≤ 2,5 px. O passo de preço
     * continua sendo calculado, porque a propagação depende dele, mas como
     * INFORMAÇÃO, nunca como veto.
     */
    const uni = gradeUniforme(casados);

    // A OCR revalida a propagação: discordância de valor na mesma linha conta.
    let corrigidas = ant.propagacaoCorrigida;
    if (ant.utilizavel && ant.origem === "PROPAGADA") {
      for (const c of casados) {
        const g = ant.grade.find(
          (x) => x.price !== null && Math.abs(x.y - c.y) <= geo.passoPx! * 0.45,
        );
        // 1% do passo quando ele é conhecido; senão, 1 ponto de tolerância.
        const tolDeValor = uni.passoPreco === null ? 1 : uni.passoPreco * 0.01;
        if (g && g.price !== null && Math.abs(g.price - c.price) > tolDeValor) corrigidas++;
      }
    }

    const grade: LinhaDaGrade[] = geo.linhas.map((l) => {
      const c = casados.find((x) => Math.abs(x.y - l) < 0.5);
      return { y: l, price: c ? c.price : null, origem: "OCR" as const };
    });

    const fechado = this.fechar(
      {
        ...base,
        rotulosOcr: normalizados.length,
        casados: casados.length,
        deslocamentoOcrPx: deslocamentoPx,
        propagacaoCorrigida: corrigidas,
        passoPreco: uni.passoPreco,
      },
      casados,
      grade,
      geo,
      "OCR",
      alturaFrame,
      ant.propagacoes,
    );
    if (!fechado.utilizavel) {
      this.confirmacaoPendente = false;
      this.ocrEmQuarentena = null;
      return { ...fechado, ocrFalhas: fechado.ocrFalhas + 1 };
    }
    return this.julgarPelaContinuidade(fechado, ant, frame, segundoNoVideo);
  }

  /**
   * A RÉGUA NOVA PRECISA EXPLICAR O MESMO PREÇO QUE A ANTIGA — ou ser
   * confirmada por uma segunda leitura.
   *
   * O DEFEITO QUE ISTO FECHA, medido no vídeo de março: com a propagação já
   * corrigida, a régua ficou estável por 100 frames seguidos (preço por pixel
   * constante em −12,6) e então a OCR de 16,8 s reancorou o eixo 571 pontos
   * abaixo — cerca de duas linhas da grade — de um frame para o outro. Não foi
   * o mercado: 571 pontos em 1,2 minuto de pregão, com a caixa do eixo andando
   * 13 px. Foi a leitura de rótulo pulando linha.
   *
   * O portão de R² não pega isso e nunca pegaria: quatro rótulos lidos com o
   * MESMO deslocamento formam uma reta perfeita. O que denuncia o erro não é a
   * geometria do eixo, é a FÍSICA do preço — ele é contínuo, e nenhuma
   * mudança de escala do gráfico muda o valor que o mercado está negociando.
   *
   * Então a régua nova é confrontada com a antiga sobre a MESMA caixa do eixo,
   * no MESMO frame. Divergindo além do que o tempo decorrido permite, ela não
   * entra: fica em quarentena, a régua em vigor continua valendo, e a próxima
   * OCR decide. Se a segunda leitura repetir o preço da primeira, a mudança é
   * real e é aceita; se voltar a concordar com a régua antiga, a suspeita cai.
   *
   * ACEITAR POR OMISSÃO É O QUE NÃO PODE: sem régua em vigor, ou sem caixa
   * para comparar, não há o que confrontar e a OCR entra — mas aí ela é a
   * única fonte, não uma troca silenciosa de uma fonte estável por outra.
   */
  private julgarPelaContinuidade(
    novo: EstadoDaCalibracao,
    ant: EstadoDaCalibracao,
    frame: PixelFrame,
    segundoNoVideo: number,
  ): EstadoDaCalibracao {
    const aceitar = (e: EstadoDaCalibracao): EstadoDaCalibracao => {
      const confirmada = this.confirmacaoPendente && this.ocrEmQuarentena !== null;
      this.confirmacaoPendente = false;
      this.ocrEmQuarentena = null;
      return {
        ...e,
        ocrConfirmadas: confirmada ? e.ocrConfirmadas + 1 : e.ocrConfirmadas,
        ultimaOcrEmSeg: segundoNoVideo,
      };
    };

    const yCaixa = detectarCaixaDePreco(frame);
    if (!ant.utilizavel || yCaixa === null) return aceitar(novo);
    const precoNovo = priceAt(novo.calibracao, yCaixa);
    const precoAntigo = priceAt(ant.calibracao, yCaixa);
    if (precoNovo === null || precoAntigo === null) return aceitar(novo);

    /*
     * O LIMITE CRESCE COM O TEMPO PARADO, porque o mercado anda.
     *
     * `SALTO_BASE` é o que o WINFUT pode andar entre dois frames vizinhos da
     * varredura densa; a parcela por segundo cobre as pausas em que a régua
     * ficou propagando sem OCR. Generoso de propósito: esta trava existe para
     * pegar erro de LINHA (centenas de pontos de uma vez), não para julgar
     * movimento de mercado.
     */
    const paradoSeg =
      ant.ultimaOcrEmSeg === null ? 0 : Math.max(0, segundoNoVideo - ant.ultimaOcrEmSeg);
    const limite = SALTO_BASE + paradoSeg * SALTO_POR_SEGUNDO;
    const salto = Math.abs(precoNovo - precoAntigo);
    if (salto <= limite) return aceitar(novo);

    const quarentena = this.ocrEmQuarentena;
    if (quarentena !== null && Math.abs(precoNovo - quarentena.precoDaCaixa) <= SALTO_BASE) {
      // Segunda leitura independente dizendo a mesma coisa: a régua mudou mesmo.
      return aceitar(novo);
    }

    this.ocrEmQuarentena = { precoDaCaixa: precoNovo, emSeg: segundoNoVideo };
    this.confirmacaoPendente = true;
    return {
      ...ant,
      ocrChamadas: novo.ocrChamadas,
      ocrRecusadasPorSalto: ant.ocrRecusadasPorSalto + 1,
      ultimaMensagem:
        `OCR em quarentena: reancorava a caixa do eixo em ${Math.round(precoNovo)} ` +
        `onde a régua em vigor lê ${Math.round(precoAntigo)} (salto de ${Math.round(salto)} ` +
        `pontos, limite ${Math.round(limite)}). Régua anterior mantida até uma segunda leitura.`,
    };
  }

  /** Ajusta a reta sobre as âncoras e aplica os portões. */
  private fechar(
    base: EstadoDaCalibracao,
    ancoras: ScaleAnchor[],
    grade: LinhaDaGrade[],
    geo: LinhasDoEixo,
    origem: "OCR" | "PROPAGADA",
    alturaFrame: number,
    propagacoes: number,
  ): EstadoDaCalibracao {
    if (ancoras.length < 4) {
      return this.semEscala(
        { ...base, grade, propagacoes },
        "ROTULOS_INSUFICIENTES",
        `${ancoras.length} linha(s) com valor — mínimo 4 para a reta valer.`,
        alturaFrame,
      );
    }
    const reta = calibrateRobust(ancoras);
    if (!reta.usable) {
      return this.semEscala({ ...base, grade, propagacoes }, "RETA_RUIM", reta.reason, alturaFrame);
    }
    if (reta.slope >= 0) {
      return this.semEscala(
        { ...base, grade, propagacoes },
        "ESCALA_INVERTIDA",
        "Escala invertida: preço subindo com Y.",
        alturaFrame,
      );
    }
    const faixa = plausiblePriceRange(this.ativo);
    if (faixa !== null) {
      const topo = reta.intercept;
      const fundo = reta.intercept + reta.slope * alturaFrame;
      if ([topo, fundo].some((p) => p < faixa.min || p > faixa.max)) {
        return this.semEscala(
          { ...base, grade, propagacoes },
          "FORA_DA_FAIXA",
          `Reta projeta ${fundo.toFixed(0)}–${topo.toFixed(0)}, fora da faixa do ${this.ativo}.`,
          alturaFrame,
        );
      }
    }
    const uni = gradeUniforme(ancoras);
    /*
     * O PASSO POR LINHA SAI DA RETA, não da contagem de rótulos: preço por
     * pixel vezes o passo da grade em pixels. É a única forma que não depende
     * de quantas linhas o Profit desenha entre dois rótulos.
     */
    const passoPrecoPorLinha =
      geo.passoPx !== null && geo.passoPx > 0
        ? Math.abs(reta.slope) * geo.passoPx
        : base.passoPrecoPorLinha;
    return {
      ...base,
      calibracao: reta,
      utilizavel: true,
      motivo: null,
      origem,
      grade,
      passoPx: geo.passoPx,
      passoPreco: uni.passoPreco ?? base.passoPreco,
      passoPrecoPorLinha,
      r2: reta.r2,
      desvioMaxPx: reta.maxResidualPx,
      confianca: reta.confidence,
      precoPorPixel: Math.abs(reta.slope),
      propagacoes,
      ultimaMensagem: `${origem}: ${ancoras.length} linhas · R² ${reta.r2.toFixed(5)} · desvio ${reta.maxResidualPx.toFixed(2)}px · passo ${geo.passoPx?.toFixed(1)}px/${uni.passoPreco ?? "?"}pts`,
    };
  }

  private semEscala(
    base: EstadoDaCalibracao,
    motivo: MotivoSemEscala,
    mensagem: string,
    alturaFrame: number,
  ): EstadoDaCalibracao {
    return {
      ...base,
      calibracao: geometricCalibration(alturaFrame),
      utilizavel: false,
      motivo,
      origem: "NENHUMA",
      precoPorPixel: null,
      r2: 0,
      desvioMaxPx: Number.POSITIVE_INFINITY,
      confianca: 0,
      ultimaMensagem: mensagem,
    };
  }
}

/**
 * ONDE ESTÁ A CAIXA DO PREÇO ATUAL — geometria pura, nenhum modelo.
 *
 * A etiqueta do último preço é a única coisa ESCURA na coluna dos rótulos:
 * texto branco sobre caixa preta, contra rótulos cinza em fundo claro. Achar a
 * faixa de linhas com maioria de pixels escuros nas colunas do eixo é achar a
 * caixa — e o centro dela, convertido pela régua calibrada, é o preço atual.
 *
 * Foi exatamente esta medição que serviu de VERDADE para validar a calibração
 * (y=384 valendo 194.609 no frame de referência): agora ela vira leitura de
 * produção do vídeo.
 */
export function detectarCaixaDePreco(frame: PixelFrame): number | null {
  const geo = detectarLinhasDoEixo(frame);
  if (geo.colunas === null) return null;
  const [x0, x1] = geo.colunas;
  const { data, width: W, height: H } = frame;
  const yIni = Math.floor(H * Y_MIN);
  const yFim = Math.ceil(H * Y_MAX);
  const largura = Math.max(1, x1 - x0 + 1);
  const limiar = Math.max(4, Math.round(largura * 0.45));

  /*
   * MEDIDO NO MATERIAL REAL (frame de 121s): o fundo da caixa tem lum ~110 —
   * cinza-escuro, não preto — enquanto os rótulos vivem em 90–205 mas nunca
   * ocupam 45% da largura numa linha. E as MARGENS do eixo (borda da toolbar
   * no topo, faixa de abas embaixo) também são escuras: banda que ENCOSTA na
   * margem é moldura, não caixa, e é recusada.
   */
  interface Banda {
    ini: number;
    fim: number;
  }
  const bandas: Banda[] = [];
  let ini = -1;
  for (let y = yIni; y <= yFim; y++) {
    let escuros = 0;
    if (y < yFim) {
      for (let x = x0; x <= x1; x++) {
        if (luma(data, (y * W + x) * 4) < 130) escuros++;
      }
    }
    const tem = y < yFim && escuros >= limiar;
    if (tem && ini < 0) ini = y;
    else if (!tem && ini >= 0) {
      bandas.push({ ini, fim: y - 1 });
      ini = -1;
    }
  }

  const candidatas = bandas.filter((b) => {
    const altura = b.fim - b.ini + 1;
    if (altura < 6 || altura > 30) return false;
    // Encostou na margem = moldura do layout, não etiqueta de preço.
    return b.ini > yIni + 2 && b.fim < yFim - 3;
  });
  if (candidatas.length === 0) return null;
  // Mais de uma candidata plausível = ambiguidade; melhor nenhum preço do que
  // o preço de outra etiqueta qualquer.
  if (candidatas.length > 1) return null;
  const caixa = candidatas[0]!;
  return (caixa.ini + caixa.fim) / 2;
}
