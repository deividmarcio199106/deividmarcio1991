import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { handleTradingRequest } from "../tradingEndpoints";
import { getDatabase, listSetups, resetTradingRepositoryForTests } from "../tradingRepository";

/**
 * O CONTRATO DAS ROTAS DE SETUP, exercitado por Request/Response de verdade.
 * O que se prova aqui: campo fora do contrato é RECUSADO (não "consertado"),
 * o setup ativo é recuperável depois do restart, e a gravação de print fecha
 * setup e entrega o aprendizado no MESMO evento.
 */

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const BASE = "http://localhost";

let workingDir: string | null = null;

function freshDatabase(): void {
  resetTradingRepositoryForTests();
  const dir = mkdtempSync(join(tmpdir(), "analisador-setup-api-"));
  workingDir = dir;
  process.env.DATA_DIR = dir;
  delete process.env.DATABASE_PATH;
  process.env.PRINT_IMAGE_RETENTION_DAYS = "0";
}

afterEach(() => {
  resetTradingRepositoryForTests();
  if (workingDir) rmSync(workingDir, { recursive: true, force: true });
  workingDir = null;
  delete process.env.DATA_DIR;
  delete process.env.DATABASE_PATH;
  delete process.env.PRINT_IMAGE_RETENTION_DAYS;
});

async function post(path: string, payload: unknown): Promise<{ status: number; body: never }> {
  const response = await handleTradingRequest(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
  if (!response) throw new Error(`rota ${path} não respondeu`);
  return { status: response.status, body: (await response.json()) as never };
}

async function get(path: string): Promise<{ status: number; body: never }> {
  const response = await handleTradingRequest(new Request(`${BASE}${path}`));
  if (!response) throw new Error(`rota ${path} não respondeu`);
  return { status: response.status, body: (await response.json()) as never };
}

function setupBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    setupId: "T4-2026-08-19-001",
    asset: "WINFUT",
    timeframe: "1m",
    direction: "COMPRA",
    stage: "CONFIRMADO",
    entry: 138_000,
    stop: 137_800,
    target: 138_600,
    entryZoneMin: null,
    entryZoneMax: null,
    confirmedAt: T0,
    createdAt: T0 - 5 * MIN,
    expiresAt: T0 + 45 * MIN,
    dnaId: null,
    printId: null,
    ...over,
  };
}

function printBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "print_1",
    asset: "WINFUT",
    timeframe: "1m",
    capturedAt: T0 + MIN,
    status: "SETUP",
    direction: "COMPRA",
    confidence: 70,
    // Campos do ciclo de vida do candle: o fixture-padrao nao le relogio nem
    // candle fechado — quem testa isso preenche explicitamente.
    chartClock: { date: null, time: null },
    lastClosedCandle: null,
    currentPrice: 138_650,
    captureCode: "CICLO_60S",
    analysis: { note: "print de teste" },
    ...over,
  };
}

describe.sequential("endpoints de setup persistente", () => {
  it("POST grava e GET open=1 restaura o setup ativo", async () => {
    freshDatabase();
    const gravado = await post("/api/trading/setups", setupBody());
    expect(gravado.status).toBe(200);
    expect(gravado.body).toMatchObject({ ok: true, outcome: "ABERTO", frozen: false });

    // O restart do backend: singleton fechado, banco relido do disco.
    resetTradingRepositoryForTests();

    const lista = await get("/api/trading/setups?asset=WINFUT&open=1");
    expect(lista.status).toBe(200);
    const setups = (lista.body as { setups: Array<Record<string, unknown>> }).setups;
    expect(setups).toHaveLength(1);
    expect(setups[0]).toMatchObject({
      setupId: "T4-2026-08-19-001",
      outcome: "ABERTO",
      direction: "COMPRA",
      entry: 138_000,
      confirmedAt: T0,
    });
  });

  it("campo fora do contrato é recusado com 422 e o nome do campo", async () => {
    freshDatabase();
    const resposta = await post(
      "/api/trading/setups",
      setupBody({ entradaMagica: 999, setupId: "T4-2026-08-19-002" }),
    );

    expect(resposta.status).toBe(422);
    expect(String((resposta.body as { error: string }).error)).toContain("entradaMagica");
    // Recusado é recusado: nada foi gravado por chute.
    expect(listSetups("WINFUT")).toHaveLength(0);
  });

  it("estágio fora do vocabulário e CONFIRMADO sem confirmedAt são recusados", async () => {
    freshDatabase();
    const estagio = await post("/api/trading/setups", setupBody({ stage: "QUASE_LA" }));
    expect(estagio.status).toBe(422);
    expect((estagio.body as { issues: string[] }).issues.join(" ")).toContain("stage");

    const semMarco = await post("/api/trading/setups", setupBody({ confirmedAt: null }));
    expect(semMarco.status).toBe(422);
    expect((semMarco.body as { issues: string[] }).issues.join(" ")).toContain("confirmedAt");

    expect(listSetups("WINFUT")).toHaveLength(0);
  });

  it("gravar print fecha o setup e entrega o aprendizado no mesmo evento", async () => {
    freshDatabase();
    await post("/api/trading/setups", setupBody());

    const resposta = await post("/api/trading/prints", printBody());

    expect(resposta.status).toBe(200);
    expect(resposta.body).toMatchObject({ ok: true, setupsResolvedNow: 1 });
    // Sem DNA vinculado o caso não entra na memória — e isso é DITO.
    expect(resposta.body).toMatchObject({ setupsLearnedNow: 0, setupsWithoutDna: 1 });

    const linha = listSetups("WINFUT")[0]!;
    expect(linha.outcome).toBe("WIN");
    expect(linha.learned).toBe(true);
  });

  it("POST em setup já fechado responde frozen com o motivo, sem reabrir", async () => {
    freshDatabase();
    await post("/api/trading/setups", setupBody());
    await post("/api/trading/prints", printBody({ currentPrice: 137_700 }));

    const reenvio = await post("/api/trading/setups", setupBody({ stage: "CONFIRMADO" }));
    expect(reenvio.body).toMatchObject({ ok: true, outcome: "LOSS", frozen: true });
    expect(String((reenvio.body as { note: string }).note)).toContain("não reabre");
  });

  it("stats declara a guarda de amostra mínima", async () => {
    freshDatabase();
    await post("/api/trading/setups", setupBody());
    await post("/api/trading/prints", printBody());

    const resposta = await get("/api/trading/setups/stats?asset=WINFUT");
    expect(resposta.status).toBe(200);
    const stats = (resposta.body as { stats: Record<string, unknown> }).stats;
    expect(stats).toMatchObject({ total: 1, wins: 1, losses: 0, decided: 1, sufficient: false });
    expect(String(stats["note"])).toContain("conclusão NÃO autorizada");
  });

  it("passes do auto-crop é persistido como metadado e recusado quando malformado", async () => {
    freshDatabase();
    const passes = [
      { pass: 1, reason: "primeira leitura", score: 4 },
      { pass: 2, reason: "confiança < 60", score: 7, chosen: true },
    ];
    const ok = await post("/api/trading/prints", printBody({ passes }));
    expect(ok.status).toBe(200);

    const linha = getDatabase()
      .prepare("SELECT passes_json FROM prints WHERE id=?")
      .get("print_1") as { passes_json: string | null };
    expect(JSON.parse(String(linha.passes_json))).toEqual(passes);

    // Print de UM passe: ausência é NULL declarado, nunca "{}".
    await post("/api/trading/prints", printBody({ id: "print_2" }));
    const semPasses = getDatabase()
      .prepare("SELECT passes_json FROM prints WHERE id=?")
      .get("print_2") as { passes_json: string | null };
    expect(semPasses.passes_json).toBeNull();

    // Forma errada não é consertada por chute.
    const recusado = await post("/api/trading/prints", printBody({ id: "print_3", passes: "2" }));
    expect(recusado.status).toBe(422);
    expect(String((recusado.body as { error: string }).error)).toContain("passes");
    expect(getDatabase().prepare("SELECT 1 FROM prints WHERE id='print_3'").get()).toBeUndefined();
  });
});
