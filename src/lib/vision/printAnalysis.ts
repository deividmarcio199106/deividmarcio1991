/**
 * ANÁLISE DE PRINT — o contrato entre o modelo visual e a tela.
 *
 * Este módulo existe para uma regra só: **a IA não desenha, ela DESCREVE**. O
 * modelo devolve dados estruturados e validados; quem desenha é o front, sobre
 * a imagem original, usando coordenadas normalizadas. Texto livre nunca vira
 * traço na tela.
 *
 * POR QUE ISSO IMPORTA AQUI MAIS QUE EM OUTROS LUGARES
 * Um modelo multimodal olhando um gráfico é confiante e criativo na mesma
 * proporção. Ele preenche número ilegível com um valor plausível, inventa um
 * ativo quando o título está cortado e arredonda preço que não conseguiu ler.
 * Qualquer um desses vira, na tela do operador, um nível de entrada indistinguível
 * de um que foi realmente lido.
 *
 * As três defesas, nesta ordem:
 *
 *   1. AUSÊNCIA É UM VALOR. Todo número carrega `visible`. Não legível não é
 *      zero, não é null silencioso: é "NÃO LEGÍVEL NO PRINT", dito na tela.
 *   2. COORDENADA É GEOMETRIA, NÃO PREÇO. As marcações vivem em 0–1 sobre a
 *      imagem. Elas não dependem da escala de preço nem do tamanho da tela, e
 *      por isso não podem "deslocar" o gráfico.
 *   3. O BACKEND VALIDA. Status fora do enum, coordenada fora de [0,1], campo
 *      obrigatório ausente: a análise é recusada, não corrigida por chute.
 */

import * as z from "zod";

import {
  DNA_GRADES,
  DNA_LOCATIONS,
  DNA_POSITIONS,
  DNA_PULLBACKS,
  DNA_TRENDS,
  DNA_TRIGGERS,
  DNA_VOLATILITIES,
} from "@/lib/t4/dna";
import { assessTradeRisk, riscoAprovado, type RiskAssessment } from "@/lib/t4/riskGate";
import { normalizeDate } from "./chartClock";
import { normalizePriceUnit } from "./priceUnit";

/** Estados possíveis do diagnóstico. Nunca há um "provavelmente". */
export const PRINT_STATUS = [
  "SEM_T4",
  "T4_EM_FORMACAO",
  "APROXIMACAO_T4",
  "PRE_ENTRADA",
  "ENTRADA_CONFIRMADA",
  "T4_INVALIDADA",
  "INCONCLUSIVO",
] as const;
export type PrintStatus = (typeof PRINT_STATUS)[number];

export const PRINT_STATUS_LABEL: Record<PrintStatus, string> = {
  SEM_T4: "SEM T4",
  T4_EM_FORMACAO: "T4 EM FORMAÇÃO",
  APROXIMACAO_T4: "APROXIMAÇÃO T4",
  PRE_ENTRADA: "PRÉ-ENTRADA",
  ENTRADA_CONFIRMADA: "ENTRADA CONFIRMADA",
  T4_INVALIDADA: "T4 INVALIDADA",
  INCONCLUSIVO: "INCONCLUSIVO",
};

/** O que o operador deve fazer com cada estado — dito sem ambiguidade. */
export const PRINT_STATUS_MEANING: Record<PrintStatus, string> = {
  SEM_T4: "Não existe configuração suficiente neste print.",
  T4_EM_FORMACAO: "Há elementos da técnica, ainda sem confirmação.",
  APROXIMACAO_T4: "Preço se aproximando de uma região relevante.",
  PRE_ENTRADA: "Quase todos os critérios presentes. Ainda não é entrada.",
  ENTRADA_CONFIRMADA: "Critérios obrigatórios atendidos no print enviado.",
  T4_INVALIDADA: "A estrutura perdeu validade.",
  INCONCLUSIVO: "Imagem insuficiente ou ilegível para afirmar qualquer coisa.",
};

export const NAO_LEGIVEL = "NÃO LEGÍVEL NO PRINT" as const;
export const NAO_IDENTIFICADO = "NÃO IDENTIFICADO" as const;

/**
 * Um número lido do gráfico.
 *
 * `visible: false` é uma AFIRMAÇÃO — "olhei e não consegui ler" —, e não a
 * ausência de resposta. É o que impede o modelo de completar por aproximação
 * silenciosa, que é o modo de falha mais caro aqui.
 */
export const ReadNumber = z.object({
  value: z.number().finite().nullable(),
  visible: z.boolean(),
});
export type ReadNumber = z.infer<typeof ReadNumber>;

/** Tipos de marcação que o front sabe desenhar. Nada fora desta lista vira traço. */
export const ANNOTATION_KINDS = [
  "ENTRY_LINE",
  "ENTRY_ZONE",
  "STOP",
  "TARGET",
  "INVALIDATION",
  "SUPPORT",
  "RESISTANCE",
  // Zonas institucionais da leitura completa (mockup do operador, 19/08):
  // oferta (venda) em vermelho, demanda (compra) em verde, atenção tracejada.
  "SUPPLY_ZONE",
  "DEMAND_ZONE",
  "ATTENTION_ZONE",
  "BREAKOUT",
  "PULLBACK",
  "T4_PAST",
  "SCENARIO_ARROW",
  /**
   * O CANDLE QUE CONFIRMOU — marcado exatamente onde fechou (§7 do operador).
   *
   * Só existe em análise cuja entrada passou na trava determinística: a
   * validação REMOVE esta marcação quando rebaixa o status, porque uma seta de
   * confirmação sobre um setup não confirmado é a mentira mais cara da tela.
   */
  "CONFIRMATION_CANDLE",
  "NOTE",
] as const;
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

/**
 * COORDENADAS NORMALIZADAS, 0 a 1, sobre a imagem enviada.
 *
 * Não são pixels: o navegador redimensiona, o operador dá zoom, o mobile mostra
 * outra largura. Em fração da imagem, a marcação continua sobre o mesmo candle
 * em qualquer tela — que é o requisito de o overlay não deslocar o gráfico.
 */
export const Annotation = z.object({
  kind: z.enum(ANNOTATION_KINDS),
  x1: z.number().min(0).max(1),
  y1: z.number().min(0).max(1),
  /** Ausentes numa marcação pontual (uma linha horizontal, uma nota). */
  x2: z.number().min(0).max(1).nullable().default(null),
  y2: z.number().min(0).max(1).nullable().default(null),
  label: z.string().max(60),
  /** Numeração das ocorrências passadas: T4 #1, T4 #2… */
  index: z.number().int().min(1).nullable().default(null),
  /** Por que esta marcação existe. Aparece ao clicar. */
  reason: z.string().max(400).default(""),
});
export type Annotation = z.infer<typeof Annotation>;

/** Um critério da técnica, atendido ou não, com o motivo. */
export const Criterion = z.object({
  id: z.string().max(40),
  label: z.string().max(80),
  met: z.boolean(),
  detail: z.string().max(300).default(""),
});
export type Criterion = z.infer<typeof Criterion>;

/**
 * PRÓXIMO PRINT — a análise diz QUANDO vale enviar outra captura.
 *
 * Sem isto, o operador fica entre dois erros: mandar print a cada candle (ruído
 * e custo de GPU para reconfirmar o já sabido) ou esquecer de mandar quando a
 * estrutura muda (e perder o momento que a análise anterior estava esperando).
 * O gatilho transforma "COMPRA/VENDA/AGUARDAR" em uma instrução operacional:
 * o que observar no gráfico, e só voltar quando ISSO acontecer.
 */
export const TRIGGER_TYPES = [
  "SUPPORT_BREAK",
  "RESISTANCE_BREAK",
  "SUPPORT_RETEST",
  "RESISTANCE_RETEST",
  "CANDLE_CONFIRMATION",
  "T4_APPROACH",
  "T4_PRE_ENTRY",
  "T4_CONFIRMATION",
  "STRUCTURE_INVALIDATION",
  "PULLBACK",
  "FALSE_BREAKOUT",
  "TARGET_APPROACH",
  "STOP_APPROACH",
  "NEW_STRUCTURE",
  "WAIT_CANDLE_CLOSE",
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

/** Emoji por gatilho — o vocabulário visual do card e do overlay. */
export const TRIGGER_EMOJI: Record<TriggerType, string> = {
  SUPPORT_BREAK: "🔴",
  RESISTANCE_BREAK: "🟢",
  SUPPORT_RETEST: "🔵",
  RESISTANCE_RETEST: "🔵",
  CANDLE_CONFIRMATION: "🟡",
  T4_APPROACH: "🟡",
  T4_PRE_ENTRY: "🟢",
  T4_CONFIRMATION: "🟢",
  STRUCTURE_INVALIDATION: "⚠️",
  PULLBACK: "🔵",
  FALSE_BREAKOUT: "⚠️",
  TARGET_APPROACH: "🟢",
  STOP_APPROACH: "🔴",
  NEW_STRUCTURE: "🟡",
  WAIT_CANDLE_CLOSE: "🟡",
};

export const NextTrigger = z.object({
  type: z.enum(TRIGGER_TYPES),
  label: z.string().max(90),
  /** Nível associado — SÓ quando legível no print. Nunca inventado. */
  level: ReadNumber.nullable().default(null),
  priority: z.enum(["HIGH", "MEDIUM", "LOW"]).default("MEDIUM"),
  /** Onde observar, em coordenadas normalizadas. Opcional: nem todo gatilho tem lugar. */
  x: z.number().min(0).max(1).nullable().default(null),
  y: z.number().min(0).max(1).nullable().default(null),
});
export type NextTrigger = z.infer<typeof NextTrigger>;

export const NEXT_STATUS = [
  "NAO_PRECISA",
  "AGUARDAR_FECHAMENTO",
  "ENVIAR_NO_GATILHO",
  "ENVIAR_AGORA",
] as const;
export type NextStatus = (typeof NEXT_STATUS)[number];

export const NEXT_STATUS_LABEL: Record<NextStatus, string> = {
  NAO_PRECISA: "AGORA: NÃO PRECISA",
  AGUARDAR_FECHAMENTO: "AGUARDAR FECHAMENTO DO CANDLE",
  ENVIAR_NO_GATILHO: "ENVIAR NO PRÓXIMO GATILHO",
  ENVIAR_AGORA: "ENVIAR AGORA",
};

/**
 * PLANO CONDICIONAL — a instrução operacional em forma de SE → ENTÃO.
 *
 * O que o operador precisa ler numa linha: "se o preço fechar acima de X, é
 * COMPRA; entrada em Y, stop em Z, alvo em W; invalida se voltar abaixo de V".
 * É condicional POR CONSTRUÇÃO — o gatilho ainda não aconteceu, e por isso
 * nada aqui é sinal de entrada: é o que observar para que vire um.
 */
/**
 * NÍVEIS DE PREÇO DA LEITURA COMPLETA — o modelo devolve PREÇOS, nunca pixels.
 *
 * É a linguagem visual que o operador pediu (mockup 19/08): zonas de oferta/
 * demanda com faixa rotulada, suportes/resistências, topos/fundos nomeados e
 * perda estrutural. A régua da escala converte cada preço em altura; pedir o
 * pixel ao modelo devolveria o alongamento sistemático de sempre.
 */
export const PRICE_LEVEL_KINDS = [
  "SUPORTE",
  "RESISTENCIA",
  "ZONA_VENDA",
  "ZONA_COMPRA",
  "ZONA_ATENCAO",
  "TOPO",
  "FUNDO",
  "PERDA_ESTRUTURAL",
] as const;
export type PriceLevelKind = (typeof PRICE_LEVEL_KINDS)[number];

export const PriceLevel = z.object({
  kind: z.enum(PRICE_LEVEL_KINDS),
  /** Nome curto na tela: "Topo institucional", "Fundo anterior"… */
  label: z.string().max(80),
  priceMin: ReadNumber,
  /** Null = nível único (linha). Presente e legível = faixa (banda). */
  priceMax: ReadNumber.nullable().default(null),
});
export type PriceLevel = z.infer<typeof PriceLevel>;

export const ConditionalPlan = z.object({
  /** O que precisa acontecer, em uma frase. Ex.: "fechamento acima do topo". */
  trigger: z.string().max(160),
  /** O nível do gatilho. SÓ quando legível — sem ele não existe plano. */
  triggerLevel: ReadNumber,
  /** Para que lado o gatilho aponta. */
  side: z.enum(["COMPRA", "VENDA"]),
  entry: ReadNumber,
  entryZone: z.object({ min: ReadNumber, max: ReadNumber }).nullable().default(null),
  stop: ReadNumber,
  targets: z.array(ReadNumber).max(3).default([]),
  /** O que mata o plano — a condição que o invalida antes de acionar. */
  invalidation: z.string().max(200).default(""),
  /** Por que este gatilho e não outro. */
  rationale: z.string().max(300).default(""),
});
export type ConditionalPlan = z.infer<typeof ConditionalPlan>;

export const NextScreenshot = z.object({
  requiredNow: z.boolean(),
  status: z.enum(NEXT_STATUS),
  instruction: z.string().max(300).default(""),
  preferredTiming: z.enum(["AFTER_CANDLE_CLOSE", "IMMEDIATE", "ANY"]).default("ANY"),
  triggers: z.array(NextTrigger).max(8).default([]),
});
export type NextScreenshot = z.infer<typeof NextScreenshot>;

/**
 * DNA DO SETUP VISTO NO PRINT — as MESMAS listas fechadas de @/lib/t4/dna.
 *
 * Os enums são importados, nunca copiados: o vocabulário DNA é único em toda a
 * cadeia (motor, print, banco), e uma lista duplicada aqui divergiria da
 * original em silêncio. Grade "C" é legítima num print — é a leitura parcial
 * que o motor não emite, mas o vocabulário comum permite.
 *
 * Dimensões com NAO_IDENTIFICADO no vocabulário usam esse valor como default:
 * o que a imagem não sustenta é dito como não identificado, nunca preenchido
 * com a classe mais plausível.
 */
export const PrintDna = z.object({
  grade: z.enum([...DNA_GRADES]),
  trend: z.enum([...DNA_TRENDS]),
  position: z.enum([...DNA_POSITIONS]),
  pullback: z.enum([...DNA_PULLBACKS]).default("NAO_IDENTIFICADO"),
  triggerCandle: z.enum([...DNA_TRIGGERS]).default("NAO_IDENTIFICADO"),
  /** Sem base visual para comparar amplitudes, a volatilidade é null — não "NORMAL". */
  volatility: z
    .enum([...DNA_VOLATILITIES])
    .nullable()
    .default(null),
  location: z.enum([...DNA_LOCATIONS]).default("NAO_IDENTIFICADO"),
  /** 1ª–3ª T4 do movimento; 4 = posterior. Null quando não dá para contar no print. */
  movementOrdinal: z
    .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
    .nullable()
    .default(null),
});
export type PrintDna = z.infer<typeof PrintDna>;

export const PrintAnalysis = z.object({
  status: z.enum(PRINT_STATUS),
  direction: z.enum(["COMPRA", "VENDA", "NEUTRO"]),
  /**
   * Confiança da LEITURA VISUAL, 0–100.
   *
   * Não é probabilidade de acerto da operação, e a UI é obrigada a dizer isso.
   * Mede o quanto a imagem sustentou a análise: nitidez, escala visível,
   * quantidade de candles, critérios identificáveis.
   */
  confidence: z.number().min(0).max(100),
  /*
   * AUSENTE E NULL SIGNIFICAM A MESMA COISA AQUI: "não identifiquei o ativo".
   *
   * Sem o `.default(null)` estes eram os dois ÚNICOS campos do contrato que
   * exigiam PRESENÇA física — e uma resposta boa, com toda a leitura correta,
   * era recusada inteira porque o modelo não escreveu `"symbol": null`. Isso
   * não protegia de alucinação nenhuma: o que protege é `visible`/null, que
   * continua valendo. Exigir a chave só transformava omissão em falha total.
   */
  symbol: z.string().max(20).nullable().default(null),
  timeframe: z.string().max(20).nullable().default(null),

  /** Etiqueta de preço ATUAL no eixo (a caixinha do último preço). É a
   * observação que fecha vereditos de previsões anteriores — só quando legível. */
  currentPrice: ReadNumber.default({ value: null, visible: false }),

  /**
   * RELÓGIO LIDO DENTRO DA IMAGEM — a identidade do candle nasce aqui.
   *
   * Default tolerante ({date:null,time:null}) de propósito: análise antiga
   * reaberta do histórico, ou provedor que ignorou o campo, não pode ser
   * recusada inteira. Ausente significa "não sei que candle é este", e quem
   * consome trata isso parando, nunca chutando `Date.now()`.
   */
  chartClock: z
    .object({
      date: z.string().max(20).nullable().default(null),
      time: z.string().max(10).nullable().default(null),
    })
    .default({ date: null, time: null }),

  /**
   * O ÚLTIMO CANDLE QUE FECHOU, lido do desenho — nunca do cabeçalho.
   *
   * É a única fonte de fechamento PROVADO (ver candleLedger). `null` bloqueia
   * confirmação de entrada, e esse é o comportamento correto: em 55 de 56
   * prints legíveis da sessão de 20/08 o cabeçalho do Profit mostrava o candle
   * em formação, e tratar aquilo como fechamento é o defeito que este campo
   * encerra.
   */
  lastClosedCandle: z
    .object({
      time: z.string().max(10).nullable().default(null),
      open: ReadNumber.default({ value: null, visible: false }),
      high: ReadNumber.default({ value: null, visible: false }),
      low: ReadNumber.default({ value: null, visible: false }),
      close: ReadNumber.default({ value: null, visible: false }),
    })
    .nullable()
    .default(null),

  entry: ReadNumber,
  entryZone: z.object({ min: ReadNumber, max: ReadNumber }).nullable().default(null),
  stop: ReadNumber,
  targets: z.array(ReadNumber).max(4).default([]),
  invalidation: z.string().max(300).default(""),

  criteria: z.array(Criterion).max(20).default([]),
  annotations: z.array(Annotation).max(40).default([]),

  /** Cenários CONDICIONAIS. Nunca afirmam que o preço vai seguir. */
  scenarios: z.array(z.string().max(300)).max(6).default([]),
  /** Ocorrências anteriores da técnica visíveis no MESMO print. */
  pastOccurrences: z.number().int().min(0).max(20).default(0),

  explanation: z.string().max(1500).default(""),
  missingCriteria: z.array(z.string().max(200)).max(20).default([]),
  /** Problemas da imagem que limitaram a leitura. */
  imageIssues: z.array(z.string().max(200)).max(10).default([]),

  /** Quando enviar a próxima captura. Null quando o modelo não avaliou. */
  nextScreenshot: NextScreenshot.nullable().default(null),

  /**
   * O PLANO CONDICIONAL — "SE romper X, é compra". Até 2.
   *
   * Esta é a resposta que faltava: sem entrada confirmada AGORA, o operador
   * ficava com "NÃO LEGÍVEL" e nenhuma instrução, sem saber o que observar.
   * O plano não afirma que o preço VAI a lugar nenhum — ele declara o gatilho
   * que, se acontecer, define lado, entrada, stop e alvo.
   *
   * Continua valendo a lei da casa: todo nível é `ReadNumber`. Um plano cujo
   * gatilho ou stop não é legível no print não é plano — é palpite, e o
   * validador o descarta dizendo por quê.
   */
  conditionalPlans: z.array(ConditionalPlan).max(2).default([]),

  /** Zonas e níveis lidos como PREÇO — a régua desenha, o modelo não estima pixel. */
  priceLevels: z.array(PriceLevel).max(12).default([]),

  /**
   * CONFIANÇAS POR CAMADA (§12) — separadas de propósito: confiança de
   * CONTEXTO alta com confiança de ENTRADA baixa significa AGUARDAR, e um
   * número único esconderia exatamente essa diferença.
   */
  confidences: z
    .object({
      contexto: z.number().min(0).max(100),
      estrutura: z.number().min(0).max(100),
      t4: z.number().min(0).max(100),
      entrada: z.number().min(0).max(100),
    })
    .nullable()
    .default(null),

  /**
   * AUDITORIA INDEPENDENTE (§11) — preenchida pelo SERVIDOR após a validação,
   * por uma segunda passada de modelo que tenta REPROVAR a análise. Reprovado
   * ⇒ a ação vira AGUARDAR na tela, não importa o status. Null = auditor não
   * rodou (falha de IA não derruba a análise — ela fica sem o carimbo).
   */
  audit: z
    .object({
      approved: z.boolean(),
      issues: z.array(z.string().max(200)).max(10).default([]),
      checkedAt: z.number(),
      /**
       * O auditor viu a estrutura CONTRADIZER a direção afirmada (ex.: COMPRA
       * com topos e fundos descendentes).
       *
       * É um campo próprio, e não um texto para interpretar, porque a
       * consequência é dura: a direção é BLOQUEADA na origem. Ler isso de
       * prosa livre ("parece que talvez a estrutura…") devolveria ao sistema
       * exatamente a interpretação de texto que o contrato existe para evitar.
       */
      directionContradicted: z.boolean().default(false),
    })
    .nullable()
    .default(null),

  /** DNA do setup lido. Null quando a imagem não sustentou classificar — e aí nada persiste. */
  dna: PrintDna.nullable().default(null),
});
export type PrintAnalysis = z.infer<typeof PrintAnalysis>;

export interface ValidationResult {
  ok: boolean;
  analysis: PrintAnalysis | null;
  /** Por que foi recusada. Nunca vazio quando `ok` é falso. */
  problem: string | null;
  /** Ajustes feitos para tornar a resposta utilizável, se houve. */
  repairs: string[];
}

/**
 * Valida a resposta do modelo.
 *
 * O que este validador NÃO faz: consertar valores. Coordenada fora da imagem
 * não é aproximada para a borda, número sem `visible` não vira legível. Reparo
 * aqui seria a alucinação entrando pela porta dos fundos — e o operador não teria
 * como distinguir o que foi lido do que foi remendado.
 *
 * O único reparo permitido é DESCARTAR o que não é utilizável, e dizer que
 * descartou.
 */
export function validatePrintAnalysis(raw: unknown): ValidationResult {
  const parsed = PrintAnalysis.safeParse(raw);
  if (!parsed.success) {
    const primeiro = parsed.error.issues[0];
    return {
      ok: false,
      analysis: null,
      problem: primeiro
        ? `Resposta da IA fora do contrato em "${primeiro.path.join(".")}": ${primeiro.message}`
        : "Resposta da IA fora do contrato.",
      repairs: [],
    };
  }

  const analysis = parsed.data;
  const repairs: string[] = [];

  /*
   * COERÊNCIA ENTRE STATUS E NÍVEIS.
   *
   * Um status de ENTRADA_CONFIRMADA sem entrada nem stop legíveis é uma
   * contradição: a técnica não pode ter confirmado sobre números que ninguém
   * conseguiu ler. Rebaixamos o status em vez de publicar a contradição.
   */
  const temNiveis = analysis.entry.visible && analysis.stop.visible;
  if (
    (analysis.status === "ENTRADA_CONFIRMADA" || analysis.status === "PRE_ENTRADA") &&
    !temNiveis
  ) {
    analysis.status = "T4_EM_FORMACAO";
    repairs.push("Status rebaixado: entrada/stop não legíveis no print não sustentam confirmação.");
  }

  /*
   * COERÊNCIA DO DNA — reparo DECLARADO, nunca conserto silencioso.
   *
   * O DNA persiste no banco e vira estatística: uma grade "A" num print cujo
   * status nega o setup (SEM_T4, T4_INVALIDADA, INCONCLUSIVO) contaminaria a
   * base com um setup que, pela própria análise, não existe. A grade vira
   * DESCARTADA e o ajuste é dito. Mesma lei para trend CONTRA: pelo vocabulário
   * (positionFor em @/lib/t4/dna), setup contra a tendência instalada opera
   * CONTRA_TENDENCIA — as duas dimensões não podem se contradizer no banco.
   */
  if (analysis.dna) {
    const statusNegaSetup =
      analysis.status === "SEM_T4" ||
      analysis.status === "T4_INVALIDADA" ||
      analysis.status === "INCONCLUSIVO";
    if (statusNegaSetup && analysis.dna.grade !== "DESCARTADA") {
      repairs.push(
        `DNA: grade ${analysis.dna.grade} rebaixada para DESCARTADA — status ${analysis.status} nega o setup.`,
      );
      analysis.dna.grade = "DESCARTADA";
    }
    if (analysis.dna.trend === "CONTRA" && analysis.dna.position !== "CONTRA_TENDENCIA") {
      repairs.push(
        "DNA: position alinhada para CONTRA_TENDENCIA — trend CONTRA a implica por definição.",
      );
      analysis.dna.position = "CONTRA_TENDENCIA";
    }
  }

  /*
   * TIMEFRAME NÃO VEM DO RELÓGIO DO CANDLE.
   *
   * O Profit exibe no canto inferior direito um contador REGRESSIVO do candle
   * atual ("35s", "03s"), e em teste real o modelo o leu como timeframe.
   * Timeframe de verdade vem do cabeçalho e tem outra forma ("1Min", "5Min",
   * "Diário") — um valor de 1–2 dígitos seguido de "s" é o contador, e
   * contador não identifica periodicidade: descarta-se, dizendo por quê.
   */
  if (analysis.timeframe !== null && /^\d{1,2}\s*s$/i.test(analysis.timeframe.trim())) {
    repairs.push(
      `Timeframe "${analysis.timeframe}" descartado: tem cara de contador regressivo do candle, não de timeframe.`,
    );
    analysis.timeframe = null;
  }

  /*
   * NÚMERO INVISÍVEL NÃO CARREGA VALOR.
   *
   * O modelo às vezes marca `visible: false` e ainda assim devolve um número —
   * que é exatamente o palpite que não pode chegar à tela.
   */
  const limpar = (n: ReadNumber, nome: string): ReadNumber => {
    if (!n.visible && n.value !== null) {
      repairs.push(`${nome}: valor descartado porque não estava legível no print.`);
      return { value: null, visible: false };
    }
    if (n.visible && n.value === null) {
      repairs.push(`${nome}: marcado como legível sem número — tratado como não legível.`);
      return { value: null, visible: false };
    }
    return n;
  };

  /*
   * A UNIDADE VEM ANTES DE TUDO QUE COMPARA PREÇO.
   *
   * Roda aqui, no limite do contrato, e não em cada consumidor: um preço na
   * notação de milhar da tela (`170,68` em vez de `170.680`) atravessava a
   * validação inteira e só era descoberto lá na frente — quando descoberto.
   * Ver `normalizePriceUnit` para a evidência de produção de 20/08.
   *
   * Precisa vir antes de `limpar` e do resto porque tudo abaixo compara
   * números entre si: entrada contra stop, stop contra alvo, nível contra
   * preço atual. Comparar duas unidades diferentes dá um resultado plausível
   * e errado, que é o pior tipo.
   */
  const emPontos = (n: ReadNumber, nome: string): ReadNumber => {
    if (n.value === null) return n;
    const { value, repair } = normalizePriceUnit(n.value, analysis.symbol, nome);
    if (repair !== null) repairs.push(repair);
    return value === n.value ? n : { ...n, value };
  };

  analysis.currentPrice = emPontos(analysis.currentPrice, "Preço atual");
  analysis.entry = emPontos(analysis.entry, "Entrada");
  analysis.stop = emPontos(analysis.stop, "Stop");
  analysis.targets = analysis.targets.map((t, i) => emPontos(t, `Alvo ${i + 1}`));
  if (analysis.entryZone) {
    analysis.entryZone = {
      min: emPontos(analysis.entryZone.min, "Zona (mínimo)"),
      max: emPontos(analysis.entryZone.max, "Zona (máximo)"),
    };
  }
  analysis.priceLevels = analysis.priceLevels.map((nivel, i) => ({
    ...nivel,
    priceMin: emPontos(nivel.priceMin, `Nível ${i + 1} (mín)`),
    priceMax: nivel.priceMax === null ? null : emPontos(nivel.priceMax, `Nível ${i + 1} (máx)`),
  }));
  analysis.conditionalPlans = analysis.conditionalPlans.map((plano, i) => ({
    ...plano,
    triggerLevel: emPontos(plano.triggerLevel, `Gatilho do plano ${i + 1}`),
  }));
  if (analysis.lastClosedCandle !== null) {
    analysis.lastClosedCandle = {
      ...analysis.lastClosedCandle,
      open: emPontos(analysis.lastClosedCandle.open, "Candle fechado (abertura)"),
      high: emPontos(analysis.lastClosedCandle.high, "Candle fechado (máxima)"),
      low: emPontos(analysis.lastClosedCandle.low, "Candle fechado (mínima)"),
      close: emPontos(analysis.lastClosedCandle.close, "Candle fechado (fechamento)"),
    };
  }

  analysis.currentPrice = limpar(analysis.currentPrice, "Preço atual");

  /*
   * O RELÓGIO DO GRÁFICO SÓ VALE NA FORMA HH:MM.
   *
   * Qualquer outra coisa ali é o modelo tendo lido outro número da tela — o
   * contador regressivo do candle, um preço, o número da conta. Um horário
   * errado não atrasa a análise: ele carimba o candle ERRADO, e todo o resto
   * (fechamento, sustentação, histórico) passa a falar de outro minuto.
   */
  if (
    analysis.chartClock.time !== null &&
    !/^\d{1,2}:\d{2}$/.test(analysis.chartClock.time.trim())
  ) {
    repairs.push(
      `Relógio do gráfico "${analysis.chartClock.time}" descartado: não tem forma de horário (HH:MM).`,
    );
    analysis.chartClock = { ...analysis.chartClock, time: null };
  }

  /*
   * A DATA DO GRÁFICO PRECISA DA MESMA CONFERÊNCIA — E ELA FALTOU.
   *
   * DEFEITO EM PRODUÇÃO, 20/08/2026 14:58: a tela mostrou "Invalid time value"
   * e nenhuma análise concluía. O prompt pede AAAA-MM-DD; a barra de abas do
   * Profit escreve "20/08/2026", e é isso que o modelo devolve — pedir ISO no
   * texto não impede. Rio abaixo, `MarketClock` fazia
   * `"20/08/2026".split("-").map(Number)` → `[NaN]` → `setFullYear(NaN)` →
   * Invalid Date → `getTime()` NaN → `new Date(NaN).toISOString()` LANÇA, e o
   * lançamento derrubava o passo inteiro da análise.
   *
   * A correção não é rejeitar: é NORMALIZAR com o mesmo parser que já existia
   * para o relógio do gráfico (`normalizeDate`, que aceita ISO e brasileiro).
   * Rejeitar jogaria fora uma data que estava legível na imagem — e a data é o
   * que separa o pregão de hoje do de ontem no id do candle.
   */
  if (analysis.chartClock.date !== null) {
    const normalizada = normalizeDate(analysis.chartClock.date);
    if (normalizada === null) {
      repairs.push(
        `Data do gráfico "${analysis.chartClock.date}" descartada: não é uma data reconhecível.`,
      );
      analysis.chartClock = { ...analysis.chartClock, date: null };
    } else if (normalizada !== analysis.chartClock.date) {
      repairs.push(
        `Data do gráfico "${analysis.chartClock.date}" normalizada para ${normalizada}.`,
      );
      analysis.chartClock = { ...analysis.chartClock, date: normalizada };
    }
  }

  if (analysis.lastClosedCandle !== null) {
    const candle = analysis.lastClosedCandle;
    const campos = {
      open: limpar(candle.open, "Candle fechado (abertura)"),
      high: limpar(candle.high, "Candle fechado (máxima)"),
      low: limpar(candle.low, "Candle fechado (mínima)"),
      close: limpar(candle.close, "Candle fechado (fechamento)"),
    };

    /*
     * CANDLE FECHADO SEM FECHAMENTO NÃO É CANDLE FECHADO.
     *
     * Ele existe para uma única finalidade — provar onde o candle terminou.
     * Sem `close` legível, guardá-lo com abertura e máxima só daria a quem
     * consome a impressão de ter prova. Vai inteiro para null, dito.
     */
    if (campos.close.value === null) {
      repairs.push(
        "Candle fechado descartado: sem fechamento legível não há o que provar com ele.",
      );
      analysis.lastClosedCandle = null;
    } else if (
      /*
       * E O CANDLE FECHADO NÃO PODE SER O CANDLE ATUAL.
       *
       * O erro que este teste pega é o mais provável de todos: o modelo copia
       * o cabeçalho do Profit, que mostra o candle EM FORMAÇÃO. Foi assim em
       * 55 de 56 prints legíveis da sessão de 20/08. Se o horário do candle
       * "fechado" é o mesmo do relógio do gráfico, é o atual disfarçado.
       */
      candle.time !== null &&
      analysis.chartClock.time !== null &&
      candle.time.trim() === analysis.chartClock.time.trim()
    ) {
      repairs.push(
        `Candle fechado descartado: horário ${candle.time} é o mesmo do relógio do gráfico — ` +
          "é o candle EM FORMAÇÃO, não o anterior.",
      );
      analysis.lastClosedCandle = null;
    } else {
      analysis.lastClosedCandle = { ...candle, ...campos };
    }
  }

  analysis.entry = limpar(analysis.entry, "Entrada");
  analysis.stop = limpar(analysis.stop, "Stop");
  analysis.targets = analysis.targets.map((t, i) => limpar(t, `Alvo ${i + 1}`));
  if (analysis.entryZone) {
    analysis.entryZone = {
      min: limpar(analysis.entryZone.min, "Zona (mínimo)"),
      max: limpar(analysis.entryZone.max, "Zona (máximo)"),
    };
  }

  /*
   * ENTRADA SEM STOP NÃO SE PUBLICA.
   *
   * Regra da técnica: "se a condição não estiver completa: SEM ENTRADA". Uma
   * entrada legível com stop ilegível é essa condição incompleta — publicá-la
   * (visto em produção: "ENTRADA 169 / STOP NÃO LEGÍVEL NO PRINT") manda o
   * operador entrar sem saber onde a leitura é reconhecida como errada. Os
   * planos condicionais NÃO passam por aqui: eles têm esta mesma regra no
   * próprio bloco, com descarte do plano inteiro.
   */
  if (analysis.entry.visible && !analysis.stop.visible) {
    analysis.entry = { value: null, visible: false };
    if (analysis.entryZone) {
      analysis.entryZone = {
        min: { value: null, visible: false },
        max: { value: null, visible: false },
      };
    }
    repairs.push("Entrada descartada: sem stop legível não se publica entrada.");
  }

  /*
   * COERÊNCIA DO PRÓXIMO PRINT.
   *
   * "requiredNow: true" com status "NÃO PRECISA" é contradição — o operador não
   * saberia qual dos dois obedecer. O status manda, porque é ele que a tela
   * destaca; requiredNow é derivado. E o nível de um gatilho segue a mesma lei
   * de todos os números daqui: invisível não carrega valor.
   */
  if (analysis.nextScreenshot) {
    const ns = analysis.nextScreenshot;
    const coerente = ns.status === "ENVIAR_AGORA";
    if (ns.requiredNow !== coerente) {
      ns.requiredNow = coerente;
      repairs.push("nextScreenshot: requiredNow alinhado ao status.");
    }
    ns.triggers = ns.triggers.map((t) => {
      if (t.level && !t.level.visible && t.level.value !== null) {
        repairs.push(`Gatilho ${t.type}: nível descartado porque não estava legível.`);
        return { ...t, level: { value: null, visible: false } };
      }
      return t;
    });
  }

  /*
   * PLANO CONDICIONAL SÓ EXISTE COM NÍVEL LIDO.
   *
   * "Se romper, é compra" sem dizer ROMPER O QUÊ não é instrução: é a
   * aparência de uma. E um plano com gatilho legível mas stop ilegível é pior
   * ainda — manda entrar sem dizer onde o erro é reconhecido. Os dois casos
   * são DESCARTADOS com o motivo dito, nunca completados por aproximação.
   *
   * Coerência de lado também é checada: numa COMPRA o stop fica ABAIXO da
   * entrada e o alvo ACIMA. Um plano que inverte isso está errado sobre o
   * próprio lado, e publicá-lo seria mandar o operador para o lado errado.
   */
  const planosValidos: ConditionalPlan[] = [];
  for (const plano of analysis.conditionalPlans) {
    const gatilho = limpar(plano.triggerLevel, `Plano "${plano.trigger}": nível do gatilho`);
    const entrada = limpar(plano.entry, `Plano "${plano.trigger}": entrada`);
    const stop = limpar(plano.stop, `Plano "${plano.trigger}": stop`);
    const alvos = plano.targets.map((t, i) => limpar(t, `Plano "${plano.trigger}": alvo ${i + 1}`));

    if (!gatilho.visible) {
      repairs.push(
        `Plano "${plano.trigger}" descartado: o nível do gatilho não é legível no print.`,
      );
      continue;
    }
    if (!stop.visible) {
      repairs.push(`Plano "${plano.trigger}" descartado: sem stop legível não se publica entrada.`);
      continue;
    }

    const referencia = entrada.visible ? entrada.value! : gatilho.value!;
    const compra = plano.side === "COMPRA";
    if (stop.value !== null && (compra ? stop.value >= referencia : stop.value <= referencia)) {
      repairs.push(
        `Plano "${plano.trigger}" descartado: stop ${stop.value} incoerente com ${plano.side}.`,
      );
      continue;
    }
    const alvosCoerentes = alvos.filter((alvo) => {
      if (!alvo.visible || alvo.value === null) return false;
      const ok = compra ? alvo.value > referencia : alvo.value < referencia;
      if (!ok)
        repairs.push(`Plano "${plano.trigger}": alvo ${alvo.value} descartado, lado errado.`);
      return ok;
    });

    planosValidos.push({
      ...plano,
      triggerLevel: gatilho,
      entry: entrada,
      stop,
      targets: alvosCoerentes,
      entryZone: plano.entryZone
        ? {
            min: limpar(plano.entryZone.min, `Plano "${plano.trigger}": zona (mín)`),
            max: limpar(plano.entryZone.max, `Plano "${plano.trigger}": zona (máx)`),
          }
        : null,
    });
  }
  analysis.conditionalPlans = planosValidos;

  /*
   * NÍVEIS DE PREÇO: a lei do visible atravessa, e faixa invertida é
   * REPARADA DECLARADAMENTE (min↔max trocados pelo modelo acontecem; a
   * informação está certa, a ordem não — trocar em silêncio esconderia o
   * padrão de erro do modelo, que queremos ver nos repairs).
   */
  const niveisValidos: PriceLevel[] = [];
  for (const nivel of analysis.priceLevels) {
    const min = limpar(nivel.priceMin, `Nível "${nivel.label}": preço`);
    const max = nivel.priceMax ? limpar(nivel.priceMax, `Nível "${nivel.label}": teto`) : null;
    if (!min.visible || min.value === null) {
      repairs.push(`Nível "${nivel.label}" descartado: preço não legível no print.`);
      continue;
    }
    let faixaMin = min;
    let faixaMax = max !== null && max.visible && max.value !== null ? max : null;
    if (faixaMax !== null && faixaMax.value! < faixaMin.value!) {
      repairs.push(`Nível "${nivel.label}": faixa invertida (min>max) — ordem corrigida.`);
      [faixaMin, faixaMax] = [faixaMax, faixaMin];
    }
    niveisValidos.push({ ...nivel, priceMin: faixaMin, priceMax: faixaMax });
  }
  analysis.priceLevels = niveisValidos;

  /*
   * MAGNITUDE MISTA ENTRE NÍVEIS — descarte em BLOCO, nunca "correção".
   *
   * Visto em produção: entrada "169" com a escala mostrando "169.875" (que no
   * WINFUT é 169875 pontos) — o modelo truncou o separador de milhar em
   * ALGUMAS leituras e não em outras. Se a razão max/min entre os níveis
   * visíveis passa de 5, as leituras misturaram unidades (com e sem milhar) e
   * NÃO há como saber qual está certa: nem a menor, nem a maior. Multiplicar
   * por mil para "alinhar" seria consertar por adivinhação — o modo de falha
   * que este projeto mais combate. Tudo cai junto, com um único motivo dito.
   */
  const niveisVisiveis: number[] = [];
  const coletar = (n: ReadNumber): void => {
    if (n.visible && n.value !== null && n.value > 0) niveisVisiveis.push(n.value);
  };
  coletar(analysis.entry);
  coletar(analysis.stop);
  analysis.targets.forEach(coletar);
  if (analysis.entryZone) {
    coletar(analysis.entryZone.min);
    coletar(analysis.entryZone.max);
  }
  for (const plano of analysis.conditionalPlans) {
    coletar(plano.triggerLevel);
    coletar(plano.entry);
    coletar(plano.stop);
    plano.targets.forEach(coletar);
  }
  if (niveisVisiveis.length >= 2) {
    const menor = Math.min(...niveisVisiveis);
    const maior = Math.max(...niveisVisiveis);
    if (maior / menor > 5) {
      const ilegivel = (): ReadNumber => ({ value: null, visible: false });
      analysis.entry = ilegivel();
      analysis.stop = ilegivel();
      analysis.targets = analysis.targets.map(() => ilegivel());
      if (analysis.entryZone) {
        analysis.entryZone = { min: ilegivel(), max: ilegivel() };
      }
      // Todo plano sobrevivente tem gatilho e stop visíveis por construção —
      // o descarte em bloco derruba os dois, e plano sem gatilho ou sem stop
      // não é plano (a mesma regra do bloco acima): a lista esvazia.
      analysis.conditionalPlans = [];
      repairs.push(
        `Níveis descartados em bloco: magnitudes misturadas (${menor} vs ${maior}) indicam separador de milhar lido errado — nenhum número é publicável.`,
      );
      /*
       * O rebaixamento de status roda DE NOVO aqui, de propósito: a checagem
       * lá de cima viu entry/stop ainda "visíveis" e deixou o status passar.
       * Sem esta repetição, um print com 169 e 169235 saía ENTRADA_CONFIRMADA
       * com todos os níveis NÃO LEGÍVEIS — confirmação sem número é a
       * contradição que a primeira checagem existe para impedir.
       */
      if (analysis.status === "ENTRADA_CONFIRMADA" || analysis.status === "PRE_ENTRADA") {
        analysis.status = "T4_EM_FORMACAO";
        repairs.push(
          "Status rebaixado: os níveis que sustentavam a confirmação caíram no descarte de magnitude.",
        );
      }
    }
  }

  // Marcação fora da imagem não é desenhável: some, e o motivo é registrado.
  const antes = analysis.annotations.length;
  analysis.annotations = analysis.annotations.filter(
    (a) =>
      dentro(a.x1) &&
      dentro(a.y1) &&
      (a.x2 === null || dentro(a.x2)) &&
      (a.y2 === null || dentro(a.y2)),
  );
  if (analysis.annotations.length !== antes) {
    repairs.push(
      `${antes - analysis.annotations.length} marcação(ões) fora da imagem descartada(s).`,
    );
  }

  /*
   * A TRAVA DA CONFIRMAÇÃO roda por último, sobre a análise já limpa: um
   * ENTRADA_CONFIRMADA que sobreviveu às checagens pontuais ainda precisa da
   * PROVA COMPLETA (níveis, candle fechado, confianças). O modelo dizer
   * "compra confirmada" nunca basta — visto em produção: "T4 EM FORMAÇÃO —
   * COMPRA" com todos os níveis NÃO IDENTIFICADOS lido pelo operador como
   * ordem de compra.
   */
  repairs.push(...applyConfirmationGate(analysis));

  return { ok: true, analysis, problem: null, repairs };
}

function dentro(v: number): boolean {
  return Number.isFinite(v) && v >= 0 && v <= 1;
}

/* ------------------------------------------------------------------------- *
 * VIÉS ≠ ENTRADA — a decisão determinística que separa os dois.
 *
 * O defeito que este bloco encerra (visto em produção, 19/08): a tela dizia
 * "T4 EM FORMAÇÃO — COMPRA" com ENTRADA, STOP, ALVO e R:R todos NÃO
 * IDENTIFICADOS. `direction` é o VIÉS da estrutura — para onde ela pende —,
 * e o operador lia como operação liberada. A partir daqui:
 *
 *   bias              COMPRA | VENDA | NEUTRO — sempre exibível, como VIÉS;
 *   status derivado   AGUARDANDO | EM_FORMACAO | CONFIRMADA | INVALIDADA;
 *   entradaConfirmada SÓ true com a PROVA COMPLETA, verificada AQUI, em
 *                     código — nunca porque o modelo escreveu "confirmada".
 *
 * A prova exige TODOS simultaneamente: lado definido; entrada, stop e alvo
 * NUMÉRICOS; níveis coerentes com o lado; R:R ≥ 1,5; candle de confirmação
 * FECHADO identificado (rompimento só por pavio não confirma); o próprio
 * status do modelo; auditor não reprovado; confianças reportadas com
 * entrada ≥ 60; leitura visual ≥ 60. Qualquer ausência ⇒ false, com a
 * pendência DITA — proibido exibir operação confirmada sem isso.
 * ------------------------------------------------------------------------- */

export type EntryBias = "COMPRA" | "VENDA" | "NEUTRO";

export type DerivedSetupStatus = "AGUARDANDO" | "EM_FORMACAO" | "CONFIRMADA" | "INVALIDADA";

export const DERIVED_STATUS_LABEL: Record<DerivedSetupStatus, string> = {
  AGUARDANDO: "AGUARDANDO",
  EM_FORMACAO: "T4 EM FORMAÇÃO",
  CONFIRMADA: "T4 CONFIRMADA",
  INVALIDADA: "T4 INVALIDADA",
};

export interface EntryProof {
  entradaConfirmada: boolean;
  /** O que falta para confirmar, em ordem de importância. Vazio SÓ quando confirmada. */
  pendencias: string[];
  /** Ressalvas que não bloqueiam — ex.: prova de fechamento dispensada. */
  avisos: string[];
  /** Entrada+stop+alvo numéricos, coerentes com o lado e R:R ≥ 1,5. */
  niveisCompletos: boolean;
  /** Razão risco/retorno calculada. Null quando falta nível ou o risco é zero. */
  rr: number | null;
  /**
   * O veredito do gate de risco (§11), inteiro.
   *
   * A máquina de setup precisa distinguir "reprovado no risco" de "reprovado na
   * leitura" para poder gravar RISK_REJECTED como estado próprio — com só o
   * `rr` numérico ela teria de reconstruir a decisão, que é a duplicação que o
   * gate existe para impedir.
   */
  risco: RiskAssessment;
}

export interface EntryDecision extends EntryProof {
  /**
   * O viés FINAL — já passado pelo auditor. NUNCA é a leitura bruta da IA.
   *
   * Quando o auditor diz que a estrutura contradiz a direção afirmada, este
   * campo vira NEUTRO: o card não pode dizer COMPRA enquanto o revisor diz
   * "topos e fundos descendentes". Direção alternativa não é inventada aqui —
   * inverter o lado por conta própria seria criar um sinal que ninguém leu.
   */
  bias: EntryBias;
  status: DerivedSetupStatus;
  /** null = auditor não rodou (ausência declarada, nunca "aprovado por omissão"). */
  auditorAprovou: boolean | null;
  /** O auditor reprovou especificamente a DIREÇÃO afirmada. */
  direcaoBloqueadaPeloAuditor: boolean;
}

/** Piso comum das confianças (§12) e da leitura visual para liberar entrada. */
export const MIN_ENTRY_CONFIDENCE = 60;
/**
 * R:R mínimo da casa — reexportado de @/lib/t4/riskGate, nunca redeclarado.
 *
 * O número (e a divisão que o usa) vive num módulo só: três cópias da mesma
 * conta divergem no primeiro ajuste, e a divergência chega ao operador como um
 * painel liberando o que o outro bloqueia.
 */
export { MIN_RR } from "@/lib/t4/riskGate";

const valorLegivel = (n: ReadNumber | null | undefined): number | null =>
  n != null && n.visible && n.value !== null ? n.value : null;

/**
 * CANDLE DE CONFIRMAÇÃO FECHADO — a prova do rompimento (§5 do operador).
 *
 * Pavio atravessando o nível não confirma nada, e candle que rompe e fecha de
 * volta na região é falha de rompimento, não entrada. Duas evidências são
 * aceitas, ambas vindas do modelo e verificáveis: o critério de candle
 * ATENDIDO na lista de critérios T4 (item 8 das regras), ou o candle de
 * gatilho CLASSIFICADO no DNA — NAO_IDENTIFICADO ali significa "olhei e não
 * achou", que é ausência de prova, não prova de ausência de exigência.
 */
export function hasClosedConfirmationCandle(analysis: PrintAnalysis): boolean {
  // Listas ausentes (análise antiga do histórico) são listas vazias: sem
  // evidência, e não uma exceção que derruba a tela.
  const annotations = analysis.annotations ?? [];
  const criteria = analysis.criteria ?? [];
  // A marcação é a evidência mais forte: o modelo apontou ONDE o candle fechou.
  if (annotations.some((a) => a.kind === "CONFIRMATION_CANDLE")) return true;
  if (criteria.some((c) => c.met && /candle/i.test(`${c.id} ${c.label}`))) return true;
  const dna = analysis.dna ?? null;
  return dna !== null && dna.triggerCandle !== "NAO_IDENTIFICADO";
}

export interface EntryProofInput {
  bias: EntryBias;
  /** Níveis NUMÉRICOS. Null = não identificado — nunca zero, nunca estimado. */
  entry: number | null;
  stop: number | null;
  target: number | null;
  status: PrintStatus;
  audit: PrintAnalysis["audit"];
  confidences: PrintAnalysis["confidences"];
  /** Confiança da leitura visual (0–100). */
  confidence: number;
  closedConfirmationCandle: boolean;
  /**
   * Exigir candle FECHADO para confirmar. Padrão `true` — a regra da casa.
   *
   * `false` só por decisão explícita do dono da técnica. O resultado passa a
   * carregar um aviso: entrada no TOQUE não é a mesma técnica que entrada com
   * fechamento provado, e a estatística de uma não vale para a outra.
   */
  exigirCandleFechado?: boolean;
}

/**
 * A REGRA DA CONFIRMAÇÃO, EM UM LUGAR SÓ.
 *
 * Dois chamadores com fontes de nível diferentes: o print sozinho
 * (`deriveEntryDecision`) e a máquina de setup, que carrega níveis herdados
 * de prints anteriores do MESMO setup. A REGRA não pode divergir entre eles —
 * duas cópias divergiriam no primeiro ajuste, e uma delas liberaria entrada
 * que a outra bloqueia. Por isso os níveis entram por parâmetro e o
 * julgamento mora aqui.
 */
export function evaluateEntryProof(input: EntryProofInput): EntryProof {
  const pendencias: string[] = [];
  /** Ressalvas que NÃO bloqueiam a confirmação, mas viajam com o resultado. */
  const avisos: string[] = [];

  /*
   * ANÁLISE ANTIGA CHEGA COM CAMPOS AUSENTES, NÃO COM null.
   *
   * O histórico do operador é JSON gravado antes destes campos existirem: ao
   * reabrir, `audit` e `confidences` voltam como `undefined`. O tipo diz
   * "nullable", então `!== null` passaria direto e a leitura de `.approved`
   * derrubaria a tela inteira. Normalizar aqui é o que faz ausência antiga e
   * ausência declarada significarem a mesma coisa — que é o que elas são.
   */
  const audit = input.audit ?? null;
  const confidences = input.confidences ?? null;
  const confidence = Number.isFinite(input.confidence) ? input.confidence : 0;

  if (input.bias === "NEUTRO") pendencias.push("sem lado definido (viés NEUTRO)");
  // Auditor null = não rodou (ausência nunca derruba); reprovado é VETO, e
  // veto vem primeiro porque anula qualquer outra prova presente.
  if (audit !== null && !audit.approved) {
    pendencias.push(`auditor reprovou: ${audit.issues?.[0] ?? "incoerência"}`);
  }

  const { entry, stop, target } = input;
  if (entry === null) pendencias.push(`entrada ${NAO_IDENTIFICADO}`);
  if (stop === null) pendencias.push(`stop ${NAO_IDENTIFICADO}`);
  if (target === null) pendencias.push(`alvo ${NAO_IDENTIFICADO}`);

  /*
   * O RISCO É JULGADO PELO GATE, NÃO AQUI (§11).
   *
   * `RISK_UNKNOWN` significa "faltou nível para julgar" — e esses níveis já
   * viraram pendência logo acima. Repetir os problemas do gate nesse caso
   * duplicaria a mesma frase na tela; por isso só os vereditos que de fato
   * avaliaram risco (aprovado/reprovado) contribuem com pendência.
   */
  const risco = assessTradeRisk({ side: input.bias, entry, stop, target });
  if (risco.verdict !== "RISK_UNKNOWN") pendencias.push(...risco.problems);
  const rr = risco.rr;

  /*
   * A PROVA DE FECHAMENTO — e a única forma de dispensá-la.
   *
   * A regra da casa é que rompimento por PAVIO não confirma entrada: o preço
   * encosta no gatilho, o candle não fecha além dele, e a "entrada" seria uma
   * falsa partida. É o que o evento TOQUE_SEM_CONFIRMACAO segura na tela.
   *
   * `exigirCandleFechado: false` remove essa exigência, e existe por um pedido
   * explícito do dono da técnica para a leitura de VÍDEO — onde o OHLC do
   * candle não é legível na resolução da gravação (medido: 40 descartes de
   * "máxima não legível" em 68 prints), e a técnica nunca confirmava por falta
   * de PROVA, não por falta de setup.
   *
   * O padrão continua `true`. Quem dispensa a prova declara isso na chamada, e
   * a pendência é substituída por um AVISO que viaja junto do resultado — para
   * nenhuma estatística produzida assim ser confundida com a da técnica
   * completa.
   */
  if (!input.closedConfirmationCandle) {
    if (input.exigirCandleFechado === false) {
      avisos.push(
        "ENTRADA NO TOQUE: confirmada sem candle fechado — prova de fechamento dispensada nesta leitura",
      );
    } else {
      pendencias.push(
        "sem candle de confirmação FECHADO (rompimento só por pavio não confirma entrada)",
      );
    }
  }
  if (input.status !== "ENTRADA_CONFIRMADA") {
    pendencias.push(`o print não sustenta confirmação (${PRINT_STATUS_LABEL[input.status]})`);
  }
  /*
   * Confiança AUSENTE é insuficiente, não "provavelmente boa": o schema
   * forçado exige as quatro camadas, então null aqui é resposta incompleta —
   * e liberar entrada sobre confiança que ninguém mediu é o oposto da regra.
   */
  if (confidences === null || typeof confidences.entrada !== "number") {
    pendencias.push("confianças por camada não reportadas");
  } else if (confidences.entrada < MIN_ENTRY_CONFIDENCE) {
    pendencias.push(
      `confiança de ENTRADA ${confidences.entrada}% abaixo de ${MIN_ENTRY_CONFIDENCE}%`,
    );
  }
  if (confidence < MIN_ENTRY_CONFIDENCE) {
    pendencias.push(`leitura visual ${confidence}% abaixo de ${MIN_ENTRY_CONFIDENCE}%`);
  }

  return {
    entradaConfirmada: pendencias.length === 0,
    pendencias,
    avisos,
    niveisCompletos: riscoAprovado(risco),
    rr,
    risco,
  };
}

/**
 * A DECISÃO FINAL DESTE PRINT — o único estado que a UI pode exibir.
 *
 * Ordem que não se inverte: ANÁLISE → AUDITOR → VALIDAÇÃO → ESTADO FINAL.
 * O `analysis.direction` que entra aqui já é a leitura validada; o auditor
 * ainda pode DERRUBAR a direção, e é neste ponto que isso acontece — antes de
 * qualquer coisa chegar à tela.
 */
export function deriveEntryDecision(analysis: PrintAnalysis): EntryDecision {
  const audit = analysis.audit ?? null;
  const auditorAprovou = audit === null ? null : audit.approved;
  /*
   * DIREÇÃO BLOQUEADA: o auditor viu a estrutura contradizer o lado afirmado.
   * O card NÃO pode mostrar COMPRA enquanto o revisor diz "estrutura de
   * baixa" — a contradição entre os dois painéis é pior que qualquer um dos
   * dois estar errado sozinho, porque o operador escolhe o que quer ver.
   */
  const direcaoBloqueadaPeloAuditor =
    audit !== null && !audit.approved && audit.directionContradicted;

  const bias: EntryBias = direcaoBloqueadaPeloAuditor ? "NEUTRO" : analysis.direction;
  const prova = evaluateEntryProof({
    bias,
    entry: valorLegivel(analysis.entry),
    stop: valorLegivel(analysis.stop),
    target: (analysis.targets ?? []).map(valorLegivel).find((v) => v !== null) ?? null,
    status: analysis.status,
    audit: analysis.audit,
    confidences: analysis.confidences,
    confidence: analysis.confidence,
    closedConfirmationCandle: hasClosedConfirmationCandle(analysis),
  });

  const status: DerivedSetupStatus =
    analysis.status === "T4_INVALIDADA"
      ? "INVALIDADA"
      : // Direção derrubada pelo auditor não é "formação": não há lado para
        // formar. Volta a AGUARDANDO, que é o estado honesto de quem perdeu a
        // premissa e não ganhou outra no lugar.
        direcaoBloqueadaPeloAuditor
        ? "AGUARDANDO"
        : prova.entradaConfirmada
          ? "CONFIRMADA"
          : analysis.status === "SEM_T4" || analysis.status === "INCONCLUSIVO"
            ? "AGUARDANDO"
            : "EM_FORMACAO";

  return { ...prova, bias, status, auditorAprovou, direcaoBloqueadaPeloAuditor };
}

/**
 * A TRAVA: rebaixa um ENTRADA_CONFIRMADA sem prova completa, dizendo tudo o
 * que faltou. Roda na validação (pré-auditor) E de novo depois do auditor —
 * é o que garante que NENHUM caminho a jusante (máquina de setup, banco,
 * painel, seta no gráfico) veja confirmação sem `entradaConfirmada=true`.
 */
export function applyConfirmationGate(analysis: PrintAnalysis): string[] {
  const reparosDirecao = applyAuditorDirectionVeto(analysis);

  if (analysis.status !== "ENTRADA_CONFIRMADA") {
    // Status que não é confirmação nunca carrega marcação de confirmação —
    // inclusive quando o modelo devolve as duas coisas em contradição.
    return [
      ...reparosDirecao,
      ...removeConfirmationMarks(analysis, "o status não é ENTRADA_CONFIRMADA"),
    ];
  }
  const decisao = deriveEntryDecision(analysis);
  if (decisao.entradaConfirmada) return reparosDirecao;

  // Níveis completos = "quase lá" (PRÉ-ENTRADA); sem eles ainda é formação.
  analysis.status = decisao.niveisCompletos ? "PRE_ENTRADA" : "T4_EM_FORMACAO";
  const reparos = [
    ...reparosDirecao,
    `TRAVA DA CONFIRMAÇÃO: status rebaixado para ${PRINT_STATUS_LABEL[analysis.status]} — ${decisao.pendencias.join("; ")}.`,
  ];
  reparos.push(...removeConfirmationMarks(analysis, "a entrada não passou na trava"));
  return reparos;
}

/**
 * VETO DE DIREÇÃO DO AUDITOR — bloqueio NA ORIGEM, não só na tela.
 *
 * Quando o revisor diz que a estrutura contradiz o lado afirmado, a direção
 * é zerada no PRÓPRIO objeto validado. Não basta a UI esconder: este mesmo
 * objeto alimenta o DNA, o banco, a memória e a máquina de setup. Deixar
 * "COMPRA" vivo lá dentro e apenas não desenhar na tela criaria um sistema
 * que aprende com uma direção que ele próprio já reprovou.
 *
 * A leitura original NÃO é apagada em silêncio: o reparo declara qual era o
 * lado e por que ele caiu — é assim que o padrão de erro do modelo continua
 * visível para quem revisa depois.
 */
function applyAuditorDirectionVeto(analysis: PrintAnalysis): string[] {
  const audit = analysis.audit ?? null;
  if (audit === null || audit.approved || !audit.directionContradicted) return [];
  if (analysis.direction === "NEUTRO") return [];

  const lado = analysis.direction;
  analysis.direction = "NEUTRO";
  const motivo = audit.issues?.[0] ?? "estrutura contradiz a direção afirmada";
  const reparos = [
    `AUDITOR VETOU A DIREÇÃO: ${lado} bloqueada — ${motivo}. Viés volta a NEUTRO; direção alternativa não é inventada.`,
  ];

  /*
   * O DNA carrega o lado do setup. Com a direção vetada não existe setup para
   * classificar: a grade vira DESCARTADA para que a base não aprenda com uma
   * configuração que o próprio revisor negou.
   */
  if (analysis.dna !== null && analysis.dna.grade !== "DESCARTADA") {
    reparos.push(
      `DNA: grade ${analysis.dna.grade} rebaixada para DESCARTADA — a direção foi vetada pelo auditor.`,
    );
    analysis.dna.grade = "DESCARTADA";
  }

  return reparos;
}

/**
 * A SETA DE CONFIRMAÇÃO ANUNCIA ORDEM: sem lado liberado, não se desenha.
 *
 * Uma função só, consumida pelas TRÊS superfícies (traço SVG, rótulo HTML e o
 * PNG exportado). O defeito original nasceu justamente de assimetria entre
 * superfícies — a linha de entrada tinha o gate, a seta não —, e três cópias
 * da mesma regra escritas à mão reabririam a porta pela mesma fresta.
 */
export function podeDesenharAnotacao(a: Annotation, entrySide: EntryBias | null): boolean {
  return a.kind !== "CONFIRMATION_CANDLE" || (entrySide !== null && entrySide !== "NEUTRO");
}

/** Tira a seta de confirmação do gráfico e diz que tirou. */
function removeConfirmationMarks(analysis: PrintAnalysis, motivo: string): string[] {
  // Análise legada do histórico pode nem ter a lista: ausência é lista vazia.
  const atuais = analysis.annotations ?? [];
  const antes = atuais.length;
  analysis.annotations = atuais.filter((a) => a.kind !== "CONFIRMATION_CANDLE");
  const removidas = antes - analysis.annotations.length;
  if (removidas === 0) return [];
  return [
    `${removidas} marcação(ões) de candle de confirmação descartada(s): ${motivo} — seta de entrada só existe com entrada confirmada.`,
  ];
}

/** Como exibir um número lido. Ausência é dita, nunca disfarçada de traço. */
export function formatRead(n: ReadNumber, decimals = 0): string {
  if (!n.visible || n.value === null) return NAO_LEGIVEL;
  return n.value.toLocaleString("pt-BR", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Cores por tipo de marcação — o padrão consistente do overlay. */
export const ANNOTATION_COLOR: Record<AnnotationKind, string> = {
  // §8 do operador: ROXO é a cor da ENTRADA (linha "ENTRAR SE TOCAR AQUI");
  // vermelho fica para stop/invalidação e verde para alvo.
  ENTRY_LINE: "#a855f7",
  ENTRY_ZONE: "#a855f7",
  STOP: "#ef4444",
  INVALIDATION: "#ef4444",
  TARGET: "#22c55e",
  SUPPORT: "#3b82f6",
  RESISTANCE: "#3b82f6",
  SUPPLY_ZONE: "#ef4444",
  DEMAND_ZONE: "#22c55e",
  ATTENTION_ZONE: "#eab308",
  BREAKOUT: "#eab308",
  PULLBACK: "#eab308",
  T4_PAST: "#22d3ee",
  SCENARIO_ARROW: "#eab308",
  // Verde é a cor padrão da confirmação; numa VENDA o overlay pinta de
  // vermelho pelo lado (a seta anuncia a direção da ordem, §7).
  CONFIRMATION_CANDLE: "#22c55e",
  NOTE: "#e5e7eb",
};
