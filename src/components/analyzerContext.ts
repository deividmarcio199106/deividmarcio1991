import { createContext, useContext } from "react";

import type { useContinuousBacktest } from "@/hooks/useContinuousBacktest";
import type { ProfitVision } from "@/hooks/useProfitVision";
import type { VisionDiagnostics } from "@/lib/vision/visionDiagnostics";
import type { SourceMode } from "@/lib/vision/sourceMode";

/**
 * CONTEXTO DO ANALISADOR — o contrato entre o `AnalyzerProvider` (layout raiz)
 * e as rotas que o consomem via `useAnalyzer()`.
 *
 * Mora fora de `AnalyzerProvider.tsx` porque o Fast Refresh só atualiza no
 * lugar um arquivo que exporta APENAS componentes (regra
 * react-refresh/only-export-components). Em produção nada muda: é o mesmo
 * `createContext`, criado uma única vez quando o módulo carrega, e o mesmo
 * erro quando alguém consome fora do provider.
 */

export interface AnalyzerContextValue {
  liveAsset: string;
  setLiveAsset: (asset: string) => void;
  backtestAsset: string;
  setBacktestAsset: (asset: string) => void;
  backtest: ReturnType<typeof useContinuousBacktest>;
  /** LIVE ou REPLAY — decide se o relógio do sistema pode carimbar mercado. */
  sourceMode: SourceMode;
  setSourceMode: (mode: SourceMode) => void;
  vision: ProfitVision;
  diagnostics: VisionDiagnostics;
}

export const AnalyzerContext = createContext<AnalyzerContextValue | null>(null);

export function useAnalyzer(): AnalyzerContextValue {
  const context = useContext(AnalyzerContext);
  if (!context) throw new Error("useAnalyzer precisa do AnalyzerProvider no layout raiz.");
  return context;
}
