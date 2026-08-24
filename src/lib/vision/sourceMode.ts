/**
 * AO VIVO OU REPLAY — a pergunta que decide se a data pode vir do relógio.
 *
 * O BUG QUE ISSO IMPEDE: num Replay de 13/03 rodando em 11/08, `Date.now()`
 * carimbava 11/08 em toda a série, nos marcos do setup e no que fosse gravado.
 * Um Golden inteiro com a data de hoje não prova nada sobre 13/03 — e o pior é
 * que ele PARECE provar.
 *
 * A regra, então, depende do modo:
 *
 *   LIVE    o pregão é agora. O relógio do sistema é uma referência legítima,
 *           e a data de hoje na tela está CORRETA.
 *   REPLAY  a data e a hora vêm do gráfico do Profit, e de mais lugar nenhum.
 *           Sem leitura do eixo, o carimbo é `null` e viaja como NÃO CONFIÁVEL.
 *
 * `Date.now()` continua existindo para telemetria e latência — medir quanto o
 * OCR demorou é uma pergunta sobre o software, não sobre o mercado. O que ele
 * nunca mais faz é virar data de mercado por omissão.
 */

export type SourceMode = "LIVE" | "REPLAY";

export const SOURCE_MODES: SourceMode[] = ["LIVE", "REPLAY"];

export const SOURCE_MODE_LABEL: Record<SourceMode, string> = {
  LIVE: "AO VIVO",
  REPLAY: "REPLAY",
};

const STORAGE_KEY = "t4.sourceMode";

export function readSourceMode(): SourceMode {
  if (typeof localStorage === "undefined") return "LIVE";
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "REPLAY" ? "REPLAY" : "LIVE";
}

export function writeSourceMode(mode: SourceMode): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, mode);
}

export interface MarketStamp {
  /** Instante de mercado, ou null quando não pôde ser lido com confiança. */
  at: number | null;
  trusted: boolean;
  source: "relógio do sistema (ao vivo)" | "eixo do gráfico" | "não lido";
}

/**
 * Instante de mercado do momento.
 *
 * Em REPLAY, sem leitura do eixo, a resposta é `null` — nunca o relógio local.
 * Devolver "agora" seria inventar uma data, e uma data inventada contamina
 * candles, marcos do setup, registros e o Golden inteiro.
 */
export function marketStamp(
  mode: SourceMode,
  chartTime: number | null,
  systemNow: number,
): MarketStamp {
  if (chartTime !== null) {
    return { at: chartTime, trusted: true, source: "eixo do gráfico" };
  }
  if (mode === "LIVE") {
    // Ao vivo o pregão É agora: o relógio do sistema não é palpite.
    return { at: systemNow, trusted: true, source: "relógio do sistema (ao vivo)" };
  }
  return { at: null, trusted: false, source: "não lido" };
}

/** `2026-03-13` do instante de mercado, ou null quando não é confiável. */
export function marketDateOf(stamp: MarketStamp): string | null {
  if (!stamp.trusted || stamp.at === null) return null;
  const date = new Date(stamp.at);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}
