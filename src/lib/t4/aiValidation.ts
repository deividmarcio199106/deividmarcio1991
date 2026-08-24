/**
 * O COMBINADOR — onde fica PROVADO que a IA nunca libera trade sozinha.
 *
 * A hierarquia é assimétrica de propósito:
 *   - a IA pode DERRUBAR uma confirmação (Luna REJECT, Terra REJECT, dúvida);
 *   - a IA NÃO pode CRIAR uma: sem T4_DETERMINISTICO_PASS não existe caminho
 *     de código que chegue em CONFIRMADO, com quantas aprovações a IA der.
 *
 * Este módulo é PURO — sem fetch, sem relógio, sem estado. É a mesma função
 * no live, no replay e no teste, e é isso que torna a paridade verificável.
 *
 * "Qualquer dúvida => NO_TRADE/AGUARDAR": INCONCLUSIVE, validação indisponível,
 * JSON fora do schema, número inventado — tudo cai no mesmo lado, o de não
 * operar. O sistema perde trade por excesso de cautela; não perde dinheiro por
 * excesso de confiança.
 */

import type { BlockCode } from "./blockCodes";
import type { LunaPrintRead, TerraChallenge } from "./aiSchemas";

/** Tolerância entre o nível lido pela IA e o nível determinístico (pontos). */
export const AI_LEVEL_TOLERANCE_POINTS = 60;

export interface LunaSanityInput {
  luna: LunaPrintRead;
  /** Níveis do MOTOR determinístico — a referência contra a qual a IA é checada. */
  deterministic: { entry: number | null; stop: number | null };
}

export interface LunaSanityRead {
  usable: boolean;
  hallucinated: boolean;
  problems: string[];
}

/**
 * A guarda anti-invenção. Um modelo que declara `entryVisible:false` e mesmo
 * assim manda um número está inventando preço — e leitura inventada não
 * derruba nem sustenta nada: é DESCARTADA, com o motivo gravado.
 */
export function lunaSanity(input: LunaSanityInput): LunaSanityRead {
  const { luna, deterministic } = input;
  const problems: string[] = [];
  let hallucinated = false;

  const pares: Array<[string, boolean, number | null]> = [
    ["entry", luna.entryVisible, luna.entry],
    ["stop", luna.stopVisible, luna.stop],
    ["target3R", luna.targetVisible, luna.target3R],
    ["target5R", luna.targetVisible, luna.target5R],
  ];
  for (const [campo, visivel, valor] of pares) {
    if (!visivel && valor !== null) {
      hallucinated = true;
      problems.push(`${campo}=${valor} com ${campo}Visible=false — número inventado.`);
    }
  }

  // Divergência contra o motor: a IA leu OUTRO gráfico? Acima da tolerância a
  // leitura não é confiável — nem para aprovar, nem para reprovar.
  if (luna.entry !== null && deterministic.entry !== null) {
    const desvio = Math.abs(luna.entry - deterministic.entry);
    if (desvio > AI_LEVEL_TOLERANCE_POINTS) {
      problems.push(
        `entrada da IA (${luna.entry}) diverge ${Math.round(desvio)} pts do motor (${deterministic.entry}).`,
      );
    }
  }
  if (luna.stop !== null && deterministic.stop !== null) {
    const desvio = Math.abs(luna.stop - deterministic.stop);
    if (desvio > AI_LEVEL_TOLERANCE_POINTS) {
      problems.push(
        `stop da IA (${luna.stop}) diverge ${Math.round(desvio)} pts do motor (${deterministic.stop}).`,
      );
    }
  }

  return { usable: problems.length === 0, hallucinated, problems };
}

export type AiAvailability<T> =
  | { status: "OK"; value: T }
  | { status: "INDISPONIVEL"; reason: string }
  | { status: "NAO_CHAMADO" };

export interface FinalConfirmationInput {
  /** TODOS os gates determinísticos passaram (RR>=3, stop, horário, E2…). */
  t4DeterministicPass: boolean;
  /** E2 fechada, provada pelo código — nunca pela IA. */
  e2Closed: boolean;
  rrOk: boolean;
  levelsValid: boolean;
  luna: AiAvailability<{ read: LunaPrintRead; sanity: LunaSanityRead }>;
  terra: AiAvailability<TerraChallenge>;
}

export interface FinalConfirmation {
  confirmado: boolean;
  blockCode: BlockCode | null;
  motivo: string;
}

const nega = (code: BlockCode, motivo: string): FinalConfirmation => ({
  confirmado: false,
  blockCode: code,
  motivo,
});

/**
 * CONFIRMADO exige TUDO:
 * T4 determinística PASS ∧ E2 fechada ∧ RR≥3 ∧ níveis válidos ∧ Luna utilizável
 * e não-REJECT ∧ Terra APPROVE. Um único lado em dúvida nega — e diz por quê.
 */
export function finalConfirmation(input: FinalConfirmationInput): FinalConfirmation {
  // A ORDEM IMPORTA: o determinístico vem primeiro. Se ele não passou, nem
  // olhamos a IA — não existe "a IA achou ótimo" registrado sobre um setup
  // que o código já negou, porque isso viraria pressão para afrouxar.
  if (!input.t4DeterministicPass) {
    return nega("AUDITOR", "T4 determinística não passou — IA não é consultada para criar trade.");
  }
  if (!input.e2Closed) {
    return nega("E2_OPEN_OR_UNKNOWN", "Candle de confirmação não comprovadamente fechado.");
  }
  if (!input.rrOk) return nega("RR_LT_3", "R:R abaixo do mínimo da casa.");
  if (!input.levelsValid) {
    return nega("PRICE_UNRELIABLE", "Entrada/stop/alvos sem leitura numérica válida.");
  }

  // Luna: precisa existir, ser sã e não rejeitar.
  if (input.luna.status === "NAO_CHAMADO" || input.luna.status === "INDISPONIVEL") {
    return nega(
      "AUDITOR",
      input.luna.status === "NAO_CHAMADO"
        ? "Validação Luna não executada — confirmação que depende de IA não sai sem ela."
        : `Validação Luna indisponível: ${input.luna.reason}. Sem confirmar no escuro.`,
    );
  }
  const { read, sanity } = input.luna.value;
  if (!sanity.usable) {
    return nega("AUDITOR", `Leitura Luna descartada: ${sanity.problems[0] ?? "insana"}`);
  }
  if (read.verdict === "REJECT") {
    return nega("AUDITOR", `Luna REJECT: ${read.contradictions[0] ?? "contradição declarada"}`);
  }
  if (read.verdict === "INCONCLUSIVE") {
    return nega("AUDITOR", "Luna INCONCLUSIVE — dúvida não confirma.");
  }
  if (!read.confirmationCandleClosed) {
    return nega("E2_OPEN_OR_UNKNOWN", "Luna vê o candle de confirmação ainda aberto.");
  }

  // Terra: o desafio adversarial precisa ter rodado E aprovado.
  if (input.terra.status !== "OK") {
    return nega(
      "AUDITOR",
      input.terra.status === "NAO_CHAMADO"
        ? "Segunda validação (Terra) não executada — CONFIRMADO exige o desafio adversarial."
        : `Terra indisponível: ${input.terra.reason}. Sem confirmar no escuro.`,
    );
  }
  if (input.terra.value.verdict !== "APPROVE" || !input.terra.value.approved) {
    return nega(
      "AUDITOR",
      `Terra ${input.terra.value.verdict}: ${
        input.terra.value.criticalIssue ?? input.terra.value.contradictions[0] ?? "não aprovou"
      }`,
    );
  }

  return { confirmado: true, blockCode: null, motivo: "T4 PASS + Luna PASS + Terra APPROVE." };
}

/** Rótulos da UI — as quatro linhas que a tela mostra, sempre. */
export function aiStatusRows(input: {
  luna: AiAvailability<{ read: LunaPrintRead; sanity: LunaSanityRead }>;
  terra: AiAvailability<TerraChallenge>;
  t4DeterministicPass: boolean;
  final: FinalConfirmation;
}): { luna: string; terra: string; t4: string; veredito: string } {
  const luna =
    input.luna.status === "NAO_CHAMADO"
      ? "NÃO CHAMADO"
      : input.luna.status === "INDISPONIVEL"
        ? "INDISPONÍVEL"
        : !input.luna.value.sanity.usable
          ? "DESCARTADA (leitura insana)"
          : input.luna.value.read.verdict === "PASS"
            ? "OK"
            : input.luna.value.read.verdict;
  const terra =
    input.terra.status === "NAO_CHAMADO"
      ? "NÃO CHAMADO"
      : input.terra.status === "INDISPONIVEL"
        ? "INDISPONÍVEL"
        : input.terra.value.verdict === "APPROVE"
          ? "OK"
          : input.terra.value.verdict;
  return {
    luna: `OPENAI LUNA: ${luna}`,
    terra: `OPENAI TERRA: ${terra}`,
    t4: `T4 DETERMINÍSTICA: ${input.t4DeterministicPass ? "PASS" : "BLOCKED"}`,
    veredito: `VEREDITO: ${input.final.confirmado ? "CONFIRMADO" : `AGUARDAR — ${input.final.motivo}`}`,
  };
}
