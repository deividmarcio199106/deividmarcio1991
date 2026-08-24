/**
 * ANTECEDÊNCIA — quanto tempo antes do gatilho a T4 começou a avisar.
 *
 * Esta é a métrica que decide se o trabalho todo valeu. Não interessa que a T4
 * acerte a direção se ela só anuncia depois que o movimento aconteceu: aviso
 * atrasado não dá tempo de posicionar ordem nenhuma, e vira uma narração do
 * passado.
 *
 *   candidateLeadTime  = confirmação − primeiro candidato
 *   preEntryLeadTime   = confirmação − pré-entrada armada
 *
 * O segundo é o que importa: é o tempo real que o operador teve entre ver
 * "PREPARE A ORDEM" e o gatilho disparar.
 *
 * ANTI-LOOKAHEAD POR CONSTRUÇÃO
 * Os instantes são gravados QUANDO o estado acontece, nunca reconstruídos
 * depois. Um registro que fosse montado ao final da operação poderia
 * "descobrir" que o candidato existia mais cedo — usando informação que só
 * apareceu depois. Aqui cada marca é escrita uma vez e nunca reescrita: a
 * primeira gravação vence, e uma tentativa de regravar é ignorada.
 */

import type { T4Stage } from "./preEntry";

export interface SetupTimeline {
  setupId: string;
  direction: "COMPRA" | "VENDA" | null;
  /** Instante de MERCADO em que cada marco foi observado pela primeira vez. */
  contextAt: number | null;
  candidateAt: number | null;
  preEntryAt: number | null;
  confirmedAt: number | null;
  invalidatedAt: number | null;
  /** Zona prevista NO MOMENTO em que armou — não a de agora. */
  zoneAtArm: { min: number; max: number } | null;
  stopAtArm: number | null;
  triggerPendingAtArm: string | null;
  /** Motivo real do bloqueio quando o setup morreu sem confirmar. */
  blockReason: string | null;
}

export function newTimeline(setupId: string, direction: "COMPRA" | "VENDA" | null): SetupTimeline {
  return {
    setupId,
    direction,
    contextAt: null,
    candidateAt: null,
    preEntryAt: null,
    confirmedAt: null,
    invalidatedAt: null,
    zoneAtArm: null,
    stopAtArm: null,
    triggerPendingAtArm: null,
    blockReason: null,
  };
}

export interface StageObservation {
  stage: T4Stage;
  marketTime: number;
  zone: { min: number; max: number } | null;
  stop: number | null;
  pendingTrigger: string | null;
  blockReason: string | null;
}

/**
 * Grava um marco. A PRIMEIRA gravação vence — regravar seria reescrever a
 * história com informação que ainda não existia naquele instante.
 */
export function markStage(timeline: SetupTimeline, observation: StageObservation): SetupTimeline {
  const { stage, marketTime } = observation;
  const next = { ...timeline };

  if (stage === "OBSERVANDO" && next.contextAt === null) {
    next.contextAt = marketTime;
  }

  if (
    stage === "PREPARANDO_COMPRA" ||
    stage === "PREPARANDO_VENDA" ||
    stage === "GATILHO_PROXIMO"
  ) {
    if (next.candidateAt === null) next.candidateAt = marketTime;
    if (next.preEntryAt === null) {
      next.preEntryAt = marketTime;
      // Congela o plano do instante do armamento. O que a T4 previu ANTES é o
      // que vale para julgar a antecedência; o plano de agora já sabe demais.
      next.zoneAtArm = observation.zone;
      next.stopAtArm = observation.stop;
      next.triggerPendingAtArm = observation.pendingTrigger;
    }
  }

  if (stage === "ENTRADA_CONFIRMADA" && next.confirmedAt === null) {
    next.confirmedAt = marketTime;
  }

  if (stage === "INVALIDADA" && next.invalidatedAt === null) {
    next.invalidatedAt = marketTime;
    next.blockReason = observation.blockReason;
  }

  return next;
}

export interface LeadTimes {
  candidateLeadTimeMs: number | null;
  preEntryLeadTimeMs: number | null;
  /** true quando a pré-entrada apareceu ANTES do gatilho — o critério. */
  warnedBeforeTrigger: boolean;
}

/**
 * Calcula a antecedência.
 *
 * Sem confirmação não há antecedência a medir — devolve nulo em vez de zero.
 * Zero significaria "avisou no instante exato do gatilho", que é uma afirmação
 * diferente de "ainda não houve gatilho".
 */
export function leadTimes(timeline: SetupTimeline): LeadTimes {
  const { confirmedAt, candidateAt, preEntryAt } = timeline;
  if (confirmedAt === null) {
    return { candidateLeadTimeMs: null, preEntryLeadTimeMs: null, warnedBeforeTrigger: false };
  }
  const candidateLead = candidateAt === null ? null : confirmedAt - candidateAt;
  const preEntryLead = preEntryAt === null ? null : confirmedAt - preEntryAt;
  return {
    candidateLeadTimeMs: candidateLead,
    preEntryLeadTimeMs: preEntryLead,
    // Estritamente maior que zero: avisar no mesmo instante não é antecedência.
    warnedBeforeTrigger: preEntryLead !== null && preEntryLead > 0,
  };
}

export function formatLead(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 0) return "ATRASADO";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s antes`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}min ${seconds % 60}s antes`;
}

/**
 * Registro de um candidato que NÃO virou entrada.
 *
 * O pedido explícito: descobrir por que a T4 não está capturando operações.
 * Sem isto, um setup rejeitado desaparece sem deixar rastro e não há como
 * distinguir "a técnica reprovou com razão" de "a visão não enxergou".
 */
export interface RejectedCandidate {
  setupId: string;
  direction: "COMPRA" | "VENDA" | null;
  candidateAt: number | null;
  preEntryAt: number | null;
  diedAt: number;
  gates: { id: string; status: string; detail: string }[];
  blockReason: string;
  /** true quando chegou a armar antes de morrer — perto de virar operação. */
  wasArmed: boolean;
}

export function describeRejection(candidate: RejectedCandidate): string {
  const quando = candidate.preEntryAt !== null ? "após armar" : "antes de armar";
  const falhou = candidate.gates.filter((g) => g.status === "FAIL").map((g) => g.id);
  const pendentes = candidate.gates.filter((g) => g.status === "PENDING").map((g) => g.id);
  const detalhe =
    falhou.length > 0
      ? `reprovou em ${falhou.join(", ")}`
      : pendentes.length > 0
        ? `nunca completou ${pendentes.join(", ")}`
        : "sem gate reprovado registrado";
  return `${candidate.direction ?? "direção indefinida"} · morreu ${quando} · ${detalhe} · ${candidate.blockReason}`;
}
