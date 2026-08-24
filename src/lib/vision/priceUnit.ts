import {
  plausiblePriceRange,
  resolveInstrument,
  validateProductionPrice,
} from "@/lib/engines/instruments";

/**
 * A UNIDADE DO PREÇO LIDO — pontos, e não a notação da tela.
 *
 * O DEFEITO, VISTO EM PRODUÇÃO NA SESSÃO DE 20/08/2026 ÀS 15:26.
 *
 * O eixo do Profit escreve `170.665` usando o ponto como separador de MILHAR,
 * à brasileira: são cento e setenta mil, seiscentos e sessenta e cinco pontos.
 * O modelo às vezes converte para `170665` e às vezes copia o texto literal
 * para o JSON, virando o número `170.665`. Não é hipótese — o histórico de
 * gatilho do setup T4-2026-08-20-008 registrou as duas formas dentro do MESMO
 * setup:
 *
 *     v2 = 170540      v3 = 170.52      v4 = 170570
 *
 * E o setup 009 saiu inteiro na notação errada: entry 170,685 · stop 170,43 ·
 * gatilho 170,68.
 *
 * POR QUE ISSO DESTRÓI A T4, e não só a exibição: a tolerância de rompimento é
 * UM TICK — 5 pontos no WINFUT. Contra um gatilho de `170,68`, cinco unidades
 * são 3% do valor, então TODO preço fica "dentro da tolerância" e a máquina
 * para de distinguir rompimento de ruído. Distância, R:R e versionamento de
 * gatilho quebram junto: `v3 = 170.52` foi gravado como um gatilho NOVO quando
 * era o mesmo nível em outra unidade.
 *
 * A CORREÇÃO É CONSERVADORA DE PROPÓSITO. Só se normaliza quando o número
 * ORIGINAL não fecha com o tick do instrumento E o número multiplicado por mil
 * fecha. Nesse par de condições não há dúvida sobre o que aconteceu: `170,68`
 * não é preço de WINFUT (que tem zero casas decimais), e `170.680` é, alinhado
 * ao tick de 5. Um número que não fecha de nenhum dos dois jeitos fica INTACTO
 * — inventar unidade para ele seria trocar um erro visível por um escondido.
 *
 * Sem símbolo, ou com símbolo que não conhecemos, nada é tocado: sem o tick não
 * existe régua para julgar, e quem não sabe não corrige.
 */

/** O fator entre a notação de milhar da tela e os pontos do contrato. */
const FATOR_DE_MILHAR = 1000;

export interface PriceUnitFix {
  value: number;
  /** Preenchido só quando houve conversão — é o texto do reparo declarado. */
  repair: string | null;
}

/**
 * Converte um preço lido para a unidade do instrumento, quando for o caso.
 *
 * PURA. `label` entra só para o reparo dizer QUAL campo foi convertido: um
 * reparo que não nomeia o campo obriga o operador a caçar o número na tela.
 */
export function normalizePriceUnit(
  value: number,
  symbol: string | null,
  label: string,
): PriceUnitFix {
  if (!Number.isFinite(value) || value <= 0) return { value, repair: null };
  const instrumento = symbol === null ? null : resolveInstrument(symbol);
  if (instrumento === null) return { value, repair: null };

  if (validateProductionPrice(value, instrumento).valid) return { value, repair: null };

  const escalado = value * FATOR_DE_MILHAR;
  if (!validateProductionPrice(escalado, instrumento).valid) return { value, repair: null };

  /*
   * O TICK SOZINHO NÃO BASTA — foi o furo desta função.
   *
   * O tick do WINFUT é 5, então QUALQUER inteiro não múltiplo de 5 reprova no
   * teste acima, e multiplicá-lo por mil sempre produz múltiplo de 5. Ou seja:
   * um dígito errado de OCR — `170433` no lugar de `170430` — passava pelas
   * duas condições e virava `170.433.000`, mil vezes o preço real, com um
   * "reparo" declarado por cima afirmando que a conversão estava certa.
   *
   * A notação de milhar tem uma assinatura que o erro de dígito não tem: o
   * número lido fica ABAIXO da faixa do contrato (`170,68` num ativo que opera
   * na casa dos 170 mil) e só o escalado cai dentro dela. Exigir as duas
   * pontas é o que separa "faltou o milhar" de "o OCR errou um dígito".
   *
   * Sem faixa conhecida para a família do contrato, nada é convertido.
   */
  const faixa = plausiblePriceRange(instrumento.symbol);
  if (faixa === null) return { value, repair: null };
  if (value >= faixa.min) return { value, repair: null };
  if (escalado < faixa.min || escalado > faixa.max) return { value, repair: null };

  return {
    value: escalado,
    repair:
      `${label}: ${value} lido como ${escalado} — o eixo do ${instrumento.symbol} usa ponto ` +
      `de milhar, e ${value} não fecha com o tick de ${instrumento.tickSize}.`,
  };
}
