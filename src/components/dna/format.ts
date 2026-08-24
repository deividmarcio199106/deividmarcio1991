/**
 * Formatação do painel DNA — números falam pt-BR e ausência é DITA.
 *
 * A regra que atravessa o arquivo: null NUNCA vira 0 nem string vazia. Um zero
 * inventado numa coluna de R é conclusão falsa disfarçada de formatação; o
 * traço "—" diz "não existe medida aqui", que é a verdade.
 */

/** R com 2 decimais e SINAL explícito — o "+" carrega tanta informação
 * quanto o "-" numa coluna de expectância. */
export function formatR(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const absolute = Math.abs(value).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${value < 0 ? "-" : "+"}${absolute}R`;
}

/** Percentual já multiplicado por 100 no servidor — aqui só veste o texto. */
export function formatPct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
}

/** Contagens inteiras (detected, sample, wins…) no locale da casa. */
export function formatInt(value: number): string {
  return value.toLocaleString("pt-BR");
}

/**
 * Payoff / profit factor. Infinity é estado legítimo (nenhuma perda no grupo)
 * e vira "∞" — arredondar para um número grande esconderia o que aconteceu.
 * (No trajeto HTTP o JSON converte Infinity em null; o "—" resultante também
 * é honesto: sem perdas não há razão computável.)
 */
export function formatFactor(value: number | null): string {
  if (value === null) return "—";
  if (!Number.isFinite(value)) return "∞";
  return value.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Número simples com decimais fixos (RR, ratio) — sem sinal forçado. */
export function formatNumber(value: number | null, decimals = 2): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toLocaleString("pt-BR", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Ordinal do setup no movimento (§4): 1ª/2ª/3ª/posterior. Null é dito como
 * SEM ORDINAL — sem impulso medível não há movimento para numerar.
 */
export function ordinalLabel(ordinal: 1 | 2 | 3 | 4 | null): string {
  if (ordinal === null) return "SEM ORDINAL";
  if (ordinal >= 4) return "posterior";
  return `${ordinal}ª`;
}
