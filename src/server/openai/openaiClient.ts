/**
 * CLIENTE OPENAI — SÓ NO SERVIDOR, e o arquivo se recusa a existir fora dele.
 *
 * A chave mora em `process.env.OPENAI_API_KEY` e NUNCA atravessa para o
 * navegador: não há prefixo VITE_, não há echo em log (o valor jamais entra em
 * mensagem de erro), e o guard abaixo lança se este módulo for importado num
 * bundle de cliente. Vazamento de chave não é bug de estilo — é incidente.
 *
 * API: Responses (`POST /v1/responses`) com Structured Outputs (json_schema
 * strict). O formato é imposto na REQUISIÇÃO; a validação zod acontece na
 * RESPOSTA (aiSchemas.parseAi) — prometido não é cumprido.
 *
 * PAPÉIS (modelos configuráveis por env, defaults da decisão de 23/08/2026):
 *   OPENAI_PRINT_MODEL      gpt-5.6-luna   — todo print (alto volume)
 *   OPENAI_VALIDATOR_MODEL  gpt-5.6-terra  — 2ª validação adversarial
 *   OPENAI_TECHNIQUE_MODEL  gpt-5.6-sol    — auditoria offline da técnica
 */

if (typeof window !== "undefined") {
  throw new Error("openaiClient é código de SERVIDOR — a chave nunca vai ao navegador.");
}

export interface OpenAiUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface OpenAiCallResult {
  ok: boolean;
  /** Texto do output estruturado (JSON string) quando ok. */
  outputText: string | null;
  /** Motivo do fracasso — NUNCA contém a chave nem headers. */
  error: string | null;
  latencyMs: number;
  usage: OpenAiUsage;
  model: string;
}

export interface OpenAiCallInput {
  role: "PRINT" | "VALIDATOR" | "TECHNIQUE";
  /** Instrução + contexto textual (estado T4, decisão determinística…). */
  prompt: string;
  /** Print em data URL; omitido nas chamadas só-texto (Sol). */
  imageDataUrl?: string;
  /** JSON Schema (strict) do Structured Outputs. */
  jsonSchema: { name: string; strict: boolean; schema: Record<string, unknown> };
  timeoutMs?: number;
  /** Injetável para teste — produção usa o fetch global. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_MODELS: Record<OpenAiCallInput["role"], string> = {
  PRINT: "gpt-5.6-luna",
  VALIDATOR: "gpt-5.6-terra",
  TECHNIQUE: "gpt-5.6-sol",
};

function modelFor(role: OpenAiCallInput["role"]): string {
  const env =
    role === "PRINT"
      ? process.env["OPENAI_PRINT_MODEL"]
      : role === "VALIDATOR"
        ? process.env["OPENAI_VALIDATOR_MODEL"]
        : process.env["OPENAI_TECHNIQUE_MODEL"];
  return env?.trim() || DEFAULT_MODELS[role];
}

export function openAiConfigured(): boolean {
  return Boolean(process.env["OPENAI_API_KEY"]?.trim());
}

const BASE_URL = () => process.env["OPENAI_BASE_URL"]?.trim() || "https://api.openai.com/v1";

/**
 * Uma chamada, um retry. O retry existe para falha TRANSIENTE (rede, 5xx);
 * 4xx não repete — pedido errado não melhora repetindo. O timeout aborta de
 * verdade (AbortController): requisição pendurada não segura fila de captura.
 */
export async function callOpenAi(input: OpenAiCallInput): Promise<OpenAiCallResult> {
  const model = modelFor(input.role);
  const começo = Date.now();
  const key = process.env["OPENAI_API_KEY"]?.trim();
  if (!key) {
    return {
      ok: false,
      outputText: null,
      error: "OPENAI_API_KEY ausente no ambiente do servidor.",
      latencyMs: 0,
      usage: { inputTokens: null, outputTokens: null },
      model,
    };
  }
  const fetcher = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 60_000;

  const content: Array<Record<string, unknown>> = [{ type: "input_text", text: input.prompt }];
  if (input.imageDataUrl) content.push({ type: "input_image", image_url: input.imageDataUrl });

  const body = JSON.stringify({
    model,
    input: [{ role: "user", content }],
    text: { format: { type: "json_schema", ...input.jsonSchema } },
    max_output_tokens: 2_000,
  });

  let ultimaFalha = "";
  for (let tentativa = 0; tentativa < 2; tentativa += 1) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const res = await fetcher(`${BASE_URL()}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body,
        signal: abort.signal,
      });
      if (!res.ok) {
        ultimaFalha = `HTTP ${res.status}`;
        if (res.status >= 400 && res.status < 500) break; // 4xx não melhora repetindo
        continue;
      }
      const json = (await res.json()) as {
        output_text?: string;
        output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const texto =
        json.output_text ??
        json.output
          ?.flatMap((o) => o.content ?? [])
          .filter((c) => c.type === "output_text")
          .map((c) => c.text ?? "")
          .join("") ??
        null;
      if (!texto) {
        ultimaFalha = "resposta sem output_text";
        continue;
      }
      return {
        ok: true,
        outputText: texto,
        error: null,
        latencyMs: Date.now() - começo,
        usage: {
          inputTokens: json.usage?.input_tokens ?? null,
          outputTokens: json.usage?.output_tokens ?? null,
        },
        model,
      };
    } catch (problem) {
      // A mensagem NUNCA inclui a chave: só a classe do problema.
      ultimaFalha = problem instanceof Error ? problem.name : "erro de rede";
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    ok: false,
    outputText: null,
    error: ultimaFalha || "falha desconhecida",
    latencyMs: Date.now() - começo,
    usage: { inputTokens: null, outputTokens: null },
    model,
  };
}
