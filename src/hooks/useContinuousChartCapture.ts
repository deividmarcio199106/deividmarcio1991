import { useEffect, useRef, useSyncExternalStore } from "react";

import type { FrameRead } from "@/lib/capture/frameProcessor";
import {
  screenCaptureManager,
  type ChartCaptureStatus,
  type CaptureManagerState,
} from "@/lib/capture/screenCaptureManager";

export type { ChartCaptureStatus };

const SSR_STATE: CaptureManagerState = {
  status: "sem-fonte",
  fps: 0,
  resolution: null,
  lastFrameAt: null,
  error: null,
  sourceLabel: null,
};

/**
 * CONTINUOUS CHART CAPTURE — visão React do ScreenCaptureManager GLOBAL.
 *
 * A captura (MediaStream, <video> de processamento e loop de frames) vive no
 * singleton `screenCaptureManager`, fora de qualquer página. Este hook apenas
 * inscreve o consumidor nos frames e no estado: montar/desmontar uma rota não
 * inicia nem interrompe a captura.
 */
export function useContinuousChartCapture(onFrame: (read: FrameRead) => void, enabled = true) {
  const onFrameRef = useRef(onFrame);
  useEffect(() => {
    onFrameRef.current = onFrame;
  }, [onFrame]);

  useEffect(() => {
    // Com a fonte em RTD não existe assinatura de frame. Guardar o consumidor
    // por dentro não bastaria: enquanto houver UM subscriber, o manager segue
    // processando frame a cada 500ms e publicando `status: "capturando"` — que
    // é exatamente o CAPTURE_ACTIVE=SIM que o operador via no modo RTD.
    if (!enabled) return;
    return screenCaptureManager.subscribeFrames((read) => onFrameRef.current(read));
  }, [enabled]);

  const live = useSyncExternalStore(
    (listener) => screenCaptureManager.subscribeState(listener),
    () => screenCaptureManager.getState(),
    () => SSR_STATE,
  );
  // Desligado, o estado publicado é "sem-fonte": nenhum painel deve conseguir
  // afirmar que há captura acontecendo quando a fonte oficial é o RTD.
  const state = enabled ? live : SSR_STATE;

  return {
    videoRef: screenCaptureManager.videoRef,
    status: state.status,
    fps: state.fps,
    resolution: state.resolution,
    lastFrameAt: state.lastFrameAt,
    error: state.error,
    sourceLabel: state.sourceLabel,
    selectSource: () => screenCaptureManager.selectSource(),
    confirmPreview: () => screenCaptureManager.confirmPreview(),
    switchSource: () => screenCaptureManager.switchSource(),
    pause: () => screenCaptureManager.pause(),
    resume: () => screenCaptureManager.resume(),
    stop: (reason?: string) => screenCaptureManager.stop(reason),
  };
}

export type ContinuousChartCapture = ReturnType<typeof useContinuousChartCapture>;
