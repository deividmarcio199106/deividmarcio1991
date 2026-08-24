/**
 * GATES TÉCNICOS DA T4 — a ordem em que a técnica tem permissão de aprovar.
 *
 * Este arquivo saiu de `lib/rtd` porque a técnica nunca foi de RTD. Enquanto
 * morou lá, o pipeline visual precisava importar de um diretório de um modo de
 * dado que não existe mais — e era justamente essa importação que mantinha o
 * legado vivo no runtime.
 *
 * Nada aqui recalcula técnica: cada gate LÊ o que o `analysisPipeline` já
 * decidiu. Se um gate discordasse do motor, o gate estaria errado.
 *
 * NENHUM GATE FOI AFROUXADO NA MUDANÇA. A função abaixo é a mesma, linha por
 * linha, que rodava antes — o que mudou foi de onde ela é importada.
 */

import type { AnalysisResult } from "@/lib/engines/types";
import { MIN_RISK_REWARD_PARTIAL } from "@/lib/engines/strategy";

export type GateStatus = "PASS" | "FAIL" | "PENDING" | "BLOCKED";

export type T4GateId =
  | "CONTEXT"
  | "STRUCTURE"
  | "LOCATION"
  | "LIQUIDITY"
  | "REACTION"
  | "STRUCTURE_SHIFT"
  | "POI_RETEST"
  | "CONFIRMATION_CANDLE"
  | "STOP_VALID"
  | "RISK_REWARD"
  | "T4_SIGNAL";

export type GateId = T4GateId;

export interface GateResult {
  id: T4GateId;
  label: string;
  status: GateStatus;
  /** Por que passou ou por que não. Nunca vazio. */
  detail: string;
}

export const T4_GATE_ORDER: T4GateId[] = [
  "CONTEXT",
  "STRUCTURE",
  "LOCATION",
  "LIQUIDITY",
  "REACTION",
  "STRUCTURE_SHIFT",
  "POI_RETEST",
  "CONFIRMATION_CANDLE",
  "STOP_VALID",
  "RISK_REWARD",
  "T4_SIGNAL",
];

const GATE_LABELS: Record<T4GateId, string> = {
  CONTEXT: "Contexto",
  STRUCTURE: "Estrutura",
  LOCATION: "Localização",
  LIQUIDITY: "Liquidez",
  REACTION: "Reação",
  STRUCTURE_SHIFT: "Mudança de estrutura",
  POI_RETEST: "POI + reteste",
  CONFIRMATION_CANDLE: "Candle de confirmação",
  STOP_VALID: "Stop válido",
  RISK_REWARD: "Risco/retorno",
  T4_SIGNAL: "Sinal T4",
};

function gate(id: T4GateId, status: GateStatus, detail: string): GateResult {
  return { id, label: GATE_LABELS[id], status, detail };
}

/**
 * Deriva os 11 gates técnicos do resultado do motor.
 *
 * Nada aqui recalcula técnica: cada gate lê o que o `analysisPipeline` já
 * decidiu. Se um gate discordasse do motor, o gate estaria errado.
 */
export function evaluateT4Gates(analysis: AnalysisResult | null, dataReady: boolean): GateResult[] {
  if (!dataReady) {
    return T4_GATE_ORDER.map((id) =>
      gate(id, "BLOCKED", "aguardando gates de dado — técnica não avaliada"),
    );
  }
  if (!analysis) {
    return T4_GATE_ORDER.map((id) => gate(id, "PENDING", "nenhuma análise concluída ainda"));
  }

  const stageMet = (stage: string): boolean =>
    analysis.sequence.stages.some((s) => s.stage === stage && s.met);
  const stageNote = (stage: string): string =>
    analysis.sequence.stages.find((s) => s.stage === stage)?.note ?? "sem leitura";

  const results: GateResult[] = [];

  const regime = analysis.regime.regime;
  results.push(
    regime === "UNCLEAR"
      ? gate("CONTEXT", "FAIL", "regime indefinido")
      : gate("CONTEXT", "PASS", `regime ${regime} · Wyckoff ${analysis.wyckoff.phase}`),
  );

  const estrutura = analysis.evidences.find((e) => e.group === "estrutura");
  results.push(
    estrutura && estrutura.state !== "ausente" && estrutura.state !== "invalidada"
      ? gate("STRUCTURE", "PASS", `${estrutura.label}: ${estrutura.state}`)
      : gate("STRUCTURE", "FAIL", estrutura ? `estrutura ${estrutura.state}` : "estrutura ausente"),
  );

  const esticado = analysis.t4.blockers.some((b) => b.includes("OVEREXTENSION"));
  if (esticado) {
    results.push(gate("LOCATION", "FAIL", "movimento esticado — entrada tardia"));
  } else if (!analysis.mainPoi) {
    results.push(gate("LOCATION", "FAIL", "nenhum POI de referência"));
  } else if (analysis.mainPoi.condition === "invalidado") {
    results.push(gate("LOCATION", "FAIL", "POI principal invalidado"));
  } else {
    results.push(
      gate("LOCATION", "PASS", `POI ${analysis.mainPoi.kind} força ${analysis.mainPoi.strength}`),
    );
  }

  results.push(
    analysis.liquidity.levels.length > 0
      ? gate("LIQUIDITY", "PASS", `${analysis.liquidity.levels.length} níveis mapeados`)
      : gate("LIQUIDITY", "FAIL", "mapa de liquidez vazio"),
  );

  results.push(
    stageMet("reaction")
      ? gate("REACTION", "PASS", stageNote("reaction"))
      : gate("REACTION", "FAIL", stageNote("reaction")),
  );

  /*
   * MUDANÇA ESTRUTURAL É EXIGÊNCIA DE FAMÍLIA, não regra global.
   *
   * Este gate lia `sms.confirmed` direto e reprovava TREND_FIRST_PULLBACK e
   * EXPANSION_RETEST — famílias que o roteador declara sem exigência de quebra
   * de estrutura (continuação de tendência respeita a estrutura VIGENTE). A
   * sequência causal já sabe quem exige o quê; o gate passa a ler o estágio,
   * que é a mesma fonte. Para as famílias de captura nada muda: o estágio só
   * é cumprido com SMS confirmada na direção do setup.
   */
  results.push(
    stageMet("structureShift")
      ? gate(
          "STRUCTURE_SHIFT",
          "PASS",
          analysis.internalConfirmation.sms.confirmed
            ? analysis.internalConfirmation.sms.label
            : stageNote("structureShift"),
        )
      : gate("STRUCTURE_SHIFT", "FAIL", stageNote("structureShift")),
  );

  const poiOk = stageMet("poi");
  const retestOk = stageMet("retest");
  results.push(
    poiOk && retestOk
      ? gate("POI_RETEST", "PASS", stageNote("retest"))
      : gate("POI_RETEST", "FAIL", poiOk ? stageNote("retest") : stageNote("poi")),
  );

  results.push(
    stageMet("confirmationClose") && analysis.reading.lastCandleClosed
      ? gate("CONFIRMATION_CANDLE", "PASS", stageNote("confirmationClose"))
      : gate(
          "CONFIRMATION_CANDLE",
          "FAIL",
          analysis.reading.lastCandleClosed
            ? stageNote("confirmationClose")
            : "nenhum candle fechado para confirmar",
        ),
  );

  const plan = analysis.plan;
  results.push(
    plan && plan.stopDistance > 0
      ? gate("STOP_VALID", "PASS", `stop ${plan.stop} · distância ${plan.stopDistance.toFixed(2)}`)
      : gate("STOP_VALID", "FAIL", plan ? "distância de stop nula" : "sem plano estrutural"),
  );

  if (!plan) {
    results.push(gate("RISK_REWARD", "FAIL", "sem plano para medir risco/retorno"));
  } else {
    const menor = Math.min(plan.riskReward, plan.riskRewardFinal, plan.riskRewardPlan);
    results.push(
      menor >= MIN_RISK_REWARD_PARTIAL
        ? gate("RISK_REWARD", "PASS", `menor R:R ${menor.toFixed(2)}`)
        : gate(
            "RISK_REWARD",
            "FAIL",
            `menor R:R ${menor.toFixed(2)} abaixo de ${MIN_RISK_REWARD_PARTIAL}`,
          ),
    );
  }

  if (analysis.t4.productionReady && analysis.blockers.length === 0) {
    results.push(
      gate("T4_SIGNAL", "PASS", `${analysis.t4.setup} · qualidade ${analysis.t4.quality}`),
    );
  } else {
    results.push(
      gate(
        "T4_SIGNAL",
        "FAIL",
        analysis.blockers[0] ?? analysis.t4.blockers[0] ?? "setup A/A+ não configurado",
      ),
    );
  }

  return results;
}
