import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { aiBreaker } from "@/services/ai";
import { handleHealthRequest } from "./healthEndpoints";

const saved = {
  ai: process.env["AI_BASE_URL"],
  ollama: process.env["OLLAMA_BASE_URL"],
};

beforeEach(() => {
  delete process.env["AI_BASE_URL"];
  delete process.env["OLLAMA_BASE_URL"];
  aiBreaker.reset();
});

afterEach(() => {
  if (saved.ai === undefined) delete process.env["AI_BASE_URL"];
  else process.env["AI_BASE_URL"] = saved.ai;
  if (saved.ollama === undefined) delete process.env["OLLAMA_BASE_URL"];
  else process.env["OLLAMA_BASE_URL"] = saved.ollama;
});

function request(path: string, method = "GET") {
  return handleHealthRequest(new Request(`https://exemplo.com${path}`, { method }));
}

describe("health endpoints", () => {
  it("ignora rotas normais e recusa método inválido", async () => {
    expect(await request("/operacao-ao-vivo")).toBeNull();
    expect((await request("/api/health", "POST"))?.status).toBe(405);
  });

  it("responde JSON sem cache", async () => {
    const response = await request("/api/health");
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toContain("application/json");
    expect(response?.headers.get("cache-control")).toContain("no-store");
  });

  it("mantém o analisador saudável quando a IA opcional está desligada", async () => {
    const body = (await (await request("/api/health"))!.json()) as {
      status: string;
      analyzer: { status: string };
      ai: { status: string };
    };
    expect(body).toMatchObject({
      status: "ok",
      analyzer: { status: "ok" },
      ai: { status: "desligado" },
    });
  });

  it("expõe /ai e mantém /ollama como alias legado", async () => {
    const ai = (await (await request("/api/health/ai"))!.json()) as { status: string };
    const legacy = (await (await request("/api/health/ollama"))!.json()) as { status: string };
    expect(ai.status).toBe("desligado");
    expect(legacy.status).toBe(ai.status);
  });

  it("aceita /api/ai/health (caminho validado no runbook de deploy) como alias do check de IA", async () => {
    const runbook = (await (await request("/api/ai/health"))!.json()) as { status: string };
    const canonical = (await (await request("/api/health/ai"))!.json()) as { status: string };
    expect(runbook.status).toBe(canonical.status);
  });
});
