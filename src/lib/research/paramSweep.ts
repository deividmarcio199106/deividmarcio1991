/**
 * SWEEP DE CANDIDATAS — a MESMA T4, com os parâmetros que o motor de fato lê.
 *
 * Cada variante roda pelo pipeline headless `runQuantBacktest` (que já é o
 * caminho do ao vivo, candle a candle, sem futuro). Este módulo não
 * reimplementa técnica nenhuma: ele divide o tempo, mede, penaliza e ordena.
 *
 * AS QUATRO RESTRIÇÕES QUE ESTE ARQUIVO EXISTE PARA GARANTIR:
 *
 * 1. OOS NÃO PARTICIPA DA ESCOLHA. A divisão é temporal (`splitTradingDates`)
 *    e o fora-da-amostra é SEMPRE o fim do período. O score que ordena a tabela
 *    (`pontuarSelecao`) nem recebe métrica de OOS como argumento — o OOS é
 *    coluna declarada e VETO, nunca critério de otimização.
 * 2. PENALIZAÇÃO DE OVERFITTING. Quanto mais hipóteses testadas sobre a mesma
 *    base, MAIOR o PF exigido fora da amostra — a mesma régua já usada pelo
 *    servidor em `candidateStatusProblem`: 1.3 + 0.2·⌈log₂(1 + hipóteses)⌉.
 * 3. NADA ENTRA EM PRODUÇÃO. O vocabulário de status é `"CANDIDATA" |
 *    "BASELINE"`; "PRODUCTION"/"PROMOVIDA" são INEXPRIMÍVEIS no tipo. Este
 *    módulo não promove, não grava e não sugere promoção.
 * 4. AMOSTRA MÍNIMA ANTES DE CONCLUSÃO. Abaixo de `minTrades` a variante é
 *    inelegível com a frase canônica da casa — as métricas continuam visíveis,
 *    a conclusão não existe.
 *
 * PURO E REPRODUTÍVEL: sem IO, sem relógio, sem `Math.random`. O Monte Carlo
 * recebe seed fixa; a mesma série e as mesmas candidatas devolvem o mesmo
 * relatório hoje e daqui a um ano.
 *
 * HONESTIDADE DE DADO: número saído de série SINTÉTICA exercita a MECÂNICA e
 * não é evidência de performance. Enquanto o dataset não for histórico real do
 * ativo, todo resultado quantitativo daqui é PENDENTE_DADOS_REAIS.
 */

import type { BacktestTrade } from "@/lib/engines/backtestEngine";
import { computeStats } from "@/lib/engines/performanceEngine";
import type { Candle } from "@/lib/engines/types";
import { splitTradingDates, MIN_SPLIT_DAYS, type DatasetSplit } from "@/lib/t4/datasetSplit";

import {
  BASELINE_ID,
  BASELINE_PARAMS,
  toQuantOptions,
  type Candidate,
  type ChangedParam,
  type SweepParams,
} from "./candidates";
import { monteCarloDrawdown } from "./monteCarlo";
import { DEFAULT_MIN_TRADES } from "./ranking";
import { runQuantBacktest, tradingDateOf, type QuantResult } from "./quantBacktest";
import { buildFolds, walkForwardStability } from "./walkForward";

/**
 * VOCABULÁRIO FECHADO DE STATUS.
 *
 * Não existe "PROMOVIDA" nem "PRODUCTION" aqui — e não é convenção, é o TIPO:
 * uma variante promovida é inexprimível. Promoção é decisão do operador, em
 * outro fluxo, com credencial; a pesquisa só produz candidatas.
 */
export type SweepStatus = "CANDIDATA" | "BASELINE";

/** Régua anti-overfitting: piso e passo, iguais aos do servidor. */
export const PF_OOS_BASE = 1.3;
export const PF_OOS_STEP = 0.2;

/** Seed FIXA do Monte Carlo — pesquisa irreproduzível não é pesquisa. */
export const DEFAULT_SWEEP_SEED = 20260319;
export const DEFAULT_MONTE_CARLO_RUNS = 1000;
export const DEFAULT_FOLDS = 4;

/**
 * PF exigido FORA DA AMOSTRA em função de quantas hipóteses foram testadas
 * sobre a mesma base.
 *
 * Regra copiada de `candidateStatusProblem` (src/server/tradingEndpoints.ts),
 * inclusive o `Math.ceil` do log — a barra sobe em DEGRAUS, não continuamente.
 * Vinte variações testadas e uma "vencedora" é exatamente o cenário em que o
 * histórico engana: com 20 hipóteses o exigido vai a 2.3.
 *
 * Zero hipótese ⇒ piso 1.3 (nada foi garimpado, a régua não precisa subir).
 */
export function pfOosExigido(hipotesesTestadas: number): number {
  if (!Number.isFinite(hipotesesTestadas) || hipotesesTestadas <= 0) return PF_OOS_BASE;
  return PF_OOS_BASE + PF_OOS_STEP * Math.ceil(Math.log2(1 + Math.trunc(hipotesesTestadas)));
}

/** Métricas de UMA janela temporal. Sem trade, tudo zero e `rrMedio` null. */
export interface JanelaMetrics {
  trades: number;
  winRate: number;
  profitFactor: number;
  expectancyR: number;
  maxDrawdownR: number;
  cumulativeR: number;
  /** Média do R:R PLANEJADO dos trades (plan.riskRewardPlan). null = sem trades. */
  rrMedioPlanejado: number | null;
}

export interface EstabilidadePeriodos {
  positiveFolds: number;
  totalFolds: number;
  /** false com `totalFolds === 0` significa NÃO AVALIADO — veja `avaliado`. */
  stable: boolean;
  avaliado: boolean;
}

export interface MonteCarloResumo {
  maxDrawdownP50: number;
  maxDrawdownP95: number;
  worstLossStreakP95: number;
  ruinProbability: number;
  runs: number;
}

export interface ReguaOos {
  exigido: number;
  medido: number;
  superou: boolean;
}

export interface SweepRow {
  id: string;
  status: SweepStatus;
  isBaseline: boolean;
  params: SweepParams;
  /** Vazio SOMENTE no baseline — a candidata sempre diz o que mudou. */
  changedFrom: ChangedParam[];
  resumo: string;
  /** Treino + validação: a ÚNICA janela que pontua e ordena. */
  selecao: JanelaMetrics;
  /** Fora da amostra: declarado e usado como VETO, nunca para escolher. */
  oos: JanelaMetrics;
  walkForward: EstabilidadePeriodos;
  monteCarlo: MonteCarloResumo;
  score: number;
  elegivel: boolean;
  /** Só true com amostra, divisão temporal E régua anti-overfitting vencidas. */
  conclusaoAutorizada: boolean;
  /** null no baseline: referência não é hipótese, a régua não se aplica a ele. */
  reguaOos: ReguaOos | null;
  /** Por que a conclusão não está autorizada. Vazio quando está. */
  motivos: string[];
  cobertura: {
    setupsDetected: number;
    candlesProcessed: number;
    discards: Record<string, number>;
    /** Trades sem `tradingDate` — declarados, nunca jogados na seleção. */
    tradesSemData: number;
  };
}

export interface SweepOptions {
  asset: string;
  /** Candidatas de `buildCandidates`. O baseline é adicionado sempre. */
  candidates: Candidate[];
  minTrades?: number;
  monteCarloRuns?: number;
  seed?: number;
  folds?: number;
}

export interface SweepContext {
  asset: string;
  split: DatasetSplit | null;
  /** Motivo declarado quando a divisão temporal não foi possível. */
  splitProblem: string | null;
  datasSelecao: ReadonlySet<string>;
  datasOos: ReadonlySet<string>;
  pregoes: number;
  minTrades: number;
  seed: number;
  monteCarloRuns: number;
  folds: number;
  hipotesesTestadas: number;
  pfOosExigido: number;
}

export interface SweepReport {
  contexto: SweepContext;
  /** Ordenadas: elegíveis primeiro, depois score de SELEÇÃO. Baseline incluído. */
  rows: SweepRow[];
}

/** Uma linha a executar: baseline ou candidata. */
export interface SweepVariant {
  id: string;
  status: SweepStatus;
  params: SweepParams;
  changedFrom: ChangedParam[];
  resumo: string;
}

/** O baseline é MONTADO, nunca alterado: sempre os parâmetros de produção. */
export function baselineVariant(): SweepVariant {
  return {
    id: BASELINE_ID,
    status: "BASELINE",
    params: { ...BASELINE_PARAMS },
    changedFrom: [],
    resumo: "técnica de produção — referência imutável do ranking",
  };
}

/** Baseline primeiro, candidatas na ordem determinística em que nasceram. */
export function sweepVariants(candidates: Candidate[]): SweepVariant[] {
  return [
    baselineVariant(),
    ...candidates.map((c): SweepVariant => ({
      id: c.id,
      status: "CANDIDATA",
      params: c.params,
      changedFrom: c.changedFrom,
      resumo: c.resumo,
    })),
  ];
}

/** Roda UMA variante pelo pipeline headless. Exportada para o teste anti-leakage. */
export function runCandidateBacktest(
  candles: Candle[],
  params: SweepParams,
  asset: string,
): QuantResult {
  return runQuantBacktest(candles, toQuantOptions(params, asset));
}

function metricsOf(trades: BacktestTrade[]): JanelaMetrics {
  const stats = computeStats(trades);
  const rrs = trades.map((t) => t.riskReward).filter((rr) => Number.isFinite(rr));
  return {
    trades: stats.total,
    winRate: stats.winRate,
    profitFactor: stats.profitFactor,
    expectancyR: stats.expectancy,
    maxDrawdownR: stats.maxDrawdown,
    cumulativeR: stats.cumulativeR,
    // Ausência é valor: sem trade não existe R:R médio — não é zero.
    rrMedioPlanejado: rrs.length > 0 ? rrs.reduce((a, rr) => a + rr, 0) / rrs.length : null,
  };
}

// ---------------------------------------------------------------------------
// SCORE DE SELEÇÃO
//
// Mesmos pesos de `ranking.ts` — MENOS o termo de OOS, e a ausência dele é
// deliberada: se o fora-da-amostra entrasse no score, ele viraria mais um
// número a otimizar e deixaria de ser fora-da-amostra. A assinatura desta
// função não aceita métrica de OOS: a garantia é de TIPO, não de disciplina.
//
//   score = 2.0·ln(PF*)            PF em log, PF* = clamp(PF, 0.05, 10)
//         + 1.5·expectancyR        expectância média por trade, em R
//         − 0.08·|maxDrawdownR|    pedágio linear por R de drawdown
//         ± 0.5 estabilidade       +0.5 estável; −0.5 instável; 0 não avaliado
//         + 0.3·log10(1+trades)    amostra em log
// ---------------------------------------------------------------------------
const PF_CAP = 10;
const PF_FLOOR = 0.05;
const PF_LOG_WEIGHT = 2.0;
const EXPECTANCY_WEIGHT = 1.5;
const DRAWDOWN_WEIGHT = 0.08;
const STABILITY_TERM = 0.5;
const SAMPLE_WEIGHT = 0.3;

export function pontuarSelecao(m: JanelaMetrics, estavel: boolean | null): number {
  if (!Number.isFinite(m.expectancyR) || !Number.isFinite(m.maxDrawdownR)) {
    // Métrica podre não vira score "aproximado": sai da disputa declarada.
    return Number.NEGATIVE_INFINITY;
  }
  // PF infinito = nenhuma perda na amostra, quase sempre amostra curta demais
  // para ter perdido. Entra pelo teto, nunca cru.
  const pf = Number.isFinite(m.profitFactor) ? m.profitFactor : PF_CAP;
  const pfClamped = Math.min(PF_CAP, Math.max(PF_FLOOR, pf));

  let score = PF_LOG_WEIGHT * Math.log(pfClamped);
  score += EXPECTANCY_WEIGHT * m.expectancyR;
  score -= DRAWDOWN_WEIGHT * Math.abs(m.maxDrawdownR);
  if (estavel === true) score += STABILITY_TERM;
  else if (estavel === false) score -= STABILITY_TERM;
  score += SAMPLE_WEIGHT * Math.log10(1 + Math.max(0, m.trades));
  return score;
}

/**
 * Ordenação determinística: elegíveis primeiro (amostra pequena NUNCA vence
 * disputa), depois score de seleção, depois amostra, depois id.
 */
export function ordenarLinhas(rows: SweepRow[]): SweepRow[] {
  return [...rows].sort((a, b) => {
    if (a.elegivel !== b.elegivel) return a.elegivel ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    if (b.selecao.trades !== a.selecao.trades) return b.selecao.trades - a.selecao.trades;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Prepara o contexto comum: divisão temporal por pregão e a régua de
 * overfitting já calculada com o número de hipóteses DESTE sweep.
 *
 * Sem pregões suficientes (`MIN_SPLIT_DAYS`) a divisão NÃO acontece: o motivo
 * fica declarado em `splitProblem`, a janela de seleção passa a ser todo o
 * período e NENHUMA variante terá conclusão autorizada. Dividir 6 dias em três
 * fatias produziria uma "validação" de um dia que valida nada e parece método.
 */
export function prepararSweep(candles: Candle[], options: SweepOptions): SweepContext {
  const datas = [...new Set(candles.map((c) => tradingDateOf(c.t)))].sort();
  const split = splitTradingDates(datas);

  const datasSelecao = new Set<string>(
    split ? [...split.treino.dates, ...split.validacao.dates] : datas,
  );
  const datasOos = new Set<string>(split ? split.oos.dates : []);
  const hipotesesTestadas = options.candidates.length;

  return {
    asset: options.asset,
    split,
    splitProblem:
      split === null
        ? `apenas ${datas.length} pregão(ões) no dataset — divisão treino/validação/OOS exige ` +
          `${MIN_SPLIT_DAYS}; sem ela o fora-da-amostra não existe e nenhuma conclusão é autorizada`
        : null,
    datasSelecao,
    datasOos,
    pregoes: datas.length,
    minTrades: Math.max(1, Math.trunc(options.minTrades ?? DEFAULT_MIN_TRADES)),
    seed: options.seed ?? DEFAULT_SWEEP_SEED,
    monteCarloRuns: Math.max(1, Math.trunc(options.monteCarloRuns ?? DEFAULT_MONTE_CARLO_RUNS)),
    folds: Math.max(1, Math.trunc(options.folds ?? DEFAULT_FOLDS)),
    hipotesesTestadas,
    pfOosExigido: pfOosExigido(hipotesesTestadas),
  };
}

/**
 * Roda UMA variante e monta a linha do ranking.
 *
 * ORDEM DAS OPERAÇÕES (importa): o backtest roda sobre a série INTEIRA, uma
 * vez, e os trades são particionados DEPOIS pela data do pregão. Rodar fatia
 * por fatia daria a cada fatia um aquecimento próprio e mediria outra coisa —
 * e não seria mais seguro: o pipeline é causal por construção, então um trade
 * do OOS já foi decidido só com o passado dele.
 */
export function runSweepVariant(
  candles: Candle[],
  variante: SweepVariant,
  ctx: SweepContext,
): SweepRow {
  const resultado = runCandidateBacktest(candles, variante.params, ctx.asset);

  const selecaoTrades: BacktestTrade[] = [];
  const oosTrades: BacktestTrade[] = [];
  let tradesSemData = 0;
  for (const trade of resultado.trades) {
    const data = trade.tradingDate;
    if (!data) {
      // Sem data não dá para saber a que fatia pertence. Declarado e fora das
      // duas — jogá-lo na seleção seria contaminar a amostra por conveniência.
      tradesSemData += 1;
      continue;
    }
    if (ctx.datasOos.has(data)) oosTrades.push(trade);
    else if (ctx.datasSelecao.has(data)) selecaoTrades.push(trade);
    else tradesSemData += 1;
  }

  const selecao = metricsOf(selecaoTrades);
  const oos = metricsOf(oosTrades);

  /*
   * WALK-FORWARD SÓ NA JANELA DE SELEÇÃO. Se os folds cobrissem o período
   * inteiro, o teste do último fold cairia dentro do OOS — e o fora-da-amostra
   * teria participado da avaliação por via indireta.
   */
  const temposSelecao = candles
    .map((c) => c.t)
    .filter((t) => ctx.datasSelecao.has(tradingDateOf(t)));
  const folds = buildFolds(temposSelecao, ctx.folds);
  const foldResults = folds.map((fold) => {
    // O trade pertence ao fold pelo instante da DECISÃO (`signalAt`): é ele que
    // diz em que período a técnica se comportou daquele jeito.
    const noFold = selecaoTrades.filter((t) => {
      const at = t.signalAt ?? t.openedAt;
      return at >= fold.testStart && at <= fold.testEnd;
    });
    return { trades: noFold.length, netR: noFold.reduce((a, t) => a + t.rMultiple, 0) };
  });
  const estabilidade = walkForwardStability(foldResults);
  const walkForward: EstabilidadePeriodos = {
    positiveFolds: estabilidade.positiveFolds,
    totalFolds: estabilidade.totalFolds,
    stable: estabilidade.stable,
    avaliado: estabilidade.totalFolds > 0,
  };

  const monteCarlo = monteCarloDrawdown(
    selecaoTrades.map((t) => t.rMultiple),
    ctx.monteCarloRuns,
    ctx.seed,
  );

  const score = pontuarSelecao(selecao, walkForward.avaliado ? walkForward.stable : null);

  const motivos: string[] = [];
  const elegivel = selecao.trades >= ctx.minTrades;
  if (!elegivel) {
    motivos.push(
      `amostra insuficiente — conclusão NÃO autorizada (${selecao.trades} < ${ctx.minTrades} trades na janela de seleção)`,
    );
  }
  if (ctx.splitProblem !== null) motivos.push(ctx.splitProblem);
  if (!walkForward.avaliado) {
    motivos.push("walk-forward não avaliado — série curta demais para folds");
  } else if (!walkForward.stable) {
    motivos.push(
      `walk-forward INSTÁVEL (${walkForward.positiveFolds}/${walkForward.totalFolds} folds positivos)`,
    );
  }

  /*
   * RÉGUA ANTI-OVERFITTING — só para CANDIDATA. O baseline não é hipótese
   * garimpada: ele é a técnica que já estava lá, e a régua existe para punir
   * garimpo. Aplicá-la ao baseline mediria o baseline pelo número de tentativas
   * que outra pessoa fez.
   */
  let reguaOos: ReguaOos | null = null;
  if (variante.status === "CANDIDATA") {
    const medido = oos.profitFactor;
    const superou = Number.isFinite(medido)
      ? medido >= ctx.pfOosExigido
      : // PF infinito = OOS sem NENHUMA perda. Só conta como superação se houve
        // trade; OOS vazio tem PF 0 e reprova pelo caminho normal.
        oos.trades > 0;
    reguaOos = { exigido: ctx.pfOosExigido, medido, superou };
    if (!superou) {
      motivos.push(
        oos.trades === 0
          ? `sem trade no fora-da-amostra — régua anti-overfitting (PF ≥ ${ctx.pfOosExigido.toFixed(2)}) não pode ser verificada`
          : `PF fora da amostra ${medido.toFixed(2)} abaixo do exigido ${ctx.pfOosExigido.toFixed(2)} — ` +
              `${ctx.hipotesesTestadas} hipótese(s) testada(s) elevam a régua`,
      );
    }
  }

  const conclusaoAutorizada =
    elegivel &&
    ctx.splitProblem === null &&
    walkForward.avaliado &&
    walkForward.stable &&
    (reguaOos === null || reguaOos.superou);

  return {
    id: variante.id,
    status: variante.status,
    isBaseline: variante.status === "BASELINE",
    params: variante.params,
    changedFrom: variante.changedFrom,
    resumo: variante.resumo,
    selecao,
    oos,
    walkForward,
    monteCarlo,
    score,
    elegivel,
    conclusaoAutorizada,
    reguaOos,
    motivos,
    cobertura: {
      setupsDetected: resultado.setupsDetected,
      candlesProcessed: resultado.candlesProcessed,
      discards: resultado.discards,
      tradesSemData,
    },
  };
}

/**
 * Sweep completo: baseline + candidatas, medidos e ordenados.
 *
 * Nada aqui promove nada. A saída é uma tabela de CANDIDATAS com o baseline
 * como referência — a decisão de trocar a técnica de produção continua sendo do
 * operador, em outro fluxo, com credencial.
 */
export function runParamSweep(candles: Candle[], options: SweepOptions): SweepReport {
  const contexto = prepararSweep(candles, options);
  const rows = sweepVariants(options.candidates).map((variante) =>
    runSweepVariant(candles, variante, contexto),
  );
  return { contexto, rows: ordenarLinhas(rows) };
}
