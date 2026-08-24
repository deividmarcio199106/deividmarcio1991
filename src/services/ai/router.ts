/**
 * AI ROUTER — Claude → OpenAI → Gemini → Ollama/Qwen.
 *
 * SOMENTE SERVIDOR. Nenhuma chave, URL ou cabeçalho sai daqui para o navegador:
 * o cliente fala com server functions, e as server functions falam com este
 * módulo. `publicProviderStatus()` é a única superfície que o front vê, e ela
 * carrega estado — nunca segredo.
 *
 * A IA aqui existe para REVISAR CÓDIGO. Ela não lê mercado, não cria candle e
 * não libera sinal: isso é do motor T4, que é determinístico.
 */

import { sanitizeSecrets } from "@/lib/errors/sanitize";
import { aiConfig } from "./config";

export type AIProviderId = "claude" | "openai" | "gemini" | "ollama";

export type ProviderState = "READY" | "ERROR" | "OFFLINE" | "RATE_LIMIT" | "FALLBACK";

export interface ProviderStatus {
  id: AIProviderId;
  label: string;
  configured: boolean;
  state: ProviderState;
  model: string;
  latencyMs: number | null;
  /** true somente após resposta HTTP real do provedor. */
  proven: boolean;
  message: string;
  lastCheckedAt: number;
}

export interface RouterResponse {
  text: string;
  provider: AIProviderId;
  /** true quando o provedor preferido falhou e outro respondeu. */
  usedFallback: boolean;
  attempts: { provider: AIProviderId; state: ProviderState; message: string }[];
}

const PROVIDER_LABEL: Record<AIProviderId, string> = {
  claude: "Claude (Anthropic)",
  openai: "OpenAI",
  gemini: "Gemini (Google)",
  ollama: "Ollama/Qwen (local)",
};

/** Ordem de preferência do comando. */
export const PROVIDER_ORDER: AIProviderId[] = ["claude", "openai", "gemini", "ollama"];

const DEFAULT_MODELS: Record<AIProviderId, string> = {
  claude: "claude-sonnet-5",
  openai: "gpt-4o",
  gemini: "gemini-2.0-flash",
  ollama: "qwen3:8b",
};

interface ProviderConfig {
  id: AIProviderId;
  apiKey: string;
  baseUrl: string;
  model: string;
  configured: boolean;
}

function env(name: string, fallback = ""): string {
  /*
   * A GUARDA QUE FALTAVA (auditoria sênior, B6): este arquivo vive em
   * `src/services` — fora de `src/server` — e o comentário "SOMENTE SERVIDOR"
   * era um contrato verbal: nada impedia um import de componente puxá-lo para
   * o bundle do navegador com as chaves dentro. Agora a leitura de ambiente
   * LANÇA no navegador: se este módulo um dia vazar para o cliente, o defeito
   * aparece na primeira chamada — nunca como chave silenciosamente exposta.
   */
  if (typeof window !== "undefined") {
    throw new Error(
      `providerConfig(${name}): módulo somente-servidor executado no navegador — chave nunca sai daqui.`,
    );
  }
  return (process.env[name] ?? "").trim() || fallback;
}

export function providerConfig(id: AIProviderId): ProviderConfig {
  switch (id) {
    case "claude": {
      const apiKey = env("ANTHROPIC_API_KEY");
      return {
        id,
        apiKey,
        baseUrl: env("ANTHROPIC_BASE_URL", "https://api.anthropic.com"),
        model: env("ANTHROPIC_MODEL", DEFAULT_MODELS.claude),
        configured: apiKey.length > 0,
      };
    }
    case "openai": {
      const apiKey = env("OPENAI_API_KEY");
      return {
        id,
        apiKey,
        baseUrl: env("OPENAI_BASE_URL", "https://api.openai.com/v1"),
        model: env("OPENAI_MODEL", DEFAULT_MODELS.openai),
        configured: apiKey.length > 0,
      };
    }
    case "gemini": {
      const apiKey = env("GEMINI_API_KEY");
      return {
        id,
        apiKey,
        baseUrl: env("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta"),
        model: env("GEMINI_MODEL", DEFAULT_MODELS.gemini),
        configured: apiKey.length > 0,
      };
    }
    case "ollama": {
      // Reaproveita a configuração de IA local que o projeto já tinha.
      const local = aiConfig();
      return {
        id,
        apiKey: local.apiKey,
        baseUrl: local.baseUrl ?? "",
        model: local.model || DEFAULT_MODELS.ollama,
        configured: Boolean(local.baseUrl),
      };
    }
  }
}

function timeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

function offline(config: ProviderConfig, message: string): ProviderStatus {
  return {
    id: config.id,
    label: PROVIDER_LABEL[config.id],
    configured: config.configured,
    state: "OFFLINE",
    model: config.model,
    latencyMs: null,
    proven: false,
    message,
    lastCheckedAt: Date.now(),
  };
}

/**
 * Health REAL de um provedor: uma chamada HTTP que só passa com resposta.
 * Sem chave configurada, o estado é OFFLINE — nunca READY presumido.
 */
export async function checkProvider(id: AIProviderId): Promise<ProviderStatus> {
  const config = providerConfig(id);
  if (!config.configured) {
    return offline(config, "Provedor não configurado — nenhuma chave/endpoint definido.");
  }

  const startedAt = Date.now();
  const base = {
    id,
    label: PROVIDER_LABEL[id],
    configured: true,
    model: config.model,
  };

  try {
    let response: Response;
    if (id === "claude") {
      response = await fetch(`${config.baseUrl}/v1/models`, {
        headers: { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" },
        signal: timeout(8_000),
      });
    } else if (id === "openai") {
      response = await fetch(`${config.baseUrl}/models`, {
        headers: { authorization: `Bearer ${config.apiKey}` },
        signal: timeout(8_000),
      });
    } else if (id === "gemini") {
      // A CHAVE VAI EM HEADER, NÃO NA URL. Em query string ela entra em log de
      // proxy, em mensagem de erro e no `error.message` que este mesmo arquivo
      // devolve ao navegador — vazamento de segredo por um caminho que ninguém
      // olha, porque é um health check.
      response = await fetch(`${config.baseUrl}/models`, {
        headers: { "x-goog-api-key": config.apiKey },
        signal: timeout(8_000),
      });
    } else {
      response = await fetch(`${config.baseUrl}/api/tags`, { signal: timeout(8_000) });
    }

    const latencyMs = Date.now() - startedAt;
    if (response.status === 429) {
      return {
        ...base,
        state: "RATE_LIMIT",
        latencyMs,
        proven: true,
        message: "Provedor respondeu, mas está limitando a taxa (HTTP 429).",
        lastCheckedAt: Date.now(),
      };
    }
    if (!response.ok) {
      return {
        ...base,
        state: "ERROR",
        latencyMs,
        proven: true,
        message:
          response.status === 401 || response.status === 403
            ? `Autenticação recusada (HTTP ${response.status}) — verifique a chave.`
            : `Provedor respondeu HTTP ${response.status}.`,
        lastCheckedAt: Date.now(),
      };
    }

    return {
      ...base,
      state: "READY",
      latencyMs,
      // Só aqui `proven` vira true: houve resposta 2xx de verdade.
      proven: true,
      message: `Respondeu em ${latencyMs}ms.`,
      lastCheckedAt: Date.now(),
    };
  } catch (error) {
    const expirou = error instanceof Error && /timeout|abort/i.test(error.name);
    return {
      ...base,
      state: "ERROR",
      latencyMs: Date.now() - startedAt,
      proven: false,
      message: expirou
        ? "Provedor não respondeu dentro de 8s."
        : // A mensagem do erro pode carregar URL com credencial. Ela vai para o
          // navegador; sanitizar aqui é o último ponto antes disso.
          `Falha de rede: ${sanitizeSecrets(error instanceof Error ? error.message : String(error))}`,
      lastCheckedAt: Date.now(),
    };
  }
}

export async function checkAllProviders(): Promise<ProviderStatus[]> {
  return Promise.all(PROVIDER_ORDER.map((id) => checkProvider(id)));
}

async function callProvider(
  config: ProviderConfig,
  system: string,
  prompt: string,
  maxTokens: number,
): Promise<string> {
  if (config.id === "claude") {
    const response = await fetch(`${config.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: timeout(120_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as { content?: { type: string; text?: string }[] };
    return (payload.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("");
  }

  if (config.id === "gemini") {
    const response = await fetch(
      `${config.baseUrl}/models/${config.model}:generateContent?key=${encodeURIComponent(config.apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: maxTokens },
        }),
        signal: timeout(120_000),
      },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    return (payload.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? "").join("");
  }

  // OpenAI e Ollama falam o mesmo dialeto chat/completions.
  const endpoint =
    config.id === "openai"
      ? `${config.baseUrl}/chat/completions`
      : `${config.baseUrl}/v1/chat/completions`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.apiKey && config.apiKey !== "not-required") {
    headers.authorization = `Bearer ${config.apiKey}`;
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
    signal: timeout(120_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return payload.choices?.[0]?.message?.content ?? "";
}

/**
 * Executa no provedor pedido e cai para o próximo configurado quando falha.
 * Cada tentativa é registrada — o relatório mostra quem falhou e por quê, em
 * vez de apresentar a resposta do fallback como se fosse do preferido.
 */
export async function routeAI(input: {
  system: string;
  prompt: string;
  preferred?: AIProviderId;
  maxTokens?: number;
}): Promise<RouterResponse> {
  const maxTokens = input.maxTokens ?? 4_000;
  const preferred = input.preferred ?? "claude";
  const chain = [preferred, ...PROVIDER_ORDER.filter((id) => id !== preferred)];
  const attempts: RouterResponse["attempts"] = [];

  for (const id of chain) {
    const config = providerConfig(id);
    if (!config.configured) {
      attempts.push({ provider: id, state: "OFFLINE", message: "não configurado" });
      continue;
    }
    try {
      const text = await callProvider(config, input.system, input.prompt, maxTokens);
      if (!text.trim()) {
        attempts.push({ provider: id, state: "ERROR", message: "resposta vazia" });
        continue;
      }
      return { text, provider: id, usedFallback: id !== preferred, attempts };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({
        provider: id,
        state: message.includes("429") ? "RATE_LIMIT" : "ERROR",
        message,
      });
    }
  }

  throw new Error(
    `Nenhum provedor de IA respondeu. Tentativas: ${attempts
      .map((attempt) => `${attempt.provider}=${attempt.state}(${attempt.message})`)
      .join(", ")}`,
  );
}

/** Superfície pública: estado, sem segredo. */
export function publicProviderStatus(): { id: AIProviderId; label: string; configured: boolean }[] {
  return PROVIDER_ORDER.map((id) => {
    const config = providerConfig(id);
    return { id, label: PROVIDER_LABEL[id], configured: config.configured };
  });
}
