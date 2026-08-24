import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Bot, Copy, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { useAnalyzer } from "@/components/AnalyzerProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { adminFetch, getAdminToken, setAdminToken } from "@/lib/adminSession";
import { screenRecordingManager } from "@/lib/recording/screenRecordingManager";
import type { ErrorEventRecord } from "@/server/errorRepository";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/erros")({
  component: ErrorCenterPage,
  head: () => ({ meta: [{ title: "Erros / Diagnóstico — NEXUS T4" }] }),
});

const FILTERS: Array<{ key: string; label: string; params: Record<string, string> }> = [
  { key: "todos", label: "TODOS", params: {} },
  { key: "criticos", label: "CRÍTICOS", params: { severity: "CRITICAL" } },
  { key: "t4", label: "T4", params: { source: "T4" } },
  { key: "captura", label: "CAPTURA", params: { source: "CAPTURA" } },
  { key: "ollama", label: "OLLAMA", params: { source: "OLLAMA" } },
  { key: "gravacao", label: "GRAVAÇÃO", params: { source: "GRAVACAO" } },
  { key: "api", label: "API", params: { source: "API" } },
  { key: "db", label: "DB", params: { source: "DB" } },
];

interface Summary {
  today: number;
  critical: number;
  warnings: number;
  resolved: number;
  open: number;
}

function ErrorCenterPage() {
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [errors, setErrors] = useState<ErrorEventRecord[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [filter, setFilter] = useState("todos");
  const [expanded, setExpanded] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    const params = new URLSearchParams(FILTERS.find((f) => f.key === filter)?.params ?? {});
    const response = await adminFetch(`/api/errors/list?${params.toString()}`);
    if (response.status === 401) {
      setAuthorized(false);
      return;
    }
    const payload = (await response.json()) as { errors: ErrorEventRecord[]; summary: Summary };
    setErrors(payload.errors ?? []);
    setSummary(payload.summary ?? null);
    setAuthorized(true);
  }, [filter]);

  useEffect(() => {
    void load().catch(() => setAuthorized(true));
    const timer = setInterval(() => void load().catch(() => undefined), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const resolve = async (id: string, resolved: boolean) => {
    await adminFetch("/api/errors/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, resolved }),
    });
    await load();
  };

  const clearResolved = async () => {
    await adminFetch("/api/errors/clear-resolved", { method: "POST" });
    toast.success("Erros resolvidos removidos.");
    await load();
  };

  const copyError = (error: ErrorEventRecord) => {
    void navigator.clipboard.writeText(JSON.stringify(error, null, 2));
    toast.success("Erro copiado.");
  };

  const sendToClaude = (error: ErrorEventRecord) => {
    // Handoff em memória de sessão APENAS do texto do erro (já sanitizado no
    // backend) — nunca tokens/segredos.
    window.sessionStorage.setItem(
      "claude.prefill",
      [
        "Investigue este erro registrado na Central de Erros e localize a CAUSA RAIZ antes de propor qualquer patch.",
        `id: ${error.id}`,
        `source: ${error.source} · severity: ${error.severity} · occurrences: ${error.occurrences}`,
        `route: ${error.route ?? "—"} · sessionId: ${error.sessionId ?? "—"} · signalId: ${error.signalId ?? "—"}`,
        `message: ${error.message}`,
        error.stack ? `stack:\n${error.stack}` : "",
        error.context ? `context:\n${error.context}` : "",
        "Depois: proponha o patch, mostre o diff e rode os testes.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    void navigate({ to: "/claude" });
  };

  if (authorized === false) {
    return (
      <Card className="mx-auto mt-10 flex max-w-md flex-col gap-3 p-4">
        <p className="nexus-eyebrow">ERROS / DIAGNÓSTICO — ÁREA ADMIN</p>
        <p className="text-xs text-muted-foreground">
          Informe o token de admin (ADMIN_TOKEN do .env da VPS). Ele fica somente em memória.
        </p>
        <Input
          type="password"
          value={tokenInput}
          placeholder="token de admin"
          onChange={(event) => setTokenInput(event.target.value)}
        />
        <Button
          onClick={() => {
            setAdminToken(tokenInput);
            setAuthorized(null);
            void load().catch(() => undefined);
          }}
        >
          Entrar
        </Button>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">Erros / Diagnóstico</h1>
          <p className="text-xs text-muted-foreground">
            Central de erros com sanitização de segredos + Health Center com estado real.
          </p>
        </div>
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => void load()}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Atualizar
        </Button>
      </header>

      <HealthCenter />

      {summary && (
        <div className="grid gap-2 text-center sm:grid-cols-5">
          <Metric label="HOJE" value={summary.today} />
          <Metric
            label="CRÍTICOS"
            value={summary.critical}
            tone={summary.critical ? "bear" : undefined}
          />
          <Metric
            label="WARNINGS"
            value={summary.warnings}
            tone={summary.warnings ? "warn" : undefined}
          />
          <Metric label="ABERTOS" value={summary.open} />
          <Metric label="RESOLVIDOS" value={summary.resolved} tone="bull" />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {FILTERS.map((item) => (
          <Button
            key={item.key}
            size="sm"
            variant={filter === item.key ? "default" : "outline"}
            className="font-mono text-[10px]"
            onClick={() => setFilter(item.key)}
          >
            {item.label}
          </Button>
        ))}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto text-[10px]"
          onClick={() => void clearResolved()}
        >
          <Trash2 className="mr-1 h-3 w-3" />
          LIMPAR RESOLVIDOS
        </Button>
      </div>

      <Card className="flex flex-col gap-1 border-border/70 bg-panel p-3">
        {errors.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nenhum erro registrado neste filtro.</p>
        ) : (
          errors.map((error) => (
            <div key={error.id} className="border-b border-border/40 py-1.5 last:border-b-0">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge
                  variant="outline"
                  className={cn(
                    "font-mono text-[9px]",
                    error.severity === "CRITICAL" && "border-bear text-bear",
                    error.severity === "ERROR" && "border-bear/60 text-bear",
                    error.severity === "WARNING" && "border-warn text-warn",
                  )}
                >
                  {error.severity}
                </Badge>
                <Badge variant="outline" className="font-mono text-[9px]">
                  {error.source}
                </Badge>
                {error.occurrences > 1 && (
                  <Badge variant="outline" className="font-mono text-[9px] text-warn">
                    ×{error.occurrences}
                  </Badge>
                )}
                {error.resolved && (
                  <Badge variant="outline" className="border-bull font-mono text-[9px] text-bull">
                    RESOLVIDO
                  </Badge>
                )}
                <span className="min-w-0 flex-1 truncate" title={error.message}>
                  {error.message}
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {new Date(error.lastSeen).toLocaleTimeString("pt-BR")}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => setExpanded(expanded === error.id ? null : error.id)}
                >
                  VER DETALHES
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => copyError(error)}
                >
                  <Copy className="mr-1 h-3 w-3" />
                  COPIAR
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => void resolve(error.id, !error.resolved)}
                >
                  {error.resolved ? "REABRIR" : "MARCAR RESOLVIDO"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[10px] text-primary"
                  onClick={() => sendToClaude(error)}
                >
                  <Bot className="mr-1 h-3 w-3" />
                  CORRIGIR COM CLAUDE
                </Button>
              </div>
              {expanded === error.id && (
                <pre className="mt-1 max-h-64 overflow-auto rounded bg-background/70 p-2 font-mono text-[10px] leading-snug">
                  {JSON.stringify(
                    {
                      id: error.id,
                      route: error.route,
                      sessionId: error.sessionId,
                      signalId: error.signalId,
                      firstSeen: new Date(error.firstSeen).toLocaleString("pt-BR"),
                      lastSeen: new Date(error.lastSeen).toLocaleString("pt-BR"),
                      stack: error.stack,
                      context: error.context,
                    },
                    null,
                    2,
                  )}
                </pre>
              )}
            </div>
          ))
        )}
      </Card>
    </div>
  );
}

type HealthState = "ONLINE" | "DEGRADADO" | "OFFLINE" | "—";

function HealthCenter() {
  const { diagnostics: diag } = useAnalyzer();
  const recording = useSyncExternalStore(
    (listener) => screenRecordingManager.subscribe(listener),
    () => screenRecordingManager.getState(),
    () => null,
  );
  const [api, setApi] = useState<{ state: HealthState; latency: number | null }>({
    state: "—",
    latency: null,
  });
  const [ai, setAi] = useState<{ state: HealthState; detail: string }>({ state: "—", detail: "" });
  const [db, setDb] = useState<HealthState>("—");
  const [claudeApi, setClaudeApi] = useState<HealthState>("—");

  useEffect(() => {
    let active = true;
    const check = async () => {
      const startedAt = Date.now();
      try {
        const response = await fetch("/api/health");
        const payload = (await response.json()) as { status?: string };
        if (!active) return;
        setApi({
          state: payload.status === "ok" ? "ONLINE" : "DEGRADADO",
          latency: Date.now() - startedAt,
        });
      } catch {
        if (active) setApi({ state: "OFFLINE", latency: null });
      }
      try {
        const response = await fetch("/api/health/ai");
        const payload = (await response.json()) as {
          status?: string;
          message?: string;
          latencyMs?: number;
        };
        if (!active) return;
        setAi({
          state:
            payload.status === "ok"
              ? "ONLINE"
              : payload.status === "falha"
                ? "OFFLINE"
                : "DEGRADADO",
          detail: payload.message ?? "",
        });
      } catch {
        if (active) setAi({ state: "OFFLINE", detail: "backend inacessível" });
      }
      try {
        const response = await adminFetch("/api/errors/list?limit=1");
        if (active) setDb(response.ok ? "ONLINE" : response.status === 401 ? "—" : "OFFLINE");
      } catch {
        if (active) setDb("OFFLINE");
      }
      /*
       * CHAVE PRESENTE NÃO É PROVEDOR FUNCIONANDO.
       *
       * Este check lia `anthropicConfigured` — que só diz se a variável de
       * ambiente EXISTE. Com uma chave expirada ou revogada, o Health Center
       * mostrava CLAUDE API ONLINE enquanto o DIAGNÓSTICO COMPLETO, na mesma
       * aplicação, reportava "Autenticação recusada (HTTP 401)". Dois painéis
       * discordando sobre a mesma coisa, e o verde era o errado.
       *
       * `/api/ai/providers` faz a chamada de verdade e só diz READY com resposta
       * 2xx. É o mesmo check que a auditoria usa — uma fonte, não duas.
       */
      try {
        const response = await fetch("/api/ai/providers", { cache: "no-store" });
        const payload = (await response.json()) as {
          providers?: { id: string; state: string; proven: boolean }[];
        };
        const claude = payload.providers?.find((p) => p.id === "claude");
        if (active) {
          setClaudeApi(
            claude === undefined
              ? "—"
              : claude.state === "READY"
                ? "ONLINE"
                : claude.state === "OFFLINE"
                  ? "—"
                  : "OFFLINE",
          );
        }
      } catch {
        if (active) setClaudeApi("OFFLINE");
      }
    };
    void check();
    const timer = setInterval(() => void check(), 20_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  // MESMO objeto que a Operação ao Vivo lê. Dois painéis não podem discordar
  // sobre o mesmo instante, e discordavam enquanto este lia o motor legado.
  const items: Array<{ label: string; state: HealthState; detail?: string }> = [
    { label: "SITE", state: "ONLINE" },
    {
      label: "API",
      state: api.state,
      detail: api.latency !== null ? `${api.latency} ms` : undefined,
    },
    { label: "DB", state: db },
    {
      // O MOTOR, não o setup: maturidade 0% com o motor rodando é pregão sem
      // oportunidade, não sistema parado.
      label: "MOTOR T4",
      state:
        diag.t4Engine === "ANALISANDO"
          ? "ONLINE"
          : diag.t4Engine === "PAUSADO_DADO"
            ? "OFFLINE"
            : diag.t4Engine === "COLETANDO_HISTORICO"
              ? "DEGRADADO"
              : "—",
      detail: diag.t4Flow,
    },
    {
      label: "CAPTURA",
      state: diag.captureActive ? "ONLINE" : "—",
      detail: diag.captureLabel,
    },
    {
      // Gráfico estático com captura viva é estado VÁLIDO: degradado, não morto.
      label: "GRÁFICO",
      state: diag.captureActive ? (diag.pixelsChanging ? "ONLINE" : "DEGRADADO") : "—",
      detail: diag.chartLabel,
    },
    {
      label: "CANDLES",
      state: diag.candlesParsed > 0 ? "ONLINE" : diag.candlesVisible > 0 ? "OFFLINE" : "—",
      detail: `${diag.candlesParsed}/${diag.candlesVisible} · série ${diag.closedCandlesAccepted}`,
    },
    {
      label: "ESCALA",
      state: diag.priceScaleReady ? "ONLINE" : diag.scaleReject === null ? "—" : "DEGRADADO",
      detail: diag.priceScaleReady ? `${diag.anchors} âncoras` : (diag.scaleReject ?? undefined),
    },
    {
      label: "PREGÃO",
      state: diag.dateTrusted ? "ONLINE" : "DEGRADADO",
      detail: diag.marketDate ?? `${diag.sourceMode} · não lido`,
    },
    {
      label: "GRAVAÇÃO",
      state:
        recording === null || recording.status === "IDLE"
          ? "—"
          : recording.status === "GRAVANDO" || recording.status === "FINALIZADA"
            ? "ONLINE"
            : recording.status === "STARTING" || recording.status === "FINALIZANDO"
              ? "DEGRADADO"
              : "OFFLINE",
      detail: recording?.status,
    },
    { label: "OLLAMA/QWEN", state: ai.state, detail: ai.detail },
    { label: "CLAUDE API", state: claudeApi },
  ];
  return (
    <Card className="nexus-card gap-2 p-3">
      <p className="nexus-eyebrow">HEALTH CENTER — estado real, nunca estado de UI</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        {items.map((item) => (
          <div key={item.label} className="rounded border border-border/50 p-2">
            <p className="text-[9px] tracking-widest text-muted-foreground">{item.label}</p>
            <p
              className={cn(
                "font-mono text-xs font-bold",
                item.state === "ONLINE" && "text-bull",
                item.state === "DEGRADADO" && "text-warn",
                item.state === "OFFLINE" && "text-bear",
              )}
            >
              {item.state}
            </p>
            {item.detail && (
              <p className="truncate text-[9px] text-muted-foreground" title={item.detail}>
                {item.detail}
              </p>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "bull" | "bear" | "warn";
}) {
  return (
    <Card className="gap-0.5 border-border/70 bg-background p-2">
      <p className="text-[9px] tracking-widest text-muted-foreground">{label}</p>
      <p
        className={cn(
          "font-mono text-sm font-bold",
          tone === "bull" && "text-bull",
          tone === "bear" && "text-bear",
          tone === "warn" && "text-warn",
        )}
      >
        {value}
      </p>
    </Card>
  );
}
