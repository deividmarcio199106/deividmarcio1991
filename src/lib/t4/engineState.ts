/**
 * O MOTOR E O SETUP SÃO DUAS PERGUNTAS DIFERENTES.
 *
 * O painel misturava as duas num número só, e o resultado era a leitura errada
 * mais cara possível: "SETUP 0%" sendo interpretado como "a T4 está parada".
 * Com 70 candles fechados, regime lido e viés de VENDA na tela, o motor estava
 * rodando o tempo todo — o que estava em zero era a MATURIDADE DO SETUP, que é
 * uma afirmação sobre o mercado, não sobre o software.
 *
 *   T4_ENGINE      → o motor está analisando?      (software)
 *   SETUP_MATURITY → o setup está maduro?          (mercado)
 *
 * Um mercado sem oportunidade nenhuma mantém ENGINE=ANALISANDO e MATURITY=0% o
 * pregão inteiro, e isso é o comportamento CORRETO. Um motor parado é outra
 * coisa, tem outra causa e outro conserto.
 *
 * VOCABULÁRIO OPERACIONAL
 * Os estágios internos (`T4Stage`) nasceram descrevendo a UI antiga. Aqui eles
 * são traduzidos para o vocabulário do fluxo — OBSERVANDO → CANDIDATE →
 * PRE_ENTRY_ARMED → ENTRY_CONFIRMED — sem tocar em NENHUM gate. É tradução de
 * rótulo, não de regra: a decisão continua inteiramente em `preEntry.ts`.
 */

import type { T4Stage } from "./preEntry";
import type { Direction } from "@/lib/engines/types";

export type T4EngineState =
  /** Nenhuma imagem chegando: não há o que analisar. */
  | "AGUARDANDO_LEITURA"
  /** Imagem viva, histórico insuficiente. O motor está montando contexto. */
  | "COLETANDO_HISTORICO"
  /** Rodando. É o estado normal de um pregão sem setup. */
  | "ANALISANDO"
  /** Havia leitura e ela caiu — distinto de "a técnica reprovou". */
  | "PAUSADO_DADO";

export interface EngineInput {
  /** O operador pediu leitura. */
  requested: boolean;
  /** Pixels utilizáveis chegando AGORA. */
  reading: boolean;
  closedCandles: number;
  minimumCandles: number;
}

export function engineState(input: EngineInput): T4EngineState {
  if (!input.requested) return "AGUARDANDO_LEITURA";
  // Pedida e sem imagem utilizável: a leitura caiu, não é o mercado parado.
  if (!input.reading) return "PAUSADO_DADO";
  if (input.closedCandles < input.minimumCandles) return "COLETANDO_HISTORICO";
  return "ANALISANDO";
}

export const ENGINE_LABEL: Record<T4EngineState, string> = {
  AGUARDANDO_LEITURA: "AGUARDANDO LEITURA",
  COLETANDO_HISTORICO: "COLETANDO HISTÓRICO",
  ANALISANDO: "ANALISANDO",
  PAUSADO_DADO: "PAUSADO — SEM IMAGEM",
};

/** Vocabulário do fluxo operacional, o mesmo usado no Golden e nos registros. */
export type T4FlowState =
  /** Sem dado valido: nao ha o que observar. Distinto de "observando e nada aconteceu". */
  | "WAITING_DATA"
  | "OBSERVANDO"
  | "CONTEXT_READY"
  | "CANDIDATE"
  | "PRE_ENTRY_ARMED"
  | "ENTRY_CONFIRMED"
  | "MANAGING"
  | "INVALIDATED"
  | "CLOSED";

/**
 * Estágio interno + maturidade → estado do fluxo.
 *
 * A maturidade é quem distingue OBSERVANDO de CONTEXT_READY e de CANDIDATE:
 * são os mesmos gates, em graus diferentes de completude, e `preEntry.ts` já
 * calculou isso. Recalcular aqui criaria uma segunda verdade sobre o mesmo
 * setup — e duas verdades divergem.
 */
export function flowState(stage: T4Stage, maturity: number, managing = false): T4FlowState {
  switch (stage) {
    case "ENTRADA_CONFIRMADA":
      return managing ? "MANAGING" : "ENTRY_CONFIRMED";
    case "PREPARANDO_COMPRA":
    case "PREPARANDO_VENDA":
    case "GATILHO_PROXIMO":
      return "PRE_ENTRY_ARMED";
    case "INVALIDADA":
      return "INVALIDATED";
    case "ENCERRADA":
      return "CLOSED";
    case "AGUARDANDO":
      // AGUARDANDO e falta de DADO, nao leitura sem oportunidade. Mapear para
      // OBSERVANDO fazia o painel dizer que a T4 observava um mercado que ela
      // nao estava recebendo.
      return "WAITING_DATA";
    case "OBSERVANDO":
    default:
      if (maturity >= 78) return "CANDIDATE";
      if (maturity >= 45) return "CONTEXT_READY";
      return "OBSERVANDO";
  }
}

/**
 * O que mostrar ANTES de existir sinal.
 *
 * Precisa dizer para que lado a leitura aponta sem parecer ordem — por isso
 * "VIÉS OBSERVADO", e não "COMPRA". A distinção é a diferença entre informar e
 * mandar operar.
 */
export function biasLabel(direction: Direction | null): string {
  if (direction === "COMPRA") return "VIÉS OBSERVADO: COMPRA";
  if (direction === "VENDA") return "VIÉS OBSERVADO: VENDA";
  return "VIÉS OBSERVADO: NEUTRO";
}

export interface VisionProgressInput {
  captureActive: boolean;
  chartVisible: boolean;
  candlesParsed: boolean;
  historyReady: boolean;
  structureRead: boolean;
  liquidityMapped: boolean;
  confirmed: boolean;
}

export interface VisionProgress {
  /**
   * 0 ou 100. NAO e progresso de setup — e o pipeline estar FUNCIONAL.
   *
   * Um numero intermediario aqui foi lido, com razao, como "falta alguma coisa
   * para o sistema funcionar". Com captura, candles, historico, estrutura e
   * liquidez prontos, nao falta nada: o sistema esta funcional e o que falta e
   * OPORTUNIDADE — que e do mercado, nao do software, e ja tem seu proprio
   * numero em MATURIDADE DO SETUP.
   */
  percent: 0 | 100;
  functional: boolean;
  label: string;
  /** O degrau que falta para o pipeline ficar funcional. */
  next: string | null;
  /** Quantos degraus do pipeline ja passaram, para o detalhe da UI. */
  stepsDone: number;
  stepsTotal: number;
}

/**
 * Escada do pipeline visual.
 *
 * A ESCADA ANTIGA TRAVAVA EM 30%: o degrau de 40% exigia escala de preço
 * calibrada, e a escala é PARALELA por decisão de projeto. Um pregão inteiro
 * com estrutura lida e liquidez mapeada aparecia como "30% — detecção do
 * gráfico", que é falso sobre o que a T4 já sabia.
 *
 * Aqui a escala não é degrau. Ela habilita NÚMERO, não leitura.
 */
export function visionT4Progress(input: VisionProgressInput): VisionProgress {
  /*
   * O DEGRAU DE 90% SAIU, E ELE ERA O PIOR DA ESCADA.
   *
   * Ele media `gatesEvaluated` — "os gates foram avaliados" —, que é VERDADEIRO
   * assim que o motor roda uma vez. Não media nada: a barra subia para 90% e
   * estacionava ali o pregão inteiro, dizendo "quase lá" enquanto a maturidade
   * do setup era 0% e o mercado não tinha oportunidade nenhuma.
   *
   * Dois números sobre a mesma coisa, discordando — o mesmo defeito que já
   * corrigimos em outros pontos. Agora a escada mede só o que ela sabe medir: a
   * prontidão do PIPELINE. Ela para em 80% quando tudo está pronto, e 100% é
   * reservado para a técnica ATIVAR de fato.
   */
  const steps: Array<[number, boolean, string]> = [
    [15, input.captureActive, "CAPTURA DA TELA"],
    [30, input.chartVisible, "GRÁFICO VISÍVEL"],
    [45, input.candlesParsed, "CANDLES RECONSTRUÍDOS"],
    [60, input.historyReady, "HISTÓRICO SUFICIENTE"],
    [70, input.structureRead, "ESTRUTURA"],
    [80, input.liquidityMapped, "LIQUIDEZ"],
    [100, input.confirmed, "ENTRADA CONFIRMADA"],
  ];

  let percent = 0;
  let label = "AGUARDANDO LEITURA";
  for (const [value, met, name] of steps) {
    if (!met) break;
    percent = value;
    label = name;
  }
  const next = steps.find(([value]) => value > percent);

  /*
   * "PRÓXIMO PASSO: ENTRADA CONFIRMADA" era promessa, não informação.
   *
   * Com o pipeline pronto e sem setup, o único degrau restante é a confirmação —
   * e anunciá-la como próximo passo sugere que ela está a caminho. Ela pode não
   * vir no pregão inteiro, e isso é o comportamento correto da técnica.
   */
  /*
   * FUNCIONAL E BINARIO.
   *
   * O pipeline entrega leitura utilizavel, ou nao entrega. Os degraus continuam
   * existindo para dizer O QUE falta enquanto ele sobe — mas o numero grande
   * deixa de sugerir "80% de um sinal".
   *
   * A confirmacao da tecnica NAO entra nesta conta: ela e sobre o mercado. Um
   * pregao inteiro sem setup mantem o sistema 100% funcional.
   */
  const pipeline = steps.filter(([value]) => value < 100);
  const stepsDone = pipeline.filter(([, met]) => met).length;
  const functional = stepsDone === pipeline.length;
  return {
    percent: functional ? 100 : 0,
    functional,
    label: functional ? "PIPELINE FUNCIONAL" : label,
    next: functional
      ? input.confirmed
        ? null
        : "AGUARDANDO SETUP DA TÉCNICA"
      : (next?.[2] ?? null),
    stepsDone,
    stepsTotal: pipeline.length,
  };
}
