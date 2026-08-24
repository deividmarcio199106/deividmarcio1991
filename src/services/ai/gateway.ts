import { aiConfig } from "./config";
import { CircuitBreaker, CircuitOpenError } from "./circuitBreaker";

/**
 * AI GATEWAY — ponto único de saída para IA textual.
 *
 * O navegador nunca acessa Ollama/provedor externo. Ollama usa /api/chat;
 * provedores OpenAI-compatible usam /v1/chat/completions por fetch nativo.
 * A camada não depende de SDK externo e a chave é opcional no Ollama local.
 */
export type AIRole = "user" | "assistant";
export interface AIMessage {
  role: AIRole;
  content: string;
}

export interface AIRequest {
  system: string;
  messages: AIMessage[];
  timeoutMs?: number;
}

export interface AIResponse {
  text: string;
  error: string | null;
}

export const aiBreaker = new CircuitBreaker();

async function ollamaNativeChat(
  cfg: ReturnType<typeof aiConfig>,
  req: AIRequest,
  timeoutMs: number,
): Promise<string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey && cfg.apiKey !== "not-required") headers.authorization = `Bearer ${cfg.apiKey}`;
  const response = await fetch(`${cfg.baseUrl}/api/chat`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model: cfg.model,
      stream: false,
      messages: [{ role: "system", content: req.system }, ...req.messages],
    }),
  });
  if (!response.ok) throw new Error(`status ${response.status}`);
  const payload = (await response.json()) as { message?: { content?: string } };
  return payload.message?.content?.trim() ?? "";
}

async function openAICompatibleChat(
  cfg: ReturnType<typeof aiConfig>,
  req: AIRequest,
  timeoutMs: number,
): Promise<string> {
  if (!cfg.apiBaseUrl) throw new Error("AI_BASE_URL não configurada");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey && cfg.apiKey !== "not-required") headers.authorization = `Bearer ${cfg.apiKey}`;
  const response = await fetch(`${cfg.apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: "system", content: req.system }, ...req.messages],
      temperature: 0,
      stream: false,
    }),
  });
  if (!response.ok) throw new Error(`status ${response.status}`);
  const payload = (await response.json()) as {
    choices?: { message?: { content?: string | null } }[];
  };
  return payload.choices?.[0]?.message?.content?.trim() ?? "";
}

export function describeAIError(e: unknown, modelId: string, timeoutMs: number): string {
  if (e instanceof CircuitOpenError) return e.message;
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
    return `A IA não respondeu em ${Math.round(timeoutMs / 1000)}s. Ajuste OLLAMA_TIMEOUT_MS/AI_TIMEOUT_MS ou verifique o provedor.`;
  }
  if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed") || msg.includes("ENOTFOUND")) {
    return "Não foi possível conectar ao servidor de IA. Verifique OLLAMA_BASE_URL/AI_BASE_URL e o túnel.";
  }
  if (msg.includes("404")) {
    return `Modelo "${modelId || "não configurado"}" não encontrado no provedor. Confira OLLAMA_TEXT_MODEL/AI_MODEL.`;
  }
  if (msg.includes("401") || msg.includes("403")) {
    return "Servidor de IA recusou a autenticação. Confira OLLAMA_API_KEY/AI_API_KEY.";
  }

  return `Falha na IA: ${sanitize(msg)}`;
}

function sanitize(msg: string): string {
  return msg.replace(/https?:\/\/[^\s"')]+/gi, "[servidor de IA]");
}

export async function generateAIText(req: AIRequest): Promise<AIResponse> {
  const cfg = aiConfig();
  if (!cfg.baseUrl) {
    return {
      text: "",
      error: "IA textual indisponível: configure OLLAMA_BASE_URL/AI_BASE_URL no servidor.",
    };
  }
  if (!cfg.model) {
    return { text: "", error: "Modelo textual não configurado." };
  }

  const timeoutMs = req.timeoutMs ?? cfg.timeoutMs;
  try {
    const text = await aiBreaker.run(() =>
      cfg.provider === "ollama"
        ? ollamaNativeChat(cfg, req, timeoutMs)
        : openAICompatibleChat(cfg, req, timeoutMs),
    );
    return { text, error: null };
  } catch (e) {
    return { text: "", error: describeAIError(e, cfg.model, timeoutMs) };
  }
}
