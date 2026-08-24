/**
 * SHADOW MODE — registro do que a técnica TERIA feito, sem tocar em nada.
 *
 * RAZÃO DE EXISTIR: trocar a técnica de produção por uma candidata só é honesto
 * depois de ver as duas decidindo sobre o MESMO mercado, no mesmo instante, com
 * amostra suficiente. Este módulo produz esse registro paralelo.
 *
 * RESTRIÇÃO CENTRAL — SHADOW NUNCA DISPARA SINAL OPERACIONAL. É por isso que
 * `ShadowDecision` não tem campo "executar", "enviar" ou "ordem", e por isso o
 * módulo não importa, não conhece e não devolve nada relacionado a execução.
 * O que sai daqui é OBSERVAÇÃO: "nesse minuto a candidata teria comprado a
 * 120.000 e a produção teria ficado de fora". Quem lê é humano.
 *
 * RESTRIÇÃO DE AMOSTRA — nenhuma conclusão sai abaixo de MIN_SHADOW_SAMPLE
 * desfechos por versão. Declarar uma candidata melhor com 4 trades é ruído
 * apresentado como evidência, o erro que este módulo existe para impedir.
 *
 * RESTRIÇÃO DE PROMOÇÃO — `podePromover` apenas RESPONDE se o gate passou.
 * Não existe promoção automática aqui: quem promove uma técnica é o operador.
 *
 * Determinístico: sem `Date.now()`, sem `Math.random()`. Mesmas entradas ⇒
 * mesma comparação, hoje e no replay de amanhã.
 */

export type ShadowDirection = "COMPRA" | "VENDA" | "NEUTRO";

export interface ShadowDecision {
  at: number;
  /** "T4-PRODUCAO" (baseline) ou o id da técnica candidata. */
  versionId: string;
  wouldEnter: boolean;
  direction: ShadowDirection;
  entry: number | null;
  stop: number | null;
  target: number | null;
  /** Por que entraria — ou por que NÃO entraria. Sempre preenchido. */
  reason: string;
}

/** Leitura crua entregue ao registrador, antes da validação do contrato. */
export interface ShadowReading {
  at: number;
  versionId: string;
  wouldEnter: boolean;
  direction: ShadowDirection;
  entry: number | null;
  stop: number | null;
  target: number | null;
  reason: string;
}

/**
 * Desfecho conhecido de uma decisão sombra, em múltiplos de risco (R).
 * `resultR: null` = operação ainda em aberto ou sem desfecho apurado — e nesse
 * caso ela NÃO entra na amostra (ver `compareShadow`).
 */
export interface ShadowOutcome {
  at: number;
  versionId: string;
  resultR: number | null;
}

export interface ShadowStats {
  versionId: string;
  /** Decisões registradas, entrando ou não. */
  decisions: number;
  /** Decisões que teriam entrado. */
  entries: number;
  /** Entradas COM desfecho apurado — é esta que o gate de amostra mede. */
  sample: number;
  wins: number;
  losses: number;
  breakeven: number;
  /** Entradas ainda sem desfecho. Ficam de fora de qualquer conclusão. */
  pending: number;
  /** null enquanto não há amostra: ausência é valor, não zero. */
  winRate: number | null;
  sumR: number | null;
  expectancyR: number | null;
}

export interface ShadowDivergence {
  at: number;
  baseline: string;
  candidate: string;
  note: string;
}

export type ShadowVerdict = "SEM_AMOSTRA" | "EQUIVALENTES" | "CANDIDATA_MELHOR" | "BASELINE_MELHOR";

export interface ShadowComparison {
  baseline: ShadowStats;
  candidate: ShadowStats;
  divergences: ShadowDivergence[];
  verdict: ShadowVerdict;
  note: string;
  /** Amostra mínima aplicada nesta comparação — o operador precisa ver o gate. */
  minSample: number;
}

/**
 * Amostra mínima por versão para qualquer conclusão. 30 é o mesmo piso já usado
 * pela validação de evidência do projeto (MIN_EVIDENCE_SAMPLE em
 * src/lib/engines/evidenceValidation.ts): abaixo disso a diferença entre duas
 * técnicas é indistinguível de sorte.
 */
export const MIN_SHADOW_SAMPLE = 30;

/**
 * Diferença de expectância (em R) abaixo da qual as duas versões são
 * declaradas EQUIVALENTES. 0,1R é menor que o custo de um slippage típico —
 * chamar isso de "melhor" seria promover ruído.
 */
export const MARGEM_EQUIVALENCIA_R = 0.1;

export const BASELINE_VERSION_ID = "T4-PRODUCAO";

/**
 * Registra o que uma versão TERIA feito num instante.
 *
 * RESTRIÇÃO: `wouldEnter` só sobrevive como true com direção operacional e
 * entrada/stop numéricos. Uma "entrada" sem preço e sem risco não é entrada; se
 * entrasse na amostra assim, contaminaria a comparação com decisões que nunca
 * poderiam ser executadas. Nesse caso o registro é REBAIXADO (wouldEnter false)
 * e o motivo original é preservado no `reason`, para o operador ver o que a
 * versão tentou dizer.
 */
export function recordShadowDecision(reading: ShadowReading): ShadowDecision {
  const numerico = (valor: number | null): boolean => valor !== null && Number.isFinite(valor);
  const completa =
    reading.direction !== "NEUTRO" && numerico(reading.entry) && numerico(reading.stop);

  if (reading.wouldEnter && !completa) {
    return {
      at: reading.at,
      versionId: reading.versionId,
      wouldEnter: false,
      direction: reading.direction,
      entry: reading.entry,
      stop: reading.stop,
      target: reading.target,
      reason: `registro rebaixado: entrada sem direção operacional ou sem entrada/stop numéricos — ${reading.reason}`,
    };
  }

  return {
    at: reading.at,
    versionId: reading.versionId,
    wouldEnter: reading.wouldEnter,
    direction: reading.direction,
    entry: reading.entry,
    stop: reading.stop,
    target: reading.target,
    reason: reading.reason,
  };
}

function chave(versionId: string, at: number): string {
  return `${versionId}@${at}`;
}

function computeStats(
  versionId: string,
  decisions: ShadowDecision[],
  outcomes: Map<string, number>,
): ShadowStats {
  const proprias = decisions.filter((decision) => decision.versionId === versionId);
  const entradas = proprias.filter((decision) => decision.wouldEnter);

  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let pending = 0;
  let sumR = 0;
  let sample = 0;

  for (const entrada of entradas) {
    const resultado = outcomes.get(chave(versionId, entrada.at));
    if (resultado === undefined) {
      // Sem desfecho apurado: fica FORA da amostra. Contar como zero inflaria a
      // base e faria a expectância parecer mais estável do que é.
      pending += 1;
      continue;
    }
    sample += 1;
    sumR += resultado;
    if (resultado > 0) wins += 1;
    else if (resultado < 0) losses += 1;
    else breakeven += 1;
  }

  return {
    versionId,
    decisions: proprias.length,
    entries: entradas.length,
    sample,
    wins,
    losses,
    breakeven,
    pending,
    winRate: sample === 0 ? null : wins / sample,
    sumR: sample === 0 ? null : sumR,
    expectancyR: sample === 0 ? null : sumR / sample,
  };
}

function descreve(decision: ShadowDecision | undefined): string {
  if (decision === undefined) return "sem registro neste instante";
  if (!decision.wouldEnter) return `sem entrada (${decision.reason})`;
  const alvo = decision.target === null ? "sem alvo" : `alvo ${decision.target}`;
  return `${decision.direction} entrada ${decision.entry ?? "—"} · stop ${decision.stop ?? "—"} · ${alvo}`;
}

function motivoDaDivergencia(
  base: ShadowDecision | undefined,
  cand: ShadowDecision | undefined,
): string | null {
  if (base === undefined || cand === undefined) {
    return "instante sem registro nas duas versões — comparação incompleta neste ponto.";
  }
  if (base.wouldEnter !== cand.wouldEnter) {
    return base.wouldEnter
      ? "a produção entraria e a candidata ficaria de fora."
      : "a candidata entraria onde a produção fica de fora.";
  }
  if (!base.wouldEnter && !cand.wouldEnter) return null;
  if (base.direction !== cand.direction) return "direções opostas no mesmo instante.";
  if (base.entry !== cand.entry || base.stop !== cand.stop || base.target !== cand.target) {
    return "mesma direção, níveis diferentes de entrada/stop/alvo.";
  }
  return null;
}

/**
 * Compara baseline e candidata sobre os mesmos instantes.
 *
 * O gate de amostra vem ANTES de qualquer julgamento: com menos de `minSample`
 * desfechos em qualquer uma das versões o veredito é SEM_AMOSTRA e a nota diz
 * que a conclusão não está autorizada. As divergências continuam sendo listadas
 * mesmo assim — elas são observação, não conclusão, e é o que o operador lê
 * para decidir se confia no experimento.
 */
export function compareShadow(
  baseline: ShadowDecision[],
  candidate: ShadowDecision[],
  outcomes: ShadowOutcome[],
  minSample: number = MIN_SHADOW_SAMPLE,
): ShadowComparison {
  const mapaDesfechos = new Map<string, number>();
  for (const outcome of outcomes) {
    if (outcome.resultR === null || !Number.isFinite(outcome.resultR)) continue;
    mapaDesfechos.set(chave(outcome.versionId, outcome.at), outcome.resultR);
  }

  const baselineId = baseline[0]?.versionId ?? BASELINE_VERSION_ID;
  const candidateId = candidate[0]?.versionId ?? "CANDIDATA";
  const estatBaseline = computeStats(baselineId, baseline, mapaDesfechos);
  const estatCandidate = computeStats(candidateId, candidate, mapaDesfechos);

  const porInstanteBase = new Map(baseline.map((decision) => [decision.at, decision]));
  const porInstanteCand = new Map(candidate.map((decision) => [decision.at, decision]));
  const instantes = [...new Set([...porInstanteBase.keys(), ...porInstanteCand.keys()])].sort(
    (a, b) => a - b,
  );

  const divergences: ShadowDivergence[] = [];
  for (const at of instantes) {
    const base = porInstanteBase.get(at);
    const cand = porInstanteCand.get(at);
    const note = motivoDaDivergencia(base, cand);
    if (note === null) continue;
    divergences.push({ at, baseline: descreve(base), candidate: descreve(cand), note });
  }

  const amostraOk = estatBaseline.sample >= minSample && estatCandidate.sample >= minSample;
  if (!amostraOk) {
    return {
      baseline: estatBaseline,
      candidate: estatCandidate,
      divergences,
      verdict: "SEM_AMOSTRA",
      note: `conclusão NÃO autorizada: são necessários ${minSample} desfechos por versão e existem ${estatBaseline.sample} (produção) e ${estatCandidate.sample} (candidata).`,
      minSample,
    };
  }

  // A partir daqui as duas expectâncias existem (sample > 0 em ambas).
  const expBase = estatBaseline.expectancyR ?? 0;
  const expCand = estatCandidate.expectancyR ?? 0;
  const diferenca = expCand - expBase;

  if (diferenca > MARGEM_EQUIVALENCIA_R) {
    return {
      baseline: estatBaseline,
      candidate: estatCandidate,
      divergences,
      verdict: "CANDIDATA_MELHOR",
      note: `candidata ${diferenca.toFixed(2)}R acima da produção em ${estatCandidate.sample} desfechos. Resultado de observação — a promoção continua sendo decisão humana.`,
      minSample,
    };
  }
  if (-diferenca > MARGEM_EQUIVALENCIA_R) {
    return {
      baseline: estatBaseline,
      candidate: estatCandidate,
      divergences,
      verdict: "BASELINE_MELHOR",
      note: `produção ${(-diferenca).toFixed(2)}R acima da candidata em ${estatBaseline.sample} desfechos. Manter a técnica atual.`,
      minSample,
    };
  }
  return {
    baseline: estatBaseline,
    candidate: estatCandidate,
    divergences,
    verdict: "EQUIVALENTES",
    note: `diferença de ${diferenca.toFixed(2)}R está dentro da margem de ${MARGEM_EQUIVALENCIA_R}R — não há ganho demonstrado em trocar a técnica.`,
    minSample,
  };
}

/**
 * Gate de promoção. Responde true SOMENTE com amostra suficiente nas duas
 * versões E candidata comprovadamente melhor.
 *
 * A checagem de amostra é refeita aqui de propósito, em vez de confiar apenas no
 * veredito: esta função é a última porta antes de um humano trocar a técnica de
 * produção, e ela não deve depender de nenhuma outra ter feito a conta certa.
 * Nada é promovido por esta chamada — ela apenas responde.
 */
export function podePromover(comparison: ShadowComparison): boolean {
  const amostraOk =
    comparison.baseline.sample >= comparison.minSample &&
    comparison.candidate.sample >= comparison.minSample;
  return amostraOk && comparison.verdict === "CANDIDATA_MELHOR";
}
