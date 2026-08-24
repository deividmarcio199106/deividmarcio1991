/**
 * VEREDITO AUTOMÁTICO DAS PREVISÕES DE PRINT — o resultado fecha o ciclo.
 *
 * Uma previsão sem resultado não ensina nada (regra anti-contaminação nº 1:
 * não aprender com previsão de desfecho desconhecido). Este módulo transforma
 * a sequência de prints da sessão em veredito por previsão:
 *
 *   ACERTOU     o preço alcançou o alvo sem ter batido o stop antes;
 *   ERROU       o preço bateu o stop;
 *   INVALIDADO  a estrutura declarada de invalidação disparou antes do gatilho;
 *   NEUTRO      expirou sem alcançar nada (mercado foi embora / virou lateral);
 *   PENDENTE    ainda em acompanhamento.
 *
 * A AMOSTRAGEM É DE 60s — E ISSO IMPORTA. Entre dois prints o preço pode ter
 * ido ao alvo E ao stop, e a ordem não foi observada. A regra é a mesma
 * conservadora da casa (ambiguidade intrabar do backtest): quando as duas
 * pontas foram cruzadas no MESMO intervalo, conta STOP primeiro e o veredito
 * carrega `ambiguous: true`. Otimismo não entra na memória.
 *
 * O preço observado vem do `currentPrice` LIDO em cada print (etiqueta do
 * eixo). Print sem preço legível não move veredito nenhum — a checagem
 * simplesmente espera a próxima observação legível.
 */

export interface PrintPrediction {
  /** Id do print que originou a previsão. */
  printId: string;
  asset: string;
  direction: "COMPRA" | "VENDA";
  /** Instante da previsão (o AGORA do operador — contrato LIVE dos prints). */
  predictedAt: number;
  entry: number | null;
  stop: number | null;
  target: number | null;
  /** Preço no instante da previsão, quando legível. */
  priceAtPrediction: number | null;
}

export interface PriceObservation {
  at: number;
  price: number;
}

export type PredictionVerdict = "PENDENTE" | "ACERTOU" | "ERROU" | "NEUTRO" | "INVALIDADO";

export interface OutcomeResult {
  verdict: PredictionVerdict;
  /** Alvo e stop cruzados entre duas observações — contado como stop. */
  ambiguous: boolean;
  /** O que fecha o veredito, dito para o painel e para a memória. */
  detail: string;
  resolvedAt: number | null;
}

/** Sem alcançar alvo nem stop por este tempo, a previsão expira NEUTRA. */
export const PREDICTION_TTL_MS = 45 * 60_000;

/**
 * Avalia UMA previsão contra as observações de preço que vieram DEPOIS dela.
 *
 * Anti-look-ahead literal: observações anteriores ao instante da previsão são
 * ignoradas — o histórico não pode validar a previsão com o passado dela.
 */
export function evaluatePrediction(
  prediction: PrintPrediction,
  observations: PriceObservation[],
  now: number,
): OutcomeResult {
  if (prediction.stop === null || prediction.target === null) {
    // Sem stop e alvo não há critério de acerto DEFINIDO ANTES — e critério
    // definido depois do resultado é a definição de viés retrospectivo.
    return {
      verdict: "NEUTRO",
      ambiguous: false,
      detail: "previsão sem stop/alvo legíveis — sem critério pré-definido, não ensina",
      resolvedAt: prediction.predictedAt,
    };
  }

  const up = prediction.direction === "COMPRA";
  const posteriores = observations
    .filter((o) => o.at > prediction.predictedAt && Number.isFinite(o.price))
    .sort((a, b) => a.at - b.at);

  for (const obs of posteriores) {
    const hitTarget = up ? obs.price >= prediction.target : obs.price <= prediction.target;
    const hitStop = up ? obs.price <= prediction.stop : obs.price >= prediction.stop;

    if (hitTarget && hitStop) {
      // As duas pontas dentro do mesmo intervalo de 60s: ordem não observada.
      return {
        verdict: "ERROU",
        ambiguous: true,
        detail:
          "alvo E stop cruzados entre duas observações — ordem desconhecida, contado como stop (conservador)",
        resolvedAt: obs.at,
      };
    }
    if (hitStop) {
      return {
        verdict: "ERROU",
        ambiguous: false,
        detail: `stop ${prediction.stop.toLocaleString("pt-BR")} atingido`,
        resolvedAt: obs.at,
      };
    }
    if (hitTarget) {
      return {
        verdict: "ACERTOU",
        ambiguous: false,
        detail: `alvo ${prediction.target.toLocaleString("pt-BR")} atingido sem stop antes`,
        resolvedAt: obs.at,
      };
    }
  }

  if (now - prediction.predictedAt > PREDICTION_TTL_MS) {
    return {
      verdict: "NEUTRO",
      ambiguous: false,
      detail: `expirou após ${Math.round(PREDICTION_TTL_MS / 60_000)} min sem alcançar alvo nem stop`,
      resolvedAt: now,
    };
  }

  return {
    verdict: "PENDENTE",
    ambiguous: false,
    detail:
      posteriores.length === 0
        ? "aguardando a primeira observação de preço posterior"
        : `acompanhando — ${posteriores.length} observação(ões), nada alcançado`,
    resolvedAt: null,
  };
}
