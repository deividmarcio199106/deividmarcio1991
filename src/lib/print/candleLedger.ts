/**
 * O LIVRO-RAZÃO DO CANDLE — quem é o candle atual, e quando o anterior fechou.
 *
 * A DECISÃO DO OPERADOR QUE ESTE MÓDULO EXISTE PARA CUMPRIR (20/08/2026):
 *
 *   "Quando surgir o candle seguinte, o candle anterior passa a ser considerado
 *    CLOSED. A IA lê OHLC/posição gráfica do candle anterior e usa esse
 *    fechamento para confirmar ou invalidar a T4. A captura :57 pode existir
 *    apenas como pré-análise/alerta, nunca como confirmação."
 *
 *   "Nenhuma entrada T4 pode nascer de candle FORMING."
 *
 * A EVIDÊNCIA QUE FORÇOU ISSO. Na sessão real de 20/08 foram lidas 83 capturas
 * da janela do operador. Em 55 dos 56 prints com cabeçalho legível, o campo
 * `Fch` do Profit era IDÊNTICO à etiqueta de preço do eixo — assinatura de
 * candle em formação. Nenhum print da sessão mostrou o fechamento de um candle.
 * A máquina de rompimento vinha tratando preço corrente como fechamento, e o
 * elo 076→077 provou o estrago: `Fch 170.960` seguido de `Abr 170.965`, ou
 * seja, houve negócio DEPOIS da captura. Um fechamento estimado erra por ticks,
 * e a tolerância de rompimento é de UM tick.
 *
 * A IDENTIDADE É `ativo + timeframe + chartTime`, e `chartTime` vem do RELÓGIO
 * DO GRÁFICO (@/lib/vision/marketClock), nunca de `Date.now()`. Medido na mesma
 * sessão: contra o relógio de dentro da imagem, 15 de 82 transições consecutivas
 * estavam erradas — 7 capturas caíram no mesmo minuto de mercado e 8 candles
 * ficaram sem captura nenhuma. Em tempo de navegador a sessão parecia perfeita.
 * `Date.now()` sobrevive aqui só como `capturedAt`: latência e diagnóstico.
 *
 * ISTO NÃO É UM SEGUNDO `ChartTracker`. O `ChartTracker`
 * (@/lib/vision/chartTracker) reconstrói a SÉRIE inteira a partir da geometria
 * dos pixels, e é o motor do mundo Profit Vision. Este livro-razão não monta
 * série nenhuma: ele responde UMA pergunta sobre o candle da vez — "já fechou,
 * e temos prova disso?" — a partir de leituras sucessivas do mesmo gráfico. Os
 * dois nunca produzem o mesmo número, então não podem discordar. O agregador
 * que FOI removido de `candleReconstruction` era justamente um segundo motor de
 * OHLC; este aqui não calcula OHLC — ele recebe o OHLC lido e carimba a fase.
 */

/** Fase do candle. Só `CLOSED` pode confirmar entrada. */
export type CandlePhase = "FORMING" | "CLOSED";

/**
 * De onde veio o fechamento — e é isto que separa prova de estimativa.
 *
 * `MODELO` e `GEOMETRIA`: o OHLC do candle JÁ FECHADO foi lido na imagem. As
 *   duas PROVAM; elas só custam e falham de jeitos diferentes.
 * `NAO_PROVADO`: só sabemos o último preço visto enquanto o candle formava.
 *   Entre aquela leitura e o fechamento real houve negócio — medido, 1 tick no
 *   elo 076→077 da sessão de 20/08. Serve para pré-alerta; NUNCA para confirmar.
 */
export type CloseSource = "MODELO" | "GEOMETRIA" | "NAO_PROVADO";

/**
 * Quem leu o candle fechado.
 *
 * `MODELO`    — a IA leu o OHLC do desenho e devolveu no contrato.
 * `GEOMETRIA` — os pixels do candle foram medidos e convertidos pela régua.
 *
 * POR QUE EXISTEM DUAS VIAS, medido em produção em 20/08/2026: o modelo
 * entregou `lastClosedCandle` em ZERO de 25 análises reais. Ele lê ETIQUETA DE
 * TEXTO muito bem — o relógio do gráfico saiu em 18 das mesmas 25 — e falha em
 * GEOMETRIA: extrair OHLC da forma do candle é outra tarefa, e é a que os
 * pixels fazem melhor que o modelo.
 *
 * Guardar QUAL via leu não é curiosidade: é o que permite comparar as duas
 * quando ambas responderem, e decidir com número em vez de impressão.
 */
export type ProvenReader = "MODELO" | "GEOMETRIA";

/** O fechamento serve para confirmar entrada? Uma pergunta, uma resposta. */
export function fechamentoProvado(source: CloseSource): boolean {
  return source === "MODELO" || source === "GEOMETRIA";
}

export interface CandleIdentity {
  asset: string;
  timeframe: string;
  /** Início do candle em epoch ms, derivado do relógio do GRÁFICO. */
  chartTime: number;
}

/** A chave do §20 aplicada ao candle: mesma chave, mesmo candle. */
export function candleKey(identity: CandleIdentity): string {
  return `${identity.asset}|${identity.timeframe}|${identity.chartTime}`;
}

export interface CandleOhlc {
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
}

export interface LedgerCandle {
  identity: CandleIdentity;
  phase: CandlePhase;
  ohlc: CandleOhlc;
  closeSource: CloseSource;
  /** Primeira e última captura que enxergaram este candle. */
  firstSeenAt: number;
  lastSeenAt: number;
  /** Quantas capturas atualizaram este candle. Dez leituras, um candle. */
  readings: number;
}

export interface CandleObservationInput {
  /**
   * Identidade lida do GRÁFICO. `null` quando o relógio do gráfico não pôde ser
   * lido — e aí nada anda: sem saber que candle é este, qualquer decisão sobre
   * fechamento seria sobre um candle que não sabemos qual é.
   */
  identity: CandleIdentity | null;
  /** `Date.now()` da captura. Diagnóstico e latência — nunca identidade. */
  capturedAt: number;
  /** Etiqueta de preço do eixo: preço CORRENTE do candle em formação. */
  price: number | null;
  /**
   * OHLC do candle IMEDIATAMENTE ANTERIOR, lido do desenho já finalizado.
   *
   * É o único caminho para um fechamento PROVADO. Ausente, o candle anterior
   * fecha mesmo assim (o gráfico andou, isso é fato), mas com
   * `closeSource: "NAO_PROVADO"` — e aí a T4 não confirma.
   *
   * `reader` é OBRIGATÓRIO junto do OHLC, e não um campo opcional com padrão:
   * quem entrega um fechamento tem de declarar de onde ele veio. Um padrão
   * silencioso aqui apagaria justamente a informação que a sessão de validação
   * existe para contar.
   */
  previousOhlc: { ohlc: CandleOhlc; reader: ProvenReader } | null;
}

export type LedgerEvent =
  | "SEM_CHART_TIME"
  | "SERIE_TROCADA"
  | "PRIMEIRO_CANDLE"
  | "MESMO_CANDLE"
  | "CANDLE_FECHADO"
  | "REGRESSAO_IGNORADA"
  | "SALTO_COM_CANDLES_NAO_OBSERVADOS";

export interface LedgerState {
  /** O candle em formação. Null antes da primeira leitura legível. */
  current: LedgerCandle | null;
  /** O último candle que fechou. Imutável depois de fechado. */
  lastClosed: LedgerCandle | null;
  /** Candles que o gráfico passou sem nenhuma captura, acumulado na sessão. */
  missedCandles: number;
  /** Leituras recusadas por falta de `chartTime`, acumulado. */
  blindReads: number;
}

export interface LedgerStep {
  state: LedgerState;
  event: LedgerEvent;
  /** Sempre preenchido, inclusive em sucesso — nada acontece em silêncio. */
  reason: string;
  /**
   * O candle que fechou NESTE passo. É o único insumo com que a T4 pode
   * confirmar entrada, e só quando o fechamento for PROVADO (ver `ProvenReader`).
   */
  justClosed: LedgerCandle | null;
  /** Quantos candles ficaram sem captura entre o anterior e este. */
  missed: number;
  /**
   * A TRAVA. `true` somente quando este passo entregou um fechamento PROVADO.
   *
   * Enquanto for `false`, a máquina T4 pode observar, aproximar e armar — mas
   * `CONFIRMED_ENTRY` está proibido. É a regra do operador escrita como campo,
   * para que nenhum consumidor precise redescobri-la.
   */
  podeConfirmar: boolean;
}

export function emptyLedger(): LedgerState {
  return { current: null, lastClosed: null, missedCandles: 0, blindReads: 0 };
}

/** Duração de um candle, em ms, a partir do rótulo de timeframe do gráfico. */
export function timeframeMs(timeframe: string): number | null {
  const texto = timeframe.trim().toLowerCase();
  const m = texto.match(/^(\d{1,4})\s*(min|m|h|hora|horas|s|seg)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unidade = m[2] ?? "min";
  if (unidade === "s" || unidade === "seg") return n * 1_000;
  if (unidade === "h" || unidade === "hora" || unidade === "horas") return n * 3_600_000;
  return n * 60_000;
}

function novoCandle(identity: CandleIdentity, at: number, price: number | null): LedgerCandle {
  return {
    identity,
    phase: "FORMING",
    // Abertura: a primeira leitura que vimos deste candle. Máxima e mínima
    // começam nela e só se abrem com leituras posteriores — nunca inventamos
    // extremos que não foram vistos.
    ohlc: { open: price, high: price, low: price, close: price },
    closeSource: "NAO_PROVADO",
    firstSeenAt: at,
    lastSeenAt: at,
    readings: 1,
  };
}

function mesclarPreco(candle: LedgerCandle, price: number | null, at: number): LedgerCandle {
  if (price === null) {
    return { ...candle, lastSeenAt: at, readings: candle.readings + 1 };
  }
  const { high, low, open } = candle.ohlc;
  return {
    ...candle,
    ohlc: {
      open: open ?? price,
      high: high === null ? price : Math.max(high, price),
      low: low === null ? price : Math.min(low, price),
      close: price,
    },
    lastSeenAt: at,
    readings: candle.readings + 1,
  };
}

/**
 * Fecha o candle em formação usando o OHLC lido do gráfico, quando houver.
 *
 * Sem esse OHLC o candle fecha assim mesmo — o gráfico avançou, e negar isso
 * seria inventar um presente que já passou. O que NÃO acontece é o fechamento
 * virar prova: `closeSource` continua `NAO_PROVADO`, e a T4 não confirma.
 */
function fechar(
  candle: LedgerCandle,
  lido: { ohlc: CandleOhlc; reader: ProvenReader } | null,
  at: number,
): LedgerCandle {
  if (lido === null || lido.ohlc.close === null) {
    return { ...candle, phase: "CLOSED", closeSource: "NAO_PROVADO", lastSeenAt: at };
  }
  return {
    ...candle,
    phase: "CLOSED",
    // A procedência vem de quem leu, e não de uma constante: é ela que a
    // sessão de validação conta para decidir entre modelo e geometria.
    closeSource: lido.reader,
    ohlc: {
      open: lido.ohlc.open ?? candle.ohlc.open,
      high: lido.ohlc.high ?? candle.ohlc.high,
      low: lido.ohlc.low ?? candle.ohlc.low,
      close: lido.ohlc.close,
    },
    lastSeenAt: at,
  };
}

const PARADO: Omit<LedgerStep, "state" | "event" | "reason"> = {
  justClosed: null,
  missed: 0,
  podeConfirmar: false,
};

/**
 * Uma leitura do gráfico entra; o livro-razão diz o que ela significa.
 *
 * PURA: recebe estado e observação, devolve estado novo. Nenhum relógio é lido
 * aqui dentro — o tempo entra por parâmetro, que é o que torna o passo
 * reproduzível no teste e no replay.
 */
export function observeCandle(state: LedgerState, input: CandleObservationInput): LedgerStep {
  const { identity, capturedAt, price, previousOhlc } = input;

  /*
   * SEM RELÓGIO DO GRÁFICO, NADA ANDA.
   *
   * A tentação é cair para `Date.now()` "só desta vez". Foi exatamente esse
   * fallback que produziu 18% de atribuição errada na sessão de 20/08. Sem
   * saber qual candle é este, fechar o anterior seria carimbar um fechamento
   * em cima de um candle que não sabemos qual é. Ausência é um valor.
   */
  /*
   * IDENTIDADE COM INSTANTE NÃO FINITO É O MESMO QUE NÃO TER IDENTIDADE.
   *
   * Tratada aqui, junto do `null`, e não como um caso à parte: um `chartTime`
   * NaN não é "um candle estranho", é a ausência de leitura chegando por outro
   * caminho. Em 20/08/2026 ele chegou — uma data em formato brasileiro virou
   * Invalid Date rio acima — e as frases de motivo deste módulo, que formatam
   * o instante com `toISOString()`, LANÇAVAM. Um módulo cuja função é dizer
   * "não sei" não pode derrubar quem o chamou ao dizer isso.
   */
  if (identity === null || !Number.isFinite(identity.chartTime)) {
    return {
      ...PARADO,
      state: { ...state, blindReads: state.blindReads + 1 },
      event: "SEM_CHART_TIME",
      reason:
        identity === null
          ? "relógio do gráfico não lido — candle não identificado, estado preservado"
          : "horário do gráfico inválido — candle não identificado, estado preservado",
    };
  }

  const atual = state.current;

  if (atual === null) {
    return {
      ...PARADO,
      state: { ...state, current: novoCandle(identity, capturedAt, price) },
      event: "PRIMEIRO_CANDLE",
      reason: `primeiro candle observado da série (${identity.asset} ${identity.timeframe})`,
    };
  }

  /*
   * TROCA DE ATIVO OU TIMEFRAME: o candle anterior NÃO fecha.
   *
   * Ele pode estar vivo no gráfico de onde saímos; só paramos de olhar. Marcar
   * CLOSED aqui inventaria um fechamento que ninguém viu, e o fechamento é
   * justamente o que libera operação.
   */
  if (atual.identity.asset !== identity.asset || atual.identity.timeframe !== identity.timeframe) {
    return {
      ...PARADO,
      state: { ...state, current: novoCandle(identity, capturedAt, price), lastClosed: null },
      event: "SERIE_TROCADA",
      reason:
        `série trocada (${atual.identity.asset} ${atual.identity.timeframe} → ` +
        `${identity.asset} ${identity.timeframe}) — candle anterior não fechado, ` +
        "só deixou de ser observado",
    };
  }

  if (identity.chartTime === atual.identity.chartTime) {
    return {
      ...PARADO,
      state: { ...state, current: mesclarPreco(atual, price, capturedAt) },
      event: "MESMO_CANDLE",
      reason: `mesma leitura de candle (${atual.readings + 1}ª) — estado atualizado, nada fechou`,
    };
  }

  /*
   * RELÓGIO PARA TRÁS: leitura fora de ordem, e ela não desfaz nada.
   *
   * Um OCR que leu 10:31 depois de já ter lido 10:32 é erro de leitura, não
   * viagem no tempo. Reabrir um candle fechado quebraria a única garantia que
   * este módulo oferece: candle fechado é imutável.
   */
  if (identity.chartTime < atual.identity.chartTime) {
    return {
      ...PARADO,
      state,
      event: "REGRESSAO_IGNORADA",
      reason:
        `relógio do gráfico regrediu (${new Date(identity.chartTime).toISOString()} < ` +
        `${new Date(atual.identity.chartTime).toISOString()}) — leitura descartada`,
    };
  }

  // O gráfico avançou: o candle em formação virou passado.
  const fechado = fechar(atual, previousOhlc, capturedAt);
  const periodo = timeframeMs(identity.timeframe);
  const salto =
    periodo === null
      ? 0
      : Math.max(0, Math.round((identity.chartTime - atual.identity.chartTime) / periodo) - 1);

  const provado = fechamentoProvado(fechado.closeSource);
  const base = {
    state: {
      current: novoCandle(identity, capturedAt, price),
      lastClosed: fechado,
      missedCandles: state.missedCandles + salto,
      blindReads: state.blindReads,
    },
    justClosed: fechado,
    missed: salto,
    /*
     * A TRAVA, EM UMA LINHA. Fechamento sem prova não confirma entrada.
     *
     * E um SALTO também não confirma: se candles inteiros passaram sem
     * captura, "o candle seguinte sustentou" é uma frase sobre candles que
     * ninguém viu. Conservador na dúvida.
     */
    podeConfirmar: provado && salto === 0,
  };

  if (salto > 0) {
    return {
      ...base,
      event: "SALTO_COM_CANDLES_NAO_OBSERVADOS",
      reason:
        `${salto} candle(s) passaram sem captura entre ` +
        `${new Date(atual.identity.chartTime).toISOString()} e ` +
        `${new Date(identity.chartTime).toISOString()} — fechamento registrado, ` +
        "confirmação suspensa por buraco na série",
    };
  }

  return {
    ...base,
    event: "CANDLE_FECHADO",
    reason: provado
      ? `candle ${new Date(fechado.identity.chartTime).toISOString()} FECHADO com OHLC lido do gráfico`
      : `candle ${new Date(fechado.identity.chartTime).toISOString()} FECHADO sem OHLC lido — ` +
        "fechamento NÃO PROVADO, confirmação bloqueada",
  };
}

/**
 * A linha de registro que o operador pediu para provar o ciclo na sessão real:
 *
 *   "FORMING 10:31 → novo chartTime 10:32 → 10:31 CLOSED → confirmação T4
 *    calculada → entrada/não entrada com motivo objetivo"
 *
 * Fica aqui, junto da máquina que produz os fatos, para que o texto e o estado
 * não possam divergir — texto de log montado longe do estado é como a tela
 * passa a dizer uma coisa e o código a fazer outra.
 */
export function ledgerLogLine(step: LedgerStep, hhmm: (t: number) => string): string {
  const anterior = step.justClosed;
  const atual = step.state.current;
  if (anterior === null || atual === null) {
    return `${step.event} — ${step.reason}`;
  }
  const prova = fechamentoProvado(anterior.closeSource)
    ? `OHLC lido por ${anterior.closeSource.toLowerCase()}`
    : "SEM prova de fechamento";
  const buraco = step.missed > 0 ? ` · ${step.missed} candle(s) não observado(s)` : "";
  return (
    `FORMING ${hhmm(anterior.identity.chartTime)} → novo chartTime ` +
    `${hhmm(atual.identity.chartTime)} → ${hhmm(anterior.identity.chartTime)} CLOSED ` +
    `(${prova})${buraco} → ${step.podeConfirmar ? "confirmação T4 liberada para cálculo" : "confirmação T4 BLOQUEADA"}`
  );
}
