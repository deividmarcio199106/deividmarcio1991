/**
 * SOM DE CONFIRMAÇÃO (comando §8).
 *
 * Toca UMA vez por signalId na transição PRE-SINAL→CONFIRMADO — nunca por
 * frame. Compra e venda têm timbres diferentes. ON/OFF vem das configurações
 * persistidas e existe um teste manual em /configuracoes.
 */

type SoundDirection = "COMPRA" | "VENDA";

const played = new Set<string>();
let context: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!context) context = new Ctor();
  if (context.state === "suspended") void context.resume().catch(() => undefined);
  return context;
}

function tone(ctx: AudioContext, frequency: number, startAt: number, duration: number): void {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = "square";
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(0.32, startAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.05);
}

function play(direction: SoundDirection): boolean {
  const ctx = audio();
  if (!ctx) return false;
  const now = ctx.currentTime;
  if (direction === "COMPRA") {
    // Compra: sequência ascendente forte.
    tone(ctx, 660, now, 0.16);
    tone(ctx, 880, now + 0.18, 0.16);
    tone(ctx, 1180, now + 0.36, 0.28);
  } else {
    // Venda: sequência descendente forte.
    tone(ctx, 980, now, 0.16);
    tone(ctx, 740, now + 0.18, 0.16);
    tone(ctx, 520, now + 0.36, 0.28);
  }
  return true;
}

/**
 * AVISO DE APROXIMAÇÃO — timbre deliberadamente DIFERENTE do de entrada.
 *
 * São mensagens diferentes e o operador precisa distingui-las sem olhar a
 * tela: aproximação é "olhe agora", confirmação é "a técnica fechou". Dois
 * bipes curtos e graves, sem a subida/descida marcante do sinal de entrada —
 * quem ouve sabe qual é antes de virar a cabeça.
 */
function playApproach(): boolean {
  const ctx = audio();
  if (!ctx) return false;
  const now = ctx.currentTime;
  tone(ctx, 420, now, 0.1);
  tone(ctx, 420, now + 0.16, 0.1);
  return true;
}

/** Aviso de aproximação: 1x por setupId. Nunca repete no mesmo setup. */
export function playApproachOnce(setupId: string, enabled: boolean): boolean {
  if (!enabled) return false;
  const chave = `aprox:${setupId}`;
  if (played.has(chave)) return false;
  played.add(chave);
  return playApproach();
}

/** Alerta de confirmação: 1x por signalId, dedupe permanente na sessão do navegador. */
export function playConfirmationOnce(
  signalId: string,
  direction: SoundDirection,
  enabled: boolean,
): boolean {
  if (!enabled) return false;
  if (played.has(signalId)) return false;
  played.add(signalId);
  return play(direction);
}

/** Botão "testar som" das configurações — não consome nenhum signalId. */
export function playTestSound(direction: SoundDirection = "COMPRA"): boolean {
  return play(direction);
}

/** Exposto para testes unitários. */
export function resetSignalSoundForTests(): void {
  played.clear();
}

/** Consulta usada em testes: o som já disparou para este sinal? */
export function hasPlayed(signalId: string): boolean {
  return played.has(signalId);
}
