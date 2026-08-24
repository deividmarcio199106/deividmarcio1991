/**
 * ESTÁGIO OPERACIONAL DA T4 — o que mostrar ANTES da entrada existir.
 *
 * O problema que este arquivo resolve: a T4 só dizia alguma coisa depois de
 * validar tudo. Quando o painel finalmente escrevia "entrada", o gatilho já
 * tinha acontecido e não havia tempo de posicionar a ordem à mão.
 *
 * A saída NÃO é afrouxar gate nenhum. É separar duas perguntas que estavam
 * coladas:
 *
 *   1. "O setup está maduro?"        → estágio, mostrado desde cedo
 *   2. "O gatilho aconteceu?"        → confirmação, inalterada
 *
 * Um setup pode estar 90% maduro e nunca disparar. Mostrar esses 90% é
 * informação; chamar isso de entrada seria mentira. Por isso `confirmed` só é
 * verdadeiro no estágio ENTRADA_CONFIRMADA, e todo nível exibido antes disso
 * vem marcado como provisório.
 *
 * NADA AQUI DECIDE. Este módulo lê o resultado dos gates determinísticos e
 * traduz para linguagem operacional. Se um gate reprova, o estágio cai — não
 * existe caminho que produza pré-entrada sem os gates correspondentes.
 */

import type { GateResult } from "@/lib/t4/gates";
import type { DecisionObject } from "@/lib/engines/backtestDecisionEngine";
import type { AnalysisResult, Direction } from "@/lib/engines/types";

export type T4Stage =
  | "AGUARDANDO"
  | "OBSERVANDO"
  | "PREPARANDO_COMPRA"
  | "PREPARANDO_VENDA"
  | "GATILHO_PROXIMO"
  | "ENTRADA_CONFIRMADA"
  | "INVALIDADA"
  | "ENCERRADA";

export const STAGE_LABEL: Record<T4Stage, string> = {
  AGUARDANDO: "AGUARDANDO DADO",
  OBSERVANDO: "OBSERVANDO",
  PREPARANDO_COMPRA: "PREPARANDO COMPRA",
  PREPARANDO_VENDA: "PREPARANDO VENDA",
  GATILHO_PROXIMO: "GATILHO PRÓXIMO",
  ENTRADA_CONFIRMADA: "ENTRADA CONFIRMADA",
  INVALIDADA: "INVALIDADA",
  ENCERRADA: "ENCERRADA",
};

/**
 * Gates que compõem a maturidade do setup, na ordem em que precisam cair.
 * Os dois últimos são o GATILHO: é o que separa preparar de entrar.
 */
const CONTEXT_GATES = ["CONTEXT", "STRUCTURE", "LOCATION"];
const SETUP_GATES = ["LIQUIDITY", "REACTION", "STRUCTURE_SHIFT", "POI_RETEST"];
const RISK_GATES = ["STOP_VALID", "RISK_REWARD"];
const TRIGGER_GATES = ["CONFIRMATION_CANDLE", "T4_SIGNAL"];

export interface T4Operation {
  stage: T4Stage;
  direction: Direction | null;
  /** true SOMENTE com o gatilho cumprido. Nunca deduza isso do estágio. */
  confirmed: boolean;
  /** true enquanto os níveis ainda podem mudar (tudo antes da confirmação). */
  provisional: boolean;
  entry: number | null;
  /** Faixa onde a entrada é aceitável, não um preço único. */
  entryZone: { min: number; max: number } | null;
  stop: number | null;
  partial: number | null;
  target: number | null;
  riskPoints: number | null;
  rewardPoints: number | null;
  riskReward: number | null;
  contracts: number | null;
  invalidation: string | null;
  /** O que já passou — por que a T4 está achando que vale a pena. */
  reasons: string[];
  /** O que ainda falta, na ordem. Primeiro item é o próximo passo. */
  missing: string[];
  /** Motivo único e específico quando nada anda. */
  blockReason: string | null;
  /**
   * 0–100 de MATURIDADE do setup. Não é probabilidade de acerto, e a UI
   * precisa dizer isso: 90% não significa 90% de chance de ganhar.
   */
  maturity: number;
  /** Identidade estável do setup, para não alertar duas vezes pelo mesmo. */
  setupId: string | null;
  /** Instante em que o setup ficou armado. */
  armedAt: number | null;
}

export const IDLE_OPERATION: T4Operation = {
  stage: "AGUARDANDO",
  direction: null,
  confirmed: false,
  provisional: true,
  entry: null,
  entryZone: null,
  stop: null,
  partial: null,
  target: null,
  riskPoints: null,
  rewardPoints: null,
  riskReward: null,
  contracts: null,
  invalidation: null,
  reasons: [],
  missing: [],
  blockReason: null,
  maturity: 0,
  setupId: null,
  armedAt: null,
};

function statusOf(gates: GateResult[], id: string): GateResult | undefined {
  return gates.find((gate) => gate.id === id);
}

function passed(gates: GateResult[], ids: string[]): boolean {
  return ids.every((id) => {
    const gate = statusOf(gates, id);
    return gate !== undefined && gate.status === "PASS";
  });
}

function firstFailing(gates: GateResult[]): GateResult | null {
  return gates.find((gate) => gate.status === "FAIL") ?? null;
}

/**
 * Faixa de entrada em vez de um preço só.
 *
 * O preço exato de um pullback não é conhecível antes de acontecer. Publicar
 * um número único convidaria a colocar ordem em ponto que talvez nunca seja
 * tocado. A faixa é derivada do risco do próprio setup: um quinto da distância
 * até o stop, que é a tolerância que a técnica já aceita.
 */
export function entryZoneFor(
  entry: number | null,
  stop: number | null,
): { min: number; max: number } | null {
  if (entry === null || stop === null) return null;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return null;
  const tolerance = risk / 5;
  return { min: entry - tolerance, max: entry + tolerance };
}

function directionFrom(
  decision: DecisionObject | null,
  analysis: AnalysisResult | null,
): Direction | null {
  if (decision) {
    if (decision.decision === "ENTER_LONG") return "COMPRA";
    if (decision.decision === "ENTER_SHORT") return "VENDA";
  }
  // Sem decisão fechada, a direção candidata vem do plano da leitura — que é
  // onde a técnica já registra para que lado o setup aponta.
  const candidate = analysis?.plan?.direction ?? analysis?.direction ?? null;
  if (candidate === "COMPRA" || candidate === "VENDA") return candidate;
  return null;
}

/**
 * O que mata o setup, em uma frase.
 *
 * Não existe campo "invalidação" na leitura: ela É o stop estrutural. Descrever
 * assim evita inventar um conceito paralelo que poderia divergir do nível que a
 * ordem realmente usa.
 */
function invalidationFor(direction: Direction | null, stop: number | null): string | null {
  if (direction === null || stop === null) return null;
  return direction === "COMPRA"
    ? `perda de ${stop.toFixed(0)} — abaixo disso o setup deixa de valer`
    : `rompimento de ${stop.toFixed(0)} — acima disso o setup deixa de valer`;
}

/**
 * Identidade do setup: direção + níveis. Mudou o plano, é outro setup — e o
 * alerta sonoro pode tocar de novo sem virar repetição do mesmo aviso.
 */
function setupIdFor(
  direction: Direction | null,
  entry: number | null,
  stop: number | null,
): string | null {
  if (direction === null || entry === null || stop === null) return null;
  return `${direction}:${entry.toFixed(1)}:${stop.toFixed(1)}`;
}

export interface OperationInput {
  dataReady: boolean;
  dataGates: GateResult[];
  t4Gates: GateResult[];
  analysis: AnalysisResult | null;
  decision: DecisionObject | null;
  entryState: string;
  /** Estado anterior, para detectar invalidação de um setup que estava armado. */
  previous: T4Operation | null;
  now: number;
}

/**
 * Traduz gates em estágio operacional.
 *
 * A ordem dos testes importa: confirmação vem antes de tudo, porque um setup
 * confirmado não pode ser rebaixado por um gate que oscilou depois.
 */
export function evaluateOperation(input: OperationInput): T4Operation {
  const { dataGates, t4Gates, analysis, decision, previous, now } = input;

  const direction = directionFrom(decision, analysis);
  const entry = decision?.entryPrice ?? null;
  const stop = decision?.stopPrice ?? null;
  const setupId = setupIdFor(direction, entry, stop);

  const base: T4Operation = {
    ...IDLE_OPERATION,
    direction,
    entry,
    entryZone: entryZoneFor(entry, stop),
    stop,
    partial: decision?.partialPrice ?? null,
    target: decision?.targetPrice ?? null,
    riskPoints: decision?.riskPoints ?? null,
    rewardPoints: decision?.rewardPoints ?? null,
    riskReward: decision?.riskRewardRatio ?? null,
    contracts: decision?.recommendedContracts ?? null,
    invalidation: invalidationFor(direction, stop),
    reasons: t4Gates.filter((g) => g.status === "PASS").map((g) => `${g.id}: ${g.detail}`),
    missing: t4Gates.filter((g) => g.status !== "PASS").map((g) => `${g.id}: ${g.detail}`),
    setupId,
  };

  // 1. Sem dado válido nada pode ser afirmado — nem para cima, nem para baixo.
  if (!input.dataReady) {
    const failing = firstFailing(dataGates);
    return {
      ...base,
      stage: "AGUARDANDO",
      maturity: 0,
      blockReason: failing ? `${failing.id}: ${failing.detail}` : "aguardando os gates de dado",
      // Sem dado, nível antigo não vale nada.
      entry: null,
      entryZone: null,
      stop: null,
      partial: null,
      target: null,
      riskReward: null,
    };
  }

  const contextOk = passed(t4Gates, CONTEXT_GATES);
  const setupOk = passed(t4Gates, SETUP_GATES);
  const riskOk = passed(t4Gates, RISK_GATES);
  const triggerOk = passed(t4Gates, TRIGGER_GATES);
  const confirmationOk = statusOf(t4Gates, "CONFIRMATION_CANDLE")?.status === "PASS";

  // 2. Gatilho cumprido: é entrada, e só aqui.
  if (triggerOk && direction !== null && entry !== null && stop !== null) {
    return {
      ...base,
      stage: "ENTRADA_CONFIRMADA",
      confirmed: true,
      provisional: false,
      maturity: 100,
      armedAt: previous?.armedAt ?? now,
    };
  }

  if (input.entryState === "CLOSED" || input.entryState === "ENCERRADA") {
    return { ...base, stage: "ENCERRADA", provisional: false, maturity: 0 };
  }

  // 3. Contexto + setup + risco válidos e faltando só o gatilho: ARMADO.
  //    É o ponto do fluxo em que o operador ainda tem tempo de agir.
  if (contextOk && setupOk && riskOk && direction !== null) {
    const armed = previous?.setupId === setupId ? previous.armedAt : now;
    if (confirmationOk) {
      return {
        ...base,
        stage: "GATILHO_PROXIMO",
        maturity: 96,
        armedAt: armed ?? now,
        blockReason: statusOf(t4Gates, "T4_SIGNAL")?.detail ?? null,
      };
    }
    return {
      ...base,
      stage: direction === "COMPRA" ? "PREPARANDO_COMPRA" : "PREPARANDO_VENDA",
      maturity: 90,
      armedAt: armed ?? now,
      blockReason: statusOf(t4Gates, "CONFIRMATION_CANDLE")?.detail ?? null,
    };
  }

  // 4. Estava armado e um gate caiu: invalidação explícita, não silêncio.
  const wasArmed =
    previous !== null &&
    (previous.stage === "PREPARANDO_COMPRA" ||
      previous.stage === "PREPARANDO_VENDA" ||
      previous.stage === "GATILHO_PROXIMO");
  if (wasArmed) {
    const failing = firstFailing(t4Gates);
    return {
      ...base,
      stage: "INVALIDADA",
      direction: previous.direction,
      maturity: 0,
      blockReason: failing
        ? `${failing.id}: ${failing.detail}`
        : "o setup perdeu validade antes do gatilho",
      // Um plano morto nao pode continuar na tela como se valesse.
      entry: null,
      entryZone: null,
      stop: null,
      partial: null,
      target: null,
      riskReward: null,
      setupId: null,
      armedAt: null,
    };
  }

  // 5. Maturidade proporcional ao que já caiu.
  let maturity = 10;
  if (contextOk) maturity = 45;
  if (contextOk && setupOk) maturity = 78;
  if (contextOk && setupOk && riskOk) maturity = 88;

  const nextGate = t4Gates.find((g) => g.status !== "PASS");
  return {
    ...base,
    stage: "OBSERVANDO",
    maturity,
    blockReason: nextGate ? `${nextGate.id}: ${nextGate.detail}` : null,
  };
}

/** true quando o setup acabou de armar — usado para alertar uma vez só. */
/**
 * ENTROU EM CONFIRMAÇÃO AGORA? — a transição que vira sinal operável.
 *
 * `justArmed` cobre a APROXIMAÇÃO (preparando/gatilho próximo) e, por isso,
 * nunca é verdadeiro em ENTRADA_CONFIRMADA. Quem quiser reagir à confirmação
 * — congelar o print, tocar o som de entrada, armar o acompanhamento — precisa
 * desta, que compara o estágio anterior com o atual. Um setup confirmado que
 * segue confirmado no frame seguinte NÃO dispara de novo: o gatilho é a
 * BORDA, não o estado.
 */
export function justConfirmed(previous: T4Operation | null, current: T4Operation): boolean {
  if (current.stage !== "ENTRADA_CONFIRMADA") return false;
  if (previous === null) return true;
  if (previous.stage !== "ENTRADA_CONFIRMADA") return true;
  // Mesmo estágio, setup diferente = outra oportunidade, outro sinal.
  return previous.setupId !== current.setupId;
}

export function justArmed(previous: T4Operation | null, current: T4Operation): boolean {
  const armedNow =
    current.stage === "PREPARANDO_COMPRA" ||
    current.stage === "PREPARANDO_VENDA" ||
    current.stage === "GATILHO_PROXIMO";
  if (!armedNow) return false;
  if (previous === null) return true;
  return previous.setupId !== current.setupId;
}
