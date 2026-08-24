import type { ChartClockRead } from "./chartClock";

export type MarketClockSource = "CHART_CLOCK" | "REALTIME_FALLBACK";

export interface MarketClockState {
  source: MarketClockSource;
  /** Motivo registrado quando o fallback realtime está ativo. */
  fallbackReason: string | null;
  /** Última leitura confiável (HH:mm) do relógio do gráfico. */
  chartTime: string | null;
  /** Data (yyyy-mm-dd) da última leitura confiável, quando visível. */
  chartDate: string | null;
  /** Epoch ms correspondente ao relógio do gráfico no instante da leitura. */
  chartEpochAtRead: number | null;
  /** Date.now() no instante da leitura confiável. */
  readAtLocal: number | null;
  confidence: number;
}

const MIN_CONFIDENCE = 0.6;
/** Leitura mais velha que isso volta ao fallback com motivo explícito. */
const MAX_READ_AGE_MS = 3 * 60_000;

/**
 * MARKET CLOCK — o tempo oficial dos candles vem do RELÓGIO DO GRÁFICO.
 *
 * Quando o chartClock (OCR da faixa de tempo do Profit) é válido,
 * marketTime = chartClock: os candles do Profit/replay são bucketizados pelo
 * horário do GRÁFICO, nunca por Date.now(). Entre leituras, o relógio avança
 * com o delta local (a leitura OCR tem precisão de minuto).
 *
 * Replay 1x/2x/5x/10x: o horário do gráfico anda mais rápido que o relógio de
 * parede; como o bucket vem do gráfico, os candles fecham no ritmo do replay
 * sem esperar 1 minuto real.
 *
 * Fallback realtime SOMENTE quando o chartClock está indisponível — e o motivo
 * fica registrado em `fallbackReason` (exposto no diagnóstico).
 */
export class MarketClock {
  private state: MarketClockState = {
    source: "REALTIME_FALLBACK",
    fallbackReason: "chartClock ainda não lido no gráfico.",
    chartTime: null,
    chartDate: null,
    chartEpochAtRead: null,
    readAtLocal: null,
    confidence: 0,
  };
  /** Garante monotonicidade: uma correção de OCR nunca volta o tempo. */
  private lastEmitted = 0;
  private lastSource: MarketClockSource | null = null;

  update(read: ChartClockRead | null, atLocal: number): void {
    if (!read || read.confidence < MIN_CONFIDENCE || !read.time) {
      // Não derruba uma leitura recente por causa de UM frame ilegível; o
      // envelhecimento é tratado em now().
      if (!this.state.chartTime) {
        this.state = {
          ...this.state,
          source: "REALTIME_FALLBACK",
          fallbackReason: read
            ? `chartClock ilegível (confiança ${Math.round((read.confidence ?? 0) * 100)}%).`
            : "chartClock indisponível.",
        };
      }
      return;
    }
    const [hourRaw, minuteRaw] = read.time.split(":");
    const hour = Number(hourRaw);
    const minute = Number(minuteRaw);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return;

    const base = new Date(atLocal);
    if (read.date) {
      const [year, month, day] = read.date.split("-").map(Number);
      /*
       * DATA ILEGÍVEL NÃO ENVENENA O RELÓGIO — derrubou produção uma vez.
       *
       * Em 20/08/2026 um `read.date` no formato brasileiro ("20/08/2026")
       * chegou aqui: o `split("-")` devolveu um elemento só, `Number` deu NaN,
       * `setFullYear(NaN)` transformou `base` em Invalid Date e
       * `chartEpochAtRead` virou NaN. Quem formatava esse instante lançava
       * `RangeError: Invalid time value` e a análise inteira morria.
       *
       * A data é OPCIONAL para o relógio funcionar — hora e minuto bastam para
       * identificar o candle dentro do pregão. Então data ruim é ignorada, e a
       * leitura continua valendo pelo horário. Quem normaliza formato é
       * `normalizeDate`; aqui a regra é só não propagar lixo.
       */
      if ([year, month, day].every((v) => Number.isFinite(v))) {
        base.setFullYear(year!, month! - 1, day!);
      }
    }
    base.setHours(hour, minute, 0, 0);

    /*
     * E a última porta: nada entra no estado sem ser um instante real. Sem
     * isto, qualquer caminho futuro que produza Invalid Date volta a derrubar
     * o consumidor em vez de degradar para o fallback declarado.
     */
    if (!Number.isFinite(base.getTime())) {
      if (!this.state.chartTime) {
        this.state = {
          ...this.state,
          source: "REALTIME_FALLBACK",
          fallbackReason: `chartClock com data/hora inválidas ("${read.date ?? "sem data"} ${read.time}").`,
        };
      }
      return;
    }

    this.state = {
      source: "CHART_CLOCK",
      fallbackReason: null,
      chartTime: read.time,
      chartDate: read.date,
      chartEpochAtRead: base.getTime(),
      readAtLocal: atLocal,
      confidence: read.confidence,
    };
  }

  /**
   * Epoch ms oficial do mercado. CHART_CLOCK quando válido; caso contrário,
   * fallback realtime com motivo registrado.
   */
  now(localNow = Date.now()): { t: number; source: MarketClockSource } {
    let t: number;
    let source: MarketClockSource;
    const { chartEpochAtRead, readAtLocal } = this.state;
    const fresh =
      chartEpochAtRead !== null &&
      readAtLocal !== null &&
      localNow - readAtLocal <= MAX_READ_AGE_MS;
    if (fresh) {
      t = chartEpochAtRead! + (localNow - readAtLocal!);
      source = "CHART_CLOCK";
    } else {
      if (chartEpochAtRead !== null && this.state.source === "CHART_CLOCK") {
        this.state = {
          ...this.state,
          source: "REALTIME_FALLBACK",
          fallbackReason: "chartClock envelheceu sem nova leitura legível.",
        };
      }
      t = localNow;
      source = "REALTIME_FALLBACK";
    }
    // Monotônico DENTRO da mesma fonte: correções de OCR nunca retrocedem
    // candles já ordenados. Uma TROCA de fonte (fallback→chartClock ou
    // vice-versa) é uma descontinuidade legítima de linha do tempo — sem isso,
    // o Date.now() do fallback "envenenava" o clamp e um replay de dia
    // histórico (gráfico atrás do relógio local) ficava congelado para sempre.
    if (source === this.lastSource && t < this.lastEmitted) t = this.lastEmitted;
    this.lastSource = source;
    this.lastEmitted = t;
    return { t, source };
  }

  snapshot(): MarketClockState {
    return this.state;
  }

  valid(localNow = Date.now()): boolean {
    return (
      this.state.chartEpochAtRead !== null &&
      this.state.readAtLocal !== null &&
      localNow - this.state.readAtLocal <= MAX_READ_AGE_MS
    );
  }

  reset(): void {
    this.state = {
      source: "REALTIME_FALLBACK",
      fallbackReason: "chartClock ainda não lido no gráfico.",
      chartTime: null,
      chartDate: null,
      chartEpochAtRead: null,
      readAtLocal: null,
      confidence: 0,
    };
    this.lastEmitted = 0;
    this.lastSource = null;
  }
}
