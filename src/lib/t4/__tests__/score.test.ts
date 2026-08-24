import { describe, expect, it } from "vitest";

import { scoreT4 } from "../score";
import {
  deriveEntryDecision,
  validatePrintAnalysis,
  type PrintAnalysis,
} from "@/lib/vision/printAnalysis";

/**
 * As análises destes testes passam pelo VALIDADOR real antes de virar entrada
 * do score. É de propósito: montar o objeto na mão deixaria passar combinações
 * que a produção nunca produz (status confirmado sem níveis, por exemplo), e o
 * teste passaria a provar algo sobre um mundo que não existe.
 */
function analise(raw: Record<string, unknown>): PrintAnalysis {
  const base = {
    status: "T4_EM_FORMACAO",
    direction: "NEUTRO",
    confidence: 0,
    symbol: "WINFUT",
    timeframe: "1Min",
    entry: { value: null, visible: false },
    stop: { value: null, visible: false },
    targets: [],
    ...raw,
  };
  const resultado = validatePrintAnalysis(base);
  if (!resultado.ok || resultado.analysis === null) {
    throw new Error(`fixture inválida para o contrato: ${resultado.problem}`);
  }
  return resultado.analysis;
}

/** Análise mínima: nada legível, nada avaliado — o pior caso honesto. */
const VAZIA = (): PrintAnalysis => analise({ status: "INCONCLUSIVO" });

/**
 * Análise que atende TUDO o que o score sabe medir, com níveis coerentes e
 * R:R 4,0 — usada para provar que score cheio não é permissão de operar.
 */
const COMPLETA = (over: Record<string, unknown> = {}): PrintAnalysis =>
  analise({
    status: "ENTRADA_CONFIRMADA",
    direction: "COMPRA",
    confidence: 90,
    entry: { value: 170000, visible: true },
    stop: { value: 169900, visible: true },
    targets: [{ value: 170400, visible: true }],
    criteria: [
      { id: "CONTEXT", label: "Contexto", met: true, detail: "tendência de alta definida" },
      { id: "STRUCTURE", label: "Estrutura", met: true, detail: "topos e fundos ascendentes" },
      { id: "LOCATION", label: "Localização", met: true, detail: "no suporte" },
      { id: "LIQUIDITY", label: "Liquidez", met: true, detail: "fundo anterior" },
      { id: "REACTION", label: "Reação", met: true, detail: "reação na região" },
      {
        id: "STRUCTURE_SHIFT",
        label: "Mudança de estrutura",
        met: true,
        detail: "micro rompimento",
      },
      { id: "POI_RETEST", label: "POI + reteste", met: true, detail: "voltou à região" },
      {
        id: "CONFIRMATION_CANDLE",
        label: "Candle de confirmação",
        met: true,
        detail: "fechou acima",
      },
      { id: "STOP_VALID", label: "Stop válido", met: true, detail: "abaixo do fundo" },
      { id: "RISK_REWARD", label: "Risco/retorno", met: true, detail: "4x o risco" },
    ],
    confidences: { contexto: 90, estrutura: 90, t4: 90, entrada: 90 },
    dna: {
      grade: "A",
      trend: "FORTE",
      position: "A_FAVOR",
      pullback: "LIMPO",
      triggerCandle: "FECHAMENTO",
      volatility: "NORMAL",
      location: "SUPORTE",
      movementOrdinal: 1,
    },
    ...over,
  });

describe("scoreT4 — invariantes do número", () => {
  it("os pesos dos componentes somam 100", () => {
    const soma = scoreT4(VAZIA()).components.reduce((s, c) => s + c.weight, 0);
    expect(soma).toBe(100);
  });

  it("o total é EXATAMENTE a soma dos earned, e cada earned cabe no seu peso", () => {
    for (const alvo of [VAZIA(), COMPLETA(), COMPLETA({ confidence: 30 })]) {
      const score = scoreT4(alvo);
      const soma = score.components.reduce((s, c) => s + c.earned, 0);
      expect(score.total).toBe(soma);
      expect(score.total).toBeGreaterThanOrEqual(0);
      expect(score.total).toBeLessThanOrEqual(100);
      for (const c of score.components) {
        expect(c.earned).toBeGreaterThanOrEqual(0);
        expect(c.earned).toBeLessThanOrEqual(c.weight);
      }
    }
  });

  it("é determinístico: a mesma análise devolve o mesmo score", () => {
    const alvo = COMPLETA();
    expect(scoreT4(alvo)).toEqual(scoreT4(alvo));
    expect(scoreT4(COMPLETA())).toEqual(scoreT4(COMPLETA()));
  });
});

describe("scoreT4 — ausência é um valor", () => {
  it("análise vazia dá score baixo com TODOS os detalhes preenchidos", () => {
    const score = scoreT4(VAZIA());
    expect(score.total).toBeLessThanOrEqual(10);
    for (const c of score.components) {
      expect(c.detail.trim().length).toBeGreaterThan(0);
    }
    expect(score.note.trim().length).toBeGreaterThan(0);
  });

  it("componente sem base fica em 0 SEM penalizar, e diz que não é avaliável", () => {
    const score = scoreT4(VAZIA());
    const semBase = score.components.filter((c) => c.detail.startsWith("NÃO AVALIÁVEL"));
    // Contexto, estrutura, localização, reteste, candle e R:R não têm fonte
    // alguma numa análise vazia; leitura tem (a confiança visual é obrigatória).
    expect(semBase.length).toBe(6);
    for (const c of semBase) {
      expect(c.earned).toBe(0);
      expect(c.penalty).toBe(false);
      expect(c.detail).toContain("NÃO AVALIÁVEL NESTA IMAGEM");
    }
  });

  it("candle não encontrado NÃO penaliza o score — mas a trava continua barrando", () => {
    const semCandle = COMPLETA({
      status: "T4_EM_FORMACAO",
      criteria: [{ id: "CONTEXT", label: "Contexto", met: true, detail: "alta" }],
      dna: {
        grade: "B",
        trend: "NORMAL",
        position: "A_FAVOR",
        pullback: "NAO_IDENTIFICADO",
        triggerCandle: "NAO_IDENTIFICADO",
        volatility: null,
        location: "NAO_IDENTIFICADO",
        movementOrdinal: null,
      },
    });
    const candle = scoreT4(semCandle).components.find((c) => c.id === "candle");
    expect(candle?.earned).toBe(0);
    expect(candle?.penalty).toBe(false);
    expect(candle?.detail).toContain("NÃO AVALIÁVEL");
    expect(deriveEntryDecision(semCandle).entradaConfirmada).toBe(false);
  });
});

describe("scoreT4 — o score NÃO substitui a regra obrigatória", () => {
  it("score alto NÃO libera entrada: entradaConfirmada espelha a trava", () => {
    /*
     * O caso que este teste existe para congelar: todos os critérios T4
     * atendidos, DNA cheio, R:R 4,0 e confiança 90 — e a trava recusando
     * porque as confianças por camada não foram reportadas. O número pode ser
     * alto; a permissão não vem dele.
     */
    const alta = COMPLETA({ confidences: null });
    const score = scoreT4(alta);

    expect(score.total).toBeGreaterThanOrEqual(80);
    expect(score.entradaConfirmada).toBe(false);
    expect(score.entradaConfirmada).toBe(deriveEntryDecision(alta).entradaConfirmada);
    expect(score.note).toContain("O SCORE NÃO AUTORIZA OPERAÇÃO");
  });

  it("entradaConfirmada é sempre o espelho de deriveEntryDecision, nos dois sentidos", () => {
    const liberada = COMPLETA();
    expect(deriveEntryDecision(liberada).entradaConfirmada).toBe(true);
    expect(scoreT4(liberada).entradaConfirmada).toBe(true);
    expect(scoreT4(liberada).note).toContain("nunca a permissão");

    for (const alvo of [VAZIA(), COMPLETA({ confidences: null }), COMPLETA({ confidence: 20 })]) {
      expect(scoreT4(alvo).entradaConfirmada).toBe(deriveEntryDecision(alvo).entradaConfirmada);
    }
  });

  it("SCORE 100 com entradaConfirmada=false continua PROIBINDO operar", () => {
    /*
     * O teto do score é alcançável: todos os critérios T4 atendidos, DNA
     * cheio, R:R 4,0, leitura visual 100 e as quatro confianças em 100. E o
     * status é PRÉ-ENTRADA — o print não sustenta confirmação. Nenhum
     * componente sabe disso, e é essa a questão: a nota chega a 100 e a
     * entrada continua barrada, porque quem decide não é o score.
     */
    const cheio = COMPLETA({
      status: "PRE_ENTRADA",
      confidence: 100,
      confidences: { contexto: 100, estrutura: 100, t4: 100, entrada: 100 },
    });
    const score = scoreT4(cheio);

    expect(score.total).toBe(100);
    expect(score.penalties).toEqual([]);
    expect(score.entradaConfirmada).toBe(false);
    expect(score.entradaConfirmada).toBe(deriveEntryDecision(cheio).entradaConfirmada);
    expect(score.note).toContain("O SCORE NÃO AUTORIZA OPERAÇÃO");
  });

  it("o teto só fecha com leitura perfeita — 90% de confiança visual custa ponto", () => {
    // Mesma análise, leitura visual 90: a parcela LEITURA vale 0,9 do peso 12
    // (round(10,8) = 11) e o total para em 99. O score não arredonda para cima
    // uma imagem que a própria análise disse não ter lido com perfeição.
    const score = scoreT4(COMPLETA());
    expect(score.total).toBe(99);
    expect(score.components.find((c) => c.id === "leitura")?.earned).toBe(11);
    expect(score.penalties).toEqual([]);
  });
});

describe("scoreT4 — cada penalização aparece com motivo", () => {
  it("critério NÃO atendido penaliza o componente certo e entra em penalties", () => {
    const score = scoreT4(
      COMPLETA({
        status: "T4_EM_FORMACAO",
        criteria: [
          { id: "CONTEXT", label: "Contexto", met: false, detail: "regime indefinido" },
          { id: "STRUCTURE", label: "Estrutura", met: true, detail: "legível" },
        ],
      }),
    );
    const contexto = score.components.find((c) => c.id === "contexto");
    expect(contexto?.penalty).toBe(true);
    expect(contexto?.detail).toContain("NÃO atendido");
    expect(score.penalties.some((p) => p.includes("regime indefinido"))).toBe(true);
    // Estrutura foi atendida: não pode aparecer como penalização.
    expect(score.penalties.some((p) => p.startsWith("ESTRUTURA:"))).toBe(false);
  });

  it("missingCriteria vira penalização quando o componente não tem critério próprio", () => {
    const score = scoreT4(
      COMPLETA({
        status: "T4_EM_FORMACAO",
        criteria: [{ id: "CONTEXT", label: "Contexto", met: true, detail: "alta" }],
        missingCriteria: ["Estrutura ilegível: topos e fundos não organizados"],
      }),
    );
    const estrutura = score.components.find((c) => c.id === "estrutura");
    expect(estrutura?.penalty).toBe(true);
    expect(estrutura?.detail).toContain("listou como AUSENTE");
    expect(score.penalties.some((p) => p.includes("topos e fundos não organizados"))).toBe(true);
  });

  it("R:R abaixo do mínimo da casa zera a parcela de risco e diz por quê", () => {
    const score = scoreT4(
      COMPLETA({
        status: "T4_EM_FORMACAO",
        entry: { value: 170000, visible: true },
        stop: { value: 169900, visible: true },
        // Alvo a 100 pontos com risco de 100 pontos: R:R 1,0, abaixo de 1,5.
        targets: [{ value: 170100, visible: true }],
        criteria: [{ id: "CONTEXT", label: "Contexto", met: true, detail: "alta" }],
      }),
    );
    const rr = score.components.find((c) => c.id === "rr");
    expect(rr?.earned).toBe(0);
    expect(rr?.penalty).toBe(true);
    expect(rr?.detail).toContain("abaixo do mínimo");
    expect(score.penalties.some((p) => p.includes("R:R 1.00"))).toBe(true);
  });

  it("tendência CONTRA no DNA penaliza o contexto com o motivo dito", () => {
    const score = scoreT4(
      COMPLETA({
        status: "T4_EM_FORMACAO",
        criteria: [],
        confidences: null,
        dna: {
          grade: "C",
          trend: "CONTRA",
          position: "CONTRA_TENDENCIA",
          pullback: "NAO_IDENTIFICADO",
          triggerCandle: "NAO_IDENTIFICADO",
          volatility: null,
          location: "NAO_IDENTIFICADO",
          movementOrdinal: null,
        },
      }),
    );
    const contexto = score.components.find((c) => c.id === "contexto");
    expect(contexto?.earned).toBe(0);
    expect(contexto?.penalty).toBe(true);
    expect(score.penalties.some((p) => p.includes("contra a tendência instalada"))).toBe(true);
  });

  it("problema de imagem e auditor reprovando penalizam a leitura", () => {
    const score = scoreT4(
      COMPLETA({
        status: "T4_EM_FORMACAO",
        confidence: 40,
        imageIssues: ["print cortado na escala"],
        audit: { approved: false, issues: ["direção incoerente com a estrutura"], checkedAt: 1 },
      }),
    );
    const leitura = score.components.find((c) => c.id === "leitura");
    /*
     * Média ponderada da parcela: confiança 40% (peso 1) contra problema de
     * imagem (peso 2) e auditor reprovando (peso 2), ambos valendo 0 →
     * 0,4/5 = 0,08 → round(12 × 0,08) = 1. A parcela desaba mas não é zerada
     * por decreto: o valor continua sendo a soma da evidência, e os dois
     * motivos aparecem escritos.
     */
    expect(leitura?.earned).toBe(1);
    expect(leitura?.penalty).toBe(true);
    expect(score.penalties.some((p) => p.includes("print cortado na escala"))).toBe(true);
    expect(score.penalties.some((p) => p.includes("auditor REPROVOU"))).toBe(true);
  });

  it("toda penalização tem componente com penalty=true — e nenhuma sobra sem motivo", () => {
    const score = scoreT4(
      COMPLETA({
        status: "T4_EM_FORMACAO",
        confidence: 30,
        criteria: [{ id: "CONTEXT", label: "Contexto", met: false, detail: "indefinido" }],
      }),
    );
    const penalizados = score.components.filter((c) => c.penalty);
    expect(score.penalties.length).toBe(penalizados.length);
    for (const p of score.penalties) {
      expect(p.trim().length).toBeGreaterThan(0);
      expect(p).toContain(":");
    }
  });
});

describe("scoreT4 — lastro: nada pontua sem fonte na análise", () => {
  it("critério fora do vocabulário T4 não pontua e é declarado na nota", () => {
    const score = scoreT4(
      COMPLETA({
        status: "T4_EM_FORMACAO",
        criteria: [{ id: "ASTROLOGIA", label: "Fase da lua", met: true, detail: "cheia" }],
        confidences: null,
        dna: null,
      }),
    );
    expect(score.note).toContain("fora do vocabulário T4");
    for (const c of score.components) {
      if (c.id !== "leitura" && c.id !== "rr") {
        expect(c.earned).toBe(0);
        expect(c.detail).toContain("NÃO AVALIÁVEL");
      }
    }
  });

  it("confiança por camada sozinha pontua parcialmente — autoavaliação não fecha a parcela", () => {
    const score = scoreT4(
      COMPLETA({
        status: "T4_EM_FORMACAO",
        criteria: [],
        dna: null,
        confidences: { contexto: 100, estrutura: 100, t4: 100, entrada: 100 },
      }),
    );
    const contexto = score.components.find((c) => c.id === "contexto");
    const estrutura = score.components.find((c) => c.id === "estrutura");
    expect(contexto?.earned).toBe(contexto?.weight);
    expect(estrutura?.earned).toBe(estrutura?.weight);
    // Localização e reteste não têm confiança própria no contrato: continuam
    // não avaliáveis, sem ganhar nada por tabela.
    expect(score.components.find((c) => c.id === "localizacao")?.earned).toBe(0);
    expect(score.components.find((c) => c.id === "reteste")?.earned).toBe(0);
  });
});
