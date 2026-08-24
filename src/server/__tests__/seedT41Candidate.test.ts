import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { T41_CANDIDATE_ID } from "@/lib/t4/techniqueT41";
import {
  getDatabase,
  listTechniqueCandidates,
  resetTradingRepositoryForTests,
} from "../tradingRepository";

/**
 * A CANDIDATA PRECISA EXISTIR NO BANCO, não só no código.
 *
 * `techniqueT41.ts` monta o registro; se ninguém o gravar, a T4.1 é uma
 * intenção num arquivo — e o laboratório continua sem ter contra o que medir. E
 * grava UMA VEZ: um seed que reescreve `rules_json` a cada boot destrói o
 * congelamento que dá sentido ao resultado da validação.
 */

let workingDir: string | null = null;

function freshDatabase(): void {
  resetTradingRepositoryForTests();
  const dir = mkdtempSync(join(tmpdir(), "analisador-t41-seed-"));
  workingDir = dir;
  process.env.DATA_DIR = dir;
  delete process.env.DATABASE_PATH;
}

afterEach(() => {
  resetTradingRepositoryForTests();
  if (workingDir) rmSync(workingDir, { recursive: true, force: true });
  workingDir = null;
  delete process.env.DATA_DIR;
});

describe("seed da candidata T4.1-REGIME_ADAPTIVE", () => {
  it("existe no banco assim que o repositório abre", () => {
    freshDatabase();
    getDatabase();
    const achada = listTechniqueCandidates().find((c) => c.id === T41_CANDIDATE_ID);
    expect(achada).toBeDefined();
    expect(achada!.status).toBe("VALIDATION");
    expect(achada!.baseVersion).toBe("T4.0.0");
  });

  it("as regras chegam completas ao rules_json", () => {
    freshDatabase();
    getDatabase();
    const achada = listTechniqueCandidates().find((c) => c.id === T41_CANDIDATE_ID)!;
    const regimes = achada.rules["regimes"] as Record<string, unknown>;
    expect(Object.keys(regimes)).toHaveLength(3);
    expect(JSON.stringify(achada.rules)).toContain("MME 9");
    expect(JSON.stringify(achada.rules)).toContain("16:30+");
  });

  it("reabrir o banco NÃO reescreve o congelamento", () => {
    freshDatabase();
    getDatabase();
    const antes = listTechniqueCandidates().find((c) => c.id === T41_CANDIDATE_ID)!;

    resetTradingRepositoryForTests();
    getDatabase();
    const depois = listTechniqueCandidates().find((c) => c.id === T41_CANDIDATE_ID)!;

    expect(depois.createdAt).toBe(antes.createdAt);
    expect(depois.updatedAt).toBe(antes.updatedAt);
    expect(JSON.stringify(depois.rules)).toBe(JSON.stringify(antes.rules));
  });
});
