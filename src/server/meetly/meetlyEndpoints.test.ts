import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MeetlyMeetingDetail, MeetlyMeetingSummary, MeetlyUser } from "@/lib/meetly/types";

import { handleMeetlyRequest, resetMeetlyRateLimitForTests } from "./meetlyEndpoints";
import { generateRoomName, resetMeetlyRepositoryForTests } from "./meetlyRepository";

let workingDir: string | null = null;

beforeEach(() => {
  resetMeetlyRepositoryForTests();
  resetMeetlyRateLimitForTests();
  workingDir = mkdtempSync(join(tmpdir(), "meetly-"));
  process.env.DATA_DIR = workingDir;
  delete process.env.MEETLY_DATABASE_PATH;
  delete process.env.MEETLY_JITSI_DOMAIN;
});

afterEach(() => {
  resetMeetlyRepositoryForTests();
  if (workingDir) rmSync(workingDir, { recursive: true, force: true });
  workingDir = null;
  delete process.env.DATA_DIR;
  delete process.env.MEETLY_JITSI_DOMAIN;
});

interface CallResult<T> {
  status: number;
  body: T & { error?: string };
  cookie: string | null;
}

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  options: { body?: unknown; cookie?: string | null; csrf?: boolean } = {},
): Promise<CallResult<T>> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.csrf !== false) headers["x-requested-with"] = "meetly";
  if (options.cookie) headers["cookie"] = options.cookie;
  const response = await handleMeetlyRequest(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
  );
  if (!response) throw new Error(`rota não tratada: ${path}`);
  const setCookie = response.headers.get("set-cookie");
  return {
    status: response.status,
    body: (await response.json()) as T & { error?: string },
    cookie: setCookie ? setCookie.split(";")[0]! : null,
  };
}

async function register(name: string, email: string, password = "segredo123") {
  const result = await call<{ user: MeetlyUser }>("POST", "/api/meetly/auth/register", {
    body: { name, email, password },
  });
  expect(result.status).toBe(201);
  return { user: result.body.user, cookie: result.cookie! };
}

const meetingInput = {
  title: "Planejamento semanal",
  content: "Revisar metas da semana",
  date: "2026-11-03",
  time: "14:30",
};

describe.sequential("Meetly — contas e sessão", () => {
  it("ignora rotas fora de /api/meetly", async () => {
    const response = await handleMeetlyRequest(new Request("http://localhost/api/trading/x"));
    expect(response).toBeNull();
  });

  it("cadastra, entra, consulta /me e sai", async () => {
    const { user, cookie } = await register("Ana", "Ana@Example.com");
    expect(user.email).toBe("ana@example.com");
    expect(cookie).toMatch(/^meetly_session=/);

    const me = await call<{ user: MeetlyUser }>("GET", "/api/meetly/me", { cookie });
    expect(me.status).toBe(200);
    expect(me.body.user.displayName).toBe("Ana");

    const logout = await call("POST", "/api/meetly/auth/logout", { cookie });
    expect(logout.status).toBe(200);
    expect((await call("GET", "/api/meetly/me", { cookie })).status).toBe(401);

    const login = await call<{ user: MeetlyUser }>("POST", "/api/meetly/auth/login", {
      body: { email: "ANA@example.com", password: "segredo123" },
    });
    expect(login.status).toBe(200);
    expect(login.cookie).toMatch(/^meetly_session=/);
  });

  it("recusa senha errada, e-mail duplicado e dados inválidos", async () => {
    await register("Ana", "ana@example.com");
    const wrong = await call("POST", "/api/meetly/auth/login", {
      body: { email: "ana@example.com", password: "errada123" },
    });
    expect(wrong.status).toBe(401);

    const unknown = await call("POST", "/api/meetly/auth/login", {
      body: { email: "ninguem@example.com", password: "qualquer1" },
    });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error).toBe(wrong.body.error);

    const dup = await call("POST", "/api/meetly/auth/register", {
      body: { name: "Outra", email: "ana@example.com", password: "segredo123" },
    });
    expect(dup.status).toBe(409);

    const shortPassword = await call("POST", "/api/meetly/auth/register", {
      body: { name: "Bia", email: "bia@example.com", password: "123" },
    });
    expect(shortPassword.status).toBe(400);

    const badEmail = await call("POST", "/api/meetly/auth/register", {
      body: { name: "Bia", email: "bia-sem-arroba", password: "segredo123" },
    });
    expect(badEmail.status).toBe(400);
  });

  it("exige o cabeçalho anti-CSRF em requisições que mudam estado", async () => {
    const result = await call("POST", "/api/meetly/auth/register", {
      body: { name: "Ana", email: "ana@example.com", password: "segredo123" },
      csrf: false,
    });
    expect(result.status).toBe(403);
  });

  it("limita tentativas de login", async () => {
    await register("Ana", "ana@example.com");
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (
        await call("POST", "/api/meetly/auth/login", {
          body: { email: "ana@example.com", password: "errada123" },
        })
      ).status;
    }
    expect(last).toBe(429);
  });

  it("atualiza perfil e valida foto e telefone", async () => {
    const { cookie } = await register("Ana", "ana@example.com");
    const ok = await call<{ user: MeetlyUser }>("PUT", "/api/meetly/me", {
      cookie,
      body: { displayName: "Ana Paula", phone: "+55 11 99999-0000", imageUrl: "" },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.user.displayName).toBe("Ana Paula");
    expect(ok.body.user.phone).toBe("+55 11 99999-0000");

    const badImage = await call("PUT", "/api/meetly/me", {
      cookie,
      body: { displayName: "Ana", phone: "", imageUrl: "javascript:alert(1)" },
    });
    expect(badImage.status).toBe(400);

    const badPhone = await call("PUT", "/api/meetly/me", {
      cookie,
      body: { displayName: "Ana", phone: "<script>", imageUrl: "" },
    });
    expect(badPhone.status).toBe(400);
  });

  it("troca a senha e derruba as outras sessões", async () => {
    const { cookie } = await register("Ana", "ana@example.com");
    const other = await call("POST", "/api/meetly/auth/login", {
      body: { email: "ana@example.com", password: "segredo123" },
    });

    const wrong = await call("PUT", "/api/meetly/me/password", {
      cookie,
      body: { currentPassword: "errada", newPassword: "novasenha1" },
    });
    expect(wrong.status).toBe(400);

    const changed = await call("PUT", "/api/meetly/me/password", {
      cookie,
      body: { currentPassword: "segredo123", newPassword: "novasenha1" },
    });
    expect(changed.status).toBe(200);
    expect((await call("GET", "/api/meetly/me", { cookie })).status).toBe(200);
    expect((await call("GET", "/api/meetly/me", { cookie: other.cookie })).status).toBe(401);

    const relogin = await call("POST", "/api/meetly/auth/login", {
      body: { email: "ana@example.com", password: "novasenha1" },
    });
    expect(relogin.status).toBe(200);
  });
});

describe.sequential("Meetly — reuniões e participantes", () => {
  it("agenda, lista, filtra por data, edita e exclui", async () => {
    const { cookie } = await register("Ana", "ana@example.com");

    const created = await call<{ meeting: MeetlyMeetingDetail }>("POST", "/api/meetly/meetings", {
      cookie,
      body: meetingInput,
    });
    expect(created.status).toBe(201);
    const meeting = created.body.meeting;
    expect(meeting.isHost).toBe(true);
    expect(meeting.attendeeCount).toBe(1);
    expect(meeting.room).toMatch(/^[a-z-]+-r-[A-Za-z0-9]{6}$/);
    expect(meeting.joinUrl).toBe(`https://meet.jit.si/${meeting.room}`);

    await call("POST", "/api/meetly/meetings", {
      cookie,
      body: { ...meetingInput, title: "Outra", date: "2026-11-04" },
    });

    const all = await call<{ meetings: MeetlyMeetingSummary[] }>("GET", "/api/meetly/meetings", {
      cookie,
    });
    expect(all.body.meetings).toHaveLength(2);

    const filtered = await call<{ meetings: MeetlyMeetingSummary[] }>(
      "GET",
      "/api/meetly/meetings?date=2026-11-03",
      { cookie },
    );
    expect(filtered.body.meetings.map((m) => m.title)).toEqual(["Planejamento semanal"]);

    const edited = await call<{ meeting: MeetlyMeetingDetail }>(
      "PUT",
      `/api/meetly/meetings/${meeting.id}`,
      { cookie, body: { ...meetingInput, title: "Planejamento mensal", time: "09:00" } },
    );
    expect(edited.status).toBe(200);
    expect(edited.body.meeting.title).toBe("Planejamento mensal");
    expect(edited.body.meeting.room).toBe(meeting.room);

    const removed = await call("DELETE", `/api/meetly/meetings/${meeting.id}`, { cookie });
    expect(removed.status).toBe(200);
    const after = await call<{ meetings: MeetlyMeetingSummary[] }>("GET", "/api/meetly/meetings", {
      cookie,
    });
    expect(after.body.meetings).toHaveLength(1);
  });

  it("valida os campos da reunião", async () => {
    const { cookie } = await register("Ana", "ana@example.com");
    for (const body of [
      { ...meetingInput, title: "" },
      { ...meetingInput, content: "  " },
      { ...meetingInput, date: "2026-02-30" },
      { ...meetingInput, time: "25:00" },
    ]) {
      const result = await call("POST", "/api/meetly/meetings", { cookie, body });
      expect(result.status).toBe(400);
    }
  });

  it("adiciona participante por e-mail e respeita as permissões", async () => {
    const ana = await register("Ana", "ana@example.com");
    const bruno = await register("Bruno", "bruno@example.com");
    const carla = await register("Carla", "carla@example.com");

    const created = await call<{ meeting: MeetlyMeetingDetail }>("POST", "/api/meetly/meetings", {
      cookie: ana.cookie,
      body: meetingInput,
    });
    const id = created.body.meeting.id;

    // Quem não participa nem enxerga a reunião.
    expect((await call("GET", `/api/meetly/meetings/${id}`, { cookie: bruno.cookie })).status).toBe(
      404,
    );

    const missing = await call("POST", `/api/meetly/meetings/${id}/participants`, {
      cookie: ana.cookie,
      body: { email: "naoexiste@example.com" },
    });
    expect(missing.status).toBe(404);

    const added = await call<{ meeting: MeetlyMeetingDetail }>(
      "POST",
      `/api/meetly/meetings/${id}/participants`,
      { cookie: ana.cookie, body: { email: "BRUNO@example.com" } },
    );
    expect(added.status).toBe(200);
    expect(added.body.meeting.attendeeCount).toBe(2);
    expect(added.body.meeting.participants.map((p) => p.displayName)).toEqual(["Ana", "Bruno"]);

    const again = await call("POST", `/api/meetly/meetings/${id}/participants`, {
      cookie: ana.cookie,
      body: { email: "bruno@example.com" },
    });
    expect(again.status).toBe(409);

    // Bruno agora vê a reunião, pode convidar, mas não edita, não exclui e não remove ninguém.
    const brunoView = await call<{ meeting: MeetlyMeetingDetail }>(
      "GET",
      `/api/meetly/meetings/${id}`,
      { cookie: bruno.cookie },
    );
    expect(brunoView.body.meeting.isHost).toBe(false);
    expect(brunoView.body.meeting.hostName).toBe("Ana");
    const brunoInvites = await call("POST", `/api/meetly/meetings/${id}/participants`, {
      cookie: bruno.cookie,
      body: { email: "carla@example.com" },
    });
    expect(brunoInvites.status).toBe(200);
    expect(
      (
        await call("PUT", `/api/meetly/meetings/${id}`, {
          cookie: bruno.cookie,
          body: meetingInput,
        })
      ).status,
    ).toBe(403);
    expect(
      (await call("DELETE", `/api/meetly/meetings/${id}`, { cookie: bruno.cookie })).status,
    ).toBe(403);
    expect(
      (
        await call("DELETE", `/api/meetly/meetings/${id}/participants/${carla.user.id}`, {
          cookie: bruno.cookie,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call("DELETE", `/api/meetly/meetings/${id}/participants/${ana.user.id}`, {
          cookie: bruno.cookie,
        })
      ).status,
    ).toBe(400);

    // Bruno sai da reunião; a anfitriã remove a Carla.
    const leave = await call("DELETE", `/api/meetly/meetings/${id}/participants/${bruno.user.id}`, {
      cookie: bruno.cookie,
    });
    expect(leave.status).toBe(200);
    expect((await call("GET", `/api/meetly/meetings/${id}`, { cookie: bruno.cookie })).status).toBe(
      404,
    );

    const kick = await call<{ meeting: MeetlyMeetingDetail }>(
      "DELETE",
      `/api/meetly/meetings/${id}/participants/${carla.user.id}`,
      { cookie: ana.cookie },
    );
    expect(kick.status).toBe(200);
    expect(kick.body.meeting.attendeeCount).toBe(1);

    // A anfitriã não pode remover a si mesma.
    expect(
      (
        await call("DELETE", `/api/meetly/meetings/${id}/participants/${ana.user.id}`, {
          cookie: ana.cookie,
        })
      ).status,
    ).toBe(400);
  });

  it("usa o domínio Jitsi configurado e ignora valores inválidos", async () => {
    const { cookie } = await register("Ana", "ana@example.com");
    process.env.MEETLY_JITSI_DOMAIN = "jitsi.minhaempresa.com.br";
    const created = await call<{ meeting: MeetlyMeetingDetail }>("POST", "/api/meetly/meetings", {
      cookie,
      body: meetingInput,
    });
    expect(created.body.meeting.joinUrl).toMatch(/^https:\/\/jitsi\.minhaempresa\.com\.br\//);

    process.env.MEETLY_JITSI_DOMAIN = "evil.com/<script>";
    const detail = await call<{ meeting: MeetlyMeetingDetail }>(
      "GET",
      `/api/meetly/meetings/${created.body.meeting.id}`,
      { cookie },
    );
    expect(detail.body.meeting.jitsiDomain).toBe("meet.jit.si");
  });

  it("gera nomes de sala no formato do app original", () => {
    const names = new Set(Array.from({ length: 50 }, () => generateRoomName()));
    expect(names.size).toBe(50);
    for (const name of names) expect(name).toMatch(/^[a-z-]+-r-[A-Za-z0-9]{6}$/);
  });
});
