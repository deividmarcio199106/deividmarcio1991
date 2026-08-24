import { describe, expect, it } from "vitest";

import { PriceScaleSession, type ScaleOcrResponse } from "../priceScaleSession";
import { scaleReject, EMPTY_AUDIT } from "../scaleReject";
import type { Geometry } from "../geometryHash";
import type { ScaleAnchor } from "../priceScale";

const GEOMETRY: Geometry = {
  frameWidth: 1920,
  frameHeight: 1080,
  roi: { x: 0.02, y: 0.05, width: 0.9, height: 0.8, confidence: 90, detail: "plot" },
  priceAxisFrom: 0.9,
  symbol: "WINFUT",
};

/** Escala WIN plausível e perfeitamente linear: 3 âncoras, R² 1. */
function anchors(): ScaleAnchor[] {
  return [
    { y: 100, price: 139_000, raw: "139.000", source: "ocr", confidence: 0.95 },
    { y: 500, price: 138_500, raw: "138.500", source: "ocr", confidence: 0.95 },
    { y: 900, price: 138_000, raw: "138.000", source: "ocr", confidence: 0.95 },
  ];
}

function response(over: Partial<ScaleOcrResponse> = {}): ScaleOcrResponse {
  return {
    anchors: anchors(),
    model: "qwen3.5:4b",
    error: null,
    reject: null,
    audit: EMPTY_AUDIT,
    revision: 1,
    sentAt: 1_000,
    ...over,
  };
}

describe("PriceScaleSession", () => {
  it("calibra e libera preço com 3 âncoras", () => {
    const session = new PriceScaleSession("sess-1", "WINFUT");
    session.observe(GEOMETRY, 1_000);
    const { revision, sentAt } = session.begin(1_000);
    const state = session.apply(response({ revision, sentAt }), 8_000);

    expect(state.scale.priceScaleReady).toBe(true);
    expect(state.scale.anchorCount).toBe(3);
    expect(state.reject).toBeNull();
    expect(state.lastLatencyMs).toBe(7_000);
  });

  it("geometria igual não pede nova leitura: CACHE HIT, zero GPU", () => {
    const session = new PriceScaleSession("sess-1", "WINFUT");
    session.observe(GEOMETRY, 1_000);
    const first = session.begin(1_000);
    session.apply(response({ revision: first.revision, sentAt: first.sentAt }), 8_000);

    // Meia hora depois, mesma janela: a reta continua valendo.
    session.observe(GEOMETRY, 1_800_000);
    expect(session.snapshot().attempts).toBe(1);
    expect(session.snapshot().scale.priceScaleReady).toBe(true);
    expect(session.shouldRequest(9_000)).toBe(false);
  });

  it("mesma geometria revisitada volta do cache sem chamar o modelo", () => {
    const session = new PriceScaleSession("sess-1", "WINFUT");
    session.observe(GEOMETRY, 1_000);
    const first = session.begin(1_000);
    session.apply(response({ revision: first.revision, sentAt: first.sentAt }), 8_000);

    // Operador dá zoom (nova geometria) e depois desfaz, voltando à anterior.
    session.observe({ ...GEOMETRY, frameHeight: 900 }, 20_000);
    expect(session.snapshot().scale.priceScaleReady).toBe(false);
    expect(session.snapshot().cache).toBe("MISS");

    const back = session.observe(GEOMETRY, 30_000);
    expect(back.cache).toBe("HIT");
    expect(back.scale.priceScaleReady).toBe(true);
    expect(session.snapshot().attempts).toBe(1);
  });

  it("zoom invalida a reta antiga em vez de aplicá-la à janela nova", () => {
    const session = new PriceScaleSession("sess-1", "WINFUT");
    session.observe(GEOMETRY, 1_000);
    const first = session.begin(1_000);
    session.apply(response({ revision: first.revision, sentAt: first.sentAt }), 8_000);

    const zoomed = session.observe({ ...GEOMETRY, priceAxisFrom: 0.8 }, 20_000);
    expect(zoomed.scale.priceScaleReady).toBe(false);
    expect(zoomed.revision).toBeGreaterThan(first.revision);
  });

  it("resposta de revisão antiga vira STALE_RESPONSE e não calibra", () => {
    const session = new PriceScaleSession("sess-1", "WINFUT");
    session.observe(GEOMETRY, 1_000);
    const sent = session.begin(1_000);
    // A janela muda enquanto o modelo pensa.
    session.observe({ ...GEOMETRY, frameWidth: 1600 }, 3_000);

    const state = session.apply(response({ revision: sent.revision, sentAt: sent.sentAt }), 9_000);
    expect(state.scale.priceScaleReady).toBe(false);
    expect(state.reject?.code).toBe("STALE_RESPONSE");
  });

  it("propaga o código de rejeição do OCR sem inventar outro", () => {
    const session = new PriceScaleSession("sess-1", "WINFUT");
    session.observe(GEOMETRY, 1_000);
    const sent = session.begin(1_000);
    const state = session.apply(
      response({
        revision: sent.revision,
        sentAt: sent.sentAt,
        anchors: [],
        reject: scaleReject("GPU_OFFLINE", "túnel fechado"),
      }),
      4_000,
    );

    expect(state.reject?.code).toBe("GPU_OFFLINE");
    expect(state.scale.priceScaleReady).toBe(false);
  });

  it("rótulo fora da faixa do contrato é BAD_TICK, não escala boa", () => {
    const session = new PriceScaleSession("sess-1", "WINFUT");
    session.observe(GEOMETRY, 1_000);
    const sent = session.begin(1_000);
    const state = session.apply(
      response({
        revision: sent.revision,
        sentAt: sent.sentAt,
        anchors: [
          { y: 100, price: 62, raw: "62", source: "ocr", confidence: 0.9 },
          { y: 500, price: 55, raw: "55", source: "ocr", confidence: 0.9 },
          { y: 900, price: 48, raw: "48", source: "ocr", confidence: 0.9 },
        ],
      }),
      6_000,
    );

    expect(state.reject?.code).toBe("BAD_TICK");
    expect(state.scale.priceScaleReady).toBe(false);
  });

  it("falha aplica backoff, e nunca desiste", () => {
    const session = new PriceScaleSession("sess-1", "WINFUT");
    session.observe(GEOMETRY, 1_000);
    const sent = session.begin(1_000);
    session.apply(
      response({
        revision: sent.revision,
        sentAt: sent.sentAt,
        anchors: [],
        reject: scaleReject("OCR_EMPTY"),
      }),
      4_000,
    );

    expect(session.shouldRequest(5_000)).toBe(false);
    expect(session.shouldRequest(1_000 + 6_000)).toBe(true);
  });

  it("nunca fica sem motivo: falhou, existe código", () => {
    const session = new PriceScaleSession("sess-1", "WINFUT");
    session.observe(GEOMETRY, 1_000);
    const sent = session.begin(1_000);
    const state = session.apply(
      response({
        revision: sent.revision,
        sentAt: sent.sentAt,
        // Duas âncoras coladas: reta passa pelas duas e não prova nada.
        anchors: [
          { y: 500, price: 138_500, raw: "138.500", source: "ocr", confidence: 0.95 },
          { y: 505, price: 138_495, raw: "138.495", source: "ocr", confidence: 0.95 },
        ],
      }),
      6_000,
    );

    expect(state.scale.priceScaleReady).toBe(false);
    expect(state.reject).not.toBeNull();
    expect(state.reject?.detail.length).toBeGreaterThan(0);
  });
});
