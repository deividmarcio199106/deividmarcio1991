/**
 * GATES DE DADO DO PIPELINE VISUAL — o portão que existia e estava desligado.
 *
 * `evaluateOperation` já tem o ramo "sem dado válido nada pode ser afirmado",
 * e ele nunca era alcançado: o hook passava `dataReady: true` e `dataGates: []`
 * como literais. Toda a proteção contra decidir sobre dado morto estava
 * escrita, testada e desconectada.
 *
 * A REGRA QUE ISTO IMPLEMENTA: nunca sinalizar sobre dado velho. Não é o mesmo
 * que "captura caiu" — a captura pode estar viva, entregando frames, e mesmo
 * assim o último candle FECHADO ter dez minutos. Um gráfico congelado por
 * janela minimizada entrega pixels idênticos indefinidamente, e a T4 seguiria
 * analisando um passado que não é mais o mercado.
 *
 * IMAGEM PARADA NÃO É DADO VELHO. Mercado sem negócio produz candles iguais, e
 * isso é informação legítima. O que estes gates medem é IDADE: quanto tempo faz
 * desde o último frame, desde a última mudança de pixel e desde o último candle
 * fechado entrar na série.
 */

import type { GateResult } from "./gates";

/**
 * Idade máxima do dado antes de bloquear entrada nova.
 *
 * 90 segundos num gráfico de 1 minuto: um candle e meio. Abaixo disso a virada
 * normal do minuto dispararia bloqueio a cada minuto; muito acima, a T4 decide
 * sobre um mercado que já mudou.
 */
export const MAX_MARKET_DATA_AGE_MS = 90_000;

/** Sem frame por este tempo, a captura parou de entregar — não é mercado parado. */
export const MAX_FRAME_AGE_MS = 10_000;

export interface DataGateInput {
  requested: boolean;
  /** Pixels utilizáveis chegando agora. */
  usable: boolean;
  now: number;
  lastFrameAt: number | null;
  /** Instante do último candle FECHADO aceito na série. */
  lastClosedCandleAt: number | null;
  closedCandles: number;
  minimumCandles: number;
}

export interface DataGateResult {
  gates: GateResult[];
  /** true quando a T4 pode afirmar qualquer coisa sobre o mercado. */
  dataReady: boolean;
  /** true quando o dado existe mas está velho — bloqueia ENTRADA NOVA. */
  stale: boolean;
}

function gate(id: GateResult["id"], status: GateResult["status"], detail: string): GateResult {
  return { id, label: id, status, detail };
}

/**
 * Avalia os gates de dado do caminho visual.
 *
 * Os ids reaproveitam os do vocabulário T4 porque `evaluateOperation` só olha
 * `status` e `detail` — e inventar um segundo vocabulário para dizer a mesma
 * coisa foi exatamente o problema que a fonte única encerrou.
 */
export function evaluateDataGates(input: DataGateInput): DataGateResult {
  const gates: GateResult[] = [];

  if (!input.requested) {
    return {
      gates: [gate("CONTEXT", "PENDING", "leitura não iniciada")],
      dataReady: false,
      stale: false,
    };
  }

  const frameAge = input.lastFrameAt === null ? Infinity : input.now - input.lastFrameAt;
  const frameOk = input.usable && frameAge <= MAX_FRAME_AGE_MS;
  gates.push(
    frameOk
      ? gate("CONTEXT", "PASS", `imagem de ${Math.round(frameAge / 1000)}s`)
      : gate(
          "CONTEXT",
          "FAIL",
          input.lastFrameAt === null
            ? "nenhum frame recebido"
            : `sem frame novo há ${Math.round(frameAge / 1000)}s — a captura parou de entregar`,
        ),
  );

  const historyOk = input.closedCandles >= input.minimumCandles;
  gates.push(
    historyOk
      ? gate("STRUCTURE", "PASS", `${input.closedCandles} candles fechados`)
      : gate(
          "STRUCTURE",
          "PENDING",
          `histórico ${input.closedCandles}/${input.minimumCandles} — coletando`,
        ),
  );

  /*
   * IDADE DO CANDLE, NÃO IDADE DO FRAME.
   *
   * São coisas diferentes e a distinção é o ponto deste gate. A captura pode
   * estar perfeita — 30 fps, pixels mudando — enquanto o último candle FECHADO
   * que entrou na série tem dez minutos, porque a série congelou por gap,
   * recusa de duplicação ou janela restaurada em outro ponto do gráfico.
   */
  const dataAge =
    input.lastClosedCandleAt === null ? Infinity : input.now - input.lastClosedCandleAt;
  const stale = historyOk && dataAge > MAX_MARKET_DATA_AGE_MS;
  gates.push(
    stale
      ? gate(
          "LOCATION",
          "FAIL",
          `último candle fechado há ${Math.round(dataAge / 1000)}s (limite ${Math.round(
            MAX_MARKET_DATA_AGE_MS / 1000,
          )}s) — DADO VELHO`,
        )
      : gate(
          "LOCATION",
          historyOk ? "PASS" : "PENDING",
          input.lastClosedCandleAt === null
            ? "nenhum candle fechado ainda"
            : `último candle fechado há ${Math.round(dataAge / 1000)}s`,
        ),
  );

  return { gates, dataReady: frameOk && historyOk && !stale, stale };
}

/** Frase única para o painel quando o dado bloqueia. */
export function dataBlockReason(result: DataGateResult): string | null {
  const failing = result.gates.find((g) => g.status === "FAIL");
  if (failing) return `${failing.id}: ${failing.detail}`;
  const pending = result.gates.find((g) => g.status === "PENDING");
  return pending ? `${pending.id}: ${pending.detail}` : null;
}
