import { detectChartBounds } from "./chartRoi";
import { estimateBackground, isInk } from "./inkModel";
/**
 * MUDANÇA DE ESCALA E DE JANELA — o gráfico virou outro, os níveis não (§6).
 *
 * O DEFEITO QUE ISTO ENCERRA (print 024 da sessão de 19/08): o operador mexeu
 * fortemente na escala/enquadramento e depois voltou. Naquele frame, TUDO o que
 * o sistema mede visualmente mudou de significado ao mesmo tempo — distância em
 * pixels, densidade de candles, altura do ponto por preço. O sistema, que
 * compara frames como se fossem o mesmo viewport, leu aquilo como movimento de
 * mercado: níveis foram reescritos, distâncias "encurtaram", e a leitura só
 * voltou ao lugar quando o operador desfez o zoom.
 *
 * A REGRA: viewport mudou ⇒ NADA de sobrescrever nível automaticamente, NADA de
 * comparar distância visual com a do frame anterior, o setup existente é
 * PRESERVADO, a leitura é recalibrada, e a confirmação da T4 espera um frame
 * ESTÁVEL. Não é invalidação — é suspensão de julgamento enquanto a régua não
 * volta a medir a mesma coisa.
 *
 * DUAS CATEGORIAS, porque as consequências diferem:
 *   SCALE_CHANGED    — a régua de preço mudou (faixa/altura). A conversão
 *                      pixel↔preço anterior está morta; recalibrar é obrigatório.
 *   VIEWPORT_CHANGED — a janela mudou (zoom, quantidade de candles, período,
 *                      layout). A régua pode até valer, mas o CAMPO DE VISÃO é
 *                      outro: "sumiu da tela" não é "foi rompido".
 *
 * CAMPO NULO NÃO GERA MUDANÇA. Uma medida que não pôde ser lida num dos frames é
 * ausência de evidência — afirmar mudança sobre ela produziria alarme a cada
 * falha de OCR, e alarme constante é o mesmo que alarme nenhum.
 */

export type ViewportChangeKind = "SCALE_CHANGED" | "VIEWPORT_CHANGED";

export interface ViewportSignature {
  /** Faixa de preço visível no eixo (mín/máx das etiquetas lidas). */
  priceMin: number | null;
  priceMax: number | null;
  /** Pixels por ponto de preço — a escala vertical propriamente dita. */
  pixelsPerPoint: number | null;
  /** Quantidade de candles visíveis no enquadramento. */
  candleCount: number | null;
  /** Largura média de um candle em pixels — a densidade/zoom horizontal. */
  candleWidthPx: number | null;
  /** Janela temporal visível, em minutos (do primeiro ao último candle). */
  timeSpanMinutes: number | null;
  /** Assinatura do layout: dimensões do frame + área do gráfico + ativo. */
  layoutHash: string | null;
}

export interface ViewportChange {
  changed: boolean;
  kinds: ViewportChangeKind[];
  /** Uma frase por medida que mudou. Vazio quando nada mudou. */
  reasons: string[];
  /** Bloqueia confirmação até um frame estável chegar. */
  bloqueiaConfirmacao: boolean;
  /** A régua pixel↔preço precisa ser refeita. */
  exigeRecalibracao: boolean;
}

/**
 * Limiares de RELEVÂNCIA.
 *
 * Todos relativos, e todos folgados o bastante para ignorar ruído de OCR e
 * antialiasing: o gráfico rola sozinho a cada minuto, e um detector nervoso
 * pausaria a T4 o pregão inteiro. O que estes números pegam é o gesto do
 * operador — zoom, arrasto de escala, troca de layout —, nunca o mercado andando.
 */
const PRICE_RANGE_TOLERANCE = 0.1; // 10% da faixa
const PIXELS_PER_POINT_TOLERANCE = 0.1; // 10%
const CANDLE_COUNT_TOLERANCE = 0.25; // 25% de candles a mais/menos
const CANDLE_WIDTH_TOLERANCE = 0.2; // 20%
const TIME_SPAN_TOLERANCE = 0.25; // 25%

function variouRelativo(antes: number | null, depois: number | null, tolerancia: number): boolean {
  if (antes === null || depois === null) return false;
  const base = Math.max(Math.abs(antes), Number.EPSILON);
  return Math.abs(depois - antes) / base > tolerancia;
}

export function emptyViewportSignature(): ViewportSignature {
  return {
    priceMin: null,
    priceMax: null,
    pixelsPerPoint: null,
    candleCount: null,
    candleWidthPx: null,
    timeSpanMinutes: null,
    layoutHash: null,
  };
}

export function detectViewportChange(
  previous: ViewportSignature | null,
  current: ViewportSignature,
): ViewportChange {
  if (previous === null) {
    return {
      changed: false,
      kinds: [],
      reasons: [],
      bloqueiaConfirmacao: false,
      exigeRecalibracao: false,
    };
  }

  const kinds = new Set<ViewportChangeKind>();
  const reasons: string[] = [];

  const faixaAntes =
    previous.priceMin !== null && previous.priceMax !== null
      ? previous.priceMax - previous.priceMin
      : null;
  const faixaDepois =
    current.priceMin !== null && current.priceMax !== null
      ? current.priceMax - current.priceMin
      : null;
  if (variouRelativo(faixaAntes, faixaDepois, PRICE_RANGE_TOLERANCE)) {
    kinds.add("SCALE_CHANGED");
    reasons.push(
      `faixa de preço do eixo mudou de ${faixaAntes?.toFixed(0)} para ${faixaDepois?.toFixed(0)} pontos`,
    );
  }
  if (variouRelativo(previous.pixelsPerPoint, current.pixelsPerPoint, PIXELS_PER_POINT_TOLERANCE)) {
    kinds.add("SCALE_CHANGED");
    reasons.push("escala vertical (pixels por ponto) mudou — a régua anterior não vale mais");
  }
  if (variouRelativo(previous.candleCount, current.candleCount, CANDLE_COUNT_TOLERANCE)) {
    kinds.add("VIEWPORT_CHANGED");
    reasons.push(
      `quantidade de candles visíveis mudou de ${previous.candleCount} para ${current.candleCount}`,
    );
  }
  if (variouRelativo(previous.candleWidthPx, current.candleWidthPx, CANDLE_WIDTH_TOLERANCE)) {
    kinds.add("VIEWPORT_CHANGED");
    reasons.push("densidade/zoom horizontal mudou");
  }
  if (variouRelativo(previous.timeSpanMinutes, current.timeSpanMinutes, TIME_SPAN_TOLERANCE)) {
    kinds.add("VIEWPORT_CHANGED");
    reasons.push(
      `janela temporal mudou de ${previous.timeSpanMinutes} para ${current.timeSpanMinutes} minutos`,
    );
  }
  if (
    previous.layoutHash !== null &&
    current.layoutHash !== null &&
    previous.layoutHash !== current.layoutHash
  ) {
    kinds.add("VIEWPORT_CHANGED");
    kinds.add("SCALE_CHANGED");
    reasons.push("layout do gráfico mudou (dimensão, área do gráfico ou ativo)");
  }

  const lista = [...kinds];
  return {
    changed: lista.length > 0,
    kinds: lista,
    reasons,
    bloqueiaConfirmacao: lista.length > 0,
    exigeRecalibracao: kinds.has("SCALE_CHANGED"),
  };
}

/**
 * PORTÃO DE ESTABILIDADE — depois da mudança, um frame estável antes de confirmar.
 *
 * Exigir DOIS frames iguais em vez de um é deliberado: o primeiro frame após um
 * gesto de zoom costuma pegar o gráfico no meio do redesenho, e ele "estabiliza"
 * contra si mesmo. O portão só abre quando duas leituras consecutivas concordam
 * — que é a definição operacional de "a mão saiu do mouse".
 */
export const FRAMES_ESTAVEIS_EXIGIDOS = 2;

export interface ViewportGateState {
  signature: ViewportSignature | null;
  /** Frames consecutivos sem mudança relevante desde a última alteração. */
  estaveis: number;
  /** Houve mudança e o portão ainda não reabriu. */
  aguardandoEstabilidade: boolean;
  ultimaMudanca: ViewportChange | null;
}

export function emptyViewportGate(): ViewportGateState {
  return { signature: null, estaveis: 0, aguardandoEstabilidade: false, ultimaMudanca: null };
}

export interface ViewportGateStep {
  state: ViewportGateState;
  change: ViewportChange;
  /** A T4 pode confirmar neste frame? False enquanto o viewport não estabiliza. */
  liberaConfirmacao: boolean;
  /** Motivo do bloqueio. Null quando liberado. */
  motivo: string | null;
}

export function stepViewportGate(
  state: ViewportGateState,
  current: ViewportSignature,
  framesExigidos = FRAMES_ESTAVEIS_EXIGIDOS,
): ViewportGateStep {
  const change = detectViewportChange(state.signature, current);

  if (change.changed) {
    return {
      state: {
        signature: current,
        estaveis: 0,
        aguardandoEstabilidade: true,
        ultimaMudanca: change,
      },
      change,
      liberaConfirmacao: false,
      motivo: `${change.kinds.join(" + ")}: ${change.reasons[0] ?? "viewport alterado"} — leitura recalibrando, confirmação suspensa`,
    };
  }

  // Primeiro frame da sessão: não houve mudança porque não havia com o que
  // comparar. Ele conta como estável — bloquear aqui pausaria a T4 na abertura.
  const estaveis = state.signature === null ? framesExigidos : state.estaveis + 1;
  const estabilizou = estaveis >= framesExigidos;
  return {
    state: {
      signature: current,
      estaveis,
      aguardandoEstabilidade: state.aguardandoEstabilidade && !estabilizou,
      ultimaMudanca: state.ultimaMudanca,
    },
    change,
    liberaConfirmacao: !state.aguardandoEstabilidade || estabilizou,
    motivo:
      state.aguardandoEstabilidade && !estabilizou
        ? `aguardando frame estável após ${state.ultimaMudanca?.kinds.join(" + ") ?? "mudança de viewport"} (${estaveis}/${framesExigidos})`
        : null,
  };
}

/* ------------------------------------------------------------------------ *
 * §7 — GRÁFICO CORTADO (VIEWPORT_CLIPPED)
 *
 * Isto NÃO é uma comparação entre prints: é um julgamento sobre UM frame. O
 * gráfico ultrapassou a janela e os candles estão cortados na borda.
 *
 * O caso que originou: o print de 19/08 em que o preço subiu além do
 * enquadramento e as barras chegaram cortadas no topo da tela. Nesse estado a
 * IA não enxerga topo completo, máxima estrutural, resistência seguinte nem
 * espaço até o alvo — e qualquer stop, alvo ou R:R calculado ali é invenção
 * sobre o que ficou fora da imagem. A resposta certa é RECUSAR os números, não
 * estimá-los com o que sobrou.
 * ------------------------------------------------------------------------ */

/** Fração da altura do gráfico examinada em cada borda. */
const FAIXA_DE_BORDA = 0.04;

/**
 * Quantas colunas da faixa precisam ter tinta para chamar de corte.
 *
 * O gráfico normalmente tem MARGEM: o candle mais alto não encosta na moldura.
 * Tinta espalhada por um quinto das colunas bem na borda é a assinatura de um
 * gráfico que estourou o enquadramento — e não de um candle isolado que por
 * acaso ficou alto.
 */
const COLUNAS_COM_TINTA_NA_BORDA = 0.2;

export interface ClippingReport {
  /** O gráfico está cortado em alguma borda? */
  clipped: boolean;
  topo: boolean;
  fundo: boolean;
  /** Sempre presente quando `clipped`; string vazia quando não há corte. */
  reason: string;
  /**
   * A PERGUNTA PÔDE SER RESPONDIDA?
   *
   * `clipped: false` tem DOIS significados muito diferentes: "medi e não há
   * corte" e "não consegui medir". Sem este campo os dois viram o mesmo
   * silêncio na tela, e um detector cego passaria por um detector calmo — que
   * é a forma mais cara de errar num sistema que existe para dizer o que não
   * sabe. Ausência é um VALOR, nunca um zero.
   *
   * Não é gate: `false` aqui não bloqueia nada. É telemetria, e é ela que a
   * sessão real do §45 vai contar para decidir se o detector serve.
   */
  avaliavel: boolean;
}

/**
 * A resposta "medi, e não há corte".
 *
 * Exportada porque quem termina a medição sem achar corte precisa devolver
 * exatamente esta resposta, e não uma cópia que possa divergir depois.
 */
export const NO_CLIPPING: ClippingReport = {
  clipped: false,
  topo: false,
  fundo: false,
  reason: "",
  avaliavel: true,
};

/**
 * A resposta "não consegui medir" — imagem ilegível, área do gráfico não
 * localizada, grade incompleta.
 *
 * `clipped: false` igual ao de cima, e de propósito: quem não sabe NÃO acusa,
 * porque acusar sem evidência pausaria a T4 por falta de informação. O que
 * muda é `avaliavel`, e é ele que impede o silêncio de virar prova.
 */
export const CLIPPING_NAO_AVALIAVEL: ClippingReport = {
  clipped: false,
  topo: false,
  fundo: false,
  reason: "",
  avaliavel: false,
};

const SEM_CORTE = NO_CLIPPING;

/**
 * Detecta gráfico cortado a partir do luma da JANELA CAPTURADA.
 *
 * DUAS COISAS MUDARAM DEPOIS DA SESSÃO REAL DE 20/08, E AS DUAS ERAM DEFEITO.
 *
 * 1. O FUNDO. Havia aqui uma cópia do histograma de 32 baldes — o mesmo trecho
 *    que vivia em `printCrop` e em mais um lugar. Ele assume fundo de um tom
 *    só, e o tema claro do Profit tem gradiente (luma 252 no alto, 205
 *    embaixo, contra limiar 26). Resultado medido: 83 de 83 capturas acusaram
 *    "cortado no topo E no fundo" em gráficos com margem sobrando dos dois
 *    lados. Agora o fundo vem do `inkModel`, estimado por linha, e é o MESMO
 *    modelo que o recorte usa — uma fonte, uma regra.
 *
 * 2. ONDE MEDIR. Media-se a borda da grade recebida. Quando essa grade é a
 *    janela inteira, a borda é barra de ferramentas e eixo de tempo — cromo,
 *    não candle. E quando é a ROI detectada por tinta, a medida é VACUOSA: a
 *    ROI é o envelope da tinta, então a tinta encosta na borda dela sempre.
 *    Agora a medida roda dentro da MOLDURA (`detectChartBounds`), que é
 *    geométrica: sai de onde o cromo termina e não se move com o desenho.
 *
 * Ausência de dado devolve NÃO AVALIÁVEL, e isso é deliberado em duas
 * camadas: o corte é uma AFIRMAÇÃO que bloqueia a leitura de níveis, e
 * afirmá-la sem evidência pararia a T4 por falta de informação — então quem
 * não sabe não acusa. Mas também não finge calma: `avaliavel: false` separa
 * "medi e está inteiro" de "não enxerguei".
 */
export function detectClipping(
  luma: ArrayLike<number>,
  width: number,
  height: number,
): ClippingReport {
  if (width <= 0 || height <= 0 || luma.length < width * height) {
    return CLIPPING_NAO_AVALIAVEL;
  }

  const moldura = detectChartBounds(luma, width, height);
  if (!moldura.usable) return CLIPPING_NAO_AVALIAVEL;

  const modelo = estimateBackground(luma, width, height);
  const { x0, y0, x1, y1 } = moldura.px;
  const larguraMoldura = x1 - x0 + 1;
  const alturaMoldura = y1 - y0 + 1;

  const linhasDaFaixa = Math.max(1, Math.round(alturaMoldura * FAIXA_DE_BORDA));
  const contaColunasComTinta = (de: number, ate: number): number => {
    let colunas = 0;
    for (let x = x0; x <= x1; x += 1) {
      for (let y = de; y < ate; y += 1) {
        if (isInk(Number(luma[y * width + x]), modelo.byRow[y]!)) {
          colunas += 1;
          break;
        }
      }
    }
    return colunas;
  };

  const minimo = Math.max(1, Math.round(larguraMoldura * COLUNAS_COM_TINTA_NA_BORDA));
  const topo = contaColunasComTinta(y0, y0 + linhasDaFaixa) >= minimo;
  const fundoCortado = contaColunasComTinta(y1 - linhasDaFaixa + 1, y1 + 1) >= minimo;

  if (!topo && !fundoCortado) return SEM_CORTE;
  const onde = topo && fundoCortado ? "no topo e no fundo" : topo ? "no topo" : "no fundo";
  return {
    clipped: true,
    topo,
    fundo: fundoCortado,
    reason:
      `gráfico cortado ${onde} do enquadramento — máxima/mínima estrutural fora da imagem; ` +
      "stop, alvo e R:R não são calculáveis a partir deste print",
    avaliavel: true,
  };
}

/** Rótulo da tela para o corte. Uma fonte, uma frase. */
export const CLIPPED_LABEL = "VIEWPORT_CLIPPED — GRÁFICO CORTADO";
