/**
 * MONTE CARLO DE SEQUÊNCIA DE TRADES — drawdown provável (roteiro §29).
 *
 * A ordem em que os trades aconteceram é UMA amostra da história; o drawdown
 * observado nela é um único sorteio. Reembaralhar a MESMA sequência (mesmos
 * resultados, outra ordem) mostra a distribuição de drawdowns que aquela
 * estratégia poderia ter vivido — e é o P95 dessa distribuição, não o DD
 * histórico, que dimensiona risco.
 *
 * PURO E REPRODUTÍVEL: Math.random é PROIBIDO aqui — pesquisa irreproduzível
 * não é pesquisa. Todo sorteio sai de um LCG semeado pelo chamador: a mesma
 * seed produz exatamente o mesmo relatório, hoje e daqui a um ano.
 */

/** Equity acumulada abaixo disto (em R) caracteriza ruína no run. */
export const RUIN_THRESHOLD_R = -20;

/**
 * LCG de Numerical Recipes (a=1664525, c=1013904223, m=2^32).
 * Math.imul mantém a multiplicação em 32 bits sem estourar o double;
 * `>>> 0` normaliza para uint32. Qualidade estatística modesta é suficiente
 * para embaralhar sequências — o requisito inegociável é o determinismo.
 */
function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296; // [0, 1)
  };
}

/** Fisher–Yates com o PRNG semeado — permutação uniforme, nunca sort(random). */
function shuffledCopy(values: readonly number[], rand: () => number): number[] {
  const arr = [...values];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

/**
 * Percentil por posto (nearest-rank) sobre lista JÁ ordenada ascendente.
 * Sem interpolação: o valor devolvido SEMPRE aconteceu em algum run —
 * nada de drawdown "médio" que nenhuma simulação produziu.
 */
function percentileSorted(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1),
  );
  return sortedAsc[idx]!;
}

/**
 * Simula `runs` permutações da sequência de resultados (em R) e mede, por
 * run: drawdown máximo (pico→vale da equity, valor positivo em R), pior
 * sequência de perdas consecutivas e ruína (equity < RUIN_THRESHOLD_R em
 * qualquer ponto do caminho — não só no fim).
 *
 * Saída: P50/P95 dos drawdowns, P95 das sequências de perda e a fração de
 * runs arruinados. P95 ≥ P50 por construção (percentis da MESMA ordenação).
 *
 * Entrada vazia, runs < 1 ou trade não numérico devolvem TUDO zerado com
 * `runs: 0` — o marcador de que a simulação NÃO foi executada. Inventar
 * percentil de amostra inexistente seria conclusão sem dado.
 */
export function monteCarloDrawdown(
  tradeRs: number[],
  runs: number,
  seed: number,
): {
  maxDrawdownP50: number;
  maxDrawdownP95: number;
  worstLossStreakP95: number;
  ruinProbability: number;
  runs: number;
} {
  const invalid =
    !Number.isInteger(runs) ||
    runs < 1 ||
    tradeRs.length === 0 ||
    tradeRs.some((r) => !Number.isFinite(r));
  if (invalid) {
    return {
      maxDrawdownP50: 0,
      maxDrawdownP95: 0,
      worstLossStreakP95: 0,
      ruinProbability: 0,
      runs: 0,
    };
  }

  const rand = makeLcg(seed);
  const maxDrawdowns: number[] = [];
  const worstStreaks: number[] = [];
  let ruinedRuns = 0;

  for (let run = 0; run < runs; run++) {
    const sequence = shuffledCopy(tradeRs, rand);
    let equity = 0;
    let peak = 0;
    let maxDrawdown = 0;
    let streak = 0;
    let worstStreak = 0;
    let ruined = false;

    for (const r of sequence) {
      equity += r;
      if (equity > peak) peak = equity;
      const drawdown = peak - equity;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
      if (r < 0) {
        streak += 1;
        if (streak > worstStreak) worstStreak = streak;
      } else {
        streak = 0;
      }
      if (equity < RUIN_THRESHOLD_R) ruined = true;
    }

    maxDrawdowns.push(maxDrawdown);
    worstStreaks.push(worstStreak);
    if (ruined) ruinedRuns += 1;
  }

  maxDrawdowns.sort((a, b) => a - b);
  worstStreaks.sort((a, b) => a - b);

  return {
    maxDrawdownP50: percentileSorted(maxDrawdowns, 50),
    maxDrawdownP95: percentileSorted(maxDrawdowns, 95),
    worstLossStreakP95: percentileSorted(worstStreaks, 95),
    ruinProbability: ruinedRuns / runs,
    runs,
  };
}
