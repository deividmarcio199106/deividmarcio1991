import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { getDatabase, getDataDir } from "./tradingRepository";

/**
 * GRAVAÇÃO — persistência progressiva (comando §9).
 *
 * Os chunks (1–5 s) chegam um a um e vão direto para disco em
 * DATA_DIR/recordings/<sessionId>/, com o manifesto no SQLite. Nunca montamos
 * o vídeo inteiro em RAM. O status GRAVANDO exibido na UI depende de três
 * fatos REAIS: MediaRecorder.state=recording no cliente + primeiro chunk
 * persistido aqui + sessão criada no banco.
 */

export interface RecordingSessionRecord {
  sessionId: string;
  liveSessionId: string | null;
  asset: string | null;
  mimeType: string | null;
  startedAt: number;
  endedAt: number | null;
  status: string;
  segment: number;
  error: string | null;
  recorderState: string | null;
}

export interface RecordingChunkRecord {
  sessionId: string;
  index: number;
  segment: number;
  startedAt: number;
  endedAt: number;
  mimeType: string | null;
  size: number;
  status: string;
}

export interface RecordingStatus {
  sessionId: string;
  recorderState: string | null;
  chunksSaved: number;
  bytesSaved: number;
  lastChunkAt: number | null;
  duration: number;
  status: string;
  error: string | null;
  segment: number;
  eventsSaved: number;
}

function recordingsDir(sessionId: string): string {
  const dir = join(getDataDir(), "recordings", sessionId.replace(/[^a-zA-Z0-9_-]/g, "_"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function createRecordingSession(record: {
  sessionId: string;
  liveSessionId?: string | null;
  asset?: string | null;
  mimeType?: string | null;
  startedAt: number;
}): void {
  const now = Date.now();
  getDatabase()
    .prepare(
      `INSERT INTO recording_sessions(session_id, live_session_id, asset, mime_type, started_at, ended_at, status, segment, error, recorder_state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, 'RECORDING', 0, NULL, 'recording', ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET status='RECORDING', updated_at=excluded.updated_at`,
    )
    .run(
      record.sessionId,
      record.liveSessionId ?? null,
      record.asset ?? null,
      record.mimeType ?? null,
      record.startedAt,
      now,
      now,
    );
}

export function saveRecordingChunk(
  meta: Omit<RecordingChunkRecord, "size" | "status">,
  bytes: Uint8Array,
): RecordingChunkRecord {
  if (bytes.byteLength === 0) {
    return { ...meta, size: 0, status: "EMPTY_DISCARDED" };
  }
  // A sessão precisa existir ANTES de qualquer byte ir para disco: sem isso,
  // um sessionId inexistente deixaria .webm.part órfão (enchimento de disco)
  // quando o INSERT com FK falhasse depois da escrita.
  const session = getDatabase()
    .prepare("SELECT 1 FROM recording_sessions WHERE session_id=?")
    .get(meta.sessionId);
  if (!session) {
    throw new Error(`Sessão de gravação inexistente: ${meta.sessionId}`);
  }
  const dir = recordingsDir(meta.sessionId);
  const filePath = join(dir, `${String(meta.index).padStart(6, "0")}.webm.part`);
  writeFileSync(filePath, bytes);
  const now = Date.now();
  getDatabase()
    .prepare(
      `INSERT INTO recording_chunks(session_id, idx, segment, started_at, ended_at, mime_type, size, status, file_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'SAVED', ?, ?)
       ON CONFLICT(session_id, idx) DO UPDATE SET size=excluded.size, status='SAVED', ended_at=excluded.ended_at`,
    )
    .run(
      meta.sessionId,
      meta.index,
      meta.segment,
      meta.startedAt,
      meta.endedAt,
      meta.mimeType,
      bytes.byteLength,
      filePath,
      now,
    );
  getDatabase()
    .prepare(
      "UPDATE recording_sessions SET updated_at=?, recorder_state='recording' WHERE session_id=?",
    )
    .run(now, meta.sessionId);
  return { ...meta, size: bytes.byteLength, status: "SAVED" };
}

export function updateRecordingSession(patch: {
  sessionId: string;
  status?: string;
  endedAt?: number | null;
  error?: string | null;
  recorderState?: string | null;
  segment?: number;
}): void {
  const current = getDatabase()
    .prepare("SELECT * FROM recording_sessions WHERE session_id=?")
    .get(patch.sessionId) as Record<string, unknown> | undefined;
  if (!current) return;
  getDatabase()
    .prepare(
      `UPDATE recording_sessions SET status=?, ended_at=?, error=?, recorder_state=?, segment=?, updated_at=? WHERE session_id=?`,
    )
    .run(
      patch.status ?? String(current.status),
      patch.endedAt !== undefined ? patch.endedAt : ((current.ended_at as number | null) ?? null),
      patch.error !== undefined ? patch.error : ((current.error as string | null) ?? null),
      patch.recorderState !== undefined
        ? patch.recorderState
        : ((current.recorder_state as string | null) ?? null),
      patch.segment !== undefined ? patch.segment : Number(current.segment ?? 0),
      Date.now(),
      patch.sessionId,
    );
}

export function saveRecordingEvent(event: {
  id: string;
  sessionId: string;
  realTimestamp: number;
  chartTimestamp: number | null;
  type: string;
  payload: unknown;
}): void {
  getDatabase()
    .prepare(
      `INSERT OR REPLACE INTO recording_events(id, session_id, real_timestamp, chart_timestamp, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.id,
      event.sessionId,
      event.realTimestamp,
      event.chartTimestamp,
      event.type,
      JSON.stringify(event.payload ?? null),
      Date.now(),
    );
}

export function getRecordingStatus(sessionId: string): RecordingStatus | null {
  const session = getDatabase()
    .prepare("SELECT * FROM recording_sessions WHERE session_id=?")
    .get(sessionId) as Record<string, unknown> | undefined;
  if (!session) return null;
  const chunkAgg = getDatabase()
    .prepare(
      "SELECT COUNT(*) AS chunks, COALESCE(SUM(size),0) AS bytes, MAX(created_at) AS last FROM recording_chunks WHERE session_id=? AND status='SAVED'",
    )
    .get(sessionId) as { chunks: number; bytes: number; last: number | null };
  const eventsAgg = getDatabase()
    .prepare("SELECT COUNT(*) AS events FROM recording_events WHERE session_id=?")
    .get(sessionId) as { events: number };
  const startedAt = Number(session.started_at);
  const endedAt = (session.ended_at as number | null) ?? null;
  return {
    sessionId,
    recorderState: (session.recorder_state as string | null) ?? null,
    chunksSaved: Number(chunkAgg.chunks),
    bytesSaved: Number(chunkAgg.bytes),
    lastChunkAt: chunkAgg.last === null ? null : Number(chunkAgg.last),
    duration: (endedAt ?? Date.now()) - startedAt,
    status: String(session.status),
    error: (session.error as string | null) ?? null,
    segment: Number(session.segment ?? 0),
    eventsSaved: Number(eventsAgg.events),
  };
}

/** Fecha a sessão validando bytes reais em disco — nunca marca FINALIZADA vazia. */
export function finalizeRecordingSession(input: {
  sessionId: string;
  endedAt: number;
}): RecordingStatus | null {
  const status = getRecordingStatus(input.sessionId);
  if (!status) return null;
  const chunkRows = getDatabase()
    .prepare("SELECT file_path FROM recording_chunks WHERE session_id=? AND status='SAVED'")
    .all(input.sessionId) as Array<{ file_path: string | null }>;
  let bytesOnDisk = 0;
  for (const row of chunkRows) {
    if (row.file_path && existsSync(row.file_path)) bytesOnDisk += statSync(row.file_path).size;
  }
  const ok = status.chunksSaved > 0 && bytesOnDisk > 0;
  updateRecordingSession({
    sessionId: input.sessionId,
    status: ok ? "COMPLETED" : "FAILED_EMPTY",
    endedAt: input.endedAt,
    recorderState: "inactive",
    error: ok ? null : "Gravação finalizada sem bytes válidos em disco.",
  });
  return getRecordingStatus(input.sessionId);
}
