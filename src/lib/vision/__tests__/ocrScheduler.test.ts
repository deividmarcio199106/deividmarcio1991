import { describe, expect, it } from "vitest";

import {
  backoffFor,
  canDispatch,
  dispatch,
  EMPTY_OCR_STATE,
  expire,
  ocrStatus,
  OCR_CONFIG,
  resolve,
  shouldRequest,
  type OcrRequest,
} from "../ocrScheduler";

const T0 = 1_000_000;

function request(overrides: Partial<OcrRequest> = {}): OcrRequest {
  return {
    kind: "PRICE_SCALE",
    requestId: "r1",
    captureRevision: 7,
    sessionId: "s1",
    videoTimestamp: null,
    sentAt: T0,
    ...overrides,
  };
}

describe("agendamento do OCR", () => {
  it("um pedido por tipo de cada vez", () => {
    // Enfileirar recortes so produziria respostas velhas em sequencia.
    const state = dispatch(EMPTY_OCR_STATE, request());
    expect(canDispatch(state, "PRICE_SCALE", T0 + 1000)).toBe(false);
    expect(canDispatch(state, "CLOCK", T0 + 1000)).toBe(true);
  });

  it("pedido preso além do timeout libera a vaga", () => {
    const state = dispatch(EMPTY_OCR_STATE, request());
    expect(canDispatch(state, "PRICE_SCALE", T0 + OCR_CONFIG.timeoutMs + 1)).toBe(true);
  });

  it("primeira leitura acontece imediatamente", () => {
    expect(
      shouldRequest(EMPTY_OCR_STATE, "PRICE_SCALE", T0, {
        geometryChanged: false,
        confidenceLow: false,
      }),
    ).toBe(true);
  });

  it("mudança de geometria fura o intervalo de rotina", () => {
    // Zoom ou arraste invalida a escala AGORA; esperar o proximo ciclo deixaria
    // preco errado na tela nesse meio-tempo.
    const state = { ...EMPTY_OCR_STATE, lastSuccessAt: { PRICE_SCALE: T0, CLOCK: null } };
    expect(
      shouldRequest(state, "PRICE_SCALE", T0 + 1000, {
        geometryChanged: true,
        confidenceLow: false,
      }),
    ).toBe(true);
    expect(
      shouldRequest(state, "PRICE_SCALE", T0 + 1000, {
        geometryChanged: false,
        confidenceLow: false,
      }),
    ).toBe(false);
  });

  it("confiança baixa também dispara releitura", () => {
    const state = { ...EMPTY_OCR_STATE, lastSuccessAt: { PRICE_SCALE: T0, CLOCK: null } };
    expect(
      shouldRequest(state, "PRICE_SCALE", T0 + 1000, {
        geometryChanged: false,
        confidenceLow: true,
      }),
    ).toBe(true);
  });

  it("relê por rotina quando o intervalo passa", () => {
    const state = { ...EMPTY_OCR_STATE, lastSuccessAt: { PRICE_SCALE: T0, CLOCK: null } };
    const depois = T0 + OCR_CONFIG.priceRefreshMs + 1;
    expect(
      shouldRequest(state, "PRICE_SCALE", depois, { geometryChanged: false, confidenceLow: false }),
    ).toBe(true);
  });

  it("recua depois de falhas seguidas em vez de martelar", () => {
    expect(backoffFor(0)).toBe(0);
    expect(backoffFor(1)).toBe(OCR_CONFIG.backoffBaseMs);
    expect(backoffFor(3)).toBeGreaterThan(backoffFor(1));
    expect(backoffFor(50)).toBe(OCR_CONFIG.maxBackoffMs);

    const comFalhas = {
      ...EMPTY_OCR_STATE,
      failures: { PRICE_SCALE: 2, CLOCK: 0 },
      lastSuccessAt: { PRICE_SCALE: T0, CLOCK: null },
    };
    expect(
      shouldRequest(comFalhas, "PRICE_SCALE", T0 + 1000, {
        geometryChanged: true,
        confidenceLow: false,
      }),
    ).toBe(false);
  });
});

describe("destino da resposta", () => {
  it("resposta coerente é aplicada", () => {
    const state = dispatch(EMPTY_OCR_STATE, request());
    const { outcome, state: next } = resolve(
      state,
      { kind: "PRICE_SCALE", requestId: "r1", captureRevision: 7, ok: true },
      7,
      T0 + 900,
    );
    expect(outcome).toBe("APLICADA");
    expect(next.lastLatencyMs.PRICE_SCALE).toBe(900);
    expect(next.appliedRevision.PRICE_SCALE).toBe(7);
    expect(next.failures.PRICE_SCALE).toBe(0);
  });

  it("geometria mudou durante o pensamento: resposta DESCARTADA", () => {
    // Aplicar seria calibrar com uma tela que nao existe mais — precos
    // plausiveis e errados, o pior resultado possivel.
    const state = dispatch(EMPTY_OCR_STATE, request());
    const { outcome, state: next } = resolve(
      state,
      { kind: "PRICE_SCALE", requestId: "r1", captureRevision: 7, ok: true },
      9,
      T0 + 900,
    );
    expect(outcome).toBe("DESCARTADA_OBSOLETA");
    expect(next.appliedRevision.PRICE_SCALE).toBeNull();
  });

  it("resposta de pedido antigo perde a corrida", () => {
    const state = dispatch(EMPTY_OCR_STATE, request({ requestId: "r2" }));
    const { outcome } = resolve(
      state,
      { kind: "PRICE_SCALE", requestId: "r1", captureRevision: 7, ok: true },
      7,
      T0 + 900,
    );
    expect(outcome).toBe("DESCARTADA_TARDIA");
  });

  it("as três formas de inutilidade são distinguidas, não viram tudo ERRO", () => {
    const state = dispatch(EMPTY_OCR_STATE, request());
    const lenta = resolve(
      state,
      { kind: "PRICE_SCALE", requestId: "r1", captureRevision: 7, ok: true },
      7,
      T0 + OCR_CONFIG.timeoutMs + 1,
    );
    expect(lenta.outcome).toBe("TIMEOUT");

    const erro = resolve(
      state,
      { kind: "PRICE_SCALE", requestId: "r1", captureRevision: 7, ok: false },
      7,
      T0 + 500,
    );
    expect(erro.outcome).toBe("ERRO");
    // Tratar cadencia como erro do modelo esconderia o problema real.
    expect(erro.outcome).not.toBe(lenta.outcome);
  });

  it("pedido que nunca volta expira por tempo", () => {
    const state = dispatch(EMPTY_OCR_STATE, request());
    const depois = expire(state, T0 + OCR_CONFIG.timeoutMs + 1);
    expect(depois.inFlight.PRICE_SCALE).toBeNull();
    expect(depois.lastOutcome.PRICE_SCALE).toBe("TIMEOUT");
    expect(depois.failures.PRICE_SCALE).toBe(1);
  });

  it("expiração não mexe em pedido ainda dentro do prazo", () => {
    const state = dispatch(EMPTY_OCR_STATE, request());
    expect(expire(state, T0 + 1000).inFlight.PRICE_SCALE).not.toBeNull();
  });
});

describe("estado para o painel", () => {
  it("ONLINE exige sucesso recente, não apenas ausência de erro", () => {
    const semNada = ocrStatus(EMPTY_OCR_STATE, "PRICE_SCALE", T0);
    expect(semNada).toBe("LENTO");

    const comSucesso = { ...EMPTY_OCR_STATE, lastSuccessAt: { PRICE_SCALE: T0, CLOCK: null } };
    expect(ocrStatus(comSucesso, "PRICE_SCALE", T0 + 1000)).toBe("ONLINE");
  });

  it("sucesso velho demais vira OFFLINE", () => {
    const state = { ...EMPTY_OCR_STATE, lastSuccessAt: { PRICE_SCALE: T0, CLOCK: null } };
    const muitoDepois = T0 + OCR_CONFIG.priceRefreshMs * 4;
    expect(ocrStatus(state, "PRICE_SCALE", muitoDepois)).toBe("OFFLINE");
  });

  it("falha sem nenhum sucesso é OFFLINE", () => {
    const state = { ...EMPTY_OCR_STATE, failures: { PRICE_SCALE: 3, CLOCK: 0 } };
    expect(ocrStatus(state, "PRICE_SCALE", T0)).toBe("OFFLINE");
  });
});
