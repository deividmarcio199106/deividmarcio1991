/**
 * ANALISAR CSV — importação e pesquisa encadeadas num clique só.
 *
 * A RESTRIÇÃO que este módulo existe para garantir: se a importação não gravou
 * NENHUM candle, a pesquisa não roda. Um pipeline sobre zero candle devolve um
 * relatório com todos os números zerados — e um relatório vazio que PARECE
 * resultado é pior que um erro, porque o operador acredita nele.
 *
 * O IO é injetado (OneClickDeps) porque a regra acima precisa ser testável sem
 * DOM, sem `fetch` e sem servidor. Este arquivo não conhece React nem window.
 *
 * Nada aqui inventa número: corpo em formato inesperado vira falha declarada,
 * nunca valor default. Quem chama recebe SEMPRE a etapa em que quebrou, porque
 * "falhou" sem dizer onde não é diagnóstico.
 */

/** Corpo de /api/trading/research/import — fonte única (a tela importa daqui). */
export interface ImportResult {
  ok: boolean;
  format: string;
  received: number;
  saved: number;
  problems: string[];
  problemCount: number;
}

/** Corpo de /api/trading/research/run — fonte única (a tela importa daqui). */
export interface RunMetrics {
  candles: number;
  discards: Record<string, number>;
  setupsDetected: number;
  stats: {
    total: number;
    wins: number;
    losses: number;
    winRate: number;
    payoff: number;
    profitFactor: number;
    expectancy: number;
    maxDrawdown: number;
    cumulativeR: number;
  };
  oos: { start: number; trades: number; expectancyR: number };
  walkForward: {
    folds: Array<{ trades: number; netR: number }>;
    positiveFolds: number;
    totalFolds: number;
    stable: boolean;
  };
  monteCarlo: {
    maxDrawdownP50: number;
    maxDrawdownP95: number;
    worstLossStreakP95: number;
    ruinProbability: number;
    runs: number;
  };
  ranking: { score: number; eligible: boolean; note: string } | null;
}

export interface OneClickDeps {
  postJson: (url: string, body: unknown) => Promise<{ ok: boolean; status: number; body: unknown }>;
}

export interface OneClickProgress {
  fase: "IMPORTANDO" | "PESQUISANDO";
}

export type OneClickEtapa = "IMPORT" | "RUN";

export type OneClickResultado =
  | { ok: true; importado: ImportResult; metrics: RunMetrics }
  | { ok: false; etapa: OneClickEtapa; motivo: string };

export const ROTA_IMPORT = "/api/trading/research/import";
export const ROTA_RUN = "/api/trading/research/run";

export async function analisarCsvCompleto(
  args: { datasetId: string; csv: string; asset: string },
  deps: OneClickDeps,
  onProgress?: (p: OneClickProgress) => void,
): Promise<OneClickResultado> {
  onProgress?.({ fase: "IMPORTANDO" });

  const importacao = await postar(deps, ROTA_IMPORT, { datasetId: args.datasetId, csv: args.csv });
  if (!importacao.ok) return { ok: false, etapa: "IMPORT", motivo: importacao.motivo };

  const importado = lerImportResult(importacao.corpo);
  if (!importado) {
    return {
      ok: false,
      etapa: "IMPORT",
      motivo: "resposta de importação em formato inesperado — contagem de candles não veio",
    };
  }

  if (importado.saved === 0) {
    // Sem candle gravado não há o que pesquisar. O primeiro problema relatado
    // pelo parser é o que o operador precisa para consertar o arquivo.
    const primeiro = importado.problems[0] ?? "sem problema relatado pelo importador";
    return {
      ok: false,
      etapa: "IMPORT",
      motivo: `nenhum candle aproveitável no arquivo — ${primeiro}`,
    };
  }

  onProgress?.({ fase: "PESQUISANDO" });

  const rodada = await postar(deps, ROTA_RUN, { datasetId: args.datasetId, asset: args.asset });
  if (!rodada.ok) return { ok: false, etapa: "RUN", motivo: rodada.motivo };

  const metrics = comoObjeto(rodada.corpo)?.metrics;
  if (!pareceRunMetrics(metrics)) {
    return {
      ok: false,
      etapa: "RUN",
      motivo: "pesquisa respondeu sem o bloco de métricas — nada a exibir",
    };
  }

  return { ok: true, importado, metrics };
}

type Resposta = { ok: true; corpo: unknown } | { ok: false; motivo: string };

async function postar(deps: OneClickDeps, url: string, corpo: unknown): Promise<Resposta> {
  try {
    const resposta = await deps.postJson(url, corpo);
    // `HTTP <status>` só quando o servidor não explicou nada: a mensagem dele é
    // sempre mais útil que o código.
    if (!resposta.ok) return { ok: false, motivo: motivoDoCorpo(resposta.body, resposta.status) };
    return { ok: true, corpo: resposta.body };
  } catch (erro) {
    // Rede caída / corpo não-JSON: falha da etapa, não exceção vazando para a UI.
    return { ok: false, motivo: erro instanceof Error ? erro.message : String(erro) };
  }
}

function motivoDoCorpo(corpo: unknown, status: number): string {
  const erro = comoObjeto(corpo)?.error;
  return typeof erro === "string" && erro.trim() !== "" ? erro : `HTTP ${status}`;
}

/**
 * Validação estrita: `saved` decide se a pesquisa roda, então um campo ausente
 * NÃO pode virar 0 — viraria "nenhum candle aproveitável" com motivo mentiroso.
 */
function lerImportResult(valor: unknown): ImportResult | null {
  const o = comoObjeto(valor);
  if (!o) return null;
  const received = comoNumero(o.received);
  const saved = comoNumero(o.saved);
  const problemCount = comoNumero(o.problemCount);
  if (
    typeof o.ok !== "boolean" ||
    typeof o.format !== "string" ||
    received === null ||
    saved === null ||
    problemCount === null ||
    !Array.isArray(o.problems)
  ) {
    return null;
  }
  return {
    ok: o.ok,
    format: o.format,
    received,
    saved,
    problems: o.problems.filter((p): p is string => typeof p === "string"),
    problemCount,
  };
}

/**
 * Confere só os BLOCOS que a tela desreferencia. Os números de dentro não são
 * revalidados de propósito: JSON serializa Infinity como null, e profit factor
 * infinito (rodada sem nenhuma perda) é resultado legítimo — exigir número
 * finito campo a campo rejeitaria pesquisa válida.
 */
function pareceRunMetrics(valor: unknown): valor is RunMetrics {
  const m = comoObjeto(valor);
  if (!m) return false;
  const walkForward = comoObjeto(m.walkForward);
  return (
    comoNumero(m.candles) !== null &&
    comoNumero(m.setupsDetected) !== null &&
    comoObjeto(m.discards) !== null &&
    comoObjeto(m.stats) !== null &&
    comoObjeto(m.oos) !== null &&
    walkForward !== null &&
    Array.isArray(walkForward.folds) &&
    comoObjeto(m.monteCarlo) !== null &&
    (m.ranking === null || comoObjeto(m.ranking) !== null)
  );
}

function comoObjeto(valor: unknown): Record<string, unknown> | null {
  if (typeof valor !== "object" || valor === null || Array.isArray(valor)) return null;
  return valor as Record<string, unknown>;
}

function comoNumero(valor: unknown): number | null {
  return typeof valor === "number" && Number.isFinite(valor) ? valor : null;
}
