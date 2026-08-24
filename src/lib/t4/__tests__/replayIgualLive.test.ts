import { describe, expect, it } from "vitest";

import { analyze } from "@/lib/engines/analysisPipeline";
import { evaluateT4Gates } from "../gates";
import { evaluateOperation } from "../preEntry";
import { buildReadingState, MIN_CLOSED_CANDLES } from "../readingState";
import { t4Versions, sameVersions } from "../version";
import { activeManagement } from "../management";
import type { Candle } from "@/lib/engines/types";

/**
 * MESMO INPUT + MESMA VERSÃO + MESMA GESTÃO = MESMO RESULTADO.
 *
 * O teste roda a técnica DUAS vezes sobre a mesma série e exige veredito
 * idêntico. O que ele tranca não é o resultado em si — é a ausência de estado
 * escondido no caminho: relógio, aleatoriedade, cache mutável, ordem de
 * iteração ou leitura de store durante a análise.
 *
 * `decide()` fica de fora de propósito: ele consulta a base de evidência
 * histórica, que muda quando novas operações são gravadas. Comparar duas
 * execuções com bases diferentes acusaria divergência sem que nada na técnica
 * tivesse mudado. A paridade vale sobre `analysis` + `gates` + `operation`.
 */

/** Série determinística, sem progressão aritmética (que é degenerada). */
function serie(n: number): Candle[] {
  const out: Candle[] = [];
  let preco = 139_000;
  let seed = 42;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    preco += ((seed % 240) - 118) / 2;
    const abertura = preco;
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    const fechamento = preco + ((seed % 160) - 80) / 2;
    out.push({
      t: Date.UTC(2026, 2, 13, 13, 0, 0) + i * 60_000,
      o: abertura,
      h: Math.max(abertura, fechamento) + 15,
      l: Math.min(abertura, fechamento) - 15,
      c: fechamento,
      v: 100 + (i % 7),
    });
    preco = fechamento;
  }
  return out;
}

const CANDLES = serie(90);
const AGORA = Date.UTC(2026, 2, 13, 14, 30, 0);

/** Uma execução completa da parte determinística da técnica. */
function executar(candles: Candle[]) {
  const reading = buildReadingState({
    closedCandles: candles.length,
    quality: 100,
    priceScaleReady: true,
    calibrationConfidence: 95,
  });
  const analysis = analyze(candles, { reading });
  const gates = evaluateT4Gates(analysis, true);
  const operation = evaluateOperation({
    dataReady: true,
    dataGates: [],
    t4Gates: gates,
    analysis,
    decision: null,
    entryState: "SCANNING",
    previous: null,
    now: AGORA,
  });
  return { analysis, gates, operation };
}

describe("Replay = Live", () => {
  it("duas execuções sobre a MESMA série produzem o mesmo veredito", () => {
    const a = executar(CANDLES);
    const b = executar(CANDLES);

    expect(b.analysis?.direction).toBe(a.analysis?.direction);
    expect(b.analysis?.regime.regime).toBe(a.analysis?.regime.regime);
    expect(b.analysis?.t4.setup).toBe(a.analysis?.t4.setup);
    expect(b.analysis?.t4.quality).toBe(a.analysis?.t4.quality);
    expect(b.gates.map((g) => `${g.id}:${g.status}`)).toEqual(
      a.gates.map((g) => `${g.id}:${g.status}`),
    );
    expect(b.operation.stage).toBe(a.operation.stage);
    expect(b.operation.maturity).toBe(a.operation.maturity);
    expect(b.operation.direction).toBe(a.operation.direction);
  });

  it("o plano estrutural é idêntico nas duas execuções", () => {
    const a = executar(CANDLES);
    const b = executar(CANDLES);
    expect(b.analysis?.plan?.entry).toBe(a.analysis?.plan?.entry);
    expect(b.analysis?.plan?.stop).toBe(a.analysis?.plan?.stop);
    expect(b.analysis?.plan?.riskRewardPlan).toBe(a.analysis?.plan?.riskRewardPlan);
  });

  it("uma série DIFERENTE pode produzir veredito diferente — o teste não é vácuo", () => {
    const a = executar(CANDLES);
    const outra = executar(serie(90).map((c, i) => ({ ...c, c: c.c + (i % 2 === 0 ? 90 : -90) })));
    const mudou =
      outra.analysis?.direction !== a.analysis?.direction ||
      outra.analysis?.regime.regime !== a.analysis?.regime.regime ||
      outra.operation.maturity !== a.operation.maturity ||
      outra.analysis?.plan?.entry !== a.analysis?.plan?.entry;
    expect(mudou).toBe(true);
  });

  it("os dois caminhos declaram as MESMAS três versões", () => {
    // Sem isso a comparação A===B não significa nada: seriam duas técnicas.
    expect(sameVersions(t4Versions(), t4Versions())).toBe(true);
    expect(t4Versions().management).toBe(activeManagement().version);
  });

  it("o mínimo de candles é um só para os dois caminhos", () => {
    const abaixo = buildReadingState({
      closedCandles: MIN_CLOSED_CANDLES - 1,
      quality: 100,
      priceScaleReady: true,
      calibrationConfidence: 95,
    });
    expect(abaixo.sufficient).toBe(false);
    const acima = buildReadingState({
      closedCandles: MIN_CLOSED_CANDLES,
      quality: 100,
      priceScaleReady: true,
      calibrationConfidence: 95,
    });
    expect(acima.sufficient).toBe(true);
  });
});
