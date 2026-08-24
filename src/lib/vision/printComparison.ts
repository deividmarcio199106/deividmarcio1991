/**
 * O QUE MUDOU ENTRE DOIS PRINTS — comparação determinística.
 *
 * A decisão de arquitetura que governa este arquivo: a comparação NÃO usa o
 * modelo. As duas análises já são dados estruturados e validados; compará-las é
 * código puro. Pedir a um modelo que "compare" seria abrir uma segunda porta
 * para alucinação — ele inventaria mudanças plausíveis exatamente como inventa
 * preços plausíveis — e tornaria o resultado não testável.
 *
 * A REGRA DO NÃO CONFIRMÁVEL: só afirmamos mudança sobre elementos presentes
 * NAS DUAS análises. Um suporte marcado no print anterior que não aparece no
 * novo NÃO prova rompimento — o modelo pode simplesmente não tê-lo marcado. A
 * diferença entre "a resistência foi rompida" e "a resistência sumiu da
 * análise" é a diferença entre informação e ruído, e o operador recebe a
 * distinção por escrito.
 */

import type { Annotation, PrintAnalysis, PrintStatus } from "./printAnalysis";
import { PRINT_STATUS_LABEL } from "./printAnalysis";

export type ChangeKind =
  | "AVANCO"
  | "RETROCESSO"
  | "INVALIDACAO"
  | "DIRECAO"
  | "CRITERIO_GANHO"
  | "CRITERIO_PERDIDO"
  | "ESTRUTURA"
  | "NAO_CONFIRMAVEL"
  | "SEM_MUDANCA";

export interface PrintChange {
  kind: ChangeKind;
  text: string;
  /** true somente quando os DOIS prints sustentam a afirmação. */
  confirmable: boolean;
}

export interface ComparisonResult {
  changes: PrintChange[];
  /** A mudança mais importante, para o topo do card. */
  headline: string;
  /** true quando nada relevante mudou — e um novo print era desnecessário. */
  unchanged: boolean;
}

/**
 * Escada de progresso da técnica. INVALIDADA e INCONCLUSIVO ficam fora: não
 * são degraus, são saídas — e compará-los como número produziria "avanços"
 * sem sentido.
 */
const LADDER: Partial<Record<PrintStatus, number>> = {
  SEM_T4: 0,
  T4_EM_FORMACAO: 1,
  APROXIMACAO_T4: 2,
  PRE_ENTRADA: 3,
  ENTRADA_CONFIRMADA: 4,
};

const MUDANCA_NAO_CONFIRMAVEL = "MUDANÇA NÃO CONFIRMÁVEL PELAS IMAGENS";

function kindsOf(annotations: Annotation[]): Set<string> {
  return new Set(annotations.map((a) => a.kind));
}

export function comparePrintAnalyses(prev: PrintAnalysis, next: PrintAnalysis): ComparisonResult {
  /*
   * INCONCLUSIVO CONTAMINA A COMPARAÇÃO INTEIRA.
   *
   * Se uma das leituras não conseguiu afirmar nada sobre o próprio print, não
   * existe base para afirmar o que mudou ENTRE prints. Melhor uma resposta
   * curta e honesta que uma lista de diferenças construída sobre o nada.
   */
  if (prev.status === "INCONCLUSIVO" || next.status === "INCONCLUSIVO") {
    const qual = prev.status === "INCONCLUSIVO" ? "anterior" : "novo";
    return {
      changes: [
        {
          kind: "NAO_CONFIRMAVEL",
          text: `${MUDANCA_NAO_CONFIRMAVEL} — a análise do print ${qual} foi inconclusiva.`,
          confirmable: false,
        },
      ],
      headline: MUDANCA_NAO_CONFIRMAVEL,
      unchanged: false,
    };
  }

  const changes: PrintChange[] = [];

  // 1. Progresso da técnica — o eixo principal da linha do tempo.
  if (next.status === "T4_INVALIDADA" && prev.status !== "T4_INVALIDADA") {
    changes.push({
      kind: "INVALIDACAO",
      text: `T4 invalidou: era ${PRINT_STATUS_LABEL[prev.status]}, a estrutura perdeu validade.`,
      confirmable: true,
    });
  } else {
    const antes = LADDER[prev.status];
    const depois = LADDER[next.status];
    if (antes !== undefined && depois !== undefined && antes !== depois) {
      changes.push({
        kind: depois > antes ? "AVANCO" : "RETROCESSO",
        text:
          depois > antes
            ? `T4 avançou: ${PRINT_STATUS_LABEL[prev.status]} → ${PRINT_STATUS_LABEL[next.status]}.`
            : `T4 perdeu força: ${PRINT_STATUS_LABEL[prev.status]} → ${PRINT_STATUS_LABEL[next.status]}.`,
        confirmable: true,
      });
    }
  }

  // 2. Direção do viés.
  if (prev.direction !== next.direction) {
    changes.push({
      kind: "DIRECAO",
      text: `Viés mudou de ${prev.direction} para ${next.direction}.`,
      confirmable: true,
    });
  }

  /*
   * 3. Critérios — SÓ os avaliados nos dois prints.
   *
   * Um critério que aparece apenas numa das análises não é transição: é o
   * modelo tendo avaliado listas diferentes. Afirmar "candle confirmou" porque
   * o critério surgiu na segunda lista seria inventar um evento.
   */
  const prevPorId = new Map(prev.criteria.map((c) => [c.id, c]));
  for (const criterio of next.criteria) {
    const anterior = prevPorId.get(criterio.id);
    if (!anterior) continue;
    if (!anterior.met && criterio.met) {
      changes.push({
        kind: "CRITERIO_GANHO",
        text: `Critério atendido agora: ${criterio.label}.`,
        confirmable: true,
      });
    } else if (anterior.met && !criterio.met) {
      changes.push({
        kind: "CRITERIO_PERDIDO",
        text: `Critério perdido: ${criterio.label}.`,
        confirmable: true,
      });
    }
  }

  // 4. Estrutura visível — presença nas DUAS análises sustenta afirmação.
  const kindsAntes = kindsOf(prev.annotations);
  const kindsDepois = kindsOf(next.annotations);

  if (!kindsAntes.has("BREAKOUT") && kindsDepois.has("BREAKOUT")) {
    changes.push({
      kind: "ESTRUTURA",
      text: "Rompimento identificado no novo print.",
      confirmable: true,
    });
  }
  if (kindsAntes.has("SUPPORT") && kindsDepois.has("SUPPORT")) {
    changes.push({
      kind: "ESTRUTURA",
      text: "Suporte segue marcado nos dois prints.",
      confirmable: true,
    });
  }
  // Sumiu da análise ≠ foi rompido. A distinção é o ponto deste módulo.
  for (const [kind, nome] of [
    ["SUPPORT", "suporte"],
    ["RESISTANCE", "resistência"],
  ] as const) {
    if (kindsAntes.has(kind) && !kindsDepois.has(kind)) {
      changes.push({
        kind: "NAO_CONFIRMAVEL",
        text: `O ${nome} do print anterior não aparece na nova análise — perda ou rompimento ${MUDANCA_NAO_CONFIRMAVEL.toLowerCase()}.`,
        confirmable: false,
      });
    }
  }

  /*
   * NADA MUDOU É UMA RESPOSTA — e é a que evita print desnecessário.
   *
   * Quando as duas análises são equivalentes, o sistema diz isso com todas as
   * letras, em vez de fabricar diferenças para justificar a existência do card.
   */
  const relevantes = changes.filter((c) => c.confirmable);
  if (relevantes.length === 0 && changes.length === 0) {
    return {
      changes: [
        {
          kind: "SEM_MUDANCA",
          text: "Gráfico praticamente igual ao anterior — NÃO PRECISA ENVIAR OUTRO PRINT AGORA.",
          confirmable: true,
        },
      ],
      headline: "SEM MUDANÇA RELEVANTE",
      unchanged: true,
    };
  }

  const prioridade: ChangeKind[] = [
    "INVALIDACAO",
    "AVANCO",
    "RETROCESSO",
    "DIRECAO",
    "CRITERIO_GANHO",
    "CRITERIO_PERDIDO",
    "ESTRUTURA",
    "NAO_CONFIRMAVEL",
  ];
  const principal =
    prioridade.map((k) => changes.find((c) => c.kind === k)).find(Boolean) ?? changes[0]!;

  return { changes, headline: principal.text, unchanged: false };
}
