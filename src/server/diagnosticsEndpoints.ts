/**
 * Endpoints de diagnóstico servidos ANTES do SSR (ver `src/server.ts`), pelo
 * mesmo motivo dos health checks: precisam responder com o aplicativo quebrado.
 *
 * Cada verificação aqui EXECUTA alguma coisa. Nenhuma responde "ok" por
 * existir: o banco abre e consulta, o motor T4 roda, o provedor de IA recebe
 * uma requisição. O que não puder ser provado sai marcado como não provado.
 */

import { analyze } from "@/lib/engines/analysisPipeline";
import { STRATEGY_VERSION } from "@/lib/engines/strategy";
import type { Candle, ReadingState } from "@/lib/engines/types";
import {
  check,
  summarize,
  type CheckResult,
  type DiagnosticsReport,
} from "@/lib/diagnostics/types";

import { checkAllProviders, publicProviderStatus } from "@/services/ai/router";

export const DIAGNOSTIC_PATHS = [
  "/api/diagnostics",

  "/api/t4/health",
  "/api/ai/providers",
] as const;

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate",
    },
  });
}

async function timed<T>(fn: () => Promise<T> | T): Promise<{ value: T; ms: number }> {
  const startedAt = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - startedAt };
}

/* ---------------------------------------------------------------- BACKEND */

function checkRuntime(): CheckResult {
  const memory = process.memoryUsage();
  const heapMb = Math.round(memory.heapUsed / 1024 / 1024);
  const rssMb = Math.round(memory.rss / 1024 / 1024);
  // Heap crescendo sem parar é o sintoma de vazamento; 1 GB é o ponto em que
  // vale investigar antes que o processo seja morto pelo sistema.
  const alto = heapMb > 1_024;
  return check({
    id: "BACKEND_RUNTIME",
    domain: "BACKEND",
    label: "Processo do servidor",
    status: alto ? "WARNING" : "PASS",
    observed: `uptime ${Math.round(process.uptime())}s · heap ${heapMb}MB · RSS ${rssMb}MB · ${process.version}`,
    cause: alto ? "Heap acima de 1GB pode indicar vazamento de memória." : null,
    impact: alto
      ? "Consumo crescente leva a queda do processo e perda de sessão."
      : "Nenhum: o processo responde e o consumo está dentro do esperado.",
    fix: alto
      ? "Compare com o MODO ENGENHEIRO ao longo do pregão; se o heap só sobe, investigue listeners não removidos."
      : "Nada a fazer.",
    proven: true,
  });
}

async function checkDatabase(): Promise<CheckResult> {
  const startedAt = Date.now();
  try {
    // Import dinâmico: `node:sqlite` não existe em todo runtime (Bun, Node <22.5).
    const { getDatabase, getDataDir } = await import("./tradingRepository");
    // Consulta real, não apenas abertura do arquivo: prova que o schema migrou.
    const row = getDatabase().prepare("SELECT COUNT(*) AS total FROM trading_sessions").get() as
      { total?: number } | undefined;
    return check({
      id: "DB_SQLITE",
      domain: "BANCO",
      label: "Banco SQLite",
      status: "PASS",
      observed: `Consulta executada em ${getDataDir()} · ${row?.total ?? 0} sessão(ões) registrada(s).`,
      impact: "Nenhum.",
      fix: "Nada a fazer.",
      proven: true,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const semModulo = message.includes("node:sqlite");
    return check({
      id: "DB_SQLITE",
      domain: "BANCO",
      label: "Banco SQLite",
      status: "FAIL",
      observed: message,
      cause: semModulo
        ? "O runtime não expõe `node:sqlite` — exige Node 22.5+ (o Bun não implementa esse módulo)."
        : "Falha ao abrir ou consultar o banco.",
      file: "src/server/tradingRepository.ts",
      line: 3,
      impact:
        "Sem banco, sessões, trades e eventos não persistem: o histórico de evidência do T4 fica vazio.",
      fix: semModulo
        ? "Rode o servidor com Node 22.5 ou superior."
        : "Verifique DATA_DIR/DATABASE_PATH e as permissões de escrita do diretório.",
      proven: true,
      durationMs: Date.now() - startedAt,
    });
  }
}

/* -------------------------------------------------------------------- ENV */

function checkEnv(): CheckResult[] {
  const results: CheckResult[] = [];

  const providers = publicProviderStatus();
  const configurados = providers.filter((provider) => provider.configured);
  results.push(
    check({
      id: "ENV_AI_PROVIDERS",
      domain: "ENV",
      label: "Provedores de IA configurados",
      status: configurados.length > 0 ? "PASS" : "WARNING",
      observed:
        configurados.length > 0
          ? `${configurados.length} configurado(s): ${configurados.map((p) => p.id).join(", ")}`
          : "Nenhum provedor de IA configurado.",
      cause: configurados.length === 0 ? "Nenhuma chave de provedor presente no ambiente." : null,
      impact:
        configurados.length === 0
          ? "A correção assistida por IA fica indisponível. O T4 continua funcionando: ele não depende de IA."
          : "Nenhum.",
      fix: "Defina ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY ou OLLAMA_BASE_URL no ambiente do SERVIDOR.",
      proven: true,
    }),
  );

  // Chave de provedor exposta ao cliente seria vazamento imediato de segredo:
  // no Vite, tudo que começa com VITE_ vai para o bundle do navegador.
  const expostas = Object.keys(process.env).filter(
    (name) => name.startsWith("VITE_") && /(KEY|TOKEN|SECRET|PASSWORD|SENHA)/i.test(name),
  );
  results.push(
    check({
      id: "ENV_NO_CLIENT_SECRETS",
      domain: "ENV",
      label: "Segredos fora do bundle do navegador",
      status: expostas.length === 0 ? "PASS" : "FAIL",
      observed:
        expostas.length === 0
          ? "Nenhuma variável VITE_* com aparência de segredo."
          : `Variáveis expostas ao navegador: ${expostas.join(", ")}`,
      cause: expostas.length ? "Variáveis VITE_* são embutidas no bundle do cliente." : null,
      impact: expostas.length
        ? "Qualquer visitante lê a chave no JavaScript servido. Rotacione as chaves afetadas."
        : "Nenhum.",
      fix: "Renomeie removendo o prefixo VITE_ e consuma o valor apenas em código de servidor.",
      proven: true,
    }),
  );

  const dataDir = (process.env["DATA_DIR"] ?? "").trim();
  results.push(
    check({
      id: "ENV_DATA_DIR",
      domain: "ENV",
      label: "Diretório de dados",
      status: "PASS",
      observed: dataDir ? `DATA_DIR=${dataDir}` : "DATA_DIR não definido — usando ./data",
      impact: "Nenhum enquanto o processo tiver permissão de escrita no caminho usado.",
      fix: "Em produção, aponte DATA_DIR para um volume persistente.",
      proven: true,
    }),
  );

  return results;
}

/* ------------------------------------------------------------------ T4 */

/**
 * Auto-teste do motor: uma série SINTÉTICA e determinística, gerada aqui, é
 * empurrada pelo `analyze()` para provar que o pipeline executa de ponta a
 * ponta sem lançar exceção.
 *
 * Estes candles NUNCA saem desta função e jamais alimentam decisão, gravação
 * ou banco. É teste de motor, não dado de mercado.
 */
function engineSelfTest(): CheckResult {
  const startedAt = Date.now();
  const candles: Candle[] = [];
  const base = Date.UTC(2026, 0, 2, 13, 0, 0);
  let price = 120_000;
  for (let i = 0; i < 60; i += 1) {
    // Onda determinística: sem Math.random, o resultado é reproduzível.
    const drift = Math.sin(i / 5) * 120 + (i < 30 ? -8 * i : 8 * (i - 30));
    const open = price;
    const close = 120_000 + drift;
    candles.push({
      t: base + i * 60_000,
      o: open,
      h: Math.max(open, close) + 25,
      l: Math.min(open, close) - 25,
      c: close,
      v: 0,
    });
    price = close;
  }

  const reading: ReadingState = {
    sufficient: true,
    timeframeConfirmed: true,
    priceScaleReady: true,
    calibrationConfidence: 100,
    candleQuality: 100,
    closedCandles: candles.length,
    lastCandleClosed: true,
    issues: [],
    label: "AUTO-TESTE",
  };

  try {
    const result = analyze(candles, { reading });
    if (!result) {
      return check({
        id: "T4_ENGINE",
        domain: "T4",
        label: "Motor T4 executa",
        status: "FAIL",
        observed: "analyze() devolveu null para uma série de 60 candles válidos.",
        cause: "Extração de features rejeitou a janela.",
        file: "src/lib/engines/analysisPipeline.ts",
        line: 129,
        impact: "O T4 não produz leitura alguma: nenhum sinal sairá jamais.",
        fix: "Verifique `extractFeatures` em src/lib/engines/marketFeatures.ts.",
        proven: true,
        durationMs: Date.now() - startedAt,
      });
    }
    return check({
      id: "T4_ENGINE",
      domain: "T4",
      label: "Motor T4 executa",
      status: "PASS",
      observed: `analyze() concluiu · técnica ${result.strategyVersion} · regime ${result.regime.regime} · setup ${result.t4.setup} · ${result.evidences.length} evidências · ${result.blockers.length} bloqueios`,
      impact: "Nenhum.",
      fix: "Nada a fazer.",
      proven: true,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    return check({
      id: "T4_ENGINE",
      domain: "T4",
      label: "Motor T4 executa",
      status: "FAIL",
      observed: error instanceof Error ? error.message : String(error),
      cause: "Exceção durante a execução do pipeline de análise.",
      file: "src/lib/engines/analysisPipeline.ts",
      line: 129,
      impact: "Toda análise falha: o T4 fica inoperante.",
      fix: "Leia o stack no MODO ENGENHEIRO e corrija o motor apontado.",
      proven: true,
      durationMs: Date.now() - startedAt,
    });
  }
}

function checkStrategyVersion(): CheckResult {
  return check({
    id: "T4_VERSION",
    domain: "T4",
    label: "Versão da técnica",
    status: STRATEGY_VERSION ? "PASS" : "FAIL",
    observed: STRATEGY_VERSION || "vazia",
    impact: STRATEGY_VERSION
      ? "Nenhum."
      : "Sem versão congelada, trades gravados não podem ser atribuídos a uma técnica.",
    fix: "Defina STRATEGY_VERSION em src/lib/engines/strategy.ts.",
    file: "src/lib/engines/strategy.ts",
    proven: true,
  });
}

/* ---------------------------------------------------------------- CAPTURA */

/**
 * O servidor NÃO consegue provar a leitura: a captura acontece no navegador do
 * operador, sobre uma janela do Profit que o servidor nunca vê. Dizer "leitura
 * ok" daqui seria exatamente o health falso que o comando proíbe. Este check
 * declara isso; a prova real vem do navegador, em `/diagnostico`.
 */
function checkVisionFromServer(): CheckResult {
  return check({
    id: "VISION_SERVER_VIEW",
    domain: "FEED",
    label: "Captura do Profit (visão do servidor)",
    status: "SKIPPED",
    observed:
      "A captura é local ao navegador do operador; o servidor não alcança o MediaStream nem os pixels.",
    cause: null,
    impact:
      "Nenhum — mas o estado da leitura só é verdadeiro quando medido no navegador que roda a sessão.",
    fix: "Abra /diagnostico no navegador do operador e rode o DIAGNÓSTICO COMPLETO.",
    proven: false,
  });
}

/* ------------------------------------------------------------------- IA */

async function checkAiProviders(): Promise<CheckResult[]> {
  const statuses = await checkAllProviders();
  return statuses.map((status) =>
    check({
      id: `AI_${status.id.toUpperCase()}`,
      domain: "IA",
      label: status.label,
      status:
        status.state === "READY"
          ? "PASS"
          : status.state === "OFFLINE"
            ? "SKIPPED"
            : status.state === "RATE_LIMIT"
              ? "WARNING"
              : "FAIL",
      observed: `${status.state} · ${status.message}`,
      cause: status.state === "ERROR" ? status.message : null,
      impact:
        status.state === "READY"
          ? "Nenhum."
          : "A correção assistida perde este provedor; o roteador cai para o próximo configurado. O T4 não é afetado.",
      fix:
        status.state === "OFFLINE"
          ? `Configure a chave/endpoint de ${status.label} no ambiente do servidor.`
          : "Verifique chave, cota e conectividade de saída do servidor.",
      proven: status.proven,
      durationMs: status.latencyMs ?? 0,
    }),
  );
}

/* ------------------------------------------------------------- AGREGADOR */

export async function runServerDiagnostics(): Promise<DiagnosticsReport> {
  const startedAt = Date.now();
  const checks: CheckResult[] = [];

  checks.push(checkRuntime());
  checks.push(...checkEnv());
  checks.push(checkStrategyVersion());
  checks.push(engineSelfTest());
  checks.push(await checkDatabase());
  checks.push(checkVisionFromServer());
  checks.push(...(await checkAiProviders()));

  checks.push(
    check({
      id: "API_DIAGNOSTICS",
      domain: "API",
      label: "Endpoints de diagnóstico",
      status: "PASS",
      observed: `Respondendo: ${DIAGNOSTIC_PATHS.join(", ")}`,
      impact: "Nenhum.",
      fix: "Nada a fazer.",
      // Esta resposta É a prova: o endpoint executou até aqui.
      proven: true,
    }),
  );

  return summarize(checks, Date.now() - startedAt);
}

export async function handleDiagnosticsRequest(request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const path = pathname.replace(/\/+$/, "") || "/";
  if (!(DIAGNOSTIC_PATHS as readonly string[]).includes(path)) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "Método não permitido — use GET." }, 405);
  }

  try {
    if (path === "/api/diagnostics") {
      const report = await runServerDiagnostics();
      return json(report, report.verdict === "FAIL" ? 503 : 200);
    }

    if (path === "/api/t4/health") {
      const engine = engineSelfTest();
      const version = checkStrategyVersion();
      const ok = engine.status === "PASS" && version.status === "PASS";
      return json(
        {
          status: ok ? "ok" : "falha",
          strategyVersion: STRATEGY_VERSION,
          checks: [engine, version],
          note: "O auto-teste usa uma série sintética determinística que nunca alimenta decisão, gravação ou banco.",
        },
        ok ? 200 : 503,
      );
    }

    // /api/ai/providers
    const { value } = await timed(() => checkAllProviders());
    return json({ providers: value }, 200);
  } catch (error) {
    return json(
      {
        status: "falha",
        message: "O próprio diagnóstico falhou ao executar.",
        detail: error instanceof Error ? error.message : String(error),
      },
      503,
    );
  }
}
