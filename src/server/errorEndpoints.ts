import {
  clearResolvedErrors,
  errorSummary,
  listErrors,
  recordError,
  setErrorResolved,
} from "./errorRepository";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * Leitura/gestão exigem o token de admin quando ADMIN_TOKEN está definido
 * (comando §18: /erros somente ADMIN). O REPORT continua aberto — a própria
 * aplicação precisa reportar erros sem credencial.
 */
const reportBuckets = new Map<string, number[]>();

function reportRateLimited(ip: string, maxPerMinute = 60): boolean {
  const now = Date.now();
  if (reportBuckets.size > 1_000) reportBuckets.clear();
  const bucket = (reportBuckets.get(ip) ?? []).filter((at) => now - at < 60_000);
  if (bucket.length >= maxPerMinute) {
    reportBuckets.set(ip, bucket);
    return true;
  }
  bucket.push(now);
  reportBuckets.set(ip, bucket);
  return false;
}

function adminDenied(request: Request): Response | null {
  const configured = process.env["ADMIN_TOKEN"]?.trim();
  if (!configured) return null; // instalação sem admin: modo local/dev
  const provided = request.headers.get("x-admin-token")?.trim();
  if (provided === configured) return null;
  return json({ error: "Não autorizado. Informe o token de admin." }, 401);
}

/** Central de Erros — API (comando §3). Sanitização acontece no repositório. */
export async function handleErrorCenterRequest(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (!path.startsWith("/api/errors")) return null;

  try {
    if (path !== "/api/errors/report") {
      const denied = adminDenied(request);
      if (denied) return denied;
    }
    if (request.method === "GET" && path === "/api/errors/list") {
      const resolvedParam = url.searchParams.get("resolved");
      return json({
        errors: listErrors({
          source: url.searchParams.get("source") ?? undefined,
          severity: url.searchParams.get("severity") ?? undefined,
          resolved: resolvedParam === null ? undefined : resolvedParam === "1",
          limit: Number(url.searchParams.get("limit") ?? 200),
        }),
        summary: errorSummary(),
      });
    }
    if (request.method === "POST" && path === "/api/errors/report") {
      // O report é aberto (a aplicação precisa reportar sem credencial), mas
      // tem teto por IP para não permitir flood ilimitado do SQLite.
      const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
      if (reportRateLimited(ip)) return json({ error: "Rate-limit de report de erros." }, 429);
      const payload = (await request.json()) as Parameters<typeof recordError>[0];
      if (!payload?.message) return json({ error: "message é obrigatório." }, 400);
      return json({ ok: true, error: recordError(payload) });
    }
    if (request.method === "POST" && path === "/api/errors/resolve") {
      const payload = (await request.json()) as { id?: string; resolved?: boolean };
      if (!payload.id) return json({ error: "id é obrigatório." }, 400);
      return json({ ok: true, error: setErrorResolved(payload.id, payload.resolved ?? true) });
    }
    if (request.method === "POST" && path === "/api/errors/clear-resolved") {
      return json({ ok: true, removed: clearResolvedErrors() });
    }
    return json({ error: "Endpoint da central de erros não encontrado." }, 404);
  } catch (error) {
    console.error("error center endpoint failure", error);
    return json(
      {
        error: "Falha na central de erros.",
        detail: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
}
