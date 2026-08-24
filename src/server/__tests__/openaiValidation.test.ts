import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LUNA_JSON_SCHEMA } from "@/lib/t4/aiSchemas";
import { callOpenAi } from "../openai/openaiClient";
import { validatePrintWithOpenAI, type DeterministicSnapshot } from "../openai/printValidation";
import { runSolTechniqueAudit } from "../openai/solAudit";
import {
  getDatabase,
  listAiValidations,
  resetTradingRepositoryForTests,
  saveAiValidation,
} from "../tradingRepository";

/**
 * INTEGRAÇÃO OPENAI COM O FETCH MOCKADO — o contrato inteiro sem rede.
 * O que se prova: chave só no servidor, Structured Outputs na requisição,
 * JSON inválido bloqueia, Terra REJECT bloqueia, indisponibilidade não trava,
 * persistência idempotente que nunca sobrescreve.
 */

let workingDir: string | null = null;

function freshDatabase(): void {
  resetTradingRepositoryForTests();
  const dir = mkdtempSync(join(tmpdir(), "analisador-openai-"));
  workingDir = dir;
  process.env.DATA_DIR = dir;
  delete process.env.DATABASE_PATH;
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = "sk-teste-nunca-logar";
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  resetTradingRepositoryForTests();
  if (workingDir) rmSync(workingDir, { recursive: true, force: true });
  workingDir = null;
  delete process.env.DATA_DIR;
});

function respostaOk(payload: unknown): Response {
  return new Response(
    JSON.stringify({
      output_text: JSON.stringify(payload),
      usage: { input_tokens: 100, output_tokens: 50 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

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

const DET_PASS: DeterministicSnapshot = {
  pass: true,
  e2Closed: true,
  rr: 3.2,
  rrOk: true,
  entry: 100_000,
  stop: 99_900,
  levelsValid: true,
  stage: "ARMED",
  blockCode: null,
  blockReason: null,
};

describe("openaiClient", () => {
  it("a requisição leva Structured Outputs (json_schema strict) e a chave no header — nunca na URL", async () => {
    let urlVista = "";
    let bodyVisto: Record<string, unknown> = {};
    let authVista = "";
    const r = await callOpenAi({
      role: "PRINT",
      prompt: "leia",
      imageDataUrl: "data:image/png;base64,AAA",
      jsonSchema: LUNA_JSON_SCHEMA,
      fetchImpl: async (url, init) => {
        urlVista = String(url);
        authVista = String((init?.headers as Record<string, string>).authorization);
        bodyVisto = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return respostaOk(lunaPayload);
      },
    });
    expect(r.ok).toBe(true);
    expect(urlVista).toContain("/responses");
    expect(urlVista).not.toContain("sk-teste");
    expect(authVista).toBe("Bearer sk-teste-nunca-logar");
    const text = bodyVisto["text"] as { format: { type: string; strict: boolean } };
    expect(text.format.type).toBe("json_schema");
    expect(text.format.strict).toBe(true);
    expect(bodyVisto["model"]).toBe("gpt-5.6-luna");
  });

  it("timeout aborta e o erro NUNCA contém a chave", async () => {
    const r = await callOpenAi({
      role: "PRINT",
      prompt: "leia",
      jsonSchema: LUNA_JSON_SCHEMA,
      timeoutMs: 20,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted sk-?")));
        }),
    });
    expect(r.ok).toBe(false);
    expect(String(r.error)).not.toContain("sk-teste");
  });

  it("4xx não repete a chamada — pedido errado não melhora repetindo", async () => {
    let chamadas = 0;
    const r = await callOpenAi({
      role: "VALIDATOR",
      prompt: "x",
      jsonSchema: LUNA_JSON_SCHEMA,
      fetchImpl: async () => {
        chamadas += 1;
        return new Response("{}", { status: 400 });
      },
    });
    expect(r.ok).toBe(false);
    expect(chamadas).toBe(1);
  });
});

describe("validatePrintWithOpenAI", () => {
  it("fluxo completo verde: Luna PASS + Terra APPROVE + T4 PASS ⇒ CONFIRMADO e persistido", async () => {
    freshDatabase();
    getDatabase();
    let chamadas = 0;
    const out = await validatePrintWithOpenAI({
      imageDataUrl: "data:image/png;base64,AAA",
      imageHash: "hash1",
      captureId: "cap_1",
      candleTime: 1_700_000_060_000,
      deterministic: DET_PASS,
      fetchImpl: async () => {
        chamadas += 1;
        return respostaOk(chamadas === 1 ? lunaPayload : terraAprova);
      },
    });
    expect(chamadas).toBe(2); // Luna + Terra (estágio ARMED)
    expect(out.final.confirmado).toBe(true);
    expect(out.ui.veredito).toContain("CONFIRMADO");
    const salvas = listAiValidations();
    expect(salvas).toHaveLength(1);
    expect(salvas[0]!.status).toBe("CONFIRMADO");
    expect(salvas[0]!.tokens).toBe(300);
  });

  it("Luna PASS SOZINHA não libera: sem T4 PASS o veredito é AGUARDAR", async () => {
    freshDatabase();
    getDatabase();
    const out = await validatePrintWithOpenAI({
      imageDataUrl: "data:x",
      imageHash: "hash2",
      captureId: "cap_2",
      candleTime: 2,
      deterministic: { ...DET_PASS, pass: false, blockCode: "RR_LT_3", blockReason: "2.99" },
      fetchImpl: async () => respostaOk(lunaPayload),
    });
    expect(out.final.confirmado).toBe(false);
    expect(out.ui.t4).toContain("BLOCKED");
  });

  it("JSON fora do schema vira INDISPONÍVEL e bloqueia a confirmação", async () => {
    freshDatabase();
    getDatabase();
    const out = await validatePrintWithOpenAI({
      imageDataUrl: "data:x",
      imageHash: "hash3",
      captureId: "cap_3",
      candleTime: 3,
      deterministic: DET_PASS,
      fetchImpl: async () => respostaOk({ verdict: "PASS" }),
    });
    expect(out.luna.status).toBe("INDISPONIVEL");
    expect(out.final.confirmado).toBe(false);
    expect(listAiValidations()[0]!.status).toBe("AI_INDISPONIVEL");
  });

  it("Terra REJECT bloqueia a confirmação que a Luna aprovaria", async () => {
    freshDatabase();
    getDatabase();
    let chamadas = 0;
    const out = await validatePrintWithOpenAI({
      imageDataUrl: "data:x",
      imageHash: "hash4",
      captureId: "cap_4",
      candleTime: 4,
      deterministic: DET_PASS,
      fetchImpl: async () => {
        chamadas += 1;
        return respostaOk(
          chamadas === 1
            ? lunaPayload
            : {
                ...terraAprova,
                approved: false,
                verdict: "REJECT",
                criticalIssue: "nível não bate",
              },
        );
      },
    });
    expect(out.final.confirmado).toBe(false);
    expect(out.final.motivo).toContain("nível não bate");
  });

  it("OpenAI fora do ar: resultado INDISPONÍVEL, nada lança, captura pode seguir", async () => {
    freshDatabase();
    getDatabase();
    const out = await validatePrintWithOpenAI({
      imageDataUrl: "data:x",
      imageHash: "hash5",
      captureId: "cap_5",
      candleTime: 5,
      deterministic: DET_PASS,
      fetchImpl: async () => new Response("erro", { status: 503 }),
    });
    expect(out.luna.status).toBe("INDISPONIVEL");
    expect(out.final.confirmado).toBe(false);
  });

  it("fora de PRE_ALERTA/ARMADO, Terra NÃO é chamada — custo controlado", async () => {
    freshDatabase();
    getDatabase();
    let chamadas = 0;
    const out = await validatePrintWithOpenAI({
      imageDataUrl: "data:x",
      imageHash: "hash6",
      captureId: "cap_6",
      candleTime: 6,
      deterministic: { ...DET_PASS, stage: "FORMING" },
      fetchImpl: async () => {
        chamadas += 1;
        return respostaOk(lunaPayload);
      },
    });
    expect(chamadas).toBe(1);
    expect(out.terra.status).toBe("NAO_CHAMADO");
    expect(out.final.confirmado).toBe(false); // sem Terra não há CONFIRMADO
  });
});

describe("persistência ai_validations", () => {
  it("é idempotente por (imageHash, candleTime) e NUNCA sobrescreve", () => {
    freshDatabase();
    getDatabase();
    const base = {
      imageHash: "h",
      captureId: "c1",
      candleTime: 42,
      t4DecisionJson: "{}",
      lunaJson: '{"verdict":"PASS"}',
      terraJson: null,
      latencyMs: 10,
      tokens: 1,
      costUsd: null,
      status: "AGUARDAR",
    };
    expect(saveAiValidation(base)).toBe(true);
    // Segunda gravação do MESMO print com conteúdo diferente: ignorada.
    expect(saveAiValidation({ ...base, status: "CONFIRMADO", lunaJson: "{}" })).toBe(false);
    const linhas = listAiValidations();
    expect(linhas).toHaveLength(1);
    expect(linhas[0]!.status).toBe("AGUARDAR");
  });
});

describe("Sol — auditoria offline", () => {
  it("sem evidência obrigatória, productionEligible é DERRUBADO localmente mesmo se o modelo disser true", async () => {
    const r = await runSolTechniqueAudit({
      evidencePayload: { ledger: "vazio" },
      fetchImpl: async () =>
        respostaOk({
          techniqueVersion: "x",
          codeHash: "y",
          critical: [],
          high: [],
          medium: [],
          evidence: [],
          metricsVerified: true,
          oosVerified: false, // sem OOS…
          walkForwardVerified: true,
          productionEligible: true, // …e o modelo mente que é elegível
        }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.audit.productionEligible).toBe(false);
  });

  it("Sol não escreve regra: o retorno não contém rules e a técnica não muda", async () => {
    const antes = readFileSync("src/lib/engines/strategy.ts", "utf8");
    await runSolTechniqueAudit({
      evidencePayload: {},
      fetchImpl: async () =>
        respostaOk({
          techniqueVersion: "x",
          codeHash: "y",
          critical: ["problema"],
          high: [],
          medium: [],
          evidence: ["e"],
          metricsVerified: false,
          oosVerified: false,
          walkForwardVerified: false,
          productionEligible: false,
        }),
    });
    expect(readFileSync("src/lib/engines/strategy.ts", "utf8")).toBe(antes);
  });
});

describe("a chave nunca chega ao frontend", () => {
  it("NENHUM arquivo de src/lib, src/components e src/services referencia a chave — exceto o router guardado", () => {
    /*
     * ALARGADO PELA AUDITORIA (B6): a lista fixa de 3 arquivos era um guard
     * que só pegava reincidência nos MESMOS lugares — services/ai/router.ts
     * lia OPENAI_API_KEY fora de src/server e a lista não olhava para lá.
     * Agora a varredura é RECURSIVA nas três árvores de código de cliente.
     *
     * A única exceção declarada é o próprio router: ele é somente-servidor
     * por contrato e agora por GUARDA (`typeof window` lança) — e a exceção
     * só vale enquanto a guarda existir, o que este teste também verifica.
     */
    const EXCECAO_GUARDADA = "src/services/ai/router.ts";
    const arvores = ["src/lib", "src/components", "src/services"];
    const violacoes: string[] = [];
    const varrer = (dir: string): void => {
      for (const nome of readdirSync(dir)) {
        const caminho = `${dir}/${nome}`;
        if (statSync(caminho).isDirectory()) {
          varrer(caminho);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(nome) || /\.test\.tsx?$/.test(nome)) continue;
        const s = readFileSync(caminho, "utf8");
        if (caminho === EXCECAO_GUARDADA) continue;
        if (s.includes("OPENAI_API_KEY") || s.includes("VITE_OPENAI")) violacoes.push(caminho);
      }
    };
    for (const arvore of arvores) varrer(arvore);
    expect(violacoes).toEqual([]);

    // A exceção só existe COM a guarda de navegador dentro dela.
    const router = readFileSync(EXCECAO_GUARDADA, "utf8");
    expect(router).toContain('typeof window !== "undefined"');

    const cliente = readFileSync("src/server/openai/openaiClient.ts", "utf8");
    expect(cliente).toContain('typeof window !== "undefined"');
  });
});
