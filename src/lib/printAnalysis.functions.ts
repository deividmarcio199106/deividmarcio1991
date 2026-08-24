import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  analyzeChartPrint,
  askAboutChartPrint,
  auditChartAnalysis,
} from "@/services/ai/chartVision";
import { applyConfirmationGate, validatePrintAnalysis } from "@/lib/vision/printAnalysis";

/**
 * A imagem sobe por server function — nunca direto do navegador para a GPU.
 *
 * O túnel do Ollama é alcançável só pelo backend, e é assim que deve continuar:
 * expor a porta do modelo ao navegador tornaria o endpoint de inferência
 * público para qualquer visitante do site.
 *
 * O limite de 12 MB cobre um print de tela 4K em PNG com folga. Acima disso a
 * recusa é imediata e explicada, em vez de o upload morrer no meio.
 */
const Input = z.object({
  imageDataUrl: z
    .string()
    .min(100)
    .max(12_000_000)
    .refine((v) => /^data:image\/(png|jpeg|jpg|webp);base64,/.test(v), {
      message: "Formato não suportado. Use PNG, JPG ou WebP.",
    }),
  /** Pergunta do operador sobre ESTE print, no chat contextual. */
  question: z.string().max(500).optional(),
});

export const analyzePrint = createServerFn({ method: "POST" })
  .validator((data: unknown) => Input.parse(data))
  .handler(async ({ data }) => analyzeChartPrint(data.imageDataUrl, data.question));

/**
 * AUDITORIA ADIADA — a segunda passada quando ela NÃO precisa segurar a tela.
 *
 * Para análises que só descrevem viés (formação, aproximação) o auditor deixou
 * de bloquear: a leitura vai para a tela e o revisor roda por aqui, em segundo
 * plano. Ele continua soberano — o veredito volta e pode VETAR a direção,
 * atualizando o card —, só não custa mais o dobro do tempo de espera.
 *
 * Quando a análise pode LIBERAR ENTRADA, esta função não é usada: lá o auditor
 * roda dentro de `analyzeChartPrint`, antes de qualquer coisa chegar à tela.
 */
const AuditInput = z.object({
  imageDataUrl: Input.shape.imageDataUrl,
  /** A análise VALIDADA que o auditor vai tentar reprovar. */
  analysis: z.unknown(),
});

export const auditPrint = createServerFn({ method: "POST" })
  .validator((data: unknown) => AuditInput.parse(data))
  .handler(async ({ data }) => {
    const validada = validatePrintAnalysis(data.analysis);
    if (!validada.ok || validada.analysis === null) {
      // Análise fora do contrato não é auditável: sem o objeto validado o
      // auditor estaria opinando sobre um dado que o sistema já recusa.
      return { ok: false as const, audit: null, repairs: [], problem: validada.problem };
    }
    const comecou = Date.now();
    const audit = await auditChartAnalysis(data.imageDataUrl, validada.analysis);
    validada.analysis.audit = audit;
    // A trava roda de novo com o carimbo na mão: é aqui que um veto de direção
    // rebaixa o status e zera a direção antes de voltar para a tela.
    const repairs = applyConfirmationGate(validada.analysis);
    return {
      ok: true as const,
      audit,
      analysis: validada.analysis,
      repairs,
      auditMs: Date.now() - comecou,
      problem: null,
    };
  });

/**
 * Chat contextual: pergunta sobre um print JÁ analisado.
 *
 * A análise vai serializada junto — o servidor não guarda sessão de chat, e é
 * melhor assim: cada pergunta é auditável sozinha, com todo o contexto à vista.
 */
const ChatInput = z.object({
  imageDataUrl: z
    .string()
    .min(100)
    .max(12_000_000)
    .refine((v) => /^data:image\/(png|jpeg|jpg|webp);base64,/.test(v), {
      message: "Formato não suportado.",
    }),
  analysisJson: z.string().min(2).max(60_000),
  question: z.string().min(2).max(500),
});

export const askPrintQuestion = createServerFn({ method: "POST" })
  .validator((data: unknown) => ChatInput.parse(data))
  .handler(async ({ data }) =>
    askAboutChartPrint(data.imageDataUrl, data.analysisJson, data.question),
  );
