import { z } from "zod";

import { MIN_EVIDENCE_SAMPLE } from "@/lib/engines/evidenceValidation";
import type { BreakoutState } from "@/lib/print/breakout";
import { normalizeStage, SETUP_STAGES, type TriggerVersion } from "@/lib/print/setupTracker";
import type { TechniqueCandidateRecord } from "@/lib/storage";
import {
  DNA_GRADES,
  DNA_LOCATIONS,
  DNA_ORIGINS,
  DNA_POSITIONS,
  DNA_PULLBACKS,
  DNA_TRENDS,
  DNA_TRIGGERS,
  DNA_VOLATILITIES,
  type SetupDna,
} from "@/lib/t4/dna";
import {
  allSegments,
  compareExitSchemes,
  discoverPatterns,
  lossFactorTable,
  similarWinners,
} from "@/lib/t4/dnaStats";
import { combineConfidence, queryMemory } from "@/lib/print/caseMemory";
import { parseCandlesCsv } from "@/lib/research/csvImport";
import { buildCandidates } from "@/lib/research/candidates";
import { runParamSweep } from "@/lib/research/paramSweep";
import { runQuantBacktest } from "@/lib/research/quantBacktest";
import { buildFolds, walkForwardStability } from "@/lib/research/walkForward";
import { monteCarloDrawdown } from "@/lib/research/monteCarlo";
import { rankVersions } from "@/lib/research/ranking";
import { computeStats } from "@/lib/engines/performanceEngine";
import { requireAdmin } from "./adminGuard";
import {
  countLabExperiments,
  generateHypothesesFromMemory,
  getSetupDna,
  listMemoryCases,
  savePrintRecord,
  sweepPredictionOutcomes,
  learnFromClosedSetups,
  listOpenSetups,
  listSetups,
  setupStats,
  sweepSetupOutcomes,
  upsertSetup,
  databaseInfo,
  getProductionTechnique,
  getSnapshot,
  insertLabExperiment,
  insertSetupDna,
  linkDnaToTrade,
  listDatasets,
  listDnaOutcomes,
  listLabExperiments,
  listSetupDna,
  listTechniqueCandidates,
  verifyT42Freeze,
  promoteTechniqueCandidate,
  runDailyLearning,
  importedCandleCount,
  loadImportedCandles,
  saveImportedCandles,
  saveResearchRun,
  listResearchRuns,
  saveLastDecision,
  saveReplayBatch,
  upsertBacktest,
  upsertDataset,
  upsertLiveSession,
  upsertMarketEvent,
  upsertReplaySession,
  upsertSegment,
  upsertTechniqueCandidate,
  upsertTradingSession,
} from "./tradingRepository";

/**
 * QUEM ENVIA A CANDIDATA NÃO DECIDE SE ELA ESTÁ VALIDADA.
 *
 * `promoteTechniqueCandidate` exige `status === "VALIDATED"` — uma boa regra que
 * não valia nada, porque o status chegava no corpo da requisição. Marcar a
 * própria candidata como validada era um campo de JSON.
 *
 * A validação é uma CONQUISTA medida (backtest, out-of-sample, walk-forward,
 * amostra mínima), não um rótulo declarado. O servidor só aceita VALIDATED com
 * as métricas presentes; sem elas, a candidata entra no estágio que ela de fato
 * alcançou.
 */
function candidateStatusProblem(candidate: Record<string, unknown>): string | null {
  const status = candidate["status"];
  if (typeof status !== "string") return "status é obrigatório.";
  if (status !== "VALIDATED") return null;

  const rules = (candidate["rules"] ?? {}) as Record<string, unknown>;
  const evidence = (rules["evidence"] ?? {}) as Record<string, unknown>;
  const amostra = Number(evidence["sampleSize"] ?? 0);
  const oos = evidence["outOfSampleValidated"] === true;
  const walk = evidence["walkForwardStable"] === true;

  const faltando: string[] = [];
  if (!Number.isFinite(amostra) || amostra < MIN_EVIDENCE_SAMPLE) {
    faltando.push(`amostra ${amostra || 0}/${MIN_EVIDENCE_SAMPLE}`);
  }
  if (!oos) faltando.push("out-of-sample não validado");
  if (!walk) faltando.push("walk-forward não estável");

  /*
   * PROTEÇÃO CONTRA OVERFITTING (§8): quanto mais hipóteses foram testadas
   * sobre a mesma base, mais dura a exigência fora da amostra. Vinte
   * variações testadas e uma "vencedora" é exatamente o cenário em que o
   * histórico engana — o PF exigido no OOS sobe com o log das tentativas.
   */
  const base = String(candidate["baseVersion"] ?? "");
  const testadas = base ? countLabExperiments(base) : 0;
  if (testadas > 0) {
    const oosPf = Number(evidence["oosProfitFactor"] ?? NaN);
    const exigido = 1.3 + 0.2 * Math.ceil(Math.log2(1 + testadas));
    if (!Number.isFinite(oosPf) || oosPf < exigido) {
      faltando.push(
        `PF fora da amostra ${Number.isFinite(oosPf) ? oosPf.toFixed(2) : "ausente"} abaixo do exigido ` +
          `${exigido.toFixed(2)} — ${testadas} hipótese(s) já testada(s) sobre ${base} elevam a régua`,
      );
    }
  }

  return faltando.length === 0
    ? null
    : `VALIDATED exige evidência medida — faltando: ${faltando.join("; ")}. ` +
        "Envie a candidata no estágio realmente alcançado (BACKTESTING/VALIDATION/OOS/WALK_FORWARD).";
}

/**
 * Erros de enum do DNA viram 422 com o campo nomeado — nunca gravação suja.
 *
 * TODA dimensão de vocabulário fechado é conferida aqui, e não só origin/grade:
 * são estas colunas que a segmentação por SQL agrupa, e uma única linha com
 * texto livre ("Tendência FORTE ↑") cria uma categoria fantasma no painel.
 * Os campos NOT NULL também são exigidos: sem isso, `INSERT OR IGNORE`
 * descartaria a linha em silêncio e o cliente receberia `ok: true` sem que
 * nada tivesse sido gravado.
 */
function dnaProblem(record: Partial<SetupDna>): string | null {
  const texto = (valor: unknown): valor is string =>
    typeof valor === "string" && valor.trim().length > 0;

  if (!texto(record.id)) return "id é obrigatório.";
  if (!DNA_ORIGINS.includes(record.origin as never)) return "origin inválida.";
  if (record.direction !== "COMPRA" && record.direction !== "VENDA") return "direction inválida.";
  if (typeof record.detectedAt !== "number" || !Number.isFinite(record.detectedAt)) {
    return "detectedAt é obrigatório (instante de mercado da decisão).";
  }
  if (!texto(record.asset)) return "asset é obrigatório.";
  if (!texto(record.techniqueVersion)) return "techniqueVersion é obrigatória.";
  if (!texto(record.sourceId)) return "sourceId é obrigatório.";
  if (!texto(record.timeframe)) return "timeframe é obrigatório.";

  const enums: Array<[string, readonly string[], unknown]> = [
    ["grade", DNA_GRADES, record.grade],
    ["trend", DNA_TRENDS, record.trend],
    ["position", DNA_POSITIONS, record.position],
    ["pullback", DNA_PULLBACKS, record.pullback],
    ["triggerCandle", DNA_TRIGGERS, record.triggerCandle],
    ["location", DNA_LOCATIONS, record.location],
  ];
  for (const [campo, vocabulario, valor] of enums) {
    if (!vocabulario.includes(valor as string)) {
      return `${campo} fora do vocabulário (recebido: ${JSON.stringify(valor)}).`;
    }
  }

  // Volatilidade e ordinal são legitimamente ausentes (sem leitura / sem
  // movimento definível) — mas quando vêm, vêm do vocabulário.
  if (
    record.volatility !== null &&
    record.volatility !== undefined &&
    !DNA_VOLATILITIES.includes(record.volatility)
  ) {
    return `volatility fora do vocabulário (recebido: ${JSON.stringify(record.volatility)}).`;
  }
  if (
    record.movementOrdinal !== null &&
    record.movementOrdinal !== undefined &&
    ![1, 2, 3, 4].includes(record.movementOrdinal)
  ) {
    return "movementOrdinal precisa ser 1, 2, 3, 4 ou null.";
  }
  if (!Array.isArray(record.targets)) return "targets é obrigatório (lista, possivelmente vazia).";
  return null;
}

/* ------------------------------------------------------------------------ *
 * CONTRATO DO SETUP PERSISTENTE
 *
 * O corpo é validado com zod e em modo ESTRITO: campo fora do contrato faz a
 * requisição cair com o nome do campo. Aceitar o desconhecido em silêncio (ou
 * "consertar por chute") deixaria um cliente desatualizado gravando setup com
 * nível que ninguém leu — e é a partir destes números que o desfecho WIN/LOSS
 * é julgado depois.
 * ------------------------------------------------------------------------ */

/*
 * VOCABULÁRIO CANÔNICO, IMPORTADO — nunca recopiado.
 *
 * A lista vivia duplicada aqui e era conferida contra a máquina por dois
 * `void`s de compilação. Conferir cópia é melhor que não conferir, mas a cópia
 * continua existindo: importar a lista de onde ela é definida elimina a classe
 * inteira do problema.
 */
const CANONICAL_STAGES = SETUP_STAGES;

/**
 * ESTÁGIOS ANTIGOS AINDA SÃO ACEITOS NA ENTRADA (§10).
 *
 * A máquina passou a falar o vocabulário padronizado (DETECTED, FORMING,
 * WAITING_BREAKOUT, …), mas o banco de produção tem linhas com os nomes em
 * português e uma aba aberta pode continuar enviando os antigos por alguns
 * minutos após o deploy. Recusá-los devolveria 422 sobre setup legítimo em
 * curso. Eles entram, são TRADUZIDOS por `normalizeStage`, e o que se grava é
 * sempre o canônico — o banco não acumula duas grafias do mesmo estado.
 */
const LEGACY_STAGES = [
  "SEM_SETUP",
  "OBSERVANDO",
  "APROXIMACAO",
  "FORMACAO",
  "PREPARADO",
  "CONFIRMADO",
  "ENCERRADO",
  "INVALIDADO",
  "EXPIRADO",
] as const;

const ACCEPTED_STAGES = [...CANONICAL_STAGES, ...LEGACY_STAGES] as [string, ...string[]];

const nivel = z.number().finite().nullable().default(null);
const instante = z.number().int().nullable().default(null);
const texto = z.string().trim().min(1).nullable().default(null);

const SetupPayload = z
  .object({
    setupId: z.string().trim().min(1),
    asset: z.string().trim().min(1),
    timeframe: texto,
    direction: z.enum(["COMPRA", "VENDA"]),
    stage: z.enum(ACCEPTED_STAGES).transform(normalizeStage),
    entry: nivel,
    stop: nivel,
    target: nivel,
    entryZoneMin: nivel,
    entryZoneMax: nivel,
    confirmedAt: instante,
    createdAt: z.number().int(),
    expiresAt: instante,
    dnaId: texto,
    printId: texto,

    /*
     * §32/§34 — O ESTADO DO ROMPIMENTO.
     *
     * Todos com `.default(...)` e todos CONSERVADORES: uma aba aberta antes
     * deste deploy continua gravando sem receber 422, e o que falta entra como
     * "nada observado". Um default otimista aqui — `operationReleased: true`
     * por omissão — faria a permissão de operar nascer do silêncio do cliente.
     *
     * O rompimento entra como objeto solto (`passthrough` implícito via
     * `z.unknown()`) de propósito: quem valida a FORMA dele é o `breakout.ts`,
     * que é dono do tipo. Duplicar o schema aqui criaria duas definições do
     * mesmo objeto, e elas divergiriam no primeiro ajuste da máquina.
     */
    triggerLevel: nivel,
    triggerVersion: z.number().int().min(1).default(1),
    triggerHistory: z.array(z.unknown()).default([]),
    breakout: z.unknown().nullable().default(null),
    operationReleased: z.boolean().default(false),
  })
  .strict()
  .superRefine((setup, ctx) => {
    /*
     * CONFIRMED SEM `confirmedAt` NÃO EXISTE. É o instante que separa o
     * passado do resultado (anti-look-ahead do `evaluateSetup`): sem ele, ou o
     * setup jamais fecharia, ou fecharia contra preços anteriores à própria
     * entrada — WIN fabricado com o passado.
     *
     * A comparação usa o vocabulário CANÔNICO porque `stage` já passou pelo
     * `transform(normalizeStage)` acima: um cliente antigo mandando
     * "CONFIRMADO" cai nesta mesma trava, e não por fora dela.
     */
    if (setup.stage === "CONFIRMED" && setup.confirmedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirmedAt"],
        message: "setup CONFIRMED exige confirmedAt — sem ele o desfecho não tem marco inicial.",
      });
    }
  });

/** Erro de contrato vira 422 com os campos nomeados — nunca gravação suja. */
function contractProblem(error: z.ZodError): { error: string; issues: string[] } {
  const issues = error.issues.map((issue) =>
    issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
  );
  return { error: `Corpo fora do contrato do setup: ${issues.join("; ")}`, issues };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function body<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}

export async function handleTradingRequest(request: Request): Promise<Response | null> {
  const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
  if (!path.startsWith("/api/trading/") && path !== "/api/trading") return null;

  try {
    if (request.method === "GET" && path === "/api/trading/snapshot") {
      return json({ ...getSnapshot(), database: databaseInfo() });
    }
    if (request.method === "GET" && path === "/api/trading/technique-current") {
      return json({ technique: getProductionTechnique() });
    }
    if (request.method === "GET" && path === "/api/trading/technique-candidates") {
      // O congelamento é VERIFICADO na leitura (B7): o leitor recebe o
      // veredito recalculado, nunca apenas o hash gravado.
      return json({ candidates: listTechniqueCandidates(), t42Freeze: verifyT42Freeze() });
    }
    /*
     * AS DUAS ROTAS ABAIXO TROCAM A TÉCNICA QUE DECIDE OPERAÇÃO REAL.
     *
     * Estavam abertas. O único requisito da promoção é `status === "VALIDATED"`,
     * e o status vinha no corpo da requisição — então dois POST sem credencial
     * nenhuma (inserir candidata já marcada como validada, depois promover)
     * substituíam a técnica de produção.
     *
     * Token obrigatório nas duas, e a validação do status passa a ser do
     * SERVIDOR: quem envia não decide se a própria candidata está validada.
     */
    if (request.method === "POST" && path === "/api/trading/technique-candidates") {
      const denied = requireAdmin(request);
      if (denied) return denied;
      const candidate = await body<Record<string, unknown>>(request);
      const problem = candidateStatusProblem(candidate);
      if (problem) return json({ error: problem }, 422);
      /*
       * CANDIDATA CONGELADA NÃO SE ATUALIZA — 409 (auditoria sênior, B7).
       * O upsert fazia ON CONFLICT DO UPDATE em cima de rules_json: dois
       * POSTs reescreviam o congelamento contra o qual meses de validação
       * foram medidos. Congelada = rules com `rulesHash`. Mudar regra
       * exige candidata NOVA com id novo — nunca a reescrita da antiga.
       */
      const idCandidata = String(candidate["id"] ?? "");
      const existente = listTechniqueCandidates().find((c) => c.id === idCandidata);
      const congelada =
        existente !== undefined &&
        existente.rules !== null &&
        typeof existente.rules === "object" &&
        typeof (existente.rules as Record<string, unknown>)["rulesHash"] === "string";
      if (congelada) {
        return json(
          {
            error: `Candidata ${idCandidata} está CONGELADA (rulesHash presente): atualizar invalidaria a validação em curso. Crie uma candidata nova com id novo.`,
          },
          409,
        );
      }
      upsertTechniqueCandidate(candidate as unknown as TechniqueCandidateRecord);
      /*
       * TODA candidata conta como hipótese testada — inclusive as enviadas
       * por esta rota. Sem isto, o denominador do §8 seria contornável por
       * omissão: bastava mandar vinte candidatas por aqui, escolher a melhor
       * e reenviá-la como VALIDATED com a régua ainda no piso.
       */
      const base = String(candidate["baseVersion"] ?? "");
      const id = String(candidate["id"] ?? "");
      if (base && id) {
        insertLabExperiment({
          id: `exp_${id}`,
          baseVersion: base,
          candidateId: id,
          hypothesis: String(candidate["hypothesis"] ?? "hipótese não declarada"),
          variation: candidate["rules"] ?? {},
          datasetId: candidate["datasetId"] ? String(candidate["datasetId"]) : null,
          createdAt: Number(candidate["createdAt"] ?? Date.now()),
        });
      }
      return json({ ok: true });
    }
    if (request.method === "POST" && path === "/api/trading/technique-promote") {
      const denied = requireAdmin(request);
      if (denied) return denied;
      const payload = await body<{ candidateId?: string }>(request);
      if (!payload.candidateId) return json({ error: "candidateId é obrigatório." }, 400);
      return json({ ok: true, technique: promoteTechniqueCandidate(payload.candidateId) });
    }
    if (request.method === "POST" && path === "/api/trading/learning-daily") {
      const payload = await body<{ tradingDate?: string; baseVersion?: string }>(request);
      if (!payload.tradingDate) return json({ error: "tradingDate é obrigatório." }, 400);
      return json({ ok: true, report: runDailyLearning(payload.tradingDate, payload.baseVersion) });
    }
    if (request.method === "POST" && path === "/api/trading/live-sessions") {
      upsertLiveSession(await body(request));
      return json({ ok: true });
    }
    if (request.method === "POST" && path === "/api/trading/trading-sessions") {
      upsertTradingSession(await body(request));
      return json({ ok: true });
    }
    if (request.method === "POST" && path === "/api/trading/segments") {
      upsertSegment(await body(request));
      return json({ ok: true });
    }
    if (request.method === "POST" && path === "/api/trading/replay-batch") {
      saveReplayBatch(await body(request));
      return json({ ok: true });
    }
    if (request.method === "POST" && path === "/api/trading/replay-sessions") {
      upsertReplaySession(await body(request));
      return json({ ok: true });
    }
    if (request.method === "POST" && path === "/api/trading/backtests") {
      upsertBacktest(await body(request));
      return json({ ok: true });
    }
    if (request.method === "POST" && path === "/api/trading/decision") {
      saveLastDecision(await body(request));
      return json({ ok: true });
    }
    if (request.method === "POST" && path === "/api/trading/events") {
      upsertMarketEvent(await body(request));
      return json({ ok: true });
    }

    /* ---------------- DNA T4: detecções, resultados e painel ---------------- */

    if (request.method === "GET" && path === "/api/trading/dna") {
      const query = new URL(request.url).searchParams;
      const filters = {
        from: query.get("from") ?? undefined,
        to: query.get("to") ?? undefined,
        asset: query.get("asset") ?? undefined,
      };
      return json({ detections: listSetupDna(filters), outcomes: listDnaOutcomes(filters) });
    }
    if (request.method === "POST" && path === "/api/trading/dna") {
      const record = await body<SetupDna>(request);
      const problem = dnaProblem(record);
      if (problem) return json({ error: problem }, 422);
      insertSetupDna(record);
      return json({ ok: true });
    }
    if (request.method === "POST" && path === "/api/trading/dna-link") {
      const payload = await body<{ dnaId?: string; tradeId?: string }>(request);
      if (!payload.dnaId || !payload.tradeId) {
        return json({ error: "dnaId e tradeId são obrigatórios." }, 400);
      }
      return json({ ok: true, linked: linkDnaToTrade(payload.dnaId, payload.tradeId) });
    }
    /*
     * O PAINEL calcula no servidor sobre TODOS os registros — o navegador
     * recebe leitura pronta, não milhares de linhas. As funções são as mesmas
     * puras e testadas de @/lib/t4/dnaStats; aqui só entra o dado real.
     */
    if (request.method === "GET" && path === "/api/trading/dna-panel") {
      const query = new URL(request.url).searchParams;
      const filters = {
        from: query.get("from") ?? undefined,
        to: query.get("to") ?? undefined,
        asset: query.get("asset") ?? undefined,
      };
      const outcomes = listDnaOutcomes(filters);
      /*
       * A metade INDIVIDUAL do §5: para cada perdedora recente, as vencedoras
       * mais parecidas e o que diferia. O agregado (lossFactors) diz onde as
       * perdas se concentram; isto responde "e as que ganharam no mesmo
       * contexto, o que tinham de diferente?" — a comparação que o operador
       * faz olhando um loss específico.
       */
      const perdedoras = outcomes
        .filter((o) => o.rMultiple !== null && o.rMultiple < 0)
        .sort((a, b) => b.dna.detectedAt - a.dna.detectedAt)
        .slice(0, 10);
      return json({
        detected: outcomes.length,
        withResult: outcomes.filter((o) => o.rMultiple !== null).length,
        segments: allSegments(outcomes),
        patterns: discoverPatterns(outcomes).slice(0, 40),
        lossFactors: lossFactorTable(outcomes),
        exitSchemes: compareExitSchemes(outcomes),
        lossComparisons: perdedoras.map((perdedora) => ({
          loser: perdedora,
          similar: similarWinners(perdedora, outcomes, 3),
        })),
      });
    }

    // §24 — gera candidatas a partir da comparação vencedores×perdedores da
    // memória. Mexe no contexto de validação ⇒ mesma barreira de admin.
    if (request.method === "POST" && path === "/api/trading/memory-hypotheses") {
      const denied = requireAdmin(request);
      if (denied) return denied;
      const payload = await body<{ baseVersion?: string }>(request);
      return json({ ok: true, ...generateHypothesesFromMemory(payload.baseVersion ?? "T4.0.0") });
    }

    /* -------- Laboratório: experimentos (hipóteses testadas) e datasets -------- */

    if (request.method === "GET" && path === "/api/trading/experiments") {
      const base = new URL(request.url).searchParams.get("base") ?? undefined;
      return json({
        experiments: listLabExperiments(base),
        tested: base ? countLabExperiments(base) : null,
      });
    }
    if (request.method === "POST" && path === "/api/trading/experiments") {
      // Registrar hipótese altera o contexto de validação das candidatas —
      // mesma barreira das rotas que mexem na técnica.
      const denied = requireAdmin(request);
      if (denied) return denied;
      const payload = await body<Record<string, unknown>>(request);
      if (!payload["id"] || !payload["baseVersion"] || !payload["hypothesis"]) {
        return json({ error: "id, baseVersion e hypothesis são obrigatórios." }, 400);
      }
      insertLabExperiment({
        id: String(payload["id"]),
        baseVersion: String(payload["baseVersion"]),
        candidateId: payload["candidateId"] ? String(payload["candidateId"]) : null,
        hypothesis: String(payload["hypothesis"]),
        variation: payload["variation"] ?? {},
        datasetId: payload["datasetId"] ? String(payload["datasetId"]) : null,
        createdAt: Number(payload["createdAt"] ?? Date.now()),
      });
      return json({ ok: true });
    }
    if (request.method === "GET" && path === "/api/trading/datasets") {
      return json({ datasets: listDatasets() });
    }
    if (request.method === "POST" && path === "/api/trading/datasets") {
      const denied = requireAdmin(request);
      if (denied) return denied;
      const payload = await body<Record<string, unknown>>(request);
      const kind = String(payload["kind"] ?? "");
      if (!payload["id"] || !payload["name"] || !payload["startDate"] || !payload["endDate"]) {
        return json({ error: "id, name, startDate e endDate são obrigatórios." }, 400);
      }
      if (kind !== "TREINO" && kind !== "VALIDACAO" && kind !== "OOS") {
        return json({ error: "kind precisa ser TREINO, VALIDACAO ou OOS." }, 422);
      }
      try {
        upsertDataset({
          id: String(payload["id"]),
          name: String(payload["name"]),
          kind,
          startDate: String(payload["startDate"]),
          endDate: String(payload["endDate"]),
          tradeCount: Number(payload["tradeCount"] ?? 0),
          frozen: payload["frozen"] === true,
          createdAt: Number(payload["createdAt"] ?? Date.now()),
        });
      } catch (raised) {
        // Dataset congelado é imutável — 409, não 500: o cliente errou, não o servidor.
        const message = raised instanceof Error ? raised.message : String(raised);
        if (message.includes("congelado")) return json({ error: message }, 409);
        throw raised;
      }
      return json({ ok: true });
    }

    /* -------- SETUPS PERSISTENTES: restaurar, gravar e placar (§21) -------- */

    if (request.method === "GET" && path === "/api/trading/setups/stats") {
      const asset = new URL(request.url).searchParams.get("asset") ?? undefined;
      return json({ asset: asset ?? null, stats: setupStats(asset) });
    }
    /*
     * É esta rota que RESTAURA o setup ativo depois de reiniciar o backend —
     * a máquina roda no navegador e morre com a aba; o servidor é quem lembra.
     */
    if (request.method === "GET" && path === "/api/trading/setups") {
      const query = new URL(request.url).searchParams;
      const asset = query.get("asset") ?? undefined;
      const apenasAbertos = query.get("open") === "1";
      return json({
        setups: apenasAbertos ? listOpenSetups(asset) : listSetups(asset),
        open: apenasAbertos,
      });
    }
    if (request.method === "POST" && path === "/api/trading/setups") {
      const parsed = SetupPayload.safeParse(await body<unknown>(request));
      if (!parsed.success) return json(contractProblem(parsed.error), 422);
      const stored = upsertSetup({
        ...parsed.data,
        // O contrato do repositório é tipado pelo domínio; o schema aceita o
        // objeto opaco. A conversão acontece AQUI, num ponto só.
        triggerHistory: parsed.data.triggerHistory as TriggerVersion[],
        breakout: (parsed.data.breakout ?? null) as BreakoutState | null,
      });
      /*
       * REPARO DECLARADO: o cliente pode estar com uma visão velha do setup que
       * a varredura já fechou. A escrita é recusada (o desfecho não se
       * reescreve) e a resposta DIZ isso, em vez de responder `ok` e deixar o
       * operador achando que o setup voltou a viver.
       */
      return json({
        ok: true,
        outcome: stored.outcome,
        frozen: stored.frozen,
        note: stored.frozen
          ? `setup já fechado como ${stored.outcome} — atualização recusada, desfecho não reabre`
          : null,
      });
    }

    /* -------- MEMÓRIA T4: prints persistidos, vereditos e consulta -------- */

    if (request.method === "POST" && path === "/api/trading/prints") {
      const payload = await body<Record<string, unknown>>(request);
      if (!payload["id"] || !payload["asset"] || !payload["status"] || !payload["direction"]) {
        return json({ error: "id, asset, status e direction são obrigatórios." }, 400);
      }
      /*
       * `passes` (§13): metadado dos 2 passes do auto-crop — motivo do 2º
       * passe, escolha e score de cada leitura. OPCIONAL, e recusado quando
       * chega com forma errada: guardar um número solto onde a tela espera o
       * relato dos passes seria dado inventado. Só metadado — não duplica
       * aprendizado nem cria um segundo registro de print.
       */
      const passesProblem =
        payload["passes"] === undefined ||
        payload["passes"] === null ||
        (typeof payload["passes"] === "object" && payload["passes"] !== null)
          ? null
          : `passes precisa ser objeto ou lista (recebido: ${typeof payload["passes"]}).`;
      if (passesProblem !== null) return json({ error: passesProblem }, 422);
      savePrintRecord({
        id: String(payload["id"]),
        sessionId: payload["sessionId"] ? String(payload["sessionId"]) : null,
        asset: String(payload["asset"]),
        timeframe: payload["timeframe"] ? String(payload["timeframe"]) : null,
        capturedAt: Number(payload["capturedAt"] ?? Date.now()),
        status: String(payload["status"]),
        direction: String(payload["direction"]),
        confidence: Number(payload["confidence"] ?? 0),
        currentPrice: typeof payload["currentPrice"] === "number" ? payload["currentPrice"] : null,
        dnaId: payload["dnaId"] ? String(payload["dnaId"]) : null,
        captureCode: payload["captureCode"] ? String(payload["captureCode"]) : null,
        analysis: payload["analysis"] ?? {},
        imageDataUrl: typeof payload["imageDataUrl"] === "string" ? payload["imageDataUrl"] : null,
        prediction:
          payload["prediction"] && typeof payload["prediction"] === "object"
            ? (payload["prediction"] as { entry: number | null; stop: number; target: number })
            : null,
        passes: payload["passes"] ?? null,
        /*
         * REPAROS: só lista de texto entra.
         *
         * Recusar em silêncio o que vem torto seria perder justamente o que
         * este campo existe para preservar. Forma errada vira lista vazia e
         * NÃO 422: o print é bom, o metadado é que veio ruim, e derrubar a
         * gravação por causa do metadado perderia a análise inteira.
         */
        repairs: Array.isArray(payload["repairs"])
          ? (payload["repairs"] as unknown[]).filter((r) => typeof r === "string").map(String)
          : null,
      });
      // A varredura roda no MESMO evento: cada print novo tenta fechar os
      // vereditos anteriores do ativo — aprendizado sem intervenção manual.
      const asset = String(payload["asset"]);
      const resolved = sweepPredictionOutcomes(asset);
      /*
       * O MESMO evento fecha os SETUPS e entrega o resultado à memória. O print
       * novo é a observação de preço que faltava; esperar uma ação do operador
       * para fechar o ciclo é como o setup confirmado ficava eterno.
       */
      const setupsResolved = sweepSetupOutcomes(asset);
      const learned = learnFromClosedSetups(asset);
      return json({
        ok: true,
        resolvedNow: resolved,
        setupsResolvedNow: setupsResolved,
        setupsLearnedNow: learned.applied,
        setupsWithoutDna: learned.withoutDna,
      });
    }
    if (request.method === "GET" && path === "/api/trading/memory") {
      const query = new URL(request.url).searchParams;
      const dnaId = query.get("dnaId");
      if (!dnaId) return json({ error: "dnaId é obrigatório." }, 400);
      const current = getSetupDna(dnaId);
      if (!current) return json({ error: "DNA não encontrado — persista a detecção antes." }, 404);
      const cases = listMemoryCases(query.get("asset") ?? undefined);
      const readout = queryMemory(current, cases);
      const visual = Number(query.get("visual") ?? NaN);
      const combined = Number.isFinite(visual) ? combineConfidence(visual, readout) : null;
      return json({
        // Compacto para a tela: o DNA inteiro de cada caso não precisa viajar.
        similarCases: readout.similarCases.slice(0, 5).map((c) => ({
          printId: c.memoryCase.printId,
          verdict: c.memoryCase.verdict,
          ambiguous: c.memoryCase.ambiguous,
          similarity: c.similarity,
          grade: c.memoryCase.dna.grade,
          direction: c.memoryCase.dna.direction,
          tradingDate: c.memoryCase.dna.tradingDate,
          differences: c.differences.slice(0, 3),
        })),
        totalSimilar: readout.similarCases.length,
        resolvedCount: readout.resolvedCount,
        hits: readout.hits,
        misses: readout.misses,
        rawHitRate: readout.rawHitRate,
        historicalConfidence: readout.historicalConfidence,
        note: readout.note,
        finalConfidence: combined?.finalConfidence ?? null,
        formula: combined?.formula ?? null,
      });
    }

    /* -------- T4 AUTO RESEARCH: importar CSV e rodar a pesquisa -------- */

    if (request.method === "POST" && path === "/api/trading/research/import") {
      const payload = await body<{ datasetId?: string; csv?: string }>(request);
      if (!payload.datasetId || !payload.csv) {
        return json({ error: "datasetId e csv são obrigatórios." }, 400);
      }
      const parsed = parseCandlesCsv(payload.csv);
      if (parsed.candles.length === 0) {
        return json(
          { error: "nenhum candle legível no CSV", problems: parsed.problems.slice(0, 20) },
          422,
        );
      }
      const saved = saveImportedCandles(payload.datasetId, parsed.candles);
      return json({
        ok: true,
        format: parsed.format,
        received: parsed.candles.length,
        saved,
        problems: parsed.problems.slice(0, 20),
        problemCount: parsed.problems.length,
      });
    }

    if (request.method === "POST" && path === "/api/trading/research/run") {
      const payload = await body<{ datasetId?: string; asset?: string; folds?: number }>(request);
      if (!payload.datasetId || !payload.asset) {
        return json({ error: "datasetId e asset são obrigatórios." }, 400);
      }
      const candles = loadImportedCandles(payload.datasetId);
      /*
       * TRUNCAMENTO DECLARADO, nunca silencioso.
       *
       * O teto de 30.000 candles corta a ponta ANTIGA do dataset. Se o CSV for
       * maior, o resultado vale para o trecho recente — e o operador precisa
       * saber, porque antes `metrics.candles` aparecia sozinho e parecia o
       * dataset inteiro, com o corte "OOS = últimos 15%" caindo no meio dele.
       */
      const candlesNoDataset = importedCandleCount(payload.datasetId);
      const truncado = candlesNoDataset > candles.length;
      if (candles.length < 100) {
        return json(
          { error: `apenas ${candles.length} candles no dataset — mínimo 100 para pesquisa.` },
          422,
        );
      }

      // 1. Backtest quant completo — mesmo pipeline T4 do ao vivo, sem futuro.
      const full = runQuantBacktest(candles, { asset: payload.asset });
      const stats = computeStats(full.trades);

      // 2. OOS declarado: os últimos 15% do PERÍODO nunca participam de
      // otimização (não há otimização nesta rodada — o corte fica registrado
      // para quando houver candidatas variando parâmetros).
      const oosStart = candles[Math.floor(candles.length * 0.85)]!.t;
      const oosTrades = full.trades.filter((tr) => tr.openedAt >= oosStart);
      const oosStats = computeStats(oosTrades);

      // 3. Walk-forward: janelas cronológicas; cada fold roda o quant no
      // trecho treino+teste e conta SÓ os trades abertos na janela de teste.
      const folds = buildFolds(
        candles.map((c) => c.t),
        Math.min(payload.folds ?? 5, 8),
      );
      const foldResults = folds.map((fold) => {
        const slice = candles.filter((c) => c.t >= fold.trainStart && c.t <= fold.testEnd);
        const result = runQuantBacktest(slice, { asset: payload.asset! });
        const testTrades = result.trades.filter(
          (tr) => tr.openedAt >= fold.testStart && tr.openedAt <= fold.testEnd,
        );
        return { fold, trades: testTrades.length, netR: computeStats(testTrades).cumulativeR };
      });
      const stability = walkForwardStability(foldResults);

      // 4. Monte Carlo com seed fixa: pesquisa irreproduzível não é pesquisa.
      const mc = monteCarloDrawdown(
        full.trades.map((tr) => tr.rMultiple),
        2000,
        42,
      );

      // 5. Ranking — nunca só lucro; amostra pequena é dita inelegível.
      const ranked = rankVersions([
        {
          version: "T4.0.0",
          trades: stats.total,
          winRate: stats.winRate,
          expectancyR: stats.expectancy,
          profitFactor: Number.isFinite(stats.profitFactor) ? stats.profitFactor : 99,
          maxDrawdownR: stats.maxDrawdown,
          oosExpectancyR: oosStats.total > 0 ? oosStats.expectancy : null,
          walkForwardStable: stability.totalFolds >= 3 ? stability.stable : null,
        },
      ]);

      const metrics = {
        candles: candles.length,
        // O dataset inteiro e se a rodada viu só um pedaço dele.
        candlesNoDataset,
        truncado,
        discards: full.discards,
        setupsDetected: full.setupsDetected,
        stats,
        oos: { start: oosStart, trades: oosStats.total, expectancyR: oosStats.expectancy },
        walkForward: { folds: foldResults, ...stability },
        monteCarlo: mc,
        ranking: ranked[0] ?? null,
      };
      const runId = `run_${Date.now()}`;
      saveResearchRun({
        id: runId,
        datasetId: payload.datasetId,
        asset: payload.asset,
        techniqueVersion: "T4.0.0",
        metrics,
        status: "DONE",
      });
      return json({ ok: true, runId, metrics });
    }

    /*
     * SWEEP DE CANDIDATAS (§25, §28-30) — varia parâmetros controlados da T4
     * e ranqueia contra o BASELINE, que entra na tabela e nunca é alterado.
     *
     * Nada aqui promove nada: toda variante sai com status CANDIDATA e a
     * régua anti-overfitting sobe conforme o número de hipóteses testadas.
     * A janela OOS é VETO, nunca critério de escolha.
     */
    if (request.method === "POST" && path === "/api/trading/research/sweep") {
      const payload = await body<{
        datasetId?: string;
        asset?: string;
        limit?: number;
        minTrades?: number;
      }>(request);
      if (!payload.datasetId || !payload.asset) {
        return json({ error: "datasetId e asset são obrigatórios." }, 400);
      }
      const candles = loadImportedCandles(payload.datasetId);
      /*
       * TRUNCAMENTO DECLARADO, nunca silencioso.
       *
       * O teto de 30.000 candles corta a ponta ANTIGA do dataset. Se o CSV for
       * maior, o resultado vale para o trecho recente — e o operador precisa
       * saber, porque antes `metrics.candles` aparecia sozinho e parecia o
       * dataset inteiro, com o corte "OOS = últimos 15%" caindo no meio dele.
       */
      const candlesNoDataset = importedCandleCount(payload.datasetId);
      const truncado = candlesNoDataset > candles.length;
      if (candles.length < 100) {
        return json(
          { error: `apenas ${candles.length} candles no dataset — mínimo 100 para pesquisa.` },
          422,
        );
      }
      // Teto explícito: cada candidata a mais ENDURECE a régua de todas as
      // outras, então varrer sem limite se sabotaria sozinho.
      const limite = Math.min(Math.max(Math.trunc(payload.limit ?? 12), 1), 24);
      const report = runParamSweep(candles, {
        asset: payload.asset,
        candidates: buildCandidates(undefined, limite),
        ...(payload.minTrades === undefined ? {} : { minTrades: payload.minTrades }),
      });
      return json({ ok: true, report, candles: candles.length, candlesNoDataset, truncado });
    }

    if (request.method === "GET" && path === "/api/trading/research/runs") {
      return json({ runs: listResearchRuns() });
    }

    return json({ error: "Endpoint de persistência não encontrado." }, 404);
  } catch (error) {
    console.error("trading persistence error", error);
    return json(
      {
        error: "Falha na persistência do analisador.",
        detail: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
}
