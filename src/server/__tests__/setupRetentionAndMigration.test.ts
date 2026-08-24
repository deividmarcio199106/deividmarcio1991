import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  getDatabase,
  listSetups,
  resetTradingRepositoryForTests,
  savePrintRecord,
  sweepPrintImages,
  upsertSetup,
  type SetupRecordInput,
} from "../tradingRepository";

/**
 * DUAS GARANTIAS QUE SÓ UM BANCO REAL PROVA:
 *  1. a retenção NUNCA apaga a imagem que ainda é prova de um caso em aberto;
 *  2. um banco ANTIGO (sem a tabela `setups`, sem `prints.passes_json`)
 *     sobrevive ao upgrade — e rodar a migração duas vezes não quebra nada.
 */

const DAY = 86_400_000;
const IMAGE_DATA_URL = `data:image/jpeg;base64,${Buffer.from("bitmap-de-teste").toString("base64")}`;

let workingDir: string | null = null;

function freshDir(): string {
  resetTradingRepositoryForTests();
  const dir = mkdtempSync(join(tmpdir(), "analisador-setup-mig-"));
  workingDir = dir;
  process.env.DATA_DIR = dir;
  delete process.env.DATABASE_PATH;
  delete process.env.PRINT_IMAGE_RETENTION_DAYS;
  return dir;
}

afterEach(() => {
  resetTradingRepositoryForTests();
  if (workingDir) rmSync(workingDir, { recursive: true, force: true });
  workingDir = null;
  delete process.env.DATA_DIR;
  delete process.env.DATABASE_PATH;
  delete process.env.PRINT_IMAGE_RETENTION_DAYS;
});

function seedPrint(id: string, capturedAt: number, prediction = false): void {
  const previous = process.env.PRINT_IMAGE_RETENTION_DAYS;
  // Semeado com a limpeza DESLIGADA: savePrintRecord dispara a varredura e ela
  // apagaria o arquivo antes de o teste afirmar qualquer coisa.
  process.env.PRINT_IMAGE_RETENTION_DAYS = "0";
  savePrintRecord({
    id,
    sessionId: null,
    asset: "WINFUT",
    timeframe: "1m",
    capturedAt,
    status: "SETUP",
    direction: "COMPRA",
    confidence: 70,
    currentPrice: 138_000,
    dnaId: null,
    captureCode: "CICLO_60S",
    analysis: { note: id },
    imageDataUrl: IMAGE_DATA_URL,
    prediction: prediction ? { entry: 138_000, stop: 137_800, target: 138_600 } : null,
  });
  if (previous === undefined) delete process.env.PRINT_IMAGE_RETENTION_DAYS;
  else process.env.PRINT_IMAGE_RETENTION_DAYS = previous;
}

function imagePath(id: string): string | null {
  const row = getDatabase().prepare("SELECT image_path FROM prints WHERE id=?").get(id) as
    { image_path: string | null } | undefined;
  return row?.image_path ?? null;
}

function setup(over: Partial<SetupRecordInput> = {}): SetupRecordInput {
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
    confirmedAt: Date.now(),
    createdAt: Date.now(),
    expiresAt: Date.now() + 45 * 60_000,
    dnaId: null,
    printId: null,
    // Setup gravado sem rompimento observado — o estado conservador, que é o
    // que um cliente antigo (ou um setup ainda em formação) manda.
    triggerLevel: 138_000,
    triggerVersion: 1,
    triggerHistory: [],
    breakout: null,
    operationReleased: false,
    ...over,
  };
}

describe.sequential("retenção: a prova do caso em aberto não é apagada", () => {
  it("preserva a imagem do print vinculado a setup ABERTO e conta keptAsEvidence", () => {
    freshDir();
    const now = Date.now();
    seedPrint("print_do_setup", now - 30 * DAY);
    seedPrint("print_solto", now - 30 * DAY);
    upsertSetup(setup({ printId: "print_do_setup" }), now);

    const caminhoProtegido = String(imagePath("print_do_setup"));
    const caminhoLivre = String(imagePath("print_solto"));

    const resultado = sweepPrintImages(now);

    expect(resultado.keptAsEvidence).toBe(1);
    expect(resultado.removedFiles).toBe(1);
    expect(resultado.clearedRows).toBe(1);
    // A prova continua no disco E no banco.
    expect(existsSync(caminhoProtegido)).toBe(true);
    expect(imagePath("print_do_setup")).toBe(caminhoProtegido);
    // O print sem caso em aberto expira normalmente.
    expect(existsSync(caminhoLivre)).toBe(false);
    expect(imagePath("print_solto")).toBeNull();
  });

  it("preserva a imagem de previsão PENDENTE e libera depois do veredito", () => {
    freshDir();
    const now = Date.now();
    seedPrint("print_pendente", now - 30 * DAY, true);
    const caminho = String(imagePath("print_pendente"));

    expect(sweepPrintImages(now).keptAsEvidence).toBe(1);
    expect(existsSync(caminho)).toBe(true);

    // Fechado o veredito, a imagem deixa de ser prova de caso em aberto.
    getDatabase()
      .prepare("UPDATE print_predictions SET verdict='ACERTOU' WHERE print_id=?")
      .run("print_pendente");
    const depois = sweepPrintImages(now);
    expect(depois.keptAsEvidence).toBe(0);
    expect(depois.removedFiles).toBe(1);
    expect(existsSync(caminho)).toBe(false);
  });

  it("setup fechado deixa de proteger a imagem", () => {
    freshDir();
    const now = Date.now();
    seedPrint("print_do_setup", now - 30 * DAY);
    upsertSetup(setup({ printId: "print_do_setup" }), now);
    const caminho = String(imagePath("print_do_setup"));
    expect(sweepPrintImages(now).keptAsEvidence).toBe(1);

    getDatabase()
      .prepare("UPDATE setups SET outcome='LOSS', outcome_at=? WHERE setup_id=?")
      .run(now, "T4-2026-08-19-001");

    const depois = sweepPrintImages(now);
    expect(depois.keptAsEvidence).toBe(0);
    expect(depois.removedFiles).toBe(1);
    expect(existsSync(caminho)).toBe(false);
    expect(imagePath("print_do_setup")).toBeNull();
  });
});

describe.sequential("migração: banco antigo sobrevive ao upgrade", () => {
  /**
   * Banco no formato ANTERIOR a esta mudança: `prints` SEM `passes_json` e
   * tabela `setups` inexistente, com dado dentro. É o estado real da VPS no
   * momento do deploy — e o cenário em que um CREATE INDEX no lugar errado já
   * derrubou todos os endpoints /api/trading/* uma vez.
   */
  function seedLegacyDatabase(dir: string): string {
    const path = join(dir, "analisador.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE prints (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        asset TEXT NOT NULL,
        timeframe TEXT,
        captured_at INTEGER NOT NULL,
        image_path TEXT,
        status TEXT NOT NULL,
        direction TEXT NOT NULL,
        confidence INTEGER NOT NULL,
        current_price REAL,
        dna_id TEXT,
        capture_code TEXT,
        analysis_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO prints(id, asset, captured_at, status, direction, confidence, analysis_json, created_at)
      VALUES ('print_legado', 'WINFUT', 1, 'SETUP', 'COMPRA', 55, '{"origem":"banco antigo"}', 1);
    `);
    legacy.close();
    return path;
  }

  it("adiciona passes_json e a tabela setups sem perder linha antiga", () => {
    const dir = freshDir();
    seedLegacyDatabase(dir);

    // Abrir o repositório aplica migrate() sobre o banco antigo.
    const database = getDatabase();

    const antiga = database
      .prepare("SELECT analysis_json, passes_json FROM prints WHERE id='print_legado'")
      .get() as { analysis_json: string; passes_json: string | null };
    expect(JSON.parse(antiga.analysis_json)).toEqual({ origem: "banco antigo" });
    // Coluna nova nasce NULL: ninguém mediu os passes daquele print.
    expect(antiga.passes_json).toBeNull();

    const tabela = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='setups'")
      .get() as { name: string } | undefined;
    expect(tabela?.name).toBe("setups");

    const indices = (
      database
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='setups'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(indices).toContain("idx_setups_asset_outcome");
    expect(indices).toContain("idx_setups_learn");

    // E o banco migrado funciona de verdade.
    upsertSetup(setup(), Date.now());
    expect(listSetups("WINFUT")).toHaveLength(1);
  });

  it("rodar a migração duas vezes não quebra nem perde dado", () => {
    const dir = freshDir();
    seedLegacyDatabase(dir);

    getDatabase();
    upsertSetup(setup(), Date.now());

    // Segunda abertura = segunda passada da migração no MESMO arquivo.
    resetTradingRepositoryForTests();
    expect(() => getDatabase()).not.toThrow();

    expect(listSetups("WINFUT")).toHaveLength(1);
    const total = getDatabase().prepare("SELECT COUNT(*) AS n FROM prints").get() as { n: number };
    expect(Number(total.n)).toBe(1);
  });

  it("o CHECK do banco recusa outcome fora do vocabulário", () => {
    freshDir();
    upsertSetup(setup(), Date.now());
    expect(() =>
      getDatabase()
        .prepare("UPDATE setups SET outcome='QUASE_WIN' WHERE setup_id=?")
        .run("T4-2026-08-19-001"),
    ).toThrow();
  });
});

/**
 * O CENÁRIO REAL DO PRÓXIMO DEPLOY: a VPS já tem a tabela `setups`, com dados,
 * no formato ANTERIOR às colunas do rompimento (§32/§34).
 *
 * O teste acima cobre "a tabela ainda não existe". Este cobre "a tabela existe
 * e precisa ganhar cinco colunas" — que é onde um ALTER TABLE mal escrito, ou
 * um NOT NULL sem DEFAULT, derruba o banco do operador no meio do pregão.
 */
describe.sequential("migração: setups antiga ganha as colunas do rompimento", () => {
  /** `setups` no formato anterior, com uma oportunidade viva dentro. */
  function seedSetupsAntigo(dir: string): void {
    const legacy = new DatabaseSync(join(dir, "analisador.sqlite"));
    legacy.exec(`
      CREATE TABLE setups (
        setup_id TEXT PRIMARY KEY,
        asset TEXT NOT NULL,
        timeframe TEXT,
        direction TEXT NOT NULL,
        stage TEXT NOT NULL,
        entry REAL,
        stop REAL,
        target REAL,
        entry_zone_min REAL,
        entry_zone_max REAL,
        confirmed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER,
        outcome TEXT NOT NULL DEFAULT 'ABERTO'
          CHECK(outcome IN ('ABERTO','WIN','LOSS','EXPIRADO','INVALIDADO')),
        outcome_at INTEGER,
        outcome_reason TEXT,
        ambiguous INTEGER NOT NULL DEFAULT 0,
        dna_id TEXT,
        print_id TEXT,
        learned INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO setups(setup_id, asset, timeframe, direction, stage, entry, stop, target,
                         confirmed_at, created_at, updated_at)
      VALUES ('T4-VPS-042', 'WINFUT', '1m', 'COMPRA', 'CONFIRMADO', 138000, 137800, 138600,
              1000, 900, 1000);
    `);
    legacy.close();
  }

  it("o setup do operador sobrevive e ganha as colunas com defaults conservadores", () => {
    const dir = freshDir();
    seedSetupsAntigo(dir);

    // Abrir o repositório aplica migrate() sobre a tabela antiga.
    const vivos = listSetups("WINFUT");
    expect(vivos).toHaveLength(1);

    const antigo = vivos[0]!;
    // O DADO ANTIGO NÃO SE PERDE — é o que mais importa aqui.
    expect(antigo.setupId).toBe("T4-VPS-042");
    expect(antigo.entry).toBe(138_000);
    expect(antigo.confirmedAt).toBe(1000);
    expect(antigo.outcome).toBe("ABERTO");

    /*
     * E as colunas novas nascem CONSERVADORAS. Um default otimista aqui faria
     * um setup gravado ontem parecer "já sustentado" hoje — permissão de
     * operar nascida de uma migração, que é o pior lugar possível para ela
     * nascer.
     */
    expect(antigo.breakout).toBeNull();
    expect(antigo.triggerLevel).toBeNull();
    expect(antigo.triggerVersion).toBe(1);
    expect(antigo.triggerHistory).toEqual([]);
    expect(antigo.operationReleased).toBe(false);
  });

  it("depois de migrado, gravar e reler o estado do rompimento funciona", () => {
    const dir = freshDir();
    seedSetupsAntigo(dir);

    upsertSetup(
      setup({
        setupId: "T4-VPS-042",
        stage: "BREAKOUT_CLOSED",
        confirmedAt: null,
        triggerLevel: 170_925,
        triggerVersion: 3,
        triggerHistory: [{ version: 3, level: 170_925, at: 2000, reason: "relido" }],
        breakout: {
          side: "COMPRA",
          trigger: 170_925,
          tolerance: 5,
          triggerTouched: true,
          breakoutClosed: true,
          breakoutSustained: false,
          retestConfirmed: false,
          setupConfirmed: false,
          phase: "BREAKOUT_CLOSED",
          breakoutCandleTime: 2000,
          lastCandleTime: 2000,
          retestTouched: false,
          failureReason: null,
          history: [],
        } as SetupRecordInput["breakout"],
      }),
      3000,
    );

    const salvo = listSetups("WINFUT")[0]!;
    expect(salvo.stage).toBe("BREAKOUT_CLOSED");
    expect(salvo.triggerVersion).toBe(3);
    expect(salvo.breakout!.breakoutClosed).toBe(true);
    expect(salvo.triggerHistory[0]!.reason).toBe("relido");
  });

  it("migrar duas vezes não duplica coluna nem perde dado", () => {
    const dir = freshDir();
    seedSetupsAntigo(dir);
    expect(listSetups("WINFUT")).toHaveLength(1);

    resetTradingRepositoryForTests();
    process.env.DATA_DIR = dir;
    const novamente = listSetups("WINFUT");
    expect(novamente).toHaveLength(1);
    expect(novamente[0]!.entry).toBe(138_000);
    expect(novamente[0]!.triggerVersion).toBe(1);
  });
});
