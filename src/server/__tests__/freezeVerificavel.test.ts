import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { T42_CANDIDATE_ID } from "@/lib/t4/techniqueT42";
import { handleTradingRequest } from "../tradingEndpoints";
import {
  getSnapshot,
  promoteTechniqueCandidate,
  resetTradingRepositoryForTests,
  verifyT42Freeze,
} from "../tradingRepository";

/**
 * CONGELAMENTO VERIFICÁVEL (auditoria sênior, BLOCO 7).
 *
 * O hash gravado com a T4.2 era decorativo: nada o recalculava, o upsert
 * reescrevia rules_json por cima, e o migrate() regravava a técnica de
 * produção a cada boot. O que se tranca aqui:
 *
 *   1. banco recém-semeado verifica OK (o hash gravado é o do código);
 *   2. ADULTERAÇÃO do registro (número editado no banco) ⇒ bloqueio com
 *      motivo específico — o conteúdo não bate com o hash gravado;
 *   3. hash gravado trocado ⇒ bloqueio — deriva declarada;
 *   4. a promoção da T4.2 RECUSA quando o congelamento não verifica;
 *   5. o endpoint devolve 409 para update de candidata CONGELADA — e o
 *      registro no banco permanece intocado;
 *   6. candidata NÃO congelada continua atualizável (o 409 não é um cadeado
 *      geral, é o contrato do freeze).
 */

let workingDir: string | null = null;

function freshDatabase(): string {
  resetTradingRepositoryForTests();
  const dir = mkdtempSync(join(tmpdir(), "analisador-freeze-"));
  workingDir = dir;
  process.env.DATA_DIR = dir;
  delete process.env.DATABASE_PATH;
  process.env.ADMIN_TOKEN = "token-de-teste";
  return dir;
}

afterEach(() => {
  resetTradingRepositoryForTests();
  if (workingDir) rmSync(workingDir, { recursive: true, force: true });
  workingDir = null;
  delete process.env.DATA_DIR;
  delete process.env.DATABASE_PATH;
  delete process.env.ADMIN_TOKEN;
});

/** Edita o rules_json gravado DIRETO no arquivo — simulando adulteração. */
function adulterar(dir: string, transform: (rules: Record<string, unknown>) => void): void {
  resetTradingRepositoryForTests();
  const database = new DatabaseSync(join(dir, "analisador.sqlite"));
  const row = database
    .prepare("SELECT rules_json FROM technique_candidates WHERE id=?")
    .get(T42_CANDIDATE_ID) as { rules_json: string };
  const rules = JSON.parse(row.rules_json) as Record<string, unknown>;
  transform(rules);
  database
    .prepare("UPDATE technique_candidates SET rules_json=? WHERE id=?")
    .run(JSON.stringify(rules), T42_CANDIDATE_ID);
  database.close();
}

async function post(path: string, payload: unknown): Promise<{ status: number; body: never }> {
  const response = await handleTradingRequest(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": "token-de-teste" },
      body: JSON.stringify(payload),
    }),
  );
  if (!response) throw new Error(`rota ${path} não respondeu`);
  return { status: response.status, body: (await response.json()) as never };
}

describe.sequential("congelamento T4.2 verificável na leitura", () => {
  it("banco recém-semeado verifica OK — o hash gravado é o do código", () => {
    freshDatabase();
    // Força a semeadura (qualquer leitura abre o banco e roda migrate+seed).
    getSnapshot();
    const veredito = verifyT42Freeze();
    expect(veredito.ok).toBe(true);
    expect(veredito.hashArmazenado).toBe(veredito.hashDoCodigo);
  });

  it("número adulterado no banco ⇒ bloqueio com motivo de adulteração", () => {
    const dir = freshDatabase();
    getSnapshot();
    adulterar(dir, (rules) => {
      (rules["config"] as Record<string, unknown>)["ttlCandles"] = 5;
    });
    const veredito = verifyT42Freeze();
    expect(veredito.ok).toBe(false);
    expect(veredito.motivo).toContain("adulterado");
  });

  it("hash gravado trocado ⇒ bloqueio (a checagem de conteúdo pega primeiro)", () => {
    const dir = freshDatabase();
    getSnapshot();
    adulterar(dir, (rules) => {
      rules["rulesHash"] = "0".repeat(64);
    });
    const veredito = verifyT42Freeze();
    expect(veredito.ok).toBe(false);
    // Trocar o hash sem trocar o conteúdo cai na checagem de INTEGRIDADE:
    // o conteúdo re-hasheia para o valor original e não bate com o gravado.
    expect(veredito.motivo).toMatch(/bate/i);
  });

  it("promoção da T4.2 RECUSA sem congelamento verificado", () => {
    const dir = freshDatabase();
    getSnapshot();
    adulterar(dir, (rules) => {
      (rules["config"] as Record<string, unknown>)["fillSlippageTicks"] = 0;
    });
    // Marca VALIDATED direto no banco: o alvo do teste é o portão do freeze,
    // não o portão de status (que já tem teste próprio).
    resetTradingRepositoryForTests();
    const database = new DatabaseSync(join(dir, "analisador.sqlite"));
    database
      .prepare("UPDATE technique_candidates SET status='VALIDATED' WHERE id=?")
      .run(T42_CANDIDATE_ID);
    database.close();
    expect(() => promoteTechniqueCandidate(T42_CANDIDATE_ID)).toThrow(/congelamento/i);
  });

  it("endpoint: update de candidata CONGELADA ⇒ 409, e o banco fica intocado", async () => {
    freshDatabase();
    getSnapshot();
    const antes = verifyT42Freeze();
    const { status, body } = await post("/api/trading/technique-candidates", {
      id: T42_CANDIDATE_ID,
      version: "T4.2.1-tentativa",
      baseVersion: "T4.0.0",
      hypothesis: "tentativa de reescrever a candidata congelada",
      status: "DISCOVERED",
      rules: { ttlCandles: 99 },
      createdAt: 1,
      updatedAt: 2,
    });
    expect(status).toBe(409);
    expect(String((body as { error: string }).error)).toContain("CONGELADA");
    const depois = verifyT42Freeze();
    expect(depois).toEqual(antes);
  });

  it("candidata NÃO congelada continua atualizável — o 409 é do freeze, não um cadeado geral", async () => {
    freshDatabase();
    getSnapshot();
    const nova = {
      id: "candidata_livre",
      version: "vX.1",
      baseVersion: "T4.0.0",
      hypothesis: "hipótese de laboratório ainda sem congelamento",
      status: "DISCOVERED",
      rules: { ideia: "sem rulesHash — não está congelada" },
      createdAt: 1,
      updatedAt: 1,
    };
    expect((await post("/api/trading/technique-candidates", nova)).status).toBe(200);
    expect(
      (await post("/api/trading/technique-candidates", { ...nova, updatedAt: 2 })).status,
    ).toBe(200);
  });
});
