import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * AUTENTICAÇÃO DO MEETLY.
 *
 * O app Android usava Firebase Auth. Aqui o login é do próprio servidor:
 * senha com scrypt + sal aleatório, sessão em cookie HttpOnly e, no banco,
 * só o SHA-256 do token — quem ler o SQLite não consegue se passar por ninguém.
 */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

/** Nome em HTTP (desenvolvimento). Em HTTPS usa-se `__Host-meetly_session`. */
export const SESSION_COOKIE = "meetly_session";
const SECURE_SESSION_COOKIE = "__Host-meetly_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function scryptAsync(password: string, salt: Buffer, n: number, r: number, p: number) {
  return new Promise<Buffer>((resolvePromise, reject) => {
    scrypt(password, salt, KEY_LEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolvePromise(key);
    });
  });
}

/**
 * Teto GLOBAL de scrypt simultâneos. Cada hash usa 16 MiB e ~50 ms de CPU no
 * pool de threads que o processo inteiro (analisador incluído) compartilha.
 * Os limites por IP dependem do proxy informar o IP certo; este não depende de
 * nada: com 2 em execução e 20 na fila, o resto recebe 503 na hora.
 */
const MAX_CONCURRENT_SCRYPT = 2;
const MAX_SCRYPT_QUEUE = 20;
let scryptActive = 0;
const scryptWaiting: Array<() => void> = [];

export class ScryptBusyError extends Error {}

async function withScryptSlot<T>(task: () => Promise<T>): Promise<T> {
  if (scryptActive < MAX_CONCURRENT_SCRYPT) {
    scryptActive++;
  } else {
    if (scryptWaiting.length >= MAX_SCRYPT_QUEUE) {
      throw new ScryptBusyError("Servidor ocupado. Tente de novo em instantes.");
    }
    // A vaga é entregue diretamente por quem terminar (scryptActive não muda).
    await new Promise<void>((resolve) => scryptWaiting.push(resolve));
  }
  try {
    return await task();
  } finally {
    const next = scryptWaiting.shift();
    if (next) next();
    else scryptActive--;
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await withScryptSlot(() => scryptAsync(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P));
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64!, "base64");
  const actual = await withScryptSlot(() =>
    scryptAsync(password, Buffer.from(saltB64!, "base64"), Number(n), Number(r), Number(p)),
  );
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Hash fixo usado quando o e-mail não existe: o login gasta o mesmo tempo com
 * ou sem conta, então o tempo de resposta não revela quem está cadastrado.
 */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  return dummyHash;
}

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function isHttps(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (forwarded) return forwarded === "https";
  return new URL(request.url).protocol === "https:";
}

/**
 * O cookie sai com `Secure` sempre que o processo roda em produção — não só
 * quando o proxy avisa por X-Forwarded-Proto, que o Nginx pode nem enviar.
 * Atrás do HTTPS da VPS o Node só enxerga http://127.0.0.1, então depender do
 * cabeçalho deixava a sessão vazar em qualquer requisição http:// do domínio.
 *
 * Com Secure o nome vira `__Host-meetly_session`: o navegador só aceita esse
 * prefixo com Secure, Path=/ e sem Domain, então nem uma resposta http
 * injetada nem um site irmão na mesma VPS conseguem plantar ou trocar a
 * sessão. `MEETLY_INSECURE_COOKIE=1` existe só para testar o build de
 * produção por http numa rede local.
 */
export function shouldUseSecureCookie(request: Request): boolean {
  if (process.env["MEETLY_INSECURE_COOKIE"] === "1") return false;
  return process.env["NODE_ENV"] === "production" || isHttps(request);
}

function cookieName(request: Request): string {
  return shouldUseSecureCookie(request) ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
}

/** Token da sessão. Em modo seguro só o cookie `__Host-` vale (sem fixação via http). */
export function readSessionToken(request: Request): string | null {
  return readCookie(request, cookieName(request));
}

export function sessionCookie(request: Request, token: string, maxAgeMs: number): string {
  const secure = shouldUseSecureCookie(request);
  const parts = [
    `${secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(request: Request): string {
  return sessionCookie(request, "", 0);
}
