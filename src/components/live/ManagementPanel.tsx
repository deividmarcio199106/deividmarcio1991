import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { AnalysisResult } from "@/lib/engines/types";
import { cn } from "@/lib/utils";

function value(value: number | null | undefined, decimals = 2): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? "—"
    : value.toFixed(decimals);
}

function Field({
  label,
  text,
  tone,
}: {
  label: string;
  text: string;
  tone?: "bull" | "bear" | "warn";
}) {
  return (
    <div>
      <p className="text-[9px] tracking-widest text-muted-foreground">{label}</p>
      <p
        className={cn(
          "font-mono text-sm font-semibold",
          tone === "bull" && "text-bull",
          tone === "bear" && "text-bear",
          tone === "warn" && "text-warn",
        )}
      >
        {text}
      </p>
    </div>
  );
}

/** Leitura técnica; a autorização final continua no motor de evidência histórica. */
export function ManagementPanel({
  analysis,
  asset,
}: {
  analysis: AnalysisResult | null;
  asset: string;
}) {
  const exposeManagement = Boolean(
    analysis?.technicalReady && analysis.reading.sufficient && analysis.plan,
  );
  const plan = exposeManagement ? analysis?.plan : null;
  return (
    <Card className="border-border/70 bg-panel p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-[10px] font-medium tracking-widest text-muted-foreground">
          T4 — LEITURA TÉCNICA · REPLAY E AO VIVO USAM O MESMO MOTOR
        </p>
        <Badge
          variant="outline"
          className={cn(
            "text-[10px]",
            analysis?.technicalReady ? "border-bull text-bull" : "border-warn text-warn",
          )}
        >
          {analysis?.technicalReady ? "SETUP TÉCNICO COMPLETO" : "AGUARDAR"}
        </Badge>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-6">
        <Field label="ATIVO" text={asset} />
        <Field label="PERÍODO" text="1 minuto" />
        {exposeManagement && plan ? (
          <>
            <Field
              label="DIREÇÃO"
              text={analysis?.direction ?? "AGUARDANDO"}
              tone={analysis?.direction === "COMPRA" ? "bull" : "bear"}
            />
            <Field
              label="SETUP T4"
              text={`${analysis?.t4.quality ?? "—"} · ${analysis?.t4.setup ?? "NONE"}`}
            />
            <Field label="PREÇO ATUAL" text={value(analysis?.price)} />
            <Field label="ENTRADA" text={value(plan.entry)} />
            <Field label="STOP TÉCNICO" text={value(plan.stop)} tone="bear" />
            <Field label="DISTÂNCIA STOP" text={`${value(plan.stopDistance)} pts`} />
            <Field label="1º CONTRATO · 3R" text={value(plan.target1)} tone="bull" />
            <Field label="2º CONTRATO · 5R" text={value(plan.target2)} tone="bull" />
            <Field label="3º CONTRATO" text="RUNNER ESTRUTURAL" tone="bull" />
            <Field label="R:R PARCIAL" text={`${value(plan.riskReward)}R`} />
            <Field label="R:R FINAL" text={`${value(plan.riskRewardFinal)}R`} />
            <Field label="R:R PLANO" text={`${value(plan.riskRewardPlan)}R`} />
          </>
        ) : (
          <div className="col-span-2 rounded-md border border-warn/40 bg-warn/10 p-2 text-[11px] text-warn sm:col-span-4 xl:col-span-4">
            Entrada, stop e alvos ficam ocultos até a leitura visual e os gates específicos da T4
            estarem completos.
          </div>
        )}
        <Field
          label="ESTADO DA LEITURA"
          text={analysis?.reading.label ?? "AGUARDANDO"}
          tone={analysis?.reading.sufficient ? "bull" : "warn"}
        />
      </div>
      {analysis?.blockers.length ? (
        <ul className="mt-3 space-y-1 rounded-md border border-warn/40 bg-warn/10 p-2 text-[11px] text-warn">
          {analysis.blockers.map((blocker) => (
            <li key={blocker}>• {blocker}</li>
          ))}
        </ul>
      ) : null}
      <p className="mt-3 text-[10px] text-muted-foreground">
        Quantidade de contratos é calculada somente por risco financeiro configurado, stop, valor do
        ponto, limites operacionais e drawdown. O sistema não executa ordens.
      </p>
    </Card>
  );
}
