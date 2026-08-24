import { describe, expect, it } from "vitest";

import {
  aiConfig,
  DEFAULT_AI_MODEL,
  DEFAULT_AI_VISION_MODEL,
  DEFAULT_AI_TIMEOUT_MS,
  DEFAULT_HEALTH_TIMEOUT_MS,
  isAIConfigured,
  normalizeAIBaseUrl,
  normalizeOllamaBaseUrl,
  publicAIConfig,
} from "./config";

describe("configuração de IA", () => {
  it("fica desligada com ambiente vazio", () => {
    const config = aiConfig({});
    expect(config.baseUrl).toBeNull();
    expect(config.apiBaseUrl).toBeNull();
    expect(config.model).toBe(DEFAULT_AI_MODEL);
    expect(config.visionModel).toBe(DEFAULT_AI_VISION_MODEL);
    expect(config.timeoutMs).toBe(DEFAULT_AI_TIMEOUT_MS);
    expect(config.healthTimeoutMs).toBe(DEFAULT_HEALTH_TIMEOUT_MS);
    expect(isAIConfigured({})).toBe(false);
  });

  it("aceita API OpenAI-compatible sem duplicar /v1", () => {
    const config = aiConfig({
      AI_BASE_URL: "https://api.exemplo.com/v1/",
      AI_MODEL: "modelo-1",
      AI_VISION_MODEL: "modelo-visao-1",
      AI_API_KEY: "segredo",
    });
    expect(config.provider).toBe("openai-compatible");
    expect(config.baseUrl).toBe("https://api.exemplo.com/v1");
    expect(config.apiBaseUrl).toBe("https://api.exemplo.com/v1");
    expect(config.model).toBe("modelo-1");
    expect(config.visionModel).toBe("modelo-visao-1");
    expect(config.apiKey).toBe("segredo");
  });

  it("acrescenta /v1 quando a API compatível informa apenas a raiz", () => {
    const config = aiConfig({ AI_BASE_URL: "https://api.exemplo.com" });
    expect(config.apiBaseUrl).toBe("https://api.exemplo.com/v1");
  });

  it("mantém compatibilidade com OLLAMA_* e remove /v1 da raiz", () => {
    const config = aiConfig({
      OLLAMA_BASE_URL: "http://127.0.0.1:11434/v1/",
      OLLAMA_MODEL: "llama3:8b",
      OLLAMA_API_KEY: "ollama",
    });
    expect(config.provider).toBe("ollama");
    expect(config.baseUrl).toBe("http://127.0.0.1:11434");
    expect(config.apiBaseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(normalizeOllamaBaseUrl("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434");
  });

  it("normaliza barras sem apagar /v1 de provedor externo", () => {
    expect(normalizeAIBaseUrl("https://api.exemplo.com/v1///", "openai-compatible")).toBe(
      "https://api.exemplo.com/v1",
    );
  });

  it("não expõe URL nem chave na configuração pública", () => {
    const value = publicAIConfig({
      AI_BASE_URL: "https://interno.exemplo/v1",
      AI_API_KEY: "chave-secreta",
      AI_MODEL: "modelo-1",
    });
    expect(JSON.stringify(value)).not.toContain("interno.exemplo");
    expect(JSON.stringify(value)).not.toContain("chave-secreta");
    expect(value).toEqual({
      configured: true,
      model: "modelo-1",
      timeoutMs: DEFAULT_AI_TIMEOUT_MS,
      provider: "openai-compatible",
    });
  });
});
