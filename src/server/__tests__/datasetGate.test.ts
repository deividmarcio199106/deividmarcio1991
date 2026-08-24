import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { autorizarDataset } from "@/lib/t4/datasetEnforcement";
import { T42_CANDIDATE_ID } from "@/lib/t4/techniqueT42";
import {
  getSnapshot,
  resetTradingRepositoryForTests,
  t42DatasetSeen,
  verifyT42Freeze,
} from "../tradingRepository";

/**
 * O GATE DE DATASET CONTRA O BANCO REAL (BLOCO 9): o mesmo fluxo que o
 * pregão executa — freeze verificado + datasetSeen LIDOS do registro — decide
 * se julho abre. Pré-freeze-violado bloqueia; pós-freeze-íntegro abre.
 */

let workingDir: string | null = null;

function freshDatabase(): string {
  resetTradingRepositoryForTests();
  const dir = mkdtempSync(join(tmpdir(), "analisador-dataset-"));
  workingDir = dir;
  process.env.DATA_DIR = dir;
  delete process.env.DATABASE_PATH;
  return dir;
}

afterEach(() => {
  resetTradingRepositoryForTests();
  if (workingDir) rmSync(workingDir, { recursive: true, force: true });
  workingDir = null;
  delete process.env.DATA_DIR;
  delete process.env.DATABASE_PATH;
});

describe.sequential("gate de dataset contra o banco real", () => {
  it("com o freeze ÍNTEGRO, julho abre como OOS e datasetSeen vem do registro", () => {
    freshDatabase();
    getSnapshot();
    expect(t42DatasetSeen()).toEqual(["MARCO"]);
    const veredito = autorizarDataset({
      data: "2026-07-01",
      congelamento: verifyT42Freeze(),
      datasetSeen: t42DatasetSeen(),
    });
    expect(veredito).toMatchObject({ allowed: true, value: { papel: "OOS_FINAL_SELADO" } });
  });

  it("com o freeze VIOLADO no banco, julho NÃO abre — bloqueio com o motivo real", () => {
    const dir = freshDatabase();
    getSnapshot();
    resetTradingRepositoryForTests();
    const database = new DatabaseSync(join(dir, "analisador.sqlite"));
    const row = database
      .prepare("SELECT rules_json FROM technique_candidates WHERE id=?")
      .get(T42_CANDIDATE_ID) as { rules_json: string };
    const rules = JSON.parse(row.rules_json) as Record<string, unknown>;
    (rules["config"] as Record<string, unknown>)["ttlCandles"] = 7;
    database
      .prepare("UPDATE technique_candidates SET rules_json=? WHERE id=?")
      .run(JSON.stringify(rules), T42_CANDIDATE_ID);
    database.close();

    const veredito = autorizarDataset({
      data: "2026-07-01",
      congelamento: verifyT42Freeze(),
      datasetSeen: t42DatasetSeen(),
    });
    expect(veredito.allowed).toBe(false);
    if (!veredito.allowed) expect(veredito.reason).toContain("adulterado");
  });

  it("o pregão de vídeo executa ESTE gate — a cadeia existe no fonte", () => {
    const pregao = readFileSync("src/server/video/pregao.ts", "utf8");
    expect(pregao).toContain("autorizarDataset({");
    expect(pregao).toContain("congelamento: verifyT42Freeze()");
    expect(pregao).toContain("datasetSeen: t42DatasetSeen()");
    expect(pregao).toContain("DATASET BLOQUEADO");
  });
});
