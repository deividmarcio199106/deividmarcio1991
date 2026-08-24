import { describe, expect, it } from "vitest";

import type { Candle } from "@/lib/engines/types";
import { MIN_CLOSED_CANDLES } from "@/lib/t4/readingState";
import { runQuantBacktest, type QuantResult } from "../quantBacktest";

/**
 * O MOTOR QUANT NÃO PROMETE TRADE EM SÉRIE SINTÉTICA — promete honestidade
 * mecânica. Por isso NENHUM teste aqui afirma lucro, win rate ou quantidade
 * mínima de operações. O que se tranca é:
 *
 * 1. série sem setup ⇒ 0 trades SEM erro (o silêncio operacional é legítimo);
 * 2. determinismo: a mesma série produz exatamente o mesmo resultado;
 * 3. anti-look-ahead ESTRUTURAL: tudo que foi decidido/resolvido até o candle
 *    i é IDÊNTICO com a série truncada em i e com a série completa — e também
 *    com um futuro completamente diferente;
 * 4. janela menor que minWindow cai INTEIRA em discards, nunca em conclusão.
 */

const T0 = Date.UTC(2026, 2, 13, 13, 0, 0);
const MINUTO = 60_000;

/** Série lateral degenerada: oscilação fixa de ±10 pontos, sem estrutura. */
function lateral(n: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const sobe = i % 2 === 0;
    const abertura = 128_000 + (sobe ? -10 : 10);
    const fechamento = 128_000 + (sobe ? 10 : -10);
    out.push({
      t: T0 + i * MINUTO,
      o: abertura,
      h: Math.max(abertura, fechamento) + 5,
      l: Math.min(abertura, fechamento) - 5,
      c: fechamento,
      // A importação de candles pode não trazer volume; zero declarado.
      v: 0,
    });
  }
  return out;
}

/** Série pseudoaleatória determinística (LCG) — estrutura variada sem sorte. */
function serie(n: number, seedInicial = 42): Candle[] {
  const out: Candle[] = [];
  let preco = 139_000;
  let seed = seedInicial;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    preco += ((seed % 240) - 118) / 2;
    const abertura = preco;
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    const fechamento = preco + ((seed % 160) - 80) / 2;
    out.push({
      t: T0 + i * MINUTO,
      o: abertura,
      h: Math.max(abertura, fechamento) + 15,
      l: Math.min(abertura, fechamento) - 15,
      c: fechamento,
      v: 100 + (i % 7),
    });
    preco = fechamento;
  }
  return out;
}

const OPCOES = { asset: "WINFUT" } as const;

/** Trades cujo desfecho coube inteiro até `cutoff` (inclusive). */
function resolvidasAte(result: QuantResult, cutoff: number) {
  return result.trades.filter((trade) => trade.closedAt <= cutoff);
}

describe("runQuantBacktest — honestidade mecânica", () => {
  it("série lateral sem setup: 0 trades, 0 setups, sem erro e sem silêncio", () => {
    const resultado = runQuantBacktest(lateral(90), OPCOES);
    expect(resultado.trades).toEqual([]);
    expect(resultado.setupsDetected).toBe(0);
    expect(resultado.candlesProcessed).toBe(90);
    // Os candles abaixo do mínimo estão DECLARADOS, não sumidos.
    expect(resultado.discards["janela_curta"]).toBe(MIN_CLOSED_CANDLES - 1);
  });

  it("série vazia devolve zeros — nunca lança", () => {
    const resultado = runQuantBacktest([], OPCOES);
    expect(resultado.trades).toEqual([]);
    expect(resultado.setupsDetected).toBe(0);
    expect(resultado.candlesProcessed).toBe(0);
    expect(resultado.discards).toEqual({});
  });

  it("determinismo: duas execuções da MESMA série são idênticas", () => {
    const s = serie(140);
    const a = runQuantBacktest(s, OPCOES);
    // Cópia profunda dos candles: o resultado não pode depender de identidade
    // de objeto nem de mutação escondida da série de entrada.
    const b = runQuantBacktest(
      s.map((candle) => ({ ...candle })),
      OPCOES,
    );
    expect(b.setupsDetected).toBe(a.setupsDetected);
    expect(b.candlesProcessed).toBe(a.candlesProcessed);
    expect(b.discards).toEqual(a.discards);
    expect(b.trades).toEqual(a.trades);
  });

  it("anti-look-ahead estrutural: truncar a série em i preserva tudo até i", () => {
    const s = serie(140);
    const completa = runQuantBacktest(s, OPCOES);

    for (const i of [60, 90, 120]) {
      const prefixo = runQuantBacktest(s.slice(0, i), OPCOES);
      const cutoff = s[i - 1]!.t;

      expect(prefixo.candlesProcessed).toBe(i);
      // A contagem de janela curta é propriedade do PREFIXO, igual nas duas.
      expect(prefixo.discards["janela_curta"]).toBe(completa.discards["janela_curta"]);
      // Toda operação resolvida dentro do prefixo tem de ser IDÊNTICA à da
      // série completa — decisão congelada em T não pode depender de T+n.
      expect(prefixo.trades).toEqual(resolvidasAte(completa, cutoff));
      // Setups só podem se ACUMULAR com mais série; nunca desaparecer.
      expect(prefixo.setupsDetected).toBeLessThanOrEqual(completa.setupsDetected);
    }
  });

  it("anti-look-ahead: um FUTURO diferente não reescreve o passado", () => {
    const s = serie(140);
    const i = 90;
    const cutoff = s[i - 1]!.t;
    // Mesmo passado, futuro deslocado 500+ pontos com outra geometria.
    const futuroMutado = [
      ...s.slice(0, i),
      ...s.slice(i).map((candle) => ({
        ...candle,
        o: candle.o + 700,
        h: candle.h + 900,
        l: candle.l + 500,
        c: candle.c + 800,
      })),
    ];
    const original = runQuantBacktest(s, OPCOES);
    const mutada = runQuantBacktest(futuroMutado, OPCOES);
    // Tudo que foi decidido E resolvido até i é idêntico nos dois mundos.
    expect(resolvidasAte(mutada, cutoff)).toEqual(resolvidasAte(original, cutoff));
  });

  it("janela menor que minWindow cai TODA em discards — nunca em conclusão", () => {
    const resultado = runQuantBacktest(lateral(30), { asset: "WINFUT", minWindow: 50 });
    expect(resultado.trades).toEqual([]);
    expect(resultado.setupsDetected).toBe(0);
    expect(resultado.candlesProcessed).toBe(30);
    expect(resultado.discards["janela_curta"]).toBe(30);
  });

  it("dado sujo é descartado com motivo, nunca em silêncio", () => {
    const base = lateral(40);
    const sujo: Candle[] = [
      ...base,
      // Timestamp repetido: o primeiro da série importada vence.
      { ...base[10]! },
      // OHLC não finito: candle inválido por construção.
      { t: T0 + 41 * MINUTO, o: Number.NaN, h: 1, l: 0, c: 1, v: 0 },
    ];
    const resultado = runQuantBacktest(sujo, OPCOES);
    expect(resultado.candlesProcessed).toBe(42);
    expect(resultado.discards["timestamp_duplicado"]).toBe(1);
    expect(resultado.discards["candle_invalido"]).toBe(1);
    expect(resultado.trades).toEqual([]);
  });
});
