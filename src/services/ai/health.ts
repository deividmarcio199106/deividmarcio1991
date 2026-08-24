import { aiConfig, type AIProvider } from "./config";
import { aiBreaker } from "./gateway";

export type HealthStatus = "ok" | "degradado" | "desligado" | "falha";

export interface AIHealth {
  status: HealthStatus;
  configured: boolean;
  reachable: boolean;
  /** Compatibilidade: disponibilidade do modelo textual. */
  modelAvailable: boolean;
  visionModelAvailable: boolean;
  textAvailable: boolean;
  visionAvailable: boolean;
  /** Compatibilidade: nome do modelo textual. */
  model: string;
  visionModel: string;
  provider: AIProvider;
  modelsCount: number;
  latencyMs: number | null;
  /** Última chamada REAL bem-sucedida ao provedor (epoch ms). */
  lastSuccessAt: number | null;
  /** Último erro real observado no health (epoch ms + mensagem). */
  lastErrorAt: number | null;
  lastError: string | null;
  breaker: ReturnType<typeof aiBreaker.snapshot>;
  message: string;
  hint: string | null;
}

let lastSuccessAt: number | null = null;
let lastErrorAt: number | null = null;
let lastError: string | null = null;

export type OllamaHealth = AIHealth;

interface ModelsPayload {
  models?: { name?: string; model?: string; id?: string }[];
  data?: { id?: string }[];
}

function sameModel(a: string, b: string): boolean {
  if (!a || !b) return false;
  const normalize = (value: string) =>
    (value.includes(":") ? value : `${value}:latest`).toLowerCase();
  return a.toLowerCase() === b.toLowerCase() || normalize(a) === normalize(b);
}

function unavailable(
  configured: boolean,
  config: ReturnType<typeof aiConfig>,
  message: string,
  hint: string | null,
): AIHealth {
  return {
    status: configured ? "falha" : "desligado",
    configured,
    reachable: false,
    modelAvailable: false,
    visionModelAvailable: false,
    textAvailable: false,
    visionAvailable: false,
    model: config.model,
    visionModel: config.visionModel,
    provider: config.provider,
    modelsCount: 0,
    latencyMs: null,
    lastSuccessAt,
    lastErrorAt,
    lastError,
    breaker: aiBreaker.snapshot(),
    message,
    hint,
  };
}

export async function checkAI(): Promise<AIHealth> {
  const config = aiConfig();
  const breaker = aiBreaker.snapshot();

  if (!config.baseUrl || !config.apiBaseUrl) {
    return unavailable(
      false,
      config,
      "IA opcional desligada: nenhum endpoint foi configurado.",
      "Na VPS, defina OLLAMA_BASE_URL e OLLAMA_TEXT_MODEL. Configure OLLAMA_VISION_MODEL somente com um modelo realmente multimodal instalado.",
    );
  }

  const endpoint =
    config.provider === "ollama" ? `${config.baseUrl}/api/tags` : `${config.apiBaseUrl}/models`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (config.apiKey && config.apiKey !== "not-required")
    headers.authorization = `Bearer ${config.apiKey}`;
  const startedAt = Date.now();

  try {
    const response = await fetch(endpoint, {
      signal: AbortSignal.timeout(config.healthTimeoutMs),
      headers,
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      lastErrorAt = Date.now();
      lastError = `HTTP ${response.status} ao listar modelos.`;
      return {
        ...unavailable(
          true,
          config,
          `Servidor de IA respondeu HTTP ${response.status} ao listar modelos.`,
          response.status === 401 || response.status === 403
            ? "Verifique a autenticação configurada no servidor."
            : "Verifique o endpoint, o túnel e os modelos instalados.",
        ),
        reachable: true,
        latencyMs,
      };
    }

    const payload = (await response.json()) as ModelsPayload;
    const modelNames = [
      ...(payload.models ?? []).map((item) => item.model ?? item.name ?? item.id ?? ""),
      ...(payload.data ?? []).map((item) => item.id ?? ""),
    ].filter(Boolean);
    const textAvailable =
      Boolean(config.model) && modelNames.some((name) => sameModel(name, config.model));
    const visionConfigured = Boolean(config.visionModel);
    const visionAvailable =
      visionConfigured && modelNames.some((name) => sameModel(name, config.visionModel));
    const circuitHealthy = breaker.state === "fechado";
    const fullyReady = textAvailable && visionAvailable && circuitHealthy;

    const missing: string[] = [];
    if (!textAvailable) missing.push(`modelo textual ${config.model || "não configurado"}`);
    if (!visionConfigured) missing.push("modelo visual não configurado");
    else if (!visionAvailable) missing.push(`modelo visual ${config.visionModel}`);

    // Chamada REAL bem-sucedida — só aqui o ONLINE pode acender.
    lastSuccessAt = Date.now();

    return {
      status: fullyReady ? "ok" : "degradado",
      configured: true,
      reachable: true,
      modelAvailable: textAvailable,
      visionModelAvailable: visionAvailable,
      textAvailable,
      visionAvailable,
      model: config.model,
      visionModel: config.visionModel,
      provider: config.provider,
      modelsCount: modelNames.length,
      latencyMs,
      lastSuccessAt,
      lastErrorAt,
      lastError,
      breaker,
      message: fullyReady
        ? "Servidor de IA online com modelos textual e visual disponíveis."
        : `Servidor de IA online em modo degradado: ${missing.join("; ") || "circuito em recuperação"}.`,
      hint: fullyReady
        ? null
        : "Não presuma capacidade visual pelo nome do modelo. Configure somente um modelo multimodal realmente instalado.",
    };
  } catch (error) {
    const timedOut =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    lastErrorAt = Date.now();
    lastError = timedOut
      ? "Timeout no health do provedor (túnel GPU caiu?)."
      : error instanceof Error
        ? error.message
        : String(error);
    const result = unavailable(
      true,
      config,
      timedOut
        ? `Servidor de IA não respondeu em ${Math.round(config.healthTimeoutMs / 1000)}s.`
        : "Não foi possível conectar ao servidor de IA.",
      "Verifique o túnel GPU, o endpoint local da VPS e o processo Ollama.",
    );
    return { ...result, latencyMs: Date.now() - startedAt };
  }
}

export const checkOllama = checkAI;

export interface AppHealth {
  status: HealthStatus;
  analyzer: { status: "ok"; message: string };
  ai: { status: HealthStatus; message: string };
  uptimeSeconds: number;
  timestamp: string;
}

export async function checkApp(): Promise<AppHealth> {
  const ai = await checkAI();
  const aiHealthy = ai.status === "ok" || ai.status === "desligado" || ai.status === "degradado";
  return {
    status: aiHealthy ? "ok" : "degradado",
    analyzer: {
      status: "ok",
      message:
        "Captura contínua, evidência histórica, persistência e gerenciamento continuam isolados de falhas do provedor de IA.",
    },
    ai: { status: ai.status, message: ai.message },
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}
