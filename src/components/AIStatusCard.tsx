import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, PowerOff, RefreshCw, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { AIHealth } from "@/services/ai/health";
import { ReconnectBackoff } from "@/services/ai/reconnect";

/**
 * Status do provedor opcional de IA para a tela administrativa.
 *
 * Consome `/api/health/ai`, que é servido antes do SSR (ver
 * `src/lib/healthEndpoints.ts`). A resposta é deliberadamente pobre em
 * infraestrutura: NÃO traz host, IP, porta nem chave — só se está no ar, qual
 * modelo, latência e o que fazer quando algo está errado.
 *
 * O navegador conversa com o backend, nunca diretamente com o provedor.
 */

const TONE: Record<
  AIHealth["status"],
  { label: string; className: string; Icon: typeof CheckCircle2 }
> = {
  ok: { label: "ONLINE", className: "text-bull", Icon: CheckCircle2 },
  degradado: { label: "DEGRADADO", className: "text-warn", Icon: AlertTriangle },
  desligado: { label: "DESLIGADA", className: "text-muted-foreground", Icon: PowerOff },
  falha: { label: "OFFLINE", className: "text-bear", Icon: XCircle },
};

export function AIStatusCard() {
  const [health, setHealth] = useState<AIHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reconnected, setReconnected] = useState(false);
  const backoffRef = useRef(new ReconnectBackoff());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    let connected = false;
    try {
      // O endpoint responde 503 quando a IA está fora — o corpo continua sendo
      // o diagnóstico completo, então `res.ok` não serve como filtro.
      const res = await fetch("/api/health/ai", { headers: { accept: "application/json" } });
      const payload = (await res.json()) as AIHealth;
      setHealth(payload);
      connected = payload.status === "ok" || payload.status === "degradado";
    } catch {
      setError("Não foi possível consultar o backend. Verifique se o servidor está no ar.");
    } finally {
      setLoading(false);
    }
    // §3: reconexão automática com backoff 1s→2s→5s→10s→30s; ao voltar,
    // sinaliza RECONECTADA uma vez e retorna ao ritmo normal.
    const { nextDelayMs, reconnected: cameBack } = backoffRef.current.record(connected);
    if (cameBack) setReconnected(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void load(), nextDelayMs);
  }, []);

  useEffect(() => {
    void load();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [load]);

  const tone = health ? TONE[health.status] : null;

  return (
    <Card className="border-border/70 bg-panel p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[10px] font-medium tracking-widest text-muted-foreground">
          PROVEDOR OPCIONAL DE IA
        </p>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          )}
          Verificar agora
        </Button>
      </div>

      <p className="mb-2 text-[11px] text-muted-foreground">
        A IA é opcional: captura, análise determinística e gerenciamento funcionam sem ela. Se o
        provedor cair, apenas o assistente fica indisponível — a análise visual continua.
      </p>

      {error && <p className="text-xs text-bear">{error}</p>}

      {health && tone && (
        <div className="flex flex-col gap-2">
          <div className={`flex items-center gap-1.5 text-sm font-semibold ${tone.className}`}>
            <tone.Icon className="h-4 w-4" />
            {tone.label}
          </div>

          <p className="font-mono text-xs font-bold">
            {health.status === "ok" || health.status === "degradado"
              ? reconnected
                ? `● IA GPU: RECONECTADA — ${health.model}`
                : `● IA GPU: CONECTADA — ${health.model}`
              : health.configured
                ? "● IA GPU: DESCONECTADA"
                : "● IA GPU: NÃO CONFIGURADA"}
          </p>
          <p className="text-xs text-foreground/90">{health.message}</p>
          {health.hint && <p className="text-[11px] text-muted-foreground">→ {health.hint}</p>}

          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] sm:grid-cols-5">
            <Field label="MODELO TEXTO" value={health.model} />
            <Field label="MODELO VISUAL" value={health.visionModel || "NÃO CONFIGURADO"} />
            <Field label="PROVEDOR" value={health.provider} />
            <Field
              label="LATÊNCIA"
              value={health.latencyMs === null ? "—" : `${health.latencyMs} ms`}
            />
            <Field label="MODELOS" value={String(health.modelsCount)} />
          </dl>

          {health.breaker.consecutiveFailures > 0 && (
            <p className="text-[11px] text-warn">
              {health.breaker.consecutiveFailures} falha(s) consecutiva(s)
              {health.breaker.retryInMs > 0 &&
                ` · nova tentativa em ${Math.ceil(health.breaker.retryInMs / 1000)}s`}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[9px] tracking-widest text-muted-foreground">{label}</dt>
      <dd className="font-mono text-foreground/90">{value}</dd>
    </div>
  );
}
