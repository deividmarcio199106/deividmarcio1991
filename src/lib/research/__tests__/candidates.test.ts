import { describe, expect, it } from "vitest";

import { DEFAULT_RISK_PARAMS } from "@/lib/engines/strategy";
import {
  BASELINE_ID,
  BASELINE_PARAMS,
  buildCandidates,
  DEFAULT_PARAM_SPACE,
  explainCandidateSpace,
  PARAM_SOURCE,
  toQuantOptions,
  UNSUPPORTED_PARAMS,
  type ParamSpace,
} from "../candidates";

/**
 * O QUE ESTES TESTES TRANCAM:
 *
 * 1. o baseline é a PRODUÇÃO e nunca é alterado nem gerado como candidata;
 * 2. a geração é DETERMINÍSTICA (nada de Math.random) e respeita o teto;
 * 3. toda candidata declara o que mudou — id opaco não é resposta;
 * 4. combinação aritmeticamente impossível não vira candidata;
 * 5. os parâmetros mapeiam para opções que o MOTOR realmente lê;
 * 6. os itens sem correspondente real ficam DECLARADOS como não suportados.
 *
 * Nenhum teste aqui afirma performance: candidata é hipótese, não resultado.
 */

describe("candidates — espaço de parâmetros da T4", () => {
  it("baseline é a produção: mesmos defaults do motor, imutável", () => {
    expect(BASELINE_ID).toBe("T4-PRODUCAO");
    // Os números NÃO são copiados à mão: vêm de DEFAULT_RISK_PARAMS.
    expect(BASELINE_PARAMS.stopMethod).toBe(DEFAULT_RISK_PARAMS.stopMethod);
    expect(BASELINE_PARAMS.partialTargetMultiple).toBe(DEFAULT_RISK_PARAMS.partialTargetMultiple);
    expect(BASELINE_PARAMS.finalTargetMultiple).toBe(DEFAULT_RISK_PARAMS.finalTargetMultiple);
    expect(BASELINE_PARAMS.maxStopDistance).toBe(DEFAULT_RISK_PARAMS.maxStopDistance);
  });

  it("geração é determinística — duas chamadas idênticas, inclusive sob o teto", () => {
    const a = buildCandidates(DEFAULT_PARAM_SPACE, 7);
    const b = buildCandidates(DEFAULT_PARAM_SPACE, 7);
    expect(b).toEqual(a);
    expect(a).toHaveLength(7);
    // O teto corta de verdade: o produto cartesiano é maior que 7.
    expect(explainCandidateSpace(DEFAULT_PARAM_SPACE, 7).validas).toBeGreaterThan(7);
  });

  it("teto explícito: limite 0 ou negativo não gera candidata nenhuma", () => {
    expect(buildCandidates(DEFAULT_PARAM_SPACE, 0)).toEqual([]);
    expect(buildCandidates(DEFAULT_PARAM_SPACE, -5)).toEqual([]);
  });

  it("nenhuma candidata é igual ao baseline, e todas dizem O QUE mudou", () => {
    const candidatas = buildCandidates(DEFAULT_PARAM_SPACE, 30);
    expect(candidatas.length).toBeGreaterThan(0);
    for (const candidata of candidatas) {
      expect(candidata.changedFrom.length).toBeGreaterThan(0);
      expect(candidata.resumo).not.toBe("");
      for (const mudanca of candidata.changedFrom) {
        // O que a tabela mostra tem de bater com o parâmetro de verdade.
        expect(String(candidata.params[mudanca.param])).toBe(mudanca.candidato);
        expect(String(BASELINE_PARAMS[mudanca.param])).toBe(mudanca.baseline);
        expect(candidata.params[mudanca.param]).not.toBe(BASELINE_PARAMS[mudanca.param]);
      }
    }
    // Ids únicos: duas linhas com o mesmo id seriam a mesma candidata na tabela.
    expect(new Set(candidatas.map((c) => c.id)).size).toBe(candidatas.length);
  });

  it("o baseline aparece no espaço mas NÃO vira candidata", () => {
    const conta = explainCandidateSpace(DEFAULT_PARAM_SPACE, 30);
    expect(conta.iguaisAoBaseline).toBe(1);
    const candidatas = buildCandidates(DEFAULT_PARAM_SPACE, 30);
    expect(candidatas.some((c) => c.id === BASELINE_ID)).toBe(false);
  });

  it("combinação impossível não vira candidata — alvo final aquém da parcial", () => {
    const espaco: ParamSpace = { partialTargetMultiple: [3], finalTargetMultiple: [2] };
    expect(buildCandidates(espaco, 10)).toEqual([]);
    const conta = explainCandidateSpace(espaco, 10);
    expect(conta.combinacoes).toBe(1);
    expect(conta.invalidas).toBe(1);
    expect(conta.validas).toBe(0);
  });

  it("eixo não declarado fica no baseline — o sweep não inventa valor", () => {
    const espaco: ParamSpace = { maxWaitBars: [5] };
    const [candidata] = buildCandidates(espaco, 10);
    expect(candidata).toBeDefined();
    expect(candidata!.params.maxWaitBars).toBe(5);
    expect(candidata!.params.stopMethod).toBe(BASELINE_PARAMS.stopMethod);
    expect(candidata!.params.partialTargetMultiple).toBe(BASELINE_PARAMS.partialTargetMultiple);
    expect(candidata!.changedFrom).toHaveLength(1);
  });

  it("parâmetros viram as opções que runQuantBacktest já entende", () => {
    const [candidata] = buildCandidates({ stopMethod: ["somente_atr"] }, 5);
    const opcoes = toQuantOptions(candidata!.params, "WINFUT");
    expect(opcoes.asset).toBe("WINFUT");
    expect(opcoes.minWindow).toBe(BASELINE_PARAMS.minWindow);
    expect(opcoes.maxWaitBars).toBe(BASELINE_PARAMS.maxWaitBars);
    expect(opcoes.riskParams).toEqual({
      stopMethod: "somente_atr",
      tickSize: BASELINE_PARAMS.tickSize,
      minStopDistance: BASELINE_PARAMS.minStopDistance,
      maxStopDistance: BASELINE_PARAMS.maxStopDistance,
      partialTargetMultiple: BASELINE_PARAMS.partialTargetMultiple,
      finalTargetMultiple: BASELINE_PARAMS.finalTargetMultiple,
    });
  });

  it("todo parâmetro suportado declara QUEM no motor o lê", () => {
    for (const chave of Object.keys(BASELINE_PARAMS) as (keyof typeof BASELINE_PARAMS)[]) {
      expect(PARAM_SOURCE[chave]).toBeTruthy();
    }
  });

  it("o que o motor NÃO expõe fica declarado como não suportado, com motivo", () => {
    const itens = UNSUPPORTED_PARAMS.map((u) => u.item);
    // Itens pedidos pelo operador que hoje são const de módulo, sem injeção.
    expect(itens).toContain("tolerância do toque");
    expect(itens).toContain("confirmação");
    expect(itens).toContain("rompimento");
    expect(itens).toContain("filtros estruturais");
    expect(itens).toContain("janela de horário");
    expect(itens).toContain("distância da linha / entrada");
    for (const item of UNSUPPORTED_PARAMS) {
      expect(item.motivo.length).toBeGreaterThan(20);
    }
    // E nenhum deles virou parâmetro fabricado no espaço de busca.
    const suportados = Object.keys(BASELINE_PARAMS);
    expect(suportados).not.toContain("janelaHorario");
    expect(suportados).not.toContain("toleranciaToque");
  });
});
