import { afterEach, describe, expect, it, vi } from "vitest";

import { aiBreaker } from "./gateway";
import { readPriceScaleWithVision, selectBestScalePair } from "./vision";

const savedEnv = {
  provider: process.env["AI_PROVIDER"],
  baseUrl: process.env["AI_BASE_URL"],
  visionModel: process.env["AI_VISION_MODEL"],
  ollamaBaseUrl: process.env["OLLAMA_BASE_URL"],
  ollamaVisionModel: process.env["OLLAMA_VISION_MODEL"],
};

afterEach(() => {
  vi.unstubAllGlobals();
  aiBreaker.reset();
  for (const [key, value] of Object.entries(savedEnv)) {
    const envKey =
      key === "provider"
        ? "AI_PROVIDER"
        : key === "baseUrl"
          ? "AI_BASE_URL"
          : key === "visionModel"
            ? "AI_VISION_MODEL"
            : key === "ollamaBaseUrl"
              ? "OLLAMA_BASE_URL"
              : "OLLAMA_VISION_MODEL";
    if (value === undefined) delete process.env[envKey];
    else process.env[envKey] = value;
  }
});

describe("seleção automática da escala", () => {
  it("preserva TODAS as âncoras consistentes para validar linearidade (3+ pontos)", () => {
    const anchors = selectBestScalePair(
      [
        { raw: "139.000", price: 139000, yPercent: 10, confidence: 0.95 },
        { raw: "138.500", price: 138500, yPercent: 50, confidence: 0.92 },
        { raw: "138.000", price: 138000, yPercent: 90, confidence: 0.94 },
      ],
      1000,
    );
    expect(anchors).toHaveLength(3);
    expect(anchors[0]).toMatchObject({ y: 100, price: 139000, source: "ocr" });
    expect(anchors[1]).toMatchObject({ y: 500, price: 138500, source: "ocr" });
    expect(anchors[2]).toMatchObject({ y: 900, price: 138000, source: "ocr" });
  });

  it("descarta rótulo intruso (indicador/horário) que quebra a monotonicidade", () => {
    const anchors = selectBestScalePair(
      [
        { raw: "139.000", price: 139000, yPercent: 10, confidence: 0.95 },
        { raw: "14", price: 14, yPercent: 40, confidence: 0.9 }, // ex.: valor de RSI lido por engano
        { raw: "138.500", price: 138500, yPercent: 50, confidence: 0.92 },
        { raw: "138.000", price: 138000, yPercent: 90, confidence: 0.94 },
      ],
      1000,
    );
    expect(anchors.map((anchor) => anchor.price)).toEqual([139000, 138500, 138000]);
  });

  it("rejeita escala invertida, próxima ou de baixa confiança", () => {
    expect(
      selectBestScalePair(
        [
          { raw: "100", price: 100, yPercent: 10, confidence: 0.9 },
          { raw: "101", price: 101, yPercent: 90, confidence: 0.9 },
        ],
        500,
      ),
    ).toEqual([]);
    expect(
      selectBestScalePair(
        [
          { raw: "101", price: 101, yPercent: 10, confidence: 0.6 },
          { raw: "100", price: 100, yPercent: 20, confidence: 0.9 },
        ],
        500,
      ),
    ).toEqual([]);
  });

  it("envia a imagem ao Ollama e converte a resposta validada em âncoras", async () => {
    process.env["AI_PROVIDER"] = "ollama";
    process.env["AI_BASE_URL"] = "http://127.0.0.1:11434";
    process.env["OLLAMA_BASE_URL"] = "http://127.0.0.1:11434";
    process.env["AI_VISION_MODEL"] = "qwen3.5:35b";
    process.env["OLLAMA_VISION_MODEL"] = "qwen3.5:35b";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              message: {
                content: JSON.stringify({
                  labels: [
                    { raw: "139.000", price: 139000, yPercent: 10, confidence: 0.95 },
                    { raw: "138.000", price: 138000, yPercent: 90, confidence: 0.94 },
                  ],
                  linearScale: true,
                }),
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const result = await readPriceScaleWithVision(
      `data:image/jpeg;base64,${"a".repeat(200)}`,
      1000,
    );
    expect(result.error).toBeNull();
    expect(result.model).toBe("qwen3.5:35b");
    expect(result.anchors.map((anchor) => anchor.price)).toEqual([139000, 138000]);
  });
});
