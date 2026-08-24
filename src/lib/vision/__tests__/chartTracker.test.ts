import { describe, expect, it } from "vitest";

import {
  ChartTracker,
  EMPTY_TRACKER,
  inspectSeries,
  marketDateLabel,
  MIN_CANDLES_FOR_ANALYSIS,
  regrid,
  UNTRUSTED_CLOCK,
  type MarketClock,
} from "../chartTracker";
import type { ExtractedCandle } from "@/lib/capture/frameProcessor";

/** 13/03/2026 10:30 — o pregão do Golden. */
const REPLAY = Date.UTC(2026, 2, 13, 13, 30, 0);
/** 11/08/2026 — o dia em que o replay foi assistido. */
const HOJE = Date.UTC(2026, 7, 11, 16, 0, 0);

function candles(count: number, base = 172000): ExtractedCandle[] {
  return Array.from({ length: count }, (_, i) => ({
    t: i * 60_000,
    o: base + i,
    h: base + i + 5,
    l: base + i - 5,
    c: base + i + 2,
    v: 0,
    quality: 80,
  }));
}

const RELOGIO_DO_GRAFICO: MarketClock = {
  marketDateTime: REPLAY,
  timeTrusted: true,
  dateTrusted: true,
};

describe("data do mercado vem do gráfico, não do sistema", () => {
  it("replay de 13/03 carimba 13/03, mesmo assistido em 11/08", () => {
    // O bug real do Golden: a serie inteira nascia com a data de HOJE, e com
    // ela candidateTime, preEntryTime e o banco. Um Golden carimbado com a data
    // errada nao prova nada sobre 13/03.
    const tracker = new ChartTracker();
    tracker.push(candles(30), HOJE, RELOGIO_DO_GRAFICO);
    const ultimo = tracker.window().at(-1)!;
    expect(new Date(ultimo.t).getUTCMonth()).toBe(2); // março
    expect(new Date(ultimo.t).getUTCDate()).toBe(13);
  });

  it("sem relógio confiável a série existe, mas a data não é afirmada", () => {
    const tracker = new ChartTracker();
    tracker.push(candles(30), HOJE, UNTRUSTED_CLOCK);
    // A estrutura continua legivel em grade relativa...
    expect(tracker.ready()).toBe(true);
    // ...mas ninguem pode dizer que aquilo e data de mercado.
    expect(tracker.snapshot().marketDate).toBeNull();
  });

  it("rótulo de data só existe com dateTrusted", () => {
    expect(marketDateLabel(RELOGIO_DO_GRAFICO)).toBe("2026-03-13");
    expect(marketDateLabel(UNTRUSTED_CLOCK)).toBeNull();
    expect(
      marketDateLabel({ marketDateTime: REPLAY, timeTrusted: true, dateTrusted: false }),
    ).toBeNull();
  });

  it("a grade termina no instante do gráfico e anda para trás de minuto em minuto", () => {
    const grade = regrid(candles(3), REPLAY);
    expect(grade[2]!.t).toBe(Math.floor(REPLAY / 60_000) * 60_000);
    expect(grade[1]!.t).toBe(grade[2]!.t - 60_000);
    expect(grade[0]!.t).toBe(grade[2]!.t - 120_000);
  });
});

describe("bootstrap a partir do que já está na tela", () => {
  it("30 candles visíveis em T0 liberam a análise na hora", () => {
    // Nao e lookahead: esses candles JA estavam desenhados quando a leitura
    // comecou. Esperar 14 minutos para reaprender o que esta na tela seria
    // desperdicio, nao rigor.
    const tracker = new ChartTracker();
    tracker.push(candles(30), HOJE, RELOGIO_DO_GRAFICO);
    expect(tracker.ready()).toBe(true);
    expect(tracker.snapshot().bootstrapRequired).toBe(0);
  });

  it("publica o progresso do bootstrap em vez de só dizer AGUARDANDO", () => {
    const tracker = new ChartTracker();
    tracker.push(candles(10), HOJE, RELOGIO_DO_GRAFICO);
    const state = tracker.snapshot();
    expect(state.closedCandlesAccepted).toBe(10);
    expect(state.bootstrapRequired).toBe(MIN_CANDLES_FOR_ANALYSIS - 10);
    expect(tracker.ready()).toBe(false);
  });

  it("expõe visíveis e parseados para diagnosticar o detector", () => {
    // Se a tela tem 20 candles e o parser ve 1, o problema e o detector — e o
    // diagnostico precisa mostrar essa diferenca.
    const tracker = new ChartTracker();
    tracker.push(candles(20), HOJE, RELOGIO_DO_GRAFICO);
    const state = tracker.snapshot();
    expect(state.candlesVisible).toBe(20);
    expect(state.candlesParsed).toBe(20);
  });

  it("recusa registra motivo e zera o parseado, nunca em silêncio", () => {
    const tracker = new ChartTracker();
    tracker.push([], HOJE, RELOGIO_DO_GRAFICO);
    const state = tracker.snapshot();
    expect(state.rejectReason).toContain("nenhum candle");
    expect(state.candlesParsed).toBe(0);
  });

  it("contagem implausível é recusada com o número no motivo", () => {
    expect(inspectSeries(candles(3))).toContain("implausível");
    expect(inspectSeries(candles(500))).toContain("implausível");
    expect(inspectSeries(candles(30))).toBeNull();
  });

  it("estado inicial não afirma nada", () => {
    expect(EMPTY_TRACKER.marketDate).toBeNull();
    expect(EMPTY_TRACKER.closedCandlesAccepted).toBe(0);
    expect(EMPTY_TRACKER.bootstrapRequired).toBe(MIN_CANDLES_FOR_ANALYSIS);
  });
});
