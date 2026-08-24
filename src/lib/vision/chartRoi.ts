import { columnCoverage, estimateBackground, rowCoverage } from "./inkModel";
/**
 * ONDE ESTÁ O GRÁFICO DENTRO DA IMAGEM CAPTURADA.
 *
 * O operador compartilha uma janela inteira do Profit, não um retângulo
 * recortado. Dentro dela há barra de ferramentas, book, lista de ativos,
 * rodapé — e o gráfico ocupa uma fração. Tratar a imagem toda como gráfico faz
 * o detector contar texto de menu como candle e a escala de preço como
 * estrutura.
 *
 * COORDENADAS RELATIVAS, SEMPRE
 * A ROI é expressa em frações de 0 a 1, nunca em pixels absolutos. Isso é o que
 * permite o operador arrastar a janela, mudar a resolução ou trocar de monitor
 * sem recalibrar nada — e é a razão de o `VisualMarketState` guardar a posição
 * dos pivôs em `x` fracionário.
 *
 * COMO A ÁREA É ENCONTRADA
 * Sem depender de cor ou tema: o gráfico é a região com maior densidade de
 * VARIAÇÃO VERTICAL entre colunas vizinhas. Candles produzem colunas de alturas
 * diferentes; menus, texto e áreas chapadas produzem colunas uniformes. Isso
 * sobrevive a tema claro, tema escuro e qualquer paleta de cores, porque mede
 * estrutura e não pigmento.
 */

export interface Roi {
  /** Frações 0–1 da imagem completa. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 0–100. Abaixo de 50 a área não é confiável e a leitura deve dizer isso. */
  confidence: number;
  detail: string;
}

/** ROI que cobre a imagem inteira — o palpite de partida, não uma detecção. */
export const FULL_FRAME: Roi = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  confidence: 0,
  detail: "área do gráfico ainda não detectada",
};

/**
 * Perfil de uma coluna da imagem. O detector de ROI trabalha sobre isto e não
 * sobre pixels, para poder ser testado sem canvas.
 */
export interface ColumnProfile {
  /** Quantidade de pixels "de conteúdo" (não-fundo) na coluna. */
  ink: number;
  /** Menor e maior linha com conteúdo, em fração 0–1 da altura. */
  top: number | null;
  bottom: number | null;
}

/**
 * Faixa horizontal ocupada pelo gráfico.
 *
 * O eixo de preço fica à direita e é uma faixa estreita de texto: tem tinta,
 * mas a extensão vertical do conteúdo dela é pequena e constante. Candles têm
 * extensão vertical variável. É essa variabilidade que separa os dois.
 */
export function detectHorizontalBand(columns: ColumnProfile[]): { start: number; end: number } {
  if (columns.length === 0) return { start: 0, end: 1 };

  const spans = columns.map((column) =>
    column.top === null || column.bottom === null ? 0 : column.bottom - column.top,
  );
  const maxSpan = Math.max(...spans);
  if (maxSpan <= 0) return { start: 0, end: 1 };

  // Coluna com conteúdo relevante é a que se estende por pelo menos um quinto
  // do maior alcance visto. O limiar é relativo de propósito: gráfico apertado
  // e gráfico em tela cheia precisam funcionar igual.
  const threshold = maxSpan * 0.2;
  let start = -1;
  let end = -1;
  for (let i = 0; i < spans.length; i += 1) {
    if (spans[i]! >= threshold) {
      if (start === -1) start = i;
      end = i;
    }
  }
  if (start === -1) return { start: 0, end: 1 };
  return { start: start / columns.length, end: (end + 1) / columns.length };
}

/**
 * Faixa vertical ocupada pelo gráfico.
 *
 * Deriva do envelope das colunas já filtradas: o topo é a menor linha com
 * conteúdo, o fundo é a maior. Uma margem é descartada nas pontas porque o
 * Profit desenha eixo de tempo embaixo e, às vezes, legenda em cima.
 */
export function detectVerticalBand(columns: ColumnProfile[]): { start: number; end: number } {
  const tops = columns.map((c) => c.top).filter((v): v is number => v !== null);
  const bottoms = columns.map((c) => c.bottom).filter((v): v is number => v !== null);
  if (tops.length === 0 || bottoms.length === 0) return { start: 0, end: 1 };
  return { start: Math.min(...tops), end: Math.max(...bottoms) };
}

/**
 * Detecta a área do gráfico a partir dos perfis de coluna.
 *
 * A confiança cai quando a área encontrada é grande demais (provavelmente não
 * separou nada) ou pequena demais (provavelmente pegou só um pedaço). Confiança
 * baixa não impede a leitura — ela é publicada, e o painel diz que a área é
 * incerta em vez de silenciosamente analisar a região errada.
 */
export function detectRoi(columns: ColumnProfile[]): Roi {
  if (columns.length < 8) {
    return { ...FULL_FRAME, detail: "imagem estreita demais para separar a área do gráfico" };
  }

  const horizontal = detectHorizontalBand(columns);
  const width = horizontal.end - horizontal.start;

  const inside = columns.slice(
    Math.floor(horizontal.start * columns.length),
    Math.ceil(horizontal.end * columns.length),
  );
  const vertical = detectVerticalBand(inside);
  const height = vertical.end - vertical.start;

  if (width <= 0.1 || height <= 0.1) {
    return { ...FULL_FRAME, detail: "área detectada pequena demais — usando o frame inteiro" };
  }

  const area = width * height;
  // Um gráfico costuma ocupar entre 30% e 95% da janela do Profit. Fora disso a
  // detecção provavelmente errou, e é melhor dizer do que afirmar.
  const plausible = area >= 0.25 && area <= 0.95;
  const confidence = plausible ? Math.round(60 + Math.min(35, area * 40)) : 35;

  return {
    x: horizontal.start,
    y: vertical.start,
    width,
    height,
    confidence,
    detail: plausible
      ? `área do gráfico: ${Math.round(width * 100)}% × ${Math.round(height * 100)}% da janela`
      : `área suspeita (${Math.round(area * 100)}% da janela) — confira o enquadramento`,
  };
}

/** Converte fração da imagem em fração DENTRO da ROI. */
export function toRoiSpace(roi: Roi, x: number, y: number): { x: number; y: number } {
  return {
    x: roi.width === 0 ? 0 : (x - roi.x) / roi.width,
    y: roi.height === 0 ? 0 : (y - roi.y) / roi.height,
  };
}

/** Caminho inverso, para desenhar sobreposição na imagem original. */
export function fromRoiSpace(roi: Roi, x: number, y: number): { x: number; y: number } {
  return { x: roi.x + x * roi.width, y: roi.y + y * roi.height };
}

/**
 * A ROI mudou o bastante para justificar redetecção?
 *
 * Redetectar a cada frame gastaria CPU e faria a leitura tremer. Só vale quando
 * a janela realmente mudou de forma — e uma tolerância generosa evita que
 * antialiasing de borda dispare redetecção sozinho.
 */
export function roiChangedSignificantly(previous: Roi, current: Roi): boolean {
  const delta =
    Math.abs(previous.x - current.x) +
    Math.abs(previous.y - current.y) +
    Math.abs(previous.width - current.width) +
    Math.abs(previous.height - current.height);
  return delta > 0.05;
}

export function roiUsable(roi: Roi): boolean {
  return roi.confidence >= 50;
}

/* ------------------------------------------------------------------------ *
 * A MOLDURA DO GRÁFICO — descascando o cromo pelas bordas.
 * ------------------------------------------------------------------------ */

/**
 * Fração da linha/coluna coberta por tinta a partir da qual ela é CROMO.
 *
 * Medido em 20 capturas reais de 20/08/2026, com o fundo adaptativo do
 * `inkModel`: barra de ferramentas e eixo de tempo dão 100%; gráfico vazio dá
 * 4%; gráfico com candles densos chega a 77%. O corte em 85% fica acima do
 * pior caso de candle e bem abaixo do cromo — e o cromo do Profit é chapado,
 * então ele satura em 100%, não em 86%.
 */
const COBERTURA_DE_CROMO = 0.85;

/**
 * Cobertura que MANTÉM uma faixa de cromo já começada — histerese.
 *
 * Sem ela o descascamento para no primeiro respiro do cromo, e o cromo do
 * Profit respira. Medido no print 001 (amostra 240×240):
 *
 *   barra:  linhas 0–3 em 98–100%, linhas 4–5 em 75–79%, 6–26 em 88–100%,
 *           linha 27 cai para 3% — ali começa o gráfico;
 *   rodapé: linha 197 em 3%, depois uma RAMPA 198–208 subindo de 50% a 91%,
 *           e 209–239 chapado em 98–100%.
 *
 * Um corte único não separa isso: 85% para na linha 4 e deixa a barra inteira
 * dentro da moldura; 50% chegaria perto de comer linha de candle denso (medida
 * em até 77%). Com histerese, só entra em cromo quem satura, e a faixa
 * continua enquanto não devolver para valor de gráfico.
 */
const COBERTURA_QUE_MANTEM_CROMO = 0.5;

/**
 * Teto do descascamento, por lado.
 *
 * Um gráfico REALMENTE estourado tem candles rente à borda; sem teto, uma
 * sequência de linhas densas seria descascada como se fosse moldura e o corte
 * sumiria justamente no caso que ele existe para detectar.
 */
const TETO_DE_DESCASCAMENTO = 0.3;

/** Cobertura a partir da qual uma linha participa de uma faixa de tinta. */
const TINTA_DE_FAIXA = 0.15;
/** Altura máxima de uma faixa para ela ainda poder ser um RÓTULO, e não candle. */
const ALTURA_MAXIMA_DE_ROTULO = 0.035;

/**
 * Remove RÓTULOS que sobraram nas pontas depois do descascamento de cromo.
 *
 * O caso concreto, medido no print 001 (amostra 240×240): a barra do Profit
 * ocupa as linhas 0–26, há um VÃO nas linhas 27–28 (3–7% de cobertura), e nas
 * linhas 29–31 vem o cabeçalho do gráfico — "WINFUT 1Min (Abr … Máx … Fch …)" —
 * cobrindo 25–28% da largura. O vão impede que a histerese continue, então o
 * cabeçalho fica DENTRO da moldura. Como o teste de corte acusa a partir de 20%
 * de colunas com tinta na borda, esse cabeçalho sozinho acusava corte: 74 dos
 * 83 prints da sessão real, todos com margem sobrando.
 *
 * O QUE SEPARA RÓTULO DE CANDLE CORTADO, e é o que esta função mede: um rótulo
 * é uma faixa FINA seguida de VÃO — texto tem três linhas e acaba. Um gráfico
 * estourado tem candles que descem CONTÍNUOS da borda para dentro do gráfico,
 * dezenas de linhas sem vão. Por isso só se remove faixa fina que termina em
 * vão; faixa que não termina fica, e é ela que faz o corte ser acusado.
 */
function descascarRotulos(
  perfil: Float64Array,
  ja: { ini: number; fim: number },
  n: number,
): { ini: number; fim: number } {
  const teto = Math.floor(n * TETO_DE_DESCASCAMENTO);
  const alturaMax = Math.max(1, Math.round(n * ALTURA_MAXIMA_DE_ROTULO));
  let { ini, fim } = ja;

  // Do topo para baixo: pula o vão, mede a faixa, remove se for fina.
  for (;;) {
    let p = ini;
    while (p < fim && perfil[p]! < TINTA_DE_FAIXA) p += 1;
    if (p >= fim || p - ini > alturaMax) break;
    let q = p;
    while (q <= fim && perfil[q]! >= TINTA_DE_FAIXA) q += 1;
    const altura = q - p;
    // Faixa grossa, ou que vai até o fim sem vão: é desenho, não rótulo.
    if (altura > alturaMax || q > fim || q > teto) break;
    ini = q;
  }

  // Do fundo para cima, mesma regra.
  for (;;) {
    let p = fim;
    while (p > ini && perfil[p]! < TINTA_DE_FAIXA) p -= 1;
    if (p <= ini || fim - p > alturaMax) break;
    let q = p;
    while (q >= ini && perfil[q]! >= TINTA_DE_FAIXA) q -= 1;
    const altura = p - q;
    if (altura > alturaMax || q < ini || q < n - 1 - teto) break;
    fim = q;
  }

  return { ini, fim };
}

export interface ChartBounds {
  /** Frações 0–1 da imagem. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Em pixels, para quem vai varrer o bitmap. */
  px: { x0: number; y0: number; x1: number; y1: number };
  /** Quantas linhas/colunas de cromo foram removidas de cada lado. */
  peeled: { top: number; bottom: number; left: number; right: number };
  /** A moldura é utilizável? Falso quando sobrou pouco, ou faltou pixel. */
  usable: boolean;
  /** Sempre preenchido, inclusive em sucesso. */
  reason: string;
}

const SEM_MOLDURA: ChartBounds = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  px: { x0: 0, y0: 0, x1: 0, y1: 0 },
  peeled: { top: 0, bottom: 0, left: 0, right: 0 },
  usable: false,
  reason: "sem pixels suficientes para localizar a moldura do gráfico",
};

/**
 * Descasca faixas de cromo coladas nas duas pontas de um perfil de cobertura.
 *
 * Histerese em cada ponta: a faixa só COMEÇA numa linha saturada, e continua
 * enquanto a cobertura não voltar a valor de gráfico. Ver a medida que motiva
 * cada limiar em `COBERTURA_QUE_MANTEM_CROMO`.
 */
function descascar(perfil: Float64Array, n: number): { ini: number; fim: number } {
  const teto = Math.floor(n * TETO_DE_DESCASCAMENTO);
  let ini = 0;
  let dentro = false;
  while (ini < teto) {
    const v = perfil[ini]!;
    if (!dentro && v >= COBERTURA_DE_CROMO) dentro = true;
    else if (!dentro || v < COBERTURA_QUE_MANTEM_CROMO) break;
    ini += 1;
  }
  let fim = n - 1;
  dentro = false;
  while (fim > n - 1 - teto) {
    const v = perfil[fim]!;
    if (!dentro && v >= COBERTURA_DE_CROMO) dentro = true;
    else if (!dentro || v < COBERTURA_QUE_MANTEM_CROMO) break;
    fim -= 1;
  }
  return { ini, fim };
}

/**
 * A ÁREA DE PLOTAGEM, encontrada pela MOLDURA e não pela tinta.
 *
 * A distinção decide se `detectClipping` responde alguma coisa. Se a área for o
 * envelope da tinta — que é o que `detectRoi` devolve, por `min(top)`/
 * `max(bottom)` — então a tinta encosta na borda dela SEMPRE, em todo gráfico,
 * cortado ou não, e perguntar "encostou na borda?" é vacuoso. A moldura é
 * geométrica: ela sai de onde o cromo termina, e não se move com o desenho.
 *
 * NADA AQUI É COORDENADA FIXA. As frações saem do bitmap de cada frame; foi
 * medido que elas convergem para y≈0,113 e altura≈0,73 tanto em 1366×720 quanto
 * em 1968×1440, dois aspectos diferentes — mas o número não está escrito no
 * código, e uma janela do Profit com outro layout devolve outro retângulo.
 */
export function detectChartBounds(
  luma: ArrayLike<number>,
  width: number,
  height: number,
): ChartBounds {
  if (width < 16 || height < 16 || luma.length < width * height) return SEM_MOLDURA;

  const modelo = estimateBackground(luma, width, height);
  const linhas = rowCoverage(luma, width, height, modelo);
  const colunas = columnCoverage(luma, width, height, modelo);

  const v = descascarRotulos(linhas, descascar(linhas, height), height);
  const h = descascar(colunas, width);
  const larguraPx = h.fim - h.ini + 1;
  const alturaPx = v.fim - v.ini + 1;

  const peeled = {
    top: v.ini,
    bottom: height - 1 - v.fim,
    left: h.ini,
    right: width - 1 - h.fim,
  };

  /*
   * Sobrou pouco: a moldura não é confiável e dizer isso é melhor que entregar
   * um retângulo qualquer. Quem consome trata `usable: false` parando, nunca
   * completando com o frame inteiro.
   */
  if (larguraPx < width * 0.3 || alturaPx < height * 0.3) {
    return {
      ...SEM_MOLDURA,
      peeled,
      reason: `moldura implausível (${Math.round((larguraPx / width) * 100)}% × ${Math.round((alturaPx / height) * 100)}% da janela)`,
    };
  }

  return {
    x: h.ini / width,
    y: v.ini / height,
    width: larguraPx / width,
    height: alturaPx / height,
    px: { x0: h.ini, y0: v.ini, x1: h.fim, y1: v.fim },
    peeled,
    usable: true,
    reason: `moldura do gráfico: ${Math.round((larguraPx / width) * 100)}% × ${Math.round((alturaPx / height) * 100)}% da janela`,
  };
}

/**
 * A ROI a partir do BITMAP — o caminho que substitui `detectRoi` onde há pixel.
 *
 * `detectRoi` recebe perfis de coluna e deriva a faixa vertical de
 * `min(top)`/`max(bottom)`. Esse envelope é frágil por construção: UMA coluna
 * que cruze a barra de ferramentas prende o topo em zero, e UM rótulo do eixo
 * de tempo prende o fundo na última linha. Medido nas 83 capturas de 20/08,
 * `detectRoi` devolveu confiança 35 — inutilizável — em 83 delas, e continuou
 * devolvendo depois que o modelo de tinta foi corrigido: o gradiente era metade
 * do problema, o `min`/`max` era a outra.
 *
 * Quem tem o bitmap usa esta função, que deriva a área da MOLDURA (onde o cromo
 * termina) e não da tinta. `detectRoi` continua existindo para quem só tem
 * perfis de coluna, e as duas não podem divergir porque não medem a mesma coisa
 * duas vezes — esta aqui é a única com acesso a pixel.
 */
export function roiFromPixels(luma: ArrayLike<number>, width: number, height: number): Roi {
  const moldura = detectChartBounds(luma, width, height);
  if (!moldura.usable) return { ...FULL_FRAME, detail: moldura.reason };
  const area = moldura.width * moldura.height;
  return {
    x: moldura.x,
    y: moldura.y,
    width: moldura.width,
    height: moldura.height,
    /*
     * A confiança sai da MESMA régua de plausibilidade de `detectRoi`, para as
     * duas falarem a mesma língua no painel. O que mudou não foi o critério de
     * "área plausível" — foi a área deixar de ser o envelope da tinta.
     */
    confidence: area >= 0.25 && area <= 0.95 ? Math.round(60 + Math.min(35, area * 40)) : 35,
    detail: moldura.reason,
  };
}
