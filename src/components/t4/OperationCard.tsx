import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { STAGE_LABEL, type T4Operation } from "@/lib/t4/preEntry";
import { cn } from "@/lib/utils";

/**
 * O card que o operador olha primeiro.
 *
 * A regra que governa o layout inteiro: enquanto `confirmed` for falso, TODO
 * número aparece marcado como provisório e a chamada de ação diz "aguardar".
 * Um painel que mostra entrada, stop e alvo com a mesma cara antes e depois do
 * gatilho transforma expectativa em ordem — que é justamente o erro que o
 * estágio de pré-entrada existe para evitar.
 */

const STAGE_TONE: Record<T4Operation["stage"], string> = {
  AGUARDANDO: "border-border text-muted-foreground",
  OBSERVANDO: "border-border text-muted-foreground",
  PREPARANDO_COMPRA: "border-bull text-bull",
  PREPARANDO_VENDA: "border-bear text-bear",
  GATILHO_PROXIMO: "border-amber-500 text-amber-500",
  ENTRADA_CONFIRMADA: "border-bull text-bull",
  INVALIDADA: "border-bear text-bear",
  ENCERRADA: "border-border text-muted-foreground",
};

function Level({
  label,
  value,
  decimals = 0,
  tone,
}: {
  label: string;
  value: number | null;
  decimals?: number;
  tone?: "bull" | "bear";
}) {
  return (
    <div className="min-w-0">
      <p className="nexus-eyebrow truncate">{label}</p>
      <p
        className={cn(
          "nexus-value truncate font-mono text-sm",
          tone === "bull" && "text-bull",
          tone === "bear" && "text-bear",
          value === null && "text-muted-foreground",
        )}
      >
        {value === null ? "—" : value.toFixed(decimals)}
      </p>
    </div>
  );
}

export function OperationCard({
  operation,
  priceScaleReady = true,
  calibrating = false,
}: {
  operation: T4Operation;
  priceScaleReady?: boolean;
  /** Qwen lendo o eixo agora. O setup NAO espera por isso. */
  calibrating?: boolean;
}) {
  const armed =
    operation.stage === "PREPARANDO_COMPRA" ||
    operation.stage === "PREPARANDO_VENDA" ||
    operation.stage === "GATILHO_PROXIMO";
  const compra = operation.direction === "COMPRA";
  const tone = operation.direction === null ? undefined : compra ? "bull" : "bear";

  return (
    <Card className="nexus-card gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="nexus-eyebrow">ANÁLISE T4</p>
        <Badge variant="outline" className={cn("font-mono", STAGE_TONE[operation.stage])}>
          {STAGE_LABEL[operation.stage]}
        </Badge>
        {operation.direction !== null && operation.stage !== "AGUARDANDO" && (
          <Badge
            variant="outline"
            className={cn("font-mono", compra ? "border-bull text-bull" : "border-bear text-bear")}
          >
            {operation.direction}
          </Badge>
        )}
        {!priceScaleReady && (armed || operation.confirmed) && (
          <Badge variant="outline" className="border-amber-500 font-mono text-amber-500">
            {calibrating ? "PREÇO EM CALIBRAÇÃO" : "PREÇO NÃO CONFIÁVEL"}
          </Badge>
        )}

        {operation.provisional && operation.entry !== null && (
          <Badge variant="outline" className="font-mono text-muted-foreground">
            PROVISÓRIO
          </Badge>
        )}
        <span
          className="nexus-eyebrow ml-auto"
          title="Maturidade do setup — não é probabilidade de acerto"
        >
          {operation.maturity}%
        </span>
      </div>

      <div className="h-1.5 w-full overflow-hidden rounded bg-border/40">
        <div
          className={cn(
            "h-full transition-all",
            operation.confirmed ? "bg-bull" : armed ? "bg-amber-500" : "bg-muted-foreground/50",
          )}
          style={{ width: `${operation.maturity}%` }}
        />
      </div>

      {operation.stage === "AGUARDANDO" && (
        <p className="rounded border border-border/70 p-2 text-xs text-muted-foreground">
          Sem dado válido não há leitura. {operation.blockReason ?? ""}
        </p>
      )}

      {operation.stage === "INVALIDADA" && (
        <div className="rounded border border-bear/50 bg-bear/10 p-2 text-xs text-bear">
          <p className="font-semibold">Pré-entrada cancelada.</p>
          <p className="mt-1">{operation.blockReason}</p>
          <p className="mt-1">
            Os níveis foram apagados de propósito: manter ordem sugerida de um setup morto é pior
            que não mostrar nada.
          </p>
        </div>
      )}

      {(armed || operation.confirmed) && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Level
              label={operation.confirmed ? "ENTRADA" : "ENTRADA PLANEJADA"}
              value={operation.entry}
              tone={tone}
            />
            <Level label="STOP" value={operation.stop} tone={compra ? "bear" : "bull"} />
            <Level label="PARCIAL" value={operation.partial} />
            <Level label="ALVO" value={operation.target} />
            <div className="min-w-0">
              <p className="nexus-eyebrow truncate">R:R</p>
              <p className="nexus-value truncate font-mono text-sm">
                {operation.riskReward === null ? "—" : operation.riskReward.toFixed(2)}
              </p>
            </div>
            <div className="min-w-0">
              <p className="nexus-eyebrow truncate">CONTRATOS</p>
              <p className="nexus-value truncate font-mono text-sm">
                {operation.contracts === null ? "—" : String(operation.contracts)}
              </p>
            </div>
          </div>

          {operation.entryZone !== null && (
            <p className="font-mono text-xs text-muted-foreground">
              FAIXA VÁLIDA {operation.entryZone.min.toFixed(0)} –{" "}
              {operation.entryZone.max.toFixed(0)}
              {operation.riskPoints !== null && <> · risco {operation.riskPoints.toFixed(0)} pts</>}
              {operation.rewardPoints !== null && (
                <> · retorno {operation.rewardPoints.toFixed(0)} pts</>
              )}
            </p>
          )}

          {operation.invalidation !== null && (
            <p className="text-xs text-muted-foreground">
              <span className="nexus-eyebrow">INVALIDAÇÃO</span> {operation.invalidation}
            </p>
          )}

          {/*
            A frase que separa análise de execução. O sistema nunca envia ordem;
            quem decide operar é o operador, e a condição precisa estar escrita.
          */}
          <p
            className={cn(
              "rounded border p-2 text-xs font-semibold",
              operation.confirmed
                ? "border-bull/50 bg-bull/10 text-bull"
                : "border-amber-500/50 bg-amber-500/10 text-amber-500",
            )}
          >
            {operation.confirmed
              ? `${operation.direction} CONFIRMADA — entrar somente se o preço ainda estiver na faixa e as condições continuarem válidas.`
              : `AGUARDANDO GATILHO — não é entrada. ${operation.blockReason ?? "falta a confirmação final."}`}
          </p>
        </>
      )}

      {operation.missing.length > 0 && !operation.confirmed && (
        <div>
          <p className="nexus-eyebrow mb-1">CONDIÇÕES FALTANTES</p>
          <ul className="grid gap-0.5 font-mono text-[11px] text-muted-foreground">
            {operation.missing.slice(0, 4).map((item) => (
              <li key={item} className="truncate" title={item}>
                · {item}
              </li>
            ))}
          </ul>
        </div>
      )}

      {operation.reasons.length > 0 && (
        <details className="text-[11px]">
          <summary className="nexus-eyebrow cursor-pointer">
            POR QUE ({operation.reasons.length} condições cumpridas)
          </summary>
          <ul className="mt-1 grid gap-0.5 font-mono text-muted-foreground">
            {operation.reasons.map((item) => (
              <li key={item} className="truncate" title={item}>
                ✓ {item}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
