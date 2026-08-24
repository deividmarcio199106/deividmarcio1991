import { MonitorPlay, Power, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { ProfitVision } from "@/hooks/useProfitVision";
import { streamLabel, visualLabel } from "@/lib/vision/streamLiveness";
import { cn } from "@/lib/utils";

/**
 * O único botão operacional da tela.
 *
 * Antes de estar lendo, existe UMA ação possível — e ela ocupa o lugar de
 * destaque. Depois que a leitura começa, o botão some e dá lugar ao estado:
 * oferecer "iniciar" para quem já iniciou é ruído, e oferecer "conectar" num
 * segundo lugar seria convite a ligar metade do sistema.
 */

type Tone = "ok" | "warn" | "bad" | "idle";

const DOT: Record<Tone, string> = {
  ok: "bg-bull",
  warn: "bg-amber-500",
  bad: "bg-bear",
  idle: "bg-muted-foreground/40",
};

const TEXT: Record<Tone, string> = {
  ok: "text-bull",
  warn: "text-amber-500",
  bad: "text-bear",
  idle: "text-muted-foreground",
};

function Status({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span className={cn("h-2 w-2 shrink-0 rounded-full", DOT[tone])} />
      <span className="nexus-eyebrow shrink-0">{label}</span>
      <span className={cn("truncate font-mono text-xs", TEXT[tone])} title={value}>
        {value}
      </span>
    </div>
  );
}

export function ProfitVisionPanel({
  vision,
  gpuStatus,
  t4State,
}: {
  vision: ProfitVision;
  /** Estado PROVADO do servico de visao. DESCONHECIDO nao e ONLINE. */
  gpuStatus: "ONLINE" | "OFFLINE" | "DESCONHECIDO";
  t4State: string;
}) {
  const { liveness } = vision;

  // CAPTURA depende SO da track. Imagem parada nao e captura parada — foi
  // exatamente essa confusao que derrubou a T4 no Golden.
  const captureTone: Tone = !vision.requested
    ? "idle"
    : liveness.stream === "ENDED" || liveness.stream === "ERROR"
      ? "bad"
      : "ok";
  // GRAFICO e informativo: estatico e amarelo, nunca vermelho.
  const chartTone: Tone = !vision.requested
    ? "idle"
    : liveness.visual === "MOVING"
      ? "ok"
      : liveness.visual === "STATIC"
        ? "warn"
        : "idle";

  return (
    <Card className="nexus-card gap-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="nexus-eyebrow">FONTE DO GRÁFICO</span>

        {!vision.requested ? (
          <Button size="sm" onClick={() => void vision.start()} disabled={vision.selecting}>
            <MonitorPlay className="mr-1.5 h-4 w-4" />
            {vision.selecting ? "ESCOLHA A JANELA DO PROFIT…" : "INICIAR LEITURA DO PROFIT"}
          </Button>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "rounded border px-2 py-1 font-mono text-xs",
                vision.reading
                  ? "border-bull/50 bg-bull/10 text-bull"
                  : "border-bear/50 bg-bear/10 text-bear",
              )}
            >
              {vision.reading ? "LEITURA ATIVA ✓" : "LEITURA INTERROMPIDA"}
            </span>
            <Button size="sm" variant="outline" onClick={vision.stop}>
              <Power className="mr-1.5 h-3.5 w-3.5" />
              PARAR LEITURA
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void vision.switchSource()}
              disabled={vision.selecting}
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              TROCAR FONTE
            </Button>
          </div>
        )}

        {!vision.requested && (
          <span className="text-xs text-muted-foreground">
            Abra o Profit no gráfico de 1 minuto e clique aqui. A janela é escolhida uma vez só.
          </span>
        )}
      </div>

      {vision.error !== null && (
        <p className="rounded border border-bear/50 bg-bear/10 p-2 text-xs text-bear">
          {vision.error}
        </p>
      )}

      {/*
        Leitura interrompida bloqueia confirmação nova. Um gráfico congelado
        parece um mercado parado, e confirmar entrada sobre uma imagem que não
        muda é decidir sobre o passado.
      */}
      {vision.requested && liveness.stream === "ENDED" && (
        <p className="rounded border border-bear/50 bg-bear/10 p-2 text-xs text-bear">
          <span className="font-semibold">Leitura interrompida.</span> {liveness.detail} Nenhuma
          confirmação nova será emitida até a imagem voltar a variar.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Status
          label="CAPTURA"
          value={vision.requested ? streamLabel(liveness) : "—"}
          tone={captureTone}
        />
        <Status
          label="GRÁFICO"
          value={vision.requested ? visualLabel(liveness) : "—"}
          tone={chartTone}
        />
        {/*
          VERDE SO COM PROVA. Antes bastava "nao esta OFFLINE" para acender
          ONLINE — e antes da primeira leitura de escala o estado e DESCONHECIDO,
          entao o painel afirmava que a visao estava no ar sem nunca ter falado
          com ela.
        */}
        <Status
          label="VISÃO IA"
          value={gpuStatus}
          tone={gpuStatus === "ONLINE" ? "ok" : gpuStatus === "OFFLINE" ? "bad" : "idle"}
        />
        <Status
          label="T4"
          value={vision.reading ? t4State : "AGUARDANDO LEITURA"}
          tone={vision.reading ? (t4State === "PAUSED_DATA" ? "bad" : "ok") : "idle"}
        />
      </div>

      {vision.requested && (
        <p className="font-mono text-[11px] text-muted-foreground">
          {Math.round(liveness.fps)} fps · {liveness.width}×{liveness.height} ·{" "}
          {liveness.framesReceived} frames · parado há {Math.round(liveness.staticForMs / 1000)}s ·{" "}
          {vision.visual.updates} atualizações de estado
        </p>
      )}
    </Card>
  );
}
