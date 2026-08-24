import { DEFAULT_RISK_PARAMS } from "@/lib/engines/strategy";
/**
 * ENTRADA SIMULADA — provar que a técnica decide e que o site reage.
 *
 * O PROBLEMA QUE ISTO RESOLVE: um setup A/A+ real pode não aparecer por horas.
 * Enquanto ele não vem, não há como saber se a técnica está lendo o gráfico e
 * se a tela inteira — card de operação, níveis, gerenciamento, alerta sonoro —
 * funciona no instante da entrada. Descobrir que o painel está quebrado JUNTO
 * com o primeiro sinal real é o pior momento possível.
 *
 * Este módulo monta uma operação a partir da LEITURA DE AGORA e a marca como
 * simulação. Ela percorre exatamente os mesmos componentes que uma entrada real
 * percorreria — inclusive a guarda de preço, que é justamente o que precisa ser
 * testado.
 *
 * TRÊS REGRAS QUE ESTE ARQUIVO NÃO PODE VIOLAR
 *
 * 1. NÃO É SINAL. `simulated: true` viaja no objeto e a UI é obrigada a
 *    anunciá-lo. Uma simulação que passe por entrada real seria pior que não
 *    ter o botão: seria fabricar sinal, que é a única coisa proibida sem
 *    exceção neste sistema.
 * 2. NÃO TOCA NO ESTADO REAL. Nada aqui altera a máquina de entrada, a linha do
 *    tempo do setup, a série ou os gates. A T4 continua no estágio em que
 *    estava, e o `visionDiagnostics` continua descrevendo o mercado, não o teste.
 * 3. NÃO ENTRA NA EVIDÊNCIA. Nenhuma simulação é gravada como trade. A base
 *    histórica é o que autoriza operações reais — contaminá-la com teste
 *    envenenaria toda decisão futura.
 *
 * O QUE A SIMULAÇÃO USA DE VERDADE: os níveis vêm de `analysis.plan`, que é o
 * plano estrutural que a própria técnica calculou para o gráfico atual. Não são
 * números inventados — são os números que a T4 usaria SE o gatilho tivesse
 * acontecido. É isso que torna o teste informativo.
 */

import type { AnalysisResult, Direction } from "@/lib/engines/types";
import { entryZoneFor, IDLE_OPERATION, type T4Operation } from "./preEntry";

export interface SimulatedOperation extends T4Operation {
  /** SEMPRE true. A UI usa isto para nunca confundir teste com sinal. */
  simulated: true;
  /** true quando a direção veio da leitura; false quando foi arbitrada. */
  directionFromReading: boolean;
  /** Instante da simulação — telemetria, não instante de mercado. */
  simulatedAt: number;
  /** Alvos de gerenciamento derivados do risco do próprio plano. */
  target3R: number | null;
  target5R: number | null;
  /** O que a leitura sustentava no momento do teste. */
  readingSummary: string;
}

export interface SimulationInput {
  analysis: AnalysisResult | null;
  /** Direção preferida. Sem ela, usa o viés da leitura. */
  direction?: Direction | null;
  now: number;
}

export type SimulationResult =
  { ok: true; operation: SimulatedOperation } | { ok: false; reason: string };

/**
 * Monta a operação simulada.
 *
 * Falha explicitamente quando não há leitura suficiente: um botão que devolve
 * uma entrada bonita sobre nada testaria apenas a própria capacidade de inventar
 * números — exatamente o oposto do que ele existe para provar.
 */
export function simulateEntry(input: SimulationInput): SimulationResult {
  const { analysis, now } = input;
  if (analysis === null) {
    return {
      ok: false,
      reason:
        "Nenhuma análise concluída ainda: sem leitura não existe plano para simular. Inicie a leitura e aguarde o histórico mínimo.",
    };
  }

  const plan = analysis.plan;
  if (plan === null) {
    return {
      ok: false,
      reason:
        "A leitura atual não produziu plano estrutural (sem POI/stop definidos). Isto é informação: a técnica não tem onde ancorar entrada agora.",
    };
  }

  const fromReading = plan.direction === "COMPRA" || plan.direction === "VENDA";
  const direction: Direction =
    input.direction === "COMPRA" || input.direction === "VENDA"
      ? input.direction
      : fromReading
        ? plan.direction
        : "COMPRA";

  const entry = plan.entry;
  const stop = plan.stop;
  const risk = entry - stop;

  // Sem risco não há R, e sem R não há alvo. Devolver um número aqui seria
  // inventar o que o teste deveria estar verificando.
  const target3R = risk === 0 ? null : entry + risk * DEFAULT_RISK_PARAMS.partialTargetMultiple;
  const target5R = risk === 0 ? null : entry + risk * DEFAULT_RISK_PARAMS.finalTargetMultiple;

  const operation: SimulatedOperation = {
    ...IDLE_OPERATION,
    stage: "ENTRADA_CONFIRMADA",
    direction,
    // `confirmed` descreve o estágio SIMULADO. Quem distingue teste de sinal é
    // `simulated`, e é por isso que ele existe e é obrigatório na UI.
    confirmed: true,
    provisional: false,
    entry,
    entryZone: entryZoneFor(entry, stop),
    stop,
    partial: plan.target1,
    target: plan.target2,
    riskPoints: Math.abs(risk),
    rewardPoints: Math.abs(plan.target2 - entry),
    riskReward: plan.riskReward,
    contracts: null,
    invalidation:
      direction === "COMPRA"
        ? `perda de ${stop.toFixed(0)} — abaixo disso o setup deixaria de valer`
        : `rompimento de ${stop.toFixed(0)} — acima disso o setup deixaria de valer`,
    reasons: [
      `SIMULAÇÃO sobre a leitura de ${new Date(now).toLocaleTimeString("pt-BR")}`,
      `plano ${plan.mode} · R:R ${plan.riskReward.toFixed(2)}`,
      `regime ${analysis.regime.regime} · Wyckoff ${analysis.wyckoff.phase}`,
    ],
    missing: [],
    blockReason: null,
    maturity: 100,
    setupId: `sim:${direction}:${entry.toFixed(1)}:${stop.toFixed(1)}`,
    armedAt: now,

    simulated: true,
    directionFromReading: fromReading && !input.direction,
    simulatedAt: now,
    target3R,
    target5R,
    readingSummary: `${analysis.regime.regime} · ${analysis.t4.setup} · qualidade ${analysis.t4.quality} · ${analysis.sequence.label}`,
  };

  return { ok: true, operation };
}

/**
 * A frase que a UI é obrigada a mostrar junto de qualquer simulação.
 *
 * Fica aqui, e não no componente, para que qualquer tela nova que renderize uma
 * simulação use o mesmo aviso — e para que mudá-lo seja uma decisão consciente,
 * num arquivo só.
 */
export const SIMULATION_WARNING =
  "SIMULAÇÃO — não é sinal. Nenhuma ordem, nenhum registro, nenhuma evidência histórica.";
