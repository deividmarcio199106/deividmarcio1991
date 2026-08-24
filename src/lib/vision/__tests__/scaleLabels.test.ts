import { describe, expect, it } from "vitest";

import { selectLabels, normalizeBrPrice, describeSelection, type RawLabel } from "../scaleLabels";
import { subsystemStatus, gpuStatusFrom, SCALE_ERROR_AFTER_ATTEMPTS } from "../subsystemStatus";

/**
 * O DEFEITO: `NON_MONOTONIC` reprovava a leitura INTEIRA quando um único rótulo
 * saía fora de ordem. Um eixo tem 5 a 8 rótulos; que o modelo erre um é o caso
 * normal — e descartar os outros sete por causa dele deixava a escala em recusa
 * permanente.
 */

const ALTURA = 1000;
const WIN = { min: 10_000, max: 500_000 };

/** Eixo real: preço CRESCE de baixo para cima, logo cai conforme y cresce. */
function rotulo(yPercent: number, price: number, confidence = 0.9): RawLabel {
  return { raw: String(price), price, yPercent, confidence };
}

describe("monotonicidade — descarta o rótulo, não a leitura", () => {
  it("um rótulo fora de ordem não invalida os outros", () => {
    const r = selectLabels(
      [
        rotulo(10, 139_500),
        rotulo(30, 139_000),
        rotulo(50, 141_000), // ERRADO: sobe onde deveria cair
        rotulo(70, 138_000),
        rotulo(90, 137_500),
      ],
      ALTURA,
      WIN,
    );

    expect(r.kept.length).toBe(4);
    expect(r.regression).not.toBeNull();
    expect(r.reason).toBeNull();
    const descartado = r.labels.find((l) => l.price === 141_000)!;
    expect(descartado.kept).toBe(false);
    expect(descartado.drop).toBe("QUEBRA_ORDEM");
  });

  it("dois rótulos fora de ordem também não derrubam a leitura", () => {
    const r = selectLabels(
      // Os aproveitaveis sao COLINEARES (p = 140000 - 20·y%), como um eixo
      // real; os dois intrusos quebram a ordem. Fixture nao colinear mediria o
      // descarte por residuo, nao o descarte por ordem.
      [
        rotulo(10, 139_800),
        rotulo(25, 142_000),
        rotulo(40, 139_200),
        rotulo(55, 143_000),
        rotulo(70, 138_600),
        rotulo(85, 138_300),
      ],
      ALTURA,
      WIN,
    );
    expect(r.kept.length).toBeGreaterThanOrEqual(4);
    expect(r.reason).toBeNull();
  });

  it("preço subindo com y (eixo invertido) é recusado COM motivo", () => {
    const r = selectLabels(
      [rotulo(10, 137_000), rotulo(50, 139_000), rotulo(90, 141_000)],
      ALTURA,
      WIN,
    );
    // A maior cadeia decrescente tem 1 elemento: nao ha eixo de preco aqui.
    expect(r.kept.length).toBeLessThan(2);
    expect(r.directionOk).toBe(false);
    expect(r.reason).toContain("decrescente");
  });

  it("rótulo deslocado da reta é removido por resíduo, mantendo o resto", () => {
    const r = selectLabels(
      [
        rotulo(10, 139_500),
        rotulo(30, 139_000),
        rotulo(50, 138_400), // fora da reta (deveria ser 138.500)
        rotulo(70, 138_000),
        rotulo(90, 137_500),
      ],
      ALTURA,
      WIN,
    );
    expect(r.kept.length).toBeGreaterThanOrEqual(4);
    expect(r.regression!.r2).toBeGreaterThan(0.999);
  });
});

describe("régua percentual", () => {
  it("percentY fora de 0–100 é rejeitado, nunca clampado", () => {
    const r = selectLabels(
      [rotulo(-5, 140_000), rotulo(50, 139_000), rotulo(120, 138_000)],
      ALTURA,
      WIN,
    );
    const fora = r.labels.filter((l) => l.drop === "PERCENT_FORA_DA_REGUA");
    expect(fora.length).toBe(2);
    expect(fora.every((l) => !l.kept)).toBe(true);
  });

  it("y vem da régua, não do Y cru do modelo", () => {
    const r = selectLabels([rotulo(25, 139_000), rotulo(75, 138_000)], ALTURA, WIN);
    expect(r.labels[0]!.y).toBe(250);
    expect(r.labels[1]!.y).toBe(750);
  });
});

describe("formato brasileiro", () => {
  it("203.625 em WIN é 203625 pontos, não o decimal", () => {
    expect(normalizeBrPrice("203.625", WIN)).toBe(203_625);
  });

  it("preço já na faixa passa intacto", () => {
    expect(normalizeBrPrice("139500", WIN)).toBe(139_500);
  });

  it("decimal legítimo de ativo sem faixa não é adulterado", () => {
    expect(normalizeBrPrice("5.432,10", null)).toBeCloseTo(5_432.1, 4);
  });

  it("WDO com vírgula decimal sai correto", () => {
    expect(normalizeBrPrice("5.432,5", { min: 1_000, max: 20_000 })).toBeCloseTo(5_432.5, 4);
  });
});

describe("duplicatas e confiança", () => {
  it("dois rótulos na mesma linha: fica o de maior confiança", () => {
    const r = selectLabels(
      [rotulo(30, 139_000, 0.6), rotulo(30.5, 139_010, 0.95), rotulo(80, 138_000)],
      ALTURA,
      WIN,
    );
    const duplicado = r.labels.find((l) => l.drop === "DUPLICADO");
    expect(duplicado).toBeDefined();
    expect(duplicado!.confidence).toBe(0.6);
  });

  it("confiança modesta NÃO descarta: quem julga é a reta", () => {
    // Um modelo de visao menor reporta confianca baixa em rotulos legiveis. O
    // corte antigo (0.7) descartava todos ANTES da regressao.
    const r = selectLabels(
      [rotulo(10, 139_500, 0.45), rotulo(50, 139_000, 0.4), rotulo(90, 138_500, 0.42)],
      ALTURA,
      WIN,
    );
    expect(r.kept.length).toBe(3);
    expect(r.reason).toBeNull();
  });
});

describe("diagnóstico por rótulo", () => {
  it("todo rótulo descartado carrega o motivo", () => {
    const r = selectLabels(
      [rotulo(10, 139_500), rotulo(200, 139_400), rotulo(50, 141_000), rotulo(90, 138_000)],
      ALTURA,
      WIN,
    );
    for (const l of r.labels) {
      if (!l.kept) expect(l.drop).not.toBeNull();
    }
    expect(describeSelection(r)).toContain("aproveitados");
  });

  it("rótulos aproveitados trazem o resíduo contra a reta", () => {
    const r = selectLabels(
      [rotulo(10, 139_500), rotulo(50, 139_000), rotulo(90, 138_500)],
      ALTURA,
      WIN,
    );
    expect(r.kept.every((l) => l.residualPx !== null)).toBe(true);
  });
});

describe("status independentes por subsistema", () => {
  it("erro de escala NÃO derruba a GPU", () => {
    const s = subsystemStatus({
      requested: true,
      gpuReachable: true,
      captureUsable: true,
      scaleReady: false,
      scaleAttempts: 9,
      scaleConsecutiveFailures: 9,
      engineAnalyzing: true,
    });
    // Era exatamente isto que estava errado: a GPU respondia e o painel a
    // marcava OFFLINE porque o eixo estava ilegivel.
    expect(s.gpu).toBe("ONLINE");
    expect(s.scale).toBe("ERRO");
    expect(s.engine).toBe("ANALISANDO");
  });

  it("GPU nunca perguntada é DESCONHECIDA, nunca ONLINE", () => {
    expect(gpuStatusFrom(null)).toBe("DESCONHECIDO");
    expect(gpuStatusFrom(false)).toBe("OFFLINE");
    expect(gpuStatusFrom(true)).toBe("ONLINE");
  });

  it("tentar é RECALIBRANDO; ERRO só depois de insistir", () => {
    const base = {
      requested: true,
      gpuReachable: true,
      captureUsable: true,
      scaleReady: false,
      scaleAttempts: 1,
      engineAnalyzing: false,
    };
    expect(subsystemStatus({ ...base, scaleConsecutiveFailures: 1 }).scale).toBe("RECALIBRANDO");
    expect(
      subsystemStatus({ ...base, scaleConsecutiveFailures: SCALE_ERROR_AFTER_ATTEMPTS }).scale,
    ).toBe("ERRO");
  });

  it("sessão NÃO iniciada nunca acende captura verde", () => {
    // `isUsable` trata UNKNOWN (antes do primeiro frame) como utilizavel —
    // correto para o pipeline arrancar, errado como rotulo: o painel dizia
    // CAPTURA ONLINE com a leitura nem iniciada.
    const s = subsystemStatus({
      requested: false,
      gpuReachable: true,
      captureUsable: true,
      scaleReady: false,
      scaleAttempts: 0,
      scaleConsecutiveFailures: 0,
      engineAnalyzing: false,
    });
    expect(s.capture).toBe("OFFLINE");
    expect(s.engine).toBe("AGUARDANDO");
    // A GPU segue independente: ela responde, e isso e verdade.
    expect(s.gpu).toBe("ONLINE");
  });

  it("captura fora não impede a GPU de estar online", () => {
    const s = subsystemStatus({
      requested: true,
      gpuReachable: true,
      captureUsable: false,
      scaleReady: false,
      scaleAttempts: 0,
      scaleConsecutiveFailures: 0,
      engineAnalyzing: false,
    });
    expect(s.capture).toBe("OFFLINE");
    expect(s.gpu).toBe("ONLINE");
    expect(s.engine).toBe("AGUARDANDO");
  });
});

/**
 * VÃO VERTICAL — a reta precisa cobrir uma faixa real do eixo.
 *
 * Foi o estado visto ao vivo: "rótulos separados por só 16% da altura". Duas
 * âncoras próximas ajustam uma reta sobre 16% do gráfico e a EXTRAPOLAM para os
 * outros 84% — que é onde ficam os alvos. O R² não denuncia: ele mede o ajuste
 * onde há pontos, não onde não há.
 */
describe("vão vertical mínimo", () => {
  it("rótulos aglomerados no centro são recusados COM o motivo", () => {
    const r = selectLabels(
      [rotulo(45, 139_100), rotulo(50, 139_000), rotulo(55, 138_900)],
      ALTURA,
      WIN,
    );
    expect(r.kept.length).toBe(0);
    expect(r.reason).toContain("% da altura");
    expect(r.labels.every((l) => l.drop === "VAO_INSUFICIENTE")).toBe(true);
  });

  it("rótulos bem distribuídos passam", () => {
    const r = selectLabels(
      [rotulo(10, 139_500), rotulo(50, 139_000), rotulo(90, 138_500)],
      ALTURA,
      WIN,
    );
    expect(r.kept.length).toBe(3);
    expect(r.reason).toBeNull();
  });

  it("uma âncora sozinha nunca vira escala", () => {
    // Eixo invertido deixa a cadeia com um elemento; aceitar esse elemento
    // devolveria uma ancora solta, que nao define reta nenhuma.
    const r = selectLabels([rotulo(10, 100), rotulo(90, 101)], ALTURA, null);
    expect(r.kept.length).toBe(0);
  });
});

/**
 * O EIXO INTEIRO MULTIPLICADO POR MIL — visto ao vivo.
 *
 * O painel mostrou "R² 1.0000 · 10/10 âncoras · preços exatos liberados" e, ao
 * lado, publicou parcial de −119.957: um preço NEGATIVO, impossível.
 *
 * A causa era a normalização: um laço tentava ×1000, ×100, ×10, ÷1000… e
 * aceitava o primeiro fator que fizesse o número caber na faixa do contrato.
 * Um eixo lido como 263,70 virava 263700.
 *
 * E o R² não denuncia: multiplicar TODOS os rótulos pelo mesmo fator preserva a
 * linearidade perfeitamente. A métrica que deveria proteger ficava cega.
 */
describe("normalização não pode inventar escala", () => {
  it("decimal de duas casas NÃO vira milhar, mesmo fora da faixa", () => {
    // "263.70" tem duas casas: e decimal. Multiplicar seria inventar.
    expect(normalizeBrPrice("263.70", WIN)).toBeCloseTo(263.7, 4);
    expect(normalizeBrPrice("263.70", WIN)).not.toBe(263_700);
  });

  it("separador de milhar legítimo continua sendo corrigido", () => {
    // Tres digitos apos o separador: assinatura do milhar brasileiro.
    expect(normalizeBrPrice("203.625", WIN)).toBe(203_625);
    expect(normalizeBrPrice("139.500", WIN)).toBe(139_500);
  });

  it("nenhum fator arbitrário é aplicado para caber na faixa", () => {
    // 26 fora da faixa do WIN: ×1000 daria 26000 e "caberia". Mas o texto nao
    // justifica correcao nenhuma, entao o valor sai como foi lido.
    expect(normalizeBrPrice("26", WIN)).toBe(26);
    expect(normalizeBrPrice("4.5", WIN)).toBeCloseTo(4.5, 4);
  });

  it("um eixo fora do contrato sai fora — e a faixa recusa depois", () => {
    // O caso do print: eixo na casa das centenas com o ativo declarado WINFUT.
    const r = selectLabels(
      [rotulo(10, 0, 0.9), rotulo(50, 0, 0.9), rotulo(90, 0, 0.9)].map((l, i) => ({
        ...l,
        raw: ["398.65", "330.20", "263.70"][i]!,
      })),
      ALTURA,
      WIN,
    );
    // Nenhum valor foi inflado para caber: continuam nas centenas.
    for (const l of r.labels) expect(l.price).toBeLessThan(1_000);
  });
});
