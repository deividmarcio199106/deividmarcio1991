import { sanitizeSecrets, sanitizeUnknown } from "./sanitize";

export type ClientErrorSource =
  "FRONTEND" | "API" | "T4" | "CAPTURA" | "CHART_CLOCK" | "OCR" | "GRAVACAO" | "OLLAMA" | "REDE";

/**
 * Reporter de erros do FRONTEND (comando §3).
 *
 * Erros de janela/promises não tratadas e erros reportados manualmente pelos
 * módulos (T4, captura, chartClock, gravação, Ollama) vão para a Central de
 * Erros no backend. Tudo é sanitizado ANTES de sair do módulo e deduplicado
 * por mensagem num intervalo curto para não inundar a API.
 */

const recentlySent = new Map<string, number>();
const DEDUPE_MS = 30_000;
let installed = false;

export function reportError(
  source: ClientErrorSource,
  message: string,
  options?: {
    severity?: "INFO" | "WARNING" | "ERROR" | "CRITICAL";
    stack?: string | null;
    context?: unknown;
    sessionId?: string | null;
    signalId?: string | null;
  },
): void {
  if (typeof window === "undefined") return;
  const clean = sanitizeSecrets(message).slice(0, 2_000);
  const key = `${source}|${clean}`;
  const now = Date.now();
  const last = recentlySent.get(key);
  if (last && now - last < DEDUPE_MS) return;
  recentlySent.set(key, now);
  if (recentlySent.size > 300) {
    for (const [entryKey, at] of recentlySent) {
      if (now - at > DEDUPE_MS) recentlySent.delete(entryKey);
    }
  }
  void fetch("/api/errors/report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      severity: options?.severity ?? "ERROR",
      source,
      route: window.location?.pathname ?? null,
      message: clean,
      stack: options?.stack ? sanitizeSecrets(options.stack).slice(0, 8_000) : null,
      context: options?.context === undefined ? undefined : sanitizeUnknown(options.context),
      sessionId: options?.sessionId ?? null,
      signalId: options?.signalId ?? null,
      timestamp: now,
    }),
  }).catch(() => {
    // A central de erros nunca pode derrubar a aplicação que ela observa.
  });
}

/** Captura global de window.onerror/unhandledrejection — instala uma vez. */
export function installGlobalErrorCapture(): void {
  if (typeof window === "undefined" || installed) return;
  installed = true;
  window.addEventListener("error", (event) => {
    reportError("FRONTEND", event.message || "Erro de janela sem mensagem", {
      stack: event.error instanceof Error ? (event.error.stack ?? null) : null,
      context: { filename: event.filename, lineno: event.lineno, colno: event.colno },
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    reportError("FRONTEND", reason instanceof Error ? reason.message : String(reason), {
      stack: reason instanceof Error ? (reason.stack ?? null) : null,
      context: { kind: "unhandledrejection" },
    });
  });
}
