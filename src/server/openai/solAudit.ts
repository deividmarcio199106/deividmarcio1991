/**
 * AUDITORIA OFFLINE DA TÉCNICA — gpt-5.6-sol como ADVERSÁRIO, nunca como autor.
 *
 * Sol recebe: regras congeladas + hash do código relevante + o material de
 * evidência (ledger de validações, relatórios de backtest, OOS, walk-forward).
 * A tarefa dele é PROCURAR FURO: look-ahead, overfitting, live≠replay, R:R
 * fora do piso, E2 aberta, 5R sem espaço, horário violado, duplicata,
 * estatística que não fecha, evento impossível.
 *
 * O QUE SOL NÃO PODE, por construção:
 *   - mudar regra (recebe snapshot, devolve achados — nenhum caminho escreve
 *     em technique/rules_json);
 *   - promover técnica (productionEligible=false dele é VETO adicional;
 *     true dele NÃO promove — a promoção continua exigindo VALIDATED +
 *     evidência no fluxo determinístico).
 *
 * `productionEligible` DEVE voltar false se qualquer evidência obrigatória
 * (métricas verificáveis, OOS, walk-forward) faltar — e o prompt diz isso com
 * todas as letras, mas quem GARANTE é o pós-processamento daqui: evidência
 * ausente derruba a flag localmente, independente do que o modelo disser.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { SOL_JSON_SCHEMA, SolAuditSchema, parseAi, type SolAudit } from "@/lib/t4/aiSchemas";
import { t41Rules } from "@/lib/t4/techniqueT41";
import { T4_PRODUCTION_VERSION, t4Versions } from "@/lib/t4/version";
import { callOpenAi, openAiConfigured } from "./openaiClient";

/** Os arquivos cujo hash identifica A TÉCNICA como implementada. */
const CORE_FILES = [
  "src/lib/engines/strategy.ts",
  "src/lib/t4/riskGate.ts",
  "src/lib/t4/management.ts",
  "src/lib/t4/regimeClassifier.ts",
  "src/lib/t4/marketClockGuard.ts",
  "src/lib/engines/orderedPullback.ts",
];

export function techniqueCodeHash(): string {
  const h = createHash("sha256");
  for (const file of CORE_FILES) {
    try {
      h.update(file);
      h.update(readFileSync(file, "utf8"));
    } catch {
      h.update(`${file}:AUSENTE`);
    }
  }
  return h.digest("hex");
}

export interface SolAuditInput {
  /** Métricas/ledger/relatórios já consolidados — o material de evidência. */
  evidencePayload: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}

export type SolAuditResult = { ok: true; audit: SolAudit } | { ok: false; reason: string };

export async function runSolTechniqueAudit(input: SolAuditInput): Promise<SolAuditResult> {
  if (!openAiConfigured()) {
    return { ok: false, reason: "OPENAI_API_KEY não configurada — auditoria Sol não executada." };
  }
  const versions = t4Versions();
  const codeHash = techniqueCodeHash();
  const prompt = [
    "Você audita ADVERSARIALMENTE uma técnica de day trade determinística. Você NÃO pode alterar regra — apenas apontar problemas com evidência.",
    "Procure: look-ahead, overfitting, inconsistência live/replay, R:R abaixo do piso, E2 em candle aberto, alvo 5R sem espaço, violação de horário, operação duplicada, estatística inconsistente, evento impossível (data/hora/preço).",
    `Versões: ${JSON.stringify(versions)} · codeHash=${codeHash}`,
    `Regras congeladas: ${JSON.stringify(t41Rules())}`,
    `Evidência: ${JSON.stringify(input.evidencePayload)}`,
    "productionEligible=true SOMENTE com métricas verificadas + OOS verificado + walk-forward verificado, todos com dados presentes na evidência. Ausência de qualquer um = false.",
    "Responda SOMENTE o JSON do schema.",
  ].join("\n\n");

  const r = await callOpenAi({
    role: "TECHNIQUE",
    prompt,
    jsonSchema: SOL_JSON_SCHEMA,
    timeoutMs: 120_000,
    fetchImpl: input.fetchImpl,
  });
  if (!r.ok || r.outputText === null) return { ok: false, reason: r.error ?? "sem resposta" };

  let bruto: unknown;
  try {
    bruto = JSON.parse(r.outputText);
  } catch {
    return { ok: false, reason: "resposta não é JSON" };
  }
  const parsed = parseAi(SolAuditSchema, bruto);
  if (!parsed.ok) return { ok: false, reason: `JSON inválido: ${parsed.reason}` };

  // A GARANTIA LOCAL: evidência obrigatória ausente derruba a elegibilidade
  // aqui, no código — a opinião do modelo não passa por cima do fato.
  const audit: SolAudit = {
    ...parsed.value,
    techniqueVersion: T4_PRODUCTION_VERSION,
    codeHash,
    productionEligible:
      parsed.value.productionEligible &&
      parsed.value.metricsVerified &&
      parsed.value.oosVerified &&
      parsed.value.walkForwardVerified &&
      parsed.value.critical.length === 0,
  };
  return { ok: true, audit };
}
