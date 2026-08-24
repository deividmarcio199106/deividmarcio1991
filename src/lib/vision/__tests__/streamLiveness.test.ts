import { describe, expect, it } from "vitest";

import {
  checkTimeout,
  EMPTY_LIVENESS,
  isMoving,
  isUsable,
  observeFrame,
  readStreamHealth,
  SILENCE_WARNING_MS,
  streamLabel,
  visualLabel,
} from "../streamLiveness";
import type { FrameRead } from "@/lib/capture/frameProcessor";

const T0 = 1_000_000;

function frame(overrides: Partial<FrameRead> = {}): FrameRead {
  return {
    t: T0,
    priceY: 400,
    bullMass: 0.012,
    bearMass: 0.009,
    activity: 50,
    quality: 90,
    width: 1920,
    height: 1080,
    candleColumns: 60,
    candles: [],
    ...overrides,
  };
}

/** Move a imagem de verdade: duas mudanças seguidas confirmam MOVING. */
function mover(state = EMPTY_LIVENESS, from = T0) {
  let s = observeFrame(state, frame({ bullMass: 0.013 }), from);
  s = observeFrame(s, frame({ bullMass: 0.014 }), from + 100);
  return s;
}

describe("os dois eixos são independentes", () => {
  it("captura viva com gráfico parado é estado VÁLIDO", () => {
    // O bug do Golden: pixels iguais derrubavam a leitura e a T4 voltava para
    // AGUARDANDO DADO, apagando contexto correto.
    let state = mover();
    for (let i = 1; i <= 40; i += 1) {
      state = observeFrame(state, frame({ bullMass: 0.014 }), T0 + 200 + i * 500);
    }
    expect(state.stream).toBe("ACTIVE");
    expect(state.visual).toBe("STATIC");
    expect(isUsable(state)).toBe(true);
    expect(isMoving(state)).toBe(false);
  });

  it("ausência de frame NÃO mata o stream", () => {
    // O FrameProcessor descarta frame identico por hash: grafico parado
    // simplesmente nao gera FrameRead. Concluir "stream morto" dali era o erro.
    const state = mover();
    const depois = checkTimeout(state, T0 + 20_000, "ACTIVE");
    expect(depois.stream).toBe("ACTIVE");
    expect(isUsable(depois)).toBe(true);
    expect(depois.visual).toBe("STATIC");
  });

  it("silêncio longo vira AVISO, nunca interrupção", () => {
    const state = mover();
    const depois = checkTimeout(state, T0 + SILENCE_WARNING_MS + 1000, "ACTIVE");
    expect(isUsable(depois)).toBe(true);
    expect(depois.detail).toContain("sem frame novo");
  });

  it("só a track declara a captura encerrada", () => {
    const state = mover();
    const encerrado = checkTimeout(state, T0 + 1000, "ENDED");
    expect(encerrado.stream).toBe("ENDED");
    expect(isUsable(encerrado)).toBe(false);
    expect(encerrado.detail).toContain("encerrado");
  });

  it("lê a saúde direto da MediaStreamTrack", () => {
    expect(readStreamHealth({ readyState: "live" } as MediaStreamTrack)).toBe("ACTIVE");
    expect(readStreamHealth({ readyState: "ended" } as MediaStreamTrack)).toBe("ENDED");
    expect(readStreamHealth(null)).toBe("UNKNOWN");
  });
});

describe("histerese do movimento", () => {
  it("uma mudança isolada não declara MOVING", () => {
    // Sem isso o painel piscaria a cada frame com ruido.
    const state = observeFrame(EMPTY_LIVENESS, frame({ bullMass: 0.013 }), T0);
    expect(state.visual).not.toBe("MOVING");
  });

  it("duas mudanças seguidas confirmam MOVING", () => {
    expect(mover().visual).toBe("MOVING");
  });

  it("MOVING não cai no primeiro frame repetido", () => {
    let state = mover();
    state = observeFrame(state, frame({ bullMass: 0.014 }), T0 + 200);
    // Ainda dentro da janela de tolerancia: nao vira STATIC na hora.
    expect(state.visual).toBe("MOVING");
  });

  it("volta a MOVING quando a imagem muda de novo, sem reiniciar nada", () => {
    let state = mover();
    for (let i = 1; i <= 20; i += 1) {
      state = observeFrame(state, frame({ bullMass: 0.014 }), T0 + 200 + i * 500);
    }
    expect(state.visual).toBe("STATIC");

    const framesAntes = state.framesReceived;
    state = observeFrame(state, frame({ bullMass: 0.02 }), T0 + 12_000);
    state = observeFrame(state, frame({ bullMass: 0.021 }), T0 + 12_100);
    expect(state.visual).toBe("MOVING");
    // Continuidade preservada: nada foi reiniciado.
    expect(state.framesReceived).toBe(framesAntes + 2);
  });
});

describe("contadores e rótulos", () => {
  it("conta todos os frames recebidos, movendo ou não", () => {
    let state = mover();
    for (let i = 1; i <= 10; i += 1) {
      state = observeFrame(state, frame({ bullMass: 0.014 }), T0 + 200 + i * 500);
    }
    expect(state.framesReceived).toBe(12);
  });

  it("mede há quanto tempo os pixels estão idênticos", () => {
    let state = mover();
    state = observeFrame(state, frame({ bullMass: 0.014 }), T0 + 5_100);
    expect(state.staticForMs).toBeGreaterThanOrEqual(5_000);
  });

  it("rótulos separam captura de movimento", () => {
    const state = mover();
    expect(streamLabel(state)).toBe("ATIVA");
    expect(visualLabel(state)).toBe("EM MOVIMENTO");
    expect(streamLabel({ ...state, stream: "ENDED" })).toBe("ENCERRADA");
    expect(visualLabel({ ...state, visual: "STATIC" })).toBe("ESTÁTICO");
  });

  it("ruído de compressão não conta como movimento", () => {
    let state = mover();
    for (let i = 1; i <= 20; i += 1) {
      state = observeFrame(state, frame({ bullMass: 0.014 + i * 0.000001 }), T0 + 200 + i * 500);
    }
    expect(state.visual).toBe("STATIC");
  });
});
