import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { podeEmitirSinal, type HealthState, type SystemHealth } from "@/lib/health/systemHealth";
import { cn } from "@/lib/utils";

/**
 * PAINEL DE SAÚDE — só apresentação. Todo o julgamento vem pronto de
 * @/lib/health/systemHealth, que é puro e testado.
 *
 * A escolha visual que importa: DEGRADED sai em ÂMBAR, nunca em verde claro.
 * Um subsistema "não medido" é degradado por definição nesta casa, e pintá-lo
 * de verde recriaria na tela exatamente o defeito que o agregador existe para
 * impedir — um painel tranquilo sobre uma ignorância.
 */

const TOM: Record<HealthState, string> = {
  OK: "border-bull text-bull",
  DEGRADED: "border-amber-500 text-amber-500",
  ERROR: "border-bear text-bear",
};

export function HealthPanel({ health }: { health: SystemHealth }) {
  const liberado = podeEmitirSinal(health);
  return (
    <Card className="flex flex-col gap-2 border-border/70 bg-panel p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="nexus-eyebrow">SAÚDE DO SISTEMA</p>
        <Badge variant="outline" className={cn("font-mono text-[10px]", TOM[health.state])}>
          {health.state}
        </Badge>
        {/*
         * A porta de segurança dita em palavras: falha de serviço não pode
         * virar sinal falso, e o operador precisa ver essa consequência aqui,
         * não descobrir na hora de operar.
         */}
        <Badge
          variant="outline"
          className={cn(
            "font-mono text-[10px]",
            liberado ? "border-border text-muted-foreground" : "border-bear text-bear",
          )}
        >
          {liberado ? "SINAL PERMITIDO" : "SINAL BLOQUEADO PELA SAÚDE"}
        </Badge>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {new Date(health.checkedAt).toLocaleTimeString("pt-BR")}
        </span>
      </div>

      <p className="text-[10px] leading-snug text-muted-foreground">{health.note}</p>

      <div className="flex flex-col gap-1">
        {health.subsystems.map((s) => (
          <div key={s.id} className="flex items-baseline justify-between gap-2">
            <span className="nexus-eyebrow shrink-0">{s.label}</span>
            <span
              className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground"
              title={s.detail}
            >
              {s.detail}
            </span>
            <span className={cn("shrink-0 font-mono text-[10px]", TOM[s.state].split(" ")[1])}>
              {s.value !== null ? `${s.value.toLocaleString("pt-BR")}${s.unit ?? ""} · ` : ""}
              {s.state}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}
