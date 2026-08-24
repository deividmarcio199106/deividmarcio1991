import {
  evaluateEntryProof,
  type ConditionalPlan,
  hasClosedConfirmationCandle,
  type PrintAnalysis,
} from "@/lib/vision/printAnalysis";
import { assessTradeRisk, riscoAprovado, type RiskAssessment } from "@/lib/t4/riskGate";
import { executeHybridEntry, type OhlcLike } from "@/lib/t4/t42FillEngine";
import { minuteStart } from "@/lib/vision/candleReconstruction";
import type { CaptureStatus } from "@/lib/capture/frameFreshness";
import { PAUSA_LABEL } from "@/lib/capture/frameFreshness";
import { CLIPPED_LABEL } from "@/lib/vision/viewportChange";
import {
  breakoutTolerance,
  FALSE_BREAKOUT_UI,
  initBreakout,
  isTerminalBreakout,
  observeClose,
  pendenciasDoRompimento,
  type BreakoutState,
  type CandleObservation,
} from "./breakout";
import { SETUP_OUTCOME_TTL_MS } from "./setupOutcome";

/**
 * MÁQUINA DE SETUP PERSISTENTE — a mesma oportunidade atravessa os prints.
 *
 * O defeito que isto encerra: cada print de 60s nascia como um mundo novo.
 * A T4 aparecia, sumia, reaparecia, e o operador não sabia se era o MESMO
 * setup evoluindo ou um novo — e "novo setup por minuto" é como se perde a
 * cabeça e o dinheiro. Aqui cada oportunidade ganha um id (T4-AAAA-MM-DD-XXX)
 * e VIVE entre prints enquanto a estrutura continuar válida.
 *
 * MÁQUINA ÚNICA E PADRONIZADA (§10):
 *   DETECTED → FORMING → WAITING_BREAKOUT → BREAKOUT_CLOSED → WAITING_SUSTAIN
 *            → CONFIRMED
 *   Saídas: BREAKOUT_FAILED · INVALIDATED · EXPIRED · RISK_REJECTED · CLOSED
 *   Liberação: só CONFIRMED **e** RISK_APPROVED ⇒ OPERATION_RELEASED.
 *
 * A REGRA DOS §6–7, QUE NÃO SE NEGOCIA:
 * O preço TOCAR a linha roxa não é entrada. Entrada exige TODOS:
 *   toque/reteste + estrutura válida + gatilho no toque + T4 válida +
 *   auditor aprovado (quando rodou) + R:R mínimo.
 * Toque sem o resto = "TOQUE SEM CONFIRMAÇÃO — AGUARDAR", dito na tela.
 *
 * E A REGRA NOVA, QUE CUSTOU UMA SESSÃO PARA SER ESCRITA (§1–§2):
 * UM FECHAMENTO ALÉM DO GATILHO NÃO LIBERA NADA. O rompimento precisa se
 * SUSTENTAR — o candle seguinte permanece além, ou há reteste com rejeição.
 * Devolveu o nível? `BREAKOUT_FAILED`: sem entrada, sem trade, sem acerto e
 * sem erro de operação — o evento fica no histórico como aprendizado. Quem
 * julga isso é ./breakout; aqui ele é uma perna obrigatória da confirmação.
 *
 * FRAME QUE NÃO É NOVO NÃO ANDA A MÁQUINA (§3–§4). Captura duplicada, parada ou
 * fora de ordem devolve o setup INTACTO: nada de estágio, nível, gatilho ou
 * histórico se move sobre um pixel repetido.
 *
 * VIEWPORT ALTERADO SUSPENDE JULGAMENTO (§6). Mudou escala/janela, o setup é
 * PRESERVADO, os níveis NÃO são sobrescritos e a confirmação espera um frame
 * estável.
 *
 * Pós-confirmação (§19): o setup NÃO gera segunda entrada. Cooldown até
 * encerrar/invalidar. §20: sem ativação dentro do prazo, EXPIRED — nada de
 * oportunidade velha pendurada para sempre.
 */

export type SetupStage =
  | "NONE"
  | "DETECTED"
  | "FORMING"
  /*
   * A ESCADA DE APROXIMAÇÃO (decisão do operador, 20/08/2026).
   *
   *   "Pode existir PRE_ALERT, APPROACHING ou ARMED, mas CONFIRMED_ENTRY
   *    somente depois da transição de candle."
   *
   * Os três descrevem PROXIMIDADE e PRONTIDÃO, não prova de rompimento —
   * por isso vivem antes de WAITING_BREAKOUT e nenhum deles libera nada. O
   * que eles resolvem é a tela: até aqui, todo setup vivo e não confirmado
   * aparecia como WAITING_BREAKOUT, tanto o que estava a 800 pontos do
   * gatilho quanto o que já o encostava. O operador não tinha como separar
   * "olho nele" de "pode acontecer agora".
   */
  | "PRE_ALERT"
  | "APPROACHING"
  | "ARMED"
  | "WAITING_BREAKOUT"
  | "BREAKOUT_CLOSED"
  | "WAITING_SUSTAIN"
  | "CONFIRMED"
  | "BREAKOUT_FAILED"
  | "RISK_REJECTED"
  | "CLOSED"
  | "INVALIDATED"
  | "EXPIRED";

/**
 * A lista, para quem precisa validar (endpoint, formulário, teste).
 *
 * `as const satisfies` em vez da anotação `: readonly SetupStage[]`, e o
 * motivo é concreto: a anotação APAGA o tipo literal, a lista vira um
 * `SetupStage[]` qualquer, e quem espalha isso num schema de validação
 * (`z.enum`, que exige tupla com ao menos um elemento) perde a prova de que
 * existe primeiro elemento — era exatamente o erro de compilação em
 * `tradingEndpoints`. Com `as const` a tupla sobrevive; com `satisfies` cada
 * item continua sendo conferido contra a união.
 */
export const SETUP_STAGES = [
  "NONE",
  "DETECTED",
  "FORMING",
  "PRE_ALERT",
  "APPROACHING",
  "ARMED",
  "WAITING_BREAKOUT",
  "BREAKOUT_CLOSED",
  "WAITING_SUSTAIN",
  "CONFIRMED",
  "BREAKOUT_FAILED",
  "RISK_REJECTED",
  "CLOSED",
  "INVALIDATED",
  "EXPIRED",
] as const satisfies readonly SetupStage[];

/*
 * E A LISTA TEM DE SER COMPLETA — conferido pelo compilador.
 *
 * `satisfies` prova que todo item da lista é um estágio válido, mas não que
 * todo estágio válido está na lista. Sem esta checagem, acrescentar um estado
 * à união e esquecer da lista faria o endpoint recusar em produção um setup
 * legítimo, sem sintoma em teste nenhum. O `never` só compila quando os dois
 * conjuntos coincidem.
 */
type EstagioForaDaLista = Exclude<SetupStage, (typeof SETUP_STAGES)[number]>;
const _todosOsEstagiosListados: EstagioForaDaLista extends never ? true : never = true;
void _todosOsEstagiosListados;

/**
 * VOCABULÁRIO ANTIGO, LIDO MAS NUNCA ESCRITO.
 *
 * O banco de produção tem setups gravados com os nomes em português da máquina
 * anterior, e o navegador do operador tem estado em cache. Recusá-los na
 * restauração perderia oportunidade viva no primeiro deploy — por isso a
 * tradução existe na ENTRADA. Na saída só sai o vocabulário canônico: manter as
 * duas grafias circulando é como o sistema acaba com dois nomes para o mesmo
 * estado, que é o defeito do §8 aplicado à própria máquina.
 */
const LEGACY_STAGE: Record<string, SetupStage> = {
  SEM_SETUP: "NONE",
  OBSERVANDO: "DETECTED",
  APROXIMACAO: "WAITING_BREAKOUT",
  FORMACAO: "FORMING",
  PREPARADO: "WAITING_BREAKOUT",
  CONFIRMADO: "CONFIRMED",
  ENCERRADO: "CLOSED",
  INVALIDADO: "INVALIDATED",
  EXPIRADO: "EXPIRED",
};

/** Traduz um estágio persistido (antigo ou novo) para o vocabulário canônico. */
export function normalizeStage(raw: string | null | undefined): SetupStage {
  if (raw == null) return "NONE";
  if ((SETUP_STAGES as readonly string[]).includes(raw)) return raw as SetupStage;
  return LEGACY_STAGE[raw] ?? "NONE";
}

/** Uma versão do gatilho — §9: nada de sobrescrever nível em silêncio. */
export interface TriggerVersion {
  version: number;
  level: number;
  at: number;
  reason: string;
}

export interface TrackedSetup {
  setupId: string;
  stage: SetupStage;
  direction: "COMPRA" | "VENDA";
  /** A linha roxa: o próximo ponto técnico válido de entrada. */
  entryLevel: number | null;
  entryZone: { min: number; max: number } | null;
  stop: number | null;
  target: number | null;
  createdAt: number;
  updatedAt: number;
  /** Quantos prints consecutivos sustentaram este setup. */
  printsSeen: number;
  /** O preço já tocou a linha roxa alguma vez? */
  touched: boolean;
  confirmedAt: number | null;
  /** Por que está no estágio atual — sempre presente, nunca vazio. */
  reason: string;

  /* ---- §9: O GATILHO TEM VERSÃO E HISTÓRICO ---- */
  /** Nível do gatilho em vigor. Null enquanto nenhum foi lido. */
  trigger: number | null;
  triggerVersion: number;
  triggerHistory: TriggerVersion[];

  /* ---- §1–§2: O ROMPIMENTO E A SUSTENTAÇÃO ---- */
  /** Estado do rompimento sobre o gatilho em vigor. Null sem gatilho legível. */
  breakout: BreakoutState | null;

  /* ---- §11: O RISCO ---- */
  /** Último veredito do gate de risco. Null enquanto não avaliado. */
  risk: RiskAssessment | null;
  /** CONFIRMED **e** RISK_APPROVED. A única porta para operar. */
  operationReleased: boolean;

  /* ---- T4.2-HYBRID_ENTRY: execução aguardando reteste ---- */
  /**
   * Presente SÓ quando a confirmação nasceu sob execução T4.2: guarda o OHLC
   * do candle E2 (a âncora IMUTÁVEL da zona) e o estado do rastreio. O plano
   * de níveis do setup só vira operação quando `fillPrice` existir.
   */
  t42?: {
    e2: { o: number; h: number; l: number; c: number };
    fillPrice: number | null;
    fillCandle: number | null;
  } | null;

  /* ---- RASTRO DA PROVA DE FECHAMENTO (auditoria sênior, BLOCO 2) ---- */
  /**
   * COMO esta confirmação provou o fechamento do candle de confirmação:
   *   - "PROVADA": a máquina de rompimento viu candle FECHADO além do gatilho
   *     e sustentação — o caminho da técnica completa;
   *   - "DISPENSADA": confirmada no TOQUE com `exigirCandleFechado: false` —
   *     modo de pesquisa declarado. A linha carrega a marca para SEMPRE:
   *     estatística de homologação EXCLUI estas por padrão, porque entrada no
   *     toque não é a mesma técnica que entrada com fechamento provado;
   *   - `null`/ausente: setup ainda não confirmado (ou registro antigo,
   *     gravado antes do rastro existir — ausência não vira "PROVADA").
   */
  provaFechamento?: "PROVADA" | "DISPENSADA" | null;
}

export interface SetupUpdate {
  setup: TrackedSetup | null;
  /** A instrução da vez, na língua do §7. */
  headline: string;
  /** Pré-alerta §6: preço se aproximando da linha roxa. */
  preAlert: boolean;
  /** Distância atual até a entrada, em pontos e %, quando legível. */
  distancePoints: number | null;
  distancePercent: number | null;
  /** Evento digno de destaque nesta atualização (mudou de estágio etc.). */
  event: string | null;
  /**
   * A CHAVE DA TELA: só `true` autoriza exibir OPERAÇÃO (AÇÃO: COMPRA/VENDA),
   * seta de entrada e congelamento do print. Enquanto for `false` o painel
   * mostra VIÉS e AGUARDANDO CONFIRMAÇÃO — nunca uma ordem.
   */
  entradaConfirmada: boolean;
  /**
   * OPERATION_RELEASED (§10–§11).
   *
   * Coincide com `entradaConfirmada` por construção — a prova de entrada JÁ
   * consulta o mesmo gate de risco (@/lib/t4/riskGate), e é assim que os dois
   * números não podem divergir. Existe como campo próprio porque a tela mostra
   * as DUAS linhas ("ENTRADA CONFIRMADA" e "OPERAÇÃO LIBERADA"), e derivá-las
   * de dois cálculos diferentes seria criar a contradição que esta casa evita.
   */
  operacaoLiberada: boolean;
  /** O que falta para confirmar. Vazio SOMENTE quando entradaConfirmada. */
  pendencias: string[];
  /**
   * Avisos em caixa alta para o topo da tela — as frases do §2 quando o
   * rompimento falha, e a pausa do §4 quando o frame não é novo.
   */
  avisos: string[];
  /** O passo NÃO moveu a máquina (frame duplicado/parado/fora de ordem). */
  frameBloqueado: boolean;
}

/** Setup sem ativação por este tempo expira — §20. */
export const SETUP_TTL_MS = 40 * 60_000;
/** Depois de CONFIRMED/CLOSED, nada de novo setup por este período — §19. */
export const CONFIRM_COOLDOWN_MS = 5 * 60_000;
/** Pré-alerta quando a distância cai abaixo desta fração do stop (ou 0,15%). */
const PRE_ALERT_STOP_FRACTION = 1.5;
/**
 * A faixa LARGA de observação — onde nasce o PRE_ALERT.
 *
 * Três vezes a faixa de pré-alerta: longe o bastante para o aviso chegar
 * antes de o preço estar em cima do gatilho, perto o bastante para não
 * marcar como "aproximando" um setup do outro lado do gráfico. Múltiplo da
 * faixa que já existe, e não um número novo, para as duas se moverem juntas
 * se um dia a de pré-alerta mudar.
 */
const WATCH_BAND_MULTIPLE = 3;
const PRE_ALERT_PRICE_FRACTION = 0.0015;
/** Tolerância de TOQUE (§6) — mais folgada que a de rompimento, de propósito. */
const TOUCH_FRACTION = 0.0003;

const STATUS_TO_STAGE: Record<string, SetupStage> = {
  APROXIMACAO_T4: "WAITING_BREAKOUT",
  T4_EM_FORMACAO: "FORMING",
  PRE_ENTRADA: "WAITING_BREAKOUT",
  ENTRADA_CONFIRMADA: "CONFIRMED",
};

function pad(n: number, size: number): string {
  return String(n).padStart(size, "0");
}

/** T4-AAAA-MM-DD-XXX — o XXX é sequência do dia, mantida pelo chamador. */
export function makeSetupId(at: number, sequence: number): string {
  const d = new Date(at);
  return `T4-${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}-${pad(sequence, 3)}`;
}

/** Nível de entrada da análise: entrada legível > zona > gatilho do plano. */
function entryLevelOf(
  analysis: PrintAnalysis,
  lado: "COMPRA" | "VENDA",
): {
  level: number | null;
  zone: { min: number; max: number } | null;
} {
  if (analysis.entry.visible && analysis.entry.value !== null) {
    return { level: analysis.entry.value, zone: null };
  }
  const zone = analysis.entryZone;
  if (
    zone &&
    zone.min.visible &&
    zone.min.value !== null &&
    zone.max.visible &&
    zone.max.value !== null
  ) {
    return {
      level: (zone.min.value + zone.max.value) / 2,
      zone: { min: zone.min.value, max: zone.max.value },
    };
  }
  const plano = planoDoLado(analysis, lado);
  if (plano !== null) return { level: plano.triggerLevel.value, zone: null };
  return { level: null, zone: null };
}

/**
 * O PLANO DO LADO CERTO — e sempre o MESMO plano para entrada, stop e alvo.
 *
 * O contrato aceita DOIS planos condicionais e o prompt PEDE um para cada lado
 * ("se romper para cima é compra; se perder para baixo é venda"). O validador
 * confere a coerência INTERNA de cada plano, mas nunca o compara com a direção
 * do setup — então os dois lados chegam aqui vivos.
 *
 * Antes, três buscas independentes pegavam "o primeiro plano legível" de cada
 * campo. Num setup de COMPRA isso permitia duas coisas graves: o gatilho do
 * plano de VENDA virar a entrada, e entrada/stop/alvo saírem de planos
 * DIFERENTES — uma quimera que não descreve operação nenhuma.
 *
 * O dano real não é cosmético: o nível do lado contrário fica perto do preço,
 * o toque é marcado no setup errado, e `touched` é PEGAJOSO. Como o toque é a
 * única perna do §7 que `evaluateEntryProof` não julga, falsificá-lo libera
 * uma confirmação sobre um preço que nunca encostou na entrada de verdade.
 */
function planoDoLado(analysis: PrintAnalysis, lado: "COMPRA" | "VENDA"): ConditionalPlan | null {
  const planos = analysis.conditionalPlans ?? [];
  return (
    planos.find(
      (p) =>
        p.side === lado &&
        p.triggerLevel.visible &&
        p.triggerLevel.value !== null &&
        p.stop.visible &&
        p.stop.value !== null,
    ) ?? null
  );
}

function stopOf(analysis: PrintAnalysis, lado: "COMPRA" | "VENDA"): number | null {
  if (analysis.stop.visible && analysis.stop.value !== null) return analysis.stop.value;
  return planoDoLado(analysis, lado)?.stop.value ?? null;
}

function targetOf(analysis: PrintAnalysis, lado: "COMPRA" | "VENDA"): number | null {
  const alvo = analysis.targets.find((t) => t.visible && t.value !== null);
  if (alvo) return alvo.value;
  const plano = planoDoLado(analysis, lado);
  if (plano === null) return null;
  return plano.targets.find((t) => t.visible && t.value !== null)?.value ?? null;
}

/**
 * O NÍVEL DO GATILHO (§9).
 *
 * Prioridade: o gatilho DECLARADO no plano condicional do lado do setup — é o
 * número que o operador lê como "se romper aqui". Sem plano legível, a própria
 * linha de entrada é o gatilho: em T4 de rompimento os dois coincidem, e usar a
 * entrada mantém a regra de sustentação viva mesmo quando o modelo não escreveu
 * um plano formal. Sem nenhum dos dois, não há gatilho — e nada é inventado.
 */
function triggerOf(
  analysis: PrintAnalysis,
  lado: "COMPRA" | "VENDA",
  entryLevel: number | null,
): number | null {
  const plano = planoDoLado(analysis, lado);
  if (plano !== null) return plano.triggerLevel.value;
  return entryLevel;
}

/** Contexto do frame e da janela — o que decide se este passo PODE julgar. */
export interface AdvanceContext {
  /**
   * Exigir candle FECHADO para confirmar entrada. Ausente = `true`, a regra da
   * casa: rompimento só por pavio não confirma (evento TOQUE_SEM_CONFIRMACAO).
   *
   * `false` entra na leitura de VÍDEO por decisão explícita do operador, porque
   * ali o OHLC do candle não é legível na resolução da gravação — a técnica
   * ficava sem confirmar por falta de PROVA, não de setup (medido: 8 toques a
   * 6–53 pontos do gatilho, nenhuma confirmação, 40 descartes de "máxima não
   * legível"). Quem dispensa a prova recebe o aviso junto do resultado.
   */
  exigirCandleFechado?: boolean;
  /**
   * EXECUÇÃO T4.2-HYBRID_ENTRY (candidata congelada). Presente = a confirmação
   * NÃO libera operação direto: o setup fica CONFIRMED aguardando o reteste na
   * zona do E2, e quem decide fill/expiração/bloqueio é o MESMO motor
   * (t42FillEngine) usado pelo quantBacktest e pelo pregão — nunca uma cópia.
   *
   * `candlesFechadosAposE2`: somente candles com fechamento PROVADO, em ordem,
   * a partir do primeiro candle após o E2. O chamador (rota ou pregão) acumula
   * do livro-razão; o tracker não conta candle aberto por construção.
   */
  t42?: {
    /** OHLC PROVADO do candle E2 (o da confirmação). Null = sem prova → a
     *  execução T4.2 não arma e o setup expira com E2_OPEN_OR_UNKNOWN. */
    e2: OhlcLike | null;
    candlesFechadosAposE2: readonly OhlcLike[];
    obstaculo: number | null;
  } | null;
  /**
   * Frescor da captura (@/lib/capture/frameFreshness). Só `FRESH` move a
   * máquina; o resto devolve o setup intacto e pausa a T4.
   */
  freshness?: { captureStatus: CaptureStatus; reason: string } | null;
  /**
   * Portão de estabilidade do viewport (@/lib/vision/viewportChange). Enquanto
   * não liberar, os níveis são PRESERVADOS e a confirmação fica suspensa.
   */
  viewport?: { liberaConfirmacao: boolean; motivo: string | null; changed: boolean } | null;
  /**
   * Observação do candle FECHADO deste print. Ausente, é derivada da etiqueta
   * de preço do próprio print — que, capturada logo após a virada do minuto, é
   * o fechamento do candle anterior.
   */
  candle?: CandleObservation | null;
  /**
   * POR QUE NÃO HÁ OBSERVAÇÃO DE CANDLE, quando não há.
   *
   * Vem do livro-razão (@/lib/print/candleLedger `LedgerStep.reason`), para que
   * a tela mostre o motivo REAL — candle em formação, relógio do gráfico
   * ilegível, buraco na série — em vez de uma frase genérica montada aqui. Duas
   * redações para o mesmo fato é como o painel passa a contradizer o log.
   */
  candleReason?: string | null;
  /** Ativo, para o rompimento usar o tick real em vez de uma fração genérica. */
  symbol?: string | null;
  /**
   * §7 — GRÁFICO CORTADO (@/lib/vision/viewportChange `detectClipping`).
   *
   * Quando o preço estoura o enquadramento, a máxima/mínima estrutural fica
   * FORA da imagem. Stop, alvo e R:R calculados nesse estado são invenção
   * sobre o que não foi visto — e por isso o risco vira NÃO AVALIÁVEL, nunca
   * "aprovado com o que sobrou".
   */
  clipping?: { clipped: boolean; reason: string } | null;
}

/**
 * Um passo da máquina: o print novo atualiza (ou cria, ou mata) o setup.
 *
 * PURA: recebe o setup anterior e a análise validada do print atual, devolve
 * o próximo estado com a instrução. Todos os caminhos têm motivo dito.
 */
export function advanceSetup(
  previous: TrackedSetup | null,
  analysis: PrintAnalysis,
  now: number,
  nextSequence: number,
  context: AdvanceContext = {},
): SetupUpdate {
  /*
   * §3–§4 — FRAME QUE NÃO É NOVO NÃO MOVE NADA.
   *
   * Vem PRIMEIRO, antes de expiração, invalidação e nascimento. Dez capturas
   * idênticas produziam dez passos: dez chances de "evoluir" o estágio, marcar
   * toque e reescrever gatilho sobre um gráfico que não se mexeu. O setup volta
   * IDÊNTICO — nem `printsSeen` sobe, porque contar print repetido como print
   * visto é a mesma mentira em outra casa decimal.
   */
  const frescor = context.freshness ?? null;
  if (frescor !== null && frescor.captureStatus !== "FRESH") {
    return {
      setup: previous,
      headline: PAUSA_LABEL,
      preAlert: false,
      distancePoints: null,
      distancePercent: null,
      event: frescor.captureStatus === "DUPLICATE" ? "DUPLICATE_FRAME" : frescor.captureStatus,
      entradaConfirmada: false,
      operacaoLiberada: false,
      pendencias: [`captura ${frescor.captureStatus}: ${frescor.reason}`],
      avisos: [PAUSA_LABEL],
      frameBloqueado: true,
    };
  }

  const price =
    analysis.currentPrice.visible && analysis.currentPrice.value !== null
      ? analysis.currentPrice.value
      : null;

  /* ---------- Setup vivo: continuar, confirmar, invalidar ou expirar ---------- */
  if (previous !== null && !isTerminal(previous.stage)) {
    // §20 — expiração primeiro: oportunidade velha não fica pendurada.
    if (now - previous.createdAt > SETUP_TTL_MS && previous.stage !== "CONFIRMED") {
      return terminal(previous, "EXPIRED", now, {
        reason: "expirou sem ativação",
        headline: `SETUP ${previous.setupId} EXPIRADO — sem ativação no prazo`,
        pendencia: "setup expirou sem ativação",
      });
    }

    // Invalidação estrutural: o print atual nega o setup.
    const invalidado =
      analysis.status === "T4_INVALIDADA" ||
      (analysis.direction !== "NEUTRO" && analysis.direction !== previous.direction);
    if (invalidado) {
      return terminal(previous, "INVALIDATED", now, {
        reason:
          analysis.status === "T4_INVALIDADA"
            ? "estrutura perdeu validade no print atual"
            : `direção virou ${analysis.direction} — estrutura contrária`,
        headline: `SETUP ${previous.setupId} INVALIDADO`,
        pendencia: "estrutura invalidada",
      });
    }

    /*
     * O CONFIRMADO PRECISA DE PRAZO — sem ele a máquina TRAVAVA.
     *
     * Três coisas se combinavam: o TTL do §20 isenta CONFIRMED de propósito,
     * a invalidação exige direção OPOSTA (e NEUTRO, que é exatamente o que o
     * veto de direção do auditor grava, está isento), e nada em produção
     * atribuía CLOSED. Resultado: depois da PRIMEIRA entrada confirmada do
     * dia, todo print seguinte caía no ramo abaixo devolvendo
     * `entradaConfirmada: true` para sempre — e, como o estágio nunca ficava
     * terminal, NENHUM setup novo nascia pelo resto do pregão.
     *
     * O prazo é o mesmo que o SERVIDOR usa para julgar o desfecho
     * (SETUP_OUTCOME_TTL_MS): vencido ele, quem decide WIN/LOSS é o banco, não
     * esta tela. Reusar a constante evita dois relógios divergentes para o
     * mesmo conceito.
     */
    if (
      previous.stage === "CONFIRMED" &&
      previous.confirmedAt !== null &&
      now - previous.confirmedAt > SETUP_OUTCOME_TTL_MS
    ) {
      return terminal(previous, "CLOSED", now, {
        reason: "prazo de desfecho vencido — o resultado é julgado pelo servidor",
        headline: `SETUP ${previous.setupId} ENCERRADO — desfecho fora desta tela`,
        pendencia: "setup encerrado — o desfecho foi julgado pelo servidor",
      });
    }

    /*
     * T4.2 AGUARDANDO RETESTE: o veredito de cada passo vem do MOTOR congelado
     * — este arquivo não conta TTL, não mede zona, não decide fill. O chamador
     * entrega os candles FECHADOS pós-E2 (livro-razão); candle aberto não
     * existe para o motor por construção.
     */
    if (
      previous.stage === "CONFIRMED" &&
      previous.t42 != null &&
      previous.t42.fillPrice === null &&
      previous.operationReleased === false
    ) {
      const candlesFechados = context.t42?.candlesFechadosAposE2 ?? [];
      const veredito = executeHybridEntry({
        e2: previous.t42.e2,
        direction: previous.direction,
        stopEstrutural: previous.stop ?? Number.NaN,
        obstaculo: context.t42?.obstaculo ?? null,
        candlesFechadosAposE2: candlesFechados,
      });
      if (veredito.status === "AGUARDANDO_RETESTE") {
        return {
          setup: { ...previous, printsSeen: previous.printsSeen + 1, updatedAt: now },
          headline: `T4.2 AGUARDANDO RETESTE ${previous.setupId} — candle ${veredito.candlesVistos}/${veredito.ttl}`,
          preAlert: false,
          distancePoints: null,
          distancePercent: null,
          event: null,
          entradaConfirmada: true,
          operacaoLiberada: false,
          pendencias: [
            `T4.2: zona ${veredito.zone.zoneLow}..${veredito.zone.zoneHigh}, ${veredito.candlesVistos}/${veredito.ttl} candles fechados sem toque`,
          ],
          avisos: [],
          frameBloqueado: false,
        };
      }
      if (veredito.status === "EXPIRED_NO_FILL") {
        return terminal(previous, "EXPIRED", now, {
          reason: `EXPIRED_NO_FILL: ${veredito.reason}`,
          headline: `SETUP ${previous.setupId} EXPIROU SEM FILL — T4.2 não persegue preço`,
          pendencia: "EXPIRED_NO_FILL — sem toque na zona dentro do TTL",
        });
      }
      if (veredito.status === "BLOCKED") {
        return {
          setup: {
            ...previous,
            stage: "RISK_REJECTED",
            updatedAt: now,
            reason: `${veredito.code}: ${veredito.reason}`,
            operationReleased: false,
          },
          headline: `T4.2 BLOQUEADA NO FILL — ${veredito.code}`,
          preAlert: false,
          distancePoints: null,
          distancePercent: null,
          event: "RISK_REJECTED",
          entradaConfirmada: false,
          operacaoLiberada: false,
          pendencias: [`${veredito.code}: ${veredito.reason}`],
          avisos: [],
          frameBloqueado: false,
        };
      }
      // FILLED — a operação nasce NO PREÇO DO FILL, re-aprovada pelo gate da casa.
      const risco = assessTradeRisk({
        side: previous.direction,
        entry: veredito.fill.fillPrice,
        stop: previous.stop,
        target: veredito.plan.target3R,
      });
      const liberada = riscoAprovado(risco);
      return {
        setup: {
          ...previous,
          entryLevel: veredito.fill.fillPrice,
          target: veredito.plan.target3R,
          risk: risco,
          operationReleased: liberada,
          updatedAt: now,
          reason: liberada
            ? `T4.2 FILL no candle ${veredito.fill.fillCandle} @ ${veredito.fill.fillPrice} — gates reaprovados no preço real`
            : `T4.2 fill @ ${veredito.fill.fillPrice} reprovado no gate de risco`,
          t42: {
            ...previous.t42,
            fillPrice: veredito.fill.fillPrice,
            fillCandle: veredito.fill.fillCandle,
          },
        },
        headline: liberada
          ? `T4.2 PREENCHIDA @ ${veredito.fill.fillPrice} — OPERAÇÃO LIBERADA — ${previous.direction}`
          : `T4.2 FILL REPROVADO NO RISCO — ${previous.direction}`,
        preAlert: false,
        distancePoints: null,
        distancePercent: null,
        event: liberada ? "T42_FILLED" : "RISK_REJECTED",
        entradaConfirmada: liberada,
        operacaoLiberada: liberada,
        pendencias: liberada ? [] : [risco.problems[0] ?? "risco reprovado no fill"],
        avisos: [],
        frameBloqueado: false,
      };
    }

    // Confirmado: acompanhar até encerrar — e NUNCA gerar segunda entrada (§19).
    if (previous.stage === "CONFIRMED") {
      return {
        setup: { ...previous, printsSeen: previous.printsSeen + 1, updatedAt: now },
        headline: `ENTRADA ATIVA ${previous.setupId} — acompanhando (sem novas entradas neste setup)`,
        preAlert: false,
        distancePoints: null,
        distancePercent: null,
        event: null,
        // Já confirmada num passo anterior: a operação está viva, e o print
        // permanece congelado até este setup encerrar.
        entradaConfirmada: true,
        operacaoLiberada: previous.operationReleased,
        pendencias: [],
        avisos: [],
        frameBloqueado: false,
      };
    }

    // Continuação: mesmo setup, estágio pode evoluir.
    return continueSetup(previous, analysis, price, now, context);
  }

  /* ---------- Sem setup vivo: nasce um? ---------- */
  // §19 — cooldown pós-confirmação: o mesmo movimento não vira setup de novo já.
  if (
    previous !== null &&
    (previous.stage === "CONFIRMED" || previous.stage === "CLOSED") &&
    previous.confirmedAt !== null &&
    now - previous.confirmedAt < CONFIRM_COOLDOWN_MS
  ) {
    return {
      setup: previous,
      headline: "COOLDOWN pós-entrada — sem novos setups por enquanto",
      preAlert: false,
      distancePoints: null,
      distancePercent: null,
      event: null,
      entradaConfirmada: false,
      operacaoLiberada: false,
      pendencias: ["cooldown pós-entrada em curso"],
      avisos: [],
      frameBloqueado: false,
    };
  }

  /*
   * §2 — ROMPIMENTO FALHO EXIGE NOVA ESTRUTURA.
   *
   * Depois de BREAKOUT_FAILED, o mesmo status de print que já estava na tela
   * NÃO faz nascer outro setup: seria o rearme automático que o §2 proíbe. É
   * preciso uma estrutura nova — na prática, um status que volte a subir a
   * escada depois de o print ter deixado de sustentar o setup falho.
   */
  if (
    previous !== null &&
    previous.stage === "BREAKOUT_FAILED" &&
    analysis.direction === previous.direction &&
    mesmoGatilho(previous, analysis)
  ) {
    return {
      setup: previous,
      headline: `${FALSE_BREAKOUT_UI[0]} — nova tentativa exige nova estrutura`,
      preAlert: false,
      distancePoints: null,
      distancePercent: null,
      event: null,
      entradaConfirmada: false,
      operacaoLiberada: false,
      pendencias: [
        previous.breakout?.failureReason ?? "rompimento falhou",
        "aguardando estrutura nova para rearmar o gatilho",
      ],
      avisos: [...FALSE_BREAKOUT_UI],
      frameBloqueado: false,
    };
  }

  const stage = STATUS_TO_STAGE[analysis.status] ?? null;
  const temLado = analysis.direction === "COMPRA" || analysis.direction === "VENDA";
  if (stage === null || !temLado) {
    return {
      setup: null,
      headline:
        analysis.status === "SEM_T4" || analysis.status === "INCONCLUSIVO"
          ? "SEM SETUP — monitorando"
          : "OBSERVANDO — sem lado definido ainda",
      preAlert: false,
      distancePoints: null,
      distancePercent: null,
      event: null,
      entradaConfirmada: false,
      operacaoLiberada: false,
      pendencias: ["nenhum setup em curso"],
      avisos: [],
      frameBloqueado: false,
    };
  }

  const ladoNovo = analysis.direction as "COMPRA" | "VENDA";
  const { level, zone } = entryLevelOf(analysis, ladoNovo);
  const gatilho = triggerOf(analysis, ladoNovo, level);
  const novo: TrackedSetup = {
    setupId: makeSetupId(now, nextSequence),
    // Nascer direto CONFIRMED exige as mesmas provas do toque e da
    // sustentação — sem elas, entra aguardando rompimento.
    stage: stage === "CONFIRMED" ? "WAITING_BREAKOUT" : stage,
    direction: ladoNovo,
    entryLevel: level,
    entryZone: zone,
    stop: stopOf(analysis, ladoNovo),
    target: targetOf(analysis, ladoNovo),
    createdAt: now,
    updatedAt: now,
    // Zero de propósito: o passo de continuação logo abaixo soma o print
    // atual — nascer com 1 contaria o mesmo print duas vezes.
    printsSeen: 0,
    touched: false,
    confirmedAt: null,
    reason: `nasceu de ${analysis.status}`,
    trigger: gatilho,
    triggerVersion: gatilho === null ? 0 : 1,
    triggerHistory:
      gatilho === null
        ? []
        : [
            {
              version: 1,
              level: gatilho,
              at: now,
              reason: `gatilho inicial de ${analysis.status}`,
            },
          ],
    breakout:
      gatilho === null
        ? null
        : initBreakout({
            side: ladoNovo,
            trigger: gatilho,
            symbol: context.symbol ?? analysis.symbol,
          }),
    risk: null,
    operationReleased: false,
  };
  const passo = continueSetup(novo, analysis, price, now, context);
  return { ...passo, event: passo.event ?? `NOVO SETUP ${novo.setupId}` };
}

function isTerminal(stage: SetupStage): boolean {
  return (
    stage === "CLOSED" ||
    stage === "INVALIDATED" ||
    stage === "EXPIRED" ||
    stage === "BREAKOUT_FAILED"
  );
}

/** O gatilho lido neste print é o mesmo que já estava em vigor? */
function mesmoGatilho(setup: TrackedSetup, analysis: PrintAnalysis): boolean {
  if (setup.trigger === null) return false;
  const { level } = entryLevelOf(analysis, setup.direction);
  const lido = triggerOf(analysis, setup.direction, level);
  if (lido === null) return true; // nada novo foi lido: o gatilho continua o mesmo
  return Math.abs(lido - setup.trigger) <= breakoutTolerance(setup.trigger, analysis.symbol);
}

/** Saída terminal, com a forma completa do update — um lugar só, sem repetição. */
function terminal(
  previous: TrackedSetup,
  stage: Extract<SetupStage, "EXPIRED" | "INVALIDATED" | "CLOSED">,
  now: number,
  texto: { reason: string; headline: string; pendencia: string },
): SetupUpdate {
  return {
    setup: { ...previous, stage, updatedAt: now, reason: texto.reason, operationReleased: false },
    headline: texto.headline,
    preAlert: false,
    distancePoints: null,
    distancePercent: null,
    event: stage,
    entradaConfirmada: false,
    operacaoLiberada: false,
    pendencias: [texto.pendencia],
    avisos: [],
    frameBloqueado: false,
  };
}

/**
 * CONGELAMENTO DO PRINT (§7) — decisão PURA, fora do React.
 *
 * Mora aqui, e não na rota, porque é regra do ciclo de vida do setup e
 * precisa ser testável sem navegador: os itens 6 e 7 do teste de aceite do
 * operador ("confirmação real congela o print", "novo setup libera novo
 * ciclo") viravam inspeção visual enquanto isto era um `if` dentro de um
 * callback de React.
 *
 * Devolve o índice do print que deve ficar na tela, ou null para acompanhar o
 * mais recente. Congela SÓ na confirmação; solta quando a oportunidade vira
 * outra (setup novo, invalidação, expiração, rompimento falho ou fim do setup).
 */
export function decidirCongelamento(args: {
  /** Índice congelado hoje, ou null. */
  congeladoEm: number | null;
  /** Índice que o print recém-analisado ocupa na sessão. */
  novoIndice: number;
  passo: SetupUpdate;
  nasceuSetup: boolean;
}): number | null {
  const { congeladoEm, novoIndice, passo, nasceuSetup } = args;
  if (passo.entradaConfirmada && passo.event === "CONFIRMED") return novoIndice;
  if (congeladoEm === null) return null;
  /*
   * FRAME BLOQUEADO NÃO SOLTA A TELA (§3).
   *
   * Um frame duplicado devolve `setup` intacto e `event: DUPLICATE_FRAME` — sem
   * esta guarda, a checagem de "oportunidade acabou" leria a ausência de evento
   * de confirmação como fim do setup e descongelaria o print da entrada por
   * causa de um pixel repetido.
   */
  if (passo.frameBloqueado) return congeladoEm;
  const oportunidadeAcabou =
    nasceuSetup ||
    passo.setup === null ||
    passo.event === "INVALIDATED" ||
    passo.event === "EXPIRED" ||
    passo.event === "BREAKOUT_FAILED" ||
    // CLOSED fechava o setup sem soltar a tela: o print da entrada ficava
    // congelado para sempre sobre uma operação que já teve desfecho.
    passo.event === "CLOSED";
  return oportunidadeAcabou ? null : congeladoEm;
}

/** O passo comum: distância, pré-alerta, toque e a decisão de confirmação. */
function continueSetup(
  setup: TrackedSetup,
  analysis: PrintAnalysis,
  price: number | null,
  now: number,
  context: AdvanceContext,
): SetupUpdate {
  const stageFromStatus = STATUS_TO_STAGE[analysis.status] ?? setup.stage;
  const viewport = context.viewport ?? null;
  const viewportSuspenso = viewport !== null && !viewport.liberaConfirmacao;

  /*
   * §6 — VIEWPORT ALTERADO NÃO SOBRESCREVE NÍVEL.
   *
   * Com escala ou janela trocadas, a leitura do print descreve outra régua: os
   * "novos" números do modelo não são correção do nível, são o MESMO nível
   * medido em outro sistema de coordenadas. Preservar é o único movimento
   * honesto até o frame estabilizar.
   */
  const { level, zone } = viewportSuspenso
    ? { level: null, zone: null }
    : entryLevelOf(analysis, setup.direction);
  const entryLevel = level ?? setup.entryLevel;
  const entryZone = zone ?? setup.entryZone;
  const stop = (viewportSuspenso ? null : stopOf(analysis, setup.direction)) ?? setup.stop;
  const target = (viewportSuspenso ? null : targetOf(analysis, setup.direction)) ?? setup.target;

  /* ---------- §9: o gatilho, versionado ---------- */
  const gatilhoLido = viewportSuspenso
    ? null
    : triggerOf(analysis, setup.direction, level ?? setup.entryLevel);
  let trigger = setup.trigger;
  let triggerVersion = setup.triggerVersion;
  let triggerHistory = setup.triggerHistory;
  let gatilhoMudou = false;
  if (gatilhoLido !== null) {
    const tolerancia = breakoutTolerance(gatilhoLido, context.symbol ?? analysis.symbol);
    if (trigger === null || Math.abs(gatilhoLido - trigger) > tolerancia) {
      gatilhoMudou = trigger !== null;
      trigger = gatilhoLido;
      triggerVersion += 1;
      triggerHistory = [
        ...triggerHistory,
        {
          version: triggerVersion,
          level: gatilhoLido,
          at: now,
          reason: gatilhoMudou
            ? `estrutura moveu o gatilho para ${gatilhoLido}`
            : `gatilho identificado em ${gatilhoLido}`,
        },
      ].slice(-12);
    }
  }

  /* ---------- §1–§2: o rompimento e a sustentação ---------- */
  let breakout: BreakoutState | null = setup.breakout;
  if (trigger !== null) {
    const precisaReiniciar =
      breakout === null ||
      breakout.side !== setup.direction ||
      Math.abs(breakout.trigger - trigger) > breakout.tolerance;
    const vivo: BreakoutState = precisaReiniciar
      ? initBreakout({
          side: setup.direction,
          trigger,
          symbol: context.symbol ?? analysis.symbol,
        })
      : breakout!;
    breakout = vivo;
    /*
     * A OBSERVAÇÃO DO CANDLE FECHADO — E O FALLBACK QUE FOI REMOVIDO DAQUI.
     *
     * Até 20/08/2026 este trecho fabricava a observação quando o chamador não
     * fornecia uma:
     *
     *     context.candle ?? (price !== null
     *       ? { close: price, candleTime: minuteStart(now), at: now }
     *       : null)
     *
     * A justificativa era que a captura acontece logo após a virada do minuto,
     * então a etiqueta de preço seria o fechamento do candle que acabou. A
     * sessão real de 20/08 mediu as duas metades dessa frase e derrubou as duas:
     *
     *   • a etiqueta é o preço CORRENTE do candle em FORMAÇÃO — em 55 de 56
     *     prints legíveis o `Fch` do cabeçalho era idêntico a ela, e o elo
     *     076→077 (`Fch 170.960` → `Abr 170.965`) provou negócio depois da
     *     captura;
     *   • `minuteStart(now)` usa o relógio do NAVEGADOR, que estava ~2 min à
     *     frente do relógio de dentro da imagem: 15 de 82 transições erradas,
     *     7 capturas no mesmo minuto de mercado e 8 candles sem captura.
     *
     * Somadas, as duas produziam o pior caso possível: como `observeClose`
     * ignora reobservação do mesmo `candleTime`, valia a PRIMEIRA leitura do
     * minuto — e numa captura em `:00` a primeira leitura é a ABERTURA do
     * candle novo. A abertura entrava na máquina como se fosse fechamento.
     *
     * Agora a observação só vem de quem PODE prová-la (@/lib/print/candleLedger,
     * via `context.candle`). Sem ela a máquina de rompimento não anda — e isso
     * é o comportamento correto, não uma regressão: não se afirma sustentação
     * sobre um candle que ainda está aberto.
     */
    const obs: CandleObservation | null = context.candle ?? null;
    if (obs !== null && !isTerminalBreakout(vivo.phase)) {
      breakout = observeClose(vivo, obs);
    }
  }

  let distancePoints: number | null = null;
  let distancePercent: number | null = null;
  if (price !== null && entryLevel !== null) {
    distancePoints = Number(Math.abs(price - entryLevel).toFixed(1));
    distancePercent = Number(((Math.abs(price - entryLevel) / price) * 100).toFixed(3));
  }

  // Toque: preço dentro da zona, ou distância ~zero na linha.
  const tocouAgora =
    price !== null &&
    (entryZone !== null
      ? price >= entryZone.min && price <= entryZone.max
      : entryLevel !== null && Math.abs(price - entryLevel) <= Math.max(1, price * TOUCH_FRACTION));
  const touched = setup.touched || tocouAgora;

  // Pré-alerta §6: perto da linha, mas ainda sem tocar.
  const stopDistance = stop !== null && entryLevel !== null ? Math.abs(entryLevel - stop) : null;
  const preAlertLimit =
    stopDistance !== null
      ? stopDistance * PRE_ALERT_STOP_FRACTION
      : price !== null
        ? price * PRE_ALERT_PRICE_FRACTION
        : null;
  const preAlert =
    !tocouAgora &&
    distancePoints !== null &&
    preAlertLimit !== null &&
    distancePoints <= preAlertLimit;

  /*
   * A ESCADA DE APROXIMAÇÃO, calculada UMA vez.
   *
   * Os três pontos abaixo que precisam de um estágio pré-rompimento usam
   * este mesmo valor. Recalcular em cada um seria abrir espaço para o card
   * dizer APPROACHING enquanto o banco grava WAITING_BREAKOUT.
   */
  const degrauDeAproximacao = estagioDeAproximacao({
    touched,
    distancePoints,
    preAlertLimit,
  });
  const base = {
    ...setup,
    entryLevel,
    entryZone,
    stop,
    target,
    touched,
    trigger,
    triggerVersion,
    triggerHistory,
    breakout,
    printsSeen: setup.printsSeen + 1,
    updatedAt: now,
  };

  /* ---------- §2: FALSE_BREAKOUT — antes de qualquer confirmação ---------- */
  if (breakout !== null && breakout.phase === "BREAKOUT_FAILED") {
    const motivo = breakout.failureReason ?? "rompimento devolvido";
    return {
      setup: {
        ...base,
        stage: "BREAKOUT_FAILED",
        reason: motivo,
        risk: null,
        operationReleased: false,
      },
      headline: `${FALSE_BREAKOUT_UI[0]} — ${motivo}`,
      preAlert: false,
      distancePoints,
      distancePercent,
      event: "BREAKOUT_FAILED",
      entradaConfirmada: false,
      operacaoLiberada: false,
      pendencias: [motivo, "nova tentativa exige nova estrutura/setup"],
      avisos: [...FALSE_BREAKOUT_UI],
      frameBloqueado: false,
    };
  }

  /*
   * A CONFIRMAÇÃO — §7 por extenso, julgada pela regra ÚNICA da casa
   * (`evaluateEntryProof`, em @/lib/vision/printAnalysis). Toque sozinho
   * NUNCA basta: entrada/stop/alvo numéricos, coerentes e com R:R ≥ 1,5,
   * candle de confirmação FECHADO neste print, status do modelo, auditor não
   * reprovado, confianças reportadas e leitura visual suficiente.
   *
   * Os NÍVEIS vêm do SETUP, não do print: o mesmo setup atravessa capturas, e
   * a entrada lida três prints atrás continua sendo um número que o operador
   * vê na tela. A prova do GATILHO, essa sim, tem de estar no print atual.
   */
  const prova = evaluateEntryProof({
    bias: setup.direction,
    entry: entryLevel,
    stop,
    target,
    status: analysis.status,
    audit: analysis.audit,
    confidences: analysis.confidences,
    confidence: analysis.confidence,
    closedConfirmationCandle: hasClosedConfirmationCandle(analysis),
    ...(context.exigirCandleFechado === undefined
      ? {}
      : { exigirCandleFechado: context.exigirCandleFechado }),
  });

  /* ---------- §11: o gate de risco, como estado próprio ---------- */
  /*
   * §7 — GRÁFICO CORTADO NÃO PRODUZ R:R.
   *
   * Com o enquadramento estourado, o topo/fundo estrutural está fora da
   * imagem: não há de onde tirar stop e alvo estruturais. Passar os níveis
   * lidos assim mesmo produziria um R:R plausível calculado sobre a metade do
   * gráfico que sobrou — o número mais perigoso da tela, porque parece medida.
   *
   * A entrada do gate vira `null`, que ele já trata como NÃO AVALIÁVEL: o
   * veredito sai RISK_UNKNOWN, com a razão dita, e RISK_UNKNOWN nunca aprova.
   */
  const cortado = context.clipping?.clipped === true;
  const risco = cortado
    ? assessTradeRisk({ side: setup.direction, entry: entryLevel, stop: null, target: null })
    : assessTradeRisk({ side: setup.direction, entry: entryLevel, stop, target });

  /*
   * §1 — A SUSTENTAÇÃO É PERNA OBRIGATÓRIA quando existe gatilho legível.
   *
   * Sem gatilho não existe afirmação de rompimento a sustentar, e a
   * confirmação recai sobre as provas do §7 como sempre foi (é o caminho da
   * imagem colada, sem plano nem entrada legível). Com gatilho, um fechamento
   * solitário além dele NÃO passa daqui.
   */
  const pendenciasRompimento = pendenciasDoRompimento(breakout);
  const rompimentoOk = breakout === null || breakout.setupConfirmed;
  const pendenciasViewport = viewportSuspenso ? [viewport!.motivo ?? "viewport alterado"] : [];
  // O corte vem PRIMEIRO na lista: é o que explica todos os "NÃO IDENTIFICADO"
  // que aparecem abaixo dele, e sem ele o operador leria a ausência de stop e
  // alvo como falha de leitura em vez de gráfico fora do enquadramento.
  const pendenciasCorte = cortado
    ? [context.clipping?.reason ?? "gráfico cortado no enquadramento"]
    : [];
  /*
   * A TRAVA DO CANDLE, DITA NA TELA.
   *
   * Sem observação de candle fechado a máquina de rompimento não andou — e uma
   * máquina parada precisa dizer por que parou. Sem esta linha o operador vê a
   * mesma tela de "aguardando" tanto quando o mercado não fez nada quanto
   * quando o sistema não conseguiu provar o fechamento, e as duas situações
   * pedem coisas opostas dele.
   */
  const pendenciaDoCandle =
    context.candle == null
      ? [
          context.candleReason ??
            "sem fechamento de candle provado — a confirmação espera a virada do candle",
        ]
      : [];
  const todasPendencias = [
    ...pendenciasCorte,
    ...pendenciaDoCandle,
    ...pendenciasViewport,
    ...pendenciasRompimento,
    ...prova.pendencias,
  ];

  if (touched && analysis.status === "ENTRADA_CONFIRMADA") {
    /*
     * §7 — GRÁFICO CORTADO NÃO CONFIRMA, e não é só o risco que cai.
     *
     * Com o enquadramento estourado falta a estrutura inteira do lado cortado:
     * topo, máxima, resistência seguinte, espaço até o alvo. Deixar o setup
     * CONFIRMAR e apenas não liberar a operação diria ao operador que a
     * técnica se completou — quando o que aconteceu é que metade da evidência
     * ficou fora da imagem.
     */
    if (!prova.entradaConfirmada || !rompimentoOk || viewportSuspenso || cortado) {
      /*
       * RISK_REJECTED é ESTADO, não pendência solta (§10–§11).
       *
       * Quando tudo o mais está provado — rompimento sustentado, viewport
       * estável, toque, candle, auditor, confianças — e o que resta é a
       * relação risco/retorno, o operador precisa ler "a operação foi
       * recusada pelo risco", não uma lista genérica de faltas.
       */
      const somenteRisco =
        rompimentoOk &&
        !viewportSuspenso &&
        // Gráfico cortado não é "recusa do risco": é falta de evidência. O
        // rótulo tem de mandar o operador olhar o enquadramento, não descartar
        // a operação por relação risco/retorno.
        !cortado &&
        risco.verdict !== "RISK_APPROVED" &&
        prova.pendencias.every((p) => risco.problems.includes(p));
      const estagio: SetupStage = somenteRisco
        ? "RISK_REJECTED"
        : (estagioDoRompimento(breakout) ?? degrauDeAproximacao);
      const motivo = todasPendencias[0] ?? "prova de entrada incompleta";
      return {
        setup: {
          ...base,
          stage: estagio,
          reason: todasPendencias.join("; "),
          risk: risco,
          operationReleased: false,
        },
        headline: cortado
          ? `${CLIPPED_LABEL} — AGUARDAR`
          : somenteRisco
            ? `OPERAÇÃO RECUSADA PELO RISCO — ${motivo}`
            : `ENTRADA BLOQUEADA — ${motivo} — AGUARDAR`,
        preAlert,
        distancePoints,
        distancePercent,
        event: cortado ? "VIEWPORT_CLIPPED" : somenteRisco ? "RISK_REJECTED" : "BLOQUEADO_NO_GATE",
        entradaConfirmada: false,
        operacaoLiberada: false,
        pendencias: todasPendencias,
        /*
         * O CORTE VEM PRIMEIRO NO TOPO DA TELA — antes do risco.
         *
         * Quando o gráfico está cortado, "OPERAÇÃO BLOQUEADA" sozinho manda o
         * operador procurar o que falta no setup; o que falta, na verdade, é
         * a IMAGEM. Dizer o nome do estado é o que faz ele rolar o gráfico em
         * vez de esperar uma confirmação que nenhum print daquele
         * enquadramento pode dar.
         */
        avisos: cortado
          ? [CLIPPED_LABEL, "SEM TOPO ESTRUTURAL — ALVO E STOP NÃO CALCULÁVEIS"]
          : somenteRisco
            ? ["ENTRADA NÃO CONFIRMADA", "OPERAÇÃO BLOQUEADA"]
            : [],
        frameBloqueado: false,
      };
    }
    /*
     * OPERATION_RELEASED. `entradaConfirmada` e `operacaoLiberada` saem do
     * mesmo lugar de propósito: a prova de entrada já consulta o gate de
     * risco, e dois cálculos independentes para a mesma permissão são o
     * caminho conhecido para a tela se contradizer.
     */
    /*
     * EXECUÇÃO T4.2 ATIVA: a confirmação técnica NÃO vira operação aqui. O
     * setup entra em CONFIRMED aguardando o reteste na zona do E2; fill,
     * expiração e bloqueio saem do motor congelado no follow-up (ramo
     * previous.stage === "CONFIRMED"). Liberar já seria executar no
     * rompimento — exatamente o que a candidata existe para não fazer.
     */
    if (context.t42) {
      if (context.t42.e2 === null) {
        return terminal(
          { ...base, stage: "CONFIRMED", confirmedAt: now, risk: risco },
          "EXPIRED",
          now,
          {
            reason:
              "E2_OPEN_OR_UNKNOWN: confirmação sem OHLC provado do candle E2 — a zona T4.2 não pode existir",
            headline: `SETUP ${setup.setupId} EXPIRADO — sem OHLC do E2 para a zona T4.2`,
            pendencia: "sem OHLC provado do E2 — execução T4.2 impossível",
          },
        );
      }
      return {
        setup: {
          ...base,
          stage: "CONFIRMED",
          confirmedAt: now,
          reason: "T4 confirmada — execução T4.2: aguardando reteste na zona do E2",
          risk: risco,
          operationReleased: false,
          // O E2 chegou com OHLC completo do livro-razão — fechamento provado.
          provaFechamento: "PROVADA",
          t42: {
            e2: {
              o: context.t42.e2.o,
              h: context.t42.e2.h,
              l: context.t42.e2.l,
              c: context.t42.e2.c,
            },
            fillPrice: null,
            fillCandle: null,
          },
        },
        headline: `T4 CONFIRMADA — T4.2 AGUARDANDO RETESTE — ${setup.direction}`,
        preAlert: false,
        distancePoints,
        distancePercent,
        event: "CONFIRMED",
        entradaConfirmada: true,
        operacaoLiberada: false,
        pendencias: ["T4.2: aguardando o preço voltar à zona do E2 (até 3 candles fechados)"],
        avisos: [],
        frameBloqueado: false,
      };
    }
    const liberada = riscoAprovado(risco);
    return {
      setup: {
        ...base,
        stage: "CONFIRMED",
        confirmedAt: now,
        reason: `toque + rompimento sustentado + candle de confirmação + gates aprovados`,
        risk: risco,
        operationReleased: liberada,
        // Chegou aqui porque a máquina de rompimento provou candle FECHADO
        // além do gatilho + sustentação — o rastro registra a técnica completa.
        provaFechamento: "PROVADA",
      },
      headline: `T4 CONFIRMADA — ENTRADA LIBERADA — ${setup.direction}`,
      preAlert: false,
      distancePoints,
      distancePercent,
      event: "CONFIRMED",
      entradaConfirmada: true,
      operacaoLiberada: liberada,
      pendencias: [],
      avisos: [],
      frameBloqueado: false,
    };
  }

  /*
   * ENTRADA NO TOQUE — desligável, declarada, e só com o risco aprovado.
   *
   * O QUE ESTE RAMO FAZ. Por padrão, tocar a entrada NÃO confirma: o preço
   * encosta no gatilho e a técnica espera o candle fechar além dele (o ramo
   * abaixo, TOQUE_SEM_CONFIRMACAO). Com `exigirCandleFechado: false`, o toque
   * confirma na hora — decisão explícita do dono da técnica.
   *
   * POR QUE ELE EXISTE, medido: na leitura de VÍDEO o portão de cima nunca
   * abre, porque exige `status === "ENTRADA_CONFIRMADA"` vindo do leitor
   * visual, e o leitor não consegue provar fechamento na resolução da
   * gravação (40 descartes de "máxima não legível" em 68 prints). Resultado:
   * 8 toques a 6–53 pontos do gatilho, ZERO confirmações — bloqueio por falta
   * de PROVA, não por falta de setup.
   *
   * O QUE NÃO É DISPENSADO: o gate de risco. Níveis completos e R:R ≥ 3
   * continuam obrigatórios — foi o piso que o operador escolheu, e entrar no
   * toque já abre mão de uma evidência; abrir mão de duas seria outra técnica.
   * E o aviso viaja no resultado: estatística de entrada-no-toque não vale
   * como estatística da T4 com fechamento provado.
   */
  if (tocouAgora && context.exigirCandleFechado === false && riscoAprovado(risco)) {
    return {
      setup: {
        ...base,
        stage: "CONFIRMED",
        reason: "entrada no toque — prova de fechamento dispensada por configuração",
        risk: risco,
        confirmedAt: now,
        operationReleased: true,
        // O rastro MÁQUINA-LEGÍVEL do bypass: o aviso abaixo é prosa para a
        // tela; este campo é o que a homologação filtra por padrão.
        provaFechamento: "DISPENSADA",
      },
      headline: `T4 CONFIRMADA NO TOQUE — ${setup.direction}`,
      preAlert: false,
      distancePoints,
      distancePercent,
      event: "CONFIRMED",
      entradaConfirmada: true,
      operacaoLiberada: true,
      pendencias: [],
      avisos: ["ENTRADA NO TOQUE: confirmada sem candle fechado — prova de fechamento dispensada"],
      frameBloqueado: false,
    };
  }

  if (tocouAgora) {
    return {
      setup: {
        ...base,
        stage: estagioDoRompimento(breakout) ?? degrauDeAproximacao,
        reason: "tocou a entrada sem confirmação neste print",
        risk: risco,
        operationReleased: false,
      },
      headline: "TOQUE SEM CONFIRMAÇÃO — AGUARDAR",
      preAlert: false,
      distancePoints,
      distancePercent,
      event: "TOQUE_SEM_CONFIRMACAO",
      entradaConfirmada: false,
      operacaoLiberada: false,
      // Mesmo motivo do retorno final: nunca bloquear em silêncio. Aqui a
      // lista só viria vazia se o ramo acima mudasse — e o invariante não
      // pode depender de acoplamento não declarado com o outro arquivo.
      pendencias:
        todasPendencias.length > 0
          ? todasPendencias
          : ["o print não confirma a entrada neste candle"],
      avisos: [],
      frameBloqueado: false,
    };
  }

  /*
   * O ESTÁGIO É O PONTO MAIS AVANÇADO REALMENTE PROVADO.
   *
   * O rompimento manda quando já disse alguma coisa (fechou, está retestando);
   * fora isso vale a escada do status do print. Um status ENTRADA_CONFIRMADA
   * sem toque NÃO vira CONFIRMED aqui — sem toque não existe entrada.
   */
  /*
   * A ESCADA REFINA O "AGUARDANDO ROMPIMENTO", e SÓ ele.
   *
   * `stageFromStatus` diz o que o modelo viu da ESTRUTURA (detectada, em
   * formação, aproximando); a escada diz onde o PREÇO está em relação ao
   * gatilho. São eixos independentes, e pegar o mais avançado dos dois seria
   * a combinação errada: um setup ainda EM FORMAÇÃO cujo preço passa perto
   * não está armado — falta a estrutura, não a distância. Prometer ARMED ali
   * seria a tela anunciando uma prontidão que o plano não tem.
   *
   * Então a escada só entra onde o próprio print já disse "estou esperando o
   * rompimento" — é exatamente esse estado, e nenhum outro, que era grosso
   * demais para o operador: valia igual para o preço a 800 pontos do gatilho
   * e para o preço encostando nele.
   */
  const doStatus = stageFromStatus === "CONFIRMED" ? "WAITING_BREAKOUT" : stageFromStatus;
  const stage =
    estagioDoRompimento(breakout) ??
    (doStatus === "WAITING_BREAKOUT" ? degrauDeAproximacao : doStatus);
  const mudouEstagio = stage !== setup.stage;
  return {
    setup: {
      ...base,
      stage,
      reason: gatilhoMudou
        ? `gatilho atualizado para ${trigger} (v${triggerVersion})`
        : mudouEstagio
          ? `evoluiu para ${stage}`
          : setup.reason,
      risk: risco,
      operationReleased: false,
    },
    headline: preAlert
      ? `T4 PRÓXIMA — PREPARAR (${distancePoints} pts do gatilho)`
      : `${stage} — ${setup.setupId}`,
    preAlert,
    distancePoints,
    distancePercent,
    event: gatilhoMudou ? "GATILHO_ATUALIZADO" : mudouEstagio ? stage : null,
    // Sem toque não existe entrada: aqui é sempre viés em evolução.
    entradaConfirmada: false,
    operacaoLiberada: false,
    /*
     * `prova` julga só o PRINT — ela não sabe do toque. Com um print de prova
     * completa e o preço ainda longe da linha roxa, a lista vinha VAZIA e a
     * caixa "FALTA PARA CONFIRMAR" sumia da tela: bloqueio sem motivo dito,
     * que é exatamente o que esta casa não faz. O toque é a pendência aqui.
     */
    pendencias:
      todasPendencias.length > 0
        ? todasPendencias
        : ["preço ainda não tocou o gatilho neste print"],
    avisos: [],
    frameBloqueado: false,
  };
}

/** A fase do rompimento traduzida em estágio da máquina única (§10). */
/**
 * O degrau de APROXIMAÇÃO, quando o rompimento ainda não começou.
 *
 * PURA e derivada de coisas já medidas — distância até o gatilho, faixa de
 * pré-alerta e o toque —, e não de um estado novo guardado em paralelo. É o
 * que garante que a escada não possa discordar da distância mostrada no card.
 *
 * NENHUM DESTES DEGRAUS LIBERA OPERAÇÃO. Eles respondem "quão perto", e a
 * liberação continua exigindo fechamento além do gatilho, sustentação e risco
 * aprovado. Um setup ARMED com o candle ainda em formação segue sem entrada.
 */
export function estagioDeAproximacao(input: {
  touched: boolean;
  distancePoints: number | null;
  preAlertLimit: number | null;
}): SetupStage {
  // Tocou o gatilho: está ARMADO. O que falta agora é o candle FECHAR além.
  if (input.touched) return "ARMED";
  if (input.distancePoints === null || input.preAlertLimit === null) return "WAITING_BREAKOUT";
  if (input.distancePoints <= input.preAlertLimit) return "APPROACHING";
  if (input.distancePoints <= input.preAlertLimit * WATCH_BAND_MULTIPLE) return "PRE_ALERT";
  return "WAITING_BREAKOUT";
}
function estagioDoRompimento(breakout: BreakoutState | null): SetupStage | null {
  if (breakout === null) return null;
  switch (breakout.phase) {
    case "BREAKOUT_FAILED":
      return "BREAKOUT_FAILED";
    case "BREAKOUT_CLOSED":
      return "BREAKOUT_CLOSED";
    case "WAITING_SUSTAIN":
      return "WAITING_SUSTAIN";
    case "CONFIRMED":
      // O rompimento se sustentou; o que falta (auditor, confiança, risco) é
      // julgado fora daqui. O estágio fica no último degrau técnico provado.
      return "WAITING_SUSTAIN";
    case "WAITING_BREAKOUT":
      return null;
  }
}
