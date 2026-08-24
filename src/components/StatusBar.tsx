import { useEffect, useState } from "react";

import { useAnalyzer } from "@/components/AnalyzerProvider";
import { STRATEGY_VERSION } from "@/lib/engines/strategy";
import { cn } from "@/lib/utils";

/**
 * Barra superior NEXUS.
 *
 * Mostra o estado REAL do único caminho de dado que existe: a captura direta do
 * Profit. Um item só acende verde depois de PROVA — pixels mudando, candles
 * entrando na série, escala confrontada com rótulos. "Processo iniciado" nunca
 * foi evidência, e os itens de bridge/RTD que ficavam aqui descreviam um
 * caminho que não roda mais.
 */
export function StatusBar() {
  const { diagnostics, sourceMode } = useAnalyzer();
  const [now, setNow] = useState<string>("");

  useEffect(() => {
    const tick = () =>
      setNow(
        new Date().toLocaleTimeString("pt-BR", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      );
    tick();
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, []);

  const d = diagnostics;
  const items: { label: string; value: string; tone: "ok" | "bad" | "idle" | "warn" }[] = [
    {
      label: "CAPTURA",
      value: d.captureLabel,
      tone: d.captureActive ? "ok" : "idle",
    },
    {
      // Gráfico parado com captura viva é estado VÁLIDO — amarelo, nunca
      // vermelho. Confundir imagem estática com captura morta foi o bug que
      // derrubou a T4 no Golden.
      label: "GRÁFICO",
      value: d.chartLabel,
      tone: d.pixelsChanging ? "ok" : d.captureActive ? "warn" : "idle",
    },
    {
      label: "CANDLES",
      value: String(d.closedCandlesAccepted),
      tone: d.closedCandlesAccepted > 0 ? "ok" : "idle",
    },
    {
      /*
       * CALIBRANDO só com captura VIVA — senão é AGUARDANDO.
       *
       * Sem janela selecionada não existe frame, e portanto não existe
       * calibração em curso: dizer "CALIBRANDO" ali afirma um trabalho que
       * ninguém está fazendo, e o operador espera por um resultado que nunca
       * vem. Estado impossível é pior que estado feio.
       */
      label: "ESCALA",
      value: !d.captureActive
        ? "AGUARDANDO"
        : d.priceScaleReady
          ? "OK"
          : (d.scaleReject ?? "CALIBRANDO"),
      tone: !d.captureActive
        ? "idle"
        : d.priceScaleReady
          ? "ok"
          : d.scaleReject === null
            ? "idle"
            : "warn",
    },
    {
      label: "T4",
      value: d.t4Flow,
      tone: d.t4Engine === "PAUSADO_DADO" ? "bad" : d.t4Engine === "ANALISANDO" ? "ok" : "idle",
    },
  ];

  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <span className="nexus-eyebrow shrink-0 text-primary/90">NEXUS TRADING INTELLIGENCE</span>
      <span
        className={cn(
          "nexus-eyebrow hidden shrink-0 rounded px-1.5 py-0.5 md:inline",
          sourceMode === "REPLAY"
            ? "bg-amber-500/15 text-amber-500"
            : "bg-muted text-muted-foreground",
        )}
      >
        {sourceMode}
      </span>
      {/*
       * O QUE ESTA BARRA MEDE — dito antes dos números.
       *
       * Ela é global (vive no __root) e descreve o MOTOR AO VIVO: captura
       * contínua, candles reconstruídos e a T4 rodando sobre eles. Em
       * /analisar-print ela aparecia ao lado de uma análise de print
       * funcionando, dizendo "CANDLES 0 · T4 WAITING_DATA" — e o operador lia
       * o sistema afirmando "sem dados" e "T4 em formação" ao mesmo tempo.
       * Os dois estavam certos: são PIPELINES DIFERENTES. O rótulo é o que
       * faltava para que isso deixasse de parecer contradição.
       */}
      <div className="hidden min-w-0 items-center gap-3 lg:flex">
        <span className="nexus-eyebrow shrink-0 whitespace-nowrap text-muted-foreground">
          MOTOR AO VIVO
        </span>
        {items.map((item) => (
          <span key={item.label} className="nexus-eyebrow shrink-0 whitespace-nowrap">
            {item.label}{" "}
            <span
              className={cn(
                "font-mono",
                item.tone === "ok" && "text-bull",
                item.tone === "bad" && "text-bear",
                item.tone === "warn" && "text-amber-500",
                item.tone === "idle" && "text-muted-foreground",
              )}
            >
              {item.value}
            </span>
          </span>
        ))}
      </div>
      <span className="nexus-eyebrow hidden shrink-0 sm:inline">{STRATEGY_VERSION}</span>
      <span className="nexus-value ml-auto shrink-0 text-xs text-muted-foreground">{now}</span>
    </div>
  );
}
