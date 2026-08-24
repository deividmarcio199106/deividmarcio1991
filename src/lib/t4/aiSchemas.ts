/**
 * SCHEMAS DAS TRÊS VALIDAÇÕES OPENAI — Luna lê, Terra desafia, Sol audita.
 *
 * DUAS CAMADAS DE SCHEMA, de propósito:
 *   1. O JSON Schema enviado à API (Structured Outputs) — obriga o MODELO ao
 *      formato antes de a resposta existir.
 *   2. O zod daqui — valida o que CHEGOU, porque contrato prometido não é
 *      contrato cumprido. JSON fora do schema BLOQUEIA a validação (vira
 *      INDISPONÍVEL), nunca é "consertado" em silêncio.
 *
 * A REGRA QUE ATRAVESSA OS TRÊS: número ilegível é null. Um modelo que devolve
 * preço onde declarou `entryVisible:false` está inventando — e invenção é
 * rejeição automática do lado determinístico (aiValidation.lunaSanity).
 */

import { z } from "zod";

/** Número lido do gráfico: ou o modelo VIU, ou é null. Nunca estimado. */
const nivel = z.number().finite().nullable();

export const LunaPrintReadSchema = z.object({
  captureId: z.string().min(1),
  candleTime: z.number().finite().nullable(),
  direction: z.enum(["COMPRA", "VENDA", "NEUTRO"]),
  regime: z.string().min(1),
  t4Present: z.boolean(),
  entryVisible: z.boolean(),
  entry: nivel,
  stopVisible: z.boolean(),
  stop: nivel,
  targetVisible: z.boolean(),
  target3R: nivel,
  target5R: nivel,
  confirmationCandleClosed: z.boolean(),
  pullbackCandles: z.number().int().min(0).nullable(),
  pivotPreserved: z.boolean().nullable(),
  structureAligned: z.boolean(),
  obstacleBefore5R: z.boolean().nullable(),
  confidences: z.object({
    visual: z.number().min(0).max(100),
    structure: z.number().min(0).max(100),
    t4: z.number().min(0).max(100),
    entry: z.number().min(0).max(100),
  }),
  contradictions: z.array(z.string()),
  evidence: z.array(z.string()),
  verdict: z.enum(["PASS", "REJECT", "INCONCLUSIVE"]),
});
export type LunaPrintRead = z.infer<typeof LunaPrintReadSchema>;

export const TerraChallengeSchema = z.object({
  approved: z.boolean(),
  contradictions: z.array(z.string()),
  criticalIssue: z.string().nullable(),
  evidence: z.array(z.string()),
  verdict: z.enum(["APPROVE", "REJECT", "INCONCLUSIVE"]),
});
export type TerraChallenge = z.infer<typeof TerraChallengeSchema>;

export const SolAuditSchema = z.object({
  techniqueVersion: z.string().min(1),
  codeHash: z.string().min(1),
  critical: z.array(z.string()),
  high: z.array(z.string()),
  medium: z.array(z.string()),
  evidence: z.array(z.string()),
  metricsVerified: z.boolean(),
  oosVerified: z.boolean(),
  walkForwardVerified: z.boolean(),
  productionEligible: z.boolean(),
});
export type SolAudit = z.infer<typeof SolAuditSchema>;

export type ParsedAi<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Valida o payload cru vindo do modelo. Falha é falha: quem chama trata como
 * validação INDISPONÍVEL — jamais aproveita "os campos que deram certo".
 */
export function parseAi<T>(schema: z.ZodType<T>, raw: unknown): ParsedAi<T> {
  const r = schema.safeParse(raw);
  if (r.success) return { ok: true, value: r.data };
  return {
    ok: false,
    reason: r.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; "),
  };
}

/**
 * JSON Schema (Structured Outputs) espelhando os zod acima — é o que vai no
 * `text.format` da Responses API. Mantidos JUNTOS neste arquivo para a dupla
 * nunca divergir sem o diff denunciar.
 */
export const LUNA_JSON_SCHEMA = {
  name: "luna_print_read",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "captureId",
      "candleTime",
      "direction",
      "regime",
      "t4Present",
      "entryVisible",
      "entry",
      "stopVisible",
      "stop",
      "targetVisible",
      "target3R",
      "target5R",
      "confirmationCandleClosed",
      "pullbackCandles",
      "pivotPreserved",
      "structureAligned",
      "obstacleBefore5R",
      "confidences",
      "contradictions",
      "evidence",
      "verdict",
    ],
    properties: {
      captureId: { type: "string" },
      candleTime: { type: ["number", "null"] },
      direction: { type: "string", enum: ["COMPRA", "VENDA", "NEUTRO"] },
      regime: { type: "string" },
      t4Present: { type: "boolean" },
      entryVisible: { type: "boolean" },
      entry: { type: ["number", "null"] },
      stopVisible: { type: "boolean" },
      stop: { type: ["number", "null"] },
      targetVisible: { type: "boolean" },
      target3R: { type: ["number", "null"] },
      target5R: { type: ["number", "null"] },
      confirmationCandleClosed: { type: "boolean" },
      pullbackCandles: { type: ["integer", "null"] },
      pivotPreserved: { type: ["boolean", "null"] },
      structureAligned: { type: "boolean" },
      obstacleBefore5R: { type: ["boolean", "null"] },
      confidences: {
        type: "object",
        additionalProperties: false,
        required: ["visual", "structure", "t4", "entry"],
        properties: {
          visual: { type: "number" },
          structure: { type: "number" },
          t4: { type: "number" },
          entry: { type: "number" },
        },
      },
      contradictions: { type: "array", items: { type: "string" } },
      evidence: { type: "array", items: { type: "string" } },
      verdict: { type: "string", enum: ["PASS", "REJECT", "INCONCLUSIVE"] },
    },
  },
} as const;

export const TERRA_JSON_SCHEMA = {
  name: "terra_challenge",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["approved", "contradictions", "criticalIssue", "evidence", "verdict"],
    properties: {
      approved: { type: "boolean" },
      contradictions: { type: "array", items: { type: "string" } },
      criticalIssue: { type: ["string", "null"] },
      evidence: { type: "array", items: { type: "string" } },
      verdict: { type: "string", enum: ["APPROVE", "REJECT", "INCONCLUSIVE"] },
    },
  },
} as const;

export const SOL_JSON_SCHEMA = {
  name: "sol_technique_audit",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "techniqueVersion",
      "codeHash",
      "critical",
      "high",
      "medium",
      "evidence",
      "metricsVerified",
      "oosVerified",
      "walkForwardVerified",
      "productionEligible",
    ],
    properties: {
      techniqueVersion: { type: "string" },
      codeHash: { type: "string" },
      critical: { type: "array", items: { type: "string" } },
      high: { type: "array", items: { type: "string" } },
      medium: { type: "array", items: { type: "string" } },
      evidence: { type: "array", items: { type: "string" } },
      metricsVerified: { type: "boolean" },
      oosVerified: { type: "boolean" },
      walkForwardVerified: { type: "boolean" },
      productionEligible: { type: "boolean" },
    },
  },
} as const;
