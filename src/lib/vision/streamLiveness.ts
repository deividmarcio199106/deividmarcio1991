/**
 * DOIS SINAIS DIFERENTES, QUE EU TINHA COLADO NUM SÓ.
 *
 *   STREAM  — a captura está viva? Vem da MediaStreamTrack.
 *   VISUAL  — os pixels estão mudando? Vem da comparação de frames.
 *
 * A combinação STREAM=ACTIVE + VISUAL=STATIC é PERFEITAMENTE VÁLIDA: um gráfico
 * de 1 minuto passa vários segundos sem alterar um pixel, e isso não é falha de
 * nada. A versão anterior tratava imagem parada como captura perdida, derrubava
 * `isUsable` e com isso jogava a T4 de volta para AGUARDANDO DADO — apagando
 * contexto que estava correto.
 *
 * A CAUSA QUE ESCONDIA O ERRO
 * O `FrameProcessor` descarta frame byte-idêntico ao anterior (dedup por hash).
 * Ou seja: com o gráfico parado, NENHUM `FrameRead` é emitido. O `lastFrameAt`
 * congelava e o watchdog concluía "os frames pararam de chegar" — quando na
 * verdade eles chegavam e estavam sendo filtrados antes. Era por isso que o
 * painel alternava entre PARADA e CONGELADA enquanto o contador subia.
 *
 * Por isso ausência de frame NÃO é mais evidência de stream morto. Stream morto
 * agora é apenas o que a própria track diz: `ended`, `readyState !== "live"`, ou
 * um erro explícito do navegador.
 */

import type { FrameRead } from "@/lib/capture/frameProcessor";

/** Saúde da captura. Vem da track, nunca dos pixels. */
export type StreamHealth = "ACTIVE" | "ENDED" | "ERROR" | "UNKNOWN";

/** Movimento da imagem. Informativo — nunca interrompe a leitura. */
export type VisualMotion = "MOVING" | "STATIC" | "UNKNOWN";

/**
 * Sem frame por este tempo, a imagem é considerada estática — NÃO parada.
 * Precisa ser generoso porque o dedup por hash suprime frames idênticos.
 */
export const STATIC_AFTER_MS = 3_000;
/**
 * Só depois deste silêncio a falta de frame vira suspeita de problema, e ainda
 * assim apenas como aviso: a palavra final é sempre da track.
 */
export const SILENCE_WARNING_MS = 30_000;
/** Duas mudanças seguidas para declarar MOVING — evita piscar a cada frame. */
const MOVING_CONFIRMATIONS = 2;

export interface LivenessState {
  stream: StreamHealth;
  visual: VisualMotion;
  lastFrameAt: number | null;
  /** Último instante em que a imagem realmente MUDOU. */
  lastChangeAt: number | null;
  framesReceived: number;
  fps: number;
  width: number;
  height: number;
  fingerprint: FrameFingerprint | null;
  /** Mudanças consecutivas, para a histerese de MOVING. */
  changeStreak: number;
  /** Há quanto tempo os pixels estão idênticos. */
  staticForMs: number;
  detail: string;
}

export const EMPTY_LIVENESS: LivenessState = {
  stream: "UNKNOWN",
  visual: "UNKNOWN",
  lastFrameAt: null,
  lastChangeAt: null,
  framesReceived: 0,
  fps: 0,
  width: 0,
  height: 0,
  fingerprint: null,
  changeStreak: 0,
  staticForMs: 0,
  detail: "aguardando o primeiro frame",
};

/**
 * Ruído tolerado na massa de candles entre frames.
 *
 * `bullMass`/`bearMass` vêm de `inspectPixelFrame` como FRAÇÃO da área do
 * gráfico (~1e-3), não como contagem. Um limiar em unidades de contagem nunca
 * dispararia.
 */
const MASS_NOISE = 0.00005;
const PRICE_Y_NOISE = 1;

export interface FrameFingerprint {
  bullMass: number;
  bearMass: number;
  candleColumns: number;
  priceY: number | null;
  width: number;
  height: number;
}

export function fingerprint(frame: FrameRead): FrameFingerprint {
  return {
    bullMass: frame.bullMass,
    bearMass: frame.bearMass,
    candleColumns: frame.candleColumns,
    priceY: frame.priceY,
    width: frame.width,
    height: frame.height,
  };
}

export function frameChanged(
  previous: FrameFingerprint | null,
  current: FrameFingerprint,
): boolean {
  if (previous === null) return true;
  if (previous.candleColumns !== current.candleColumns) return true;
  const massDelta =
    Math.abs(previous.bullMass - current.bullMass) + Math.abs(previous.bearMass - current.bearMass);
  if (massDelta > MASS_NOISE) return true;
  if (previous.priceY !== null && current.priceY !== null) {
    if (Math.abs(previous.priceY - current.priceY) > PRICE_Y_NOISE) return true;
  } else if (previous.priceY !== current.priceY) {
    return true;
  }
  return false;
}

/** Estado da track, lido do navegador. É a ÚNICA fonte sobre stream vivo. */
export function readStreamHealth(track: MediaStreamTrack | null | undefined): StreamHealth {
  if (!track) return "UNKNOWN";
  if (track.readyState === "ended") return "ENDED";
  if (track.readyState === "live") return "ACTIVE";
  return "UNKNOWN";
}

export function observeFrame(
  previous: LivenessState,
  frame: FrameRead,
  now: number,
  stream: StreamHealth = "ACTIVE",
): LivenessState {
  const current = fingerprint(frame);
  const changed = frameChanged(previous.fingerprint, current);
  const resized =
    previous.width !== 0 && (previous.width !== frame.width || previous.height !== frame.height);

  const elapsed = previous.lastFrameAt === null ? 0 : now - previous.lastFrameAt;
  const instantFps = elapsed > 0 ? 1000 / elapsed : previous.fps;
  const fps = previous.fps === 0 ? instantFps : previous.fps * 0.7 + instantFps * 0.3;

  const changeStreak = changed ? previous.changeStreak + 1 : 0;
  const lastChangeAt = changed ? now : previous.lastChangeAt;
  const staticForMs = lastChangeAt === null ? 0 : now - lastChangeAt;

  // Histerese: duas mudanças seguidas para declarar movimento. Um frame isolado
  // que variou não deve fazer o painel piscar.
  const visual: VisualMotion = changed
    ? changeStreak >= MOVING_CONFIRMATIONS
      ? "MOVING"
      : previous.visual === "MOVING"
        ? "MOVING"
        : "UNKNOWN"
    : staticForMs >= STATIC_AFTER_MS
      ? "STATIC"
      : previous.visual;

  return {
    stream,
    visual,
    lastFrameAt: now,
    lastChangeAt,
    framesReceived: previous.framesReceived + 1,
    fps,
    width: frame.width,
    height: frame.height,
    fingerprint: current,
    changeStreak,
    staticForMs,
    detail: resized
      ? `resolução mudou para ${frame.width}×${frame.height}`
      : visual === "MOVING"
        ? `${Math.round(fps)} fps · ${frame.candleColumns} colunas`
        : `gráfico sem alteração há ${Math.round(staticForMs / 1000)}s`,
  };
}

/**
 * Reavalia sem frame novo.
 *
 * Ausência de frame NÃO derruba o stream: com o dedup por hash, gráfico parado
 * simplesmente não gera frame. Só a track decide se a captura morreu.
 */
export function checkTimeout(
  state: LivenessState,
  now: number,
  stream: StreamHealth = state.stream,
): LivenessState {
  if (state.lastFrameAt === null) return { ...state, stream };

  const silence = now - state.lastFrameAt;
  const staticForMs = state.lastChangeAt === null ? silence : now - state.lastChangeAt;
  const visual: VisualMotion = staticForMs >= STATIC_AFTER_MS ? "STATIC" : state.visual;

  let detail = state.detail;
  if (stream === "ENDED") {
    detail = "o compartilhamento foi encerrado";
  } else if (silence >= SILENCE_WARNING_MS) {
    // Aviso, não interrupção: pode ser só um gráfico muito parado.
    detail = `sem frame novo há ${Math.round(silence / 1000)}s — confira se a janela está visível`;
  } else if (visual === "STATIC") {
    detail = `gráfico sem alteração há ${Math.round(staticForMs / 1000)}s`;
  }

  return { ...state, stream, visual, staticForMs, detail };
}

/**
 * A leitura pode continuar?
 *
 * Depende SOMENTE da captura estar viva. Imagem parada é informação sobre o
 * mercado, não sobre o sistema — e derrubar a análise por isso apagaria
 * contexto correto, que foi o defeito observado no Golden.
 */
export function isUsable(state: LivenessState): boolean {
  return state.stream === "ACTIVE" || state.stream === "UNKNOWN";
}

/** true quando há movimento — usado para decidir se vale reanalisar. */
export function isMoving(state: LivenessState): boolean {
  return state.visual === "MOVING";
}

export function streamLabel(state: LivenessState): string {
  switch (state.stream) {
    case "ACTIVE":
      return "ATIVA";
    case "ENDED":
      return "ENCERRADA";
    case "ERROR":
      return "ERRO";
    default:
      return "AGUARDANDO";
  }
}

export function visualLabel(state: LivenessState): string {
  switch (state.visual) {
    case "MOVING":
      return "EM MOVIMENTO";
    case "STATIC":
      return "ESTÁTICO";
    default:
      return "AGUARDANDO";
  }
}
