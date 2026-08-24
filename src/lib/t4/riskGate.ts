/**
 * O GATE DE RISCO — uma única fórmula de R:R para o sistema inteiro (§11).
 *
 * POR QUE ELE EXISTE COMO MÓDULO: o R:R era calculado em três lugares — a prova
 * de entrada (`evaluateEntryProof`), o card SETUP T4 (`rrDoSetup`) e a máquina
 * de setup. Três cópias da mesma divisão divergem no primeiro ajuste, e a
 * divergência aparece como a tela liberando o que outro painel bloqueia. Aqui a
 * conta mora uma vez e todo mundo pergunta.
 *
 * O QUE ESTE MÓDULO DECIDE, e nada além: com entrada, stop e alvo na mão, a
 * operação passa no risco mínimo da casa? Sem alvo legível, ou com R:R abaixo do
 * mínimo, o veredito é `RISK_REJECTED` — e operação continua BLOQUEADA mesmo com
 * o rompimento confirmado. Confirmação técnica e permissão de operar são coisas
 * diferentes; foi por confundi-las que "confirmado" virou sinônimo de "pode".
 */

import { MIN_RISK_REWARD } from "@/lib/engines/strategy";
import type { BlockCode } from "./blockCodes";

/**
 * R:R MÍNIMO DA CASA — UM número, importado da técnica, nunca redigitado.
 *
 * ESTE MÓDULO SE CONTRADIZIA COM A T4. O comentário acima promete "o mesmo
 * número para print, setup e motor", mas aqui morava `1.5` enquanto
 * `docs/T4_FINAL.md` e `strategy.ts` exigem 3. Como este gate é o que libera
 * OPERATION_RELEASED no caminho de print (setupTracker) e `entradaConfirmada`
 * na análise de print, um setup de 1,5R saía na tela como "T4 CONFIRMADA —
 * ENTRADA LIBERADA": metade do espaço técnico que a técnica manda exigir.
 *
 * Pior que o risco por operação: o benchmark que autoriza operar (PF ≥ 3,
 * drawdown ≤ 5R) foi medido sobre 3R. Liberar 1,5R na tela e comparar com uma
 * régua de 3R é medir uma técnica e operar outra.
 *
 * Agora o valor é IMPORTADO. Um segundo piso não pode voltar a existir por
 * digitação — quem quiser mudar o mínimo muda na técnica, e o sistema inteiro
 * acompanha. Decisão do dono da técnica, tomada em 21/08/2026: vale 3.
 */
export const MIN_RR = MIN_RISK_REWARD;

export type RiskVerdict = "RISK_APPROVED" | "RISK_REJECTED" | "RISK_UNKNOWN";

export interface RiskInput {
  side: "COMPRA" | "VENDA" | "NEUTRO";
  /** Níveis NUMÉRICOS já lidos. Null = não identificado — nunca zero, nunca estimado. */
  entry: number | null;
  stop: number | null;
  target: number | null;
  minRr?: number;
}

export interface RiskAssessment {
  verdict: RiskVerdict;
  /** Razão risco/retorno. Null quando falta nível ou o risco é zero. */
  rr: number | null;
  /** Distância entrada→stop, em pontos. Null sem os dois níveis. */
  riskPoints: number | null;
  /** Distância entrada→alvo, em pontos. Null sem os dois níveis. */
  rewardPoints: number | null;
  /** Stop e alvo estão dos lados corretos da entrada para o lado declarado. */
  coherent: boolean;
  /** Por que reprovou/não deu para julgar. Vazio SÓ em RISK_APPROVED. */
  problems: string[];
  /**
   * Código ESTÁVEL da recusa — o que log, UI e teste comparam. `null` SÓ em
   * RISK_APPROVED. RISK_UNKNOWN carrega PRICE_UNRELIABLE: faltou número legível
   * para julgar, e nível ilegível é dado não confiável, não aprovação tímida.
   */
  blockCode: BlockCode | null;
}

/**
 * Avalia o risco da operação.
 *
 * `RISK_UNKNOWN` não é aprovação envergonhada: é "faltou número para julgar", e
 * o chamador é obrigado a tratá-lo como bloqueio. A distinção existe porque a
 * pendência que a tela mostra é diferente — "alvo NÃO IDENTIFICADO" manda o
 * operador ler o gráfico; "R:R 0,80 abaixo do mínimo" manda descartar a
 * operação.
 */
export function assessTradeRisk(input: RiskInput): RiskAssessment {
  const minRr = typeof input.minRr === "number" && input.minRr > 0 ? input.minRr : MIN_RR;
  const problems: string[] = [];
  const { entry, stop, target } = input;

  if (entry === null || stop === null || target === null || input.side === "NEUTRO") {
    if (input.side === "NEUTRO") problems.push("sem lado definido — risco não avaliável");
    if (entry === null) problems.push("entrada não identificada — risco não avaliável");
    if (stop === null) problems.push("stop não identificado — risco não avaliável");
    if (target === null) problems.push("alvo não identificado — risco não avaliável");
    return {
      verdict: "RISK_UNKNOWN",
      rr: null,
      riskPoints: entry !== null && stop !== null ? Math.abs(entry - stop) : null,
      rewardPoints: entry !== null && target !== null ? Math.abs(target - entry) : null,
      coherent: false,
      problems,
      blockCode: "PRICE_UNRELIABLE",
    };
  }

  const compra = input.side === "COMPRA";
  const coherent = compra ? stop < entry && target > entry : stop > entry && target < entry;
  if (!coherent) {
    problems.push(
      `níveis incoerentes com ${input.side} (stop ${stop} / entrada ${entry} / alvo ${target})`,
    );
  }

  const riskPoints = Math.abs(entry - stop);
  const rewardPoints = Math.abs(target - entry);
  if (riskPoints <= 0) {
    problems.push("risco zero — R:R incalculável");
    return {
      verdict: "RISK_REJECTED",
      rr: null,
      riskPoints,
      rewardPoints,
      coherent,
      problems,
      blockCode: "STOP_TOO_SMALL",
    };
  }

  const rr = rewardPoints / riskPoints;
  if (rr < minRr) {
    problems.push(`R:R ${rr.toFixed(2)} abaixo do mínimo ${minRr.toFixed(1).replace(".", ",")}`);
  }

  // 2,99 REPROVA e 3,00 passa: o corte é `rr < minRr`, sem tolerância escondida.
  const blockCode: BlockCode | null =
    problems.length === 0 ? null : rr < minRr ? "RR_LT_3" : "PRICE_UNRELIABLE";
  return {
    verdict: problems.length === 0 ? "RISK_APPROVED" : "RISK_REJECTED",
    rr,
    riskPoints,
    rewardPoints,
    coherent,
    problems,
    blockCode,
  };
}

/** Só `RISK_APPROVED` autoriza. UNKNOWN é bloqueio, nunca benefício da dúvida. */
export function riscoAprovado(assessment: RiskAssessment): boolean {
  return assessment.verdict === "RISK_APPROVED";
}
