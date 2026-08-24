/**
 * SELEÇÃO DE ÂNCORAS DA ESCALA — um lugar só, com o motivo de cada descarte.
 *
 * O DEFEITO QUE ISTO ENCERRA: `NON_MONOTONIC` reprovava a leitura inteira quando
 * UM rótulo saía fora de ordem. Um eixo de preço tem 5 a 8 rótulos; que o modelo
 * erre um é o caso NORMAL, não a exceção — e jogar os outros sete fora por causa
 * dele deixava a escala em recusa permanente.
 *
 * A CONVENÇÃO, DITA UMA VEZ: no eixo do Profit o preço CRESCE de baixo para
 * cima. Como `y` cresce para baixo na imagem, preço e `y` são inversamente
 * relacionados: ordenado por `y` ascendente, o preço tem de ser ESTRITAMENTE
 * DECRESCENTE. Toda a validação abaixo é essa única frase.
 *
 * A ORDEM DAS ETAPAS IMPORTA, e cada uma responde por um tipo de erro:
 *
 *   1. régua      percentY fora de [0,100] é impossível — rejeita, nunca clampa
 *   2. formato    "203.625" em WIN é 203625 pontos, não o decimal 203,625
 *   3. duplicata  dois rótulos na mesma linha: fica o de maior confiança
 *   4. ordem      maior cadeia decrescente; o que sobra fora dela é descartado
 *   5. reta       regressão preço=f(y); resíduo alto derruba o pior e refaz
 *
 * NENHUM LIMIAR FOI AFROUXADO. O que mudou é que o descarte é POR RÓTULO, com
 * nome e motivo, em vez de recusa em bloco.
 */

import { parsePriceLabel } from "./priceScale";

export type LabelDrop =
  | "PERCENT_FORA_DA_REGUA"
  | "PRECO_ILEGIVEL"
  | "CONFIANCA_BAIXA"
  | "DUPLICADO"
  | "QUEBRA_ORDEM"
  | "FORA_DA_RETA"
  | "VAO_INSUFICIENTE";

/** Um rótulo lido, com o veredito de por que entrou ou saiu. */
export interface LabelReading {
  raw: string;
  price: number;
  yPercent: number;
  /** Linha de pixel no frame. Derivada de percentY — nunca do Y cru do modelo. */
  y: number;
  confidence: number;
  kept: boolean;
  drop: LabelDrop | null;
  /** Resíduo em pixels contra a reta final. Null enquanto não há reta. */
  residualPx: number | null;
}

export interface RawLabel {
  raw: string;
  price: number;
  yPercent: number;
  confidence: number;
}

export interface Regression {
  slope: number;
  intercept: number;
  r2: number;
  maxResidualPx: number;
}

export interface SelectionResult {
  /** Todos os rótulos, aproveitados e descartados, na ordem do eixo. */
  labels: LabelReading[];
  kept: LabelReading[];
  regression: Regression | null;
  /** Preço cresce de baixo para cima? Falso indica eixo invertido ou lixo. */
  directionOk: boolean;
  reason: string | null;
}

export const SELECTION_CONFIG = {
  /**
   * Corte de confiança BAIXO de propósito.
   *
   * O antigo era 0.7, e um modelo de visão menor reporta confiança modesta em
   * rótulos perfeitamente legíveis — descartando todos ANTES da regressão, que
   * é quem de fato sabe se o rótulo pertence à reta. A geometria é um juiz
   * melhor que a autoavaliação do modelo: um rótulo que cai na reta com resíduo
   * de meio pixel está certo, tenha o modelo confiado nele ou não.
   */
  minConfidence: 0.3,
  /** Dois rótulos a menos de 1,5% da altura são a mesma linha. */
  duplicateWithinPercent: 1.5,
  /** Mínimo absoluto para uma reta. */
  minAnchors: 2,
  /**
   * Vão vertical mínimo entre a âncora mais alta e a mais baixa, em % da altura.
   *
   * Duas âncoras separadas por 10% ajustam uma reta sobre 10% do eixo e a
   * EXTRAPOLAM para os outros 90% — que é justamente onde ficam os alvos. O erro
   * de extrapolação cresce com a distância, e o R² não denuncia: ele mede o
   * ajuste onde há pontos, não onde não há.
   */
  minSpanPercent: 18,
  /** Resíduo tolerado contra a reta ajustada. */
  maxResidualPx: 2.5,
  /** Quantos rótulos podem ser removidos por resíduo antes de desistir. */
  maxOutlierDrops: 2,
} as const;

/**
 * Normalização de formato brasileiro, dependente da FAIXA do contrato.
 *
 * `parsePriceLabel` já resolve separador decimal versus milhar pelo texto. O que
 * o texto sozinho não resolve: "203.625" é ambíguo — 203625 pontos de WIN ou o
 * decimal 203,625? A faixa do contrato desempata, e sem ela a escala inteira sai
 * mil vezes menor sem nenhum sinal de erro.
 */
export function normalizeBrPrice(
  raw: string,
  expected: { min: number; max: number } | null,
): number | null {
  const direct = parsePriceLabel(raw);
  if (direct === null) return null;
  if (!expected) return direct;
  if (direct >= expected.min && direct <= expected.max) return direct;

  /*
   * A CORREÇÃO É UMA SÓ, E O TEXTO PRECISA JUSTIFICÁ-LA.
   *
   * Aqui havia um laço tentando ×1000, ×100, ×10, ÷1000… e aceitando o primeiro
   * fator que fizesse o número cair na faixa do contrato. Isso não é
   * normalização: é forçar o dado a caber na expectativa.
   *
   * O estrago visto ao vivo: um eixo lido como 263,70 virava 263700, e a escala
   * inteira saía MIL VEZES maior. O R² não denuncia — multiplicar todos os
   * rótulos pelo mesmo fator preserva a linearidade PERFEITAMENTE. O painel
   * mostrava "R² 1.0000, 10/10 âncoras" e publicava parcial de −119.957, um
   * preço negativo, que é impossível.
   *
   * A única correção legítima é o separador de milhar do formato brasileiro, e
   * ela tem assinatura no TEXTO: 1 a 3 dígitos, separador, exatamente 3 dígitos
   * ("203.625" = 203625 pontos). "263.70" tem duas casas — é decimal, e
   * multiplicá-lo seria inventar.
   *
   * Fora desse caso, o valor sai como foi lido. Se ele não pertence ao
   * contrato, quem recusa é a checagem de faixa lá na frente — com a guarda de
   * preço ligada, em vez de um número plausível e mil vezes errado.
   */
  const limpo = raw.trim().replace(/\s+/g, "");
  const pareceMilhar = /^-?\d{1,3}[.,]\d{3}$/.test(limpo);
  if (pareceMilhar) {
    const escalado = direct * 1_000;
    if (escalado >= expected.min && escalado <= expected.max) return escalado;
  }
  return direct;
}

/** Regressão ponderada preço = intercept + slope·y. */
function fit(points: LabelReading[]): Regression | null {
  if (points.length < 2) return null;
  let sw = 0;
  let swy = 0;
  let swp = 0;
  for (const p of points) {
    const w = Math.max(0.05, p.confidence);
    sw += w;
    swy += w * p.y;
    swp += w * p.price;
  }
  const meanY = swy / sw;
  const meanP = swp / sw;
  let num = 0;
  let den = 0;
  for (const p of points) {
    const w = Math.max(0.05, p.confidence);
    num += w * (p.y - meanY) * (p.price - meanP);
    den += w * (p.y - meanY) ** 2;
  }
  if (den <= 1e-9) return null;
  const slope = num / den;
  if (!Number.isFinite(slope) || slope === 0) return null;
  const intercept = meanP - slope * meanY;

  let ssRes = 0;
  let ssTot = 0;
  let maxResidualPx = 0;
  for (const p of points) {
    const previsto = intercept + slope * p.y;
    ssRes += (p.price - previsto) ** 2;
    ssTot += (p.price - meanP) ** 2;
    maxResidualPx = Math.max(maxResidualPx, Math.abs((p.price - previsto) / slope));
  }
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  return { slope, intercept, r2, maxResidualPx };
}

/** Maior subsequência com preço estritamente decrescente conforme y cresce. */
function longestDecreasing(sorted: LabelReading[]): LabelReading[] {
  const chains: LabelReading[][] = sorted.map((l) => [l]);
  let best: LabelReading[] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = 0; j < i; j++) {
      if (sorted[j]!.price > sorted[i]!.price && chains[j]!.length + 1 > chains[i]!.length) {
        chains[i] = [...chains[j]!, sorted[i]!];
      }
    }
    const cand = chains[i]!;
    const spanCand = cand.length < 2 ? 0 : cand[cand.length - 1]!.y - cand[0]!.y;
    const spanBest = best.length < 2 ? 0 : best[best.length - 1]!.y - best[0]!.y;
    if (cand.length > best.length || (cand.length === best.length && spanCand > spanBest)) {
      best = cand;
    }
  }
  return best;
}

/**
 * Seleciona as âncoras utilizáveis e explica cada descarte.
 *
 * Nunca lança: uma leitura ruim produz `kept` vazio com `reason` preenchido, e
 * todos os rótulos marcados com o motivo individual.
 */
export function selectLabels(
  raws: RawLabel[],
  frameHeight: number,
  expected: { min: number; max: number } | null = null,
): SelectionResult {
  const labels: LabelReading[] = raws.map((r) => {
    const normalizado = normalizeBrPrice(r.raw, expected) ?? r.price;
    const dentroDaRegua = Number.isFinite(r.yPercent) && r.yPercent >= 0 && r.yPercent <= 100;
    return {
      raw: r.raw,
      price: normalizado,
      yPercent: r.yPercent,
      // percentY → pixel. O Y cru do modelo NUNCA é usado: ele apresentou
      // distorção sistemática, e a régua existe para não depender dele.
      y: dentroDaRegua ? (r.yPercent / 100) * frameHeight : Number.NaN,
      confidence: r.confidence,
      kept: false,
      drop: !dentroDaRegua
        ? ("PERCENT_FORA_DA_REGUA" as LabelDrop)
        : !Number.isFinite(normalizado)
          ? ("PRECO_ILEGIVEL" as LabelDrop)
          : r.confidence < SELECTION_CONFIG.minConfidence
            ? ("CONFIANCA_BAIXA" as LabelDrop)
            : null,
      residualPx: null,
    };
  });

  const vivos = labels.filter((l) => l.drop === null).sort((a, b) => a.y - b.y);

  // Duplicatas por altura: fica a de maior confiança.
  const semDuplicata: LabelReading[] = [];
  for (const l of vivos) {
    const anterior = semDuplicata[semDuplicata.length - 1];
    const juntos =
      anterior !== undefined &&
      Math.abs(l.yPercent - anterior.yPercent) < SELECTION_CONFIG.duplicateWithinPercent;
    if (juntos && anterior !== undefined) {
      const perdedor = l.confidence > anterior.confidence ? anterior : l;
      const vencedor = perdedor === l ? anterior : l;
      perdedor.drop = "DUPLICADO";
      semDuplicata[semDuplicata.length - 1] = vencedor;
      continue;
    }
    semDuplicata.push(l);
  }

  // Ordem: quem não pertence à maior cadeia decrescente sai — UM a UM, e não
  // a leitura inteira, que era o defeito.
  const cadeia = longestDecreasing(semDuplicata);
  const naCadeia = new Set(cadeia);
  for (const l of semDuplicata) if (!naCadeia.has(l)) l.drop = "QUEBRA_ORDEM";

  const directionOk = cadeia.length >= 2;
  let restantes = [...cadeia];
  let regression = fit(restantes);

  // Outlier de RETA: mesmo dentro da ordem, um rótulo pode estar deslocado.
  // Derruba o pior e refaz, enquanto sobrar reta testável.
  let drops = 0;
  while (
    regression !== null &&
    regression.maxResidualPx > SELECTION_CONFIG.maxResidualPx &&
    drops < SELECTION_CONFIG.maxOutlierDrops &&
    restantes.length > SELECTION_CONFIG.minAnchors
  ) {
    let pior = restantes[0]!;
    let piorResiduo = -1;
    for (const p of restantes) {
      const previsto = regression.intercept + regression.slope * p.y;
      const residuo = Math.abs((p.price - previsto) / regression.slope);
      if (residuo > piorResiduo) {
        piorResiduo = residuo;
        pior = p;
      }
    }
    pior.drop = "FORA_DA_RETA";
    restantes = restantes.filter((p) => p !== pior);
    regression = fit(restantes);
    drops++;
  }

  /*
   * SÓ MARCA COMO ACEITO SE O CONJUNTO FOR UTILIZÁVEL.
   *
   * Com o eixo invertido, a maior cadeia decrescente tem UM elemento — e marcá-lo
   * como aceito devolveria uma âncora solta, que não define reta nenhuma. O
   * mínimo tem de ser verificado ANTES de aceitar, não depois.
   */
  const utilizavel = restantes.length >= SELECTION_CONFIG.minAnchors && regression !== null;
  if (utilizavel) {
    for (const p of restantes) {
      p.kept = true;
      if (regression) {
        const previsto = regression.intercept + regression.slope * p.y;
        p.residualPx = Math.abs((p.price - previsto) / regression.slope);
      }
    }
  }

  /*
   * VÃO VERTICAL: a reta precisa cobrir uma faixa real do eixo.
   *
   * Verificado DEPOIS do descarte de outliers, porque é o conjunto final que vai
   * virar régua. Rótulos aglomerados no centro do eixo — o que um modelo devolve
   * quando lê só a vizinhança do preço atual — produzem uma reta que descreve
   * bem 16% do gráfico e adivinha o resto.
   */
  const span =
    restantes.length >= 2 ? restantes[restantes.length - 1]!.yPercent - restantes[0]!.yPercent : 0;
  const spanInsuficiente = restantes.length >= 2 && span < SELECTION_CONFIG.minSpanPercent;
  if (spanInsuficiente) {
    for (const p of restantes) {
      p.kept = false;
      p.drop = "VAO_INSUFICIENTE";
    }
  }

  const kept = labels.filter((l) => l.kept);
  const reason =
    kept.length >= SELECTION_CONFIG.minAnchors
      ? null
      : spanInsuficiente
        ? `rótulos cobrem só ${span.toFixed(0)}% da altura (mínimo ${SELECTION_CONFIG.minSpanPercent}%) — a reta seria extrapolada para o resto do eixo`
        : labels.length === 0
          ? "o modelo não devolveu nenhum rótulo"
          : !directionOk
            ? `nenhuma sequência decrescente em ${labels.length} rótulo(s) — os números lidos não descrevem um eixo de preço`
            : `${kept.length}/${labels.length} rótulos aproveitáveis (mínimo ${SELECTION_CONFIG.minAnchors})`;

  return { labels, kept, regression, directionOk, reason };
}

/** Resumo de uma linha para o painel. */
export function describeSelection(result: SelectionResult): string {
  const total = result.labels.length;
  const por: Record<string, number> = {};
  for (const l of result.labels) if (l.drop) por[l.drop] = (por[l.drop] ?? 0) + 1;
  const descartes = Object.entries(por)
    .map(([k, v]) => `${v} ${k.toLowerCase().replace(/_/g, " ")}`)
    .join(" · ");
  return `${result.kept.length}/${total} aproveitados${descartes ? ` · ${descartes}` : ""}`;
}
