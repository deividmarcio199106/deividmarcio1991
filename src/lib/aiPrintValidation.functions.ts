import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { aiStatusRows, finalConfirmation } from "@/lib/t4/aiValidation";
import {
  validatePrintWithOpenAI,
  type PrintValidationOutput,
} from "@/server/openai/printValidation";
import { runSolTechniqueAudit, type SolAuditResult } from "@/server/openai/solAudit";
import { listAiValidations, setupStats } from "@/server/tradingRepository";

/**
 * OPENAI NO RUNTIME — SOMENTE PELO SERVIDOR (auditoria sênior, BLOCO 6).
 *
 * `validatePrintWithOpenAI` existia pronto e NENHUM caminho do navegador
 * conseguia alcançá-lo: setupTracker e marketMonitor rodam no cliente, e a
 * chave vive em `backend/.env`. Esta server function é a ponte que faltava —
 * a imagem sobe, a chave nunca desce.
 *
 * O CONTRATO DE FALHA é o mesmo do módulo: IA indisponível/timeout NUNCA
 * derruba a captura nem promove operação — o handler devolve o veredito
 * degradado (Luna INDISPONÍVEL ⇒ `final.confirmado === false`) construído
 * pelo MESMO `finalConfirmation` de produção, nunca por uma segunda regra.
 */

const Deterministic = z.object({
  pass: z.boolean(),
  e2Closed: z.boolean(),
  rr: z.number().nullable(),
  rrOk: z.boolean(),
  entry: z.number().nullable(),
  stop: z.number().nullable(),
  levelsValid: z.boolean(),
  stage: z.string(),
  blockCode: z.string().nullable(),
  blockReason: z.string().nullable(),
});

const ValidateInput = z.object({
  imageDataUrl: z
    .string()
    .min(100)
    .max(12_000_000)
    .refine((v) => /^data:image\/(png|jpeg|jpg|webp);base64,/.test(v), {
      message: "Formato não suportado. Use PNG, JPG ou WebP.",
    }),
  imageHash: z.string().min(8),
  captureId: z.string().min(1),
  candleTime: z.number().int(),
  deterministic: Deterministic,
});

/** Resposta degradada com a MESMA semântica do caminho feliz. */
function degradado(d: z.infer<typeof Deterministic>, reason: string): PrintValidationOutput {
  const luna = { status: "INDISPONIVEL" as const, reason };
  const terra = { status: "NAO_CHAMADO" as const };
  const final = finalConfirmation({
    t4DeterministicPass: d.pass,
    e2Closed: d.e2Closed,
    rrOk: d.rrOk,
    levelsValid: d.levelsValid,
    luna,
    terra,
  });
  return {
    luna,
    terra,
    final,
    ui: aiStatusRows({ luna, terra, t4DeterministicPass: d.pass, final }),
  };
}

export const validateCaptureWithOpenAI = createServerFn({ method: "POST" })
  .validator((data: unknown) => ValidateInput.parse(data))
  .handler(async ({ data }): Promise<PrintValidationOutput> => {
    try {
      return await validatePrintWithOpenAI(data);
    } catch (raised) {
      // Nenhuma exceção da IA atravessa para o cliente como erro de captura.
      return degradado(data.deterministic, String(raised).slice(0, 200));
    }
  });

/**
 * As últimas validações persistidas — para as telas que não geram validação
 * própria (ex.: backtest) mostrarem o estado REAL da trilha, não um placeholder.
 */
export const latestAiValidation = createServerFn({ method: "GET" }).handler(
  async (): Promise<{
    rows: { luna: string; terra: string; t4: string; veredito: string } | null;
    total: number;
  }> => {
    const registros = listAiValidations(1);
    const ultimo = registros[0];
    if (!ultimo) return { rows: null, total: 0 };
    const luna = ultimo.lunaJson !== null;
    const terra = ultimo.terraJson !== null;
    return {
      total: registros.length,
      rows: {
        luna: luna ? "Luna: leitura registrada" : "Luna: sem resposta válida",
        terra: terra ? "Terra: desafio registrado" : "Terra: não chamado",
        t4: `T4: ${ultimo.status}`,
        veredito: `${ultimo.status} · candle ${new Date(ultimo.candleTime).toISOString().slice(11, 16)}`,
      },
    };
  },
);

/**
 * SOL — AUDITORIA OFFLINE DA TÉCNICA, por demanda do operador (nunca no laço
 * de análise). A evidência mínima sai do próprio banco (`setupStats`); o
 * operador pode anexar relatórios consolidados no payload. Sem créditos ou
 * sem chave, a recusa volta declarada — jamais um veredito inventado.
 */
export const runSolAuditOffline = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    z.object({ evidence: z.record(z.string(), z.unknown()).optional() }).parse(data ?? {}),
  )
  .handler(async ({ data }): Promise<SolAuditResult> => {
    const evidencePayload: Record<string, unknown> = {
      setupStats: setupStats(),
      ...(data.evidence ?? {}),
    };
    return runSolTechniqueAudit({ evidencePayload });
  });
