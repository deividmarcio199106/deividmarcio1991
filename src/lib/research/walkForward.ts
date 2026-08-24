/**
 * WALK-FORWARD — janelas deslizantes cronológicas (roteiro §27/§28).
 *
 * A RESTRIÇÃO que este módulo existe para garantir: o teste vem SEMPRE
 * depois do treino, no tempo. Otimizar num período e medir no mesmo período
 * (ou em qualquer fatia anterior) é look-ahead — o candidato "descobre" o
 * que já tinha visto. Aqui a série nunca é embaralhada, os folds deslizam
 * para frente e a fração de treino/teste é fixa por construção.
 *
 * PURO: sem IO, sem relógio, sem aleatoriedade. Amostra insuficiente devolve
 * [] — fold fabricado com meia dúzia de candles pareceria método e não é.
 */

export interface Fold {
  /** Timestamps INCLUSIVOS, tirados da própria série (nunca interpolados). */
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
}

/** Fração default da janela dedicada ao treino (o restante é teste). */
export const DEFAULT_TRAIN_FRACTION = 0.7;

/** Menos folds que isto e "estabilidade" é uma moeda jogada 2 vezes. */
export const MIN_FOLDS_FOR_STABILITY = 3;

/**
 * Percentual mínimo de folds com netR positivo para declarar estável.
 * INTEIRO de propósito: a comparação 60% é feita em aritmética inteira
 * (positivos·100 ≥ total·60) e nunca depende de arredondamento binário.
 */
export const STABILITY_MIN_PERCENT = 60;

/**
 * Constrói `folds` janelas deslizantes sobre os timestamps dos candles.
 *
 * Geometria: cada janela tem treino + teste na proporção `trainFraction`;
 * a janela seguinte desliza exatamente o tamanho do teste, então os blocos
 * de teste são contíguos e SEM sobreposição — cada candle é testado no
 * máximo uma vez. As janelas são ancoradas no FIM da série: sobra de
 * arredondamento descarta os candles mais ANTIGOS, nunca os recentes
 * (o dado novo é o que menos se parece com o passado decorado).
 *
 * Devolve [] quando a série não sustenta a geometria pedida (treino ou
 * teste ficariam com menos de 1 candle) — nunca um fold degenerado.
 */
export function buildFolds(
  candleTimes: number[],
  folds: number,
  trainFraction: number = DEFAULT_TRAIN_FRACTION,
): Fold[] {
  if (!Number.isInteger(folds) || folds < 1) return [];
  if (!Number.isFinite(trainFraction) || trainFraction <= 0 || trainFraction >= 1) return [];

  // Ordena e deduplica: timestamp repetido quebraria a garantia
  // testStart > trainEnd na fronteira entre treino e teste.
  const times = [...new Set(candleTimes.filter((t) => Number.isFinite(t)))].sort((a, b) => a - b);
  const n = times.length;

  // trainLen/testLen derivados da fração: trainLen ≈ r·testLen, com
  // r = trainFraction/(1-trainFraction). O total ocupado é
  // trainLen + folds·testLen (os testes deslizam, o primeiro treino ancora).
  const r = trainFraction / (1 - trainFraction);
  const testLen = Math.floor(n / (folds + r));
  const trainLen = Math.round(testLen * r);
  if (testLen < 1 || trainLen < 1) return [];

  const used = trainLen + folds * testLen;
  // Âncora no fim: o que sobra fica fora pelo lado ANTIGO da série.
  const offset = n - used;

  const result: Fold[] = [];
  for (let i = 0; i < folds; i++) {
    const a = offset + i * testLen;
    const trainEndIdx = a + trainLen - 1;
    const testEndIdx = a + trainLen + testLen - 1;
    result.push({
      trainStart: times[a]!,
      trainEnd: times[trainEndIdx]!,
      testStart: times[trainEndIdx + 1]!,
      testEnd: times[testEndIdx]!,
    });
  }
  return result;
}

/**
 * Resume a estabilidade de uma bateria walk-forward.
 *
 * `stable` exige DUAS coisas ao mesmo tempo: pelo menos
 * MIN_FOLDS_FOR_STABILITY folds executados E 60%+ deles com netR POSITIVO
 * (zero não conta — empate não é evidência de robustez). Um ou dois folds
 * vencedores nunca autorizam a conclusão: amostra insuficiente de folds é
 * `stable: false`, não "provavelmente estável".
 *
 * A comparação de fração é feita em inteiros (positivos·100 ≥ total·60)
 * para o limite de 60% não depender de arredondamento binário.
 */
export function walkForwardStability(results: Array<{ netR: number }>): {
  positiveFolds: number;
  totalFolds: number;
  stable: boolean;
} {
  const totalFolds = results.length;
  const positiveFolds = results.filter((f) => Number.isFinite(f.netR) && f.netR > 0).length;
  const stable =
    totalFolds >= MIN_FOLDS_FOR_STABILITY &&
    positiveFolds * 100 >= totalFolds * STABILITY_MIN_PERCENT;
  return { positiveFolds, totalFolds, stable };
}
