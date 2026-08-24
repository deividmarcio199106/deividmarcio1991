import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { finalConfirmation } from "@/lib/t4/aiValidation";
import { resetTradingRepositoryForTests } from "../tradingRepository";
import { validatePrintWithOpenAI, type DeterministicSnapshot } from "../openai/printValidation";

/**
 * OPENAI NO RUNTIME — AS COSTURAS DO BLOCO 6 (auditoria sênior).
 *
 * Luna/Terra/Sol existiam prontos e NENHUM caminho do navegador os alcançava.
 * O que se tranca aqui não é o validador (openaiValidation.test.ts já o
 * cobre): são os CONTRATOS da costura —
 *
 *   1. falha de BANCO ao persistir a trilha não derruba a validação: o
 *      veredito volta ao chamador e a captura nunca para;
 *   2. IA indisponível NUNCA promove — `finalConfirmation` nega com código,
 *      mesmo com todas as pernas determinísticas verdes (é a semântica que a
 *      server function degradada reusa, nunca reescreve);
 *   3. a cadeia navegador→servidor existe DE VERDADE no fonte: o hook chama a
 *      server function no instante congelado, as rotas consomem as linhas e o
 *      selo de promoção exige `confirmado === true`; e nenhum módulo de
 *      navegador fala com a OpenAI diretamente.
 */

let workingDir: string | null = null;

beforeEach(() => {
  process.env.OPENAI_API_KEY = "sk-teste-nunca-logar";
});

afterEach(() => {
  resetTradingRepositoryForTests();
  if (workingDir) rmSync(workingDir, { recursive: true, force: true });
  workingDir = null;
  delete process.env.DATA_DIR;
  delete process.env.OPENAI_API_KEY;
});

const DET_PASS: DeterministicSnapshot = {
  pass: true,
  e2Closed: true,
  rr: 3.2,
  rrOk: true,
  entry: 100_000,
  stop: 99_900,
  levelsValid: true,
  stage: "CONFIRMED",
  blockCode: null,
  blockReason: null,
};

const lunaPayload = {
  captureId: "cap_1",
  candleTime: 1_700_000_000_000,
  direction: "COMPRA",
  regime: "TENDENCIA_ALTA",
  t4Present: true,
  entryVisible: true,
  entry: 100_000,
  stopVisible: true,
  stop: 99_900,
  targetVisible: true,
  target3R: 100_300,
  target5R: 100_500,
  confirmationCandleClosed: true,
  pullbackCandles: 3,
  pivotPreserved: true,
  structureAligned: true,
  obstacleBefore5R: false,
  confidences: { visual: 90, structure: 85, t4: 80, entry: 75 },
  contradictions: [],
  evidence: ["ok"],
  verdict: "PASS",
};

const terraAprova = {
  approved: true,
  contradictions: [],
  criticalIssue: null,
  evidence: ["sem furo"],
  verdict: "APPROVE",
};

function respostaOk(payload: unknown): Response {
  return new Response(
    JSON.stringify({
      output_text: JSON.stringify(payload),
      usage: { input_tokens: 100, output_tokens: 50 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("falha de persistência não derruba a validação", () => {
  it("banco inacessível ⇒ veredito volta ao chamador, sem exceção", async () => {
    /*
     * DATA_DIR apontando para um ARQUIVO: `db()` tenta criar o diretório e
     * lança. Antes do try/catch (printValidation.ts), essa exceção subia e
     * apagava a resposta da IA que já existia — a captura parava porque um
     * INSERT falhou. Agora o veredito chega; o registro perdido vira log.
     */
    resetTradingRepositoryForTests();
    const dir = mkdtempSync(join(tmpdir(), "analisador-ai-"));
    workingDir = dir;
    const arquivo = join(dir, "nao-sou-diretorio");
    writeFileSync(arquivo, "x");
    process.env.DATA_DIR = arquivo;

    let chamadas = 0;
    const out = await validatePrintWithOpenAI({
      imageDataUrl: "data:image/png;base64,QUJD",
      imageHash: "hash_persist_1",
      captureId: "cap_1",
      candleTime: 1_700_000_000_000,
      deterministic: DET_PASS,
      fetchImpl: async () => {
        chamadas += 1;
        return respostaOk(chamadas === 1 ? lunaPayload : terraAprova);
      },
    });
    expect(out.final.confirmado).toBe(true);
    expect(out.ui.veredito.length).toBeGreaterThan(0);
  });
});

describe("IA indisponível nunca promove — a semântica que a server function reusa", () => {
  it("Luna INDISPONÍVEL com todas as pernas determinísticas verdes ⇒ negado com código", () => {
    const final = finalConfirmation({
      t4DeterministicPass: true,
      e2Closed: true,
      rrOk: true,
      levelsValid: true,
      luna: { status: "INDISPONIVEL", reason: "timeout" },
      terra: { status: "NAO_CHAMADO" },
    });
    expect(final.confirmado).toBe(false);
    expect(final.blockCode).not.toBeNull();
  });
});

describe("a cadeia navegador→servidor existe no fonte", () => {
  it("o hook de visão chama a server function no instante congelado", () => {
    const hook = readFileSync("src/hooks/useProfitVision.ts", "utf8");
    expect(hook).toContain('from "@/lib/aiPrintValidation.functions"');
    expect(hook).toContain("validateCapture({");
    // O snapshot determinístico viaja com o print — não é recalculado depois.
    expect(hook).toContain("deterministic: {");
  });

  it("a promoção assistida exige confirmado === true nas rotas", () => {
    const aoVivo = readFileSync("src/routes/operacao-ao-vivo.tsx", "utf8");
    expect(aoVivo).toContain("vision.aiValidation?.confirmado === true");
    expect(aoVivo).toContain("aiValidationRows={vision.aiValidation?.rows ?? null}");
    const backtest = readFileSync("src/routes/backtest.tsx", "utf8");
    expect(backtest).toContain("aiValidationRows={aiRows}");
  });

  it("nenhum módulo de NAVEGADOR fala com a OpenAI diretamente", () => {
    // setupTracker e marketMonitor rodam no cliente: a IA só existe para eles
    // através da server function — nunca por chamada direta.
    for (const arquivo of ["src/lib/print/setupTracker.ts", "src/lib/capture/marketMonitor.ts"]) {
      const fonte = readFileSync(arquivo, "utf8");
      expect(fonte.toLowerCase()).not.toContain("openai");
    }
  });

  it("Sol existe como superfície OFFLINE por demanda — nunca no laço de análise", () => {
    const fns = readFileSync("src/lib/aiPrintValidation.functions.ts", "utf8");
    expect(fns).toContain("runSolTechniqueAudit");
    // Nenhum caminho de frame/monitor importa a auditoria Sol.
    for (const arquivo of [
      "src/hooks/useProfitVision.ts",
      "src/hooks/useContinuousBacktest.ts",
      "src/lib/capture/marketMonitor.ts",
    ]) {
      expect(readFileSync(arquivo, "utf8")).not.toContain("solAudit");
    }
  });
});
