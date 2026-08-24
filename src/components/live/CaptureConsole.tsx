import { Check, Pause, Play, RefreshCw, ScreenShare } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { ChartCaptureStatus } from "@/hooks/useContinuousChartCapture";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<ChartCaptureStatus, string> = {
  "sem-fonte": "sem captura",
  "aguardando-confirmacao": "confirme a janela",
  capturando: "capturando",
  pausado: "pausado",
};

/**
 * CONSOLE DE CAPTURA COMPACTO (comando §6).
 *
 * O preview/player grande foi removido da UI: o processamento roda no
 * ScreenCaptureManager global, num <video> interno que nenhuma página destrói.
 * Aqui ficam somente o estado REAL da captura e os controles.
 */
export function CaptureConsole({
  status,
  fps,
  resolution,
  lastFrameAt,
  error,
  sourceLabel,
  onSelectSource,
  onConfirmPreview,
  onPause,
  onResume,
  onSwitchSource,
}: {
  status: ChartCaptureStatus;
  fps: number;
  resolution: string | null;
  lastFrameAt: number | null;
  error: string | null;
  sourceLabel: string | null;
  onSelectSource: () => void;
  onConfirmPreview: () => void;
  onPause: () => void;
  onResume: () => void;
  onSwitchSource: () => void;
}) {
  const active = status === "capturando";
  return (
    <Card className="flex flex-col gap-2 border-border/70 bg-panel p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[10px] font-medium tracking-widest text-muted-foreground">
          CAPTURA GLOBAL DO GRÁFICO — 1 MINUTO
        </p>
        <Badge variant="outline" className={cn("text-[10px]", active && "border-bull text-bull")}>
          {active && (
            <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-bull" />
          )}
          {STATUS_LABEL[status]}
        </Badge>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {sourceLabel ?? "—"} · FPS {fps} · {resolution ?? "—"} ·{" "}
          {lastFrameAt
            ? new Date(lastFrameAt).toLocaleTimeString("pt-BR", { hour12: false })
            : "sem frame"}
        </span>
      </div>

      <p className="text-[10px] text-muted-foreground">
        A captura continua ativa em qualquer aba do analisador — trocar de rota não interrompe
        candles, contexto nem o T4. O preview foi removido; o processamento é invisível.
      </p>

      {error && <p className="rounded bg-bear/10 px-2 py-1 text-[11px] text-bear">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        {status === "sem-fonte" && (
          <Button size="sm" onClick={onSelectSource}>
            <ScreenShare className="mr-1.5 h-3.5 w-3.5" />
            Selecionar janela do Profit
          </Button>
        )}
        {status === "aguardando-confirmacao" && (
          <Button size="sm" onClick={onConfirmPreview}>
            <Check className="mr-1.5 h-3.5 w-3.5" />
            Confirmar esta janela
          </Button>
        )}
        {status === "pausado" && (
          <Button size="sm" onClick={onResume}>
            <Play className="mr-1.5 h-3.5 w-3.5" />
            Retomar
          </Button>
        )}
        {status === "capturando" && (
          <Button size="sm" variant="secondary" onClick={onPause}>
            <Pause className="mr-1.5 h-3.5 w-3.5" />
            Pausar
          </Button>
        )}
        {status !== "sem-fonte" && (
          <Button size="sm" variant="secondary" onClick={onSwitchSource}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Trocar janela
          </Button>
        )}
      </div>
    </Card>
  );
}
