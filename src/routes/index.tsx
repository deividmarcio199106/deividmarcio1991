import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { BarChart3, Radio, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { computeStats } from "@/lib/engines/performanceEngine";
import { STRATEGY_VERSION } from "@/lib/engines/strategy";
import { store, type BacktestRecord, type LiveSessionRecord } from "@/lib/storage";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({
  component: Dashboard,
  head: () => ({
    meta: [
      { title: "Analisador Visual T4" },
      {
        name: "description",
        content: "Painel do NEXUS T4 com sessões de observação contínua e desempenho consolidado.",
      },
      { property: "og:title", content: "Analisador Visual T4" },
      {
        property: "og:description",
        content: "Resumo de sessões ao vivo, backtests e performance consolidada.",
      },
    ],
  }),
});

function Dashboard() {
  const [sessions, setSessions] = useState<LiveSessionRecord[]>([]);
  const [backtests, setBacktests] = useState<BacktestRecord[]>([]);

  useEffect(() => {
    let active = true;
    void store.hydrate().then(() => {
      if (!active) return;
      setSessions(store.sessions().slice().reverse());
      setBacktests(store.backtests().slice().reverse());
    });
    return () => {
      active = false;
    };
  }, []);

  const stats = computeStats(backtests.flatMap((b) => b.trades));

  return (
    <div className="flex flex-col gap-3">
      <header>
        <h1 className="font-display text-2xl font-bold">Painel</h1>
        <p className="text-xs text-muted-foreground">
          Estratégia <span className="font-mono">{STRATEGY_VERSION}</span> — backtest e operação ao
          vivo usam o mesmo motor de análise.
        </p>
      </header>

      <div className="grid gap-3 md:grid-cols-2">
        <Card className="gap-2 border-border/70 bg-panel p-4">
          <div className="flex items-center gap-2">
            <Radio className="h-5 w-5 text-primary" />
            <h2 className="font-display text-lg font-bold">Operação ao Vivo</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Leitura da janela gráfica de 1 minuto, decisão por evidência auditável e configuração
            validada somente quando há evidência histórica suficiente e risco aceitável.
          </p>
          <Button asChild className="mt-1 w-fit">
            <Link to="/operacao-ao-vivo">Abrir operação ao vivo</Link>
          </Button>
        </Card>

        <Card className="gap-2 border-border/70 bg-panel p-4">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-primary" />
            <h2 className="font-display text-lg font-bold">Backtest</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Observação contínua do histórico sem ver o futuro, com resultado real registrado por
            pregão.
          </p>
          <Button asChild variant="secondary" className="mt-1 w-fit">
            <Link to="/backtest">Abrir backtest</Link>
          </Button>
        </Card>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Sessões ao vivo" value={String(sessions.length)} />
        <Stat label="Backtests executados" value={String(backtests.length)} />
        <Stat label="Operações validadas" value={String(stats.total)} />
        <Stat
          label="Acerto consolidado"
          value={stats.total ? `${stats.winRate.toFixed(1)}%` : "—"}
          tone={stats.winRate >= 50 ? "bull" : "bear"}
        />
      </div>

      <Card className="flex items-start gap-2 border-warn/50 bg-warn/10 p-3 text-xs text-warn">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          Esta é uma ferramenta de <strong>apoio à decisão</strong>. Nenhuma ordem é enviada
          automaticamente à corretora — toda execução é manual, feita por você no Profit.
        </p>
      </Card>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "bull" | "bear" }) {
  return (
    <Card className="gap-0.5 border-border/70 bg-panel p-3">
      <p className="text-[10px] tracking-widest text-muted-foreground">{label}</p>
      <p
        className={cn(
          "font-mono text-2xl font-bold",
          tone === "bull" && "text-bull",
          tone === "bear" && "text-bear",
        )}
      >
        {value}
      </p>
    </Card>
  );
}
