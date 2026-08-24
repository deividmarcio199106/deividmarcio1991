import { aiReachable } from "@/lib/ai/aiReachable";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Camera, Monitor, Pause, Play, Square } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { marketMonitor, type MonitorStage } from "@/lib/capture/marketMonitor";
import { screenCaptureManager } from "@/lib/capture/screenCaptureManager";
import { cn } from "@/lib/utils";

/**
 * CAPTURA CONTÍNUA — seleciona o Profit UMA vez; a cada 60 segundos um print
 * real é congelado do stream oculto e enviado à IA, com o gráfico parado ou
 * não. Decisão do operador (18/08): cadência fixa; a captura "só quando muda"
 * foi removida.
 *
 * Este componente é só o rosto. O ciclo vive no `marketMonitor` (singleton
 * fora do React, como o capture manager): trocar de rota, re-renderizar ou
 * fechar este painel NÃO para o relógio — e é por isso que aqui não existe
 * nenhum setInterval: um segundo timer no componente seria o timer duplicado
 * clássico de re-render.
 */

const STAGE_LABEL: Record<MonitorStage, string> = {
  OCIOSO: "AGUARDANDO SELEÇÃO",
  MONITORANDO: "T4 MONITORANDO",
  CAPTURANDO: "CAPTURANDO",
  ANALISANDO: "ANALISANDO",
  PAUSADO: "PAUSADO",
  ENCERRADO: "STREAM ENCERRADO",
};

const STAGE_TONE: Record<MonitorStage, string> = {
  OCIOSO: "border-border text-muted-foreground",
  MONITORANDO: "border-bull text-bull",
  CAPTURANDO: "border-primary text-primary",
  ANALISANDO: "border-primary text-primary",
  PAUSADO: "border-amber-500 text-amber-500",
  ENCERRADO: "border-bear text-bear",
};

function hora(at: number | null): string {
  if (at === null) return "—";
  return new Date(at).toLocaleTimeString("pt-BR");
}

export function ScreenCapturePanel() {
  /** IA alcançável? Health HTTP a cada 30s — badge, nunca bloqueio. */
  const [iaOk, setIaOk] = useState<boolean | null>(null);
  useEffect(() => {
    let vivo = true;
    const checar = async () => {
      // Poller COMPARTILHADO: dois consumidores, uma requisição.
      const ok = await aiReachable();
      if (vivo) setIaOk(ok);
    };
    void checar();
    const timer = setInterval(() => void checar(), 30_000);
    return () => {
      vivo = false;
      clearInterval(timer);
    };
  }, []);

  const state = useSyncExternalStore(
    (listener) => marketMonitor.subscribe(listener),
    () => marketMonitor.getState(),
    () => marketMonitor.getState(),
  );
  const ativo = state.stage !== "OCIOSO" && state.stage !== "ENCERRADO";

  /*
   * GUARDA DE REENTRADA (auditoria sênior, B8): o seletor de janela é
   * assíncrono e o botão continuava clicável — dois cliques abriam dois
   * seletores e o segundo confirmava por cima do primeiro, com dois begin()
   * disputando o mesmo monitor. Enquanto um start está em voo, os demais são
   * ignorados; o finally solta a trava aconteça o que acontecer.
   */
  const startingRef = useRef(false);
  const start = async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    try {
      await screenCaptureManager.selectSource();
      screenCaptureManager.confirmPreview();
      marketMonitor.begin();
    } catch {
      // Cancelar o seletor é escolha do operador, não erro.
    } finally {
      startingRef.current = false;
    }
  };

  const stop = () => {
    marketMonitor.stop();
    screenCaptureManager.stop("captura contínua encerrada pelo operador");
  };

  return (
    <Card className="flex flex-col gap-2 border-border/70 bg-panel p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="nexus-eyebrow">CAPTURA {ativo ? "ATIVA" : "CONTÍNUA"}</span>
        <Badge variant="outline" className={cn("font-mono text-[10px]", STAGE_TONE[state.stage])}>
          {STAGE_LABEL[state.stage]}
        </Badge>
        {ativo && (
          <>
            <Badge
              variant="outline"
              className={cn(
                "font-mono text-[10px]",
                state.frozen
                  ? "border-bear text-bear"
                  : state.streamOk
                    ? "border-bull text-bull"
                    : "border-amber-500 text-amber-500",
              )}
            >
              STREAM {state.frozen ? "CONGELADO" : state.streamOk ? "OK" : "AGUARDANDO"}
            </Badge>
            <Badge variant="outline" className="font-mono text-[10px]">
              CAPTURAS: {state.captures}
            </Badge>
            <Badge
              variant="outline"
              className={cn(
                "font-mono text-[10px]",
                iaOk === null
                  ? "border-border text-muted-foreground"
                  : iaOk
                    ? "border-bull text-bull"
                    : "border-bear text-bear",
              )}
            >
              IA {iaOk === null ? "…" : iaOk ? "OK" : "FORA"}
            </Badge>
          </>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {!ativo ? (
            <Button size="sm" onClick={() => void start()} className="font-mono text-xs">
              <Monitor className="mr-1.5 h-3.5 w-3.5" />
              {state.needsReselect ? "SELECIONAR JANELA NOVAMENTE" : "SELECIONAR JANELA DO PROFIT"}
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                className="font-mono text-xs"
                onClick={() => marketMonitor.analyzeNow()}
              >
                <Camera className="mr-1.5 h-3.5 w-3.5" />
                ANALISAR AGORA
              </Button>
              {state.stage === "PAUSADO" ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="font-mono text-xs"
                  onClick={() => marketMonitor.resume()}
                >
                  <Play className="mr-1.5 h-3.5 w-3.5" />
                  CONTINUAR
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="font-mono text-xs"
                  onClick={() => marketMonitor.pause()}
                >
                  <Pause className="mr-1.5 h-3.5 w-3.5" />
                  PAUSAR
                </Button>
              )}
              <Button size="sm" variant="outline" className="font-mono text-xs" onClick={stop}>
                <Square className="mr-1.5 h-3.5 w-3.5" />
                ENCERRAR
              </Button>
            </>
          )}
        </div>
      </div>

      {ativo && (
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[11px]">
          <span className="text-muted-foreground">
            PRÓXIMO PRINT{" "}
            <span className="text-foreground">
              {state.stage === "PAUSADO"
                ? "PAUSADO"
                : state.secondsToNext !== null
                  ? `${state.secondsToNext}s`
                  : "—"}
            </span>
          </span>
          <span className="text-muted-foreground">
            ÚLTIMO PRINT <span className="text-foreground">{hora(state.lastCaptureAt)}</span>
          </span>
          <span className="text-muted-foreground">
            ANÁLISE{" "}
            <span className="text-foreground">
              {state.analysisBusy ? "ANALISANDO" : state.lastCaptureAt ? "CONCLUÍDA" : "—"}
            </span>
          </span>
          {state.lastLatencyMs !== null && (
            <span className="text-muted-foreground">
              LATÊNCIA{" "}
              <span className="text-foreground">{(state.lastLatencyMs / 1000).toFixed(1)}s</span>
            </span>
          )}
        </div>
      )}

      {state.lastError !== null && (
        <p className="font-mono text-[11px] text-bear">
          {state.lastError} — o monitoramento continua.
        </p>
      )}

      {state.needsReselect && (
        <p className="font-mono text-[11px] text-amber-500">
          O compartilhamento foi encerrado. Selecione a janela novamente para voltar a capturar.
        </p>
      )}
    </Card>
  );
}
