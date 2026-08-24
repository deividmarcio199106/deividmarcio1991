/**
 * Identificação de data/hora/ativo/timeframe do gráfico (comando §16).
 *
 * A IA visual lê a barra de informações do Profit e responde JSON; este módulo
 * faz o parse ESTRITO da resposta. Campo ilegível = UNKNOWN — nunca inventado.
 * Data reconhecida muda o rótulo do pregão; cada pregão vira unidade
 * independente de backtest.
 */

export interface ChartClockRead {
  /** ISO yyyy-mm-dd ou null quando UNKNOWN. */
  date: string | null;
  /** HH:mm ou null. */
  time: string | null;
  asset: string | null;
  timeframe: string | null;
  confidence: number; // 0..1
}

const DATE_BR = /(\d{2})[/.-](\d{2})[/.-](\d{4})/;
const DATE_ISO = /(\d{4})-(\d{2})-(\d{2})/;
const TIME_RE = /\b(\d{1,2}):(\d{2})(?::\d{2})?\b/;

/**
 * Normaliza data de gráfico para AAAA-MM-DD, aceitando o formato BRASILEIRO.
 *
 * EXPORTADA depois de 20/08/2026, quando o contrato do print ganhou seu próprio
 * campo de relógio e passou a montar data sem passar por aqui. O modelo lê
 * "20/08/2026" na barra de abas do Profit e devolve exatamente isso — pedir
 * ISO no prompt não impede. Sem esta normalização, o consumidor fazia
 * `"20/08/2026".split("-")` e obtinha NaN.
 */
export function normalizeDate(raw: string): string | null {
  const iso = DATE_ISO.exec(raw);
  if (iso) {
    const [, year, month, day] = iso;
    return validDate(Number(year), Number(month), Number(day));
  }
  const br = DATE_BR.exec(raw);
  if (br) {
    const [, day, month, year] = br;
    return validDate(Number(year), Number(month), Number(day));
  }
  return null;
}

function validDate(year: number, month: number, day: number): string | null {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

function normalizeTime(raw: string): string | null {
  const match = TIME_RE.exec(raw);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * Parse da resposta da IA (JSON com date/time/asset/timeframe/confidence).
 * Aceita "UNKNOWN"/"desconhecido"/vazio como null. Nunca lança: resposta
 * inválida devolve tudo UNKNOWN com confiança 0.
 */
export function parseChartClock(raw: string): ChartClockRead {
  const unknown: ChartClockRead = {
    date: null,
    time: null,
    asset: null,
    timeframe: null,
    confidence: 0,
  };
  const jsonMatch = /\{[\s\S]*\}/.exec(raw);
  if (!jsonMatch) return unknown;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch {
    return unknown;
  }
  const text = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed || /^unknown$/i.test(trimmed) || /^desconhecid/i.test(trimmed)) return null;
    return trimmed;
  };
  const confidenceRaw = payload["confidence"];
  const confidence =
    typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
      ? Math.max(0, Math.min(1, confidenceRaw))
      : 0;
  const dateText = text(payload["date"]);
  const timeText = text(payload["time"]);
  return {
    date: dateText ? normalizeDate(dateText) : null,
    time: timeText ? normalizeTime(timeText) : null,
    asset: text(payload["asset"])?.toUpperCase() ?? null,
    timeframe: text(payload["timeframe"]) ?? null,
    confidence,
  };
}

/** Rótulo do pregão para exibição: data reconhecida ou identificador honesto. */
export function tradingDayLabel(read: ChartClockRead | null, segmentIndex: number): string {
  if (read?.date) {
    const [year, month, day] = read.date.split("-");
    return `${day}/${month}/${year}`;
  }
  return `Trecho ${segmentIndex + 1} (data não reconhecida)`;
}

/**
 * Associa a cada segmento o rótulo de pregão da leitura mais próxima ANTERIOR
 * ao primeiro frame do segmento (ou a primeira leitura posterior, como
 * fallback). Sem leitura confiável, o rótulo é honesto: data não reconhecida.
 */
export function labelSegments(
  segmentStartFrames: number[],
  reads: { frameIndex: number; read: ChartClockRead }[],
  minConfidence = 0.6,
): string[] {
  const reliable = reads
    .filter((item) => item.read.confidence >= minConfidence && item.read.date)
    .sort((a, b) => a.frameIndex - b.frameIndex);
  return segmentStartFrames.map((startFrame, segmentIndex) => {
    let candidate: (typeof reliable)[number] | null = null;
    for (const item of reliable) {
      if (item.frameIndex <= startFrame) candidate = item;
      else break;
    }
    if (!candidate) candidate = reliable.find((item) => item.frameIndex > startFrame) ?? null;
    return tradingDayLabel(candidate?.read ?? null, segmentIndex);
  });
}
