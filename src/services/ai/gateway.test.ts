import { describe, expect, it } from "vitest";

import { CircuitOpenError } from "./circuitBreaker";
import { describeAIError } from "./gateway";

describe("describeAIError", () => {
  const model = "modelo-1";
  const timeoutMs = 120_000;

  it("traduz circuito e timeout", () => {
    expect(describeAIError(new CircuitOpenError(30_000), model, timeoutMs)).toContain(
      "circuito aberto",
    );
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    expect(describeAIError(timeout, model, timeoutMs)).toContain("AI_TIMEOUT_MS");
  });

  it("orienta conexão, modelo e autenticação pelas variáveis genéricas", () => {
    expect(describeAIError(new Error("fetch failed"), model, timeoutMs)).toContain("AI_BASE_URL");
    expect(describeAIError(new Error("status 404"), model, timeoutMs)).toContain("AI_MODEL");
    expect(describeAIError(new Error("status 401"), model, timeoutMs)).toContain("AI_API_KEY");
  });

  it("remove host e porta das mensagens técnicas", () => {
    const message = describeAIError(
      new Error("request to http://10.0.0.7:11434/v1/chat/completions failed"),
      model,
      timeoutMs,
    );
    expect(message).not.toContain("10.0.0.7");
    expect(message).not.toContain("11434");
    expect(message).toContain("[servidor de IA]");
  });
});
