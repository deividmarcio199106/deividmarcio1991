import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { MEETLY_COLORS, MEETLY_ROOM_WORDS } from "@/lib/meetly/rules";
import type {
  MeetlyMeetingInput,
  MeetlyMeetingSummary,
  MeetlyParticipant,
  MeetlyProfileInput,
  MeetlyUser,
} from "@/lib/meetly/types";

/**
 * PERSISTÊNCIA DO MEETLY.
 *
 * Banco próprio (`meetly.sqlite` dentro de DATA_DIR), separado do banco do
 * analisador: as reuniões não participam das migrações do T4 e um problema
 * aqui não encosta nos dados de operação.
 *
 * Equivalência com o Firestore do app original:
 *   users            → meetly_users
 *   meetings         → meetly_meetings
 *   meetings.userId  → meetly_participants (o anfitrião também é participante)
 */

function dataDir(): string {
  return resolve(process.env["DATA_DIR"]?.trim() || "./data");
}

function dbPath(): string {
  return process.env["MEETLY_DATABASE_PATH"]?.trim() || join(dataDir(), "meetly.sqlite");
}

let singleton: DatabaseSync | null = null;

function db(): DatabaseSync {
  if (singleton) return singleton;
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  // Só publica a conexão depois que tudo deu certo: uma falha passageira (disco
  // cheio, banco ocupado) não pode deixar um handle pela metade em cache até o
  // próximo restart. busy_timeout vem primeiro para valer na troca de journal.
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
    migrate(database);
  } catch (error) {
    database.close();
    throw error;
  }
  singleton = database;
  return database;
}

function migrate(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS meetly_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meetly_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES meetly_users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS meetly_sessions_user ON meetly_sessions(user_id);
    CREATE TABLE IF NOT EXISTS meetly_meetings (
      id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL REFERENCES meetly_users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      room TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meetly_participants (
      meeting_id TEXT NOT NULL REFERENCES meetly_meetings(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES meetly_users(id) ON DELETE CASCADE,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (meeting_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS meetly_participants_user ON meetly_participants(user_id);
  `);
}

/** Fecha o banco para os testes abrirem outro DATA_DIR. */
export function resetMeetlyRepositoryForTests(): void {
  singleton?.close();
  singleton = null;
}

/* ------------------------------------------------------------------------ *
 * USUÁRIOS E SESSÕES
 * ------------------------------------------------------------------------ */

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  phone: string;
  image_url: string;
  password_hash: string;
  created_at: number;
}

function toUser(row: UserRow): MeetlyUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    phone: row.phone,
    imageUrl: row.image_url,
    createdAt: row.created_at,
  };
}

export function createUser(input: {
  email: string;
  displayName: string;
  passwordHash: string;
}): MeetlyUser {
  const now = Date.now();
  const id = randomUUID();
  db()
    .prepare(
      `INSERT INTO meetly_users(id, email, display_name, phone, image_url, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, '', '', ?, ?, ?)`,
    )
    .run(id, input.email, input.displayName, input.passwordHash, now, now);
  return getUserById(id)!;
}

export function getUserById(id: string): MeetlyUser | null {
  const row = db().prepare("SELECT * FROM meetly_users WHERE id = ?").get(id) as
    UserRow | undefined;
  return row ? toUser(row) : null;
}

export function findUserByEmail(email: string): (MeetlyUser & { passwordHash: string }) | null {
  const row = db().prepare("SELECT * FROM meetly_users WHERE email = ?").get(email) as
    UserRow | undefined;
  return row ? { ...toUser(row), passwordHash: row.password_hash } : null;
}

export function getPasswordHash(userId: string): string | null {
  const row = db().prepare("SELECT password_hash FROM meetly_users WHERE id = ?").get(userId) as
    { password_hash: string } | undefined;
  return row?.password_hash ?? null;
}

export function updateUserProfile(userId: string, input: MeetlyProfileInput): MeetlyUser | null {
  db()
    .prepare(
      `UPDATE meetly_users SET display_name = ?, phone = ?, image_url = ?, updated_at = ? WHERE id = ?`,
    )
    .run(input.displayName, input.phone, input.imageUrl, Date.now(), userId);
  return getUserById(userId);
}

export function updateUserPassword(userId: string, passwordHash: string): void {
  db()
    .prepare("UPDATE meetly_users SET password_hash = ?, updated_at = ? WHERE id = ?")
    .run(passwordHash, Date.now(), userId);
}

export function createSession(tokenHash: string, userId: string, expiresAt: number): void {
  const now = Date.now();
  // Faxina barata a cada login: sessões vencidas não ficam acumulando.
  db().prepare("DELETE FROM meetly_sessions WHERE expires_at <= ?").run(now);
  db()
    .prepare(
      "INSERT INTO meetly_sessions(token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
    .run(tokenHash, userId, now, expiresAt);
}

export function getUserBySession(tokenHash: string, now = Date.now()): MeetlyUser | null {
  const row = db()
    .prepare(
      `SELECT u.* FROM meetly_sessions s JOIN meetly_users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(tokenHash, now) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function deleteSession(tokenHash: string): void {
  db().prepare("DELETE FROM meetly_sessions WHERE token_hash = ?").run(tokenHash);
}

/** Troca de senha derruba as outras sessões do usuário (mantém a atual). */
export function deleteOtherSessions(userId: string, keepTokenHash: string): void {
  db()
    .prepare("DELETE FROM meetly_sessions WHERE user_id = ? AND token_hash <> ?")
    .run(userId, keepTokenHash);
}

/* ------------------------------------------------------------------------ *
 * REUNIÕES
 * ------------------------------------------------------------------------ */

interface MeetingRow {
  id: string;
  host_id: string;
  host_name: string;
  title: string;
  content: string;
  date: string;
  time: string;
  room: string;
  color: string;
  created_at: number;
  updated_at: number;
  attendee_count: number;
}

const MEETING_SELECT = `
  SELECT m.*, h.display_name AS host_name,
    (SELECT COUNT(*) FROM meetly_participants c WHERE c.meeting_id = m.id) AS attendee_count
  FROM meetly_meetings m
  JOIN meetly_users h ON h.id = m.host_id`;

function toSummary(row: MeetingRow, viewerId: string): MeetlyMeetingSummary {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    date: row.date,
    time: row.time,
    color: row.color,
    room: row.room,
    hostId: row.host_id,
    hostName: row.host_name,
    isHost: row.host_id === viewerId,
    attendeeCount: Number(row.attendee_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ROOM_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** "<expressão>-r-<6 caracteres>", igual ao LinkPicker + getRandomString do Android. */
export function generateRoomName(): string {
  const word = MEETLY_ROOM_WORDS[randomInt(MEETLY_ROOM_WORDS.length)]!;
  const bytes = randomBytes(6);
  let suffix = "";
  for (const byte of bytes) suffix += ROOM_CHARS[byte % ROOM_CHARS.length];
  return `${word}-r-${suffix}`;
}

export function createMeeting(hostId: string, input: MeetlyMeetingInput): MeetlyMeetingSummary {
  const now = Date.now();
  const id = randomUUID();
  const color = MEETLY_COLORS[randomInt(MEETLY_COLORS.length)]!;
  const database = db();
  database.exec("BEGIN");
  try {
    database
      .prepare(
        `INSERT INTO meetly_meetings(id, host_id, title, content, date, time, room, color, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        hostId,
        input.title,
        input.content,
        input.date,
        input.time,
        generateRoomName(),
        color,
        now,
        now,
      );
    database
      .prepare("INSERT INTO meetly_participants(meeting_id, user_id, added_at) VALUES (?, ?, ?)")
      .run(id, hostId, now);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return getMeetingSummary(id, hostId)!;
}

export function getMeetingSummary(
  meetingId: string,
  viewerId: string,
): MeetlyMeetingSummary | null {
  const row = db().prepare(`${MEETING_SELECT} WHERE m.id = ?`).get(meetingId) as
    MeetingRow | undefined;
  return row ? toSummary(row, viewerId) : null;
}

/** Máximo de reuniões devolvidas na lista (as mais recentes por data). */
export const MEETING_LIST_LIMIT = 500;
/** Trecho da descrição na lista: o card mostra uma linha; o detalhe traz tudo. */
const LIST_CONTENT_CHARS = 200;

/**
 * Reuniões em que o usuário participa (o whereArrayContains("userId") do
 * original). Limitada e sem a descrição inteira, com a contagem feita por
 * JOIN agregado: a lista não pode virar uma consulta que trava o processo.
 */
export function listMeetingsForUser(
  userId: string,
  filter: { date?: string } = {},
): MeetlyMeetingSummary[] {
  const params: Array<string | number> = [userId];
  let where = "WHERE m.id IN (SELECT meeting_id FROM meetly_participants WHERE user_id = ?)";
  if (filter.date) {
    where += " AND m.date = ?";
    params.push(filter.date);
  }
  params.push(MEETING_LIST_LIMIT);
  const rows = db()
    .prepare(
      `SELECT m.id, m.host_id, m.title, substr(m.content, 1, ${LIST_CONTENT_CHARS}) AS content,
              m.date, m.time, m.room, m.color, m.created_at, m.updated_at,
              h.display_name AS host_name, COALESCE(c.total, 0) AS attendee_count
       FROM meetly_meetings m
       JOIN meetly_users h ON h.id = m.host_id
       LEFT JOIN (SELECT meeting_id, COUNT(*) AS total FROM meetly_participants GROUP BY meeting_id) c
         ON c.meeting_id = m.id
       ${where}
       ORDER BY m.date DESC, m.time DESC, m.created_at DESC
       LIMIT ?`,
    )
    .all(...params) as unknown as MeetingRow[];
  return rows.reverse().map((row) => toSummary(row, userId));
}

export function countHostedMeetings(hostId: string): number {
  const row = db()
    .prepare("SELECT COUNT(*) AS total FROM meetly_meetings WHERE host_id = ?")
    .get(hostId) as { total: number } | undefined;
  return Number(row?.total ?? 0);
}

export function isParticipant(meetingId: string, userId: string): boolean {
  return Boolean(
    db()
      .prepare("SELECT 1 FROM meetly_participants WHERE meeting_id = ? AND user_id = ?")
      .get(meetingId, userId),
  );
}

/**
 * Participantes da reunião. A foto NÃO vai embutida (cada uma pode ter ~100 KB
 * em base64): vai só o endereço de /api/meetly/users/:id/avatar, com a versão
 * para o cache do navegador. Assim o tamanho da resposta não cresce com as fotos.
 */
export function listParticipants(meetingId: string, hostId: string): MeetlyParticipant[] {
  const rows = db()
    .prepare(
      `SELECT u.id, u.email, u.display_name, u.updated_at, (u.image_url <> '') AS has_image
       FROM meetly_participants p JOIN meetly_users u ON u.id = p.user_id
       WHERE p.meeting_id = ?
       ORDER BY CASE WHEN u.id = ? THEN 0 ELSE 1 END, p.added_at ASC`,
    )
    .all(meetingId, hostId) as unknown as Array<{
    id: string;
    email: string;
    display_name: string;
    updated_at: number;
    has_image: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    imageUrl: row.has_image
      ? `/api/meetly/users/${encodeURIComponent(row.id)}/avatar?v=${row.updated_at}`
      : "",
    isHost: row.id === hostId,
  }));
}

/** Foto (data URL) do usuário, ou "" se não houver. */
export function getUserImage(userId: string): string {
  const row = db().prepare("SELECT image_url FROM meetly_users WHERE id = ?").get(userId) as
    { image_url: string } | undefined;
  return row?.image_url ?? "";
}

/** Os dois usuários estão em alguma reunião em comum? */
export function sharesMeeting(userA: string, userB: string): boolean {
  return Boolean(
    db()
      .prepare(
        `SELECT 1 FROM meetly_participants a
         JOIN meetly_participants b ON b.meeting_id = a.meeting_id
         WHERE a.user_id = ? AND b.user_id = ? LIMIT 1`,
      )
      .get(userA, userB),
  );
}

export function updateMeeting(meetingId: string, input: MeetlyMeetingInput): void {
  db()
    .prepare(
      `UPDATE meetly_meetings SET title = ?, content = ?, date = ?, time = ?, updated_at = ? WHERE id = ?`,
    )
    .run(input.title, input.content, input.date, input.time, Date.now(), meetingId);
}

export function deleteMeeting(meetingId: string): void {
  db().prepare("DELETE FROM meetly_meetings WHERE id = ?").run(meetingId);
}

function touchMeeting(meetingId: string): void {
  db().prepare("UPDATE meetly_meetings SET updated_at = ? WHERE id = ?").run(Date.now(), meetingId);
}

export function addParticipant(meetingId: string, userId: string): void {
  db()
    .prepare(
      "INSERT OR IGNORE INTO meetly_participants(meeting_id, user_id, added_at) VALUES (?, ?, ?)",
    )
    .run(meetingId, userId, Date.now());
  touchMeeting(meetingId);
}

export function countParticipants(meetingId: string): number {
  const row = db()
    .prepare("SELECT COUNT(*) AS total FROM meetly_participants WHERE meeting_id = ?")
    .get(meetingId) as { total: number } | undefined;
  return Number(row?.total ?? 0);
}

/**
 * Remove o participante e TROCA a sala de vídeo. No Jitsi público o nome da
 * sala é a única credencial: sem a troca, quem saiu (ou foi removido)
 * continuaria entrando na chamada pelo link antigo. Os demais recebem o link
 * novo no próximo carregamento da reunião.
 */
export function removeParticipant(meetingId: string, userId: string): void {
  const database = db();
  database.exec("BEGIN");
  try {
    database
      .prepare("DELETE FROM meetly_participants WHERE meeting_id = ? AND user_id = ?")
      .run(meetingId, userId);
    database
      .prepare("UPDATE meetly_meetings SET room = ?, updated_at = ? WHERE id = ?")
      .run(generateRoomName(), Date.now(), meetingId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
