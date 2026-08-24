/**
 * T4.2-HYBRID_ENTRY — a candidata que muda SÓ a execução, congelada ANTES de
 * qualquer dado novo ser aberto.
 *
 * MARÇO ESTÁ CONTAMINADO. Todas as decisões de desenho abaixo foram tomadas
 * olhando os 11 pregões de março — por isso março NUNCA conta como validação
 * desta candidata: `datasetSeen=["MARCO"]` declara a contaminação no próprio
 * congelamento, e a validação começa em abril.
 *
 * O QUE ESTA CANDIDATA NÃO TOCA (idêntico à T4 congelada):
 *   setup, E2 em candle fechado, tendência/pullback/pivô, MIN_RR=3, stop
 *   estrutural, gestão 3R/5R/runner, gates de risco e de horário.
 *
 * O QUE ELA MUDA — apenas ONDE e QUANDO a entrada é executada após o E2
 * CONFIRMADO:
 *   1. NÃO entra a mercado no rompimento (março provou: stop estrutural longe
 *      infla o risco e 67% stopa antes do 3R).
 *   2. NÃO espera o reteste da zona antiga (março provou: 98% nunca preenche).
 *   3. Zona híbrida: do FECHAMENTO do E2 até 50% do range do E2, a favor do
 *      pullback. TTL de 3 candles fechados. Primeira negociação dentro da zona
 *      é o candidato a fill; no preço REAL do fill, stop/RR/alvos/espaço são
 *      RECALCULADOS e os gates rodam de novo — RR<3 ou obstáculo antes de 5R
 *      no risco novo = NO_TRADE, mesmo com o setup perfeito.
 *   4. PROIBIDO perseguir: sem conversão a mercado, sem ampliar zona, sem
 *      reancorar. Não tocou em 3 candles = EXPIRED_NO_FILL, e acabou.
 */

import { createHash } from "node:crypto";

import type { TechniqueCandidateRecord } from "@/lib/storage";
import { T4_PRODUCTION_VERSION } from "./version";

export const T42_CANDIDATE_ID = "T4.2-HYBRID_ENTRY";
export const T42_CANDIDATE_VERSION = "T4.2.0-hybrid-entry";

/**
 * A CONFIGURAÇÃO DE EXECUÇÃO — números congelados. Mudar qualquer um deles
 * depois de abril ter sido aberto invalida a validação inteira; o codeHash
 * do snapshot existe para denunciar exatamente isso.
 */
export const T42_EXECUTION = {
  /** Profundidade da zona: do close do E2 até 50% do range do E2. */
  zoneDepthOfE2Range: 0.5,
  /** Tick do WIN — a zona sai arredondada para preço que existe no book. */
  tickSize: 5,
  /** Candles FECHADOS após o E2 para o preço visitar a zona. */
  ttlCandles: 3,
  /** Derrapagem conservadora no fill, em ticks contra a posição. */
  fillSlippageTicks: 1,
  /** Piso da casa reavaliado NO PREÇO REAL do fill. */
  minRrAtFill: 3,
  /** Espaço estrutural mínimo até o obstáculo, em múltiplos do risco NOVO. */
  requiredRoomR: 5,
  noChase: true as const,
} as const;

/** Regras completas — é isto que vira `rules_json`, serializado uma vez. */
export function t42Rules(): Record<string, unknown> {
  return {
    tecnica: "T4.2 — entrada híbrida na zona do E2",
    baseVersion: T4_PRODUCTION_VERSION,
    naoAltera: [
      "setup T4 e leitura de estrutura",
      "E2 somente em candle fechado",
      "tendência/pullback/pivô",
      "MIN_RR=3 (fonte única)",
      "stop estrutural",
      "gestão 3 contratos: parcial 3R, alvo 5R, runner",
      "gates de risco e de horário",
    ],
    execucao: {
      zona: "do fechamento do E2 até 50% do range do E2, a favor do pullback",
      arredondamento: `tick ${T42_EXECUTION.tickSize} (WIN)`,
      ttl: `${T42_EXECUTION.ttlCandles} candles fechados após o E2`,
      fill: "primeira negociação dentro da zona; abertura dentro da zona preenche na abertura, senão na borda proximal tocada",
      slippage: `${T42_EXECUTION.fillSlippageTicks} tick contra a posição no fill + custos B3`,
      recalculoNoFill: [
        "stop estrutural do evento (imutável)",
        "RR sobre o risco NOVO |fill−stop|",
        "alvo 3R e 5R sobre o risco NOVO",
        "espaço estrutural até o obstáculo sobre o risco NOVO",
      ],
      vetosNoFill: {
        RR_LT_3: `RR<${T42_EXECUTION.minRrAtFill} no preço real do fill`,
        TARGET_5R_NO_ROOM: `obstáculo antes de ${T42_EXECUTION.requiredRoomR}R do risco novo`,
      },
      semPerseguicao:
        "PROIBIDO converter para mercado, ampliar a zona ou reancorar; sem toque em 3 candles = EXPIRED_NO_FILL",
    },
    validacaoCronologica: {
      MARCO: "REFERÊNCIA CONTAMINADA — regras desenhadas olhando estes dados; nunca conta como OOS",
      ABRIL: "VALIDATION",
      MAIO_JUNHO: "WALK_FORWARD fixo, sem tuning",
      JULHO: "OOS FINAL SELADO — só abre com este hash congelado",
      FEVEREIRO: "robustness check adicional; nunca usado para ajuste",
    },
    gateMinimo: ">=30 execuções validamente preenchidas; N<30 = SAMPLE_INSUFFICIENT, sem promoção",
  };
}

/**
 * Hash do CONTEÚDO das regras + config: se qualquer número mudar depois do
 * congelamento, o hash muda e a comparação com o gravado denuncia.
 */
export function t42RulesHash(): string {
  return createHash("sha256")
    .update(JSON.stringify(t42Rules()))
    .update(JSON.stringify(T42_EXECUTION))
    .digest("hex");
}

export function t42Candidate(now: number): TechniqueCandidateRecord {
  return {
    id: T42_CANDIDATE_ID,
    version: T42_CANDIDATE_VERSION,
    baseVersion: T4_PRODUCTION_VERSION,
    hypothesis:
      "A entrada híbrida (zona entre o close do E2 e 50% do seu range, TTL 3 candles, gates " +
      "reavaliados no preço real do fill) preenche o que o reteste antigo perdia SEM pagar o " +
      "risco inflado da entrada a mercado — mantendo intactos setup, E2, MIN_RR=3, stop " +
      "estrutural e gestão 3R/5R/runner.",
    status: "VALIDATION",
    rules: {
      ...t42Rules(),
      config: T42_EXECUTION,
      rulesHash: t42RulesHash(),
      datasetSeen: ["MARCO"],
      congeladaEm: new Date(now).toISOString(),
    },
    createdAt: now,
    updatedAt: now,
  };
}

/* ------------------------------------------------------------------------ *
 * CONGELAMENTO VERIFICÁVEL (auditoria sênior, BLOCO 7)
 * ------------------------------------------------------------------------ */

export interface VereditoDoCongelamento {
  ok: boolean;
  /** Null quando ok. Sempre específico: qual verificação falhou e por quê. */
  motivo: string | null;
  hashDoCodigo: string;
  hashArmazenado: string | null;
}

/**
 * Confere o congelamento gravado contra DUAS ameaças distintas — no molde de
 * `canPromoteNewSetup04` (newSetup04.frozen.ts), que já recalcula o hash do
 * bloco congelado antes de qualquer promoção:
 *
 *   1. ADULTERAÇÃO DO ARMAZENADO: o hash é recalculado DO CONTEÚDO gravado
 *      (regras sem metadados + config gravada). Se alguém editou um número no
 *      banco sem refazer o hash, a conta não fecha.
 *   2. DERIVA DO CÓDIGO: o hash gravado é comparado com `t42RulesHash()` do
 *      código ATUAL. Se alguém mudou T42_EXECUTION depois do congelamento, o
 *      código deixou de ser o que a candidata validou.
 *
 * Divergência NUNCA é warning: quem consome (promoção, abertura de OOS) trata
 * `ok:false` como bloqueio explícito.
 */
export function conferirCongelamentoT42(
  rulesArmazenadas: Record<string, unknown> | null,
): VereditoDoCongelamento {
  const hashDoCodigo = t42RulesHash();
  if (rulesArmazenadas === null || typeof rulesArmazenadas !== "object") {
    return {
      ok: false,
      motivo: "rules_json da candidata T4.2 ausente ou ilegível — congelamento não verificável.",
      hashDoCodigo,
      hashArmazenado: null,
    };
  }
  const hashArmazenado =
    typeof rulesArmazenadas["rulesHash"] === "string" ? rulesArmazenadas["rulesHash"] : null;
  if (hashArmazenado === null) {
    return {
      ok: false,
      motivo: "rules_json sem rulesHash — a candidata não carrega prova de congelamento.",
      hashDoCodigo,
      hashArmazenado: null,
    };
  }

  // 1) Integridade do CONTEÚDO gravado: refaz a conta exatamente como o
  // congelamento fez (regras sem os metadados acrescentados + config gravada).
  const semMeta: Record<string, unknown> = { ...rulesArmazenadas };
  delete semMeta["config"];
  delete semMeta["rulesHash"];
  delete semMeta["datasetSeen"];
  delete semMeta["congeladaEm"];
  const hashDoConteudo = createHash("sha256")
    .update(JSON.stringify(semMeta))
    .update(JSON.stringify(rulesArmazenadas["config"] ?? null))
    .digest("hex");
  if (hashDoConteudo !== hashArmazenado) {
    return {
      ok: false,
      motivo: `conteúdo gravado NÃO bate com o hash gravado (${hashDoConteudo.slice(0, 12)}… ≠ ${hashArmazenado.slice(0, 12)}…) — registro adulterado após o congelamento.`,
      hashDoCodigo,
      hashArmazenado,
    };
  }

  // 2) Paridade com o CÓDIGO atual.
  if (hashArmazenado !== hashDoCodigo) {
    return {
      ok: false,
      motivo: `o código divergiu do congelamento (código ${hashDoCodigo.slice(0, 12)}… ≠ gravado ${hashArmazenado.slice(0, 12)}…) — algum número de T42_EXECUTION/regra mudou depois do freeze.`,
      hashDoCodigo,
      hashArmazenado,
    };
  }

  return { ok: true, motivo: null, hashDoCodigo, hashArmazenado };
}
