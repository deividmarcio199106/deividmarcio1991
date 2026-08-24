import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { TradeManagementCard } from "@/components/live/TradeManagementCard";
import { Card } from "@/components/ui/card";
import type { DecisionObject } from "@/lib/engines/backtestDecisionEngine";
import { store } from "@/lib/storage";

export const Route = createFileRoute("/gerenciamento")({
  component: ManagementPage,
  head: () => ({ meta: [{ title: "Gerenciamento — NEXUS T4" }] }),
});

/**
 * Aba GERENCIAMENTO (comando master §51–§54, §64, §98): a última decisão do
 * BacktestDecisionEngine com entrada/stop/parcial/alvo em destaque. Sem
 * indicador arbitrário como autoridade; sem valores inventados.
 */
function ManagementPage() {
  const [decision, setDecision] = useState<DecisionObject | null>(null);

  useEffect(() => {
    let active = true;
    void store.hydrate().then(() => {
      if (active) setDecision(store.lastDecision<DecisionObject>());
    });
    const timer = setInterval(() => setDecision(store.lastDecision<DecisionObject>()), 2_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <header>
        <h1 className="font-display text-2xl font-bold">Gerenciamento</h1>
        <p className="text-xs text-muted-foreground">
          A confirmação vem da evidência histórica validada (casos semelhantes, expectância,
          out-of-sample, walk-forward, regime, risco) — nunca de um indicador arbitrário. Ausência
          de evidência = aguardar.
        </p>
      </header>
      {/*
        Esta aba lê a ÚLTIMA decisão persistida, não a sessão viva: por isso não
        conhece a contagem de candles do momento nem o estado da escala. Os
        níveis mostrados aqui já saíram guardados do pipeline — sem escala
        validada, eles chegam nulos.
      */}
      <TradeManagementCard decision={decision} />
      {!decision && (
        <Card className="border-border/70 bg-panel p-3 text-xs text-muted-foreground">
          Inicie uma sessão na Operação ao Vivo para o motor de decisão produzir a primeira
          avaliação, e alimente o Backtest pela observação contínua do gráfico para construir a base
          de evidências.
        </Card>
      )}
    </div>
  );
}
