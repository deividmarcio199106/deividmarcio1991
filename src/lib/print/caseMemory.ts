import type { SetupDna } from "@/lib/t4/dna";
import type { PredictionVerdict } from "./predictionOutcome";

/**
 * MEMÓRIA DE CASOS DA T4 — o print de hoje consulta os desfechos de ontem.
 *
 * O que ela é: recuperação de casos HISTÓRICOS estruturalmente semelhantes
 * (pelo DNA, que já é o vocabulário fechado da técnica) cujo RESULTADO já é
 * conhecido, e a taxa de acerto deles como segunda opinião de confiança.
 *
 * O que ela NUNCA é: um mecanismo que altera a T4. A memória informa
 * confiança e mostra evidência; regra só muda pelo Laboratório, com OOS e
 * walk-forward. É a linha anti-contaminação do operador, e é estrutural aqui:
 * este módulo não tem NENHUM caminho de escrita em técnica.
 *
 * AS TRÊS LEIS DA MEMÓRIA:
 *   1. Só caso com resultado ensina (ACERTOU/ERROU; NEUTRO e INVALIDADO não
 *      entram na taxa — não provam nem refutam o setup).
 *   2. Quantidade não é confiança: a taxa histórica usa o limite INFERIOR de
 *      Wilson — 3 acertos em 3 casos é ~44%, não 100%. Muitos prints
 *      parecidos sem resultado não somam nada.
 *   3. Erros são tão memória quanto acertos, e nunca são apagados.
 */

export interface MemoryCase {
  dna: SetupDna;
  verdict: PredictionVerdict;
  /** true quando o veredito veio de intervalo ambíguo (contado como stop). */
  ambiguous: boolean;
  printId: string;
  resolvedAt: number | null;
}

export interface SimilarCase {
  memoryCase: MemoryCase;
  /** 0–1: fração ponderada das dimensões do DNA que casam. */
  similarity: number;
  /** Dimensões que diferem do cenário atual — o "o que é diferente agora". */
  differences: string[];
}

/**
 * Pesos por dimensão. Direção e nota pesam mais: um caso da MESMA nota e do
 * MESMO lado diz mais sobre este setup que coincidência de horário. Pesos
 * fixos e visíveis — calibrá-los por resultado seria overfitting da memória
 * sobre ela mesma.
 */
const DIMENSION_WEIGHTS: Array<{
  key: string;
  weight: number;
  value: (dna: SetupDna) => string;
}> = [
  { key: "direction", weight: 3, value: (d) => d.direction },
  { key: "grade", weight: 3, value: (d) => d.grade },
  { key: "trend", weight: 2, value: (d) => d.trend },
  { key: "position", weight: 2, value: (d) => d.position },
  { key: "pullback", weight: 2, value: (d) => d.pullback },
  { key: "triggerCandle", weight: 2, value: (d) => d.triggerCandle },
  { key: "location", weight: 1, value: (d) => d.location },
  { key: "volatility", weight: 1, value: (d) => d.volatility ?? "SEM_LEITURA" },
  { key: "asset", weight: 1, value: (d) => d.asset },
];

const TOTAL_WEIGHT = DIMENSION_WEIGHTS.reduce((sum, d) => sum + d.weight, 0);

/** Similaridade estrutural entre dois DNAs, 0–1, com as diferenças nomeadas. */
export function dnaSimilarity(a: SetupDna, b: SetupDna): { score: number; differences: string[] } {
  let matched = 0;
  const differences: string[] = [];
  for (const dim of DIMENSION_WEIGHTS) {
    if (dim.value(a) === dim.value(b)) {
      matched += dim.weight;
    } else {
      differences.push(`${dim.key}: ${dim.value(b)} → ${dim.value(a)}`);
    }
  }
  return { score: Number((matched / TOTAL_WEIGHT).toFixed(3)), differences };
}

/** Abaixo disto o caso não é "semelhante" — é só outro trade. */
export const MIN_SIMILARITY = 0.6;
/** Abaixo disto a memória não emite taxa — mostra os casos e diz que é pouco. */
export const MIN_CASES_FOR_RATE = 5;

/**
 * Limite inferior do intervalo de Wilson (95%) para proporção.
 *
 * É o que impede 2/2 de virar "100% de acerto histórico": com amostra
 * pequena, o limite inferior desaba — a confiança sobe com CASOS RESOLVIDOS,
 * não com entusiasmo.
 */
export function wilsonLowerBound(hits: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const phat = hits / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denominator);
}

export interface MemoryReadout {
  /** Casos semelhantes COM resultado (ACERTOU/ERROU). */
  similarCases: SimilarCase[];
  resolvedCount: number;
  hits: number;
  misses: number;
  /** Taxa bruta, exibida sempre com a amostra do lado. */
  rawHitRate: number | null;
  /** Limite inferior de Wilson — a "taxa histórica" que a confiança usa. */
  historicalConfidence: number | null;
  /** O veredito da memória em uma frase honesta. */
  note: string;
}

/**
 * Consulta a memória para um DNA atual.
 *
 * NEUTRO/INVALIDADO aparecem na lista (contexto vale), mas ficam FORA da
 * taxa: um setup que expirou sem andar não prova acerto nem erro. Vereditos
 * ambíguos contam como o que a regra conservadora decidiu (ERROU).
 */
export function queryMemory(current: SetupDna, cases: MemoryCase[], limit = 12): MemoryReadout {
  const similar: SimilarCase[] = [];
  for (const memoryCase of cases) {
    // O próprio print não é história de si mesmo.
    if (memoryCase.dna.id === current.id) continue;
    const { score, differences } = dnaSimilarity(current, memoryCase.dna);
    if (score >= MIN_SIMILARITY) {
      similar.push({ memoryCase, similarity: score, differences });
    }
  }
  similar.sort((a, b) => b.similarity - a.similarity);
  const top = similar.slice(0, limit);

  const resolved = top.filter(
    (c) => c.memoryCase.verdict === "ACERTOU" || c.memoryCase.verdict === "ERROU",
  );
  const hits = resolved.filter((c) => c.memoryCase.verdict === "ACERTOU").length;
  const misses = resolved.length - hits;

  if (resolved.length === 0) {
    return {
      similarCases: top,
      resolvedCount: 0,
      hits: 0,
      misses: 0,
      rawHitRate: null,
      historicalConfidence: null,
      note:
        top.length === 0
          ? "nenhum caso semelhante na memória ainda"
          : `${top.length} caso(s) semelhante(s), nenhum com resultado — sem taxa histórica`,
    };
  }

  const raw = hits / resolved.length;
  const wilson = wilsonLowerBound(hits, resolved.length);
  const sufficient = resolved.length >= MIN_CASES_FOR_RATE;

  return {
    similarCases: top,
    resolvedCount: resolved.length,
    hits,
    misses,
    rawHitRate: Number((raw * 100).toFixed(1)),
    historicalConfidence: Number((wilson * 100).toFixed(1)),
    note: sufficient
      ? `${resolved.length} casos resolvidos: ${hits} acertos, ${misses} erros`
      : `apenas ${resolved.length}/${MIN_CASES_FOR_RATE} casos resolvidos — taxa exibida, conclusão NÃO autorizada`,
  };
}

/**
 * Composição da confiança final: a VISUAL (qualidade da leitura desta
 * imagem) segue sendo a base; a HISTÓRICA entra com peso proporcional à
 * evidência resolvida, saturando em metade do peso total. Sem memória
 * suficiente, a confiança final É a visual — a memória nunca INVENTA
 * convicção, no máximo tempera.
 */
export function combineConfidence(
  visualConfidence: number,
  memory: Pick<MemoryReadout, "historicalConfidence" | "resolvedCount">,
): { finalConfidence: number; formula: string } {
  if (memory.historicalConfidence === null || memory.resolvedCount === 0) {
    return { finalConfidence: Math.round(visualConfidence), formula: "só leitura visual" };
  }
  // Peso da história cresce com a amostra e satura em 0,5 aos 20 casos.
  const historyWeight = Math.min(0.5, memory.resolvedCount / 40);
  const final =
    visualConfidence * (1 - historyWeight) + memory.historicalConfidence * historyWeight;
  return {
    finalConfidence: Math.round(final),
    formula: `visual ${Math.round(visualConfidence)}% × ${(1 - historyWeight).toFixed(2)} + histórica ${memory.historicalConfidence}% × ${historyWeight.toFixed(2)}`,
  };
}
