import { fechamentoProvado, type CandlePhase, type CloseSource } from "./candleLedger";
import { resolveInstrument } from "@/lib/engines/instruments";

/**
 * ROMPIMENTO COM SUSTENTAÇÃO — um fechamento além do gatilho NÃO libera nada.
 *
 * O DEFEITO QUE ISTO ENCERRA (sessão de 19/08, gatilho 170.925): o preço
 * rompeu, UM candle fechou acima, e a tela tratou aquilo como entrada. O candle
 * seguinte devolveu o movimento inteiro e fechou abaixo do gatilho. Isso não é
 * entrada que deu errado — é ROMPIMENTO QUE FALHOU, e a diferença importa em
 * três lugares: não existe trade, não existe acerto nem erro de operação, e o
 * evento continua no histórico como aprendizado.
 *
 * A REGRA, POR EXTENSO:
 *   COMPRA: rompe o gatilho → fecha acima → AGUARDA SUSTENTAÇÃO.
 *   Confirma só com uma das duas provas:
 *     — o candle seguinte permanece/fecha acima do gatilho; OU
 *     — houve reteste do gatilho com rejeição compradora válida.
 *   VENDA é o inverso exato, sem exceção e sem parâmetro diferente.
 *
 * As pernas são SEPARADAS de propósito (`triggerTouched`, `breakoutClosed`,
 * `breakoutSustained`, `retestConfirmed`): um booleano único "confirmado"
 * esconde QUAL prova faltou, e foi exatamente isso que deixou um fechamento
 * solitário passar por confirmação. `setupConfirmed` é derivado, nunca gravado:
 *
 *   setupConfirmed = breakoutClosed && (breakoutSustained || retestConfirmed)
 *
 * O QUE ESTE MÓDULO NÃO FAZ: julgar níveis, R:R, auditor ou confiança. Ele
 * responde UMA pergunta — o rompimento se sustentou? A liberação da operação
 * exige isto E todas as outras provas (ver `evaluateEntryProof` e o gate de
 * risco em ./riskGate).
 */

export type BreakoutSide = "COMPRA" | "VENDA";

/**
 * Fases do rompimento — o pedaço da máquina única (§10) que este módulo
 * governa. `BREAKOUT_CLOSED` e `WAITING_SUSTAIN` são estados DIFERENTES de
 * propósito: o primeiro é "fechou além, ninguém provou nada ainda", o segundo é
 * "o preço voltou ao gatilho e o reteste está em curso". Fundi-los apagaria a
 * informação de que existe um reteste vivo na tela.
 */
export type BreakoutPhase =
  "WAITING_BREAKOUT" | "BREAKOUT_CLOSED" | "WAITING_SUSTAIN" | "CONFIRMED" | "BREAKOUT_FAILED";

export type BreakoutEventKind =
  | "TRIGGER_TOUCHED"
  | "BREAKOUT_CLOSED"
  | "RETEST_TOUCHED"
  | "RETEST_CONFIRMED"
  | "BREAKOUT_SUSTAINED"
  | "BREAKOUT_FAILED"
  | "OUT_OF_ORDER"
  /**
   * A observacao chegou mas NAO era prova de fechamento (§ trava do operador).
   *
   * Tem tipo proprio porque significa outra coisa que OUT_OF_ORDER: la o dado
   * era valido e velho; aqui ele e do agora e nao prova nada. Uma tela que
   * junta os dois esconde do operador que o sistema esta esperando a VIRADA do
   * candle, e nao um candle mais novo.
   */
  | "OBSERVATION_REJECTED";

export interface BreakoutEvent {
  kind: BreakoutEventKind;
  at: number;
  candleTime: number;
  close: number;
  /** Por que este evento existe — sempre presente, nunca vazio. */
  reason: string;
}

/** Uma observação de candle FECHADO. Pavio entra separado, e não confirma. */
export interface CandleObservation {
  /** Fechamento observado. É a única evidência que confirma rompimento. */
  close: number;
  /** Máxima/mínima quando legíveis. Marcam TOQUE e reteste — nunca confirmação. */
  high?: number | null;
  low?: number | null;
  /** Início do candle. Chave de unicidade: reobservar o mesmo candle é no-op. */
  candleTime: number;
  at: number;
  /**
   * A NATUREZA DO CANDLE VIRA DADO, E DEIXA DE SER PROMESSA DO COMENTÁRIO.
   *
   * Este tipo sempre DISSE "candle FECHADO" na documentação, e nada no tipo
   * provava. Enquanto isso o chamador fabricava a observação a partir da
   * etiqueta de preço do eixo — que é o preço CORRENTE de um candle em
   * formação. Medido em 20/08/2026: em 55 de 56 prints legíveis o cabeçalho do
   * Profit mostrava o candle em formação, e o elo 076→077 (`Fch 170.960`
   * seguido de `Abr 170.965`) provou que houve negócio depois da captura.
   *
   * Agora quem quiser mover a máquina precisa DECLARAR de onde veio o
   * fechamento, e `observeClose` recusa o que não for prova. Ver
   * @/lib/print/candleLedger, que é quem carimba estes dois campos.
   */
  phase: CandlePhase;
  closeSource: CloseSource;
}

/**
 * Por que a observação foi recusada — ou `null` quando entrou.
 *
 * Recusa é EVENTO, não silêncio: sem isso a máquina simplesmente não andaria e
 * o operador não saberia se o mercado está parado ou se a leitura não prova
 * nada. As duas coisas parecem iguais na tela e não são.
 */
export type ObservationRejection = "CANDLE_EM_FORMACAO" | "FECHAMENTO_NAO_PROVADO";

export function rejectObservation(obs: CandleObservation): ObservationRejection | null {
  if (obs.phase !== "CLOSED") return "CANDLE_EM_FORMACAO";
  if (!fechamentoProvado(obs.closeSource)) return "FECHAMENTO_NAO_PROVADO";
  return null;
}

/** A frase que a tela mostra para cada recusa. Uma fonte, uma redação. */
export const REJECTION_LABEL: Record<ObservationRejection, string> = {
  CANDLE_EM_FORMACAO: "candle ainda em formação — a confirmação espera a virada do candle",
  FECHAMENTO_NAO_PROVADO:
    "fechamento do candle anterior não foi lido no gráfico — sem prova, sem confirmação",
};

export interface BreakoutState {
  side: BreakoutSide;
  trigger: number;
  /** Quanto o fechamento precisa ultrapassar o gatilho para contar. */
  tolerance: number;
  triggerTouched: boolean;
  breakoutClosed: boolean;
  breakoutSustained: boolean;
  retestConfirmed: boolean;
  /** Derivado — ver a fórmula no cabeçalho. Gravado só para inspeção. */
  setupConfirmed: boolean;
  phase: BreakoutPhase;
  /** Candle em que o rompimento fechou. Null enquanto não houve. */
  breakoutCandleTime: number | null;
  /** Último candle aplicado — barra duplicata e observação fora de ordem. */
  lastCandleTime: number | null;
  /** O preço voltou à zona do gatilho depois do rompimento. */
  retestTouched: boolean;
  /** Motivo da falha. Preenchido SÓ em BREAKOUT_FAILED. */
  failureReason: string | null;
  history: BreakoutEvent[];
}

/** Guarda o histórico curto: o card mostra os últimos, o resto é ruído. */
const MAX_HISTORY = 24;

/**
 * TOLERÂNCIA DE ROMPIMENTO = 1 TICK DO CONTRATO.
 *
 * Um fechamento "além" precisa ser além de VERDADE. Sem tick a régua vira
 * fração do preço, e a fração é escolhida apertada de propósito: a tolerância
 * de TOQUE da máquina de setup (0,03%) daria 51 pontos num índice em 170.925 —
 * com ela, um candle que devolvesse 45 pontos abaixo do gatilho não contaria
 * como devolução, e o rompimento falho da sessão de 19/08 passaria de novo.
 */
const FALLBACK_TOLERANCE_FRACTION = 0.00005;

export function breakoutTolerance(trigger: number, symbol: string | null): number {
  const instrumento = symbol === null ? null : resolveInstrument(symbol);
  if (instrumento !== null) return instrumento.tickSize;
  return Math.max(Math.abs(trigger) * FALLBACK_TOLERANCE_FRACTION, Number.EPSILON);
}

export interface BreakoutInit {
  side: BreakoutSide;
  trigger: number;
  /** Ativo, para a tolerância sair do tick real. Null usa a fração de reserva. */
  symbol?: string | null;
  /** Sobrescrita explícita da tolerância — usada em teste e em reprocessamento. */
  tolerance?: number;
}

export function initBreakout(init: BreakoutInit): BreakoutState {
  const tolerance =
    typeof init.tolerance === "number" && Number.isFinite(init.tolerance) && init.tolerance > 0
      ? init.tolerance
      : breakoutTolerance(init.trigger, init.symbol ?? null);
  return {
    side: init.side,
    trigger: init.trigger,
    tolerance,
    triggerTouched: false,
    breakoutClosed: false,
    breakoutSustained: false,
    retestConfirmed: false,
    setupConfirmed: false,
    phase: "WAITING_BREAKOUT",
    breakoutCandleTime: null,
    lastCandleTime: null,
    retestTouched: false,
    failureReason: null,
    history: [],
  };
}

/** Terminal: exige nova estrutura/setup, salvo rearme explícito (ver `rearm`). */
export function isTerminalBreakout(phase: BreakoutPhase): boolean {
  return phase === "CONFIRMED" || phase === "BREAKOUT_FAILED";
}

/**
 * Distância do fechamento ALÉM do gatilho, no sentido da operação.
 * Positiva = a favor do rompimento; negativa = devolveu o nível.
 */
function alem(state: BreakoutState, price: number): number {
  return state.side === "COMPRA" ? price - state.trigger : state.trigger - price;
}

function push(state: BreakoutState, event: BreakoutEvent): BreakoutEvent[] {
  return [...state.history, event].slice(-MAX_HISTORY);
}

/**
 * O passo da máquina: um candle FECHADO atualiza (ou mata) o rompimento.
 *
 * PURA. Observação repetida do mesmo candle não muda nada — é a mesma trava que
 * impede um frame duplicado de mover o estado (§3): dez capturas do mesmo
 * minuto produzem UMA transição, não dez.
 */
export function observeClose(state: BreakoutState, obs: CandleObservation): BreakoutState {
  if (isTerminalBreakout(state.phase)) return state;

  /*
   * A TRAVA DO OPERADOR, NA FONTE: nenhuma entrada nasce de candle FORMING.
   *
   * Fica AQUI, e não no chamador, porque este é o único lugar por onde um
   * fechamento entra na máquina — pôr a regra no chamador seria confiar em que
   * todo chamador futuro se lembre dela. O evento é registrado no histórico:
   * uma máquina que não anda precisa dizer por que não andou.
   */
  const recusa = rejectObservation(obs);
  if (recusa !== null) {
    return {
      ...state,
      history: push(state, {
        kind: "OBSERVATION_REJECTED",
        at: obs.at,
        candleTime: obs.candleTime,
        close: obs.close,
        reason: REJECTION_LABEL[recusa],
      }),
    };
  }

  /*
   * FORA DE ORDEM NÃO ANDA A MÁQUINA — e é DITO.
   *
   * Uma análise lenta pode voltar depois de um candle mais novo já ter sido
   * aplicado. Ela continua valendo como registro, mas reaplicá-la moveria a
   * fase com um passado — que é a versão temporal do look-ahead.
   */
  if (state.lastCandleTime !== null && obs.candleTime <= state.lastCandleTime) {
    if (obs.candleTime === state.lastCandleTime) return state;
    return {
      ...state,
      history: push(state, {
        kind: "OUT_OF_ORDER",
        at: obs.at,
        candleTime: obs.candleTime,
        close: obs.close,
        reason: `observação do candle ${new Date(obs.candleTime).toISOString()} chegou depois de um candle mais novo — ignorada para o estado`,
      }),
    };
  }

  const distancia = alem(state, obs.close);
  const fechouAlem = distancia > state.tolerance;
  const devolveu = distancia < -state.tolerance;

  // Pavio: marca TOQUE e sustenta reteste — nunca confirma sozinho.
  const extremo = state.side === "COMPRA" ? (obs.high ?? obs.close) : (obs.low ?? obs.close);
  const extremoAlcancou = alem(state, extremo) >= -state.tolerance;
  // O extremo CONTRÁRIO é o que prova que o preço voltou ao gatilho no reteste.
  const extremoContrario =
    state.side === "COMPRA" ? (obs.low ?? obs.close) : (obs.high ?? obs.close);
  const voltouAoGatilho = alem(state, extremoContrario) <= state.tolerance;

  let next: BreakoutState = {
    ...state,
    lastCandleTime: obs.candleTime,
    triggerTouched: state.triggerTouched || extremoAlcancou,
  };
  if (!state.triggerTouched && extremoAlcancou) {
    next = {
      ...next,
      history: push(state, {
        kind: "TRIGGER_TOUCHED",
        at: obs.at,
        candleTime: obs.candleTime,
        close: obs.close,
        reason: `preço alcançou o gatilho ${state.trigger}`,
      }),
    };
  }

  /* ---------- Ainda sem rompimento: o fechamento além é o que abre a máquina ---------- */
  if (next.phase === "WAITING_BREAKOUT") {
    if (!fechouAlem) return finalize(next);
    return finalize({
      ...next,
      breakoutClosed: true,
      breakoutCandleTime: obs.candleTime,
      phase: "BREAKOUT_CLOSED",
      history: push(next, {
        kind: "BREAKOUT_CLOSED",
        at: obs.at,
        candleTime: obs.candleTime,
        close: obs.close,
        reason: `fechou ${state.side === "COMPRA" ? "acima" : "abaixo"} do gatilho ${state.trigger} (${obs.close}) — falta sustentação`,
      }),
    });
  }

  /* ---------- Rompeu: este candle decide entre falhar, sustentar ou retestar ---------- */

  /*
   * §2 — FALSE_BREAKOUT. O candle seguinte devolveu o nível de forma
   * relevante. Não é entrada perdida: é entrada que NUNCA existiu.
   */
  if (devolveu) {
    return finalize({
      ...next,
      phase: "BREAKOUT_FAILED",
      breakoutSustained: false,
      retestConfirmed: false,
      failureReason: `candle seguinte fechou ${state.side === "COMPRA" ? "abaixo" : "acima"} do gatilho ${state.trigger} (${obs.close}) — rompimento devolvido`,
      history: push(next, {
        kind: "BREAKOUT_FAILED",
        at: obs.at,
        candleTime: obs.candleTime,
        close: obs.close,
        reason: `rompimento falhou: fechamento ${obs.close} devolveu o gatilho ${state.trigger}`,
      }),
    });
  }

  if (fechouAlem) {
    /*
     * RETESTE COM REJEIÇÃO NO MESMO CANDLE conta: o preço voltou a encostar no
     * gatilho (pavio contrário) e ainda assim FECHOU além. É a prova que o
     * operador chama de rejeição — e ela é mais forte que o simples "ficou
     * acima", por isso é registrada com nome próprio em vez de virar sustentação
     * genérica.
     */
    const rejeitou = next.retestTouched || voltouAoGatilho;
    return finalize({
      ...next,
      phase: "CONFIRMED",
      breakoutSustained: true,
      retestConfirmed: rejeitou,
      history: push(next, {
        kind: rejeitou ? "RETEST_CONFIRMED" : "BREAKOUT_SUSTAINED",
        at: obs.at,
        candleTime: obs.candleTime,
        close: obs.close,
        reason: rejeitou
          ? `reteste do gatilho ${state.trigger} com rejeição — fechou de volta em ${obs.close}`
          : `permaneceu ${state.side === "COMPRA" ? "acima" : "abaixo"} do gatilho ${state.trigger} (${obs.close})`,
      }),
    });
  }

  /*
   * Fechamento DENTRO da tolerância do gatilho: não devolveu, mas também não
   * sustentou. É reteste em curso — e reteste em curso não é confirmação.
   */
  return finalize({
    ...next,
    phase: "WAITING_SUSTAIN",
    retestTouched: true,
    history: next.retestTouched
      ? next.history
      : push(next, {
          kind: "RETEST_TOUCHED",
          at: obs.at,
          candleTime: obs.candleTime,
          close: obs.close,
          reason: `fechou colado no gatilho ${state.trigger} (${obs.close}) — reteste em curso, sem sustentação`,
        }),
  });
}

/** `setupConfirmed` nunca é escrito à mão: ele é a fórmula, aplicada aqui. */
function finalize(state: BreakoutState): BreakoutState {
  return {
    ...state,
    setupConfirmed: state.breakoutClosed && (state.breakoutSustained || state.retestConfirmed),
  };
}

/**
 * REARME EXPLÍCITO — a única porta de volta depois de um rompimento falho.
 *
 * §2 exige nova estrutura para nova tentativa. Rearmar não é "tentar de novo com
 * o mesmo gatilho por otimismo": é declarar que a estrutura mudou e que existe
 * um gatilho NOVO. Por isso o nível entra por parâmetro e o histórico segue
 * junto — o falso rompimento anterior continua visível no card.
 */
export function rearm(
  state: BreakoutState,
  trigger: number,
  motivo: string,
  at: number,
): BreakoutState {
  const novo = initBreakout({ side: state.side, trigger, tolerance: state.tolerance });
  return {
    ...novo,
    history: [
      ...state.history.slice(-MAX_HISTORY + 1),
      {
        kind: "OUT_OF_ORDER",
        at,
        candleTime: state.lastCandleTime ?? at,
        close: trigger,
        reason: `rearmado em ${trigger}: ${motivo}`,
      },
    ],
  };
}

/** As três linhas que a tela mostra quando o rompimento falha (§2). */
export const FALSE_BREAKOUT_UI = [
  "ROMPIMENTO FALHOU",
  "ENTRADA NÃO CONFIRMADA",
  "OPERAÇÃO BLOQUEADA",
] as const;

/**
 * O rompimento libera operação?
 *
 * Só `setupConfirmed`. Existe como função, e não como leitura direta do campo,
 * porque é ela que os chamadores importam — e um campo lido solto em cinco
 * lugares vira cinco regras no primeiro ajuste.
 */
export function rompimentoLibera(state: BreakoutState | null): boolean {
  return state !== null && state.setupConfirmed;
}

/** O que falta para o rompimento confirmar. Vazio SÓ quando confirmado. */
export function pendenciasDoRompimento(state: BreakoutState | null): string[] {
  if (state === null) return [];
  if (state.phase === "BREAKOUT_FAILED") {
    return [state.failureReason ?? "rompimento falhou — operação bloqueada"];
  }
  if (state.setupConfirmed) return [];
  if (!state.breakoutClosed) {
    return [
      `sem fechamento ${state.side === "COMPRA" ? "acima" : "abaixo"} do gatilho ${state.trigger}`,
    ];
  }
  return [
    state.retestTouched
      ? `reteste do gatilho ${state.trigger} em curso — falta a rejeição fechar ${state.side === "COMPRA" ? "acima" : "abaixo"}`
      : `rompimento fechado sem sustentação — aguardando o próximo candle confirmar ${state.side === "COMPRA" ? "acima" : "abaixo"} de ${state.trigger}`,
  ];
}
