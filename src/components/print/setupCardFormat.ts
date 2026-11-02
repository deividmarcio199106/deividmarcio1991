import type { TrackedSetup } from "@/lib/print/setupTracker";
import { NAO_IDENTIFICADO } from "@/lib/vision/printAnalysis";

/**
 * Formatação do card SETUP T4 — números falam pt-BR e ausência é DITA.
 *
 * Funções puras, fora de `SetupCard.tsx` para que o arquivo do componente
 * exporte só componentes (Fast Refresh) e para que os testes as exercitem sem
 * montar a UI. As regras de honestidade são as do card: R:R só com os TRÊS
 * níveis legíveis, e entrada ausente é NÃO IDENTIFICADO, nunca zero.
 */

export const ptBR = (n: number, opts?: Intl.NumberFormatOptions): string =>
  n.toLocaleString("pt-BR", opts);

/** R:R do setup — null sem os TRÊS níveis legíveis ou com risco zero. */
export function rrDoSetup(setup: TrackedSetup | null): number | null {
  if (setup === null || setup.entryLevel === null || setup.stop === null || setup.target === null) {
    return null;
  }
  const risco = Math.abs(setup.entryLevel - setup.stop);
  if (risco <= 0) return null;
  return Math.abs(setup.target - setup.entryLevel) / risco;
}

/** Texto da entrada roxa: zona quando existe, senão nível, senão ausência dita. */
export function textoEntrada(setup: TrackedSetup | null): string {
  if (setup === null) return NAO_IDENTIFICADO;
  if (setup.entryZone !== null) {
    return `${ptBR(setup.entryZone.min)} – ${ptBR(setup.entryZone.max)}`;
  }
  if (setup.entryLevel !== null) return ptBR(setup.entryLevel);
  return NAO_IDENTIFICADO;
}
