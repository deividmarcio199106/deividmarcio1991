import { useEffect, useMemo, useState, type ReactNode } from "react";

import { AnalyzerContext } from "@/components/analyzerContext";
import { useContinuousBacktest } from "@/hooks/useContinuousBacktest";
import { useProfitVision } from "@/hooks/useProfitVision";
import { installGlobalErrorCapture } from "@/lib/errors/errorReporter";
import { buildVisionDiagnostics } from "@/lib/vision/visionDiagnostics";
import { readSourceMode, writeSourceMode, type SourceMode } from "@/lib/vision/sourceMode";

/**
 * ANALYZER PROVIDER — o runtime do analisador vive AQUI, no layout raiz.
 *
 * As sessões são criadas uma única vez no shell da aplicação e apenas
 * CONSUMIDAS pelas rotas: navegar entre páginas NÃO derruba a captura, NÃO zera
 * candles/contexto e NÃO reinicia o T4.
 *
 * FONTE ÚNICA
 * Existe UM caminho de dado: a captura direta do Profit por `getDisplayMedia`.
 * O caminho RTD/bridge foi REMOVIDO do runtime — não é escondido por flag, não
 * é instanciado "por precaução", não existe. Enquanto ele coexistia, dois
 * motores mediam o mesmo gráfico e a UI lia o errado: era daí que vinham
 * "esperar 14 minutos" com 14 candles na tela e CANDLES_PARSED=0 com candles
 * visíveis.
 *
 * `useProfitVision` mora aqui, e não na rota, por um motivo concreto: o hook
 * guarda tracker, série, decisão e linha do tempo do setup em refs. Montado na
 * rota, sair de /operacao-ao-vivo destruiria tudo isso e a T4 recomeçaria do
 * zero a cada navegação — com a captura continuando viva por trás, porque o
 * `screenCaptureManager` é singleton.
 *
 * `visionDiagnostics` é calculado UMA vez, aqui. Operação ao Vivo e /diagnostico
 * leem o MESMO objeto: dois painéis não podem discordar sobre o mesmo instante.
 *
 * O contexto e o hook `useAnalyzer` moram em `analyzerContext.ts`: este
 * arquivo exporta só o componente, como o Fast Refresh exige.
 */

export function AnalyzerProvider({ children }: { children: ReactNode }) {
  const [liveAsset, setLiveAsset] = useState("WINFUT");
  const [backtestAsset, setBacktestAsset] = useState("WINFUT");
  // O SSR não tem localStorage: o padrão entra na hidratação, não na render.
  const [sourceMode, setSourceModeState] = useState<SourceMode>("LIVE");

  const vision = useProfitVision(liveAsset, sourceMode);
  const backtest = useContinuousBacktest(backtestAsset);

  useEffect(() => installGlobalErrorCapture(), []);

  useEffect(() => {
    setSourceModeState(readSourceMode());
  }, []);

  const setSourceMode = (mode: SourceMode) => {
    setSourceModeState(mode);
    writeSourceMode(mode);
  };

  // FONTE ÚNICA DE VERDADE: tudo que qualquer painel mostra sai daqui.
  const diagnostics = useMemo(
    () =>
      buildVisionDiagnostics({
        requested: vision.requested,
        liveness: vision.liveness,
        tracker: vision.tracker,
        visual: vision.visual,
        operation: vision.operation,
        analysis: vision.analysis,
        scale: vision.scale,
        timeline: vision.timeline,
        sourceMode,
        gpuReachable: vision.gpuReachable,
      }),
    [
      vision.requested,
      vision.liveness,
      vision.tracker,
      vision.visual,
      vision.operation,
      vision.analysis,
      vision.scale,
      vision.timeline,
      vision.gpuReachable,
      sourceMode,
    ],
  );

  return (
    <AnalyzerContext.Provider
      value={{
        liveAsset,
        setLiveAsset,
        backtestAsset,
        setBacktestAsset,
        backtest,
        sourceMode,
        setSourceMode,
        vision,
        diagnostics,
      }}
    >
      {children}
    </AnalyzerContext.Provider>
  );
}
