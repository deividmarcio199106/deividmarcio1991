/** Configuração de IA opcional, lida somente no servidor. */

export const DEFAULT_AI_MODEL = "qwen3:8b";
export const DEFAULT_AI_VISION_MODEL = "";
export const DEFAULT_AI_TIMEOUT_MS = 120_000;
export const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;
// Aliases mantidos para instalações antigas.
export const DEFAULT_OLLAMA_MODEL = DEFAULT_AI_MODEL;
export const DEFAULT_OLLAMA_TIMEOUT_MS = DEFAULT_AI_TIMEOUT_MS;

export type AIProvider = "ollama" | "openai-compatible";

export interface AIConfig {
  provider: AIProvider;
  /** Base sem barra final. No Ollama, também sem o sufixo /v1. */
  baseUrl: string | null;
  /** Base exata consumida pelo cliente OpenAI-compatible. */
  apiBaseUrl: string | null;
  model: string;
  /** Modelo multimodal usado exclusivamente para OCR/leitura visual. Vazio = visão desabilitada. */
  visionModel: string;
  timeoutMs: number;
  apiKey: string;
  healthTimeoutMs: number;
}

export function normalizeAIBaseUrl(
  raw: string | undefined | null,
  provider: AIProvider,
): string | null {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  return provider === "ollama" ? trimmed.replace(/\/v1$/i, "") : trimmed;
}

/** Compatibilidade com a configuração antiga. */
export function normalizeOllamaBaseUrl(raw: string | undefined | null): string | null {
  return normalizeAIBaseUrl(raw, "ollama");
}

function toApiBaseUrl(baseUrl: string | null): string | null {
  if (!baseUrl) return null;
  return /\/v1$/i.test(baseUrl) ? baseUrl : `${baseUrl}/v1`;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * AI_* tem prioridade e aceita qualquer API OpenAI-compatible. OLLAMA_* segue
 * funcionando para instalações existentes.
 */
export function aiConfig(env: Record<string, string | undefined> = process.env): AIConfig {
  const modern = Boolean(env["AI_BASE_URL"]?.trim());
  const provider: AIProvider =
    env["AI_PROVIDER"]?.trim().toLowerCase() === "ollama" || env["OLLAMA_BASE_URL"]?.trim()
      ? "ollama"
      : modern
        ? "openai-compatible"
        : "ollama";
  // §consolidação: OLLAMA_BASE_URL é aceito e PREFERIDO quando definido;
  // AI_BASE_URL permanece como compatibilidade.
  const baseUrl = normalizeAIBaseUrl(
    env["OLLAMA_BASE_URL"]?.trim() ? env["OLLAMA_BASE_URL"] : env["AI_BASE_URL"],
    provider,
  );
  return {
    provider,
    baseUrl,
    apiBaseUrl: toApiBaseUrl(baseUrl),
    model:
      env["OLLAMA_TEXT_MODEL"]?.trim() ||
      env["AI_MODEL"]?.trim() ||
      env["OLLAMA_MODEL"]?.trim() ||
      DEFAULT_AI_MODEL,
    visionModel:
      env["OLLAMA_VISION_MODEL"]?.trim() ||
      env["AI_VISION_MODEL"]?.trim() ||
      DEFAULT_AI_VISION_MODEL,
    timeoutMs: positiveInt(env["AI_TIMEOUT_MS"] ?? env["OLLAMA_TIMEOUT_MS"], DEFAULT_AI_TIMEOUT_MS),
    apiKey: env["AI_API_KEY"]?.trim() || env["OLLAMA_API_KEY"]?.trim() || "not-required",
    healthTimeoutMs: positiveInt(
      env["AI_HEALTH_TIMEOUT_MS"] ?? env["OLLAMA_HEALTH_TIMEOUT_MS"],
      DEFAULT_HEALTH_TIMEOUT_MS,
    ),
  };
}

export function isAIConfigured(env?: Record<string, string | undefined>): boolean {
  return aiConfig(env).baseUrl !== null;
}

export function publicAIConfig(env?: Record<string, string | undefined>): {
  configured: boolean;
  model: string;
  timeoutMs: number;
  provider: AIProvider;
} {
  const config = aiConfig(env);
  return {
    configured: config.baseUrl !== null,
    model: config.model,
    timeoutMs: config.timeoutMs,
    provider: config.provider,
  };
}
