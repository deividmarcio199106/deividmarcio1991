import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Loader2, Send } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { askAnalyst, getAssistantProviders } from "@/lib/analyst.functions";
import { store, type AIMemoryScope } from "@/lib/storage";
import { cn } from "@/lib/utils";

type Msg = { role: "user" | "assistant"; content: string; savedAt: number };

type ProvidersState = { configured: boolean; model: string; provider: string };

const NO_PROVIDER: ProvidersState = { configured: false, model: "", provider: "" };

/**
 * Assistente de IA do Aprendizado — recebe as estatísticas do backtest e
 * trechos do analisador para propor melhorias na técnica. O provedor é
 * configurado exclusivamente no servidor.
 */
export function AnalystAssistant({
  context,
  scope = "aprendizado",
  metrics,
}: {
  context: string;
  scope?: AIMemoryScope;
  metrics?: { backtests: number; trades: number; validatedSetups: number; totalSetups: number };
}) {
  const ask = useServerFn(askAnalyst);
  const loadProviders = useServerFn(getAssistantProviders);
  const [providers, setProviders] = useState<ProvidersState>(NO_PROVIDER);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setMessages(store.aiMessages(scope));
  }, [scope]);

  useEffect(() => {
    let alive = true;
    void loadProviders({}).then((p) => {
      if (alive) setProviders(p);
    });
    return () => {
      alive = false;
    };
  }, [loadProviders]);

  const saveMessages = useCallback(
    (next: Msg[]) => {
      const limited = next.slice(-30);
      setMessages(limited);
      store.saveAIMessages(scope, limited);
    },
    [scope],
  );

  const send = useCallback(
    async (override?: string) => {
      const text = (override ?? input).trim();
      if (!text || loading || !providers.configured) return;
      const next: Msg[] = [...messages, { role: "user", content: text, savedAt: Date.now() }];
      saveMessages(next);
      setInput("");
      setError(null);
      setLoading(true);
      try {
        const res = await ask({
          data: {
            messages: next.map(({ role, content }) => ({ role, content })),
            context,
          },
        });
        if (res.error) setError(res.error);
        else saveMessages([...next, { role: "assistant", content: res.text, savedAt: Date.now() }]);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Falha ao consultar a IA.");
      } finally {
        setLoading(false);
        inputRef.current?.focus();
      }
    },
    [ask, context, input, loading, messages, providers.configured, saveMessages],
  );

  return (
    <Card className="border-border/70 bg-panel p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-[10px] font-medium tracking-widest text-muted-foreground">
          <Bot className="h-3.5 w-3.5" /> LABORATÓRIO — ASSISTENTE DE HIPÓTESES
        </p>
        {providers.configured && (
          <span className="rounded-md border border-border/60 bg-background px-2 py-1 text-[10px] text-muted-foreground">
            {providers.provider} — {providers.model}
          </span>
        )}
      </div>

      {!providers.configured && (
        <p className="mb-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[11px]">
          IA ainda não configurada. Na VPS, defina <code>OLLAMA_BASE_URL</code> e{" "}
          <code>OLLAMA_TEXT_MODEL</code>. O modelo visual é configurado separadamente.
        </p>
      )}

      {metrics && (
        <div className="mb-2">
          <div className="grid gap-2 text-[10px] sm:grid-cols-4">
            <span className="rounded border border-border/60 p-2">
              Backtests: <strong>{metrics.backtests}</strong>
            </span>
            <span className="rounded border border-border/60 p-2">
              Operações: <strong>{metrics.trades}</strong>
            </span>
            <span className="rounded border border-border/60 p-2">
              Setups validados:{" "}
              <strong>
                {metrics.validatedSetups}/{metrics.totalSetups}
              </strong>
            </span>
            <span className="rounded border border-border/60 p-2">
              Mensagens salvas: <strong>{messages.length}</strong>
            </span>
          </div>
          <p className="mt-1 text-[9px] text-muted-foreground">
            Estes contadores representam dados realmente armazenados e setups com amostra/validação;
            não representam chance de acerto nem retreinamento automático do modelo.
          </p>
        </div>
      )}

      <div className="mb-2 max-h-[420px] space-y-2 overflow-y-auto">
        {messages.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Cole aqui uma regra ou hipótese da técnica (condições, gatilho, invalidação) e peça uma
            revisão. A IA recebe automaticamente as estatísticas dos seus backtests.
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={`${m.savedAt}-${i}`}
            className={cn(
              "whitespace-pre-wrap rounded-md border px-3 py-2 text-xs",
              m.role === "user"
                ? "border-primary/40 bg-primary/10"
                : "border-border/60 bg-background font-mono leading-relaxed",
            )}
          >
            {m.content}
          </div>
        ))}
        {loading && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> analisando…
          </p>
        )}
        {error && <p className="text-xs text-bear">{error}</p>}
      </div>

      <div className="flex items-end gap-2">
        <Textarea
          ref={inputRef}
          autoFocus
          rows={3}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
          }}
          placeholder="Ex.: o Spring com varredura entre 9h15 e 10h30 rende mais? Formule como hipótese testável…"
          className="min-h-[72px] font-mono text-xs"
        />
        <Button
          onClick={() => void send()}
          disabled={loading || !input.trim() || !providers.configured}
          size="icon"
          aria-label="Enviar"
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
      <Button
        className="mt-2"
        variant="outline"
        size="sm"
        disabled={loading || !providers.configured}
        onClick={() =>
          void send(
            "Diga exatamente o que você absorveu dos meus backtests até agora, o que ainda não tem amostra suficiente e quais melhorias são apenas hipóteses pendentes de validação.",
          )
        }
      >
        O que a IA absorveu até agora?
      </Button>
    </Card>
  );
}
