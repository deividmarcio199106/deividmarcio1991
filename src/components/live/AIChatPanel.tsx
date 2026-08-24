import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { ChatEntry } from "@/lib/engines/types";

const toneClass: Record<ChatEntry["tone"], string> = {
  info: "text-muted-foreground",
  bull: "text-bull",
  bear: "text-bear",
  warn: "text-warn",
  alert: "text-primary font-semibold",
};

export function AIChatPanel({
  entries,
  provider,
}: {
  entries: ChatEntry[];
  provider: { configured: boolean; model: string; provider: string };
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [entries.length]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-[10px] font-medium tracking-widest text-muted-foreground">
        <p>CHAT IA — ANÁLISE AO VIVO</p>
        <span className={provider.configured ? "text-bull" : "text-warn"}>
          {provider.configured ? `${provider.provider} · ${provider.model}` : "IA NÃO CONFIGURADA"}
        </span>
      </div>
      <div ref={ref} className="flex-1 overflow-y-auto px-3 py-2 font-mono text-xs">
        {entries.length === 0 && (
          <p className="text-muted-foreground">Aguardando início da sessão…</p>
        )}
        {entries.map((e, i) => (
          <p key={`${e.t}-${i}`} className={cn("py-0.5", toneClass[e.tone])}>
            <span className="mr-2 text-muted-foreground/70">
              {new Date(e.t).toLocaleTimeString("pt-BR", { hour12: false })}
            </span>
            {e.text}
          </p>
        ))}
      </div>
    </div>
  );
}
