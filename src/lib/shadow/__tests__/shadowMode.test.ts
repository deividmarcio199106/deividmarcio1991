import { describe, expect, it } from "vitest";

import {
  BASELINE_VERSION_ID,
  compareShadow,
  MARGEM_EQUIVALENCIA_R,
  MIN_SHADOW_SAMPLE,
  podePromover,
  recordShadowDecision,
  type ShadowDecision,
  type ShadowOutcome,
} from "../shadowMode";

/**
 * O shadow existe para responder "a candidata seria melhor?" SEM tocar na
 * operação. Estes testes trancam as três leis: nada aqui emite ordem, amostra
 * pequena nunca conclui, e a promoção continua sendo decisão humana.
 */

const T0 = Date.UTC(2026, 7, 19, 13, 0, 0);
const CANDIDATA = "T4-CANDIDATA-01";

function decisao(versionId: string, i: number, over: Partial<ShadowDecision> = {}): ShadowDecision {
  return recordShadowDecision({
    at: T0 + i * 60_000,
    versionId,
    wouldEnter: true,
    direction: "COMPRA",
    entry: 169_500,
    stop: 169_300,
    target: 169_900,
    reason: "gatilho da técnica",
    ...over,
  });
}

/** N decisões de uma versão, com desfecho fixo em R. */
function serie(versionId: string, n: number, resultR: number) {
  const decisions: ShadowDecision[] = [];
  const outcomes: ShadowOutcome[] = [];
  for (let i = 0; i < n; i += 1) {
    decisions.push(decisao(versionId, i));
    outcomes.push({ at: T0 + i * 60_000, versionId, resultR });
  }
  return { decisions, outcomes };
}

describe("registro — o que não é executável não vira entrada", () => {
  it("entrada sem preço/stop é REBAIXADA, e o motivo original sobrevive", () => {
    const d = decisao(CANDIDATA, 0, { entry: null, stop: null, reason: "achei que dava" });
    expect(d.wouldEnter).toBe(false);
    expect(d.reason).toContain("achei que dava");
  });

  it("direção NEUTRO não entra", () => {
    expect(decisao(CANDIDATA, 0, { direction: "NEUTRO" }).wouldEnter).toBe(false);
  });

  it("decisão completa é preservada como entrada", () => {
    const d = decisao(CANDIDATA, 0);
    expect(d.wouldEnter).toBe(true);
    expect(d.versionId).toBe(CANDIDATA);
  });

  it("o tipo não carrega nada de execução — shadow não dispara ordem", () => {
    const d = decisao(CANDIDATA, 0);
    expect(Object.keys(d).sort()).toEqual(
      ["at", "direction", "entry", "reason", "stop", "target", "versionId", "wouldEnter"].sort(),
    );
  });
});

describe("comparação — amostra pequena nunca conclui", () => {
  it("abaixo da amostra mínima o veredito é SEM_AMOSTRA, mesmo com candidata voando", () => {
    const base = serie(BASELINE_VERSION_ID, 5, -0.5);
    const cand = serie(CANDIDATA, 5, 3);
    const c = compareShadow(base.decisions, cand.decisions, [...base.outcomes, ...cand.outcomes]);
    expect(c.verdict).toBe("SEM_AMOSTRA");
    expect(c.note).toContain("conclusão NÃO autorizada");
    expect(podePromover(c)).toBe(false);
  });

  it("amostra suficiente só de UM lado ainda é SEM_AMOSTRA", () => {
    const base = serie(BASELINE_VERSION_ID, MIN_SHADOW_SAMPLE, 0.2);
    const cand = serie(CANDIDATA, 3, 2);
    const c = compareShadow(base.decisions, cand.decisions, [...base.outcomes, ...cand.outcomes]);
    expect(c.verdict).toBe("SEM_AMOSTRA");
  });

  it("entradas SEM desfecho não entram na amostra", () => {
    const base = serie(BASELINE_VERSION_ID, MIN_SHADOW_SAMPLE, 0.3);
    const cand = serie(CANDIDATA, MIN_SHADOW_SAMPLE, 0.9);
    // Nenhum desfecho da candidata é apurado: ela fica pendente.
    const c = compareShadow(base.decisions, cand.decisions, base.outcomes);
    expect(c.candidate.sample).toBe(0);
    expect(c.candidate.pending).toBe(MIN_SHADOW_SAMPLE);
    expect(c.candidate.expectancyR).toBeNull();
    expect(c.verdict).toBe("SEM_AMOSTRA");
  });
});

describe("comparação — veredito com amostra suficiente", () => {
  const n = MIN_SHADOW_SAMPLE;

  it("candidata claramente melhor: CANDIDATA_MELHOR e promoção liberada", () => {
    const base = serie(BASELINE_VERSION_ID, n, 0.1);
    const cand = serie(CANDIDATA, n, 0.8);
    const c = compareShadow(base.decisions, cand.decisions, [...base.outcomes, ...cand.outcomes]);
    expect(c.verdict).toBe("CANDIDATA_MELHOR");
    expect(podePromover(c)).toBe(true);
    // Mesmo liberando, a nota deixa claro que quem promove é humano.
    expect(c.note).toContain("decisão humana");
  });

  it("baseline melhor: BASELINE_MELHOR e promoção negada", () => {
    const base = serie(BASELINE_VERSION_ID, n, 0.9);
    const cand = serie(CANDIDATA, n, 0.1);
    const c = compareShadow(base.decisions, cand.decisions, [...base.outcomes, ...cand.outcomes]);
    expect(c.verdict).toBe("BASELINE_MELHOR");
    expect(podePromover(c)).toBe(false);
  });

  it("diferença dentro da margem é EQUIVALENTES — ruído não promove", () => {
    const base = serie(BASELINE_VERSION_ID, n, 0.5);
    const cand = serie(CANDIDATA, n, 0.5 + MARGEM_EQUIVALENCIA_R / 2);
    const c = compareShadow(base.decisions, cand.decisions, [...base.outcomes, ...cand.outcomes]);
    expect(c.verdict).toBe("EQUIVALENTES");
    expect(podePromover(c)).toBe(false);
  });
});

describe("divergências — o operador vê onde as versões discordam", () => {
  it("mesmo instante com decisões opostas vira divergência listada", () => {
    const base = [decisao(BASELINE_VERSION_ID, 0)];
    const cand = [decisao(CANDIDATA, 0, { wouldEnter: false, reason: "filtro de horário barrou" })];
    const c = compareShadow(base, cand, []);
    expect(c.divergences).toHaveLength(1);
    expect(c.divergences[0]!.at).toBe(T0);
    expect(c.divergences[0]!.note.length).toBeGreaterThan(0);
  });

  it("decisões idênticas não geram ruído na lista", () => {
    const c = compareShadow([decisao(BASELINE_VERSION_ID, 0)], [decisao(CANDIDATA, 0)], []);
    expect(c.divergences).toHaveLength(0);
  });
});

describe("gate de promoção — a última porta antes do humano", () => {
  it("veredito bom com amostra adulterada para baixo NÃO promove", () => {
    const n = MIN_SHADOW_SAMPLE;
    const base = serie(BASELINE_VERSION_ID, n, 0.1);
    const cand = serie(CANDIDATA, n, 0.8);
    const c = compareShadow(base.decisions, cand.decisions, [...base.outcomes, ...cand.outcomes]);
    // O gate refaz a conta de amostra em vez de confiar no veredito.
    const adulterado = { ...c, candidate: { ...c.candidate, sample: 2 } };
    expect(c.verdict).toBe("CANDIDATA_MELHOR");
    expect(podePromover(adulterado)).toBe(false);
  });
});
