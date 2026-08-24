import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  listHistory,
  removeHistoryEntry,
  requestReopen,
  type PrintHistoryEntry,
} from "@/lib/print/printHistory";
import {
  deriveEntryDecision,
  PRINT_STATUS_LABEL,
  NAO_IDENTIFICADO,
} from "@/lib/vision/printAnalysis";

/**
 * O rótulo do card no histórico passa pela MESMA trava da tela de análise.
 *
 * Entradas gravadas antes da regra carregam ENTRADA_CONFIRMADA no JSON sem as
 * provas; repetir o campo cru aqui manteria a afirmação viva num lugar onde
 * não há card de pendências para contradizê-la.
 */
function rotuloDoStatus(analysis: PrintHistoryEntry["analysis"]): string {
  if (analysis.status !== "ENTRADA_CONFIRMADA") return PRINT_STATUS_LABEL[analysis.status];
  return deriveEntryDecision(analysis).entradaConfirmada
    ? PRINT_STATUS_LABEL.ENTRADA_CONFIRMADA
    : "CONFIRMAÇÃO NÃO PROVADA";
}

export const Route = createFileRoute("/historico-prints")({
  component: HistoricoPage,
  head: () => ({ meta: [{ title: "Histórico de Análises — NEXUS T4" }] }),
});

/**
 * HISTÓRICO DE ANÁLISES DE PRINT.
 *
 * Lê do localStorage DESTE navegador — o aviso está na tela porque um histórico
 * que parece global mas é local surpreende na pior hora: quando o operador
 * troca de máquina e "perdeu tudo". As imagens são miniaturas reduzidas; a
 * reabertura diz isso.
 */
function HistoricoPage() {
  const [entradas, setEntradas] = useState<PrintHistoryEntry[]>([]);
  const navigate = useNavigate();

  useEffect(() => setEntradas(listHistory()), []);

  const excluir = (id: string) => {
    removeHistoryEntry(id);
    setEntradas(listHistory());
  };

  const reabrir = (id: string) => {
    requestReopen(id);
    void navigate({ to: "/analisar-print" });
  };

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">Histórico de Análises</h1>
          <p className="text-xs text-muted-foreground">
            Guardado neste navegador, com miniaturas — as últimas {8} análises de print.
          </p>
        </div>
        <Button asChild size="sm" variant="outline" className="ml-auto font-mono text-xs">
          <Link to="/analisar-print">
            <ArrowLeft className="mr-1 h-3.5 w-3.5" />
            ANALISAR PRINT
          </Link>
        </Button>
      </header>

      {entradas.length === 0 ? (
        <Card className="border-border/70 bg-panel p-6 text-center">
          <p className="text-sm text-muted-foreground">
            Nenhuma análise guardada ainda. Analise um print e ele aparece aqui.
          </p>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {entradas.map((e) => (
            <Card key={e.id} className="flex flex-col gap-2 border-border/70 bg-panel p-3">
              <button
                type="button"
                className="overflow-hidden rounded border border-border/50"
                onClick={() => reabrir(e.id)}
                title="Reabrir esta análise"
              >
                <img src={e.thumb} alt="Miniatura do print" className="block w-full" />
              </button>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="font-mono text-[10px]">
                  {rotuloDoStatus(e.analysis)}
                </Badge>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {e.analysis.symbol ?? NAO_IDENTIFICADO} ·{" "}
                  {e.analysis.timeframe ?? NAO_IDENTIFICADO}
                </span>
                {e.feedback && (
                  <span className="font-mono text-[10px]">
                    {e.feedback.verdict === "CORRETA" ? "👍" : "👎"}
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] text-muted-foreground">
                  {new Date(e.at).toLocaleString("pt-BR")}
                </span>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-[10px]"
                    onClick={() => reabrir(e.id)}
                  >
                    REABRIR
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2"
                    onClick={() => excluir(e.id)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
