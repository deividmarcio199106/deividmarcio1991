import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { handleHealthRequest } from "./lib/healthEndpoints";
import { handleClaudeAdminRequest } from "./server/claudeAdminEndpoints";
import { handleDiagnosticsRequest } from "./server/diagnosticsEndpoints";
import { handleErrorCenterRequest } from "./server/errorEndpoints";
import { handleRecordingRequest } from "./server/recordingEndpoints";
import { handleTradingRequest } from "./server/tradingEndpoints";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      // Health check ANTES do SSR: precisa responder mesmo com o aplicativo
      // quebrado — é o que impede o container de subir silenciosamente ruim.
      const health = await handleHealthRequest(request);
      if (health) return health;

      // Diagnóstico também precisa responder com o SSR quebrado: é ele que
      // diz o que quebrou.
      const diagnostics = await handleDiagnosticsRequest(request);
      if (diagnostics) return diagnostics;

      const trading = await handleTradingRequest(request);
      if (trading) return trading;

      const recording = await handleRecordingRequest(request);
      if (recording) return recording;

      const errors = await handleErrorCenterRequest(request);
      if (errors) return errors;

      const admin = await handleClaudeAdminRequest(request);
      if (admin) return admin;

      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      // Erros de backend também entram na Central de Erros, sem segredos.
      try {
        const { recordError } = await import("./server/errorRepository");
        recordError({
          severity: "CRITICAL",
          source: "BACKEND",
          route: new URL(request.url).pathname,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? (error.stack ?? null) : null,
        });
      } catch {
        // A central de erros nunca pode quebrar o tratamento do erro original.
      }
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
