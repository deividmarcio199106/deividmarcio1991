/**
 * TESTE DA TÉCNICA — a mesma série entra, a mesma decisão sai.
 *
 * O QUE ISTO SUBSTITUI: existia um "REPRODUZIR ERRO" que reencenava os ticks
 * gravados da bridge RTD pelo mesmo `analyze()` e provava que a decisão saía
 * idêntica. Aquele botão morreu junto com o RTD — ele lia `RtdTick`, e ticks de
 * bridge não existem mais. O teste, porém, continua sendo necessário: quando a
 * T4 dá um sinal estranho, a primeira pergunta é sempre "foi a técnica ou foi a
 * leitura?", e sem reprodução determinística não há como responder.
 *
 * No pipeline visual a entrada bruta não é tick: é a SÉRIE COSTURADA do
 * `ChartTracker`. É ela que este bundle guarda, junto do veredito que o motor
 * produziu naquele instante.
 *
 * O QUE TORNA O REPLAY DETERMINÍSTICO
 * - `analyze()` é puro sobre `Candle[]` + `ReadingState`;
 * - `evaluateT4Gates` lê só o resultado da análise;
 * - `evaluateOperation` recebe o `now` GRAVADO, não o relógio de agora — senão
 *   o mesmo bundle daria resultados diferentes a cada execução, e a diferença
 *   seria do teste, não da técnica;
 * - a versão da técnica viaja no bundle: replay em outra versão é COMPARAÇÃO,
 *   não reprodução, e o relatório diz isso em vez de acusar divergência.
 *
 * O QUE FICA DE FORA, DE PROPÓSITO
 * `decide()` consulta a base de evidência histórica, que muda quando novas
 * operações são gravadas. Reexecutá-lo compararia duas bases diferentes e
 * acusaria divergência sem que nada na técnica tenha mudado. A decisão é
 * gravada para leitura humana; o que o teste REEXECUTA é a parte determinística.
 */

import { analyze } from "@/lib/engines/analysisPipeline";
import { riskParamsForAsset, STRATEGY_VERSION } from "@/lib/engines/strategy";
import type { AnalysisResult, Candle, ReadingState } from "@/lib/engines/types";
import type { DecisionObject } from "@/lib/engines/backtestDecisionEngine";
import { evaluateT4Gates, type GateResult } from "@/lib/t4/gates";
import { evaluateOperation, type T4Operation } from "@/lib/t4/preEntry";
import type { SetupTimeline } from "@/lib/t4/leadTime";
import type { SourceMode } from "./sourceMode";

export const VISION_REPLAY_FORMAT = 2;

export interface VisionReplayBundle {
  formatVersion: number;
  /** Instante de MERCADO da captura, ou null quando não é confiável. */
  capturedAtMarket: number | null;
  /** Instante local — telemetria apenas, nunca data de mercado. */
  capturedAtSystem: number;
  sessionId: string;
  symbol: string;
  sourceMode: SourceMode;
  strategyVersion: string;
  /** Por que o bundle foi capturado: pedido humano ou falha automática. */
  trigger: string;

  /** A ENTRADA BRUTA do pipeline visual: a série costurada. */
  candles: Candle[];
  reading: ReadingState;
  priceScaleReady: boolean;
  /** `now` do instante da avaliação — reexecutar sem isto não é reprodução. */
  evaluatedAt: number;
  entryState: string;

  /** O VEREDITO gravado, para comparar com o reexecutado. */
  analysis: AnalysisResult | null;
  decision: DecisionObject | null;
  t4Gates: GateResult[];
  operation: T4Operation;
  timeline: SetupTimeline | null;
}

export interface CaptureInput {
  sessionId: string;
  symbol: string;
  sourceMode: SourceMode;
  trigger: string;
  candles: Candle[];
  reading: ReadingState;
  priceScaleReady: boolean;
  evaluatedAt: number;
  entryState: string;
  analysis: AnalysisResult | null;
  decision: DecisionObject | null;
  t4Gates: GateResult[];
  operation: T4Operation;
  timeline: SetupTimeline | null;
  capturedAtMarket: number | null;
  capturedAtSystem: number;
}

export function captureVisionReplay(input: CaptureInput): VisionReplayBundle {
  return {
    formatVersion: VISION_REPLAY_FORMAT,
    capturedAtMarket: input.capturedAtMarket,
    capturedAtSystem: input.capturedAtSystem,
    sessionId: input.sessionId,
    symbol: input.symbol,
    sourceMode: input.sourceMode,
    strategyVersion: STRATEGY_VERSION,
    trigger: input.trigger,
    // Cópias: o tracker continua mexendo na série dele depois desta linha.
    candles: [...input.candles],
    reading: { ...input.reading },
    priceScaleReady: input.priceScaleReady,
    evaluatedAt: input.evaluatedAt,
    entryState: input.entryState,
    analysis: input.analysis,
    decision: input.decision,
    t4Gates: [...input.t4Gates],
    operation: { ...input.operation },
    timeline: input.timeline ? { ...input.timeline } : null,
  };
}

export interface ReplayDivergence {
  campo: string;
  gravado: string;
  replay: string;
}

export interface VisionReplayOutcome {
  ok: boolean;
  /** true quando o bundle foi gravado nesta mesma versão da técnica. */
  sameStrategyVersion: boolean;
  candlesReplayed: number;
  gatesReplayed: number;
  /** Divergências entre o gravado e o reexecutado. Vazio = determinístico. */
  divergences: ReplayDivergence[];
  message: string;
}

function describe(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(4);
  return String(value);
}

/**
 * Reexecuta a técnica sobre a série gravada e compara veredito a veredito.
 *
 * Divergência aqui significa que a mesma entrada produziu saída diferente — ou
 * seja, existe estado escondido no caminho (relógio, aleatoriedade, cache
 * mutável). É o primeiro lugar para olhar quando um sinal sai errado, e é a
 * única forma de separar "a técnica reprovou" de "a leitura estava ruim".
 */
export function replayTechnique(bundle: VisionReplayBundle): VisionReplayOutcome {
  const sameStrategyVersion = bundle.strategyVersion === STRATEGY_VERSION;
  const divergences: ReplayDivergence[] = [];

  if (bundle.candles.length === 0) {
    return {
      ok: false,
      sameStrategyVersion,
      candlesReplayed: 0,
      gatesReplayed: 0,
      divergences: [],
      message: "O bundle não tem candles: nada a reproduzir. Inicie a leitura e capture de novo.",
    };
  }

  // O ATIVO FAZ PARTE DA ENTRADA, não só a série: é dele que sai o tick do
  // contrato. Reexecutar sem ele daria níveis fora do tick e o replay acusaria
  // divergência de arredondamento — divergência do teste, não da técnica.
  const analysis = analyze(bundle.candles, {
    reading: bundle.reading,
    riskParams: riskParamsForAsset(bundle.symbol),
  });
  const gates = evaluateT4Gates(analysis, true);
  const operation = evaluateOperation({
    dataReady: true,
    dataGates: [],
    t4Gates: gates,
    analysis,
    decision: bundle.decision,
    entryState: bundle.entryState,
    // O estado anterior faz parte da entrada: sem ele, INVALIDADA e o instante
    // de armamento não teriam como se reproduzir.
    previous: null,
    now: bundle.evaluatedAt,
  });

  const compare = (campo: string, gravado: unknown, replay: unknown) => {
    if (describe(gravado) !== describe(replay)) {
      divergences.push({ campo, gravado: describe(gravado), replay: describe(replay) });
    }
  };

  compare("análise.direção", bundle.analysis?.direction, analysis?.direction);
  compare("análise.regime", bundle.analysis?.regime.regime, analysis?.regime.regime);
  compare("análise.setup", bundle.analysis?.t4.setup, analysis?.t4.setup);
  compare("análise.qualidade", bundle.analysis?.t4.quality, analysis?.t4.quality);
  compare("análise.prontoTecnicamente", bundle.analysis?.technicalReady, analysis?.technicalReady);
  compare(
    "análise.liquidez",
    bundle.analysis?.liquidity.levels.length,
    analysis?.liquidity.levels.length,
  );

  for (const gravado of bundle.t4Gates) {
    const atual = gates.find((gate) => gate.id === gravado.id);
    compare(`gate.${gravado.id}`, gravado.status, atual?.status);
  }

  // O estágio é o que o operador leu na tela: divergir aqui é o caso grave.
  compare("operação.estágio", bundle.operation.stage, operation.stage);
  compare("operação.direção", bundle.operation.direction, operation.direction);
  compare("operação.maturidade", bundle.operation.maturity, operation.maturity);
  compare("operação.confirmada", bundle.operation.confirmed, operation.confirmed);

  const ok = divergences.length === 0;
  return {
    ok,
    sameStrategyVersion,
    candlesReplayed: bundle.candles.length,
    gatesReplayed: gates.length,
    divergences: divergences.slice(0, 20),
    message: !ok
      ? sameStrategyVersion
        ? `${divergences.length} divergência(s) na MESMA versão da técnica — existe estado escondido no caminho.`
        : `${divergences.length} divergência(s), mas o bundle é da técnica ${bundle.strategyVersion} e o código atual é ${STRATEGY_VERSION}: divergir aqui é legítimo.`
      : sameStrategyVersion
        ? `Técnica reproduzida exatamente sobre ${bundle.candles.length} candles: mesma análise, mesmos ${gates.length} gates, mesmo estágio. A decisão é auditável.`
        : `Reprodução idêntica, mas o bundle é da técnica ${bundle.strategyVersion} e o código atual é ${STRATEGY_VERSION}.`,
  };
}
