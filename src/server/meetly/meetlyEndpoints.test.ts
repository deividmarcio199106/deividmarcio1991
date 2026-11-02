import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MeetlyMeetingDetail, MeetlyMeetingSummary, MeetlyUser } from "@/lib/meetly/types";

import { handleMeetlyRequest, resetMeetlyRateLimitForTests } from "./meetlyEndpoints";
import { clientIp, SlidingWindowLimiter } from "./meetlyRateLimit";
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
  process.env.NODE_ENV = "test";
});

interface CallResult<T> {
  status: number;
  body: T & { error?: string };
  cookie: string | null;
}

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  options: { body?: unknown; cookie?: string | null; csrf?: boolean; ip?: string } = {},
): Promise<CallResult<T> & { setCookie: string | null }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.csrf !== false) headers["x-requested-with"] = "meetly";
  if (options.cookie) headers["cookie"] = options.cookie;
  // Como o Nginx com $proxy_add_x_forwarded_for: o IP real é o ÚLTIMO item.
  if (options.ip) headers["x-forwarded-for"] = options.ip;
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
    setCookie,
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

  it("quem só sabe o e-mail não bloqueia o login da vítima a partir de outro IP", async () => {
    await register("Ana", "ana@example.com");
    // Atacante sem senha: não conta nada.
    for (let i = 0; i < 15; i++) {
      const r = await call("POST", "/api/meetly/auth/login", {
        body: { email: "ana@example.com" },
        ip: "6.6.6.6",
      });
      expect(r.status).toBe(400);
    }
    // Atacante com senhas erradas: esgota o limite DELE (par IP+e-mail).
    let attacker = 0;
    for (let i = 0; i < 12; i++) {
      attacker = (
        await call("POST", "/api/meetly/auth/login", {
          body: { email: "ana@example.com", password: `errada-${i}` },
          ip: "6.6.6.6",
        })
      ).status;
    }
    expect(attacker).toBe(429);
    // A vítima, de outro IP e com a senha certa, entra.
    const victim = await call("POST", "/api/meetly/auth/login", {
      body: { email: "ana@example.com", password: "segredo123" },
      ip: "1.1.1.1",
    });
    expect(victim.status).toBe(200);
  });

  it("não aceita o primeiro X-Forwarded-For (escrito pelo cliente) como IP", () => {
    const spoofed = new Request("http://localhost/", {
      headers: { "x-forwarded-for": "9.9.9.9, 203.0.113.7" },
    });
    expect(clientIp(spoofed)).toBe("203.0.113.7");
    const direct = Object.assign(new Request("http://localhost/"), { ip: "198.51.100.4" });
    direct.headers.set("x-forwarded-for", "9.9.9.9");
    expect(clientIp(direct)).toBe("198.51.100.4");
  });

  it("o limitador tem teto de chaves e chave de tamanho fixo", () => {
    const limiter = new SlidingWindowLimiter(3, 60_000, 100);
    for (let i = 0; i < 1_000; i++) limiter.hit(`${"x".repeat(10_000)}-${i}`);
    expect(limiter.size).toBe(100);
    expect(limiter.consume("a")).toBe(false);
    expect(limiter.consume("a")).toBe(false);
    expect(limiter.consume("a")).toBe(false);
    expect(limiter.consume("a")).toBe(true);
  });

  it("cadastros simultâneos com o mesmo e-mail: um entra, o outro recebe 409", async () => {
    const [a, b] = await Promise.all([
      call("POST", "/api/meetly/auth/register", {
        body: { name: "Ana", email: "dup@example.com", password: "segredo123" },
      }),
      call("POST", "/api/meetly/auth/register", {
        body: { name: "Ana 2", email: "dup@example.com", password: "segredo123" },
      }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
  });

  it("em produção a sessão usa __Host- + Secure e ignora o cookie sem prefixo", async () => {
    process.env.NODE_ENV = "production";
    const result = await call("POST", "/api/meetly/auth/register", {
      body: { name: "Ana", email: "ana@example.com", password: "segredo123" },
    });
    expect(result.status).toBe(201);
    expect(result.setCookie).toMatch(/^__Host-meetly_session=/);
    expect(result.setCookie).toMatch(/; Secure/);
    expect((await call("GET", "/api/meetly/me", { cookie: result.cookie })).status).toBe(200);
    // Um cookie plantado por http (sem o prefixo) não vale como sessão.
    const token = result.cookie!.split("=")[1]!;
    const planted = await call("GET", "/api/meetly/me", { cookie: `meetly_session=${token}` });
    expect(planted.status).toBe(401);
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

    // Bruno agora vê a reunião, mas não convida, não edita, não exclui e não remove ninguém.
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
    expect(brunoInvites.status).toBe(403);
    const anaInvites = await call("POST", `/api/meetly/meetings/${id}/participants`, {
      cookie: ana.cookie,
      body: { email: "carla@example.com" },
    });
    expect(anaInvites.status).toBe(200);
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

  it("remover ou sair troca a sala de vídeo (o link antigo deixa de valer)", async () => {
    const ana = await register("Ana", "ana@example.com");
    await register("Bruno", "bruno@example.com");
    const created = await call<{ meeting: MeetlyMeetingDetail }>("POST", "/api/meetly/meetings", {
      cookie: ana.cookie,
      body: meetingInput,
    });
    const id = created.body.meeting.id;
    const added = await call<{ meeting: MeetlyMeetingDetail }>(
      "POST",
      `/api/meetly/meetings/${id}/participants`,
      { cookie: ana.cookie, body: { email: "bruno@example.com" } },
    );
    const roomBefore = added.body.meeting.room;
    const bruno = added.body.meeting.participants.find((p) => p.displayName === "Bruno")!;
    const kicked = await call<{ meeting: MeetlyMeetingDetail }>(
      "DELETE",
      `/api/meetly/meetings/${id}/participants/${bruno.id}`,
      { cookie: ana.cookie },
    );
    expect(kicked.status).toBe(200);
    expect(kicked.body.meeting.room).not.toBe(roomBefore);
    expect(kicked.body.meeting.joinUrl).not.toContain(roomBefore);
  });

  it("fotos saem por endereço próprio, só para quem divide reunião", async () => {
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const ana = await register("Ana", "ana@example.com");
    const bruno = await register("Bruno", "bruno@example.com");
    const carla = await register("Carla", "carla@example.com");
    await call("PUT", "/api/meetly/me", {
      cookie: bruno.cookie,
      body: { displayName: "Bruno", phone: "", imageUrl: png },
    });
    const created = await call<{ meeting: MeetlyMeetingDetail }>("POST", "/api/meetly/meetings", {
      cookie: ana.cookie,
      body: meetingInput,
    });
    const added = await call<{ meeting: MeetlyMeetingDetail }>(
      "POST",
      `/api/meetly/meetings/${created.body.meeting.id}/participants`,
      { cookie: ana.cookie, body: { email: "bruno@example.com" } },
    );
    const brunoRow = added.body.meeting.participants.find((p) => p.id === bruno.user.id)!;
    expect(brunoRow.imageUrl).toMatch(
      new RegExp(`^/api/meetly/users/${bruno.user.id}/avatar\\?v=\\d+$`),
    );
    expect(JSON.stringify(added.body)).not.toContain("data:image");

    const avatarPath = `/api/meetly/users/${bruno.user.id}/avatar`;
    const fetchAvatar = (cookie: string) =>
      handleMeetlyRequest(new Request(`http://localhost${avatarPath}`, { headers: { cookie } }));
    const forAna = (await fetchAvatar(ana.cookie))!;
    expect(forAna.status).toBe(200);
    expect(forAna.headers.get("content-type")).toBe("image/png");
    expect(forAna.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await fetchAvatar(bruno.cookie))!.status).toBe(200);
    // Carla não divide reunião com o Bruno.
    expect((await fetchAvatar(carla.cookie))!.status).toBe(404);
  });

  it("corpo grande demais é recusado antes de ser lido; corpo não-JSON também", async () => {
    const big = await handleMeetlyRequest(
      new Request("http://localhost/api/meetly/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-requested-with": "meetly",
          "content-length": "5000000",
        },
        body: "{}",
      }),
    );
    expect(big!.status).toBe(413);
    const chunked = await call("POST", "/api/meetly/auth/login", {
      body: { email: "a@b.co", password: "x".repeat(400_000) },
    });
    expect(chunked.status).toBe(413);
    const text = await handleMeetlyRequest(
      new Request("http://localhost/api/meetly/auth/login", {
        method: "POST",
        headers: { "content-type": "text/plain", "x-requested-with": "meetly" },
        body: JSON.stringify({ email: "a@b.co", password: "segredo123" }),
      }),
    );
    expect(text!.status).toBe(415);
  });

  it("limita a criação de reuniões e resume a descrição na lista", async () => {
    const { cookie } = await register("Ana", "ana@example.com");
    const long = "x".repeat(1_500);
    let last = 0;
    for (let i = 0; i < 21; i++) {
      last = (
        await call("POST", "/api/meetly/meetings", {
          cookie,
          body: { ...meetingInput, title: `R${i}`, content: long },
        })
      ).status;
    }
    expect(last).toBe(429);
    const list = await call<{ meetings: MeetlyMeetingSummary[] }>("GET", "/api/meetly/meetings", {
      cookie,
    });
    expect(list.body.meetings).toHaveLength(20);
    expect(list.body.meetings[0]!.content.length).toBe(200);
    const detail = await call<{ meeting: MeetlyMeetingDetail }>(
      "GET",
      `/api/meetly/meetings/${list.body.meetings[0]!.id}`,
      { cookie },
    );
    expect(detail.body.meeting.content.length).toBe(1_500);
  });

  it("scrypt tem teto global: excesso recebe 503, nunca 500", async () => {
    await register("Ana", "ana@example.com");
    const results = await Promise.all(
      Array.from({ length: 28 }, (_, i) =>
        call("POST", "/api/meetly/auth/login", {
          body: { email: `ninguem${i}@example.com`, password: "errada123" },
          ip: `10.0.0.${i + 1}`,
        }),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 503).length).toBeGreaterThan(0);
    expect(statuses.every((s) => s === 401 || s === 503)).toBe(true);
  });

  it("percent-encoding inválido no caminho vira 404, não erro 500", async () => {
    const { cookie } = await register("Ana", "ana@example.com");
    const bad = await call("GET", "/api/meetly/meetings/%E0%A4%A", { cookie });
    expect(bad.status).toBe(404);
    const badParticipant = await call("DELETE", "/api/meetly/meetings/abc/participants/%E0%A4%A", {
      cookie,
    });
    expect(badParticipant.status).toBe(404);
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
