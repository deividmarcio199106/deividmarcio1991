/**
 * CICLO DE VIDA DE REGRAS (spec finalíssimo §53, §116–§118).
 *
 * Nova técnica NUNCA entra direto em produção. Estados:
 * DISCOVERED → EXTRACTED → STRUCTURED → TESTING (shadow) → VALIDATED →
 * APPROVED → ACTIVE. Só APPROVED pode virar ACTIVE, e a promoção exige
 * comparação real com o baseline: se piorar, não promove.
 */

export type RuleState =
  | "DISCOVERED"
  | "EXTRACTED"
  | "STRUCTURED"
  | "TESTING"
  | "VALIDATED"
  | "APPROVED"
  | "ACTIVE"
  | "DEGRADED";

const FORWARD: Record<RuleState, RuleState[]> = {
  DISCOVERED: ["EXTRACTED"],
  EXTRACTED: ["STRUCTURED"],
  STRUCTURED: ["TESTING"],
  TESTING: ["VALIDATED"],
  VALIDATED: ["APPROVED", "TESTING"],
  APPROVED: ["ACTIVE", "TESTING"],
  ACTIVE: ["DEGRADED", "TESTING"],
  DEGRADED: ["TESTING"],
};

export interface StrategyRule {
  id: string;
  name: string;
  state: RuleState;
  source: string;
  version: string;
  /** true = roda em paralelo SEM afetar a decisão de produção (§53). */
  shadow: boolean;
}

export function canTransition(from: RuleState, to: RuleState): boolean {
  return FORWARD[from].includes(to);
}

export interface PerformanceSnapshot {
  sample: number;
  winRate: number;
  expectancy: number;
}

export const PROMOTION_MIN_SAMPLE = 30;

/**
 * §69/§118 — promoção APPROVED → ACTIVE só com amostra mínima e sem piorar o
 * baseline (expectância E estabilidade de acerto).
 */
export function canPromoteToActive(
  rule: StrategyRule,
  baseline: PerformanceSnapshot,
  candidate: PerformanceSnapshot,
  minSample = PROMOTION_MIN_SAMPLE,
): { allowed: boolean; reason: string } {
  if (rule.state !== "APPROVED") {
    return {
      allowed: false,
      reason: `Regra em ${rule.state}: somente APPROVED pode virar ACTIVE.`,
    };
  }
  if (candidate.sample < minSample) {
    return {
      allowed: false,
      reason: `Amostra da regra insuficiente: ${candidate.sample}/${minSample} operações em shadow.`,
    };
  }
  if (candidate.expectancy < baseline.expectancy) {
    return {
      allowed: false,
      reason: `Expectância com a regra (${candidate.expectancy.toFixed(2)}R) pior que o baseline (${baseline.expectancy.toFixed(2)}R).`,
    };
  }
  if (candidate.winRate < baseline.winRate - 5) {
    return {
      allowed: false,
      reason: `Acerto caiu mais de 5pp vs baseline (${candidate.winRate.toFixed(0)}% vs ${baseline.winRate.toFixed(0)}%).`,
    };
  }
  return { allowed: true, reason: "Regra aprovada supera o baseline com amostra suficiente." };
}

/** Decisões de produção NUNCA usam regras shadow ou fora de ACTIVE. */
export function productionRules(rules: StrategyRule[]): StrategyRule[] {
  return rules.filter((rule) => rule.state === "ACTIVE" && !rule.shadow);
}
