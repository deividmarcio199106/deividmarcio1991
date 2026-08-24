/**
 * ESPAÇO DE PARÂMETROS DA T4 — só o que o MOTOR realmente lê.
 *
 * A RESTRIÇÃO CENTRAL DESTE ARQUIVO: **um parâmetro só existe aqui se o
 * pipeline T4 headless (`runQuantBacktest` → `analyze` → `buildPlan` →
 * `LiveOutcomeTracker`) o consumir de verdade**. Inventar um knob que o motor
 * ignora produziria um sweep bonito e MENTIROSO: variantes com números
 * diferentes por ruído de amostra, atribuídos a um ajuste que nunca aconteceu.
 *
 * Por isso o mapa abaixo é explícito nos DOIS sentidos:
 *  - `PARAM_SOURCE` diz, para cada parâmetro suportado, QUEM no motor o lê;
 *  - `UNSUPPORTED_PARAMS` declara os itens pedidos pelo operador que HOJE não
 *    têm correspondente configurável (são constantes de módulo em
 *    `@/lib/engines/strategy` lidas direto por cada engine, sem ponto de
 *    injeção). Eles aparecem no relatório como NÃO SUPORTADOS — nunca como
 *    coluna fabricada.
 *
 * A T4 de produção é BASELINE IMUTÁVEL (`BASELINE_ID`): entra no ranking como
 * referência e NUNCA é alterada por este módulo.
 *
 * PURO E DETERMINÍSTICO: sem IO, sem relógio e sem `Math.random` — o sorteio,
 * quando o teto corta o produto cartesiano, sai de um LCG com seed FIXA (mesma
 * lei do `monteCarlo.ts`). Mesma entrada ⇒ exatamente as mesmas candidatas.
 */

import { DEFAULT_RISK_PARAMS, type RiskParams, type StopMethod } from "@/lib/engines/strategy";
import { MIN_CLOSED_CANDLES } from "@/lib/t4/readingState";

import { DEFAULT_MAX_WAIT_BARS, type QuantOptions } from "./quantBacktest";

/** A técnica de produção. Referência do ranking, jamais alvo do sweep. */
export const BASELINE_ID = "T4-PRODUCAO";

/**
 * Parâmetros REAIS do pipeline. Todo campo aqui tem um consumidor no motor —
 * conferido em `PARAM_SOURCE`.
 */
export interface SweepParams {
  /** `buildPlan`: referência do stop (invalidação do POI ou swing ± ATR). */
  stopMethod: StopMethod;
  /** `buildPlan`: abaixo disto o plano é RECUSADO (retorna null). Em pontos. */
  minStopDistance: number;
  /** `buildPlan`: acima disto o plano é RECUSADO (retorna null). Em pontos. */
  maxStopDistance: number;
  /** `buildPlan`: alvo parcial = entrada ± múltiplo · distância do stop. */
  partialTargetMultiple: number;
  /** `buildPlan`: alvo final = entrada ± múltiplo · distância do stop. */
  finalTargetMultiple: number;
  /** `roundToTick`: propriedade do ATIVO, não hipótese — fora do sweep. */
  tickSize: number;
  /** `runQuantBacktest`: candles fechados exigidos antes de a análise rodar. */
  minWindow: number;
  /** `LiveOutcomeTracker`: candles de espera pela execução antes de expirar. */
  maxWaitBars: number;
}

/** Rótulo legível — o operador precisa ler a tabela, não decorar campo. */
export const PARAM_LABELS: Record<keyof SweepParams, string> = {
  stopMethod: "método do stop",
  minStopDistance: "distância mínima do stop (pts)",
  maxStopDistance: "distância máxima do stop (pts)",
  partialTargetMultiple: "múltiplo do alvo parcial (R)",
  finalTargetMultiple: "múltiplo do alvo final (R)",
  tickSize: "tick do ativo",
  minWindow: "janela mínima de candles fechados",
  maxWaitBars: "candles de espera pela execução",
};

/**
 * QUEM lê cada parâmetro no motor. É esta coluna que impede o sweep de
 * inventar knob: se um dia a linha correspondente sumir do motor, o parâmetro
 * tem de sair daqui junto.
 */
export const PARAM_SOURCE: Record<keyof SweepParams, string> = {
  stopMethod: "buildPlan (riskEngine) — params.stopMethod escolhe POI vs swing±ATR",
  minStopDistance: "buildPlan (riskEngine) — stopDistance < min ⇒ plano recusado",
  maxStopDistance: "buildPlan (riskEngine) — stopDistance > max ⇒ plano recusado",
  partialTargetMultiple: "buildPlan (riskEngine) — target1 = entry ± stopDistance · múltiplo",
  finalTargetMultiple: "buildPlan (riskEngine) — target2 = entry ± stopDistance · múltiplo",
  tickSize: "roundToTick (strategy) — arredondamento final do plano",
  minWindow: "runQuantBacktest — candles abaixo da janela caem em discards",
  maxWaitBars: "LiveOutcomeTracker — entrada não executada em N candles expira",
};

/**
 * ITENS PEDIDOS PELO OPERADOR QUE O MOTOR NÃO EXPÕE.
 *
 * Todos existem como CONSTANTES de módulo em `@/lib/engines/strategy`, lidas
 * diretamente por cada engine (`import { LIQUIDITY_CONFIG } from "./strategy"`).
 * Não há parâmetro, opção nem override: variá-los exigiria alterar
 * `src/lib/engines/**` — fora do escopo deste módulo. Declarados aqui para o
 * relatório dizer "não medido" em vez de mostrar coluna inventada.
 */
export const UNSUPPORTED_PARAMS: readonly { item: string; motivo: string }[] = [
  {
    item: "distância da linha / entrada",
    motivo:
      "buildPlan calcula a entrada com offset FIXO (nível ± atr·0.12) e alterna reteste/entrada " +
      "direta por limiares embutidos (breakoutStrength > 62, locationInTrend > 0.8). " +
      "ENTRY_CHASE_TOLERANCE_ATR existe em strategy.ts mas não é lido por ninguém. Sem injeção.",
  },
  {
    item: "tolerância do toque",
    motivo:
      "LIQUIDITY_CONFIG.touchAtr / equalLevelToleranceAtr são const de módulo lidas por " +
      "liquidityEngine. Sem parâmetro nem override.",
  },
  {
    item: "confirmação",
    motivo:
      "SMS_CONFIG.minConfidence / minBreakBodyRatio / minDisplacement são const de módulo lidas " +
      "por smsEngine; o gate CONFIRMATION_CANDLE apenas LÊ o estágio já decidido. Sem injeção.",
  },
  {
    item: "rompimento",
    motivo:
      "HSS_CONFIG.minDisplacement / minRejectionWick / rejectionWindowBars são const de módulo " +
      "(hssEngine, liquidityEngine) e a força de rompimento em buildPlan é literal. Sem injeção.",
  },
  {
    item: "filtros estruturais",
    motivo:
      "Guards T4, MAX_REVERSAL_RISK, POI_CONFIG.minStrengthForSignal e os mínimos de R:R são " +
      "const de módulo avaliadas dentro do analysisPipeline/t4Engine. Sem injeção.",
  },
  {
    item: "janela de horário",
    motivo:
      "A T4 de produção NÃO tem filtro de horário em lugar nenhum do pipeline. Criar um aqui " +
      "seria medir uma técnica que não existe — declarado como ausente, não fabricado.",
  },
];

/**
 * BASELINE = a produção como ela é HOJE, montada a partir dos defaults reais do
 * motor. Nada de números copiados à mão: se `DEFAULT_RISK_PARAMS` mudar, o
 * baseline muda junto e o sweep continua comparando contra a produção de fato.
 */
export const BASELINE_PARAMS: SweepParams = {
  stopMethod: DEFAULT_RISK_PARAMS.stopMethod,
  minStopDistance: DEFAULT_RISK_PARAMS.minStopDistance,
  maxStopDistance: DEFAULT_RISK_PARAMS.maxStopDistance,
  partialTargetMultiple: DEFAULT_RISK_PARAMS.partialTargetMultiple,
  finalTargetMultiple: DEFAULT_RISK_PARAMS.finalTargetMultiple,
  tickSize: DEFAULT_RISK_PARAMS.tickSize,
  minWindow: MIN_CLOSED_CANDLES,
  maxWaitBars: DEFAULT_MAX_WAIT_BARS,
};

/** `tickSize` é propriedade do ativo — varrê-lo mediria o ativo, não a técnica. */
export type SweepableParam = Exclude<keyof SweepParams, "tickSize">;

/** Valores a testar por eixo. Eixo ausente = fica no baseline. */
export type ParamSpace = {
  [K in SweepableParam]?: readonly SweepParams[K][];
};

/**
 * ORDEM FIXA DOS EIXOS — o produto cartesiano é enumerado sempre nesta ordem,
 * então a mesma `ParamSpace` produz sempre a mesma lista, com os mesmos ids.
 */
const AXIS_ORDER: readonly SweepableParam[] = [
  "stopMethod",
  "partialTargetMultiple",
  "finalTargetMultiple",
  "minStopDistance",
  "maxStopDistance",
  "minWindow",
  "maxWaitBars",
];

/**
 * Espaço default: variações CONSERVADORAS em torno do baseline.
 *
 * `minStopDistance`/`maxStopDistance` ficam DE FORA de propósito: são valores
 * em PONTOS do ativo, e um intervalo chutado aqui viraria hipótese sobre o WIN
 * que ninguém declarou. O operador que quiser varrê-los passa o próprio espaço.
 */
export const DEFAULT_PARAM_SPACE: ParamSpace = {
  stopMethod: ["combinado", "somente_atr"],
  partialTargetMultiple: [2, 3, 4],
  finalTargetMultiple: [5, 6],
  minWindow: [24, 40],
  maxWaitBars: [5, 10, 15],
};

/** Teto default de candidatas geradas. Explícito porque sweep sem teto não é pesquisa, é força bruta. */
export const DEFAULT_CANDIDATE_LIMIT = 12;

/** Seed FIXA do corte pelo teto — reprodutibilidade acima de tudo. */
export const CANDIDATE_SEED = 20260319;

/** O que difere do baseline, em linguagem de operador. */
export interface ChangedParam {
  param: SweepableParam;
  label: string;
  baseline: string;
  candidato: string;
}

export interface Candidate {
  /** Id determinístico e estável para a mesma ParamSpace + teto. */
  id: string;
  params: SweepParams;
  /** NUNCA vazio: uma candidata idêntica ao baseline não é gerada. */
  changedFrom: ChangedParam[];
  /** Uma linha legível do que mudou — a tabela mostra isto, não o id. */
  resumo: string;
}

/** LCG de Numerical Recipes — o mesmo do monteCarlo.ts. Determinismo é o requisito. */
function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function formatValue(value: SweepParams[SweepableParam]): string {
  if (typeof value === "string") return value;
  if (!Number.isFinite(value)) return value > 0 ? "∞" : "−∞";
  return String(value);
}

function changedFrom(params: SweepParams): ChangedParam[] {
  const out: ChangedParam[] = [];
  for (const axis of AXIS_ORDER) {
    if (params[axis] === BASELINE_PARAMS[axis]) continue;
    out.push({
      param: axis,
      label: PARAM_LABELS[axis],
      baseline: formatValue(BASELINE_PARAMS[axis]),
      candidato: formatValue(params[axis]),
    });
  }
  return out;
}

/**
 * Combinação impossível de operar — descartada ANTES de virar candidata.
 * Não é opinião de mérito: é aritmética (alvo final aquém da parcial, faixa de
 * stop vazia, contagens não inteiras) que produziria plano nulo ou incoerente.
 */
function invalidReason(p: SweepParams): string | null {
  if (!Number.isFinite(p.partialTargetMultiple) || p.partialTargetMultiple <= 0) {
    return "múltiplo da parcial precisa ser > 0";
  }
  if (!Number.isFinite(p.finalTargetMultiple) || p.finalTargetMultiple <= 0) {
    return "múltiplo do alvo final precisa ser > 0";
  }
  if (p.finalTargetMultiple <= p.partialTargetMultiple) {
    return "alvo final precisa ficar além da parcial";
  }
  if (!Number.isFinite(p.minStopDistance) || p.minStopDistance < 0) {
    return "distância mínima do stop precisa ser >= 0";
  }
  if (Number.isNaN(p.maxStopDistance) || p.maxStopDistance <= p.minStopDistance) {
    return "faixa de distância do stop vazia";
  }
  if (!Number.isInteger(p.minWindow) || p.minWindow < 1) return "janela mínima precisa ser >= 1";
  if (!Number.isInteger(p.maxWaitBars) || p.maxWaitBars < 1) {
    return "espera pela execução precisa ser >= 1 candle";
  }
  return null;
}

interface Enumerated {
  /** Combinações válidas, na ordem canônica do produto cartesiano. */
  validas: SweepParams[];
  combinacoes: number;
  invalidas: number;
  iguaisAoBaseline: number;
}

/**
 * Expande a lista atual por UM eixo. Escrita 100% tipada (o `apply` é escrito
 * campo a campo por quem chama), sem cast e sem chave dinâmica — é o que
 * mantém este arquivo livre de `as any`. Eixo ausente/vazio devolve a lista
 * intacta: quem não declara valor fica no baseline.
 */
function expand<V>(
  combos: SweepParams[],
  valores: readonly V[] | undefined,
  apply: (base: SweepParams, valor: V) => SweepParams,
): SweepParams[] {
  if (!valores || valores.length === 0) return combos;
  const next: SweepParams[] = [];
  for (const base of combos) {
    for (const valor of valores) next.push(apply(base, valor));
  }
  return next;
}

/** Produto cartesiano na ORDEM DE `AXIS_ORDER` — a ordem das chamadas abaixo. */
function enumerate(space: ParamSpace): Enumerated {
  let combos: SweepParams[] = [{ ...BASELINE_PARAMS }];
  combos = expand(combos, space.stopMethod, (p, v) => ({ ...p, stopMethod: v }));
  combos = expand(combos, space.partialTargetMultiple, (p, v) => ({
    ...p,
    partialTargetMultiple: v,
  }));
  combos = expand(combos, space.finalTargetMultiple, (p, v) => ({ ...p, finalTargetMultiple: v }));
  combos = expand(combos, space.minStopDistance, (p, v) => ({ ...p, minStopDistance: v }));
  combos = expand(combos, space.maxStopDistance, (p, v) => ({ ...p, maxStopDistance: v }));
  combos = expand(combos, space.minWindow, (p, v) => ({ ...p, minWindow: v }));
  combos = expand(combos, space.maxWaitBars, (p, v) => ({ ...p, maxWaitBars: v }));

  let invalidas = 0;
  let iguaisAoBaseline = 0;
  const validas: SweepParams[] = [];
  for (const combo of combos) {
    if (invalidReason(combo) !== null) {
      invalidas += 1;
      continue;
    }
    if (changedFrom(combo).length === 0) {
      // O baseline não é candidata: ele entra no ranking por fora, imutável.
      iguaisAoBaseline += 1;
      continue;
    }
    validas.push(combo);
  }
  return { validas, combinacoes: combos.length, invalidas, iguaisAoBaseline };
}

/**
 * Corte pelo teto: quando o produto cartesiano é maior que `limit`, a seleção
 * é um SORTEIO SEMEADO (Fisher–Yates com LCG de seed fixa) sobre os ÍNDICES,
 * seguido de reordenação pelo índice original.
 *
 * Por que sortear em vez de "pegar os N primeiros": os N primeiros varreriam
 * só o começo do primeiro eixo, e o operador acharia que testou o espaço. O
 * sorteio semeado cobre o espaço inteiro E continua reproduzível — a mesma
 * ParamSpace com o mesmo teto devolve exatamente as mesmas candidatas.
 */
function selectWithinLimit(validas: SweepParams[], limit: number): SweepParams[] {
  if (validas.length <= limit) return validas;
  const indices = validas.map((_, i) => i);
  const rand = makeLcg(CANDIDATE_SEED);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = indices[i]!;
    indices[i] = indices[j]!;
    indices[j] = tmp;
  }
  return indices
    .slice(0, limit)
    .sort((a, b) => a - b)
    .map((i) => validas[i]!);
}

/**
 * Gera as candidatas do espaço, com TETO EXPLÍCITO.
 *
 * Garantias:
 * - determinística: mesma `space` + mesmo `limit` ⇒ mesmas candidatas, mesmos ids;
 * - nenhuma candidata é igual ao baseline (`changedFrom` nunca vem vazio);
 * - combinações aritmeticamente impossíveis não viram candidata;
 * - `limit <= 0` devolve lista vazia — sweep sem teto declarado não roda.
 */
export function buildCandidates(
  space: ParamSpace = DEFAULT_PARAM_SPACE,
  limit: number = DEFAULT_CANDIDATE_LIMIT,
): Candidate[] {
  const teto = Number.isFinite(limit) ? Math.trunc(limit) : 0;
  if (teto < 1) return [];

  const { validas } = enumerate(space);
  const escolhidas = selectWithinLimit(validas, teto);
  const casas = String(escolhidas.length).length;

  return escolhidas.map((params, i) => {
    const mudou = changedFrom(params);
    return {
      id: `CAND-${String(i + 1).padStart(casas, "0")}`,
      params,
      changedFrom: mudou,
      resumo: mudou.map((c) => `${c.label}: ${c.baseline} → ${c.candidato}`).join(" · "),
    };
  });
}

/**
 * Contabilidade do espaço — o que foi gerado, o que foi cortado e por quê.
 * Existe para a tela nunca dizer "12 candidatas" sem dizer 12 de quantas.
 */
export function explainCandidateSpace(
  space: ParamSpace = DEFAULT_PARAM_SPACE,
  limit: number = DEFAULT_CANDIDATE_LIMIT,
): {
  combinacoes: number;
  invalidas: number;
  iguaisAoBaseline: number;
  validas: number;
  geradas: number;
  teto: number;
  cortadasPeloTeto: number;
} {
  const teto = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0;
  const { validas, combinacoes, invalidas, iguaisAoBaseline } = enumerate(space);
  const geradas = Math.min(validas.length, teto);
  return {
    combinacoes,
    invalidas,
    iguaisAoBaseline,
    validas: validas.length,
    geradas,
    teto,
    cortadasPeloTeto: validas.length - geradas,
  };
}

/** Traduz os parâmetros para as opções que `runQuantBacktest` já entende. */
export function toQuantOptions(params: SweepParams, asset: string): QuantOptions {
  const riskParams: RiskParams = {
    stopMethod: params.stopMethod,
    tickSize: params.tickSize,
    minStopDistance: params.minStopDistance,
    maxStopDistance: params.maxStopDistance,
    partialTargetMultiple: params.partialTargetMultiple,
    finalTargetMultiple: params.finalTargetMultiple,
  };
  return {
    asset,
    minWindow: params.minWindow,
    maxWaitBars: params.maxWaitBars,
    riskParams,
  };
}
