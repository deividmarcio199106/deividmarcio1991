/**
 * T4.1-REGIME_ADAPTIVE — a candidata, congelada.
 *
 * A T4.0.0 continua sendo a técnica de PRODUÇÃO. Este arquivo descreve uma
 * candidata que ainda não operou nada: playbook por regime, runner conduzido
 * pela MME 9, relógio institucional e a gestão de três contratos com parcial em
 * 3R.
 *
 * POR QUE UM SNAPSHOT IMUTÁVEL, e não "ler as constantes na hora": a candidata
 * será medida contra dados históricos, e o resultado dessa medição só significa
 * alguma coisa se as regras que produziram os números forem as mesmas depois. Se
 * `rules_json` apontasse para constantes vivas, ajustar o piso de lateralidade
 * amanhã reescreveria retroativamente a regra sob a qual a validação de hoje
 * foi feita — e ninguém teria como saber.
 *
 * `status: VALIDATION` é uma afirmação sobre o ESTÁGIO, não sobre mérito: existe
 * hipótese formulada e ela está em medição. Promover exige `VALIDATED`, que
 * `promoteTechniqueCandidate` só aceita depois da evidência.
 */

import type { TechniqueCandidateRecord } from "@/lib/storage";
import { T4_PRODUCTION_VERSION } from "./version";
import {
  EXTREMO_BANDA,
  GAP_COOLDOWN_CANDLES,
  GAP_LIMITE_PONTOS,
  LATERALIDADE_MIN_CANDLES,
  MAX_PERNA_AUTORIZADA,
} from "./regimeClassifier";
import { BREAK_EVEN_OFFSET_POINTS, RUNNER_MME_PERIODO } from "./management";
import {
  ABERTURA_MIN,
  CHOQUE_FIM_MIN,
  CHOQUE_INICIO_MIN,
  CORTE_NOVAS_MIN,
  ENCERRAMENTO_LIMITE_MIN,
  FIM_ABERTURA_MIN,
  NY_FIM_MIN,
  NY_INICIO_MIN,
} from "./marketClockGuard";
import { B3_TAXAS_POR_CONTRATO_POR_PERNA } from "./assets";

export const T41_CANDIDATE_ID = "T4.1-REGIME_ADAPTIVE";
export const T41_CANDIDATE_VERSION = "T4.1.0-regime-adaptive";

const hhmm = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/**
 * As regras, exatamente como valiam no momento em que a candidata foi criada.
 *
 * Os valores vêm das constantes dos módulos para que o snapshot NASÇA correto —
 * mas ele é serializado uma vez e gravado. Depois de gravado, é o `rules_json`
 * que manda, não este arquivo.
 */
export function t41Rules(): Record<string, unknown> {
  return {
    tecnica: "T4.1 — Playbook adaptativo por regime",
    baseVersion: T4_PRODUCTION_VERSION,
    regimes: {
      REGIME_A_TENDENCIA: {
        criterio: "topos e fundos ascendentes/descendentes em 3 blocos consecutivos",
        autoriza: ["T4.1_PULLBACK_LIMPO"],
        pernasAutorizadas: `1..${MAX_PERNA_AUTORIZADA}`,
        alvosR: [3, 5, "runner"],
        runner: "MME 9, barra fechada",
      },
      REGIME_B_LATERALIDADE: {
        criterio: `preço contido por >= ${LATERALIDADE_MIN_CANDLES} candles, sem progresso líquido`,
        autoriza: ["T4.3_EXTREMO_COM_SWEEP"],
        vetoMeioDoGrafico: `entrada só nos ${EXTREMO_BANDA * 100}% do extremo de cada lado`,
        alvosR: [1.5, 2.5],
        runner: "PROIBIDO",
      },
      REGIME_C_GAP_VOLATILIDADE: {
        criterio: `gap de abertura > ${GAP_LIMITE_PONTOS} pontos`,
        cooldownCandles: GAP_COOLDOWN_CANDLES,
        autoriza: [],
      },
    },
    gestao: {
      contratos: 3,
      parcialR: 3,
      alvo2R: 5,
      runner: {
        conducao: `MME ${RUNNER_MME_PERIODO} em barra fechada de 1 min`,
        encerraCompra: "primeiro fechamento ABAIXO da MME 9",
        encerraVenda: "primeiro fechamento ACIMA da MME 9",
      },
      breakEvenAposParcial: {
        gatilho: "parcial de 3R atingida",
        stop: `entrada +${BREAK_EVEN_OFFSET_POINTS} pontos a favor`,
        alcanca: ["alvo2", "runner"],
      },
    },
    relogioB3: {
      [`${hhmm(ABERTURA_MIN)}-${hhmm(FIM_ABERTURA_MIN)}`]: "bloqueio de novas entradas",
      [`${hhmm(CHOQUE_INICIO_MIN)}-${hhmm(CHOQUE_FIM_MIN)}`]:
        "choque do à vista: sem novas + break-even forçado",
      [`${hhmm(NY_INICIO_MIN)}-${hhmm(NY_FIM_MIN)}`]: "janela de alta liquidez (NY)",
      [`${hhmm(CORTE_NOVAS_MIN)}+`]: `bloqueio total, encerramento compulsório até ${hhmm(ENCERRAMENTO_LIMITE_MIN)}`,
    },
    custos: {
      taxasB3PorContratoPorPerna: B3_TAXAS_POR_CONTRATO_POR_PERNA,
      slippageTicks: { entrada: 1, stop: 1 },
      obrigatorio: "result_brl e netAfterCostsR sempre líquidos",
    },
    invariantes: [
      "pipeline visual único — sem RTD no runtime",
      "toda decisão em T usa apenas dados <= T",
      "IA observa, código determinístico valida",
      "sem score agregado: autorização exige todos os gates PASS",
    ],
  };
}

/** O registro pronto para `upsertTechniqueCandidate`. */
export function t41Candidate(now: number): TechniqueCandidateRecord {
  return {
    id: T41_CANDIDATE_ID,
    version: T41_CANDIDATE_VERSION,
    baseVersion: T4_PRODUCTION_VERSION,
    hypothesis:
      "Restringir o playbook por regime (tendência/lateralidade/gap), conduzir o runner pela " +
      "MME 9 em barra fechada e bloquear as faixas institucionais da B3 melhora a expectância " +
      "LÍQUIDA da T4 sem afrouxar nenhum gate.",
    status: "VALIDATION",
    rules: t41Rules(),
    createdAt: now,
    updatedAt: now,
  };
}
