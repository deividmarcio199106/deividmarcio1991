import {
  isValidDate,
  isValidEmail,
  isValidImageUrl,
  isValidPhone,
  isValidTime,
  MEETLY_LIMITS,
  normalizeEmail,
} from "@/lib/meetly/rules";
import type { MeetlyMeetingDetail, MeetlyMeetingInput, MeetlyUser } from "@/lib/meetly/types";

import {
  clearSessionCookie,
  dummyPasswordHash,
  hashPassword,
  hashSessionToken,
  newSessionToken,
  readCookie,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  sessionCookie,
  verifyPassword,
} from "./meetlyAuth";
import {
  addParticipant,
  createMeeting,
  createSession,
  createUser,
  deleteMeeting,
  deleteOtherSessions,
  deleteSession,
  findUserByEmail,
  getMeetingSummary,
  getPasswordHash,
  getUserBySession,
  isParticipant,
  listMeetingsForUser,
  listParticipants,
  removeParticipant,
  updateMeeting,
  updateUserPassword,
  updateUserProfile,
} from "./meetlyRepository";

/**
 * API DO MEETLY — servida antes do SSR, como /api/trading.
 *
 * POST   /api/meetly/auth/register             cria conta e já entra
 * POST   /api/meetly/auth/login                entra (cookie de sessão)
 * POST   /api/meetly/auth/logout               sai
 * GET    /api/meetly/me                        usuário logado
 * PUT    /api/meetly/me                        atualiza nome/telefone/foto
 * PUT    /api/meetly/me/password               troca a senha
 * GET    /api/meetly/meetings[?date=]          minhas reuniões (filtro por dia)
 * POST   /api/meetly/meetings                  agenda reunião
 * GET    /api/meetly/meetings/:id              detalhe + participantes
 * PUT    /api/meetly/meetings/:id              edita (anfitrião)
 * DELETE /api/meetly/meetings/:id              exclui (anfitrião)
 * POST   /api/meetly/meetings/:id/participants adiciona por e-mail
 * DELETE /api/meetly/meetings/:id/participants/:userId
 *        anfitrião remove alguém; participante remove a si mesmo (sair)
 *
 * Toda requisição que muda estado exige o cabeçalho `x-requested-with: meetly`.
 * Um site de terceiros não consegue enviá-lo sem preflight CORS — que esta API
 * nunca autoriza —, então o cookie de sessão não pode ser usado por CSRF.
 */

const MAX_BODY_CHARS = 300_000;
const DEFAULT_JITSI_DOMAIN = "meet.jit.si";

function json(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function fail(status: number, error: string): Response {
  return json({ error }, status);
}

class BadRequest extends Error {}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) throw new BadRequest("Requisição grande demais.");
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // cai no erro abaixo
  }
  throw new BadRequest("Corpo da requisição inválido.");
}

function str(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}

/* ---------------------------- rate limit ---------------------------- */

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;
const buckets = new Map<string, number[]>();

function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

function rateLimited(key: string): boolean {
  const now = Date.now();
  const bucket = (buckets.get(key) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
  bucket.push(now);
  buckets.set(key, bucket);
  if (buckets.size > 10_000) {
    for (const [k, v] of buckets)
      if (v.every((at) => now - at >= RATE_WINDOW_MS)) buckets.delete(k);
  }
  return bucket.length > RATE_MAX;
}

/** Só para testes: zera o contador de tentativas. */
export function resetMeetlyRateLimitForTests(): void {
  buckets.clear();
}

/* ------------------------------ helpers ----------------------------- */

export function jitsiDomain(): string {
  const configured = process.env["MEETLY_JITSI_DOMAIN"]?.trim().toLowerCase();
  if (configured && /^[a-z0-9.-]+(:\d{1,5})?$/.test(configured)) return configured;
  return DEFAULT_JITSI_DOMAIN;
}

function currentSession(request: Request): { user: MeetlyUser; tokenHash: string } | null {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const user = getUserBySession(tokenHash);
  return user ? { user, tokenHash } : null;
}

function startSession(request: Request, user: MeetlyUser, status = 200): Response {
  const token = newSessionToken();
  createSession(hashSessionToken(token), user.id, Date.now() + SESSION_TTL_MS);
  return json({ user }, status, { "set-cookie": sessionCookie(request, token, SESSION_TTL_MS) });
}

function validateMeetingInput(body: Record<string, unknown>): MeetlyMeetingInput | string {
  const title = str(body, "title").trim();
  const content = str(body, "content").trim();
  const date = str(body, "date").trim();
  const time = str(body, "time").trim();
  if (!title) return "O título é obrigatório.";
  if (title.length > MEETLY_LIMITS.titleMax) return "Título longo demais.";
  if (!content) return "A descrição é obrigatória.";
  if (content.length > MEETLY_LIMITS.contentMax) return "Descrição longa demais.";
  if (!isValidDate(date)) return "Informe uma data válida.";
  if (!isValidTime(time)) return "Informe um horário válido.";
  return { title, content, date, time };
}

function meetingDetail(meetingId: string, viewerId: string): MeetlyMeetingDetail | null {
  const summary = getMeetingSummary(meetingId, viewerId);
  if (!summary) return null;
  const domain = jitsiDomain();
  return {
    ...summary,
    participants: listParticipants(meetingId, summary.hostId),
    jitsiDomain: domain,
    joinUrl: `https://${domain}/${encodeURIComponent(summary.room)}`,
  };
}

/* ------------------------------ handler ----------------------------- */

export async function handleMeetlyRequest(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path !== "/api/meetly" && !path.startsWith("/api/meetly/")) return null;

  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    if (request.headers.get("x-requested-with") !== "meetly") {
      return fail(403, "Requisição recusada.");
    }
  }

  try {
    /* ----------------------------- auth ----------------------------- */
    if (method === "POST" && path === "/api/meetly/auth/register") {
      if (rateLimited(`register:${clientIp(request)}`)) {
        return fail(429, "Muitas tentativas. Aguarde um minuto.");
      }
      const body = await readBody(request);
      const name = str(body, "name").trim();
      const email = normalizeEmail(str(body, "email"));
      const password = str(body, "password");
      if (!name) return fail(400, "Informe o nome!");
      if (name.length > MEETLY_LIMITS.nameMax) return fail(400, "Nome longo demais.");
      if (!email) return fail(400, "Informe o e-mail!");
      if (!isValidEmail(email)) return fail(400, "Informe um e-mail válido!");
      if (password.length < MEETLY_LIMITS.passwordMin) {
        return fail(400, `A senha precisa ter pelo menos ${MEETLY_LIMITS.passwordMin} caracteres!`);
      }
      if (password.length > MEETLY_LIMITS.passwordMax) return fail(400, "Senha longa demais.");
      if (findUserByEmail(email)) return fail(409, "Já existe uma conta com este e-mail.");
      const user = createUser({
        email,
        displayName: name,
        passwordHash: await hashPassword(password),
      });
      return startSession(request, user, 201);
    }

    if (method === "POST" && path === "/api/meetly/auth/login") {
      const body = await readBody(request);
      const email = normalizeEmail(str(body, "email"));
      const password = str(body, "password");
      if (rateLimited(`login:${clientIp(request)}`) || rateLimited(`login-email:${email}`)) {
        return fail(429, "Muitas tentativas. Aguarde um minuto.");
      }
      if (!email || !password) return fail(400, "Informe e-mail e senha!");
      const found = findUserByEmail(email);
      const ok = await verifyPassword(
        password.slice(0, MEETLY_LIMITS.passwordMax),
        found?.passwordHash ?? (await dummyPasswordHash()),
      );
      if (!found || !ok) return fail(401, "E-mail ou senha incorretos, ou conta inexistente!");
      const { passwordHash: _ignored, ...user } = found;
      return startSession(request, user);
    }

    if (method === "POST" && path === "/api/meetly/auth/logout") {
      const token = readCookie(request, SESSION_COOKIE);
      if (token) deleteSession(hashSessionToken(token));
      return json({ ok: true }, 200, { "set-cookie": clearSessionCookie(request) });
    }

    /* ---------------- daqui pra baixo: só logado ---------------- */
    const session = currentSession(request);
    if (!session) return fail(401, "Faça login para continuar.");
    const me = session.user;

    if (path === "/api/meetly/me") {
      if (method === "GET") return json({ user: me });
      if (method === "PUT") {
        const body = await readBody(request);
        const displayName = str(body, "displayName").trim();
        const phone = str(body, "phone").trim();
        const imageUrl = str(body, "imageUrl");
        if (!displayName) return fail(400, "Informe o nome!");
        if (displayName.length > MEETLY_LIMITS.nameMax) return fail(400, "Nome longo demais.");
        if (!isValidPhone(phone)) return fail(400, "Telefone inválido.");
        if (!isValidImageUrl(imageUrl)) return fail(400, "Foto inválida ou grande demais.");
        const user = updateUserProfile(me.id, { displayName, phone, imageUrl });
        return json({ user });
      }
    }

    if (method === "PUT" && path === "/api/meetly/me/password") {
      if (rateLimited(`password:${me.id}`)) {
        return fail(429, "Muitas tentativas. Aguarde um minuto.");
      }
      const body = await readBody(request);
      const currentPassword = str(body, "currentPassword");
      const newPassword = str(body, "newPassword");
      const stored = getPasswordHash(me.id);
      if (!stored || !(await verifyPassword(currentPassword, stored))) {
        return fail(400, "Senha atual incorreta.");
      }
      if (newPassword.length < MEETLY_LIMITS.passwordMin) {
        return fail(
          400,
          `A nova senha precisa ter pelo menos ${MEETLY_LIMITS.passwordMin} caracteres!`,
        );
      }
      if (newPassword.length > MEETLY_LIMITS.passwordMax) return fail(400, "Senha longa demais.");
      updateUserPassword(me.id, await hashPassword(newPassword));
      deleteOtherSessions(me.id, session.tokenHash);
      return json({ ok: true });
    }

    /* --------------------------- reuniões --------------------------- */
    if (path === "/api/meetly/meetings") {
      if (method === "GET") {
        const date = url.searchParams.get("date")?.trim() ?? "";
        if (date && !isValidDate(date)) return fail(400, "Data inválida.");
        return json({ meetings: listMeetingsForUser(me.id, { date: date || undefined }) });
      }
      if (method === "POST") {
        const input = validateMeetingInput(await readBody(request));
        if (typeof input === "string") return fail(400, input);
        const created = createMeeting(me.id, input);
        return json({ meeting: meetingDetail(created.id, me.id) }, 201);
      }
    }

    const meetingMatch = /^\/api\/meetly\/meetings\/([^/]+)(?:\/participants(?:\/([^/]+))?)?$/.exec(
      path,
    );
    if (meetingMatch) {
      const meetingId = decodeURIComponent(meetingMatch[1]!);
      const participantsPath = path.includes("/participants");
      const targetUserId = meetingMatch[2] ? decodeURIComponent(meetingMatch[2]) : null;

      // Quem não participa recebe 404 — nem a existência da reunião vaza.
      if (!isParticipant(meetingId, me.id)) return fail(404, "Reunião não encontrada.");
      const summary = getMeetingSummary(meetingId, me.id);
      if (!summary) return fail(404, "Reunião não encontrada.");

      if (!participantsPath) {
        if (method === "GET") return json({ meeting: meetingDetail(meetingId, me.id) });
        if (method === "PUT") {
          if (!summary.isHost) return fail(403, "Só o anfitrião pode editar a reunião.");
          const input = validateMeetingInput(await readBody(request));
          if (typeof input === "string") return fail(400, input);
          updateMeeting(meetingId, input);
          return json({ meeting: meetingDetail(meetingId, me.id) });
        }
        if (method === "DELETE") {
          if (!summary.isHost) return fail(403, "Só o anfitrião pode excluir a reunião.");
          deleteMeeting(meetingId);
          return json({ ok: true });
        }
      } else if (!targetUserId && method === "POST") {
        const email = normalizeEmail(str(await readBody(request), "email"));
        if (!email || !isValidEmail(email)) return fail(400, "Informe um e-mail válido!");
        const invited = findUserByEmail(email);
        if (!invited) return fail(404, "Este usuário não tem conta no Meetly!");
        if (isParticipant(meetingId, invited.id)) return fail(409, "Usuário já participa!");
        addParticipant(meetingId, invited.id);
        return json({ meeting: meetingDetail(meetingId, me.id) });
      } else if (targetUserId && method === "DELETE") {
        if (targetUserId === summary.hostId) {
          return fail(
            400,
            summary.isHost
              ? "Você é o anfitrião: para sair, exclua a reunião."
              : "O anfitrião não pode ser removido.",
          );
        }
        if (!summary.isHost && targetUserId !== me.id) {
          return fail(403, "Só o anfitrião pode remover participantes.");
        }
        if (!isParticipant(meetingId, targetUserId)) {
          return fail(404, "Participante não encontrado.");
        }
        removeParticipant(meetingId, targetUserId);
        return json({
          meeting: targetUserId === me.id ? null : meetingDetail(meetingId, me.id),
        });
      }
    }

    return fail(404, "Rota do Meetly não encontrada.");
  } catch (error) {
    if (error instanceof BadRequest) return fail(400, error.message);
    throw error;
  }
}
