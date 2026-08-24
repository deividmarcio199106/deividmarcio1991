import { describe, expect, it } from "vitest";

import {
  aberturaNyEmMinutosSp,
  autorizarDataset,
  janelaNyEmSp,
  normalizarData,
} from "../datasetEnforcement";
import { marketClockGuard } from "../marketClockGuard";

/**
 * O PLANO CRONOLÓGICO VIROU GATE (auditoria sênior, BLOCO 9).
 *
 * Antes: o papel de cada mês era prosa no rules_json, `datasetSeen` era
 * escrito e nunca lido, nada impedia abrir o OOS sem freeze, e a janela de
 * NY era um horário BRT fixo — errado metade do ano desde que o Brasil
 * aboliu o horário de verão e os EUA não.
 */

const FREEZE_OK = { ok: true, motivo: null };
const FREEZE_VIOLADO = { ok: false, motivo: "hash divergente (teste)" };
const SEEN = ["MARCO"] as const;

describe("papel por mês e calendário B3", () => {
  it("cada mês do estudo tem o papel do comando; mês sem papel NÃO abre", () => {
    const abril = autorizarDataset({
      data: "2026-04-06",
      congelamento: FREEZE_OK,
      datasetSeen: SEEN,
    });
    expect(abril).toMatchObject({ allowed: true, value: { papel: "VALIDATION" } });
    const maio = autorizarDataset({
      data: "2026-05-04",
      congelamento: FREEZE_OK,
      datasetSeen: SEEN,
    });
    expect(maio).toMatchObject({ allowed: true, value: { papel: "WALK_FORWARD" } });
    const agosto = autorizarDataset({
      data: "2026-08-03",
      congelamento: FREEZE_OK,
      datasetSeen: SEEN,
    });
    expect(agosto.allowed).toBe(false);
    if (!agosto.allowed) expect(agosto.reason).toContain("papel");
  });

  it("fim de semana não é pregão — a data lida está errada", () => {
    // 04/04/2026 = sábado; 05/04/2026 = domingo (Páscoa).
    for (const dia of ["2026-04-04", "2026-04-05"]) {
      const veredito = autorizarDataset({ data: dia, congelamento: FREEZE_OK, datasetSeen: SEEN });
      expect(veredito.allowed).toBe(false);
      if (!veredito.allowed) expect(veredito.reason).toMatch(/sábado|domingo/);
    }
  });

  it("feriado B3 não é pregão — bloqueio com o NOME do feriado", () => {
    const sexta = autorizarDataset({
      data: "2026-04-03",
      congelamento: FREEZE_OK,
      datasetSeen: SEEN,
    });
    expect(sexta.allowed).toBe(false);
    if (!sexta.allowed) expect(sexta.reason).toContain("Sexta-feira Santa");
    const carnaval = autorizarDataset({
      data: "17/02/2026",
      congelamento: FREEZE_OK,
      datasetSeen: SEEN,
    });
    expect(carnaval.allowed).toBe(false);
    if (!carnaval.allowed) expect(carnaval.reason).toContain("Carnaval");
  });

  it("data ilegível ou fora de formato bloqueia — sem data não há papel", () => {
    for (const lixo of [null, "", "3/2/26", "2026-13-01x"]) {
      const veredito = autorizarDataset({
        data: lixo,
        congelamento: FREEZE_OK,
        datasetSeen: SEEN,
      });
      expect(veredito.allowed).toBe(false);
    }
  });

  it("normalizarData aceita o formato do OCR (dd/mm/yyyy) e o ISO", () => {
    expect(normalizarData("02/03/2026")).toBe("2026-03-02");
    expect(normalizarData("2026-03-02")).toBe("2026-03-02");
    expect(normalizarData("2/3/2026")).toBeNull();
  });
});

describe("datasetSeen LIDO de verdade — contaminação não é opinião", () => {
  it("março (visto no desenho) NÃO abre sem declaração de uso como referência", () => {
    const bloqueado = autorizarDataset({
      data: "02/03/2026",
      congelamento: FREEZE_OK,
      datasetSeen: SEEN,
    });
    expect(bloqueado.allowed).toBe(false);
    if (!bloqueado.allowed) expect(bloqueado.reason).toContain("datasetSeen");
  });

  it("com usoComoReferencia:true março abre COMO REFERÊNCIA — nunca validação", () => {
    const referencia = autorizarDataset({
      data: "02/03/2026",
      congelamento: FREEZE_OK,
      datasetSeen: SEEN,
      usoComoReferencia: true,
    });
    expect(referencia).toMatchObject({
      allowed: true,
      value: { papel: "REFERENCIA_CONTAMINADA" },
    });
  });
});

describe("OOS FINAL SELADO — só com congelamento verificado", () => {
  it("julho ANTES do freeze verificado = bloqueio explícito com o motivo do freeze", () => {
    const bloqueado = autorizarDataset({
      data: "2026-07-01",
      congelamento: FREEZE_VIOLADO,
      datasetSeen: SEEN,
    });
    expect(bloqueado.allowed).toBe(false);
    if (!bloqueado.allowed) {
      expect(bloqueado.reason).toContain("OOS FINAL SELADO");
      expect(bloqueado.reason).toContain("hash divergente (teste)");
    }
  });

  it("julho DEPOIS do freeze verificado abre com o papel selado", () => {
    const aberto = autorizarDataset({
      data: "2026-07-01",
      congelamento: FREEZE_OK,
      datasetSeen: SEEN,
    });
    expect(aberto).toMatchObject({ allowed: true, value: { papel: "OOS_FINAL_SELADO" } });
  });

  it("o freeze violado NÃO contamina os papéis que não são OOS", () => {
    const abril = autorizarDataset({
      data: "2026-04-06",
      congelamento: FREEZE_VIOLADO,
      datasetSeen: SEEN,
    });
    expect(abril.allowed).toBe(true);
  });
});

describe("abertura de NY pelo fuso REAL — nunca BRT fixo", () => {
  it("verão de NY (EDT): 09:30 NY = 10:30 em São Paulo", () => {
    expect(aberturaNyEmMinutosSp("2026-07-06")).toBe(10 * 60 + 30);
  });

  it("inverno de NY (EST): 09:30 NY = 11:30 em São Paulo — a hora que o fixo errava", () => {
    expect(aberturaNyEmMinutosSp("2026-02-02")).toBe(11 * 60 + 30);
  });

  it("a virada do horário de verão dos EUA (08/03/2026) muda a janela de um dia para o outro", () => {
    // Sexta 06/03 ainda EST; segunda 09/03 já EDT.
    expect(aberturaNyEmMinutosSp("2026-03-06")).toBe(11 * 60 + 30);
    expect(aberturaNyEmMinutosSp("2026-03-09")).toBe(10 * 60 + 30);
  });

  it("marketClockGuard consome a janela da DATA: 11:35 é NY no inverno, pregão comum no default", () => {
    const inverno = janelaNyEmSp("2026-02-02");
    const guardComData = marketClockGuard(11 * 60 + 35, inverno);
    expect(guardComData.window).toBe("ALTA_LIQUIDEZ");
    // O default (histórico, 10:30 fixo) não reconhece 11:35 — é exatamente o
    // que muda quando o chamador passa a janela derivada da data.
    const guardFixo = marketClockGuard(11 * 60 + 35);
    expect(guardFixo.window).toBe("PREGAO");
  });
});
