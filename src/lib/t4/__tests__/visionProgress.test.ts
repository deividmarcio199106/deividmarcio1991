import { describe, expect, it } from "vitest";

import { visionT4Progress } from "../engineState";

/**
 * DOIS DEFEITOS, A MESMA CAUSA: um numero de progresso que nao media o que o
 * operador lia nele.
 *
 * O degrau de 90% media "os gates foram avaliados" — verdadeiro assim que o
 * motor roda uma vez. E mesmo depois de removido, um 80% no numero grande
 * continuava sendo lido como "falta algo para o sistema funcionar", quando o
 * que faltava era OPORTUNIDADE — do mercado, nao do software.
 *
 * Agora este numero responde UMA pergunta: o pipeline entrega leitura
 * utilizavel? Sim ou nao.
 */

const PIPELINE_PRONTO = {
  captureActive: true,
  chartVisible: true,
  candlesParsed: true,
  historyReady: true,
  structureRead: true,
  liquidityMapped: true,
  confirmed: false,
};

describe("pipeline funcional — 0 ou 100", () => {
  it("pipeline pronto e 100%, mesmo sem setup nenhum", () => {
    const p = visionT4Progress(PIPELINE_PRONTO);
    expect(p.percent).toBe(100);
    expect(p.functional).toBe(true);
    expect(p.label).toBe("PIPELINE FUNCIONAL");
  });

  it("nunca existe valor intermediario", () => {
    const combinacoes = [
      PIPELINE_PRONTO,
      { ...PIPELINE_PRONTO, confirmed: true },
      { ...PIPELINE_PRONTO, liquidityMapped: false },
      { ...PIPELINE_PRONTO, structureRead: false },
      { ...PIPELINE_PRONTO, historyReady: false },
      { ...PIPELINE_PRONTO, captureActive: false },
    ];
    for (const c of combinacoes) {
      expect([0, 100]).toContain(visionT4Progress(c).percent);
    }
  });

  it("qualquer degrau faltando derruba para 0", () => {
    expect(visionT4Progress({ ...PIPELINE_PRONTO, liquidityMapped: false }).percent).toBe(0);
    expect(visionT4Progress({ ...PIPELINE_PRONTO, captureActive: false }).percent).toBe(0);
  });

  it("a CONFIRMACAO da tecnica nao entra na conta do funcional", () => {
    // Um pregao inteiro sem setup mantem o sistema 100% funcional: a ausencia
    // de oportunidade e do mercado, e ja tem seu numero na maturidade.
    expect(visionT4Progress(PIPELINE_PRONTO).functional).toBe(true);
    expect(visionT4Progress({ ...PIPELINE_PRONTO, confirmed: true }).functional).toBe(true);
  });

  it("diz o que falta enquanto nao esta funcional", () => {
    expect(visionT4Progress({ ...PIPELINE_PRONTO, historyReady: false }).next).toContain(
      "HISTÓRICO",
    );
    expect(visionT4Progress(PIPELINE_PRONTO).next).toContain("AGUARDANDO SETUP");
  });

  it("os degraus do pipeline continuam contados para o detalhe", () => {
    expect(visionT4Progress(PIPELINE_PRONTO).stepsDone).toBe(6);
    expect(visionT4Progress(PIPELINE_PRONTO).stepsTotal).toBe(6);
    expect(visionT4Progress({ ...PIPELINE_PRONTO, liquidityMapped: false }).stepsDone).toBe(5);
  });
});
