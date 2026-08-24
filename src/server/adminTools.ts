import { exec } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { sanitizeSecrets } from "@/lib/errors/sanitize";
import { getDatabase, getDataDir } from "./tradingRepository";

/**
 * FERRAMENTAS INTERNAS CONTROLADAS DO CLAUDE ADMIN (comando §7–§9, §18–§19).
 *
 * - O modelo NUNCA executa shell arbitrário: só a whitelist fixa abaixo.
 * - Todo caminho é resolvido dentro do diretório do projeto; `../`, /etc,
 *   ~/.ssh, .env e afins são bloqueados (path traversal).
 * - Nenhum patch é aplicado automaticamente: proposePatch só REGISTRA a
 *   alteração; aplicar/reverter são ações explícitas do usuário na UI, sempre
 *   com snapshot automático antes (backup em DATA_DIR/claude-admin/backups).
 * - Conteúdo lido passa por redação de segredos antes de ir ao modelo.
 */

export function projectRoot(): string {
  return resolve(process.env["CLAUDE_ADMIN_ROOT"]?.trim() || process.cwd());
}

const DENY_PATH_PATTERNS = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.env$/i,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.ssh(\/|$)/,
  /id_rsa|id_ed25519/i,
  /credentials|\.pem$|\.key$/i,
];

const MAX_FILE_BYTES = 512 * 1024;

export function guardPath(input: string, { forWrite = false } = {}): string {
  const root = projectRoot();
  const target = resolve(root, input);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`Caminho fora do diretório permitido do projeto: ${input}`);
  }
  const rel = relative(root, target).split(sep).join("/");
  for (const pattern of DENY_PATH_PATTERNS) {
    if (pattern.test(rel) || pattern.test(input)) {
      throw new Error(`Caminho bloqueado por política de segurança: ${input}`);
    }
  }
  if (forWrite && /^(package-lock\.json|bun\.lock)$/.test(rel)) {
    throw new Error(`Arquivo gerenciado por ferramenta — não editável pelo admin: ${input}`);
  }
  return target;
}

export function listFiles(dir = "."): { path: string; type: "file" | "dir"; size: number }[] {
  const target = guardPath(dir);
  if (!existsSync(target)) throw new Error(`Diretório não existe: ${dir}`);
  const entries = readdirSync(target, { withFileTypes: true });
  const root = projectRoot();
  const out: { path: string; type: "file" | "dir"; size: number }[] = [];
  for (const entry of entries) {
    const full = join(target, entry.name);
    const rel = relative(root, full).split(sep).join("/");
    if (DENY_PATH_PATTERNS.some((pattern) => pattern.test(rel))) continue;
    try {
      out.push({
        path: rel,
        type: entry.isDirectory() ? "dir" : "file",
        size: entry.isDirectory() ? 0 : statSync(full).size,
      });
    } catch {
      // arquivo sumiu no meio da listagem — ignora
    }
  }
  return out.sort((a, b) =>
    a.type === b.type ? a.path.localeCompare(b.path) : a.type === "dir" ? -1 : 1,
  );
}

export function readFileSafe(path: string): { path: string; content: string; truncated: boolean } {
  const target = guardPath(path);
  if (!existsSync(target)) throw new Error(`Arquivo não existe: ${path}`);
  const stats = statSync(target);
  if (stats.isDirectory()) throw new Error(`É um diretório, use listFiles: ${path}`);
  const truncated = stats.size > MAX_FILE_BYTES;
  const raw = readFileSync(target, "utf8").slice(0, MAX_FILE_BYTES);
  return { path, content: sanitizeSecrets(raw), truncated };
}

export function searchCode(
  query: string,
  dir = "src",
  maxResults = 60,
): Array<{ path: string; line: number; text: string }> {
  if (!query || query.length < 2) throw new Error("Consulta de busca muito curta.");
  const rootDir = guardPath(dir);
  const root = projectRoot();
  const results: Array<{ path: string; line: number; text: string }> = [];
  const queue: string[] = [rootDir];
  const lowered = query.toLowerCase();
  while (queue.length && results.length < maxResults) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      const full = join(current, entry.name);
      const rel = relative(root, full).split(sep).join("/");
      if (DENY_PATH_PATTERNS.some((pattern) => pattern.test(rel))) continue;
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx|json|css|md|sql|txt|yml|yaml|html)$/i.test(entry.name)) continue;
      let content: string;
      try {
        if (statSync(full).size > MAX_FILE_BYTES) continue;
        content = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      for (let index = 0; index < lines.length && results.length < maxResults; index++) {
        if (lines[index]!.toLowerCase().includes(lowered)) {
          results.push({
            path: rel,
            line: index + 1,
            text: sanitizeSecrets(lines[index]!.slice(0, 300)),
          });
        }
      }
    }
  }
  return results;
}

/** Whitelist FIXA — o modelo escolhe a chave, nunca o comando. */
const COMMAND_WHITELIST: Record<string, string> = {
  test: "npm run test --silent",
  typecheck: "npx tsc --noEmit",
  lint: "npm run lint --silent",
  build: "npm run build",
  "git diff": "git diff --stat && git diff",
  "git status": "git status --porcelain=v1 -b",
};

export function allowedCommands(): string[] {
  return Object.keys(COMMAND_WHITELIST);
}

export async function runWhitelistedCommand(
  name: string,
): Promise<{ command: string; exitCode: number; output: string }> {
  const command = COMMAND_WHITELIST[name];
  if (!command) {
    throw new Error(`Comando não permitido: ${name}. Permitidos: ${allowedCommands().join(", ")}.`);
  }
  if (process.env["CLAUDE_ADMIN_ALLOW_COMMANDS"]?.trim() !== "1") {
    throw new Error(
      "Execução de comandos desativada nesta instalação. Defina CLAUDE_ADMIN_ALLOW_COMMANDS=1 no .env da VPS para habilitar test/typecheck/lint/build/git.",
    );
  }
  return new Promise((resolvePromise) => {
    exec(
      command,
      { cwd: projectRoot(), timeout: 300_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = sanitizeSecrets(`${stdout ?? ""}\n${stderr ?? ""}`).slice(0, 40_000);
        resolvePromise({
          command,
          exitCode: error && typeof error.code === "number" ? error.code : error ? 1 : 0,
          output,
        });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// ALTERAÇÕES: propose → diff → (aprovação humana) apply/reject → revert
// ---------------------------------------------------------------------------

export interface AdminChangeFile {
  path: string;
  before: string;
  after: string;
  addedLines: number;
  removedLines: number;
}

export interface AdminChangeRecord {
  changeId: string;
  createdAt: number;
  description: string;
  status: "PROPOSED" | "APPLIED" | "REJECTED" | "REVERTED";
  files: AdminChangeFile[];
  tests: { name: string; exitCode: number; output: string }[] | null;
  updatedAt: number;
}

function diffCounts(before: string, after: string): { added: number; removed: number } {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  return {
    removed: Math.max(0, beforeLines.length - prefix - suffix),
    added: Math.max(0, afterLines.length - prefix - suffix),
  };
}

function backupsDir(changeId: string): string {
  const dir = join(
    getDataDir(),
    "claude-admin",
    "backups",
    changeId.replace(/[^a-zA-Z0-9_-]/g, "_"),
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function saveChange(record: AdminChangeRecord): void {
  getDatabase()
    .prepare(
      `INSERT INTO admin_changes(change_id, created_at, description, status, files_json, tests_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(change_id) DO UPDATE SET description=excluded.description, status=excluded.status, files_json=excluded.files_json, tests_json=excluded.tests_json, updated_at=excluded.updated_at`,
    )
    .run(
      record.changeId,
      record.createdAt,
      record.description,
      record.status,
      JSON.stringify(record.files),
      record.tests ? JSON.stringify(record.tests) : null,
      Date.now(),
    );
}

export function getChange(changeId: string): AdminChangeRecord | null {
  const row = getDatabase()
    .prepare("SELECT * FROM admin_changes WHERE change_id=?")
    .get(changeId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    changeId: String(row.change_id),
    createdAt: Number(row.created_at),
    description: String(row.description),
    status: row.status as AdminChangeRecord["status"],
    files: JSON.parse(String(row.files_json)) as AdminChangeFile[],
    tests: row.tests_json
      ? (JSON.parse(String(row.tests_json)) as AdminChangeRecord["tests"])
      : null,
    updatedAt: Number(row.updated_at),
  };
}

export function listChanges(limit = 50): AdminChangeRecord[] {
  const rows = getDatabase()
    .prepare("SELECT change_id FROM admin_changes ORDER BY created_at DESC LIMIT ?")
    .all(limit) as Array<{ change_id: string }>;
  return rows.map((row) => getChange(row.change_id)!).filter(Boolean);
}

/** Registra uma proposta de alteração. NÃO escreve nada no disco. */
export function proposePatch(input: {
  filePath: string;
  newContent: string;
  description: string;
}): AdminChangeRecord {
  const target = guardPath(input.filePath, { forWrite: true });
  const before = existsSync(target) ? readFileSync(target, "utf8") : "";
  const counts = diffCounts(before, input.newContent);
  const changeId = `chg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const record: AdminChangeRecord = {
    changeId,
    createdAt: Date.now(),
    description: sanitizeSecrets(input.description).slice(0, 2_000),
    status: "PROPOSED",
    files: [
      {
        path: relative(projectRoot(), target).split(sep).join("/"),
        before,
        after: input.newContent,
        addedLines: counts.added,
        removedLines: counts.removed,
      },
    ],
    tests: null,
    updatedAt: Date.now(),
  };
  saveChange(record);
  return record;
}

/** APROVAÇÃO EXPLÍCITA DO USUÁRIO: snapshot automático + escrita. */
export function applyChange(changeId: string): AdminChangeRecord {
  const record = getChange(changeId);
  if (!record) throw new Error(`Alteração não encontrada: ${changeId}`);
  if (record.status !== "PROPOSED") {
    throw new Error(`Alteração ${changeId} não está em estado PROPOSED (${record.status}).`);
  }
  const backups = backupsDir(changeId);
  for (const file of record.files) {
    const target = guardPath(file.path, { forWrite: true });
    if (existsSync(target)) {
      const backupPath = join(backups, file.path.replace(/[/\\]/g, "__"));
      copyFileSync(target, backupPath);
    }
  }
  for (const file of record.files) {
    const target = guardPath(file.path, { forWrite: true });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.after, "utf8");
  }
  const updated: AdminChangeRecord = { ...record, status: "APPLIED", updatedAt: Date.now() };
  saveChange(updated);
  return updated;
}

export function rejectChange(changeId: string): AdminChangeRecord {
  const record = getChange(changeId);
  if (!record) throw new Error(`Alteração não encontrada: ${changeId}`);
  const updated: AdminChangeRecord = { ...record, status: "REJECTED", updatedAt: Date.now() };
  saveChange(updated);
  return updated;
}

/** Restaura o conteúdo ANTES da alteração (do registro, com backup em disco). */
export function revertChange(changeId: string): AdminChangeRecord {
  const record = getChange(changeId);
  if (!record) throw new Error(`Alteração não encontrada: ${changeId}`);
  if (record.status !== "APPLIED") {
    throw new Error(`Somente alterações APPLIED podem ser revertidas (${record.status}).`);
  }
  for (const file of record.files) {
    const target = guardPath(file.path, { forWrite: true });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.before, "utf8");
  }
  const updated: AdminChangeRecord = { ...record, status: "REVERTED", updatedAt: Date.now() };
  saveChange(updated);
  return updated;
}

export function attachTests(
  changeId: string,
  tests: { name: string; exitCode: number; output: string }[],
): AdminChangeRecord | null {
  const record = getChange(changeId);
  if (!record) return null;
  const updated: AdminChangeRecord = { ...record, tests, updatedAt: Date.now() };
  saveChange(updated);
  return updated;
}
