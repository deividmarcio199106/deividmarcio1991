/**
 * TRACKER — o elo que faltava entre a tela e o motor T4.
 *
 * Cada frame produz uma série de candles reconstruídos por geometria. O
 * problema é que ela é reconstruída DO ZERO a cada frame: o candle que era o
 * décimo agora é o nono porque o gráfico rolou uma coluna. Sem costura, a T4
 * receberia uma série nova a cada 500ms e nunca teria história.
 *
 * O `CandleStitcher` resolve isso casando o sufixo da série conhecida com uma
 * janela da série nova por sobreposição de valores OHLC — e no modo afim
 * sobrevive à autoescala do Profit, que muda os números quando o eixo se ajusta
 * sem que o mercado tenha mudado.
 *
 * O QUE ESTE ARQUIVO NÃO FAZ, DE PROPÓSITO
 * Não detecta estrutura. Pivô, sweep, BOS, CHOCH, liquidez e regime já existem
 * dentro de `analyze()`, testados e dirigidos por três fontes em produção.
 * Duplicar isso aqui criaria duas verdades sobre o mesmo gráfico, e elas
 * divergiriam. O tracker entrega candles; quem lê mercado é o motor.
 *
 * HORÁRIO: O PONTO FRACO, DITO EM VOZ ALTA
 * `extractCandlesFromPixels` numera os candles com passo fixo de 60s a partir
 * de um instante base. Isso ASSUME que toda coluna visível é exatamente um
 * minuto e que não há buraco — o que é falso em leilão, pausa e virada de
 * pregão. Enquanto o relógio do gráfico não for lido, o horário é uma grade
 * relativa, não a hora do mercado, e `timeTrusted` diz isso a quem consome.
 */

import { CandleStitcher } from "@/lib/replay/candleStitcher";
import { MINUTE_MS, minuteStart } from "@/lib/vision/candleReconstruction";
import type { Candle } from "@/lib/engines/types";
import type { ExtractedCandle } from "@/lib/capture/frameProcessor";
import { candleCountPlausible } from "./profitLayout";

/** Mínimo que o motor T4 exige para dizer qualquer coisa de estrutura. */
export const MIN_CANDLES_FOR_ANALYSIS = 24;
/** Janela entregue ao motor — a mesma dos outros caminhos. */
export const ANALYSIS_WINDOW = 160;

export interface TrackerState {
  /** Série costurada, do mais antigo para o mais novo, sem o em formação. */
  candles: Candle[];
  /** Frames aproveitados desde o início da leitura. */
  accepted: number;
  /** Frames recusados, com o motivo do último. */
  rejected: number;
  lastRejection: string | null;
  /** true quando o horário vem do relógio do gráfico, não de uma grade suposta. */
  timeTrusted: boolean;
  /** true quando os preços são reais, não unidades relativas de pixel. */
  priceTrusted: boolean;
  /** Descontinuidades detectadas na costura — gráfico rolou demais ou saltou. */
  discontinuities: number;
  /** Candles que o extrator enxergou no último frame. */
  candlesVisible: number;
  /** Quantos viraram OHLC utilizável. */
  candlesParsed: number;
  /** Total aceito na série costurada. */
  closedCandlesAccepted: number;
  /** Quantos faltam para o motor poder falar. */
  bootstrapRequired: number;
  /** Motivo da última recusa — nunca silenciosa. */
  rejectReason: string | null;
  /** Data do mercado lida do gráfico. Null = não confiável. */
  marketDate: string | null;

  /* ---- CONTABILIDADE DE DUPLICAÇÃO ---- */
  /** Candles distintos na série. É o número que a T4 realmente recebeu. */
  uniqueCandles: number;
  /** Frames recusados por tentarem reintroduzir história já conhecida. */
  duplicatesRejected: number;
  /** Frames idênticos ao anterior — idempotentes por construção. */
  identicalFrames: number;
  /** Candles fechados NOVOS aceitos no último frame que mudou a série. */
  newClosedCandles: number;
  /** Total de candles fechados novos desde o bootstrap. */
  closedSinceBootstrap: number;
}

export const EMPTY_TRACKER: TrackerState = {
  candles: [],
  accepted: 0,
  rejected: 0,
  lastRejection: null,
  timeTrusted: false,
  priceTrusted: false,
  discontinuities: 0,
  candlesVisible: 0,
  candlesParsed: 0,
  closedCandlesAccepted: 0,
  bootstrapRequired: MIN_CANDLES_FOR_ANALYSIS,
  rejectReason: null,
  marketDate: null,
  uniqueCandles: 0,
  duplicatesRejected: 0,
  identicalFrames: 0,
  newClosedCandles: 0,
  closedSinceBootstrap: 0,
};

/**
 * Quantos candles fechados NOVOS um único frame pode revelar depois do
 * bootstrap.
 *
 * O gráfico é de 1 minuto e o frame chega a cada 500ms: em condições normais um
 * frame revela ZERO ou UM candle fechado. Dois cobre a virada de minuto chegando
 * junto com um frame atrasado. QUARENTA E SEIS — que foi o observado ao vivo,
 * com a série pulando de 212 para 258 em segundos — é impossível como fato de
 * mercado e só pode ser a mesma história entrando de novo.
 *
 * O costurador não tem como saber disso: ele compara formas e não conhece o
 * timeframe. Quem conhece é este arquivo.
 */
export const MAX_NEW_CLOSED_PER_FRAME = 2;

/**
 * Recusas seguidas antes de aceitar que a série precisa recomeçar.
 *
 * A 2 frames por segundo, 6 recusas são ~3 segundos: rápido o bastante para não
 * deixar a T4 lendo um passado obsoleto, e lento o bastante para não recomeçar a
 * série por causa de um único frame ruim.
 */
export const RESYNC_AFTER = 6;

/**
 * Assinatura da série visível no frame.
 *
 * Frame idêntico ao anterior é IDEMPOTENTE por construção: não entra no
 * costurador, não reanalisa, não incrementa nada. Sem isto, a garantia de
 * "mesmo frame 100 vezes = zero candles novos" dependeria de o casamento de
 * janelas nunca errar — e foi justamente ele que errou.
 */
export function frameFingerprint(candles: ExtractedCandle[]): string {
  if (candles.length === 0) return "vazio";
  const round = (value: number) => Math.round(value * 100) / 100;
  const head = candles[0]!;
  const tail = candles[candles.length - 1]!;
  const middle = candles[Math.floor(candles.length / 2)]!;
  return [
    candles.length,
    round(head.o),
    round(head.c),
    round(middle.h),
    round(middle.l),
    round(tail.o),
    round(tail.h),
    round(tail.l),
    round(tail.c),
  ].join("|");
}

/**
 * Rejeição de frame com motivo — nunca silenciosa.
 *
 * Um frame recusado sem explicação vira "a T4 não vê nada" no diagnóstico, e é
 * exatamente a pergunta que o operador está tentando responder.
 */
export function inspectSeries(candles: ExtractedCandle[]): string | null {
  if (candles.length === 0) return "nenhum candle reconstruído no frame";
  if (!candleCountPlausible(candles.length)) {
    return `contagem implausível: ${candles.length} candles (esperado entre 8 e 200)`;
  }
  const invalid = candles.find(
    (candle) =>
      !Number.isFinite(candle.o) ||
      !Number.isFinite(candle.h) ||
      !Number.isFinite(candle.l) ||
      !Number.isFinite(candle.c) ||
      candle.h < candle.l,
  );
  if (invalid) return "candle com OHLC inconsistente no frame";
  return null;
}

/**
 * Reatribui a grade de tempo à série costurada.
 *
 * Os instantes vindos do extrator são relativos. Aqui eles viram uma grade real
 * de 1 minuto terminando no minuto corrente — que é o formato que o mapa de
 * liquidez e a sequência causal esperam, ambos medindo idade em barras de 60s.
 *
 * Continua sendo grade SUPOSTA enquanto o relógio do gráfico não for lido. A
 * diferença é que agora está explícito, e `timeTrusted` acompanha o dado.
 */
export function regrid(candles: Candle[], endAt: number): Candle[] {
  const lastMinute = minuteStart(endAt);
  return candles.map((candle, index) => ({
    ...candle,
    t: lastMinute - (candles.length - 1 - index) * MINUTE_MS,
  }));
}

/**
 * Instante de mercado do candle mais recente.
 *
 * O DEFEITO QUE ISSO CORRIGE: a grade era ancorada em `Date.now()`. Num replay
 * de 13/03/2026 rodando em 11/08/2026, TODA a série nascia com a data errada —
 * o pregão aparecia como 11/08, e junto com ele iam candidateTime, preEntryTime,
 * confirmationTime, o banco e os logs. Um Golden inteiro carimbado com a data
 * de hoje não prova nada sobre 13/03.
 *
 * Agora o relógio do GRÁFICO manda. Sem ele, a série continua sendo montada —
 * a estrutura é legível em grade relativa — mas `dateTrusted` fica falso e quem
 * consome sabe que aquele carimbo não é data de mercado.
 */
export interface MarketClock {
  /** Instante do candle mais recente, lido do eixo de tempo. */
  marketDateTime: number | null;
  timeTrusted: boolean;
  dateTrusted: boolean;
}

export const UNTRUSTED_CLOCK: MarketClock = {
  marketDateTime: null,
  timeTrusted: false,
  dateTrusted: false,
};

/** `2026-03-13` do instante de mercado, ou null quando não é confiável. */
export function marketDateLabel(clock: MarketClock): string | null {
  if (!clock.dateTrusted || clock.marketDateTime === null) return null;
  const date = new Date(clock.marketDateTime);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export class ChartTracker {
  private stitcher: CandleStitcher;
  private state: TrackerState = EMPTY_TRACKER;
  private lastFingerprint: string | null = null;
  private bootstrapped = false;
  /** Recusas seguidas por suspeita de duplicação. Zera a cada frame aceito. */
  private consecutiveRejections = 0;

  /**
   * Teto de candles fechados novos por frame. Ver `MAX_NEW_CLOSED_PER_FRAME`.
   *
   * É PARÂMETRO, não constante, por causa do REPLAY EM VÍDEO: numa gravação
   * do pregão reproduzida acelerada, um frame revela 3, 6, 9 candles novos —
   * e isso é mercado de verdade, não história repetida. Com o teto do ao vivo,
   * o tracker recusava 55% dos frames e ressincronizava 62 vezes em 30
   * segundos: a T4 nunca via 160 candles estáveis. O padrão continua 2, então
   * nenhum caminho ao vivo muda; só quem sabe que a fonte é acelerada afrouxa.
   */
  private readonly maxNewClosedPerFrame: number;
  /** Piso de tolerância do costurador (px). 0 = comportamento do ao vivo. */
  private readonly stitchMinTolerance: number;

  constructor(options: { maxNewClosedPerFrame?: number; stitchMinTolerance?: number } = {}) {
    this.stitcher = new CandleStitcher();
    this.maxNewClosedPerFrame = options.maxNewClosedPerFrame ?? MAX_NEW_CLOSED_PER_FRAME;
    this.stitchMinTolerance = options.stitchMinTolerance ?? 0;
  }

  snapshot(): TrackerState {
    return this.state;
  }

  /** Zera tudo. Trocar de fonte ou de ativo não pode emendar séries. */
  reset(): void {
    this.stitcher = new CandleStitcher();
    this.state = EMPTY_TRACKER;
    this.lastFingerprint = null;
    this.bootstrapped = false;
    this.consecutiveRejections = 0;
  }

  /**
   * Consome os candles de um frame.
   * @returns true quando a série mudou e vale reanalisar.
   */
  push(candles: ExtractedCandle[], now: number, clock: MarketClock = UNTRUSTED_CLOCK): boolean {
    const problem = inspectSeries(candles);
    if (problem !== null) {
      this.state = {
        ...this.state,
        rejected: this.state.rejected + 1,
        lastRejection: problem,
        rejectReason: problem,
        candlesVisible: candles.length,
        candlesParsed: 0,
      };
      return false;
    }

    // FRAME IDÊNTICO É IDEMPOTENTE. Nada entra no costurador, nada é
    // reanalisado. Com o gráfico parado — que é estado NORMAL de mercado — este
    // é o caminho percorrido a cada 500ms.
    const fingerprint = frameFingerprint(candles);
    if (fingerprint === this.lastFingerprint) {
      this.state = {
        ...this.state,
        candlesVisible: candles.length,
        candlesParsed: candles.length,
        identicalFrames: this.state.identicalFrames + 1,
        newClosedCandles: 0,
        rejectReason: null,
      };
      return false;
    }

    const before = this.stitcher.sequence().length;
    // Modo afim: a autoescala do Profit muda os números do eixo sem que o
    // mercado tenha se mexido, e sem isso cada reajuste viraria série nova.
    const result = this.stitcher.ingest(candles, {
      allowAffine: true,
      minTolerance: this.stitchMinTolerance,
    });

    /*
     * ANTIDUPLICAÇÃO — a correção do defeito observado ao vivo.
     *
     * A série pulou de 212 para 258 em segundos num gráfico de 1 minuto. Isso
     * acontece quando uma sobreposição CURTA casa na posição errada: o
     * costurador conclui que 46 candles "foram revelados" e anexa história que
     * já estava lá. O efeito não é cosmético — estrutura, regime e viés são
     * calculados sobre a série, e uma série com o passado repetido descreve um
     * mercado que não existiu.
     *
     * O teto não é palpite: com candle de 1 minuto e frame a cada 500ms, um
     * frame revela zero ou um candle fechado. O que passa disso é a mesma
     * história voltando, e o frame inteiro é recusado COM MOTIVO.
     */
    const isBootstrap = !this.bootstrapped && before === 0;
    if (!isBootstrap && !result.discontinuity && result.appended > this.maxNewClosedPerFrame) {
      this.stitcher.undoAppend(result.appended);
      this.consecutiveRejections += 1;

      /*
       * A RECUSA NÃO PODE VIRAR CONGELAMENTO.
       *
       * O teto supõe continuidade: um frame revela zero ou um candle fechado
       * porque o gráfico anda um minuto por vez. Essa suposição QUEBRA em
       * eventos legítimos — janela minimizada por dez minutos, notebook
       * suspenso, leilão, ou o operador arrastando o gráfico. Em todos, o
       * próximo frame mostra um salto grande e verdadeiro.
       *
       * Sem esta saída, o primeiro salto legítimo recusaria todo frame seguinte
       * para sempre: a série congelaria e a T4 seguiria analisando um passado
       * que não é mais o mercado — pior que a duplicação que o teto evita,
       * porque não aparece como erro.
       *
       * Depois de RESYNC_AFTER recusas seguidas, a leitura reconhece que o
       * mundo mudou e recomeça a série DECLARANDO a descontinuidade, em vez de
       * emendar um salto que ela não consegue explicar.
       */
      if (this.consecutiveRejections >= RESYNC_AFTER) {
        this.stitcher.reset();
        this.stitcher.ingest(candles, { allowAffine: true, minTolerance: this.stitchMinTolerance });
        this.consecutiveRejections = 0;
        this.lastFingerprint = fingerprint;
        const resynced = regrid([...this.stitcher.sequence()], clock.marketDateTime ?? now);
        this.state = {
          ...this.state,
          candles: resynced.slice(-ANALYSIS_WINDOW * 2),
          accepted: this.state.accepted + 1,
          candlesVisible: candles.length,
          candlesParsed: candles.length,
          closedCandlesAccepted: resynced.length,
          uniqueCandles: resynced.length,
          newClosedCandles: 0,
          discontinuities: this.state.discontinuities + 1,
          bootstrapRequired: Math.max(0, MIN_CANDLES_FOR_ANALYSIS - resynced.length),
          marketDate: marketDateLabel(clock),
          lastRejection: this.state.rejectReason,
          rejectReason: null,
        };
        return true;
      }

      this.state = {
        ...this.state,
        rejected: this.state.rejected + 1,
        candlesVisible: candles.length,
        candlesParsed: candles.length,
        duplicatesRejected: this.state.duplicatesRejected + 1,
        newClosedCandles: 0,
        lastRejection: `duplicação recusada: ${result.appended} candles fechados num frame`,
        rejectReason: `frame tentou revelar ${result.appended} candles fechados de uma vez (máximo ${this.maxNewClosedPerFrame} por frame em 1 minuto) — história repetida, não mercado novo`,
      };
      return false;
    }

    if (isBootstrap && result.appended > 0) this.bootstrapped = true;
    this.consecutiveRejections = 0;
    this.lastFingerprint = fingerprint;

    // O relogio do GRAFICO manda. `now` so entra quando nao ha leitura de eixo,
    // e nesse caso a data viaja marcada como nao confiavel.
    const anchor = clock.marketDateTime ?? now;
    const merged = regrid([...this.stitcher.sequence()], anchor);
    const newlyClosed = Math.max(0, merged.length - before);

    this.state = {
      ...this.state,
      candles: merged.slice(-ANALYSIS_WINDOW * 2),
      accepted: this.state.accepted + 1,
      candlesVisible: candles.length,
      candlesParsed: candles.length,
      closedCandlesAccepted: merged.length,
      uniqueCandles: merged.length,
      newClosedCandles: newlyClosed,
      closedSinceBootstrap: this.state.closedSinceBootstrap + (isBootstrap ? 0 : newlyClosed),
      bootstrapRequired: Math.max(0, MIN_CANDLES_FOR_ANALYSIS - merged.length),
      rejectReason: null,
      marketDate: marketDateLabel(clock),
      discontinuities: this.state.discontinuities + (result.discontinuity ? 1 : 0),
    };

    // Reanalisar quando nada entrou queimaria GPU para reconfirmar o já sabido.
    return merged.length !== before || result.appended > 0;
  }

  /** A série já é suficiente para o motor dizer alguma coisa? */
  ready(): boolean {
    return this.state.candles.length >= MIN_CANDLES_FOR_ANALYSIS;
  }

  /**
   * Janela para análise, SEM o candle em formação.
   *
   * O extrator já descarta o último cluster por posição, mas repetir a garantia
   * aqui é barato: analisar vela em formação é decidir sobre um candle que
   * ainda vai mudar.
   */
  window(): Candle[] {
    return this.state.candles.slice(-ANALYSIS_WINDOW);
  }
}
