import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  getDatabase,
  listMemoryCases,
  resetTradingRepositoryForTests,
  savePrintRecord,
  sweepPrintImages,
} from "../tradingRepository";

/**
 * RETENÇÃO DE IMAGEM COM ARQUIVO DE VERDADE. Nada de mock de fs: o que precisa
 * ser provado é que o .jpg some do disco e a ANÁLISE fica no banco.
 */

const DAY = 86_400_000;
const IMAGE_DATA_URL = `data:image/jpeg;base64,${Buffer.from("bitmap-de-teste").toString("base64")}`;

let workingDir: string | null = null;

function freshDatabase(): string {
  resetTradingRepositoryForTests();
  const dir = mkdtempSync(join(tmpdir(), "analisador-retencao-"));
  workingDir = dir;
  process.env.DATA_DIR = dir;
  delete process.env.DATABASE_PATH;
  delete process.env.PRINT_IMAGE_RETENTION_DAYS;
  return dir;
}

function printsDir(): string {
  return join(workingDir ?? "", "prints");
}

/**
 * Semeia com a retenção DESLIGADA de propósito: `savePrintRecord` dispara a
 * varredura estrangulada, e ela apagaria o arquivo antes do teste chegar a
 * afirmar qualquer coisa. Cada teste liga depois a janela que quer provar.
 */
function seedPrint(id: string, capturedAt: number, withImage = true): void {
  const previous = process.env.PRINT_IMAGE_RETENTION_DAYS;
  process.env.PRINT_IMAGE_RETENTION_DAYS = "0";
  savePrintRecord({
    id,
    sessionId: null,
    asset: "WINFUT",
    timeframe: "1m",
    capturedAt,
    status: "SETUP",
    direction: "COMPRA",
    confidence: 72,
    currentPrice: 138_000,
    dnaId: null,
    captureCode: null,
    analysis: { setup: "Spring+LiquiditySweep", note: id },
    imageDataUrl: withImage ? IMAGE_DATA_URL : null,
    prediction: { entry: 138_000, stop: 137_800, target: 138_600 },
  });
  if (previous === undefined) delete process.env.PRINT_IMAGE_RETENTION_DAYS;
  else process.env.PRINT_IMAGE_RETENTION_DAYS = previous;
}

function printRow(id: string): { image_path: string | null; analysis_json: string } {
  const row = getDatabase()
    .prepare("SELECT image_path, analysis_json FROM prints WHERE id=?")
    .get(id) as { image_path: string | null; analysis_json: string } | undefined;
  if (!row) throw new Error(`linha ${id} sumiu do banco — a análise nunca pode ser apagada`);
  return row;
}

afterEach(() => {
  resetTradingRepositoryForTests();
  if (workingDir) rmSync(workingDir, { recursive: true, force: true });
  workingDir = null;
  delete process.env.DATA_DIR;
  delete process.env.DATABASE_PATH;
  delete process.env.PRINT_IMAGE_RETENTION_DAYS;
});

describe.sequential("retenção das imagens de print", () => {
  it("apaga o bitmap antigo, declara image_path NULL e preserva a análise", () => {
    freshDatabase();
    const now = Date.now();
    seedPrint("print_velho", now - 10 * DAY);
    /*
     * A previsão deste print precisa estar JULGADA para a imagem poder expirar
     * — a guarda de prova (adicionada com os setups persistentes) preserva
     * imagem de caso EM ABERTO. Um print de 10 dias atrás com previsão ainda
     * PENDENTE não existe no fluxo real: a varredura de vereditos a teria
     * fechado como NEUTRO em 45 min. O caso protegido tem teste próprio em
     * setupRetentionAndMigration.test.ts.
     */
    getDatabase()
      .prepare("UPDATE print_predictions SET verdict='NEUTRO', resolved_at=? WHERE print_id=?")
      .run(now - 10 * DAY + 45 * 60_000, "print_velho");

    const before = printRow("print_velho");
    expect(before.image_path).not.toBeNull();
    expect(existsSync(String(before.image_path))).toBe(true);
    const filePath = String(before.image_path);
    const fileSize = readFileSync(filePath).length;

    const result = sweepPrintImages(now);

    expect(result.skipped).toBeNull();
    expect(result.removedFiles).toBe(1);
    expect(result.clearedRows).toBe(1);
    expect(result.freedBytes).toBe(fileSize);
    expect(existsSync(filePath)).toBe(false);

    const after = printRow("print_velho");
    // Ausência é NULL declarado — nunca string vazia nem caminho fantasma.
    expect(after.image_path).toBeNull();
    expect(JSON.parse(after.analysis_json)).toEqual({
      setup: "Spring+LiquiditySweep",
      note: "print_velho",
    });
  });

  it("não encosta no print dentro da janela", () => {
    freshDatabase();
    const now = Date.now();
    seedPrint("print_recente", now - 2 * DAY);
    const path = String(printRow("print_recente").image_path);

    const result = sweepPrintImages(now);

    expect(result.removedFiles).toBe(0);
    expect(result.clearedRows).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(printRow("print_recente").image_path).toBe(path);
  });

  it("PRINT_IMAGE_RETENTION_DAYS=0 desliga a limpeza; texto inválido também", () => {
    freshDatabase();
    const now = Date.now();
    seedPrint("print_antiquissimo", now - 400 * DAY);
    const path = String(printRow("print_antiquissimo").image_path);

    process.env.PRINT_IMAGE_RETENTION_DAYS = "0";
    const desligada = sweepPrintImages(now);
    expect(desligada.skipped).toBe("DESLIGADA");
    expect(desligada.cutoff).toBe(0);
    expect(desligada.removedFiles).toBe(0);
    expect(desligada.clearedRows).toBe(0);
    expect(desligada.freedBytes).toBe(0);

    // Configuração ilegível não pode apagar imagem: o lado seguro é manter.
    process.env.PRINT_IMAGE_RETENTION_DAYS = "sete";
    expect(sweepPrintImages(now).skipped).toBe("DESLIGADA");

    expect(existsSync(path)).toBe(true);
    expect(printRow("print_antiquissimo").image_path).toBe(path);
  });

  it("recolhe órfão antigo e poupa órfão recém-escrito", () => {
    freshDatabase();
    const now = Date.now();
    seedPrint("print_recente", now - 1 * DAY);

    const velho = join(printsDir(), "orfao_velho.jpg");
    const novo = join(printsDir(), "orfao_novo.jpg");
    writeFileSync(velho, Buffer.from("bitmap-orfao-velho"));
    writeFileSync(novo, Buffer.from("bitmap-orfao-novo"));
    const envelhecido = (now - 30 * DAY) / 1000;
    utimesSync(velho, envelhecido, envelhecido);

    const result = sweepPrintImages(now);

    expect(result.orphanFiles).toBe(1);
    expect(result.freedBytes).toBe(Buffer.from("bitmap-orfao-velho").length);
    expect(existsSync(velho)).toBe(false);
    // O órfão recente pode ser a imagem de um print cuja linha ainda não gravou.
    expect(existsSync(novo)).toBe(true);
    expect(existsSync(String(printRow("print_recente").image_path))).toBe(true);
  });

  it("previsões e linhas continuam consultáveis depois da varredura", () => {
    freshDatabase();
    const now = Date.now();
    seedPrint("print_velho", now - 10 * DAY);
    seedPrint("print_recente", now - 1 * DAY);

    sweepPrintImages(now);

    const database = getDatabase();
    const total = database.prepare("SELECT COUNT(*) AS n FROM prints").get() as { n: number };
    expect(Number(total.n)).toBe(2);
    const previsoes = database
      .prepare("SELECT print_id, stop, target, verdict FROM print_predictions ORDER BY print_id")
      .all() as Array<{ print_id: string; stop: number; target: number; verdict: string }>;
    expect(previsoes.map((row) => row.print_id)).toEqual(["print_recente", "print_velho"]);
    expect(previsoes[0]?.stop).toBe(137_800);
    expect(previsoes[0]?.target).toBe(138_600);
    // A memória de casos segue respondendo — imagem expirada não a mutila.
    expect(() => listMemoryCases("WINFUT")).not.toThrow();
  });

  it("savePrintRecord varre uma vez e estrangula a seguinte na mesma hora", () => {
    freshDatabase();
    const now = Date.now();
    process.env.PRINT_IMAGE_RETENTION_DAYS = "7";

    // Primeira gravação do processo: a varredura roda e limpa o próprio print
    // antigo que acabou de entrar.
    savePrintRecordAged("print_a", now - 10 * DAY);
    expect(printRow("print_a").image_path).toBeNull();

    // Segunda gravação no mesmo minuto: estrangulada, nada é varrido.
    savePrintRecordAged("print_b", now - 10 * DAY);
    const b = printRow("print_b");
    expect(b.image_path).not.toBeNull();
    expect(existsSync(String(b.image_path))).toBe(true);
  });
});

/** Gravação normal (sem desligar a retenção) para provar o gatilho embutido. */
function savePrintRecordAged(id: string, capturedAt: number): void {
  savePrintRecord({
    id,
    sessionId: null,
    asset: "WINFUT",
    timeframe: "1m",
    capturedAt,
    status: "SETUP",
    direction: "COMPRA",
    confidence: 60,
    currentPrice: 138_000,
    dnaId: null,
    captureCode: null,
    analysis: { note: id },
    imageDataUrl: IMAGE_DATA_URL,
    prediction: null,
  });
}

/**
 * O REPARO DECLARADO PRECISA SOBREVIVER À ABA.
 *
 * A casa exige que todo reparo da validação seja dito, nunca silencioso. Ele
 * era dito no navegador e morria com a sessão — e em 20/08/2026 isso custou
 * uma investigação: com `lastClosedCandle` ausente em 25 de 25 análises reais,
 * não deu para separar "o modelo devolveu null" de "o reparo anulou porque o
 * modelo mandou o candle ATUAL disfarçado". As duas hipóteses pedem correções
 * opostas, e o dado que as separava tinha sido descartado.
 */
describe.sequential("reparos persistidos", () => {
  function reparosDe(id: string): string | null {
    const row = getDatabase().prepare("SELECT repairs_json FROM prints WHERE id=?").get(id) as
      { repairs_json: string | null } | undefined;
    if (!row) throw new Error(`linha ${id} sumiu do banco`);
    return row.repairs_json;
  }

  function salvarCom(id: string, repairs: string[] | null | undefined): void {
    process.env.PRINT_IMAGE_RETENTION_DAYS = "0";
    savePrintRecord({
      id,
      sessionId: null,
      asset: "WINFUT",
      timeframe: "1m",
      capturedAt: Date.now(),
      status: "SETUP",
      direction: "COMPRA",
      confidence: 72,
      currentPrice: 138_000,
      dnaId: null,
      captureCode: null,
      analysis: { note: id },
      imageDataUrl: null,
      prediction: null,
      ...(repairs === undefined ? {} : { repairs }),
    });
  }

  it("a lista de reparos volta inteira do banco", () => {
    freshDatabase();
    const reparos = [
      "Candle fechado descartado: horário 15:34 é o mesmo do relógio do gráfico — é o candle EM FORMAÇÃO, não o anterior.",
      "Gatilho: 170.68 lido como 170680 — o eixo do WINFUT usa ponto de milhar.",
    ];
    salvarCom("prt_com_reparo", reparos);
    expect(JSON.parse(reparosDe("prt_com_reparo")!)).toEqual(reparos);
  });

  it("lista VAZIA é gravada como [] — afirma que a validação rodou e nada achou", () => {
    /*
     * `[]` e NULL dizem coisas diferentes, e é essa diferença que resolve a
     * dúvida do dia 20/08: `[]` prova que nenhum reparo tocou o campo, então a
     * ausência veio do modelo. NULL só diz que ninguém contou.
     */
    freshDatabase();
    salvarCom("prt_sem_reparo", []);
    expect(reparosDe("prt_sem_reparo")).toBe("[]");
  });

  it("ausente vira NULL — e print antigo, sem a coluna, continua legível", () => {
    freshDatabase();
    salvarCom("prt_nao_informado", undefined);
    expect(reparosDe("prt_nao_informado")).toBeNull();
    // E a análise, que é o que nunca pode se perder, continua lá.
    expect(JSON.parse(printRow("prt_nao_informado").analysis_json).note).toBe("prt_nao_informado");
  });
});
