import type { T4SetupId } from "./t4Engine";
import type { LiquidityCaptureResult, POI, SMSRead, TradePlan, Direction } from "./types";

/**
 * MOTOR DE SEQUÊNCIA CAUSAL (spec finalíssimo §23–§25).
 *
 * Detectar eventos não basta: eles precisam ocorrer em ORDEM coerente e dentro
 * de uma JANELA temporal. Compra: sweep abaixo → reação → fechamento de
 * confirmação → mudança estrutural → POI → reteste → confirmação de entrada.
 * Venda: espelhado.
 *
 * Regras do spec:
 * - sequência incompleta = WAIT (§25) — nunca preencher evento inexistente;
 * - sweep antigo demais não é gatilho novo (§24): fora da janela, a sequência
 *   volta para o início;
 * - este motor não agrega pontuação: ele é um GATE (§38 sequenceValid).
 */

export type CausalStage =
  | "liquiditySweep"
  | "reaction"
  | "confirmationClose"
  | "structureShift"
  | "poi"
  | "retest"
  | "entryConfirmation";

export const CAUSAL_ORDER: CausalStage[] = [
  "liquiditySweep",
  "reaction",
  "confirmationClose",
  "structureShift",
  "poi",
  "retest",
  "entryConfirmation",
];

/** Janela máxima entre o sweep e o candle atual, em candles de 1 minuto. */
export const SEQUENCE_WINDOW_BARS = 30;

/**
 * QUEM PRECISA DE CAPTURA DE LIQUIDEZ — copiado do roteador, não inventado.
 *
 * A lista espelha `evaluateT4`: RANGE_SWEEP exige `captureAligned`,
 * FAILED_BREAKOUT nasce de `breakoutFailed` (que deriva da captura) e
 * HSS_CAPTURE é, por definição, "captura + estrutura + reteste". PHASE_RESET
 * aceita captura OU deslocamento, então não entra aqui: exigir sweep dele
 * seria endurecer a técnica por conta própria, que é tão errado quanto
 * afrouxá-la.
 *
 * `NONE` fica de fora deliberadamente: quando o roteador não reconheceu
 * família, prender a sequência ao sweep faria a tela dizer "aguardando sweep"
 * em contexto de tendência — a mentira que originou este conserto.
 */
const FAMILIAS_QUE_EXIGEM_SWEEP: T4SetupId[] = ["RANGE_SWEEP", "FAILED_BREAKOUT", "HSS_CAPTURE"];

/**
 * QUEM PRECISA DE MUDANÇA ESTRUTURAL CONFIRMADA — também do roteador.
 *
 * RANGE_SWEEP, FAILED_BREAKOUT, PHASE_RESET e HSS_CAPTURE exigem `smsAligned`.
 * TREND_FIRST_PULLBACK e EXPANSION_RETEST não: continuação de tendência não
 * pede quebra de estrutura — pede a estrutura VIGENTE respeitada.
 */
const FAMILIAS_QUE_EXIGEM_ESTRUTURA: T4SetupId[] = [
  "RANGE_SWEEP",
  "FAILED_BREAKOUT",
  "PHASE_RESET",
  "HSS_CAPTURE",
];

export interface CausalStageState {
  stage: CausalStage;
  met: boolean;
  /** Instante do evento quando conhecido (epoch ms); null quando derivado do estado atual. */
  at: number | null;
  note: string;
}

export interface CausalSequenceRead {
  direction: Direction;
  stages: CausalStageState[];
  complete: boolean;
  missing: CausalStage[];
  /** true quando o sweep existe mas está velho demais para ancorar a sequência. */
  staleSweep: boolean;
  /** true quando eventos datados aparecem em ordem incoerente. */
  orderViolated: boolean;
  label: string;
}

export interface CausalSequenceInput {
  direction: Direction;
  capture: LiquidityCaptureResult;
  reactionConfirmed: boolean;
  sms: SMSRead;
  mainPoi: POI | null;
  plan: TradePlan | null;
  priceInEntryZone: boolean;
  price: number;
  lastCandleAt: number;
  barMs?: number;
  windowBars?: number;
  /**
   * Família T4 reconhecida pelo roteador. É ela que decide QUAIS estágios são
   * pré-requisito — sem isso a sequência aplicava a regra da captura a todas as
   * famílias e travava as de continuação. Ausente = "NONE" (contexto ainda não
   * roteado), tratado como sequência sem exigência de captura.
   */
  family?: T4SetupId;
}

export function evaluateCausalSequence(input: CausalSequenceInput): CausalSequenceRead {
  const barMs = input.barMs ?? 60_000;
  const windowBars = input.windowBars ?? SEQUENCE_WINDOW_BARS;
  const { direction } = input;

  if (direction === "NEUTRO") {
    return {
      direction,
      stages: CAUSAL_ORDER.map((stage) => ({ stage, met: false, at: null, note: "sem direção" })),
      complete: false,
      missing: [...CAUSAL_ORDER],
      staleSweep: false,
      orderViolated: false,
      label: "Sequência causal não avaliada: direção indefinida.",
    };
  }

  // 1. Sweep de liquidez na direção certa: compra varre liquidez ABAIXO
  // (vendedora); venda varre liquidez ACIMA (compradora).
  const expectedSide = direction === "COMPRA" ? "vendedora" : "compradora";
  const sweepAt = input.capture.detail.at;
  const sweepDetected =
    input.capture.valid &&
    input.capture.direction === direction &&
    input.capture.detail.side === expectedSide;
  const sweepAgeBars = sweepAt !== null ? (input.lastCandleAt - sweepAt) / barMs : null;
  const staleSweep = sweepDetected && sweepAgeBars !== null && sweepAgeBars > windowBars;
  const sweepMet = sweepDetected && !staleSweep;

  /*
   * A ÂNCORA DA SEQUÊNCIA DEPENDE DA FAMÍLIA — a correção do "REACTION:
   * Aguardando reação após o sweep" que travava a técnica inteira.
   *
   * O DEFEITO: todo estágio abaixo pendia de `sweepMet`. Como
   * `reaction = sweepMet && ...`, `close = reaction && ...`, `sms = close && ...`
   * e assim por diante, a ausência de captura de liquidez zerava a cadeia
   * INTEIRA. Mas o roteador T4 (`evaluateT4`) declara, em código e no comentário
   * "Sweep não é obrigatório", que TREND_FIRST_PULLBACK e EXPANSION_RETEST não
   * exigem captura: a tese delas é o pullback defendido, não a varredura.
   *
   * Resultado: as duas famílias de continuação — a nº 1 da lista de
   * `docs/T4_FINAL.md` — eram reconhecidas pelo roteador e reprovadas pelos
   * gates, que leem esta sequência. Nenhuma delas jamais chegou a
   * ENTRADA_CONFIRMADA, ao vivo ou em backtest. Foi exatamente onde o vídeo de
   * março parou: OBSERVANDO, bloqueio "aguardando reação após o sweep", num
   * contexto de tendência onde sweep nunca viria.
   *
   * O QUE ESTA CORREÇÃO NÃO FAZ: afrouxar. Cada família continua exigindo o que
   * o roteador exige dela — as famílias cuja TESE é a captura (RANGE_SWEEP,
   * FAILED_BREAKOUT, HSS_CAPTURE) seguem obrigadas ao sweep, e nenhuma família
   * ganhou permissão nova. O que muda é o pré-requisito indevido: quem não
   * precisa de sweep deixa de ficar preso a ele.
   */
  const exigeSweep = FAMILIAS_QUE_EXIGEM_SWEEP.includes(input.family ?? "NONE");
  const exigeEstrutura = FAMILIAS_QUE_EXIGEM_ESTRUTURA.includes(input.family ?? "NONE");
  const anteriorAoFluxo = exigeSweep ? sweepMet : true;

  // 2. Reação na direção do setup, já medida pelo motor de price action.
  const reactionMet = anteriorAoFluxo && input.reactionConfirmed;

  /*
   * 3. Fechamento de confirmação além do nível (nunca pavio isolado).
   *
   * A PROVA DE FECHAMENTO TAMBÉM É POR FAMÍLIA. Para quem opera a captura, é o
   * fechamento estrutural da própria captura. Para a continuação, é o
   * fechamento do candle além do nível rompido, com corpo real — o mesmo teste
   * que o motor de estrutura aplica (`sms.closeConfirmed`), que NÃO exige que a
   * mudança estrutural inteira esteja confirmada. Nos dois casos exige-se
   * candle FECHADO: nenhum caminho aceita pavio nem candle em formação.
   */
  const provaDeFechamento = exigeSweep
    ? input.capture.detail.closeConfirmed
    : input.sms.closeConfirmed;
  const closeMet = reactionMet && provaDeFechamento;

  // 4. Mudança estrutural (SMS/CHoCH) na MESMA direção — exigida só de quem a
  // tese pede; a continuação de tendência não nasce de quebra de estrutura.
  const smsConfirmada = input.sms.confirmed && input.sms.direction === direction;
  const smsMet = closeMet && (exigeEstrutura ? smsConfirmada : true);

  // 5. POI alinhado e não invalidado.
  const poiMet =
    smsMet &&
    input.mainPoi !== null &&
    input.mainPoi.direction === direction &&
    input.mainPoi.condition !== "invalidado";

  // 6. Reteste: preço dentro do POI ou POI já testado.
  const retestMet =
    poiMet &&
    input.mainPoi !== null &&
    (input.mainPoi.condition === "testado" ||
      (input.price >= input.mainPoi.lower && input.price <= input.mainPoi.upper));

  // 7. Confirmação de entrada: plano válido com preço na zona de entrada.
  const entryMet = retestMet && input.plan !== null && input.priceInEntryZone;

  // Coerência de ordem entre os eventos que TÊM timestamp (sweep, POI).
  const poiAt = input.mainPoi?.originAt ?? null;
  const orderViolated =
    sweepMet && poiMet && sweepAt !== null && poiAt !== null ? poiAt < sweepAt : false;

  const stages: CausalStageState[] = [
    {
      stage: "liquiditySweep",
      met: sweepMet,
      at: sweepAt,
      note: staleSweep
        ? `Sweep detectado há ${Math.round(sweepAgeBars!)} candles — fora da janela de ${windowBars}; contexto mudou.`
        : sweepMet
          ? `Liquidez ${expectedSide} varrida.`
          : "Aguardando varredura de liquidez na direção do setup.",
    },
    {
      stage: "reaction",
      met: reactionMet,
      at: null,
      note: reactionMet
        ? "Reação confirmada no candle fechado."
        : "Aguardando reação após o sweep.",
    },
    {
      stage: "confirmationClose",
      met: closeMet,
      at: null,
      note: closeMet
        ? "Fechamento confirmou o movimento."
        : "Aguardando fechamento de confirmação.",
    },
    {
      stage: "structureShift",
      met: smsMet,
      at: null,
      note: smsMet
        ? input.sms.label
        : exigeEstrutura
          ? "Aguardando mudança estrutural na direção do setup."
          : "Mudança estrutural não é pré-requisito desta família.",
    },
    {
      stage: "poi",
      met: poiMet && !orderViolated,
      at: poiAt,
      note: orderViolated
        ? "POI anterior ao sweep — ordem causal incoerente; POI pertence a outro contexto."
        : poiMet
          ? "POI alinhado e válido."
          : "Aguardando POI válido na direção do setup.",
    },
    {
      stage: "retest",
      met: retestMet && !orderViolated,
      at: null,
      note: retestMet ? "Reteste em andamento ou concluído." : "Aguardando reteste do POI.",
    },
    {
      stage: "entryConfirmation",
      met: entryMet && !orderViolated,
      at: null,
      note: entryMet ? "Entrada tecnicamente confirmada." : "Aguardando confirmação de entrada.",
    },
  ];

  /*
   * O QUE FALTA É O QUE A FAMÍLIA EXIGE — não a lista inteira.
   *
   * `missing` alimenta a frase que o operador lê ("falta liquiditySweep") e o
   * gate de sequência. Cobrar de uma continuação de tendência os estágios que
   * a tese dela não tem deixaria a sequência eternamente incompleta e mandaria
   * o operador esperar um evento que não vai acontecer — que é exatamente o
   * defeito que este módulo acabou de deixar de ter.
   *
   * Os estágios não exigidos continuam VISÍVEIS em `stages`, com a nota
   * dizendo que não são pré-requisito daquela família. Some do "falta", não da
   * auditoria.
   */
  const exigidos = new Set<CausalStage>(CAUSAL_ORDER);
  if (!exigeSweep) exigidos.delete("liquiditySweep");
  if (!exigeEstrutura) exigidos.delete("structureShift");

  const missing = stages
    .filter((stage) => exigidos.has(stage.stage) && !stage.met)
    .map((stage) => stage.stage);
  const complete = missing.length === 0;
  const label = complete
    ? `Sequência causal completa (${direction}).`
    : staleSweep
      ? "WAIT — sweep fora da janela temporal; sequência reiniciada."
      : orderViolated
        ? "WAIT — ordem causal incoerente entre sweep e POI."
        : `WAIT — sequência causal incompleta: falta ${missing[0]}.`;

  return { direction, stages, complete, missing, staleSweep, orderViolated, label };
}
