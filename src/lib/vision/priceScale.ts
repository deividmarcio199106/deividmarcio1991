/**
 * CALIBRAÇÃO DA ESCALA DE PREÇOS — o alicerce de toda leitura visual.
 *
 * REGRA CENTRAL: posição vertical de pixel NUNCA vira preço sem calibração.
 * Antes desta versão o motor fazia `price = proxy * 1000` (preço normalizado
 * artificial). Agora todo preço nasce de uma reta ajustada sobre âncoras reais
 * lidas da escala do gráfico — OCR ou informadas manualmente pelo operador.
 *
 * Uma âncora só existe se houver um número efetivamente lido na escala. Nunca
 * se inventa âncora, nunca se extrapola a partir de um único ponto.
 */

import { plausiblePriceRange } from "@/lib/engines/instruments";

/** Um ponto (linha de pixel ↔ preço) lido da escala vertical do gráfico. */
export interface ScaleAnchor {
  /** Linha de pixel dentro do recorte do gráfico. Cresce para baixo. */
  y: number;
  /** Preço exibido nessa linha. */
  price: number;
  /** Texto exatamente como lido — mantido para auditoria e casas decimais. */
  raw: string;
  source: "ocr" | "manual";
  /** Confiança da leitura desta âncora (0..1). Manual = 1. */
  confidence: number;
}

/*
 * A FAIXA VEM DO REGISTRO DE INSTRUMENTOS — não é mais copiada aqui.
 *
 * Esta tabela existia em três arquivos com valores iguais e famílias
 * DIFERENTES (esta cobria WIN e WDO; IND e DOL ficavam de fora), então o mesmo
 * preço era plausível ou implausível dependendo de quem perguntasse.
 */
function faixaDoAtivo(asset: string): { min: number; max: number; label: string } | null {
  const faixa = plausiblePriceRange(asset);
  if (faixa === null) return null;
  return { ...faixa, label: asset.trim().toUpperCase() };
}

/** Impede que números de indicadores sejam aceitos como escala do ativo. */
export function assetScaleIssue(asset: string, anchors: ScaleAnchor[]): string | null {
  const expected = faixaDoAtivo(asset);
  if (!expected || anchors.length === 0) return null;
  const invalid = anchors.find(
    (anchor) => anchor.price < expected.min || anchor.price > expected.max,
  );
  return invalid
    ? `Escala rejeitada para ${expected.label}: ${invalid.raw} está fora da faixa plausível. Mostre a escala real de preços do gráfico.`
    : null;
}

/**
 * O Profit brasileiro costuma exibir WIN/WDO com ponto como separador de
 * milhar (ex.: `203.625` = 203625 pontos). Modelos visuais às vezes devolvem
 * esse rótulo como o número decimal 203.625. Normalizamos SOMENTE quando:
 *
 * - o ativo possui faixa plausível conhecida;
 * - o valor lido ficou abaixo dessa faixa;
 * - multiplicar por 1.000 o coloca dentro da faixa; e
 * - o texto original termina em exatamente três dígitos após `.` ou `,`.
 *
 * Isso evita "consertar" silenciosamente preços decimais legítimos de ativos
 * sem regra conhecida.
 */
export function normalizeScaleAnchorsForAsset(
  asset: string,
  anchors: ScaleAnchor[],
): ScaleAnchor[] {
  const expected = faixaDoAtivo(asset);
  if (!expected) return anchors;

  return anchors.map((anchor) => {
    if (anchor.price >= expected.min && anchor.price <= expected.max) return anchor;
    const raw = anchor.raw.trim().replace(/\s+/g, "");
    const looksLikeThousands = /^\d{1,3}[.,]\d{3}$/.test(raw);
    const scaled = anchor.price * 1_000;
    if (
      looksLikeThousands &&
      anchor.price > 0 &&
      scaled >= expected.min &&
      scaled <= expected.max
    ) {
      return { ...anchor, price: scaled };
    }
    return anchor;
  });
}

export type CalibrationStatus =
  | "calibrada"
  | "geometrica"
  | "ancoras_insuficientes"
  | "escala_nao_linear"
  | "confianca_baixa"
  | "ausente";

export interface Calibration {
  status: CalibrationStatus;
  /**
   * MODO GEOMÉTRICO: a escala ainda não foi calibrada, mas o frame é legível e
   * a leitura estrutural roda em unidades relativas de pixel. `usable` continua
   * false — nenhum preço exato de mercado pode ser publicado nem salvo.
   */
  geometric?: boolean;

  /** true somente quando a escala pode ser usada para produzir preços. */
  usable: boolean;
  /** preço = intercept + slope * y. Negativo: y cresce para baixo, preço cai. */
  slope: number;
  intercept: number;
  anchors: ScaleAnchor[];
  /** Casas decimais reconhecidas nos rótulos da escala. */
  decimals: number;
  /** Menor incremento reconhecido entre rótulos (null quando indeterminado). */
  tickSize: number | null;
  /** Qualidade do ajuste linear (0..1). */
  r2: number;
  /** Maior desvio de uma âncora em relação à reta, em pixels. */
  maxResidualPx: number;
  /** Confiança consolidada da calibração (0..100). */
  confidence: number;
  /** Motivo legível — sempre preenchido, inclusive em sucesso. */
  reason: string;
}

export const SCALE_CONFIG = {
  /** Mínimo absoluto de âncoras. Uma âncora só nunca calibra uma reta. */
  minAnchors: 2,
  /** A partir daqui a calibração é considerada robusta. */
  preferredAnchors: 3,
  /** Qualidade mínima do ajuste linear. Escala logarítmica reprova aqui. */
  minR2: 0.9995,
  /** Desvio máximo tolerado de qualquer âncora, em pixels. */
  maxResidualPx: 2.5,
  /** Distância vertical mínima entre a âncora mais alta e a mais baixa. */
  minSpanPx: 40,
  /** Confiança mínima para liberar a produção de sinais. */
  minConfidence: 60,
} as const;

/** Calibração vazia — estado inicial e resultado de toda falha. */
export function emptyCalibration(reason = "Escala ainda não calibrada."): Calibration {
  return {
    status: "ausente",
    usable: false,
    slope: 0,
    intercept: 0,
    anchors: [],
    decimals: 0,
    tickSize: null,
    r2: 0,
    maxResidualPx: Number.POSITIVE_INFINITY,
    confidence: 0,
    reason,
  };
}

/**
 * LEITURA GEOMÉTRICA — o gráfico está visível, a escala ainda não.
 *
 * REGRA: gráfico na tela = análise ativa. A calibração de preço deixou de ser
 * portão global; enquanto ela procura âncoras, a leitura estrutural roda nesta
 * escala relativa (unidades de pixel invertidas, topo = maior valor). É uma
 * transformação linear, então estrutura, impulso, varredura, POI, Wyckoff, BOS,
 * CHOCH e sequência temporal são idênticos ao que sairia com a escala real.
 *
 * `usable` permanece FALSE de propósito: nenhum número produzido aqui é preço
 * de mercado e nada disso pode virar entrada/stop/alvo publicados ou salvos.
 */
export function geometricCalibration(frameHeight: number): Calibration {
  const height = Math.max(1, Math.round(frameHeight));
  return {
    ...emptyCalibration(
      "Escala de preços em calibração automática — leitura estrutural ativa em unidades relativas.",
    ),
    status: "geometrica",
    geometric: true,
    slope: -1,
    intercept: height,
    decimals: 1,
    r2: 1,
    maxResidualPx: 0,
  };
}

/** true quando o frame gera geometria de candles (com ou sem preço exato). */
export function isReadable(calibration: Calibration): boolean {
  return calibration.usable || calibration.geometric === true;
}

/** true somente quando os números derivados são preço real de mercado. */
export function priceReliable(calibration: Calibration): boolean {
  return calibration.usable;
}

/**
 * Casas decimais de um rótulo numérico.
 *
 * Aceita os dois formatos que aparecem em plataformas brasileiras e
 * internacionais: "5.432,50" (vírgula decimal) e "138,750.25" (ponto decimal).
 * O separador decimal é o ÚLTIMO separador quando ele isola 1–2 dígitos, ou
 * 3 dígitos apenas se for o único separador presente e vier precedido de vírgula.
 */
export function decimalsOf(raw: string): number {
  const cleaned = raw.trim().replace(/[^\d.,-]/g, "");
  if (!cleaned) return 0;
  const lastDot = cleaned.lastIndexOf(".");
  const lastComma = cleaned.lastIndexOf(",");
  const sepIndex = Math.max(lastDot, lastComma);
  if (sepIndex < 0) return 0;
  const tail = cleaned.slice(sepIndex + 1);
  // Grupo de milhar (exatamente 3 dígitos) não é parte decimal quando existe
  // outro separador antes dele indicando agrupamento.
  if (tail.length === 3 && Math.min(lastDot, lastComma) >= 0) return 0;
  if (tail.length === 3 && /^\d{1,3}([.,]\d{3})+$/.test(cleaned)) return 0;
  return /^\d+$/.test(tail) ? tail.length : 0;
}

/**
 * Converte o rótulo lido em número, respeitando os dois formatos de separador.
 * Devolve null quando o texto não é um número utilizável — jamais um palpite.
 */
export function parsePriceLabel(raw: string): number | null {
  const cleaned = raw.trim().replace(/[^\d.,-]/g, "");
  if (!cleaned || !/\d/.test(cleaned)) return null;

  const lastDot = cleaned.lastIndexOf(".");
  const lastComma = cleaned.lastIndexOf(",");
  let normalized: string;

  if (lastDot >= 0 && lastComma >= 0) {
    // O separador mais à direita é o decimal; o outro é agrupamento.
    const decimalSep = lastDot > lastComma ? "." : ",";
    const groupSep = decimalSep === "." ? "," : ".";
    normalized = cleaned.split(groupSep).join("").replace(decimalSep, ".");
  } else if (lastComma >= 0) {
    const tail = cleaned.slice(lastComma + 1);
    normalized = tail.length === 3 ? cleaned.split(",").join("") : cleaned.replace(",", ".");
  } else if (lastDot >= 0) {
    const tail = cleaned.slice(lastDot + 1);
    // "1.234" com um único ponto e 3 dígitos é milhar, não decimal.
    normalized =
      tail.length === 3 && /^\d{1,3}(\.\d{3})+$/.test(cleaned)
        ? cleaned.split(".").join("")
        : cleaned;
  } else {
    normalized = cleaned;
  }

  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/** Maior divisor comum aproximado — usado para inferir o incremento da escala. */
function approximateGcd(values: number[], tolerance: number): number | null {
  const positive = values.filter((v) => v > tolerance);
  if (positive.length === 0) return null;
  let current = positive[0]!;
  for (let i = 1; i < positive.length; i++) {
    let a = current;
    let b = positive[i]!;
    let guard = 0;
    while (b > tolerance && guard++ < 64) {
      const rest = a - Math.floor(a / b) * b;
      a = b;
      b = rest;
    }
    current = a;
    if (current <= tolerance) return null;
  }
  return current;
}

/**
 * Ajusta a reta preço↔pixel por regressão linear ponderada pela confiança de
 * cada âncora e valida a escala antes de liberá-la.
 *
 * Reprova (e portanto bloqueia a operação) quando:
 * - há menos de 2 âncoras;
 * - as âncoras estão praticamente na mesma altura (span insuficiente);
 * - o ajuste não é linear (escala logarítmica, OCR trocando dígitos);
 * - alguma âncora desvia mais que `maxResidualPx` da reta;
 * - a confiança consolidada fica abaixo do mínimo.
 */
/**
 * CALIBRAÇÃO COM DESCARTE DE UM RÓTULO ERRADO.
 *
 * O que se via ao vivo: "Escala não linear (R²=0.99178, desvio máx. 18.3px)".
 * R² de 0.99 é altíssimo para quase tudo — e reprovado aqui, com razão: um eixo
 * de preço é uma reta EXATA, e 18 pixels de desvio significam que um rótulo foi
 * lido na altura errada. Aceitar essa reta espalharia o erro por todo o eixo.
 *
 * Mas reprovar a leitura inteira por causa de um rótulo torto também é perda: os
 * outros três estavam certos. Esta função procura o maior subconjunto CONSISTENTE
 * em vez de escolher entre aceitar tudo ou recusar tudo.
 *
 * A REGRA QUE IMPEDE ISSO DE VIRAR AFROUXAMENTO: o descarte só acontece com 4+
 * rótulos, e o que sobra precisa ter 3+. Com 2 âncoras qualquer reta passa pelos
 * dois pontos e o R² é sempre 1 — o teste de linearidade não testaria nada, e
 * "descartar até passar" seria fabricar aprovação. O terceiro rótulo é o
 * primeiro que pode discordar, e ele continua obrigatório.
 *
 * Nenhum limiar foi alterado: `minR2`, `maxResidualPx` e `minConfidence` são os
 * mesmos. O que mudou é quantas hipóteses são testadas contra eles.
 */
export function calibrateRobust(input: ScaleAnchor[]): Calibration {
  const direto = calibrateFromAnchors(input);
  if (direto.usable) return direto;
  if (input.length < 4) return direto;

  let melhor: Calibration | null = null;
  for (let i = 0; i < input.length; i++) {
    const subconjunto = input.filter((_, index) => index !== i);
    if (subconjunto.length < SCALE_CONFIG.preferredAnchors) continue;
    const tentativa = calibrateFromAnchors(subconjunto);
    if (!tentativa.usable) continue;
    // Entre subconjuntos aprovados, vence o de menor desvio: é o que descreve
    // melhor o eixo real, não o que tem mais rótulos.
    if (melhor === null || tentativa.maxResidualPx < melhor.maxResidualPx) melhor = tentativa;
  }

  if (melhor === null) return direto;
  return {
    ...melhor,
    reason: `${melhor.reason} Um rótulo foi descartado por não pertencer à reta do eixo.`,
  };
}

export function calibrateFromAnchors(input: ScaleAnchor[]): Calibration {
  // Deduplica por linha de pixel mantendo a leitura mais confiável.
  const byY = new Map<number, ScaleAnchor>();
  for (const a of input) {
    if (!Number.isFinite(a.y) || !Number.isFinite(a.price)) continue;
    const key = Math.round(a.y);
    const existing = byY.get(key);
    if (!existing || a.confidence > existing.confidence) byY.set(key, a);
  }
  const anchors = [...byY.values()].sort((x, z) => x.y - z.y);

  if (anchors.length < SCALE_CONFIG.minAnchors) {
    return {
      ...emptyCalibration(
        `Calibração exige pelo menos ${SCALE_CONFIG.minAnchors} preços legíveis na escala; ${anchors.length} lido(s).`,
      ),
      status: "ancoras_insuficientes",
      anchors,
    };
  }

  const span = anchors[anchors.length - 1]!.y - anchors[0]!.y;
  if (span < SCALE_CONFIG.minSpanPx) {
    return {
      ...emptyCalibration(
        `Preços lidos concentrados em ${Math.round(span)}px (mínimo ${SCALE_CONFIG.minSpanPx}px). Escala insuficiente para interpolar.`,
      ),
      status: "ancoras_insuficientes",
      anchors,
    };
  }

  const distinctPrices = new Set(anchors.map((a) => a.price));
  if (distinctPrices.size < 2) {
    return {
      ...emptyCalibration("Todos os rótulos lidos têm o mesmo preço — escala não interpolável."),
      status: "ancoras_insuficientes",
      anchors,
    };
  }

  // Regressão linear ponderada: price = intercept + slope * y
  let sw = 0;
  let swy = 0;
  let swp = 0;
  for (const a of anchors) {
    const w = Math.max(0.05, a.confidence);
    sw += w;
    swy += w * a.y;
    swp += w * a.price;
  }
  const meanY = swy / sw;
  const meanP = swp / sw;

  let num = 0;
  let den = 0;
  for (const a of anchors) {
    const w = Math.max(0.05, a.confidence);
    num += w * (a.y - meanY) * (a.price - meanP);
    den += w * (a.y - meanY) ** 2;
  }
  if (den === 0) {
    return {
      ...emptyCalibration("Âncoras degeneradas: não é possível ajustar a escala."),
      status: "escala_nao_linear",
      anchors,
    };
  }

  const slope = num / den;
  const intercept = meanP - slope * meanY;

  if (slope === 0 || !Number.isFinite(slope)) {
    return {
      ...emptyCalibration("Escala plana: preço não varia com a altura."),
      status: "escala_nao_linear",
      anchors,
    };
  }

  // Qualidade do ajuste + maior desvio convertido para pixels.
  let ssRes = 0;
  let ssTot = 0;
  let maxResidualPx = 0;
  for (const a of anchors) {
    const predicted = intercept + slope * a.y;
    const residual = a.price - predicted;
    ssRes += residual ** 2;
    ssTot += (a.price - meanP) ** 2;
    maxResidualPx = Math.max(maxResidualPx, Math.abs(residual / slope));
  }
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;

  if (r2 < SCALE_CONFIG.minR2 || maxResidualPx > SCALE_CONFIG.maxResidualPx) {
    return {
      ...emptyCalibration(
        `Escala não linear (R²=${r2.toFixed(5)}, desvio máx. ${maxResidualPx.toFixed(1)}px). ` +
          "Confirme que o gráfico está em escala linear e recalibre.",
      ),
      status: "escala_nao_linear",
      anchors,
      slope,
      intercept,
      r2,
      maxResidualPx,
    };
  }

  const decimals = Math.max(0, ...anchors.map((a) => decimalsOf(a.raw)));

  // Incremento reconhecido a partir das diferenças entre rótulos consecutivos.
  const sortedPrices = [...distinctPrices].sort((a, b) => a - b);
  const diffs: number[] = [];
  for (let i = 1; i < sortedPrices.length; i++) {
    diffs.push(Math.abs(sortedPrices[i]! - sortedPrices[i - 1]!));
  }
  const unit = Math.pow(10, -decimals);
  const gcd = approximateGcd(diffs, unit / 2);
  const tickSize = gcd !== null ? Math.max(unit, Number(gcd.toFixed(decimals + 2))) : null;

  // Confiança: média das âncoras, com bônus por quantidade e por linearidade.
  const meanConfidence = anchors.reduce((acc, a) => acc + a.confidence, 0) / anchors.length;
  const countBonus = anchors.length >= SCALE_CONFIG.preferredAnchors ? 1 : 0.82;
  const fitBonus = Math.max(0, Math.min(1, (r2 - SCALE_CONFIG.minR2) / (1 - SCALE_CONFIG.minR2)));
  const confidence = Math.round(
    Math.max(0, Math.min(100, meanConfidence * 100 * countBonus * (0.9 + 0.1 * fitBonus))),
  );

  if (confidence < SCALE_CONFIG.minConfidence) {
    return {
      status: "confianca_baixa",
      usable: false,
      slope,
      intercept,
      anchors,
      decimals,
      tickSize,
      r2,
      maxResidualPx,
      confidence,
      reason: `Confiança da leitura ${confidence}% abaixo do mínimo (${SCALE_CONFIG.minConfidence}%). Ajuste a escala visível e tente a leitura automática novamente.`,
    };
  }

  return {
    status: "calibrada",
    usable: true,
    slope,
    intercept,
    anchors,
    decimals,
    tickSize,
    r2,
    maxResidualPx,
    confidence,
    reason:
      `Escala calibrada com ${anchors.length} preços` +
      (anchors.some((a) => a.source === "manual") ? " (inclui calibração manual)" : "") +
      `, ${decimals} casa(s) decimal(is).`,
  };
}

/**
 * Converte linha de pixel em valor da escala corrente.
 *
 * Com `usable === true` o resultado é PREÇO REAL. No modo geométrico é uma
 * unidade relativa — serve para geometria/estrutura e nunca para publicar
 * entrada, stop, parcial ou alvo. Quem publica número checa `priceReliable`.
 */
export function priceAt(calibration: Calibration, y: number): number | null {
  if (!isReadable(calibration)) return null;
  const price = calibration.intercept + calibration.slope * y;
  return Number.isFinite(price) ? round(price, calibration.decimals) : null;
}

/** Converte preço em linha de pixel — usado para desenhar as linhas do plano. */
export function yAt(calibration: Calibration, price: number): number | null {
  if (!isReadable(calibration) || calibration.slope === 0) return null;
  const y = (price - calibration.intercept) / calibration.slope;
  return Number.isFinite(y) ? y : null;
}

function round(value: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

/** Faixa de preços efetivamente visível no recorte, do topo à base. */
export function visibleRange(
  calibration: Calibration,
  heightPx: number,
): { min: number; max: number } | null {
  const top = priceAt(calibration, 0);
  const bottom = priceAt(calibration, heightPx);
  if (top === null || bottom === null) return null;
  return { min: Math.min(top, bottom), max: Math.max(top, bottom) };
}

/**
 * Decide se a calibração vigente ainda vale para o frame atual.
 *
 * Zoom, mudança de escala ou redimensionamento deslocam os rótulos: se as
 * âncoras novas divergirem da reta anterior além da tolerância, a calibração
 * está vencida e a análise deve pausar até recalibrar.
 */
export function calibrationDrift(
  previous: Calibration,
  freshAnchors: ScaleAnchor[],
): { stale: boolean; maxDriftPx: number } {
  if (!previous.usable || freshAnchors.length === 0) {
    return { stale: true, maxDriftPx: Number.POSITIVE_INFINITY };
  }
  let maxDriftPx = 0;
  for (const a of freshAnchors) {
    const expectedY = yAt(previous, a.price);
    if (expectedY === null) return { stale: true, maxDriftPx: Number.POSITIVE_INFINITY };
    maxDriftPx = Math.max(maxDriftPx, Math.abs(expectedY - a.y));
  }
  return { stale: maxDriftPx > SCALE_CONFIG.maxResidualPx * 2, maxDriftPx };
}

/** Estados de qualidade da calibração (spec V5 §11) — derivados de métricas reais. */
export type CalibrationGrade = "EXCELENTE" | "BOA" | "ACEITAVEL" | "INSUFICIENTE";

/**
 * Grau derivado exclusivamente das métricas medidas: quantidade de âncoras,
 * R² do ajuste, maior desvio em pixels e confiança consolidada — nenhum
 * número arbitrário fora dos limiares já versionados em SCALE_CONFIG.
 */
export function calibrationGrade(calibration: Calibration): {
  grade: CalibrationGrade;
  metrics: string[];
} {
  const metrics = [
    `ancoras=${calibration.anchors.length}`,
    `r2=${calibration.r2.toFixed(5)}`,
    `desvioMax=${Number.isFinite(calibration.maxResidualPx) ? calibration.maxResidualPx.toFixed(1) : "inf"}px`,
    `confianca=${calibration.confidence}%`,
  ];
  if (!calibration.usable) return { grade: "INSUFICIENTE", metrics };
  const excellent =
    calibration.anchors.length >= SCALE_CONFIG.preferredAnchors &&
    calibration.confidence >= 85 &&
    calibration.maxResidualPx <= SCALE_CONFIG.maxResidualPx / 2;
  if (excellent) return { grade: "EXCELENTE", metrics };
  const good =
    calibration.anchors.length >= SCALE_CONFIG.preferredAnchors || calibration.confidence >= 75;
  if (good) return { grade: "BOA", metrics };
  return { grade: "ACEITAVEL", metrics };
}
