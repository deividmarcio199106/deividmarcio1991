/** ScreenCaptureService — captura da tela/janela do Profit via getDisplayMedia. */
export interface CaptureHandle {
  stream: MediaStream;
  stop: () => void;
}

/**
 * true quando a página está num contexto seguro (https:// ou localhost).
 *
 * getDisplayMedia só existe em contexto seguro. Servir a aplicação em
 * http://dominio (sem TLS) impede a seleção da janela do gráfico.
 */
export function isSecureContextAvailable(): boolean {
  if (typeof window === "undefined") return false;
  return window.isSecureContext === true;
}

export async function startScreenCapture(): Promise<CaptureHandle> {
  if (typeof navigator === "undefined") {
    throw new Error("Captura de tela não suportada neste navegador.");
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    // Distingue as duas causas: sem TLS o recurso some mesmo em navegador compatível.
    throw new Error(
      isSecureContextAvailable()
        ? "Captura de tela não suportada neste navegador."
        : "Captura de tela indisponível: a página precisa ser servida por HTTPS (ou localhost). Configure o certificado no servidor e acesse pelo endereço https://.",
    );
  }
  // O usuário autoriza manualmente o compartilhamento no seletor nativo.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: "window", frameRate: { ideal: 15, max: 30 } },
    audio: false,
  });
  return {
    stream,
    stop: () => stream.getTracks().forEach((t) => t.stop()),
  };
}
