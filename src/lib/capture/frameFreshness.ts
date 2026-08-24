import { DUPLICATE_RETRY_LIMIT, framesAreDuplicate } from "./frameHash";

/**
 * FRESCOR DO FRAME — a tela não pode dizer SINCRONIZADO sobre imagem parada.
 *
 * DUAS COISAS DIFERENTES QUE ESTAVAM MISTURADAS (§4, §5):
 *
 *  1. RELÓGIO DESLOCADO. Na sessão de 19/08 havia ~2 minutos de diferença entre
 *     o horário nominal da captura e o horário VISÍVEL no Profit. Isso é offset
 *     de relógio — a máquina de captura e o servidor do gráfico marcam horas
 *     diferentes — e não significa frame atrasado. Tratar offset como atraso
 *     colocaria a T4 em pausa permanente num ambiente perfeitamente saudável.
 *
 *  2. FRAME ATRASADO/PARADO. O gráfico realmente não avançou: Profit travado,
 *     vídeo pausado pelo navegador, RDP sem foco. Aqui a T4 TEM de parar.
 *
 * A distinção é possível porque offset de relógio é CONSTANTE e atraso é
 * CRESCENTE. Este módulo estima o offset pela mediana das últimas diferenças
 * (só quando elas são estáveis entre si) e mede a idade REAL do frame depois de
 * descontá-lo. É por isso que o horário do NOME DO ARQUIVO não decide nada
 * sozinho: ele é só o `capturedAt`, e a verdade exige o par com o `marketFrameAt`.
 *
 * ORDEM DE PRECEDÊNCIA, que não é arbitrária: tempo regressivo primeiro (a fonte
 * andou para trás, nada mais do frame é confiável), depois duplicata, depois
 * envelhecimento. Um frame duplicado E antigo é STALE, não DUPLICATE — o
 * operador precisa da causa mais grave, não da primeira encontrada.
 */

export type CaptureStatus = "FRESH" | "DUPLICATE" | "STALE" | "OUT_OF_ORDER";

/** Idade real (já sem o offset de relógio) acima disto: captura envelhecida. */
export const FRAME_STALE_AFTER_MS = 90_000;

/** Amostras estáveis necessárias para acreditar num offset de relógio. */
const OFFSET_MIN_SAMPLES = 3;
/** Janela do estimador. Curta: offset muda quando o operador acerta o relógio. */
const OFFSET_WINDOW = 9;
/**
 * Dispersão máxima entre as amostras para chamar a diferença de OFFSET.
 *
 * Acima disto a diferença não é constante — é atraso variável, e atraso variável
 * não pode ser descontado, sob pena de o sistema mascarar exatamente o defeito
 * que deveria denunciar.
 */
const OFFSET_SPREAD_TOLERANCE_MS = 5_000;

/** A frase única da pausa (§4). Uma só, para a tela não inventar sinônimos. */
export const PAUSA_LABEL = "T4 PAUSADA — AGUARDANDO FRAME NOVO";

export interface FrameObservation {
  /** Relógio LOCAL no instante da captura. */
  capturedAt: number;
  /**
   * Horário do MERCADO visível no frame (relógio do Profit lido do gráfico).
   * Null quando não foi possível ler — e aí a idade real não é afirmável.
   */
  marketFrameAt: number | null;
  /** Hash perceptual do frame. Null quando não foi calculado. */
  frameHash: string | null;
  /** O heartbeat viu o vídeo parado (currentTime sem avançar). */
  frozen?: boolean;
}

/** O que atravessa capturas — persistido para sobreviver a refresh/restart. */
export interface FreshnessMemory {
  /** Hash do último frame ÚNICO (não o do último frame recebido). */
  lastUniqueHash: string | null;
  lastUniqueFrameAt: number | null;
  lastCapturedAt: number | null;
  lastMarketFrameAt: number | null;
  /** Capturas repetidas seguidas desde o último frame único. */
  duplicateStreak: number;
  /** Diferenças capturedAt − marketFrameAt recentes, para estimar o offset. */
  offsetSamples: number[];
}

export interface FrameFreshness {
  captureStatus: CaptureStatus;
  capturedAt: number;
  marketFrameAt: number | null;
  /** Idade BRUTA (capturedAt − marketFrameAt), em segundos. Null sem o par. */
  frameAgeSec: number | null;
  /** Idade REAL, já descontado o offset de relógio. Null sem o par. */
  frameAgeRealSec: number | null;
  lastUniqueFrameAt: number | null;
  duplicateStreak: number;
  /** Offset de relógio estimado, em ms. Null enquanto não é confiável. */
  clockOffsetMs: number | null;
  /** Este frame pode governar análise, T4, histórico e níveis? */
  analisavel: boolean;
  /** Motivo do status — sempre presente, nunca vazio. */
  reason: string;
  /** Ainda cabe recapturar (§3: até 3 tentativas antes de declarar parada). */
  podeRecapturar: boolean;
}

export function emptyFreshnessMemory(): FreshnessMemory {
  return {
    lastUniqueHash: null,
    lastUniqueFrameAt: null,
    lastCapturedAt: null,
    lastMarketFrameAt: null,
    duplicateStreak: 0,
    offsetSamples: [],
  };
}

function median(values: number[]): number {
  const ordenado = [...values].sort((a, b) => a - b);
  const meio = Math.floor(ordenado.length / 2);
  return ordenado.length % 2 === 1 ? ordenado[meio]! : (ordenado[meio - 1]! + ordenado[meio]!) / 2;
}

/**
 * O offset de relógio, quando ele existe e é confiável.
 *
 * Null significa "as amostras não sustentam afirmar offset" — nunca zero. Zero
 * seria a afirmação "os relógios batem", e ela derrubaria a idade real de um
 * ambiente com dois minutos de diferença para dois minutos de atraso falso.
 */
export function estimateClockOffset(samples: number[]): number | null {
  if (samples.length < OFFSET_MIN_SAMPLES) return null;
  const janela = samples.slice(-OFFSET_WINDOW);
  const spread = Math.max(...janela) - Math.min(...janela);
  if (spread > OFFSET_SPREAD_TOLERANCE_MS) return null;
  return median(janela);
}

export interface ClassifyOptions {
  staleAfterMs?: number;
  retryLimit?: number;
}

/**
 * Classifica um frame e devolve a memória atualizada.
 *
 * PURA: recebe a memória anterior, devolve a próxima. É o que permite testar dez
 * capturas iguais sem navegador — e é o que permite restaurar o estado depois de
 * um refresh sem que a contagem de duplicatas recomece do zero.
 */
export function classifyFrame(
  memory: FreshnessMemory,
  observation: FrameObservation,
  options: ClassifyOptions = {},
): { freshness: FrameFreshness; memory: FreshnessMemory } {
  const staleAfterMs = options.staleAfterMs ?? FRAME_STALE_AFTER_MS;
  const retryLimit = options.retryLimit ?? DUPLICATE_RETRY_LIMIT;
  const { capturedAt, marketFrameAt, frameHash } = observation;

  /* ---------- Tempo regressivo: nada mais do frame é confiável ---------- */
  const capturaRegrediu = memory.lastCapturedAt !== null && capturedAt < memory.lastCapturedAt;
  const mercadoRegrediu =
    marketFrameAt !== null &&
    memory.lastMarketFrameAt !== null &&
    marketFrameAt < memory.lastMarketFrameAt;
  if (capturaRegrediu || mercadoRegrediu) {
    /*
     * A memória NÃO absorve o instante regressivo: gravá-lo faria o próximo
     * frame (legítimo) parecer um salto para a frente, e o estado se
     * "consertaria" sozinho escondendo que a fonte andou para trás.
     */
    return {
      freshness: {
        captureStatus: "OUT_OF_ORDER",
        capturedAt,
        marketFrameAt,
        frameAgeSec: idadeSec(capturedAt, marketFrameAt),
        frameAgeRealSec: null,
        lastUniqueFrameAt: memory.lastUniqueFrameAt,
        duplicateStreak: memory.duplicateStreak,
        clockOffsetMs: estimateClockOffset(memory.offsetSamples),
        analisavel: false,
        reason: capturaRegrediu
          ? `horário de captura regrediu (${new Date(capturedAt).toISOString()} < ${new Date(memory.lastCapturedAt!).toISOString()})`
          : `horário do gráfico regrediu (${new Date(marketFrameAt!).toISOString()} < ${new Date(memory.lastMarketFrameAt!).toISOString()})`,
        podeRecapturar: true,
      },
      memory,
    };
  }

  /* ---------- Offset de relógio e idade real ---------- */
  const amostras =
    marketFrameAt === null
      ? memory.offsetSamples
      : [...memory.offsetSamples, capturedAt - marketFrameAt].slice(-OFFSET_WINDOW);
  const clockOffsetMs = estimateClockOffset(amostras);
  const frameAgeSec = idadeSec(capturedAt, marketFrameAt);
  const idadeRealMs =
    marketFrameAt === null ? null : capturedAt - marketFrameAt - (clockOffsetMs ?? 0);
  const frameAgeRealSec = idadeRealMs === null ? null : Math.round(idadeRealMs / 100) / 10;

  /* ---------- Duplicata ---------- */
  const duplicado = framesAreDuplicate(memory.lastUniqueHash, frameHash);
  const streak = duplicado ? memory.duplicateStreak + 1 : 0;
  const base: FreshnessMemory = {
    lastUniqueHash: duplicado ? memory.lastUniqueHash : frameHash,
    lastUniqueFrameAt: duplicado ? memory.lastUniqueFrameAt : capturedAt,
    lastCapturedAt: capturedAt,
    lastMarketFrameAt: marketFrameAt ?? memory.lastMarketFrameAt,
    duplicateStreak: streak,
    offsetSamples: amostras,
  };

  const envelhecido = idadeRealMs !== null && idadeRealMs > staleAfterMs;
  const congelado = observation.frozen === true;
  const repetiuDemais = duplicado && streak > retryLimit;

  if (envelhecido || congelado || repetiuDemais) {
    const motivo = repetiuDemais
      ? `${streak} capturas idênticas seguidas — fonte parada`
      : congelado
        ? "vídeo congelado (currentTime não avança)"
        : `frame com ${frameAgeRealSec}s de idade real (limite ${Math.round(staleAfterMs / 1000)}s)`;
    return {
      freshness: {
        captureStatus: "STALE",
        capturedAt,
        marketFrameAt,
        frameAgeSec,
        frameAgeRealSec,
        lastUniqueFrameAt: base.lastUniqueFrameAt,
        duplicateStreak: streak,
        clockOffsetMs,
        analisavel: false,
        reason: motivo,
        // Recapturar um frame já declarado parado é insistir no mesmo pixel: o
        // que resolve é o operador olhar a fonte, não o sistema tentar de novo.
        podeRecapturar: false,
      },
      memory: base,
    };
  }

  if (duplicado) {
    return {
      freshness: {
        captureStatus: "DUPLICATE",
        capturedAt,
        marketFrameAt,
        frameAgeSec,
        frameAgeRealSec,
        lastUniqueFrameAt: base.lastUniqueFrameAt,
        duplicateStreak: streak,
        clockOffsetMs,
        analisavel: false,
        reason: `frame idêntico ao último único (tentativa ${streak} de ${retryLimit})`,
        podeRecapturar: streak < retryLimit,
      },
      memory: base,
    };
  }

  return {
    freshness: {
      captureStatus: "FRESH",
      capturedAt,
      marketFrameAt,
      frameAgeSec,
      frameAgeRealSec,
      lastUniqueFrameAt: capturedAt,
      duplicateStreak: 0,
      clockOffsetMs,
      analisavel: true,
      reason:
        clockOffsetMs !== null && Math.abs(clockOffsetMs) > 1_000
          ? `frame novo (offset de relógio conhecido: ${Math.round(clockOffsetMs / 1000)}s)`
          : "frame novo",
      podeRecapturar: false,
    },
    memory: base,
  };
}

function idadeSec(capturedAt: number, marketFrameAt: number | null): number | null {
  if (marketFrameAt === null) return null;
  return Math.round(((capturedAt - marketFrameAt) / 1000) * 10) / 10;
}

/**
 * A tela pode dizer SINCRONIZADO? (§4)
 *
 * Só com frame novo e sem atraso. Duplicata, regressão, envelhecimento e imagem
 * congelada viram PAUSA — porque "SINCRONIZADO" sobre um gráfico parado é a
 * mentira mais cara desta tela: ela convida o operador a decidir sobre um
 * mercado que não está mais ali.
 */
export function podeMostrarSincronizado(
  freshness: FrameFreshness | null,
  atrasoDaCaptura: "SINCRONIZADO" | "ATRASADO" | "PROCESSANDO",
): boolean {
  if (freshness === null) return atrasoDaCaptura === "SINCRONIZADO";
  return freshness.captureStatus === "FRESH" && atrasoDaCaptura === "SINCRONIZADO";
}

/** O rótulo de sincronismo já com a pausa aplicada. Uma fonte, uma frase. */
export function rotuloDeSincronismo(
  freshness: FrameFreshness | null,
  atrasoDaCaptura: "SINCRONIZADO" | "ATRASADO" | "PROCESSANDO",
): string {
  if (freshness !== null && freshness.captureStatus !== "FRESH") return PAUSA_LABEL;
  return atrasoDaCaptura;
}
