import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { DNA_GRADE_LABEL, type SetupDna } from "@/lib/t4/dna";
import type { DnaOutcome } from "@/lib/t4/dnaStats";
import { cn } from "@/lib/utils";

import { formatNumber, formatR, ordinalLabel } from "./format";

/** Quantas detecções recentes o painel mostra em card — o resto vive nas
 * tabelas segmentadas; card é para inspecionar caso a caso. */
const RECENT_LIMIT = 20;

/**
 * CARDS DE DETECÇÃO (§4) — as detecções mais recentes, uma a uma.
 *
 * O card junta duas coisas que o banco guarda separadas de propósito: o DNA
 * (classificado ANTES do desfecho, nunca reescrito) e o outcome (que chega
 * depois, via tradeId). Detecção sem resultado é dita "SEM OPERAÇÃO" — um
 * setup DESCARTADO ou não operado é dado legítimo, não linha faltando.
 */
export function DetectionCards({
  detections,
  outcomes,
}: {
  detections: SetupDna[];
  outcomes: DnaOutcome[];
}) {
  if (detections.length === 0) {
    return (
      <Card className="border-border/70 bg-panel p-4">
        <p className="text-xs text-muted-foreground">
          0 detecções registradas — rode um replay ou envie um print.
        </p>
      </Card>
    );
  }

  const outcomeById = new Map(outcomes.map((o) => [o.dna.id, o]));
  const recent = [...detections].sort((a, b) => b.detectedAt - a.detectedAt).slice(0, RECENT_LIMIT);

  return (
    <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
      {recent.map((dna) => (
        <DetectionCard key={dna.id} dna={dna} outcome={outcomeById.get(dna.id)} />
      ))}
    </div>
  );
}

function DetectionCard({ dna, outcome }: { dna: SetupDna; outcome: DnaOutcome | undefined }) {
  const buy = dna.direction === "COMPRA";
  // Outcome pode existir com rMultiple null (setup sem operação) — os dois
  // casos são o mesmo estado para o card: nada foi operado.
  const rMultiple = outcome?.rMultiple ?? null;

  return (
    <Card className="flex flex-col gap-2 border-border/70 bg-panel p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 truncate font-mono text-xs font-bold" title={dna.id}>
          T4 #{dna.id} · <span className={buy ? "text-bull" : "text-bear"}>{dna.direction}</span>
          {" | "}
          {DNA_GRADE_LABEL[dna.grade]}
        </p>
        <span className="font-mono text-[9px] text-muted-foreground">
          {new Date(dna.detectedAt).toLocaleString("pt-BR")}
        </span>
      </div>

      <div className="flex flex-wrap gap-1">
        <Badge variant="outline" className="font-mono text-[9px]">
          {dna.trend}
        </Badge>
        <Badge variant="outline" className="font-mono text-[9px]">
          {dna.position}
        </Badge>
        <Badge variant="outline" className="font-mono text-[9px]">
          PULLBACK {dna.pullback}
        </Badge>
        <Badge variant="outline" className="font-mono text-[9px]">
          GATILHO {dna.triggerCandle}
        </Badge>
        <Badge variant="outline" className="font-mono text-[9px]">
          {/* Volatilidade null = motor sem leitura naquele instante — dito. */}
          VOL {dna.volatility ?? "SEM LEITURA"}
        </Badge>
        <Badge variant="outline" className="font-mono text-[9px]">
          {ordinalLabel(dna.movementOrdinal)}
        </Badge>
        <Badge variant="outline" className="font-mono text-[9px]">
          RR {formatNumber(dna.rrAvailable)}
        </Badge>
      </div>

      <div className="flex flex-wrap items-center gap-2 font-mono text-[10px]">
        <span className="text-muted-foreground">
          {dna.asset} · {dna.timeframe} · {dna.origin}
        </span>
        {rMultiple === null ? (
          <Badge
            variant="outline"
            className="ml-auto border-muted-foreground/50 font-mono text-[9px] text-muted-foreground"
          >
            SEM OPERAÇÃO
          </Badge>
        ) : (
          <span className="ml-auto flex items-center gap-2">
            <span
              className={cn(
                "font-bold",
                rMultiple > 0 ? "text-bull" : rMultiple < 0 ? "text-bear" : "",
              )}
            >
              {formatR(rMultiple)}
            </span>
            <span className="text-muted-foreground">
              MFE {formatR(outcome?.mfeR ?? null)} · MAE {formatR(outcome?.maeR ?? null)}
            </span>
          </span>
        )}
      </div>
    </Card>
  );
}
