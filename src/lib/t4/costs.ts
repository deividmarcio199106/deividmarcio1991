/**
 * CUSTO OPERACIONAL — o que separa expectância de lucro.
 *
 * O backtest media resultado BRUTO. Nenhum ponto de corretagem, emolumento,
 * spread ou derrapagem entrava na conta, e o `rMultiple` gravado ia direto para
 * a base de evidência que autoriza operação real.
 *
 * O tamanho do erro depende do risco da operação, e é onde ele engana: com stop
 * curto o custo pesa MUITO mais em R. Um stop de 100 pontos no WIN arrisca
 * R$ 20 por contrato; o custo de ida e volta come uma fração relevante disso.
 * A mesma técnica pode ter expectância positiva no bruto e negativa no líquido —
 * e a decisão de operar sai da expectância.
 *
 * A CONVERSÃO PARA R É O PONTO. Custo em reais só vira comparável quando
 * dividido pelo risco em reais da própria operação:
 *
 *   riscoEmReais = distanciaDoStop(pontos) × valorDoPonto × contratos
 *   custoEmR     = custoTotalEmReais ÷ riscoEmReais
 *
 * Assim `rLiquido = rBruto − custoEmR` fica na mesma unidade de tudo que a
 * técnica já mede.
 */

import type { AssetConfig } from "./assets";

export interface CostInput {
  config: AssetConfig;
  /** Distância entrada→stop, em pontos do contrato. */
  stopDistancePoints: number;
  contracts: number;
  /** Quantas pernas de saída a operação teve. A entrada é sempre uma. */
  exitLegs: number;
}

export interface CostBreakdown {
  brokerage: number;
  exchangeFees: number;
  /** Spread e derrapagem convertidos de ticks para reais. */
  slippage: number;
  totalMoney: number;
  /** Custo em múltiplos de R. É este que sai do resultado. */
  costR: number | null;
}

export const NO_COST: CostBreakdown = {
  brokerage: 0,
  exchangeFees: 0,
  slippage: 0,
  totalMoney: 0,
  costR: null,
};

/**
 * Custo total da operação, em reais e em R.
 *
 * Cada perna paga corretagem e emolumentos: a entrada e cada saída. Uma
 * operação de três contratos com três alvos paga SEIS vezes, não duas — e era
 * exatamente essa multiplicação que faltava.
 */
export function operationCost(input: CostInput): CostBreakdown {
  const { config, contracts, exitLegs } = input;
  const { costs, instrument } = config;

  if (contracts <= 0 || !Number.isFinite(contracts)) return NO_COST;

  // Entrada (1) + cada saída. Uma operação encerrada em três alvos tem 3 saídas.
  const legs = 1 + Math.max(1, Math.round(exitLegs));
  const brokerage = costs.brokeragePerContract * contracts * legs;
  const exchangeFees = costs.exchangeFeesPerContract * contracts * legs;

  // Spread é pago UMA vez, na entrada; derrapagem acontece em cada perna.
  const ticksPerdidos = costs.spreadTicks + costs.slippageTicks * legs;
  const slippage = ticksPerdidos * instrument.tickSize * instrument.pointValue * contracts;

  const totalMoney = brokerage + exchangeFees + slippage;

  const riscoEmReais = input.stopDistancePoints * instrument.pointValue * contracts;
  // Sem risco não há R, e sem R o custo não é conversível. Devolver 0 aqui
  // esconderia o custo em vez de declará-lo indisponível.
  const costR = riscoEmReais > 0 ? totalMoney / riscoEmReais : null;

  return { brokerage, exchangeFees, slippage, totalMoney, costR };
}

/**
 * Resultado LÍQUIDO da operação.
 *
 * Quando o custo não é conversível, devolve o bruto e diz isso pelo `liquido`
 * falso — nunca finge que custo zero é o mesmo que custo desconhecido.
 */
export function netR(grossR: number, cost: CostBreakdown): { r: number; liquido: boolean } {
  if (cost.costR === null) return { r: grossR, liquido: false };
  return { r: grossR - cost.costR, liquido: true };
}

/* ------------------------------------------------------------------------ *
 * LIQUIDAÇÃO — os campos que o banco é obrigado a receber
 * ------------------------------------------------------------------------ */

export interface LiquidacaoInput {
  config: AssetConfig;
  /** R BRUTO apurado pelo rastreador de desfecho. */
  grossR: number;
  stopDistancePoints: number;
  contracts: number;
  exitLegs: number;
}

export interface Liquidacao {
  /** R LÍQUIDO. É este que vai para `netAfterCostsR` e para a expectância. */
  netR: number;
  /** Falso quando o custo não era conversível — o R devolvido é bruto. */
  liquido: boolean;
  cost: CostBreakdown;
  /** R$ LÍQUIDO da operação → `trades.result_brl`. Null sem risco conversível. */
  resultBrl: number | null;
  /** R$ de custo total → `trades.costs_brl`. */
  costsBrl: number;
  /** Derrapagem total em PONTOS → `trades.slippage_points`. */
  slippagePoints: number;
}

/**
 * Fecha a conta da operação: bruto em R entra, líquido em R e em R$ sai.
 *
 * POR QUE ESTA FUNÇÃO EXISTE em vez de cada chamador multiplicar por conta
 * própria: `result_brl` e `netAfterCostsR` são gravados em pontos diferentes do
 * sistema, e enquanto cada um fazia a sua conta era possível — e aconteceu — o
 * R do banco estar líquido e o R$ da mesma linha estar bruto. Duas colunas da
 * mesma operação descrevendo operações diferentes.
 *
 * `resultBrl` volta null quando o risco não é conversível (stop desconhecido ou
 * zero). Null é a resposta honesta: gravar o bruto no campo líquido seria mentir
 * exatamente no número que decide se a técnica pode operar.
 */
export function liquidarOperacao(input: LiquidacaoInput): Liquidacao {
  const { config, grossR, stopDistancePoints, contracts, exitLegs } = input;
  const cost = operationCost({ config, stopDistancePoints, contracts, exitLegs });
  const { r, liquido } = netR(grossR, cost);

  const { instrument } = config;
  const riscoEmReais = stopDistancePoints * instrument.pointValue * contracts;
  const resultBrl = riscoEmReais > 0 ? r * riscoEmReais : null;

  const legs = 1 + Math.max(1, Math.round(exitLegs));
  const ticks = config.costs.spreadTicks + config.costs.slippageTicks * legs;

  return {
    netR: r,
    liquido,
    cost,
    resultBrl,
    costsBrl: cost.totalMoney,
    slippagePoints: ticks * instrument.tickSize,
  };
}
