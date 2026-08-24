import {
  createRecordingSession,
  finalizeRecordingSession,
  getRecordingStatus,
  saveRecordingChunk,
  saveRecordingEvent,
  updateRecordingSession,
} from "./recordingRepository";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * API de gravação (comando §9). Servida antes do SSR, como /api/trading.
 *
 * GET  /api/recording/status/:sessionId → estado REAL do manifesto no banco
 * POST /api/recording/sessions          → cria a sessão de gravação no DB
 * POST /api/recording/chunks            → chunk binário progressivo (1–5 s)
 * POST /api/recording/state             → recorder.state/erros reportados
 * POST /api/recording/stop              → finaliza validando bytes em disco
 * POST /api/recording/events            → eventos T4 sincronizados (real+chart)
 */
export async function handleRecordingRequest(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (!path.startsWith("/api/recording/")) return null;

  try {
    const statusMatch = /^\/api\/recording\/status\/([^/]+)$/.exec(path);
    if (request.method === "GET" && statusMatch) {
      const status = getRecordingStatus(decodeURIComponent(statusMatch[1]!));
      if (!status) return json({ error: "Sessão de gravação não encontrada." }, 404);
      return json(status);
    }
    if (request.method === "POST" && path === "/api/recording/sessions") {
      const payload = (await request.json()) as {
        sessionId?: string;
        liveSessionId?: string | null;
        asset?: string | null;
        mimeType?: string | null;
        startedAt?: number;
      };
      if (!payload.sessionId) return json({ error: "sessionId é obrigatório." }, 400);
      createRecordingSession({
        sessionId: payload.sessionId,
        liveSessionId: payload.liveSessionId ?? null,
        asset: payload.asset ?? null,
        mimeType: payload.mimeType ?? null,
        startedAt: payload.startedAt ?? Date.now(),
      });
      return json({ ok: true });
    }
    if (request.method === "POST" && path === "/api/recording/chunks") {
      const sessionId = url.searchParams.get("sessionId");
      const index = Number(url.searchParams.get("index"));
      if (!sessionId || !Number.isFinite(index)) {
        return json({ error: "sessionId e index são obrigatórios." }, 400);
      }
      const bytes = new Uint8Array(await request.arrayBuffer());
      const chunk = saveRecordingChunk(
        {
          sessionId,
          index,
          segment: Number(url.searchParams.get("segment") ?? 0),
          startedAt: Number(url.searchParams.get("startedAt") ?? Date.now()),
          endedAt: Number(url.searchParams.get("endedAt") ?? Date.now()),
          mimeType: url.searchParams.get("mimeType"),
        },
        bytes,
      );
      return json({ ok: chunk.status === "SAVED", chunk });
    }
    if (request.method === "POST" && path === "/api/recording/state") {
      const payload = (await request.json()) as {
        sessionId?: string;
        recorderState?: string | null;
        status?: string;
        error?: string | null;
        segment?: number;
      };
      if (!payload.sessionId) return json({ error: "sessionId é obrigatório." }, 400);
      updateRecordingSession(payload as { sessionId: string });
      return json({ ok: true });
    }
    if (request.method === "POST" && path === "/api/recording/stop") {
      const payload = (await request.json()) as { sessionId?: string; endedAt?: number };
      if (!payload.sessionId) return json({ error: "sessionId é obrigatório." }, 400);
      const status = finalizeRecordingSession({
        sessionId: payload.sessionId,
        endedAt: payload.endedAt ?? Date.now(),
      });
      if (!status) return json({ error: "Sessão de gravação não encontrada." }, 404);
      return json(status);
    }
    if (request.method === "POST" && path === "/api/recording/events") {
      const payload = (await request.json()) as {
        id?: string;
        sessionId?: string;
        realTimestamp?: number;
        chartTimestamp?: number | null;
        type?: string;
        payload?: unknown;
      };
      if (!payload.sessionId || !payload.type) {
        return json({ error: "sessionId e type são obrigatórios." }, 400);
      }
      saveRecordingEvent({
        id:
          payload.id ??
          `${payload.sessionId}_${payload.type}_${payload.realTimestamp ?? Date.now()}`,
        sessionId: payload.sessionId,
        realTimestamp: payload.realTimestamp ?? Date.now(),
        chartTimestamp: payload.chartTimestamp ?? null,
        type: payload.type,
        payload: payload.payload,
      });
      return json({ ok: true });
    }
    return json({ error: "Endpoint de gravação não encontrado." }, 404);
  } catch (error) {
    console.error("recording endpoint error", error);
    return json(
      {
        error: "Falha na API de gravação.",
        detail: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
}
