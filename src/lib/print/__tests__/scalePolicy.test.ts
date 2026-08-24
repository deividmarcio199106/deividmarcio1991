import { describe, expect, it } from "vitest";

import type { ChartBounds } from "@/lib/vision/chartRoi";
import { EMPTY_PRICE_SCALE, type PriceScaleState } from "@/lib/vision/priceScaleTracker";
import {
  planScale,
  REVALIDACAO_DE_ROTINA_MS,
  TOLERANCIA_DE_MOLDURA,
  type ScaleMemory,
} from "../scalePolicy";

/**
 * A POLÍTICA DA RÉGUA EM TESTE.
 *
 * O que ela precisa provar: não recalibrar do zero em todo print (era o
 * comportamento anterior, e produziu erros de 121 a 774 pontos na linha de
 * entrada), mas também não reusar cegamente uma régua cuja janela mudou.
 */

const T0 = Date.UTC(2026, 7, 20, 13, 0, 0);

function moldura(over: Partial<ChartBounds> = {}): ChartBounds {
  return {
    x: 0,
    y: 0.113,
    width: 0.97,
    height: 0.73,
    px: { x0: 0, y0: 27, x1: 232, y1: 202 },
    peeled: { top: 27, bottom: 37, left: 0, right: 7 },
    usable: true,
    reason: "moldura do gráfico: 97% × 73% da janela",
    ...over,
  };
}

/** Uma régua vigente e confiável — o estado em que o cache faz sentido. */
function reguaBoa(over: Partial<PriceScaleState> = {}): PriceScaleState {
  return {
    ...EMPTY_PRICE_SCALE,
    priceScaleReady: true,
    priceConfidence: 88,
    pricePerPixel: -0.19,
    scaleResidual: 1.2,
    lastScaleUpdate: T0,
    anchorCount: 6,
    blockReason: null,
    ...over,
  };
}

function memoria(over: Partial<ScaleMemory> = {}): ScaleMemory {
  return {
    state: reguaBoa(),
    bounds: moldura(),
    asset: "WINFUT",
    frameHeight: 720,
    ...over,
  };
}

const CONTEXTO = { chartBounds: moldura(), asset: "WINFUT" };

describe("primeira leitura e reaproveitamento", () => {
  it("sem memória, calibra", () => {
    const p = planScale(null, CONTEXTO, T0);
    expect(p.decision).toBe("PRIMEIRA_CALIBRACAO");
    expect(p.recalibrate).toBe(true);
  });

  it("memória sem calibração concluída também calibra", () => {
    const p = planScale(memoria({ state: EMPTY_PRICE_SCALE }), CONTEXTO, T0);
    expect(p.recalibrate).toBe(true);
  });

  it("com janela igual e dentro do prazo, REUSA — e diz que reusou", () => {
    /*
     * O ponto da tarefa toda: antes, este caso gastava uma inferência de visão
     * e refazia a reta do zero, em TODO print.
     */
    const p = planScale(memoria(), CONTEXTO, T0 + 60_000);
    expect(p.decision).toBe("REUSA_CACHE");
    expect(p.recalibrate).toBe(false);
    expect(p.reason).toContain("reaproveitada");
  });

  it("tremor de detecção NÃO conta como mudança de janela", () => {
    // A moldura sai de bitmap amostrado e treme entre frames com a janela parada.
    const tremida = moldura({ y: 0.113 + TOLERANCIA_DE_MOLDURA / 2 });
    const p = planScale(memoria(), { chartBounds: tremida, asset: "WINFUT" }, T0 + 60_000);
    expect(p.recalibrate).toBe(false);
  });
});

describe("o que obriga a recalibrar", () => {
  it("a área do gráfico mudou (zoom, arrasto, resize)", () => {
    const outra = moldura({ height: 0.73 - TOLERANCIA_DE_MOLDURA * 3 });
    const p = planScale(memoria(), { chartBounds: outra, asset: "WINFUT" }, T0 + 60_000);
    expect(p.decision).toBe("RECALIBRA_MOLDURA_MUDOU");
    expect(p.recalibrate).toBe(true);
  });

  it("trocou de ativo — WIN e WDO não compartilham eixo", () => {
    const p = planScale(memoria(), { chartBounds: moldura(), asset: "WDOFUT" }, T0 + 60_000);
    expect(p.decision).toBe("RECALIBRA_ATIVO_TROCOU");
  });

  it("a captura não localizou a moldura — sem sinal, relê", () => {
    /*
     * Reusar no escuro é o que produz linha centenas de pontos fora do lugar:
     * não se sabe se a janela é a mesma, e a régua sai justamente daí.
     */
    const p = planScale(memoria(), { chartBounds: null, asset: "WINFUT" }, T0 + 60_000);
    expect(p.decision).toBe("RECALIBRA_SEM_MOLDURA");
    expect(p.recalibrate).toBe(true);

    const inutil = moldura({ usable: false });
    expect(
      planScale(memoria(), { chartBounds: inutil, asset: "WINFUT" }, T0 + 60_000).recalibrate,
    ).toBe(true);
  });

  it("escala vigente inválida não se reusa, e o motivo dela é repassado", () => {
    const ruim = memoria({
      state: reguaBoa({ priceScaleReady: false, blockReason: "só 2 rótulos legíveis no eixo" }),
    });
    const p = planScale(ruim, CONTEXTO, T0 + 60_000);
    expect(p.decision).toBe("RECALIBRA_ESCALA_INVALIDA");
    expect(p.reason).toBe("só 2 rótulos legíveis no eixo");
  });

  it("vencido o prazo de rotina, relê mesmo com tudo parado", () => {
    /*
     * A rede de segurança: o operador pode arrastar a ESCALA VERTICAL sem
     * mudar o tamanho do gráfico, e aí a moldura não acusa nada.
     */
    const p = planScale(memoria(), CONTEXTO, T0 + REVALIDACAO_DE_ROTINA_MS + 1);
    expect(p.decision).toBe("RECALIBRA_PRAZO");
    expect(p.recalibrate).toBe(true);
  });

  it("e ANTES do prazo, não relê — senão não existe cache", () => {
    const p = planScale(memoria(), CONTEXTO, T0 + REVALIDACAO_DE_ROTINA_MS - 1);
    expect(p.recalibrate).toBe(false);
  });
});

describe("o prazo é do caminho do print, não do caminho ao vivo", () => {
  it("é bem maior que os 30s do tracker ao vivo", () => {
    /*
     * Com 30s num ciclo de 60s, `needsRefresh` seria verdadeiro em todo print e
     * o cache não existiria — que é exatamente o estado que a política veio
     * consertar. Cada revalidação aqui custa uma inferência sobre o eixo.
     */
    expect(REVALIDACAO_DE_ROTINA_MS).toBeGreaterThan(60_000);
  });

  it("todo plano traz motivo — inclusive o de reusar", () => {
    const planos = [
      planScale(null, CONTEXTO, T0),
      planScale(memoria(), CONTEXTO, T0 + 60_000),
      planScale(memoria(), { chartBounds: null, asset: "WINFUT" }, T0 + 60_000),
    ];
    for (const p of planos) expect(p.reason.length).toBeGreaterThan(0);
  });
});
