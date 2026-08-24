import { describe, expect, it } from "vitest";

import {
  analisarCsvCompleto,
  ROTA_IMPORT,
  ROTA_RUN,
  type OneClickDeps,
  type OneClickProgress,
  type RunMetrics,
} from "../csvOneClick";

/**
 * As deps abaixo são INJEÇÃO DE DEPENDÊNCIA no teste — o servidor é substituído
 * por respostas declaradas. Nenhuma delas existe em produção: a tela injeta um
 * postJson que usa `fetch` de verdade.
 */
function depsFake(respostas: Array<{ ok: boolean; status: number; body: unknown }>) {
  const chamadas: Array<{ url: string; body: unknown }> = [];
  const deps: OneClickDeps = {
    postJson: (url, body) => {
      chamadas.push({ url, body });
      const proxima = respostas.shift();
      if (!proxima) return Promise.reject(new Error(`chamada não prevista no teste: ${url}`));
      return Promise.resolve(proxima);
    },
  };
  return { deps, chamadas };
}

function importOk(saved: number, problems: string[] = []) {
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      format: "PROFIT_CSV",
      received: saved + problems.length,
      saved,
      problems,
      problemCount: problems.length,
    },
  };
}

const METRICS: RunMetrics = {
  candles: 1200,
  discards: { fora_do_horario: 7 },
  setupsDetected: 31,
  stats: {
    total: 20,
    wins: 12,
    losses: 8,
    winRate: 60,
    payoff: 1.4,
    profitFactor: 1.8,
    expectancy: 0.24,
    maxDrawdown: 3.1,
    cumulativeR: 4.8,
  },
  oos: { start: Date.UTC(2026, 2, 18, 9, 0, 0), trades: 4, expectancyR: 0.19 },
  walkForward: {
    folds: [
      { trades: 6, netR: 1.2 },
      { trades: 5, netR: -0.4 },
      { trades: 9, netR: 2.0 },
    ],
    positiveFolds: 2,
    totalFolds: 3,
    stable: true,
  },
  monteCarlo: {
    maxDrawdownP50: 2.4,
    maxDrawdownP95: 5.9,
    worstLossStreakP95: 5,
    ruinProbability: 0.02,
    runs: 2000,
  },
  ranking: { score: 61.5, eligible: true, note: "amostra sustenta conclusão preliminar" },
};

const ARGS = { datasetId: "csv_teste_1", csv: "t,o,h,l,c\n1,2,3,4,5", asset: "WINFUT" };

describe("analisarCsvCompleto", () => {
  it("caminho feliz: encadeia import → run e devolve as métricas da rodada", async () => {
    const { deps, chamadas } = depsFake([
      importOk(1200),
      { ok: true, status: 200, body: { ok: true, runId: "run_1", metrics: METRICS } },
    ]);

    const r = await analisarCsvCompleto(ARGS, deps);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.importado.saved).toBe(1200);
    expect(r.metrics).toEqual(METRICS);
    expect(chamadas.map((c) => c.url)).toEqual([ROTA_IMPORT, ROTA_RUN]);
    expect(chamadas[0]!.body).toEqual({ datasetId: ARGS.datasetId, csv: ARGS.csv });
    expect(chamadas[1]!.body).toEqual({ datasetId: ARGS.datasetId, asset: ARGS.asset });
  });

  it("saved=0 NÃO chama a pesquisa e explica com o primeiro problema do arquivo", async () => {
    const { deps, chamadas } = depsFake([
      importOk(0, ["linha 2: data ilegível '31/02/2026'", "linha 3: preço vazio"]),
    ]);

    const r = await analisarCsvCompleto(ARGS, deps);

    expect(r).toEqual({
      ok: false,
      etapa: "IMPORT",
      motivo: "nenhum candle aproveitável no arquivo — linha 2: data ilegível '31/02/2026'",
    });
    // A garantia central: pesquisa sobre zero candle nunca é disparada.
    expect(chamadas.map((c) => c.url)).toEqual([ROTA_IMPORT]);
  });

  it("erro HTTP no run devolve etapa RUN com o motivo vindo do corpo", async () => {
    const { deps } = depsFake([
      importOk(80),
      {
        ok: false,
        status: 422,
        body: { error: "apenas 80 candles no dataset — mínimo 100 para pesquisa." },
      },
    ]);

    const r = await analisarCsvCompleto(ARGS, deps);

    expect(r).toEqual({
      ok: false,
      etapa: "RUN",
      motivo: "apenas 80 candles no dataset — mínimo 100 para pesquisa.",
    });
  });

  it("onProgress emite IMPORTANDO e depois PESQUISANDO, nessa ordem", async () => {
    const { deps } = depsFake([
      importOk(1200),
      { ok: true, status: 200, body: { ok: true, metrics: METRICS } },
    ]);
    const fases: OneClickProgress["fase"][] = [];

    await analisarCsvCompleto(ARGS, deps, (p) => fases.push(p.fase));

    expect(fases).toEqual(["IMPORTANDO", "PESQUISANDO"]);
  });

  it("import quebrado não emite PESQUISANDO — a fase anunciada é a fase real", async () => {
    const { deps, chamadas } = depsFake([
      { ok: false, status: 422, body: { error: "nenhum candle legível no CSV" } },
    ]);
    const fases: OneClickProgress["fase"][] = [];

    const r = await analisarCsvCompleto(ARGS, deps, (p) => fases.push(p.fase));

    expect(r).toEqual({ ok: false, etapa: "IMPORT", motivo: "nenhum candle legível no CSV" });
    expect(fases).toEqual(["IMPORTANDO"]);
    expect(chamadas.map((c) => c.url)).toEqual([ROTA_IMPORT]);
  });

  it("erro sem mensagem no corpo cai para HTTP <status>", async () => {
    const { deps } = depsFake([{ ok: false, status: 500, body: {} }]);
    await expect(analisarCsvCompleto(ARGS, deps)).resolves.toEqual({
      ok: false,
      etapa: "IMPORT",
      motivo: "HTTP 500",
    });
  });

  it("rede caída vira falha da etapa, não exceção vazando", async () => {
    const deps: OneClickDeps = { postJson: () => Promise.reject(new Error("Failed to fetch")) };
    await expect(analisarCsvCompleto(ARGS, deps)).resolves.toEqual({
      ok: false,
      etapa: "IMPORT",
      motivo: "Failed to fetch",
    });
  });

  it("import 200 sem o campo saved é falha declarada — nunca 0 assumido", async () => {
    const { deps, chamadas } = depsFake([
      { ok: true, status: 200, body: { ok: true, format: "PROFIT_CSV", received: 10 } },
    ]);

    const r = await analisarCsvCompleto(ARGS, deps);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.etapa).toBe("IMPORT");
    expect(r.motivo).toContain("formato inesperado");
    expect(chamadas).toHaveLength(1);
  });

  it("run 200 sem bloco de métricas não vira resultado vazio", async () => {
    const { deps } = depsFake([importOk(1200), { ok: true, status: 200, body: { ok: true } }]);

    const r = await analisarCsvCompleto(ARGS, deps);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.etapa).toBe("RUN");
    expect(r.motivo).toContain("sem o bloco de métricas");
  });
});
