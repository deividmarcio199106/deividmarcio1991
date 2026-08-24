// Formatação de preço em R$ (spec §4: "Todos os valores devem ser formatados
// conforme o ativo analisado"). Função pura — nunca fabrica um valor: preço
// ausente/inválido sempre vira "Dado indisponível", nunca "R$ 0,00".

const formatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "Dado indisponível";
  return formatter.format(value);
}

const percentFormatter = new Intl.NumberFormat("pt-BR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "Dado indisponível";
  return `${value > 0 ? "+" : ""}${percentFormatter.format(value)}%`;
}
