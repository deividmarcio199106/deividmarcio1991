/**
 * ALLOWLIST DE LEITURA DE CÓDIGO.
 *
 * A correção assistida precisa mostrar arquivos para a IA. Sem uma allowlist,
 * "leia este arquivo para me ajudar" vira leitura arbitrária do disco do
 * servidor — `.env`, chaves SSH, banco, qualquer coisa.
 *
 * Portanto: só código-fonte, só dentro do projeto, e uma negação explícita para
 * tudo que possa carregar segredo. A negação vence a permissão.
 */

import { readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

/** Prefixos permitidos, relativos à raiz do projeto. */
// `bridge/` saiu: a ponte RTD não faz mais parte do caminho de dado, e manter
// seus arquivos auditáveis convidaria a IA a propor correções para um pipeline
// que não roda.
const ALLOWED_PREFIXES = ["src/", "scripts/", "migrations/", "docs/"];

/** Extensões permitidas. Binário e configuração de ambiente ficam de fora. */
const ALLOWED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".md",
  ".sql",
  ".bas",
  ".ps1",
];

/**
 * Negação explícita. Estes padrões vencem qualquer permissão acima — é a
 * diferença entre "não listei" e "recusei".
 */
const DENIED_PATTERNS = [
  /(^|\/)\.env/i,
  /(^|\/)\.git(\/|$)/i,
  /secret/i,
  /credential/i,
  /password|senha/i,
  /\.pem$|\.key$|\.pfx$|\.p12$/i,
  /id_rsa|id_ed25519|\.ssh(\/|$)/i,
  /(^|\/)node_modules(\/|$)/i,
  /\.sqlite($|-wal$|-shm$)/i,
  /(^|\/)data(\/|$)/i,
  /updater\.config\.json$/i,
];

const MAX_BYTES = 200_000;

export type FileReadResult =
  { ok: true; path: string; content: string; bytes: number } | { ok: false; reason: string };

function projectRoot(): string {
  return resolve(process.env["PROJECT_ROOT"]?.trim() || process.cwd());
}

/** Normaliza para caminho relativo com barras, sem `..`. */
export function normalizeRequestedPath(raw: string): string | null {
  const cleaned = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!cleaned) return null;
  if (cleaned.startsWith("/") || /^[a-zA-Z]:/.test(cleaned)) return null;
  if (cleaned.split("/").includes("..")) return null;
  return cleaned;
}

export function isAuditableFile(relativePath: string): { ok: boolean; reason: string } {
  for (const pattern of DENIED_PATTERNS) {
    if (pattern.test(relativePath)) {
      return { ok: false, reason: "caminho negado pela allowlist (possível segredo ou dado)" };
    }
  }
  if (!ALLOWED_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) {
    return {
      ok: false,
      reason: `fora dos diretórios auditáveis (${ALLOWED_PREFIXES.join(", ")})`,
    };
  }
  if (!ALLOWED_EXTENSIONS.some((extension) => relativePath.endsWith(extension))) {
    return { ok: false, reason: "extensão não auditável" };
  }
  return { ok: true, reason: "" };
}

export function readAuditableFile(raw: string): FileReadResult {
  const relativePath = normalizeRequestedPath(raw);
  if (!relativePath) return { ok: false, reason: "caminho inválido" };

  const verdict = isAuditableFile(relativePath);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };

  const root = projectRoot();
  const absolute = resolve(root, relativePath);
  // Defesa final contra symlink e escape: o caminho resolvido tem que continuar
  // dentro da raiz do projeto.
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    return { ok: false, reason: "caminho escapa da raiz do projeto" };
  }

  try {
    const stats = statSync(absolute);
    if (!stats.isFile()) return { ok: false, reason: "não é arquivo" };
    if (stats.size > MAX_BYTES) {
      return { ok: false, reason: `arquivo grande demais (${stats.size} bytes)` };
    }
    return {
      ok: true,
      path: relativePath,
      content: readFileSync(absolute, "utf8"),
      bytes: stats.size,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "falha ao ler",
    };
  }
}
