import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { T4Progress, T4Stage } from "@/lib/t4/progress";
import type { TradeSignalSnapshot } from "@/lib/t4/signalSnapshot";
import { cn } from "@/lib/utils";

const STAGE_LABELS: Array<{ key: T4Stage; label: string }> = [
  { key: "ESTRUTURA", label: "ESTRUTURA" },
  { key: "LIQUIDEZ", label: "LIQUIDEZ" },
  { key: "CONTRAPONTO", label: "CONTRAPONTO" },
  { key: "CONFLUENCIAS", label: "CONFLUÊNCIAS" },
  { key: "ENTRADA", label: "ENTRADA" },
];

/**
 * T4 — LEITURA TÉCNICA (comando §6).
 *
 * Substitui o preview/gráfico grande na UI. O percentual vem do estado REAL do
 * pipeline (nunca timer/score fake) e mede a completude da leitura — não é
 * chance de gain. Abaixo de 100%, direção/entrada/stop/3R/5R/runner ficam
 * OCULTOS e os bloqueios reais aparecem. Em 100% (CONFIRMADO + signalId), os
 * níveis exibidos vêm do SNAPSHOT CONGELADO, nunca da análise corrente.
 */
export function T4ProgressCard({
  asset,
  progress,
  snapshot,
}: {
  asset: string;
  progress: T4Progress;
  snapshot: TradeSignalSnapshot | null;
}) {
  const confirmed = progress.percent === 100 && snapshot !== null;
  return (
    <Card className="nexus-card flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="nexus-eyebrow">T4 — LEITURA TÉCNICA</p>
          <p className="font-mono text-xs text-muted-foreground">{asset} | 1 MIN</p>
        </div>
        <Badge
          variant="outline"
          className={cn(
            "font-mono",
            confirmed
              ? "border-bull text-bull"
              : progress.status === "ANALISANDO"
                ? "border-primary text-primary"
                : "border-border text-muted-foreground",
          )}
        >
          STATUS: {confirmed ? "CONFIRMADO" : progress.status}
        </Badge>
      </div>

      <div>
        <div className="flex items-baseline justify-between">
          <span className="font-display text-3xl font-bold text-primary">{progress.percent}%</span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {confirmed ? "TÉCNICA T4 100%" : `PRÓXIMO PASSO: ${progress.currentStepLabel}`}
          </span>
        </div>
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-border/50">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              confirmed ? "bg-bull" : "bg-primary",
            )}
            style={{ width: `${progress.percent}%` }}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {STAGE_LABELS.map((stage) => (
          <Badge
            key={stage.key}
            variant="outline"
            className={cn(
              "font-mono text-[10px]",
              progress.stages[stage.key]
                ? "border-bull text-bull"
                : "border-border text-muted-foreground",
            )}
          >
            {progress.stages[stage.key] ? "✓" : "·"} {stage.label}
          </Badge>
        ))}
      </div>

      {!confirmed && (
        <div className="rounded-md border border-border/60 bg-background/60 p-3">
          <p className="nexus-eyebrow">CARREGAMENTO DA TÉCNICA T4</p>
          {progress.blockers.length > 0 ? (
            <ul className="mt-1 flex flex-col gap-0.5 text-[11px] text-warn">
              {progress.blockers.map((blocker) => (
                <li key={blocker}>• {blocker}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Leitura avançando com candle fechado. Sem setup válido não existe entrada.
            </p>
          )}
        </div>
      )}

      {confirmed && snapshot && (
        <div
          className={cn(
            "rounded-md border p-3",
            snapshot.direction === "COMPRA"
              ? "border-bull/60 bg-bull/10"
              : "border-bear/60 bg-bear/10",
          )}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-display text-lg font-bold">
              ENTRADA CONFIRMADA —{" "}
              <span className={snapshot.direction === "COMPRA" ? "text-bull" : "text-bear"}>
                {snapshot.direction}
              </span>
            </p>
            <Badge variant="outline" className="border-primary text-primary">
              MOMENTO: AGORA
            </Badge>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-sm sm:grid-cols-5">
            <SnapshotField label="ENTRADA" value={snapshot.entry.toFixed(2)} />
            <SnapshotField label="STOP" value={snapshot.initialStop.toFixed(2)} tone="bear" />
            <SnapshotField label="3R" value={snapshot.threeR.toFixed(2)} tone="bull" />
            <SnapshotField label="5R" value={snapshot.fiveR.toFixed(2)} tone="bull" />
            <SnapshotField label="RUNNER" value="ESTRUTURAL" />
          </div>
          <p className="mt-2 font-mono text-[10px] text-muted-foreground">
            {snapshot.signalId} · {snapshot.setup} · snapshot congelado — níveis não oscilam
          </p>
        </div>
      )}
    </Card>
  );
}

function SnapshotField({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "bull" | "bear";
}) {
  return (
    <div>
      <p className="text-[9px] tracking-widest text-muted-foreground">{label}</p>
      <p
        className={cn("font-bold", tone === "bull" && "text-bull", tone === "bear" && "text-bear")}
      >
        {value}
      </p>
    </div>
  );
}
