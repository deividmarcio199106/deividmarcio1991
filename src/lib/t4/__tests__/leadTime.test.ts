import { describe, expect, it } from "vitest";

import {
  describeRejection,
  formatLead,
  leadTimes,
  markStage,
  newTimeline,
  type SetupTimeline,
} from "../leadTime";

const T0 = Date.UTC(2026, 2, 13, 13, 0, 0); // 13/03/2026, abertura

function observe(stage: Parameters<typeof markStage>[1]["stage"], offsetMs: number, extra = {}) {
  return {
    stage,
    marketTime: T0 + offsetMs,
    zone: null,
    stop: null,
    pendingTrigger: null,
    blockReason: null,
    ...extra,
  };
}

describe("antecedência da pré-entrada", () => {
  it("mede quanto tempo antes do gatilho a T4 avisou", () => {
    let t: SetupTimeline = newTimeline("s1", "COMPRA");
    t = markStage(t, observe("OBSERVANDO", 0));
    t = markStage(t, observe("PREPARANDO_COMPRA", 120_000));
    t = markStage(t, observe("ENTRADA_CONFIRMADA", 300_000));

    const lead = leadTimes(t);
    expect(lead.preEntryLeadTimeMs).toBe(180_000);
    expect(lead.candidateLeadTimeMs).toBe(180_000);
    expect(lead.warnedBeforeTrigger).toBe(true);
  });

  it("aviso no mesmo instante do gatilho NÃO conta como antecedência", () => {
    let t = newTimeline("s1", "VENDA");
    t = markStage(t, observe("PREPARANDO_VENDA", 300_000));
    t = markStage(t, observe("ENTRADA_CONFIRMADA", 300_000));
    expect(leadTimes(t).preEntryLeadTimeMs).toBe(0);
    expect(leadTimes(t).warnedBeforeTrigger).toBe(false);
  });

  it("sem confirmação não há antecedência — nulo, não zero", () => {
    let t = newTimeline("s1", "COMPRA");
    t = markStage(t, observe("PREPARANDO_COMPRA", 60_000));
    const lead = leadTimes(t);
    // Zero afirmaria "avisou no instante do gatilho"; nulo diz "nao houve gatilho".
    expect(lead.preEntryLeadTimeMs).toBeNull();
    expect(lead.warnedBeforeTrigger).toBe(false);
  });

  it("a primeira gravação vence — a história não é reescrita", () => {
    // Anti-lookahead: regravar deixaria uma observacao posterior mudar quando o
    // candidato "apareceu".
    let t = newTimeline("s1", "COMPRA");
    t = markStage(t, observe("PREPARANDO_COMPRA", 120_000));
    t = markStage(t, observe("PREPARANDO_COMPRA", 200_000));
    expect(t.preEntryAt).toBe(T0 + 120_000);
  });

  it("congela o plano do instante em que armou, não o de agora", () => {
    let t = newTimeline("s1", "VENDA");
    t = markStage(
      t,
      observe("PREPARANDO_VENDA", 120_000, {
        zone: { min: 179550, max: 179650 },
        stop: 179850,
        pendingTrigger: "rejeição + perda da mínima",
      }),
    );
    // Plano muda depois; o registro do armamento nao pode acompanhar.
    t = markStage(
      t,
      observe("GATILHO_PROXIMO", 240_000, {
        zone: { min: 179000, max: 179100 },
        stop: 179300,
      }),
    );
    expect(t.zoneAtArm).toEqual({ min: 179550, max: 179650 });
    expect(t.stopAtArm).toBe(179850);
    expect(t.triggerPendingAtArm).toBe("rejeição + perda da mínima");
  });

  it("GATILHO_PROXIMO também marca candidato e pré-entrada", () => {
    let t = newTimeline("s1", "COMPRA");
    t = markStage(t, observe("GATILHO_PROXIMO", 90_000));
    expect(t.candidateAt).toBe(T0 + 90_000);
    expect(t.preEntryAt).toBe(T0 + 90_000);
  });

  it("invalidação grava o instante e o motivo real", () => {
    let t = newTimeline("s1", "VENDA");
    t = markStage(t, observe("PREPARANDO_VENDA", 60_000));
    t = markStage(
      t,
      observe("INVALIDADA", 150_000, { blockReason: "STRUCTURE: estrutura perdida" }),
    );
    expect(t.invalidatedAt).toBe(T0 + 150_000);
    expect(t.blockReason).toContain("STRUCTURE");
    expect(leadTimes(t).warnedBeforeTrigger).toBe(false);
  });

  it("contexto é registrado antes do candidato", () => {
    let t = newTimeline("s1", null);
    t = markStage(t, observe("OBSERVANDO", 10_000));
    t = markStage(t, observe("OBSERVANDO", 20_000));
    expect(t.contextAt).toBe(T0 + 10_000);
  });

  it("formata a antecedência em linguagem de operador", () => {
    expect(formatLead(45_000)).toBe("45s antes");
    expect(formatLead(180_000)).toBe("3min 0s antes");
    expect(formatLead(null)).toBe("—");
    // Aviso depois do gatilho precisa gritar, nao virar numero negativo discreto.
    expect(formatLead(-5_000)).toBe("ATRASADO");
  });
});

describe("candidatos rejeitados", () => {
  it("explica por que morreu, distinguindo reprovado de incompleto", () => {
    const reprovado = describeRejection({
      setupId: "s1",
      direction: "COMPRA",
      candidateAt: T0,
      preEntryAt: T0 + 60_000,
      diedAt: T0 + 90_000,
      gates: [
        { id: "STRUCTURE", status: "FAIL", detail: "perdeu o fundo" },
        { id: "LIQUIDITY", status: "PASS", detail: "ok" },
      ],
      blockReason: "estrutura perdida antes do gatilho",
      wasArmed: true,
    });
    expect(reprovado).toContain("após armar");
    expect(reprovado).toContain("STRUCTURE");

    const incompleto = describeRejection({
      setupId: "s2",
      direction: "VENDA",
      candidateAt: T0,
      preEntryAt: null,
      diedAt: T0 + 30_000,
      gates: [{ id: "CONFIRMATION_CANDLE", status: "PENDING", detail: "aguardando" }],
      blockReason: "sessão encerrada",
      wasArmed: false,
    });
    expect(incompleto).toContain("antes de armar");
    expect(incompleto).toContain("nunca completou");
  });
});
