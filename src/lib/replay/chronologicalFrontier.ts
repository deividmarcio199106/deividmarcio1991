import type { Candle } from "@/lib/engines/types";

/**
 * Um frame do Profit pode revelar dezenas/centenas de candles de uma vez.
 * Para backtest isso NÃO significa que todos estavam disponíveis em T.
 *
 * Esta função transforma o lote novo em uma sequência de fronteiras
 * cronológicas: cada passo recebe somente o histórico até o candle atual.
 * Assim, mesmo quando o usuário arrasta o gráfico rapidamente, a decisão de
 * 10:30 nunca enxerga 10:31, 10:32 etc. que já estejam visíveis na mesma tela.
 */
export interface ChronologicalFrontier {
  /** Índice absoluto do candle na sequência costurada do segmento. */
  index: number;
  /** Candle que acaba de se tornar o tempo T deste passo. */
  candle: Candle;
  /** Janela histórica terminando EXATAMENTE em T; nunca contém candle futuro. */
  history: Candle[];
}

export function chronologicalFrontiers(
  sequence: readonly Candle[],
  previouslyProcessed: number,
  analysisWindow = 160,
): ChronologicalFrontier[] {
  if (sequence.length === 0) return [];
  const start = Math.max(0, Math.min(sequence.length, Math.trunc(previouslyProcessed)));
  const window = Math.max(1, Math.trunc(analysisWindow));
  const out: ChronologicalFrontier[] = [];

  for (let index = start; index < sequence.length; index++) {
    const from = Math.max(0, index - window + 1);
    out.push({
      index,
      candle: sequence[index]!,
      history: sequence.slice(from, index + 1),
    });
  }
  return out;
}
