/**
 * Instrumentos (spec V5 §14, §29) — tick size, valor do ponto e decimais.
 *
 * Valores padrão são os contratos reais da B3, mas SEMPRE sobrescrevíveis pela
 * configuração do usuário — nada fica hardcoded espalhado pelo código: este
 * registro é o único lugar que conhece esses números.
 */

export interface Instrument {
  symbol: string;
  label: string;
  /** Menor variação de preço do contrato (em pontos). */
  tickSize: number;
  /** Valor financeiro de 1 ponto por contrato, em R$. */
  pointValue: number;
  /** Casas decimais da cotação. */
  decimals: number;
}

/** Padrões reais da B3 — ponto de partida, não verdade imutável. */
const DEFAULT_INSTRUMENTS: Instrument[] = [
  { symbol: "WINFUT", label: "Mini Índice (WIN)", tickSize: 5, pointValue: 0.2, decimals: 0 },
  { symbol: "WDOFUT", label: "Mini Dólar (WDO)", tickSize: 0.5, pointValue: 10, decimals: 1 },
  { symbol: "INDFUT", label: "Índice cheio (IND)", tickSize: 5, pointValue: 1, decimals: 0 },
  { symbol: "DOLFUT", label: "Dólar cheio (DOL)", tickSize: 0.5, pointValue: 50, decimals: 1 },
];

export interface InstrumentOverrides {
  tickSize?: number;
  pointValue?: number;
  decimals?: number;
}

function positive(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Resolve o instrumento do ativo com sobrescritas do usuário.
 * Ativo desconhecido sem configuração completa devolve null — o sistema
 * mostra "configure o instrumento" em vez de inventar tick/valor do ponto.
 */
export function resolveInstrument(
  asset: string,
  overrides: InstrumentOverrides = {},
): Instrument | null {
  const symbol = asset.trim().toUpperCase();
  const base = DEFAULT_INSTRUMENTS.find(
    (instrument) =>
      symbol === instrument.symbol || symbol.startsWith(instrument.symbol.slice(0, 3)),
  );
  const tickSize = positive(overrides.tickSize) ?? base?.tickSize ?? null;
  const pointValue = positive(overrides.pointValue) ?? base?.pointValue ?? null;
  const decimals =
    typeof overrides.decimals === "number" &&
    Number.isFinite(overrides.decimals) &&
    overrides.decimals >= 0
      ? Math.floor(overrides.decimals)
      : (base?.decimals ?? null);
  if (tickSize === null || pointValue === null || decimals === null) return null;
  return { symbol, label: base?.label ?? symbol, tickSize, pointValue, decimals };
}

/** Alinha um preço ao tick do instrumento. */
export function alignToTick(price: number, instrument: Instrument): number {
  return Math.round(price / instrument.tickSize) * instrument.tickSize;
}

/**
 * FAIXA PLAUSÍVEL DE PREÇO POR FAMÍLIA DE CONTRATO.
 *
 * Estes números viviam copiados em três lugares (a régua de escala, a projeção
 * de preço e a normalização de unidade). Três cópias da mesma régua é uma régua
 * que muda de valor conforme quem pergunta — e o cabeçalho deste arquivo já
 * dizia que os números do contrato moram AQUI.
 *
 * A faixa é grosseira DE PROPÓSITO: ela não valida preço (isso é trabalho do
 * tick), ela separa ORDEM DE GRANDEZA — distingue "cento e setenta mil pontos"
 * de "cento e setenta", que é o erro que a notação de milhar brasileira produz.
 */
const PRICE_RANGES: Array<{ pattern: RegExp; min: number; max: number }> = [
  { pattern: /^(WIN|IND)/i, min: 10_000, max: 500_000 },
  { pattern: /^(WDO|DOL)/i, min: 1_000, max: 20_000 },
];

export interface PriceRange {
  min: number;
  max: number;
}

/**
 * Faixa plausível do símbolo, ou null quando a família é desconhecida.
 *
 * Null significa "não sei julgar" — e quem não sabe não corrige.
 */
export function plausiblePriceRange(symbol: string): PriceRange | null {
  const found = PRICE_RANGES.find((range) => range.pattern.test(symbol.trim()));
  return found === undefined ? null : { min: found.min, max: found.max };
}

/**
 * Validação de preço de produção (spec V5 §15): finito, positivo e alinhado ao
 * tick (dentro de meia unidade de arredondamento). Devolve o motivo da recusa.
 */
export function validateProductionPrice(
  price: number,
  instrument: Instrument,
): { valid: boolean; reason: string } {
  if (!Number.isFinite(price)) return { valid: false, reason: "Preço não numérico." };
  if (price <= 0) return { valid: false, reason: `Preço ${price} não é positivo.` };
  const aligned = alignToTick(price, instrument);
  const drift = Math.abs(price - aligned);
  // Alinhado = desvio numérico desprezível. Meio tick de tolerância validaria
  // QUALQUER preço (o arredondamento nunca desvia mais que tick/2).
  if (drift > Math.max(1e-9, instrument.tickSize * 1e-6)) {
    return {
      valid: false,
      reason: `Preço ${price} não alinhado ao tick ${instrument.tickSize} de ${instrument.symbol}.`,
    };
  }
  return { valid: true, reason: "" };
}
