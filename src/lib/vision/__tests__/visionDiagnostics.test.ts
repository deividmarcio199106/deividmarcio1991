import { describe, expect, it } from "vitest";

import {
  buildVisionDiagnostics,
  candlesComeFromTracker,
  PIPELINE_NAME,
  SOURCE_OF_TRUTH,
  type DiagnosticsInput,
} from "../visionDiagnostics";
import { EMPTY_TRACKER, MIN_CANDLES_FOR_ANALYSIS, type TrackerState } from "../chartTracker";
import { EMPTY_LIVENESS, type LivenessState } from "../streamLiveness";
import { EMPTY_STATE } from "../visualMarketState";
import { IDLE_OPERATION } from "@/lib/t4/preEntry";
import { newTimeline, markStage } from "@/lib/t4/leadTime";

const T0 = Date.UTC(2026, 2, 13, 13, 0, 0);

function liveness(overrides: Partial<LivenessState> = {}): LivenessState {
  return {
    ...EMPTY_LIVENESS,
    stream: "ACTIVE",
    visual: "MOVING",
    framesReceived: 50,
    lastFrameAt: T0,
    ...overrides,
  };
}

function tracker(overrides: Partial<TrackerState> = {}): TrackerState {
  return {
    ...EMPTY_TRACKER,
    candlesVisible: 30,
    candlesParsed: 30,
    closedCandlesAccepted: 30,
    bootstrapRequired: 0,
    marketDate: "2026-03-13",
    ...overrides,
  };
}

function input(overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    requested: true,
    liveness: liveness(),
    tracker: tracker(),
    visual: EMPTY_STATE,
    operation: IDLE_OPERATION,
    analysis: null,
    ...overrides,
  };
}

describe("fonte única de verdade", () => {
  it("identifica o motor que produziu os números", () => {
    const d = buildVisionDiagnostics(input());
    expect(d.pipeline).toBe(PIPELINE_NAME);
    expect(d.sourceOfTruth).toBe(SOURCE_OF_TRUTH);
  });

  it("todos os números de candle vêm do ChartTracker", () => {
    // Asserção viva: se alguém religar o CandleReconstructor ao caminho visual,
    // as contagens deixam de bater e o teste falha — em vez de a UI mentir.
    const t = tracker({ candlesVisible: 17, candlesParsed: 15, closedCandlesAccepted: 15 });
    const d = buildVisionDiagnostics(input({ tracker: t }));
    expect(candlesComeFromTracker(d, t)).toBe(true);
    expect(d.candlesVisible).toBe(17);
    expect(d.candlesParsed).toBe(15);
  });

  it("PREGÃO vem do gráfico e nunca cai na data de hoje", () => {
    expect(buildVisionDiagnostics(input()).marketDate).toBe("2026-03-13");

    const semData = buildVisionDiagnostics(input({ tracker: tracker({ marketDate: null }) }));
    expect(semData.marketDate).toBeNull();
    expect(semData.dateTrusted).toBe(false);
  });

  it("captura viva com gráfico parado não é falha", () => {
    const d = buildVisionDiagnostics(
      input({ liveness: liveness({ visual: "STATIC", staticForMs: 8_000 }) }),
    );
    expect(d.captureActive).toBe(true);
    expect(d.pixelsChanging).toBe(false);
    expect(d.captureLabel).toBe("ATIVA");
    expect(d.chartLabel).toBe("ESTÁTICO");
  });
});

describe("a manchete aponta o problema certo", () => {
  it("captura encerrada vem antes de qualquer outra queixa", () => {
    // Anunciar "preço não confiável" com a captura parada mandaria o operador
    // consertar a coisa errada.
    const d = buildVisionDiagnostics(
      input({
        liveness: liveness({ stream: "ENDED" }),
        tracker: tracker({ candlesVisible: 0, candlesParsed: 0 }),
      }),
    );
    expect(d.headline).toContain("captura foi encerrada");
  });

  it("nenhuma coluna encontrada culpa zoom e tema, não o mercado", () => {
    const d = buildVisionDiagnostics(
      input({ tracker: tracker({ candlesVisible: 0, candlesParsed: 0 }) }),
    );
    expect(d.headline).toContain("zoom");
  });

  it("candles visíveis sem aproveitamento mostra o motivo real", () => {
    const d = buildVisionDiagnostics(
      input({
        tracker: tracker({
          candlesVisible: 20,
          candlesParsed: 0,
          rejectReason: "candle com OHLC inconsistente no frame",
        }),
      }),
    );
    expect(d.headline).toContain("OHLC inconsistente");
  });

  it("bootstrap mostra progresso em vez de só AGUARDANDO", () => {
    const d = buildVisionDiagnostics(
      input({ tracker: tracker({ closedCandlesAccepted: 9, bootstrapRequired: 15 }) }),
    );
    expect(d.bootstrapProgress).toBe(9);
    expect(d.headline).toContain(`9/${MIN_CANDLES_FOR_ANALYSIS}`);
  });

  it("com tudo andando não há manchete", () => {
    expect(buildVisionDiagnostics(input()).headline).toBeNull();
  });

  it("sessão não iniciada não reclama de nada", () => {
    expect(buildVisionDiagnostics(input({ requested: false })).headline).toBeNull();
  });
});

describe("antecedência", () => {
  it("expõe os instantes e o lead time do setup", () => {
    let timeline = newTimeline("s1", "COMPRA");
    timeline = markStage(timeline, {
      stage: "PREPARANDO_COMPRA",
      marketTime: T0 + 120_000,
      zone: null,
      stop: null,
      pendingTrigger: null,
      blockReason: null,
    });
    timeline = markStage(timeline, {
      stage: "ENTRADA_CONFIRMADA",
      marketTime: T0 + 300_000,
      zone: null,
      stop: null,
      pendingTrigger: null,
      blockReason: null,
    });

    const d = buildVisionDiagnostics(input({ timeline }));
    expect(d.preEntryTime).toBe(T0 + 120_000);
    expect(d.confirmationTime).toBe(T0 + 300_000);
    expect(d.preEntryLeadTimeMs).toBe(180_000);
  });

  it("sem setup não há lead time — nulo, não zero", () => {
    const d = buildVisionDiagnostics(input());
    expect(d.preEntryLeadTimeMs).toBeNull();
    expect(d.candidateTime).toBeNull();
  });
});
