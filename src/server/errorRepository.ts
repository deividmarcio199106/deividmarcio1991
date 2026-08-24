import { getDatabase } from "./tradingRepository";
import { sanitizeSecrets, sanitizeUnknown } from "@/lib/errors/sanitize";

export type ErrorSeverity = "INFO" | "WARNING" | "ERROR" | "CRITICAL";
export type ErrorSource =
  | "FRONTEND"
  | "BACKEND"
  | "API"
  | "T4"
  | "CAPTURA"
  | "CHART_CLOCK"
  | "OCR"
  | "GRAVACAO"
  | "OLLAMA"
  | "DB"
  | "REDE"
  | "BUILD";

export interface ErrorEventRecord {
  id: string;
  timestamp: number;
  severity: ErrorSeverity;
  source: ErrorSource;
  route: string | null;
  message: string;
  stack: string | null;
  context: string | null;
  sessionId: string | null;
  signalId: string | null;
  resolved: boolean;
  occurrences: number;
  firstSeen: number;
  lastSeen: number;
}

const SEVERITIES: ErrorSeverity[] = ["INFO", "WARNING", "ERROR", "CRITICAL"];
const SOURCES: ErrorSource[] = [
  "FRONTEND",
  "BACKEND",
  "API",
  "T4",
  "CAPTURA",
  "CHART_CLOCK",
  "OCR",
  "GRAVACAO",
  "OLLAMA",
  "DB",
  "REDE",
  "BUILD",
];

function hash(text: string): string {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0).toString(36);
}

/**
 * CENTRAL DE ERROS — repositório (comando §3).
 * Erros repetidos são AGRUPADOS por (source + severity + mensagem): a linha
 * existente ganha occurrences+1 e lastSeen novo em vez de inundar a tabela.
 * Todo texto passa pela sanitização de segredos antes de persistir.
 */
export function recordError(input: {
  severity?: string;
  source?: string;
  route?: string | null;
  message: string;
  stack?: string | null;
  context?: unknown;
  sessionId?: string | null;
  signalId?: string | null;
  timestamp?: number;
}): ErrorEventRecord {
  const severity = SEVERITIES.includes(input.severity as ErrorSeverity)
    ? (input.severity as ErrorSeverity)
    : "ERROR";
  const source = SOURCES.includes(input.source as ErrorSource)
    ? (input.source as ErrorSource)
    : "BACKEND";
  const message = sanitizeSecrets(String(input.message ?? "Erro sem mensagem.")).slice(0, 2_000);
  const stack = input.stack ? sanitizeSecrets(String(input.stack)).slice(0, 8_000) : null;
  const context = input.context === undefined ? null : sanitizeUnknown(input.context);
  const timestamp = input.timestamp ?? Date.now();
  const groupKey = hash(`${source}|${severity}|${message}`);

  const database = getDatabase();
  const existing = database
    .prepare("SELECT id, occurrences FROM error_events WHERE group_key=? AND resolved=0 LIMIT 1")
    .get(groupKey) as { id: string; occurrences: number } | undefined;

  if (existing) {
    database
      .prepare(
        "UPDATE error_events SET occurrences=occurrences+1, last_seen=?, timestamp=?, stack=COALESCE(?, stack), context_json=COALESCE(?, context_json), route=COALESCE(?, route), session_id=COALESCE(?, session_id), signal_id=COALESCE(?, signal_id) WHERE id=?",
      )
      .run(
        timestamp,
        timestamp,
        stack,
        context,
        input.route ?? null,
        input.sessionId ?? null,
        input.signalId ?? null,
        existing.id,
      );
    return getError(existing.id)!;
  }

  const id = `err_${timestamp.toString(36)}_${groupKey}`;
  database
    .prepare(
      `INSERT INTO error_events(id, group_key, timestamp, severity, source, route, message, stack, context_json, session_id, signal_id, resolved, occurrences, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
    )
    .run(
      id,
      groupKey,
      timestamp,
      severity,
      source,
      input.route ?? null,
      message,
      stack,
      context,
      input.sessionId ?? null,
      input.signalId ?? null,
      timestamp,
      timestamp,
    );
  return getError(id)!;
}

function rowToRecord(row: Record<string, unknown>): ErrorEventRecord {
  return {
    id: String(row.id),
    timestamp: Number(row.timestamp),
    severity: row.severity as ErrorSeverity,
    source: row.source as ErrorSource,
    route: (row.route as string | null) ?? null,
    message: String(row.message),
    stack: (row.stack as string | null) ?? null,
    context: (row.context_json as string | null) ?? null,
    sessionId: (row.session_id as string | null) ?? null,
    signalId: (row.signal_id as string | null) ?? null,
    resolved: Number(row.resolved) === 1,
    occurrences: Number(row.occurrences),
    firstSeen: Number(row.first_seen),
    lastSeen: Number(row.last_seen),
  };
}

export function getError(id: string): ErrorEventRecord | null {
  const row = getDatabase().prepare("SELECT * FROM error_events WHERE id=?").get(id) as
    Record<string, unknown> | undefined;
  return row ? rowToRecord(row) : null;
}

export function listErrors(filter?: {
  source?: string;
  severity?: string;
  resolved?: boolean;
  limit?: number;
}): ErrorEventRecord[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filter?.source && SOURCES.includes(filter.source as ErrorSource)) {
    clauses.push("source=?");
    params.push(filter.source);
  }
  if (filter?.severity && SEVERITIES.includes(filter.severity as ErrorSeverity)) {
    clauses.push("severity=?");
    params.push(filter.severity);
  }
  if (filter?.resolved !== undefined) {
    clauses.push("resolved=?");
    params.push(filter.resolved ? 1 : 0);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  // limit não numérico (NaN) não pode derrubar a listagem com datatype mismatch.
  const limit = Number.isFinite(filter?.limit) ? Math.min(Math.max(1, filter!.limit!), 500) : 200;
  const rows = getDatabase()
    .prepare(`SELECT * FROM error_events ${where} ORDER BY last_seen DESC LIMIT ?`)
    .all(...params, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToRecord);
}

export function setErrorResolved(id: string, resolved: boolean): ErrorEventRecord | null {
  getDatabase()
    .prepare("UPDATE error_events SET resolved=? WHERE id=?")
    .run(resolved ? 1 : 0, id);
  return getError(id);
}

export function clearResolvedErrors(): number {
  const result = getDatabase().prepare("DELETE FROM error_events WHERE resolved=1").run();
  return Number(result.changes ?? 0);
}

export function errorSummary(): {
  today: number;
  critical: number;
  warnings: number;
  resolved: number;
  open: number;
} {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const database = getDatabase();
  const count = (sql: string, ...params: Array<string | number>) =>
    Number((database.prepare(sql).get(...params) as { n: number }).n);
  return {
    today: count("SELECT COUNT(*) AS n FROM error_events WHERE last_seen>=?", startOfDay.getTime()),
    critical: count(
      "SELECT COUNT(*) AS n FROM error_events WHERE severity='CRITICAL' AND resolved=0",
    ),
    warnings: count(
      "SELECT COUNT(*) AS n FROM error_events WHERE severity='WARNING' AND resolved=0",
    ),
    resolved: count("SELECT COUNT(*) AS n FROM error_events WHERE resolved=1"),
    open: count("SELECT COUNT(*) AS n FROM error_events WHERE resolved=0"),
  };
}
