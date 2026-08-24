/**
 * PERFORMANCE SEGMENTADA DO DNA — onde a vantagem realmente mora.
 *
 * Este módulo responde três perguntas, sempre com a amostra na frente:
 *
 *   1. Como cada contexto performa? (nota, tendência, pullback, gatilho…)
 *   2. Por que as perdedoras perderam? (associação estatística, não causa)
 *   3. Que esquema de saída o MFE/MAE das MESMAS operações sustenta?
 *
 * A REGRA QUE ATRAVESSA O ARQUIVO: amostra insuficiente nunca vira conclusão.
 * As métricas são calculadas e exibidas, mas carregam `sufficient: false` e a
 * frase que impede alguém de agir sobre elas. Esconder o número seria pior —
 * o operador precisa VER que são 4 casos, não 400.
 *
 * O que este módulo NUNCA faz: bloquear setup, alterar regra, escolher filtro.
 * Ele produz leitura; quem muda técnica é o Laboratório, com validação fora
 * da amostra.
 */

import type { DnaGrade, SetupDna } from "./dna";

/** Um DNA casado com o desfecho — ou sem desfecho (setup sem operação). */
export interface DnaOutcome {
  dna: SetupDna;
  /** Null = setup detectado sem operação (DESCARTADA, no-trade, aguardando). */
  rMultiple: number | null;
  mfeR: number | null;
  maeR: number | null;
  /** Custo da operação em R, quando conversível. Null nunca vira zero. */
  costR: number | null;
  resultMoney: number | null;
  /**
   * Patamar em R comprovadamente alcançado ANTES do stop (parcial realizada).
   * Torna conhecível a ordem intra-trade que MFE/MAE sozinhos não revelam.
   * Null quando não houve parcial ou o dado não foi gravado.
   */
  partialReachedR?: number | null;
}

/**
 * Abaixo disto, nada é vantagem — é ruído com cara de padrão. 30 é o corte
 * clássico para a média começar a se comportar; segue exibido, nunca conclusivo.
 */
export const MIN_SEGMENT_SAMPLE = 30;

export interface SegmentMetrics {
  dimension: string;
  value: string;
  /** DNAs detectados no segmento, com ou sem operação. */
  detected: number;
  /** Operações com resultado — é sobre elas que as métricas falam. */
  sample: number;
  wins: number;
  losses: number;
  neutrals: number;
  winRate: number | null;
  lossRate: number | null;
  expectancyR: number | null;
  payoff: number | null;
  profitFactor: number | null;
  maxDrawdownR: number | null;
  mfeMeanR: number | null;
  mfeMedianR: number | null;
  maeMeanR: number | null;
  maeMedianR: number | null;
  netR: number | null;
  /** Líquido descontando custo onde ele existe; `costsCovered` diz onde. */
  netAfterCostsR: number | null;
  costsCovered: number;
  sufficient: boolean;
  note: string;
  /** Por que o líquido após custos existe (ou não). Null sem operações. */
  costNote: string | null;
}

export interface DnaDimension {
  key: string;
  label: string;
  valueOf: (dna: SetupDna) => string;
}

/** Faixa horária de 1h — granularidade que o pregão de 9h–18h sustenta. */
function hourBand(hour: number | null): string {
  if (hour === null) return "SEM_HORA";
  return `${String(hour).padStart(2, "0")}h`;
}

/** As dimensões do §3, cada uma lendo um campo já classificado do DNA. */
export const DNA_DIMENSIONS: DnaDimension[] = [
  { key: "grade", label: "Nota", valueOf: (d) => d.grade },
  { key: "direction", label: "Direção", valueOf: (d) => d.direction },
  { key: "position", label: "Posição vs tendência", valueOf: (d) => d.position },
  { key: "trend", label: "Tendência", valueOf: (d) => d.trend },
  { key: "pullback", label: "Pullback", valueOf: (d) => d.pullback },
  { key: "triggerCandle", label: "Candle gatilho", valueOf: (d) => d.triggerCandle },
  {
    key: "movementOrdinal",
    label: "T4 do movimento",
    valueOf: (d) =>
      d.movementOrdinal === null
        ? "SEM_ORDINAL"
        : d.movementOrdinal >= 4
          ? "POSTERIOR"
          : `${d.movementOrdinal}a`,
  },
  { key: "volatility", label: "Volatilidade", valueOf: (d) => d.volatility ?? "SEM_LEITURA" },
  { key: "location", label: "Localização", valueOf: (d) => d.location },
  { key: "asset", label: "Ativo", valueOf: (d) => d.asset },
  { key: "timeframe", label: "Timeframe", valueOf: (d) => d.timeframe },
  { key: "hour", label: "Faixa horária", valueOf: (d) => hourBand(d.hour) },
];

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return Number(value.toFixed(3));
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Number((values.reduce((sum, v) => sum + v, 0) / values.length).toFixed(3));
}

const round3 = (value: number) => Number(value.toFixed(3));

/** Métricas de um grupo já separado. Ordena por instante para o drawdown. */
export function metricsFor(dimension: string, value: string, rows: DnaOutcome[]): SegmentMetrics {
  const resolved = rows
    .filter((row) => row.rMultiple !== null)
    .sort((a, b) => a.dna.detectedAt - b.dna.detectedAt);
  const rs = resolved.map((row) => row.rMultiple!);

  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r < 0);
  const neutrals = rs.filter((r) => r === 0);
  const grossWin = wins.reduce((a, r) => a + r, 0);
  const grossLoss = Math.abs(losses.reduce((a, r) => a + r, 0));

  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const r of rs) {
    equity += r;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }

  /*
   * LÍQUIDO SÓ EXISTE SE O CUSTO EXISTE EM TODAS AS OPERAÇÕES DO GRUPO.
   *
   * Somar `rMultiple - (costR ?? 0)` faria o custo desconhecido valer ZERO
   * dentro de um número rotulado "líquido após custos" — exatamente o "zero
   * disfarçado" que a casa proíbe. Com custo parcial, o campo é null e
   * `costsCovered` diz de quantas operações o custo é conhecido.
   */
  const withCost = resolved.filter((row) => row.costR !== null);
  const netAfterCosts =
    resolved.length > 0 && withCost.length === resolved.length
      ? round3(resolved.reduce((sum, row) => sum + row.rMultiple! - row.costR!, 0))
      : null;

  const sample = resolved.length;
  const sufficient = sample >= MIN_SEGMENT_SAMPLE;

  return {
    dimension,
    value,
    detected: rows.length,
    sample,
    wins: wins.length,
    losses: losses.length,
    neutrals: neutrals.length,
    winRate: sample > 0 ? round3((wins.length / sample) * 100) : null,
    lossRate: sample > 0 ? round3((losses.length / sample) * 100) : null,
    expectancyR: sample > 0 ? round3(equity / sample) : null,
    payoff:
      wins.length > 0 && losses.length > 0
        ? round3(grossWin / wins.length / (grossLoss / losses.length))
        : null,
    profitFactor: grossLoss > 0 ? round3(grossWin / grossLoss) : grossWin > 0 ? Infinity : null,
    maxDrawdownR: sample > 0 ? round3(maxDrawdown) : null,
    mfeMeanR: mean(resolved.map((r) => r.mfeR).filter((v): v is number => v !== null)),
    mfeMedianR: median(resolved.map((r) => r.mfeR).filter((v): v is number => v !== null)),
    maeMeanR: mean(resolved.map((r) => r.maeR).filter((v): v is number => v !== null)),
    maeMedianR: median(resolved.map((r) => r.maeR).filter((v): v is number => v !== null)),
    netR: sample > 0 ? round3(equity) : null,
    netAfterCostsR: netAfterCosts,
    costsCovered: withCost.length,
    sufficient,
    note: sufficient
      ? `${sample} operações — métricas utilizáveis`
      : `amostra insuficiente (${sample}/${MIN_SEGMENT_SAMPLE}) — leitura exibida, conclusão NÃO autorizada`,
    costNote:
      resolved.length === 0
        ? null
        : withCost.length === resolved.length
          ? `custo conhecido nas ${withCost.length} operações`
          : `líquido após custos indisponível: custo conhecido em ${withCost.length}/${resolved.length} operações`,
  };
}

/** Segmenta por UMA dimensão. Valores ordenados por amostra. */
export function segmentBy(rows: DnaOutcome[], dimension: DnaDimension): SegmentMetrics[] {
  const groups = new Map<string, DnaOutcome[]>();
  for (const row of rows) {
    const value = dimension.valueOf(row.dna);
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value)!.push(row);
  }
  return [...groups.entries()]
    .map(([value, list]) => metricsFor(dimension.key, value, list))
    .sort((a, b) => b.sample - a.sample);
}

/** Todas as dimensões do §3 de uma vez — a matriz completa do painel. */
export function allSegments(rows: DnaOutcome[]): Record<string, SegmentMetrics[]> {
  const out: Record<string, SegmentMetrics[]> = {};
  for (const dimension of DNA_DIMENSIONS) out[dimension.key] = segmentBy(rows, dimension);
  return out;
}

/* ------------------------------------------------------------------------ *
 * DESCOBERTA — combinações com amostra que sustentam leitura.
 * ------------------------------------------------------------------------ */

export interface PatternFinding {
  /** Ex.: "grade=A_PLUS · direction=VENDA · movementOrdinal=1a" */
  pattern: string;
  parts: { dimension: string; value: string }[];
  metrics: SegmentMetrics;
  /** SEMPRE sugestão para o Laboratório — nunca bloqueio automático. */
  suggestion: string;
}

/** Dimensões que participam da descoberta combinatória (pares e trios). */
const DISCOVERY_KEYS = [
  "grade",
  "direction",
  "position",
  "trend",
  "pullback",
  "triggerCandle",
  "movementOrdinal",
  "volatility",
] as const;

function combinations<T>(items: T[], size: number): T[][] {
  if (size === 0) return [[]];
  if (items.length < size) return [];
  const [head, ...rest] = items;
  const withHead = combinations(rest, size - 1).map((combo) => [head!, ...combo]);
  return [...withHead, ...combinations(rest, size)];
}

/**
 * Varre pares e trios de dimensões e devolve os padrões COM amostra
 * suficiente, ordenados pela força da leitura (|expectancy| primeiro).
 *
 * Padrões negativos também saem — saber onde NÃO há vantagem vale tanto
 * quanto o contrário. O texto termina sempre em sugestão para o Laboratório:
 * a descoberta nunca altera regra sozinha (§13).
 */
export function discoverPatterns(
  rows: DnaOutcome[],
  options: { minSample?: number; maxDepth?: 2 | 3 } = {},
): PatternFinding[] {
  const minSample = options.minSample ?? MIN_SEGMENT_SAMPLE;
  const maxDepth = options.maxDepth ?? 2;
  const dimensions = DNA_DIMENSIONS.filter((d) =>
    (DISCOVERY_KEYS as readonly string[]).includes(d.key),
  );

  const findings: PatternFinding[] = [];
  const depths = maxDepth === 3 ? [2, 3] : [2];
  for (const depth of depths) {
    for (const combo of combinations(dimensions, depth)) {
      const groups = new Map<string, DnaOutcome[]>();
      for (const row of rows) {
        const key = combo.map((d) => `${d.key}=${d.valueOf(row.dna)}`).join(" · ");
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(row);
      }
      for (const [pattern, list] of groups) {
        const resolved = list.filter((r) => r.rMultiple !== null);
        if (resolved.length < minSample) continue;
        const metrics = metricsFor("combo", pattern, list);
        const positive = (metrics.expectancyR ?? 0) > 0;
        findings.push({
          pattern,
          parts: combo.map((d, i) => ({
            dimension: d.key,
            value: pattern.split(" · ")[i]!.split("=")[1]!,
          })),
          metrics,
          suggestion: positive
            ? `Contexto com expectância positiva (${metrics.expectancyR}R em ${metrics.sample} operações). Sugestão: criar candidata no Laboratório priorizando este contexto e validar fora da amostra.`
            : `Contexto com expectância ${metrics.expectancyR}R em ${metrics.sample} operações. Sugestão: criar candidata no Laboratório que trate este contexto e validar fora da amostra. NÃO bloquear automaticamente.`,
        });
      }
    }
  }

  return findings.sort(
    (a, b) => Math.abs(b.metrics.expectancyR ?? 0) - Math.abs(a.metrics.expectancyR ?? 0),
  );
}

/* ------------------------------------------------------------------------ *
 * POR QUE PERDEU — associação estatística, dita como associação.
 * ------------------------------------------------------------------------ */

export interface LossFactor {
  dimension: string;
  value: string;
  /** % das perdedoras em que o fator aparece. */
  inLossesPct: number;
  /** % das vencedoras em que o fator aparece. */
  inWinsPct: number;
  /** inLosses/inWins — acima de 1, o fator sobre-representa perdas. */
  lift: number;
  losses: number;
  wins: number;
  note: string;
  /** Mesma régua das demais seções: abaixo dela é leitura, não conclusão. */
  sufficient: boolean;
}

/**
 * Fatores associados às perdas: em que dimensões as perdedoras diferem das
 * vencedoras. Lift alto é ASSOCIAÇÃO — o texto nunca afirma causa (§5).
 */
export function lossFactorTable(rows: DnaOutcome[], minCases = 5): LossFactor[] {
  const losses = rows.filter((r) => r.rMultiple !== null && r.rMultiple < 0);
  const wins = rows.filter((r) => r.rMultiple !== null && r.rMultiple > 0);
  if (losses.length === 0 || wins.length === 0) return [];

  const factors: LossFactor[] = [];
  for (const dimension of DNA_DIMENSIONS) {
    const values = new Set(rows.map((r) => dimension.valueOf(r.dna)));
    for (const value of values) {
      const inLosses = losses.filter((r) => dimension.valueOf(r.dna) === value).length;
      const inWins = wins.filter((r) => dimension.valueOf(r.dna) === value).length;
      if (inLosses < minCases) continue;
      const inLossesPct = (inLosses / losses.length) * 100;
      const inWinsPct = (inWins / wins.length) * 100;
      const lift = inWinsPct > 0 ? inLossesPct / inWinsPct : Infinity;
      if (lift <= 1.25) continue; // só o que sobre-representa perda com folga
      factors.push({
        dimension: dimension.key,
        value,
        inLossesPct: round3(inLossesPct),
        inWinsPct: round3(inWinsPct),
        lift: Number.isFinite(lift) ? round3(lift) : Infinity,
        losses: inLosses,
        wins: inWins,
        // A régua é a MESMA das tabelas segmentadas: proteger o operador de
        // concluir com 30 casos e deixá-lo concluir com 5 na seção seguinte
        // seria uma inconsistência que a UI não tem como consertar.
        sufficient: losses.length >= MIN_SEGMENT_SAMPLE,
        note:
          `${dimension.label}=${value} aparece em ${inLossesPct.toFixed(0)}% das perdedoras vs ` +
          `${inWinsPct.toFixed(0)}% das vencedoras (${inLosses}/${losses.length} perdas). ` +
          `Associação estatística — não é afirmação de causa.` +
          (losses.length < MIN_SEGMENT_SAMPLE
            ? ` AMOSTRA INSUFICIENTE: ${losses.length}/${MIN_SEGMENT_SAMPLE} perdas — leitura exibida, conclusão NÃO autorizada.`
            : ""),
      });
    }
  }
  return factors.sort((a, b) => b.lift - a.lift);
}

export interface SimilarWinner {
  outcome: DnaOutcome;
  matching: number;
  differing: { dimension: string; loser: string; winner: string }[];
}

/**
 * Vencedoras mais parecidas com uma perdedora — o §5 pede exatamente esta
 * comparação: o que as vencedoras do MESMO contexto tinham de diferente.
 */
export function similarWinners(loser: DnaOutcome, rows: DnaOutcome[], limit = 3): SimilarWinner[] {
  const wins = rows.filter((r) => r.rMultiple !== null && r.rMultiple > 0);
  return wins
    .map((winner) => {
      const differing: SimilarWinner["differing"] = [];
      let matching = 0;
      for (const dimension of DNA_DIMENSIONS) {
        const a = dimension.valueOf(loser.dna);
        const b = dimension.valueOf(winner.dna);
        if (a === b) matching += 1;
        else differing.push({ dimension: dimension.key, loser: a, winner: b });
      }
      return { outcome: winner, matching, differing };
    })
    .sort((a, b) => b.matching - a.matching)
    .slice(0, limit);
}

/* ------------------------------------------------------------------------ *
 * OTIMIZAÇÃO DE SAÍDA — o que o MFE/MAE das mesmas entradas sustenta.
 * ------------------------------------------------------------------------ */

export interface ExitSchemeResult {
  scheme: string;
  targetR: number | null;
  sample: number;
  wins: number;
  winRate: number | null;
  expectancyR: number | null;
  profitFactor: number | null;
  /** Casos em que MFE≥alvo E MAE≤-1 sem ordem conhecida: contados como stop. */
  ambiguous: number;
  /** Operações que encerraram ANTES deste alvo — o valor é piso, não medida. */
  truncatedByExit: number;
  note: string;
}

export const EXIT_TARGETS_R = [1, 1.5, 2, 2.5, 3, 4, 5] as const;

/**
 * Compara alvos fixos contra o gerenciamento real, usando o MFE/MAE das
 * MESMAS operações — nunca amostras diferentes por esquema (§10).
 *
 * AMBIGUIDADE, E QUANDO ELA NÃO EXISTE: com MFE ≥ alvo e MAE ≤ -1 na mesma
 * operação, a ordem intra-trade normalmente não está gravada e o caso conta
 * como STOP (conservador, igual ao tratamento intrabar do backtest). MAS
 * quando a parcial foi realizada — `partialReachedR` conhecido — todo alvo
 * ATÉ esse patamar comprovadamente ocorreu ANTES do stop, porque o tracker só
 * move o stop depois da parcial. Nesses casos a ordem É conhecida, e contar
 * como stop deprimia sistematicamente os alvos curtos exatamente onde eles
 * ganham. `ambiguous` conta apenas o que sobrou de fato ambíguo.
 *
 * LIMITE QUE NÃO DÁ PARA CONTORNAR: MFE/MAE são medidos até a saída REAL. Um
 * alvo mais alto que o ponto onde a operação encerrou nunca pode ser
 * confirmado, mesmo que o mercado tenha seguido — por isso alvos acima do MFE
 * observado usam o encerramento real e o resultado sai marcado em
 * `truncatedByExit`. A comparação é justa entre alvos ATÉ o MFE observado;
 * acima dele é piso, não medida.
 *
 * Trailing estrutural e break-even NÃO são computáveis só com MFE/MAE (exigem
 * a trajetória candle a candle, que os trades não gravam hoje) — e por isso
 * não aparecem aqui com número. Fingir seria pior que faltar.
 */
export function compareExitSchemes(rows: DnaOutcome[]): ExitSchemeResult[] {
  const resolved = rows.filter((r) => r.rMultiple !== null && r.mfeR !== null && r.maeR !== null);
  const out: ExitSchemeResult[] = [];

  for (const target of EXIT_TARGETS_R) {
    let equity = 0;
    let grossWin = 0;
    let grossLoss = 0;
    let wins = 0;
    let ambiguous = 0;
    let truncatedByExit = 0;
    for (const row of resolved) {
      const reachedTarget = row.mfeR! >= target;
      const reachedStop = row.maeR! <= -1;
      // Parcial realizada prova que o preço passou por ela ANTES do stop.
      const provenBeforeStop =
        row.partialReachedR !== null &&
        row.partialReachedR !== undefined &&
        target <= row.partialReachedR;
      let r: number;
      if (reachedTarget && (!reachedStop || provenBeforeStop)) {
        r = target;
      } else if (reachedTarget && reachedStop) {
        // Ordem desconhecida: stop primeiro, e o caso é contado como ambíguo.
        ambiguous += 1;
        r = -1;
      } else if (reachedStop) {
        r = -1;
      } else {
        // Nem alvo nem stop: vale o encerramento real registrado. Se o alvo
        // ficou acima do MFE observado, isto é piso — a operação encerrou
        // antes e não há como saber se o mercado teria chegado lá.
        if (target > row.mfeR!) truncatedByExit += 1;
        r = row.rMultiple!;
      }
      equity += r;
      if (r > 0) {
        wins += 1;
        grossWin += r;
      } else if (r < 0) {
        grossLoss += Math.abs(r);
      }
    }
    const sample = resolved.length;
    out.push({
      scheme: `ALVO ${target}R (saída única)`,
      targetR: target,
      sample,
      wins,
      winRate: sample > 0 ? round3((wins / sample) * 100) : null,
      expectancyR: sample > 0 ? round3(equity / sample) : null,
      profitFactor: grossLoss > 0 ? round3(grossWin / grossLoss) : grossWin > 0 ? Infinity : null,
      ambiguous,
      truncatedByExit,
      note: [
        ambiguous > 0
          ? `${ambiguous} operação(ões) com alvo E stop alcançados sem ordem gravada — contadas como stop (conservador).`
          : "Sem ambiguidade MFE/MAE nesta configuração.",
        truncatedByExit > 0
          ? `${truncatedByExit} operação(ões) encerraram antes deste alvo: valor é PISO, não medida — o mercado depois da saída real não foi observado.`
          : null,
      ]
        .filter(Boolean)
        .join(" "),
    });
  }

  // O gerenciamento real (parcial 3R/5R/runner) é a linha de base.
  const realized = resolved.map((r) => r.rMultiple!);
  const realizedWins = realized.filter((r) => r > 0);
  const realizedLoss = Math.abs(realized.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const realizedWinSum = realizedWins.reduce((a, b) => a + b, 0);
  out.push({
    scheme: "GERENCIAMENTO ATUAL (parcial 3R · 5R · runner)",
    targetR: null,
    sample: resolved.length,
    wins: realizedWins.length,
    winRate: resolved.length > 0 ? round3((realizedWins.length / resolved.length) * 100) : null,
    expectancyR:
      resolved.length > 0 ? round3(realized.reduce((a, b) => a + b, 0) / resolved.length) : null,
    profitFactor:
      realizedLoss > 0
        ? round3(realizedWinSum / realizedLoss)
        : realizedWinSum > 0
          ? Infinity
          : null,
    ambiguous: 0,
    // A linha de base é o que de fato aconteceu: nada nela é extrapolado.
    truncatedByExit: 0,
    note: "Resultado realmente registrado das mesmas operações — linha de base da comparação.",
  });

  return out;
}
