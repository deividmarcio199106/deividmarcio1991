/**
 * PERFIS DE GESTÃO — uma é produção, as outras são laboratório.
 *
 * O CONFLITO QUE ISTO ENCERRA: o projeto declarava duas gestões diferentes para
 * a mesma operação e usava as duas ao mesmo tempo, em lugares distintos.
 *
 *   Configurações e o texto da técnica:  3 contratos — 3R, 5R e runner
 *   Biblioteca e o cálculo de resultado: 60% na parcial, 40% no alvo final
 *
 * Não era só divergência de rótulo. `liveOutcome` e `riskEngine` calculavam o
 * R-múltiplo com a fração 60/40 enquanto a operação era conduzida com três
 * contratos. O resultado gravado descrevia uma gestão que não foi a executada —
 * e é sobre esse resultado que a evidência histórica decide se um setup pode
 * operar. Um erro assim não aparece como bug: aparece como estatística.
 *
 * PRODUÇÃO é a de três contratos, por decisão explícita do operador. A 60/40
 * continua existindo como EXPERIMENTAL, porque ela ainda descreve corretamente
 * um plano de dois alvos — mas não pode mais ser confundida com a T4.
 *
 * Toda operação carrega `managementVersion`. Sem isso, dois resultados gerados
 * por gestões diferentes se somam na mesma média e ninguém percebe.
 */

import {
  FIRST_EXIT_FRACTION,
  PARTIAL_EXIT_FRACTION,
  PROFIT_LOCK_R,
  PROTECT_AFTER_R,
  RUNNER_EXIT_FRACTION,
  RUNNER_TRAIL_START_R,
  SECOND_EXIT_FRACTION,
} from "@/lib/engines/strategy";
import { ema } from "@/lib/engines/marketFeatures";
import type { Candle } from "@/lib/engines/types";
import { T4_MANAGEMENT_VERSION } from "./version";

export type ManagementStatus = "PRODUCTION" | "EXPERIMENTAL";

export interface ManagementProfile {
  id: string;
  version: string;
  status: ManagementStatus;
  label: string;
  /** Quantas pernas a operação tem. */
  legs: number;
  /** Fração realizada em cada perna, na ordem. Soma 1. */
  fractions: number[];
  /** Alvo de cada perna em múltiplos de R. `null` = runner estrutural. */
  targetsR: Array<number | null>;
  protectAfterR: number;
  profitLockR: number;
  runnerTrailStartR: number;
  description: string;
}

/**
 * A gestão que o ao vivo e o backtest usam.
 *
 * Três contratos, um por perna: 3R, 5R e runner estrutural. O runner não tem
 * alvo numérico de propósito — ele sai pela estrutura, e fixar um número aqui
 * transformaria a única perna aberta a favor da tendência numa saída arbitrária.
 */
export const PRODUCTION_MANAGEMENT: ManagementProfile = {
  id: "T4-3C",
  version: T4_MANAGEMENT_VERSION,
  status: "PRODUCTION",
  label: "3 contratos — 3R, 5R, runner",
  legs: 3,
  fractions: [FIRST_EXIT_FRACTION, SECOND_EXIT_FRACTION, RUNNER_EXIT_FRACTION],
  targetsR: [3, 5, null],
  protectAfterR: PROTECT_AFTER_R,
  profitLockR: PROFIT_LOCK_R,
  runnerTrailStartR: RUNNER_TRAIL_START_R,
  description: "1º contrato em 3R, 2º em 5R, 3º acompanha a estrutura. Stop sempre estrutural.",
};

/**
 * Plano de dois alvos. NÃO é a T4.
 *
 * Fica como EXPERIMENTAL porque descreve corretamente uma gestão de duas pernas
 * — só não é a que está em produção. Enquanto ela aparecia na Biblioteca sem
 * rótulo, o operador tinha duas respostas para "como a T4 gerencia?".
 */
export const EXPERIMENTAL_60_40: ManagementProfile = {
  id: "LEGADO-2A",
  version: "mgmt-2A-60-40-legado",
  status: "EXPERIMENTAL",
  label: "2 alvos — 60% na parcial, 40% no final",
  legs: 2,
  fractions: [PARTIAL_EXIT_FRACTION, 1 - PARTIAL_EXIT_FRACTION],
  targetsR: [3, 5],
  protectAfterR: PROTECT_AFTER_R,
  profitLockR: PROFIT_LOCK_R,
  runnerTrailStartR: RUNNER_TRAIL_START_R,
  description:
    "Modo legado de duas pernas. Mantido para comparação histórica; não conduz operação.",
};

export const MANAGEMENT_PROFILES: ManagementProfile[] = [PRODUCTION_MANAGEMENT, EXPERIMENTAL_60_40];

/** A gestão em vigor. Backtest e ao vivo chamam ESTA função, não constantes soltas. */
export function activeManagement(): ManagementProfile {
  return PRODUCTION_MANAGEMENT;
}

/**
 * R-múltiplo consolidado da operação a partir do R de cada perna.
 *
 * A perna que não foi atingida entra com o R que de fato aconteceu — quem
 * informa isso é o rastreador, não este módulo. O que muda entre perfis é só o
 * PESO de cada perna, e é exatamente esse peso que estava divergindo do que era
 * executado.
 */
export function blendedR(profile: ManagementProfile, legsR: number[]): number | null {
  if (legsR.length === 0) return null;
  let total = 0;
  let peso = 0;
  for (let i = 0; i < profile.fractions.length && i < legsR.length; i++) {
    const r = legsR[i];
    if (r === undefined || !Number.isFinite(r)) continue;
    total += r * profile.fractions[i]!;
    peso += profile.fractions[i]!;
  }
  if (peso === 0) return null;
  // Normaliza pelo peso efetivamente usado: uma operação encerrada antes da
  // última perna não pode ser diluída por uma fração que nunca existiu.
  return total / peso;
}

/* ------------------------------------------------------------------------ *
 * CONDUÇÃO DO RUNNER — barra fechada contra a MME 9
 * ------------------------------------------------------------------------ */

/**
 * O RUNNER DEIXA DE SER SUBJETIVO.
 *
 * `targetsR` marca o 3º contrato como `null` — "sai pela estrutura". Isso é
 * correto como intenção e inútil como regra: "estrutura" não é verificável no
 * replay, e uma saída que não é verificável não pode ser medida. Na prática o
 * runner saía por decisão humana, e o R gravado descrevia uma condução que
 * ninguém consegue repetir.
 *
 * A REGRA AGORA É UMA SÓ, e é de BARRA FECHADA:
 *
 *   COMPRA  o runner segue enquanto o candle de 1 min FECHAR acima da MME 9.
 *           O primeiro fechamento ABAIXO encerra a mercado.
 *   VENDA   o espelho: o primeiro fechamento ACIMA da MME 9 encerra.
 *
 * BARRA FECHADA é a parte que importa. Testar o preço no meio do candle faria
 * o runner sair num pavio e voltar, e transformaria a mesma tendência em dois
 * resultados diferentes dependendo do instante em que a captura ocorreu.
 * Empate (fechamento exatamente na média) NÃO encerra: "abaixo" é abaixo.
 */
export const RUNNER_MME_PERIODO = 9;

export type RunnerVerdict = "RUNNER_SEGUE" | "RUNNER_ENCERRA" | "RUNNER_SEM_DADO";

export interface RunnerTrailInput {
  side: "COMPRA" | "VENDA";
  /**
   * Candles de 1 min FECHADOS até T, em ordem. O último é o que acabou de
   * fechar — é ele que decide. Candle em formação nunca entra aqui.
   */
  closedCandles: Candle[];
}

export interface RunnerTrailRead {
  verdict: RunnerVerdict;
  /** MME 9 dos fechamentos da janela. Null sem candles suficientes. */
  mme9: number | null;
  /** Fechamento do último candle avaliado. */
  close: number | null;
  detail: string;
}

/**
 * O runner continua ou encerra, dado o candle que acabou de fechar.
 *
 * Exige ao menos `RUNNER_MME_PERIODO` candles fechados: uma MME de 9 calculada
 * sobre 3 candles é um número, não uma média — e sairia do runner cedo demais.
 */
export function runnerTrailingMme9(input: RunnerTrailInput): RunnerTrailRead {
  const { side, closedCandles } = input;
  if (closedCandles.length < RUNNER_MME_PERIODO) {
    return {
      verdict: "RUNNER_SEM_DADO",
      mme9: null,
      close: closedCandles.length > 0 ? closedCandles[closedCandles.length - 1]!.c : null,
      detail:
        `MME ${RUNNER_MME_PERIODO} exige ${RUNNER_MME_PERIODO} candles fechados; ` +
        `há ${closedCandles.length}. Runner mantido sem veredito.`,
    };
  }

  const mme9 = ema(
    closedCandles.map((c) => c.c),
    RUNNER_MME_PERIODO,
  );
  const close = closedCandles[closedCandles.length - 1]!.c;
  const rompeu = side === "COMPRA" ? close < mme9 : close > mme9;

  if (rompeu) {
    return {
      verdict: "RUNNER_ENCERRA",
      mme9,
      close,
      detail:
        `Fechamento ${close.toFixed(0)} ${side === "COMPRA" ? "abaixo" : "acima"} da MME 9 ` +
        `(${mme9.toFixed(0)}) — runner encerrado a mercado.`,
    };
  }

  return {
    verdict: "RUNNER_SEGUE",
    mme9,
    close,
    detail:
      `Fechamento ${close.toFixed(0)} ${side === "COMPRA" ? "acima" : "abaixo"} da MME 9 ` +
      `(${mme9.toFixed(0)}) — runner segue.`,
  };
}

/* ------------------------------------------------------------------------ *
 * BREAK-EVEN PROTEGIDO APÓS A PARCIAL
 * ------------------------------------------------------------------------ */

/**
 * Pontos além da entrada para onde o stop vai depois da parcial.
 *
 * NÃO é o preço de entrada. Stop exatamente na entrada devolve a operação no
 * zero a zero mas ainda paga corretagem, emolumentos e derrapagem das duas
 * pernas — "empate" no gráfico é prejuízo no extrato. Os 10 pontos existem para
 * cobrir isso.
 */
export const BREAK_EVEN_OFFSET_POINTS = 10;

/**
 * Stop do 2º contrato e do runner depois que a parcial de 3R é atingida.
 *
 * Sempre A FAVOR da operação: numa compra sobe para entrada + 10; numa venda
 * desce para entrada − 10. Escrever "entrada + 10" literalmente numa venda
 * moveria o stop para CONTRA a posição, e é esse tipo de espelhamento esquecido
 * que transforma proteção em risco extra.
 */
export function stopAposParcial(
  side: "COMPRA" | "VENDA",
  entry: number,
  offsetPoints: number = BREAK_EVEN_OFFSET_POINTS,
): number {
  return side === "COMPRA" ? entry + offsetPoints : entry - offsetPoints;
}

/**
 * O stop informado já está no break-even protegido (ou melhor)?
 *
 * Usado pelo relógio institucional: a trava das 09:55 manda proteger, e sem esta
 * verificação "proteger" seria mover o stop toda vez que o gate rodasse, podendo
 * PIORAR um stop que já estava mais adiantado no lucro.
 */
export function stopJaProtegido(
  side: "COMPRA" | "VENDA",
  entry: number,
  stopAtual: number,
  offsetPoints: number = BREAK_EVEN_OFFSET_POINTS,
): boolean {
  const alvo = stopAposParcial(side, entry, offsetPoints);
  return side === "COMPRA" ? stopAtual >= alvo : stopAtual <= alvo;
}
