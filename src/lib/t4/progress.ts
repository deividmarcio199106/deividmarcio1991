import type { AnalysisResult } from "@/lib/engines/types";
import type { PipelineDiagnostics } from "./diagnostics";
import type { TradeSignalSnapshot } from "./signalSnapshot";

/**
 * PROGRESSO T4 0–100% (comando §6).
 *
 * O percentual mede a COMPLETUDE DA LEITURA TÉCNICA, nunca chance de gain e
 * nunca timer/score fake. Cada degrau vem de um fato REAL do pipeline:
 *
 *   0%  = não iniciado
 *  10%  = captura ativa
 *  20%  = Profit detectado
 *  30%  = gráfico detectado
 *  40%  = preços/escala calibrados
 *  50%  = chartClock resolvido (válido, ou fallback declarado com motivo)
 *  60%  = estrutura lida no candle fechado
 *  70%  = liquidez mapeada
 *  80%  = contraponto (motor adversarial) avaliado
 *  90%  = confluências/gates oficiais avaliados
 * 100%  = sinal CONFIRMADO + signalId válido (snapshot imutável existe)
 *
 * Os degraus são MONOTÔNICOS: um degrau só conta se todos os anteriores estão
 * cumpridos — o número nunca "pula" por um estado isolado fora de ordem.
 */

export type T4Stage = "ESTRUTURA" | "LIQUIDEZ" | "CONTRAPONTO" | "CONFLUENCIAS" | "ENTRADA";

export interface T4Progress {
  percent: 0 | 10 | 20 | 30 | 40 | 50 | 60 | 70 | 80 | 90 | 100;
  status: "AGUARDAR" | "ANALISANDO" | "CONFIRMADO";
  stages: Record<T4Stage, boolean>;
  /** Bloqueios reais exibidos enquanto <100%. */
  blockers: string[];
  /** Rótulo do degrau atual, para a UI explicar o que falta. */
  currentStepLabel: string;
}

export interface ProgressInput {
  sessionActive: boolean;
  diagnostics: PipelineDiagnostics;
  analysis: AnalysisResult | null;
  /** Gates/confluências oficiais avaliados (DecisionObject calculado). */
  decisionEvaluated: boolean;
  snapshot: TradeSignalSnapshot | null;
}

const STEP_LABELS: Record<number, string> = {
  0: "NÃO INICIADO",
  10: "CAPTURA DE TELA",
  20: "DETECÇÃO DO PROFIT",
  30: "DETECÇÃO DO GRÁFICO",
  40: "PREÇOS / ESCALA",
  50: "CHART CLOCK",
  60: "ESTRUTURA",
  70: "LIQUIDEZ",
  80: "CONTRAPONTO",
  90: "CONFLUÊNCIAS / GATES",
  100: "ENTRADA CONFIRMADA",
};

export function computeT4Progress(input: ProgressInput): T4Progress {
  const { diagnostics, analysis, snapshot } = input;

  const structureRead =
    analysis !== null &&
    analysis.evidences.some((item) => item.group === "estrutura" && item.state !== "ausente");
  // `>= 0` era tautologia: a etapa LIQUIDEZ acendia com o mapa VAZIO, que é
  // exatamente o caso em que o gate LIQUIDITY reprova. Dois indicadores da mesma
  // coisa discordando na mesma tela.
  const liquidityMapped =
    analysis !== null && analysis.liquidity.levels.length > 0 && structureRead;
  const contrapontoEvaluated = analysis !== null && Array.isArray(analysis.contradictions);
  const gatesEvaluated = analysis !== null && input.decisionEvaluated;
  const confirmed = snapshot !== null && snapshot.signalId.length > 0;

  const steps: Array<[number, boolean]> = [
    [10, input.sessionActive && diagnostics.CAPTURE_ACTIVE],
    [20, diagnostics.PROFIT_DETECTED],
    [30, diagnostics.GRAPH_DETECTED],
    [40, diagnostics.PRICE_AXIS],
    // chartClock: válido, OU fallback realtime DECLARADO com motivo registrado.
    [
      50,
      diagnostics.CHART_CLOCK === "VALID" ||
        (diagnostics.CHART_CLOCK === "FALLBACK_REALTIME" && diagnostics.chartClockReason !== null),
    ],
    [60, structureRead],
    [70, liquidityMapped],
    [80, contrapontoEvaluated],
    [90, gatesEvaluated],
    [100, confirmed],
  ];

  let percent: T4Progress["percent"] = 0;
  for (const [value, met] of steps) {
    if (!met) break;
    percent = value as T4Progress["percent"];
  }

  const stages: Record<T4Stage, boolean> = {
    ESTRUTURA: percent >= 60,
    LIQUIDEZ: percent >= 70,
    CONTRAPONTO: percent >= 80,
    CONFLUENCIAS: percent >= 90,
    ENTRADA: percent >= 100,
  };

  const blockers: string[] = [];
  if (percent < 100) {
    if (diagnostics.parseError) blockers.push(diagnostics.parseError);
    if (diagnostics.BLOCK_REASON) blockers.push(diagnostics.BLOCK_REASON);
    for (const blocker of analysis?.blockers ?? []) blockers.push(blocker);
  }

  const nextStep = steps.find(([value]) => value > percent);
  return {
    percent,
    status: percent >= 100 ? "CONFIRMADO" : percent === 0 ? "AGUARDAR" : "ANALISANDO",
    stages,
    blockers: [...new Set(blockers)].slice(0, 8),
    currentStepLabel:
      percent >= 100 ? STEP_LABELS[100]! : (STEP_LABELS[nextStep ? nextStep[0] : 0] ?? ""),
  };
}
