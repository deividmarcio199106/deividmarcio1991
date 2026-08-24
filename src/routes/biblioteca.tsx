import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { filterEvidenceTrades } from "@/lib/engines/evidenceFilter";
import { techniqueStats, TECHNIQUE_MIN_SAMPLE } from "@/lib/knowledge/techniqueStats";
import type { TechniqueCategory } from "@/lib/knowledge/techniqueLibrary";
import { store } from "@/lib/storage";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/biblioteca")({
  component: LibraryPage,
  head: () => ({
    meta: [
      { title: "Biblioteca de Conhecimento — NEXUS Trading Intelligence" },
      {
        name: "description",
        content:
          "Técnicas de trading catalogadas com origem rastreável, regras objetivas, detecção automática e validação estatística individual.",
      },
    ],
  }),
});

const CATEGORY_LABEL: Record<TechniqueCategory, string> = {
  wyckoff: "Wyckoff",
  smc_ict: "SMC / ICT",
  price_action: "Price Action",
  order_flow: "Order Flow",
  gestao: "Gestão",
};

/**
 * BIBLIOTECA DE CONHECIMENTO (comando de expansão).
 *
 * Cada técnica: origem, contexto, gatilho, invalidação, alvo — e o veredito
 * ESTATÍSTICO individual construído pelos backtests deste sistema. Técnica
 * catalogada mas não detectável mostra exatamente qual dado falta; nada é
 * "detectado" sem o motor conseguir medir.
 */
function LibraryPage() {
  const [filter, setFilter] = useState<TechniqueCategory | "todas">("todas");

  const rows = useMemo(() => {
    const trades = filterEvidenceTrades(store.backtests());
    return techniqueStats(trades);
  }, []);

  const visible =
    filter === "todas" ? rows : rows.filter((row) => row.technique.category === filter);
  const detectable = rows.filter((row) => row.technique.status === "DETECTABLE").length;

  return (
    <div className="flex flex-col gap-3">
      <header>
        <h1 className="font-display text-2xl font-bold">Biblioteca de Conhecimento</h1>
        <p className="text-xs text-muted-foreground">
          {rows.length} técnicas catalogadas com origem rastreável · {detectable} detectáveis pelo
          motor atual. Detecção rotula a configuração; quem valida é a estatística individual (gate
          de {TECHNIQUE_MIN_SAMPLE} casos). Catalogar não é recomendar.
        </p>
      </header>

      <div className="flex flex-wrap gap-1.5">
        {(["todas", "wyckoff", "smc_ict", "price_action", "order_flow", "gestao"] as const).map(
          (category) => (
            <button
              key={category}
              onClick={() => setFilter(category)}
              className={cn(
                "rounded-md border px-2.5 py-1 font-mono text-[11px] transition-colors",
                filter === category
                  ? "border-primary/60 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {category === "todas" ? "TODAS" : CATEGORY_LABEL[category].toUpperCase()}
            </button>
          ),
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {visible.map((row) => (
          <Card key={row.technique.id} className="nexus-card flex flex-col gap-2 p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-display text-sm font-bold">{row.technique.name}</p>
                <p className="text-[10px] text-muted-foreground">{row.technique.origin}</p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <Badge variant="outline" className="border-border text-muted-foreground">
                  {CATEGORY_LABEL[row.technique.category]}
                </Badge>
                <Badge
                  variant="outline"
                  className={
                    row.technique.status === "DETECTABLE"
                      ? "border-primary/60 text-primary"
                      : "border-border text-muted-foreground"
                  }
                >
                  {row.technique.status === "DETECTABLE"
                    ? "DETECTÁVEL"
                    : row.technique.status === "CATALOGED"
                      ? "CATALOGADA"
                      : "DESATIVADA"}
                </Badge>
              </div>
            </div>

            <div className="flex flex-col gap-1 text-[11px]">
              <p>
                <span className="nexus-eyebrow">CONTEXTO · </span>
                {row.technique.context}
              </p>
              <p>
                <span className="nexus-eyebrow">GATILHO · </span>
                {row.technique.trigger}
              </p>
              <p>
                <span className="nexus-eyebrow">INVALIDAÇÃO · </span>
                {row.technique.invalidation}
              </p>
              <p>
                <span className="nexus-eyebrow">ALVO · </span>
                {row.technique.target}
              </p>
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-border/40 pt-2">
              <span
                className={cn(
                  "font-mono text-[11px] font-bold",
                  row.verdict === "VALIDADA" && "text-bull",
                  row.verdict === "NAO_VALIDADA" && "text-bear",
                  row.verdict === "AMOSTRA_INSUFICIENTE" && "text-muted-foreground",
                )}
              >
                {row.verdict === "AMOSTRA_INSUFICIENTE"
                  ? `AMOSTRA INSUFICIENTE (${row.sample}/${TECHNIQUE_MIN_SAMPLE})`
                  : `${row.verdict.replace("_", " ")} (${row.sample} casos)`}
              </span>
              {row.stats && (
                <span className="nexus-value text-[10px] text-muted-foreground">
                  {row.stats.winRate.toFixed(0)}% · {row.stats.expectancy >= 0 ? "+" : ""}
                  {row.stats.expectancy.toFixed(2)}R
                </span>
              )}
            </div>
            <p className="text-[10px] text-muted-foreground">{row.reason}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}
