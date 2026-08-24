/**
 * DIVISÃO TREINO / VALIDAÇÃO / FORA-DA-AMOSTRA — temporal, nunca aleatória.
 *
 * Série temporal embaralhada vaza futuro para dentro do treino: o candidato
 * "aprende" com dias que, na validação, fingem ser inéditos. A divisão aqui é
 * por PREGÃO, em ordem cronológica, com o fora-da-amostra sempre no FIM —
 * os dias mais recentes são os únicos que a candidata comprovadamente nunca
 * viu durante a própria criação.
 *
 * O resultado é DECLARATIVO (listas de datas): quem grava os datasets no
 * banco os congela (`frozen`), e um recorte usado em validação não muda mais.
 */

/** Menos pregões que isto e nenhuma divisão é honesta — só ruído repartido. */
export const MIN_SPLIT_DAYS = 10;

export interface DatasetSlice {
  kind: "TREINO" | "VALIDACAO" | "OOS";
  startDate: string;
  endDate: string;
  dates: string[];
}

export interface DatasetSplit {
  treino: DatasetSlice;
  validacao: DatasetSlice;
  oos: DatasetSlice;
  totalDays: number;
}

export const DEFAULT_PROPORTIONS = { treino: 0.7, validacao: 0.15, oos: 0.15 } as const;

/**
 * Divide pregões (yyyy-mm-dd) em três fatias cronológicas.
 *
 * Devolve null quando a amostra não sustenta a divisão — dividir 6 dias em
 * três fatias produz "validação" de um dia, que valida nada e ainda parece
 * método. As três fatias saem SEMPRE não vazias quando a divisão acontece.
 */
export function splitTradingDates(
  dates: readonly string[],
  proportions: { treino: number; validacao: number; oos: number } = DEFAULT_PROPORTIONS,
): DatasetSplit | null {
  const unique = [...new Set(dates.filter(Boolean))].sort();
  if (unique.length < MIN_SPLIT_DAYS) return null;

  const soma = proportions.treino + proportions.validacao + proportions.oos;
  if (soma <= 0) return null;

  // O arredondamento nunca pode zerar validação/OOS: fatia mínima de 1 dia.
  const oosCount = Math.max(1, Math.round((proportions.oos / soma) * unique.length));
  const validacaoCount = Math.max(1, Math.round((proportions.validacao / soma) * unique.length));
  const treinoCount = unique.length - validacaoCount - oosCount;
  if (treinoCount < 1) return null;

  const treino = unique.slice(0, treinoCount);
  const validacao = unique.slice(treinoCount, treinoCount + validacaoCount);
  const oos = unique.slice(treinoCount + validacaoCount);

  const slice = (kind: DatasetSlice["kind"], list: string[]): DatasetSlice => ({
    kind,
    startDate: list[0]!,
    endDate: list[list.length - 1]!,
    dates: list,
  });

  return {
    treino: slice("TREINO", treino),
    validacao: slice("VALIDACAO", validacao),
    oos: slice("OOS", oos),
    totalDays: unique.length,
  };
}

/**
 * O pregão pertence à fatia? Comparação por string funciona porque o formato
 * yyyy-mm-dd ordena lexicograficamente igual à cronologia.
 */
export function dateInSlice(date: string, slice: DatasetSlice): boolean {
  return date >= slice.startDate && date <= slice.endDate && slice.dates.includes(date);
}
