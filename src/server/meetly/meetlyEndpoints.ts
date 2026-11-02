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
  readSessionToken,
  SESSION_TTL_MS,
  sessionCookie,
  verifyPassword,
} from "./meetlyAuth";
import { clientIp, meetlyLimits, resetMeetlyLimits } from "./meetlyRateLimit";
import {
  addParticipant,
  countParticipants,
  createMeeting,
  createSession,
  createUser,
  deleteMeeting,
  deleteOtherSessions,
  deleteSession,
  findUserByEmail,
  getMeetingSummary,
  getPasswordHash,
  getUserImage,
  getUserBySession,
  isParticipant,
  listMeetingsForUser,
  listParticipants,
  removeParticipant,
  sharesMeeting,
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
 * GET    /api/meetly/users/:id/avatar          foto de quem divide reunião comigo
 * PUT    /api/meetly/meetings/:id              edita (anfitrião)
 * DELETE /api/meetly/meetings/:id              exclui (anfitrião)
 * POST   /api/meetly/meetings/:id/participants anfitrião convida por e-mail
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

const TOO_MANY = "Muitas tentativas. Aguarde alguns minutos e tente de novo.";

/** Só para testes: zera os contadores de tentativa. */
export function resetMeetlyRateLimitForTests(): void {
  resetMeetlyLimits();
}

/* ------------------------------ helpers ----------------------------- */

export function jitsiDomain(): string {
  const configured = process.env["MEETLY_JITSI_DOMAIN"]?.trim().toLowerCase();
  if (configured && /^[a-z0-9.-]+(:\d{1,5})?$/.test(configured)) return configured;
  return DEFAULT_JITSI_DOMAIN;
}

function currentSession(request: Request): { user: MeetlyUser; tokenHash: string } | null {
  const token = readSessionToken(request);
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

/** Segmento de URL decodificado, ou null se o percent-encoding for inválido. */
function pathSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
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
      const ip = clientIp(request);
      if (meetlyLimits.authVolumeByIp.consume(ip)) return fail(429, TOO_MANY);
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
      // Conta TODA tentativa válida, inclusive o 409: o cadastro também serve
      // para descobrir se um e-mail tem conta, e isso precisa de teto por IP.
      if (meetlyLimits.registerByIp.consume(ip)) return fail(429, TOO_MANY);
      if (findUserByEmail(email)) return fail(409, "Já existe uma conta com este e-mail.");
      const passwordHash = await hashPassword(password);
      let user: MeetlyUser;
      try {
        user = createUser({ email, displayName: name, passwordHash });
      } catch (error) {
        // Dois cadastros simultâneos com o mesmo e-mail: o segundo perde no UNIQUE.
        if (isUniqueViolation(error)) return fail(409, "Já existe uma conta com este e-mail.");
        throw error;
      }
      return startSession(request, user, 201);
    }

    if (method === "POST" && path === "/api/meetly/auth/login") {
      const ip = clientIp(request);
      if (meetlyLimits.authVolumeByIp.consume(ip)) return fail(429, TOO_MANY);
      const body = await readBody(request);
      const email = normalizeEmail(str(body, "email"));
      const password = str(body, "password");
      // Valida ANTES de qualquer contador: requisição malformada não custa nada
      // a ninguém e não vira chave guardada em memória.
      if (!email || !password) return fail(400, "Informe e-mail e senha!");
      if (!isValidEmail(email)) return fail(400, "Informe um e-mail válido!");
      if (password.length > MEETLY_LIMITS.passwordMax) {
        return fail(401, "E-mail ou senha incorretos, ou conta inexistente!");
      }
      const pairKey = `${ip}|${email}`;
      if (
        meetlyLimits.loginFailByIpEmail.isLimited(pairKey) ||
        meetlyLimits.loginFailByIp.isLimited(ip) ||
        meetlyLimits.loginFailByEmail.isLimited(email)
      ) {
        return fail(429, TOO_MANY);
      }
      const found = findUserByEmail(email);
      const ok = await verifyPassword(password, found?.passwordHash ?? (await dummyPasswordHash()));
      if (!found || !ok) {
        // Só a FALHA conta. Quem apenas conhece o e-mail de alguém não consegue
        // bloquear o login dessa pessoa a partir de outro IP.
        meetlyLimits.loginFailByIpEmail.hit(pairKey);
        meetlyLimits.loginFailByIp.hit(ip);
        meetlyLimits.loginFailByEmail.hit(email);
        return fail(401, "E-mail ou senha incorretos, ou conta inexistente!");
      }
      meetlyLimits.loginFailByIpEmail.reset(pairKey);
      const { passwordHash: _ignored, ...user } = found;
      return startSession(request, user);
    }

    if (method === "POST" && path === "/api/meetly/auth/logout") {
      const token = readSessionToken(request);
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
      if (meetlyLimits.authVolumeByIp.consume(clientIp(request))) return fail(429, TOO_MANY);
      if (meetlyLimits.passwordFailByUser.isLimited(me.id)) return fail(429, TOO_MANY);
      const body = await readBody(request);
      const currentPassword = str(body, "currentPassword");
      const newPassword = str(body, "newPassword");
      const stored = getPasswordHash(me.id);
      if (
        !stored ||
        !currentPassword ||
        currentPassword.length > MEETLY_LIMITS.passwordMax ||
        !(await verifyPassword(currentPassword, stored))
      ) {
        meetlyLimits.passwordFailByUser.hit(me.id);
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

    const avatarMatch = /^\/api\/meetly\/users\/([^/]+)\/avatar$/.exec(path);
    if (avatarMatch && method === "GET") {
      const userId = pathSegment(avatarMatch[1]!);
      // Só a própria foto ou a de quem divide uma reunião comigo; o resto é 404.
      if (!userId || (userId !== me.id && !sharesMeeting(me.id, userId))) {
        return fail(404, "Foto não encontrada.");
      }
      const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+=*)$/.exec(
        getUserImage(userId),
      );
      if (!match) return fail(404, "Foto não encontrada.");
      return new Response(Buffer.from(match[2]!, "base64"), {
        status: 200,
        headers: {
          "content-type": match[1]!,
          "x-content-type-options": "nosniff",
          "cache-control": "private, max-age=86400",
          "content-security-policy": "default-src 'none'; sandbox",
        },
      });
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
      const meetingId = pathSegment(meetingMatch[1]!);
      const participantsPath = path.includes("/participants");
      const targetUserId = meetingMatch[2] ? pathSegment(meetingMatch[2]) : null;
      if (meetingId === null || (meetingMatch[2] && targetUserId === null)) {
        return fail(404, "Reunião não encontrada.");
      }

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
        // Só o anfitrião controla quem participa. Se qualquer participante
        // pudesse convidar, alguém removido voltaria por uma segunda conta.
        if (!summary.isHost) return fail(403, "Só o anfitrião pode convidar participantes.");
        const email = normalizeEmail(str(await readBody(request), "email"));
        if (!email || !isValidEmail(email)) return fail(400, "Informe um e-mail válido!");
        // Teto de convites: sem ele, convidar e remover vira uma consulta em
        // massa de "este e-mail tem conta?".
        if (meetlyLimits.inviteByUser.consume(me.id)) return fail(429, TOO_MANY);
        if (countParticipants(meetingId) >= MEETLY_LIMITS.participantsMax) {
          return fail(400, `Limite de ${MEETLY_LIMITS.participantsMax} participantes atingido.`);
        }
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
