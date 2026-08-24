import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DEFAULT_RISK_PARAMS, MIN_RISK_REWARD } from "@/lib/engines/strategy";
import { MIN_RR } from "@/lib/t4/riskGate";

/**
 * PREGÃO SEM SEGUNDO MOTOR (auditoria sênior, BLOCO 3).
 *
 * O replay tinha 3 e 5 REDIGITADOS (alvos derivados, gate de espaço, gestão,
 * contrafactual) e somava resultado desconhecido como zero (`?? 0`). Estes
 * testes leem o FONTE de `pregao.ts` — de propósito: importar o módulo puxaria
 * o cliente de visão e o ffmpeg para dentro da suíte, e a pergunta aqui é
 * sobre o TEXTO do programa, não sobre seu comportamento (o comportamento
 * compartilhado — advanceSetup, assessTradeRisk, LiveOutcomeTracker — já tem
 * suíte própria).
 *
 * Se um literal voltar, este arquivo fica vermelho ANTES de a estatística do
 * vídeo divergir da produção.
 */

const FONTE = readFileSync("src/server/video/pregao.ts", "utf8");

describe("pregao.ts — constantes da técnica vêm da fonte única", () => {
  it("os múltiplos de alvo derivam de DEFAULT_RISK_PARAMS — nunca redigitados", () => {
    expect(FONTE).toContain("ALVO_PARCIAL_R = DEFAULT_RISK_PARAMS.partialTargetMultiple");
    expect(FONTE).toContain("ALVO_FINAL_R = DEFAULT_RISK_PARAMS.finalTargetMultiple");
    // Nenhum `risco * 3` / `risco * 5` literal sobrou no arquivo.
    expect(FONTE).not.toMatch(/risco\s*\*\s*[35](?![.\d])/);
    // O gate de espaço compara com o múltiplo, não com 3 cru.
    expect(FONTE).not.toMatch(/espacoReal\s*>=\s*3(?![.\d])/);
    expect(FONTE).toContain("espacoReal >= ALVO_PARCIAL_R");
    // O contrafactual também não carimba `rr: 3`.
    expect(FONTE).not.toMatch(/rr:\s*3(?![.\d])/);
  });

  it("resultado desconhecido NÃO soma zero — o ?? 0 de pontos/r está banido", () => {
    expect(FONTE).not.toMatch(/op\.pontos\s*\?\?\s*0/);
    expect(FONTE).not.toMatch(/op\.r\s*\?\?\s*0/);
    // A forma correta: somar só o que tem número; o resto já está declarado
    // em `semDesfecho`.
    expect(FONTE).toContain('if (typeof op.pontos === "number")');
    expect(FONTE).toContain('if (typeof op.r === "number")');
  });

  it("a decisão continua nos módulos compartilhados — não numa cópia local", () => {
    // Máquina de setup e gestão: as MESMAS do caminho de produção.
    expect(FONTE).toContain("advanceSetup(");
    expect(FONTE).toContain("LiveOutcomeTracker");
    // Nenhuma redefinição local de piso de R:R.
    expect(FONTE).not.toMatch(/MIN_RR\s*=/);
    expect(FONTE).not.toMatch(/MIN_RISK_REWARD\s*=/);
  });

  it("as fontes únicas continuam iguais entre si — riskGate reexporta strategy", () => {
    // O contrato que faz o guard acima valer alguma coisa: o piso é UM.
    expect(MIN_RR).toBe(MIN_RISK_REWARD);
    expect(DEFAULT_RISK_PARAMS.partialTargetMultiple).toBe(MIN_RISK_REWARD);
  });
});
