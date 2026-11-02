/**
 * Regras do Meetly usadas dos dois lados (formulário e API).
 *
 * O servidor é quem decide; o cliente repete as mesmas regras só para mostrar
 * o erro no campo antes de enviar.
 */

export const MEETLY_LIMITS = {
  nameMax: 80,
  emailMax: 254,
  passwordMin: 6,
  passwordMax: 128,
  titleMax: 120,
  contentMax: 2000,
  phoneMax: 20,
  /** Data URL da foto de perfil já redimensionada no navegador. */
  imageMaxChars: 200_000,
} as const;

/** Paleta de cores das reuniões — a mesma do ColorPicker do app original. */
export const MEETLY_COLORS = ["#7209B7", "#EF233C", "#F7B801", "#06D6A0", "#F72585", "#00BBF9"];

/**
 * Nomes de sala do app original (LinkPicker). A sala final recebe um sufixo
 * aleatório, como no Android: "<expressão>-r-<6 caracteres>".
 */
export const MEETLY_ROOM_WORDS = [
  "the-best-of-both-worlds",
  "speak-of-the-devil",
  "see-eye-to-eye",
  "once-in-a-blue-moon",
  "when-pigs-fly",
  "a-piece-of-cake",
  "let-the-cat-out-of-the-bag",
  "to-feel-under-the-weather",
  "to-cost-an-arm-and-a-leg",
  "stealing-someones-thunder",
  "the-elephant-in-the-room",
  "the-last-straw",
  "giving-someone-the-cold-shoulder",
  "getting-a-taste-of-your-own-medicine",
  "bite-the-bullet",
  "no-pain-no-gain",
  "let-someone-off-the-hook",
  "call-it-a-day",
  "a-blessing-in-disguise",
  "to-hit-the-nail-on-the-head",
  "break-a-leg",
  "you-cant-judge-a-book-by-its-cover",
  "to-add-insult-to-injury",
  "to-cut-corners",
  "to-kill-two-birds-with-one-stone",
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const PHONE_RE = /^[0-9+()\-\s]*$/;
const IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidEmail(value: string): boolean {
  return value.length <= MEETLY_LIMITS.emailMax && EMAIL_RE.test(value);
}

export function isValidDate(value: string): boolean {
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return (
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(m) - 1 &&
    date.getUTCDate() === Number(d)
  );
}

export function isValidTime(value: string): boolean {
  return TIME_RE.test(value);
}

export function isValidPhone(value: string): boolean {
  return value.length <= MEETLY_LIMITS.phoneMax && PHONE_RE.test(value);
}

export function isValidImageUrl(value: string): boolean {
  return value === "" || (value.length <= MEETLY_LIMITS.imageMaxChars && IMAGE_RE.test(value));
}

/** Data local de hoje no formato YYYY-MM-DD (o "Today's meetings" do app). */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
