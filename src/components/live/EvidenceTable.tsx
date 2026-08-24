import { useState } from "react";
import { ChevronDown } from "lucide-react";

import { Card } from "@/components/ui/card";
import type { TechnicalEvidence } from "@/lib/engines/types";
import { guardNarration, guardRegion } from "@/lib/t4/priceGuard";
import { cn } from "@/lib/utils";

export function EvidenceTable({
  evidences,
  priceScaleReady = true,
}: {
  evidences: TechnicalEvidence[];
  /** Sem escala validada, toda faixa citada aqui e coordenada de pixel. */
  priceScaleReady?: boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    <Card className="border-border/70 bg-panel p-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between px-3 py-2 text-left"
      >
        <span className="text-[10px] font-medium tracking-widest text-muted-foreground">
          EVIDÊNCIAS TÉCNICAS OBSERVADAS
        </span>
        <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="overflow-x-auto px-3 pb-3">
          <table className="w-full min-w-[680px] font-mono text-[11px]">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 font-normal">Critério</th>
                <th className="font-normal">Estado</th>
                <th className="text-right font-normal">Valor observado</th>
                <th className="pl-3 font-normal">Justificativa objetiva</th>
              </tr>
            </thead>
            <tbody>
              {evidences.map((item) => (
                <tr key={item.id} className="border-t border-border/40 align-top">
                  <td className="py-2 pr-2">
                    {item.label}
                    <div className="text-[9px] text-muted-foreground">
                      {/* A regiao do POI e um intervalo puro ("194.00-197.00"): nenhum
                          termo antes o identifica como preco, e por isso ele escapou
                          das varreduras por termo e por preposicao. */}
                      {guardRegion(item.chartRegion, priceScaleReady)}
                    </div>
                  </td>
                  <td
                    className={cn(
                      "py-2",
                      item.state === "confirmada" && "text-bull",
                      item.state === "invalidada" && "text-bear",
                      item.state === "parcial" && "text-warn",
                    )}
                  >
                    {item.state}
                  </td>
                  <td className="py-2 text-right">
                    {item.measuredValue === null ? "—" : item.measuredValue.toFixed(0)}
                  </td>
                  <td className="py-2 pl-3 font-sans text-[10px] text-muted-foreground">
                    {/* A justificativa é texto livre do motor e também cita níveis. */}
                    {guardNarration(item.justification, priceScaleReady)}
                  </td>
                </tr>
              ))}
              {evidences.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-4 text-center text-muted-foreground">
                    Aguardando candles fechados e escala calibrada.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
