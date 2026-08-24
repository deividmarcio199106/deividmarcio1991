import type { Candle, Direction } from "./types";
import type { Instrument } from "./instruments";

/**
 * Risco financeiro REAL (spec V5 §29–§32) e MFE/MAE (§33–§34).
 *
 * Nenhum valor financeiro é presumido: sem saldo/risco configurado o motor
 * devolve `configured: false` com a mensagem "Configure o risco financeiro" —
 * nunca um número inventado.
 */

export interface FinancialRiskConfig {
  /** Saldo da conta em R$. 0 ou ausente = não configurado. */
  accountBalance: number;
  /** Risco máximo por operação em % do saldo. 0 = não usar. */
  maxRiskPercent: number;
  /** Risco máximo por operação em R$ (tem prioridade sobre o percentual). 0 = não usar. */
  maxRiskMoney: number;
  /** Teto físico de contratos. */
  contractsLimit: number;
}

/** riskPoints com direção explícita (§30): compra = entry−stop; venda = stop−entry. */
export function riskPoints(
  direction: Exclude<Direction, "NEUTRO">,
  entryPrice: number,
  stopPrice: number,
): number | null {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(stopPrice)) return null;
  const points = direction === "COMPRA" ? entryPrice - stopPrice : stopPrice - entryPrice;
  return points > 0 ? points : null; // stop do lado errado nunca vira risco válido
}

/** Risco financeiro máximo aceito, resolvido a partir da configuração (§31). */
export function resolveMaxRiskMoney(config: FinancialRiskConfig): number | null {
  if (config.maxRiskMoney > 0 && Number.isFinite(config.maxRiskMoney)) return config.maxRiskMoney;
  if (
    config.accountBalance > 0 &&
    config.maxRiskPercent > 0 &&
    Number.isFinite(config.accountBalance) &&
    Number.isFinite(config.maxRiskPercent)
  ) {
    return (config.accountBalance * config.maxRiskPercent) / 100;
  }
  return null;
}

export interface FinancialContractsResult {
  configured: boolean;
  contracts: number;
  riskPerContract: number | null;
  maxRiskMoney: number | null;
  reason: string;
}

/** contractsByRisk = floor(maxRiskMoney / (riskPoints × pointValue)) (§30). */
export function computeContractsByFinancialRisk(
  direction: Exclude<Direction, "NEUTRO">,
  entryPrice: number,
  stopPrice: number,
  instrument: Instrument,
  config: FinancialRiskConfig,
): FinancialContractsResult {
  const maxMoney = resolveMaxRiskMoney(config);
  if (maxMoney === null) {
    return {
      configured: false,
      contracts: 0,
      riskPerContract: null,
      maxRiskMoney: null,
      reason: "Configure o risco financeiro (saldo + % de risco, ou risco em R$ por operação).",
    };
  }
  const points = riskPoints(direction, entryPrice, stopPrice);
  if (points === null) {
    return {
      configured: true,
      contracts: 0,
      riskPerContract: null,
      maxRiskMoney: maxMoney,
      reason: "Stop do lado errado da entrada — risco em pontos inválido.",
    };
  }
  const riskPerContract = points * instrument.pointValue;
  const contracts = Math.max(0, Math.floor(maxMoney / riskPerContract));
  return {
    configured: true,
    contracts,
    riskPerContract,
    maxRiskMoney: maxMoney,
    reason:
      contracts > 0
        ? `Risco de R$ ${riskPerContract.toFixed(2)}/contrato dentro do máximo de R$ ${maxMoney.toFixed(2)}.`
        : `Risco de R$ ${riskPerContract.toFixed(2)}/contrato excede o máximo de R$ ${maxMoney.toFixed(2)} — nenhum contrato autorizado.`,
  };
}

/** Quantidade final: limitada exclusivamente pelo risco financeiro e pelo teto físico configurado. */
export function finalContracts(contractsByRisk: number, contractsLimit: number): number {
  return Math.max(0, Math.min(contractsByRisk, contractsLimit));
}

export interface MfeMae {
  /** Máxima excursão favorável em pontos (§33). */
  mfePoints: number;
  /** Máxima excursão adversa em pontos (§34). */
  maePoints: number;
  /** Em múltiplos de R quando a distância do stop é conhecida. */
  mfeR: number | null;
  maeR: number | null;
  candlesMeasured: number;
}

/**
 * MFE/MAE medidos sobre candles REAIS posteriores à entrada — nunca estimados.
 * Compra: MFE = maxHigh − entry, MAE = entry − minLow. Venda: invertido.
 */
export function computeMfeMae(
  direction: Exclude<Direction, "NEUTRO">,
  entryPrice: number,
  candlesAfterEntry: Candle[],
  stopDistancePoints: number | null = null,
): MfeMae | null {
  if (!Number.isFinite(entryPrice) || candlesAfterEntry.length === 0) return null;
  let maxHigh = -Infinity;
  let minLow = Infinity;
  for (const candle of candlesAfterEntry) {
    if (!Number.isFinite(candle.h) || !Number.isFinite(candle.l)) continue;
    maxHigh = Math.max(maxHigh, candle.h);
    minLow = Math.min(minLow, candle.l);
  }
  if (!Number.isFinite(maxHigh) || !Number.isFinite(minLow)) return null;
  const mfePoints =
    direction === "COMPRA" ? Math.max(0, maxHigh - entryPrice) : Math.max(0, entryPrice - minLow);
  const maePoints =
    direction === "COMPRA" ? Math.max(0, entryPrice - minLow) : Math.max(0, maxHigh - entryPrice);
  const validStop =
    stopDistancePoints !== null && Number.isFinite(stopDistancePoints) && stopDistancePoints > 0;
  return {
    mfePoints,
    maePoints,
    mfeR: validStop ? mfePoints / stopDistancePoints : null,
    maeR: validStop ? maePoints / stopDistancePoints : null,
    candlesMeasured: candlesAfterEntry.length,
  };
}
