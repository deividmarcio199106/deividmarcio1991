import { describe, expect, it } from "vitest";

import {
  candleKey,
  emptyLedger,
  ledgerLogLine,
  observeCandle,
  timeframeMs,
  type CandleIdentity,
  type CandleObservationInput,
  type LedgerState,
} from "../candleLedger";

/**
 * O CICLO DE VIDA DO CANDLE EM TESTE.
 *
 * A regra do operador que estes testes trancam: nenhuma entrada T4 nasce de
 * candle FORMING, e um candle só vira CLOSED quando o SEGUINTE aparece no
 * gráfico. Fechamento sem OHLC lido não é prova — é estimativa, e estimativa
 * erra por ticks contra uma tolerância de rompimento de um tick.
 */

const MIN = 60_000;
const T = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return Date.UTC(2026, 7, 20, h!, m!, 0, 0);
};
const hhmm = (t: number): string => new Date(t).toISOString().slice(11, 16);

const id = (chart: string, over: Partial<CandleIdentity> = {}): CandleIdentity => ({
  asset: "WINFUT",
  timeframe: "1Min",
  chartTime: T(chart),
  ...over,
});

/** Uma observação: o relógio do gráfico, o preço do eixo e o OHLC anterior. */
function obs(
  chart: string | null,
  price: number | null,
  over: Partial<CandleObservationInput> = {},
): CandleObservationInput {
  return {
    identity: chart === null ? null : id(chart),
    capturedAt: T("09:00"),
    price,
    previousOhlc: null,
    ...over,
  };
}

/** Roda uma sequência e devolve todos os passos. */
function rodar(entradas: CandleObservationInput[]) {
  let estado: LedgerState = emptyLedger();
  return entradas.map((entrada) => {
    const passo = observeCandle(estado, entrada);
    estado = passo.state;
    return passo;
  });
}

const OHLC = { open: 170_900, high: 171_050, low: 170_880, close: 170_960 };

describe("identidade do candle", () => {
  it("a chave é ativo + timeframe + chartTime — nunca o relógio local", () => {
    expect(candleKey(id("10:31"))).toBe(`WINFUT|1Min|${T("10:31")}`);
    // Mesmo instante de captura, gráficos diferentes: candles diferentes.
    expect(candleKey(id("10:31"))).not.toBe(candleKey(id("10:31", { asset: "WDOFUT" })));
    expect(candleKey(id("10:31"))).not.toBe(candleKey(id("10:31", { timeframe: "5Min" })));
  });

  it("o período sai do rótulo do timeframe, e o ilegível vira null", () => {
    expect(timeframeMs("1Min")).toBe(MIN);
    expect(timeframeMs("5 min")).toBe(5 * MIN);
    expect(timeframeMs("1h")).toBe(60 * MIN);
    expect(timeframeMs("30s")).toBe(30_000);
    // Ausência é um valor: rótulo que não dá para interpretar não vira 1 minuto
    // por conveniência — quem chama precisa saber que não sabe.
    expect(timeframeMs("diário")).toBeNull();
    expect(timeframeMs("")).toBeNull();
    expect(timeframeMs("0Min")).toBeNull();
  });
});

describe("§3 — dez leituras do mesmo candle são UM candle", () => {
  it("a mesma leitura repetida atualiza, não cria e não fecha", () => {
    const passos = rodar([
      obs("10:31", 170_900),
      obs("10:31", 170_940),
      obs("10:31", 170_880),
      obs("10:31", 170_960),
    ]);
    expect(passos[0]!.event).toBe("PRIMEIRO_CANDLE");
    for (const passo of passos.slice(1)) {
      expect(passo.event).toBe("MESMO_CANDLE");
      expect(passo.justClosed).toBeNull();
      expect(passo.podeConfirmar).toBe(false);
    }
    const atual = passos[3]!.state.current!;
    expect(atual.readings).toBe(4);
    expect(atual.phase).toBe("FORMING");
    // Máxima e mínima abrem com o que foi VISTO — nada de extremo inventado.
    expect(atual.ohlc.high).toBe(170_960);
    expect(atual.ohlc.low).toBe(170_880);
    expect(atual.ohlc.close).toBe(170_960);
  });

  it("leitura sem preço legível não apaga o que já se sabia", () => {
    const passos = rodar([obs("10:31", 170_900), obs("10:31", null)]);
    const atual = passos[1]!.state.current!;
    expect(atual.readings).toBe(2);
    expect(atual.ohlc.close).toBe(170_900);
  });
});

describe("a transição de candle é o que fecha o anterior", () => {
  it("o candle só vira CLOSED quando o SEGUINTE aparece", () => {
    const passos = rodar([obs("10:31", 170_900), obs("10:32", 170_970)]);
    expect(passos[0]!.state.current!.phase).toBe("FORMING");
    const fechou = passos[1]!;
    expect(fechou.event).toBe("CANDLE_FECHADO");
    expect(fechou.justClosed!.identity.chartTime).toBe(T("10:31"));
    expect(fechou.justClosed!.phase).toBe("CLOSED");
    // E já existe um novo candle em formação, com o preço desta leitura.
    expect(fechou.state.current!.identity.chartTime).toBe(T("10:32"));
    expect(fechou.state.current!.phase).toBe("FORMING");
  });

  it("SEM OHLC lido, o candle fecha mas o fechamento NÃO é prova", () => {
    /*
     * O caso medido em 20/08: a etiqueta de preço é o último negócio no
     * instante da captura, e entre ela e o fechamento real ainda houve
     * negócio (elo 076→077, 1 tick). Fechar é fato — o gráfico andou. Provar
     * o fechamento é outra coisa, e sem o OHLC do desenho não temos.
     */
    const [, fechou] = rodar([obs("10:31", 170_900), obs("10:32", 170_970)]);
    expect(fechou!.justClosed!.closeSource).toBe("NAO_PROVADO");
    expect(fechou!.podeConfirmar).toBe(false);
    expect(fechou!.reason).toContain("NÃO PROVADO");
  });

  it("COM OHLC lido do gráfico, o fechamento é prova e libera o cálculo", () => {
    const [, fechou] = rodar([
      obs("10:31", 170_900),
      obs("10:32", 170_970, { previousOhlc: { ohlc: OHLC, reader: "MODELO" } }),
    ]);
    expect(fechou!.justClosed!.closeSource).toBe("MODELO");
    expect(fechou!.justClosed!.ohlc).toEqual(OHLC);
    expect(fechou!.podeConfirmar).toBe(true);
  });

  it("o OHLC lido SUBSTITUI o estimado — o desenho manda, não a amostra", () => {
    const [, , fechou] = rodar([
      obs("10:31", 170_900),
      obs("10:31", 171_500), // amostra ruidosa: puxaria a máxima para 171.500
      obs("10:32", 170_970, { previousOhlc: { ohlc: OHLC, reader: "MODELO" } }),
    ]);
    expect(fechou!.justClosed!.ohlc.high).toBe(OHLC.high);
    expect(fechou!.justClosed!.ohlc.close).toBe(OHLC.close);
  });

  it("candle fechado é imutável — leitura fora de ordem não o reabre", () => {
    const passos = rodar([
      obs("10:31", 170_900),
      obs("10:32", 170_970, { previousOhlc: { ohlc: OHLC, reader: "MODELO" } }),
      obs("10:31", 169_000), // OCR atrasado
    ]);
    const tarde = passos[2]!;
    expect(tarde.event).toBe("REGRESSAO_IGNORADA");
    expect(tarde.podeConfirmar).toBe(false);
    expect(tarde.state.lastClosed!.ohlc.close).toBe(OHLC.close);
    expect(tarde.state.current!.identity.chartTime).toBe(T("10:32"));
  });
});

describe("a TRAVA — nenhuma entrada nasce de candle FORMING", () => {
  it("enquanto o candle forma, podeConfirmar é sempre false", () => {
    const passos = rodar([obs("10:31", 170_900), obs("10:31", 170_950), obs("10:31", 171_000)]);
    expect(passos.every((p) => p.podeConfirmar === false)).toBe(true);
  });

  it("podeConfirmar é true em UM passo só: o da transição com prova", () => {
    const passos = rodar([
      obs("10:31", 170_900),
      obs("10:31", 170_950),
      obs("10:32", 170_970, { previousOhlc: { ohlc: OHLC, reader: "MODELO" } }),
      obs("10:32", 171_010),
      obs("10:32", 171_040),
    ]);
    expect(passos.map((p) => p.podeConfirmar)).toEqual([false, false, true, false, false]);
  });

  it("buraco na série NÃO confirma, mesmo com OHLC lido", () => {
    /*
     * "O candle seguinte sustentou" é uma frase sobre candles observados. Se
     * 10:32 e 10:33 passaram sem captura, sustentação ali é sobre imagem que
     * ninguém viu. Conservador na dúvida.
     */
    const passos = rodar([
      obs("10:31", 170_900),
      obs("10:34", 170_970, { previousOhlc: { ohlc: OHLC, reader: "MODELO" } }),
    ]);
    const salto = passos[1]!;
    expect(salto.event).toBe("SALTO_COM_CANDLES_NAO_OBSERVADOS");
    expect(salto.missed).toBe(2);
    expect(salto.justClosed!.phase).toBe("CLOSED");
    expect(salto.podeConfirmar).toBe(false);
    expect(salto.state.missedCandles).toBe(2);
  });
});

describe("sem relógio do gráfico, nada anda", () => {
  it("leitura sem chartTime preserva o estado e é contada", () => {
    const passos = rodar([obs("10:31", 170_900), obs(null, 171_000), obs(null, 171_100)]);
    for (const passo of passos.slice(1)) {
      expect(passo.event).toBe("SEM_CHART_TIME");
      expect(passo.justClosed).toBeNull();
      expect(passo.podeConfirmar).toBe(false);
    }
    expect(passos[2]!.state.blindReads).toBe(2);
    // O candle em formação continua exatamente como estava.
    expect(passos[2]!.state.current!.ohlc.close).toBe(170_900);
    expect(passos[2]!.state.current!.readings).toBe(1);
  });

  it("a primeira leitura sem chartTime não cria candle nenhum", () => {
    const [primeiro] = rodar([obs(null, 170_900)]);
    expect(primeiro!.state.current).toBeNull();
    expect(primeiro!.event).toBe("SEM_CHART_TIME");
  });
});

describe("troca de série", () => {
  it("trocar de ativo NÃO fecha o candle anterior — só paramos de olhar", () => {
    const passos = rodar([
      obs("10:31", 170_900),
      { ...obs("10:31", 5_400), identity: id("10:31", { asset: "WDOFUT" }) },
    ]);
    const troca = passos[1]!;
    expect(troca.event).toBe("SERIE_TROCADA");
    expect(troca.justClosed).toBeNull();
    expect(troca.podeConfirmar).toBe(false);
    expect(troca.state.lastClosed).toBeNull();
    expect(troca.state.current!.identity.asset).toBe("WDOFUT");
  });

  it("trocar de timeframe também não fecha nada", () => {
    const passos = rodar([
      obs("10:31", 170_900),
      { ...obs("10:30", 170_900), identity: id("10:30", { timeframe: "5Min" }) },
    ]);
    expect(passos[1]!.event).toBe("SERIE_TROCADA");
    expect(passos[1]!.justClosed).toBeNull();
  });
});

describe("a linha de registro que o operador pediu", () => {
  it("diz FORMING → novo chartTime → CLOSED → confirmação, com a prova", () => {
    const [, fechou] = rodar([
      obs("10:31", 170_900),
      obs("10:32", 170_970, { previousOhlc: { ohlc: OHLC, reader: "MODELO" } }),
    ]);
    const linha = ledgerLogLine(fechou!, hhmm);
    expect(linha).toContain("FORMING 10:31");
    expect(linha).toContain("novo chartTime 10:32");
    expect(linha).toContain("10:31 CLOSED");
    expect(linha).toContain("OHLC lido");
    expect(linha).toContain("confirmação T4 liberada");
  });

  it("e diz BLOQUEADA quando não há prova", () => {
    const [, fechou] = rodar([obs("10:31", 170_900), obs("10:32", 170_970)]);
    const linha = ledgerLogLine(fechou!, hhmm);
    expect(linha).toContain("SEM prova de fechamento");
    expect(linha).toContain("confirmação T4 BLOQUEADA");
  });

  it("passo que não fechou nada não finge que fechou", () => {
    const [primeiro] = rodar([obs("10:31", 170_900)]);
    expect(ledgerLogLine(primeiro!, hhmm)).toContain("PRIMEIRO_CANDLE");
  });
});
