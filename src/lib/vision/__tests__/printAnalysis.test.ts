import { describe, expect, it } from "vitest";

import {
  applyConfirmationGate,
  deriveEntryDecision,
  formatRead,
  NAO_IDENTIFICADO,
  NAO_LEGIVEL,
  PRINT_STATUS,
  validatePrintAnalysis,
  type PrintAnalysis,
} from "../printAnalysis";
import { auditModeFor } from "@/services/ai/chartVision";

/**
 * A ANÁLISE DE PRINT NÃO TEM CONFERÊNCIA GEOMÉTRICA.
 *
 * No OCR da escala, a régua confere o resultado: uma reta com R² alto prova que
 * os rótulos são consistentes. Aqui o modelo descreve ESTRUTURA, e não existe
 * teste posterior que diga "esta leitura de topo está certa".
 *
 * Por isso a defesa não é conferir o resultado — é restringir o que pode ser
 * AFIRMADO. Estes testes trancam essa restrição.
 */

function base(): PrintAnalysis {
  return {
    status: "SEM_T4",
    direction: "NEUTRO",
    confidence: 50,
    symbol: null,
    timeframe: null,
    // Campos do ciclo de vida do candle: o fixture-padrao nao le relogio nem
    // candle fechado — quem testa isso preenche explicitamente.
    chartClock: { date: null, time: null },
    lastClosedCandle: null,
    currentPrice: { value: null, visible: false },
    entry: { value: null, visible: false },
    entryZone: null,
    stop: { value: null, visible: false },
    targets: [],
    invalidation: "",
    criteria: [],
    annotations: [],
    scenarios: [],
    pastOccurrences: 0,
    explanation: "",
    missingCriteria: [],
    imageIssues: [],
    nextScreenshot: null,
    conditionalPlans: [],
    priceLevels: [],
    dna: null,
    audit: null,
    confidences: null,
  };
}

/** Bloco DNA coerente com um setup vivo — o ponto de partida dos testes. */
function dnaValido(): NonNullable<PrintAnalysis["dna"]> {
  return {
    grade: "A",
    trend: "NORMAL",
    position: "A_FAVOR",
    pullback: "LIMPO",
    triggerCandle: "FECHAMENTO",
    volatility: null,
    location: "SUPORTE",
    movementOrdinal: 1,
  };
}

describe("contrato da resposta", () => {
  it("recusa status fora do enum em vez de adivinhar", () => {
    const r = validatePrintAnalysis({ ...base(), status: "TALVEZ_COMPRA" });
    expect(r.ok).toBe(false);
    expect(r.analysis).toBeNull();
    expect(r.problem).toContain("status");
  });

  it("recusa resposta sem os campos obrigatórios", () => {
    const r = validatePrintAnalysis({ direction: "COMPRA" });
    expect(r.ok).toBe(false);
    expect(r.problem).not.toBeNull();
  });

  it("recusa confiança fora de 0–100", () => {
    expect(validatePrintAnalysis({ ...base(), confidence: 140 }).ok).toBe(false);
  });
});

describe("número não legível nunca carrega valor", () => {
  it("valor com visible=false é DESCARTADO, não exibido", () => {
    // Este e o palpite silencioso que nao pode chegar a tela do operador.
    const r = validatePrintAnalysis({
      ...base(),
      entry: { value: 141_385, visible: false },
    });
    expect(r.ok).toBe(true);
    expect(r.analysis!.entry.value).toBeNull();
    expect(r.repairs.join(" ")).toContain("Entrada");
  });

  it("visible=true sem número vira não legível", () => {
    const r = validatePrintAnalysis({ ...base(), stop: { value: null, visible: true } });
    expect(r.analysis!.stop.visible).toBe(false);
  });

  it("alvos seguem a mesma regra", () => {
    const r = validatePrintAnalysis({
      ...base(),
      targets: [
        { value: 141_470, visible: true },
        { value: 141_560, visible: false },
      ],
    });
    expect(r.analysis!.targets[0]!.value).toBe(141_470);
    expect(r.analysis!.targets[1]!.value).toBeNull();
  });

  it("a exibição diz NÃO LEGÍVEL, nunca um traço ambíguo", () => {
    expect(formatRead({ value: null, visible: false })).toBe(NAO_LEGIVEL);
    expect(formatRead({ value: 141_385, visible: true })).toContain("141");
  });
});

describe("status não pode contradizer os níveis", () => {
  it("ENTRADA_CONFIRMADA sem entrada/stop legíveis é rebaixada", () => {
    // A tecnica nao pode ter confirmado sobre numeros que ninguem leu.
    const r = validatePrintAnalysis({
      ...base(),
      status: "ENTRADA_CONFIRMADA",
      direction: "COMPRA",
    });
    expect(r.analysis!.status).toBe("T4_EM_FORMACAO");
    expect(r.repairs.join(" ")).toContain("rebaixado");
  });

  it("PRE_ENTRADA com níveis legíveis é preservada", () => {
    const r = validatePrintAnalysis({
      ...base(),
      status: "PRE_ENTRADA",
      direction: "COMPRA",
      entry: { value: 141_385, visible: true },
      stop: { value: 141_250, visible: true },
    });
    expect(r.analysis!.status).toBe("PRE_ENTRADA");
  });

  it("SEM_T4 e INCONCLUSIVO passam sem níveis — são respostas legítimas", () => {
    expect(validatePrintAnalysis({ ...base(), status: "SEM_T4" }).analysis!.status).toBe("SEM_T4");
    expect(validatePrintAnalysis({ ...base(), status: "INCONCLUSIVO" }).analysis!.status).toBe(
      "INCONCLUSIVO",
    );
  });
});

describe("coordenadas do overlay", () => {
  it("marcação fora de 0–1 é recusada pelo schema", () => {
    const r = validatePrintAnalysis({
      ...base(),
      annotations: [{ kind: "ENTRY_LINE", x1: 0.5, y1: 1.4, label: "Entrada" }],
    });
    expect(r.ok).toBe(false);
  });

  it("tipo de marcação desconhecido não vira traço", () => {
    const r = validatePrintAnalysis({
      ...base(),
      annotations: [{ kind: "DESENHO_LIVRE", x1: 0.5, y1: 0.5, label: "x" }],
    });
    expect(r.ok).toBe(false);
  });

  it("marcação válida sobrevive com os campos completos", () => {
    const r = validatePrintAnalysis({
      ...base(),
      annotations: [
        { kind: "ENTRY_ZONE", x1: 0.62, y1: 0.4, x2: 0.89, y2: 0.46, label: "Zona T4" },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.analysis!.annotations).toHaveLength(1);
    expect(r.analysis!.annotations[0]!.x2).toBeCloseTo(0.89, 4);
  });
});

describe("o validador não conserta valores", () => {
  it("nunca aproxima coordenada para a borda", () => {
    // Aproximar seria a alucinacao entrando pela porta dos fundos: o operador
    // nao teria como distinguir o que foi lido do que foi remendado.
    const r = validatePrintAnalysis({
      ...base(),
      annotations: [{ kind: "STOP", x1: 0.5, y1: 1.2, label: "Stop" }],
    });
    expect(r.ok).toBe(false);
    expect(r.analysis).toBeNull();
  });

  it("todo descarte é reportado, nunca silencioso", () => {
    const r = validatePrintAnalysis({
      ...base(),
      entry: { value: 999, visible: false },
      stop: { value: 888, visible: false },
    });
    expect(r.repairs.length).toBeGreaterThanOrEqual(2);
  });
});

describe("bloco dna — vocabulário fechado e coerência com o status", () => {
  it("enum fora do vocabulário é recusado pelo zod, nunca aproximado", () => {
    // O DNA persiste no banco; um valor fora da lista quebraria a segmentação
    // por SQL — a resposta inteira é recusada, com o campo nomeado.
    const r = validatePrintAnalysis({
      ...base(),
      dna: { ...dnaValido(), grade: "A_MAIS" },
    });
    expect(r.ok).toBe(false);
    expect(r.analysis).toBeNull();
    expect(r.problem).toContain("dna");
  });

  it("grade C é aceita no print — a leitura parcial é classificação legítima", () => {
    const r = validatePrintAnalysis({
      ...base(),
      status: "T4_EM_FORMACAO",
      dna: { ...dnaValido(), grade: "C" },
    });
    expect(r.ok).toBe(true);
    expect(r.analysis!.dna!.grade).toBe("C");
  });

  it("status que nega o setup rebaixa a grade para DESCARTADA — e diz", () => {
    for (const status of ["SEM_T4", "T4_INVALIDADA", "INCONCLUSIVO"] as const) {
      const r = validatePrintAnalysis({ ...base(), status, dna: dnaValido() });
      expect(r.ok).toBe(true);
      expect(r.analysis!.dna!.grade).toBe("DESCARTADA");
      expect(r.repairs.join(" ")).toContain("DESCARTADA");
    }
  });

  it("status de setup vivo preserva a grade classificada, sem reparo", () => {
    const r = validatePrintAnalysis({
      ...base(),
      status: "T4_EM_FORMACAO",
      dna: dnaValido(),
    });
    expect(r.analysis!.dna!.grade).toBe("A");
    expect(r.repairs).toHaveLength(0);
  });

  it("trend CONTRA arrasta position para CONTRA_TENDENCIA, com reparo dito", () => {
    const r = validatePrintAnalysis({
      ...base(),
      status: "T4_EM_FORMACAO",
      dna: { ...dnaValido(), trend: "CONTRA", position: "A_FAVOR" },
    });
    expect(r.ok).toBe(true);
    expect(r.analysis!.dna!.position).toBe("CONTRA_TENDENCIA");
    expect(r.repairs.join(" ")).toContain("CONTRA_TENDENCIA");
  });

  it("bloco ausente vira null sem erro — ausência é um valor, não uma falha", () => {
    const semDna: Record<string, unknown> = { ...base() };
    delete semDna.dna;
    const r = validatePrintAnalysis(semDna);
    expect(r.ok).toBe(true);
    expect(r.analysis!.dna).toBeNull();
    expect(r.repairs).toHaveLength(0);
  });
});

/**
 * REGRESSÃO DE CAMPO OMITIDO (18/08, pego em teste real com o qwen3.5:35b).
 *
 * O modelo devolveu uma análise inteira correta e sem `symbol`. Como o campo
 * era `nullable()` SEM default, o zod exigia a chave presente e a resposta boa
 * era recusada com "symbol: Required" — a leitura toda perdida por causa de
 * uma chave ausente cujo significado já era inequívoco.
 */
describe("campos de identificação ausentes (regressão)", () => {
  function semIdentificacao(): Record<string, unknown> {
    const { symbol: _s, timeframe: _t, ...resto } = base() as Record<string, unknown>;
    return resto;
  }

  it("resposta sem symbol/timeframe é ACEITA e vira null — ausência é não identificado", () => {
    const resultado = validatePrintAnalysis(semIdentificacao());
    expect(resultado.ok).toBe(true);
    expect(resultado.problem).toBeNull();
    expect(resultado.analysis!.symbol).toBeNull();
    expect(resultado.analysis!.timeframe).toBeNull();
  });

  it("symbol legível continua preservado — o default não apaga leitura boa", () => {
    const resultado = validatePrintAnalysis({ ...base(), symbol: "WINFUT", timeframe: "1 min" });
    expect(resultado.ok).toBe(true);
    expect(resultado.analysis!.symbol).toBe("WINFUT");
    expect(resultado.analysis!.timeframe).toBe("1 min");
  });

  it("a defesa real segue de pé: número sem `visible` continua recusado", () => {
    const ruim = { ...base(), entry: { value: 171500 } };
    expect(validatePrintAnalysis(ruim).ok).toBe(false);
  });
});

/**
 * PLANO CONDICIONAL — a instrução "SE romper X, é compra".
 *
 * É o campo mais perigoso do contrato: ele PARECE ordem operacional. Por isso
 * a régua é a mais dura da casa — plano sem nível lido, sem stop, ou com stop
 * do lado errado é DESCARTADO com motivo, nunca completado por aproximação.
 */
describe("planos condicionais", () => {
  const num = (value: number) => ({ value, visible: true });
  const ilegivel = { value: null, visible: false };

  function plano(over: Record<string, unknown> = {}) {
    return {
      trigger: "fechamento acima do topo",
      triggerLevel: num(169575),
      side: "COMPRA",
      entry: num(169575),
      entryZone: null,
      stop: num(169235),
      targets: [num(170000)],
      invalidation: "perder o fundo anterior",
      rationale: "reteste da região com candle de força",
      ...over,
    };
  }

  it("plano completo e coerente é publicado como veio", () => {
    const r = validatePrintAnalysis({ ...base(), conditionalPlans: [plano()] });
    expect(r.ok).toBe(true);
    const p = r.analysis!.conditionalPlans[0]!;
    expect(p.side).toBe("COMPRA");
    expect(p.triggerLevel.value).toBe(169575);
    expect(p.stop.value).toBe(169235);
    expect(p.targets).toHaveLength(1);
  });

  it("sem nível de gatilho legível o plano é descartado — 'se romper' de quê?", () => {
    const r = validatePrintAnalysis({
      ...base(),
      conditionalPlans: [plano({ triggerLevel: ilegivel })],
    });
    expect(r.analysis!.conditionalPlans).toHaveLength(0);
    expect(r.repairs.join(" ")).toContain("gatilho não é legível");
  });

  it("sem stop legível o plano é descartado — não se publica entrada sem stop", () => {
    const r = validatePrintAnalysis({ ...base(), conditionalPlans: [plano({ stop: ilegivel })] });
    expect(r.analysis!.conditionalPlans).toHaveLength(0);
    expect(r.repairs.join(" ")).toContain("sem stop legível");
  });

  it("stop do lado errado reprova o plano inteiro: erra sobre o próprio lado", () => {
    // COMPRA com stop ACIMA da entrada mandaria o operador para o lado errado.
    const r = validatePrintAnalysis({
      ...base(),
      conditionalPlans: [plano({ stop: num(170000) })],
    });
    expect(r.analysis!.conditionalPlans).toHaveLength(0);
    expect(r.repairs.join(" ")).toContain("incoerente com COMPRA");
  });

  it("alvo do lado errado cai sozinho, sem derrubar o plano", () => {
    const r = validatePrintAnalysis({
      ...base(),
      conditionalPlans: [plano({ targets: [num(170000), num(168000)] })],
    });
    const p = r.analysis!.conditionalPlans[0]!;
    expect(p.targets).toHaveLength(1);
    expect(p.targets[0]!.value).toBe(170000);
    expect(r.repairs.join(" ")).toContain("lado errado");
  });

  it("VENDA usa a régua espelhada: stop acima, alvo abaixo", () => {
    const venda = plano({
      side: "VENDA",
      triggerLevel: num(169235),
      entry: num(169235),
      stop: num(169575),
      targets: [num(168895)],
    });
    const r = validatePrintAnalysis({ ...base(), conditionalPlans: [venda] });
    expect(r.analysis!.conditionalPlans).toHaveLength(1);
  });

  it("lista vazia é resposta legítima — escala ilegível não vira palpite", () => {
    const r = validatePrintAnalysis({ ...base(), conditionalPlans: [] });
    expect(r.ok).toBe(true);
    expect(r.analysis!.conditionalPlans).toEqual([]);
  });
});

/**
 * REGRESSÃO: ENTRADA PUBLICADA SEM STOP (18/08, teste real com qwen3.5:35b).
 *
 * Produção mostrou "ENTRADA 169 / STOP NÃO LEGÍVEL NO PRINT". Regra da técnica:
 * entrada sem stop não se publica ("se a condição não estiver completa: SEM
 * ENTRADA"). O validador rebaixa a entrada — e diz que rebaixou.
 */
describe("entrada sem stop legível não se publica (regressão)", () => {
  it("entrada visível com stop ilegível é rebaixada, com reparo declarado", () => {
    const r = validatePrintAnalysis({
      ...base(),
      entry: { value: 169_575, visible: true },
      entryZone: {
        min: { value: 169_540, visible: true },
        max: { value: 169_610, visible: true },
      },
      stop: { value: null, visible: false },
    });
    expect(r.ok).toBe(true);
    expect(r.analysis!.entry).toEqual({ value: null, visible: false });
    // A zona acompanha a entrada: publicá-la sozinha seria a mesma ordem sem stop.
    expect(r.analysis!.entryZone!.min).toEqual({ value: null, visible: false });
    expect(r.analysis!.entryZone!.max).toEqual({ value: null, visible: false });
    expect(r.repairs.join(" ")).toContain("Entrada descartada");
  });

  it("entrada com stop legível segue publicada — a regra não derruba leitura boa", () => {
    const r = validatePrintAnalysis({
      ...base(),
      entry: { value: 169_575, visible: true },
      stop: { value: 169_235, visible: true },
    });
    expect(r.analysis!.entry.value).toBe(169_575);
    expect(r.repairs).toHaveLength(0);
  });
});

/**
 * REGRESSÃO: TIMEFRAME LIDO DO RELÓGIO DE CONTAGEM (18/08, qwen3.5:35b).
 *
 * O Profit mostra no canto inferior direito o contador regressivo do candle
 * atual ("41s", depois "03s") e o modelo o devolveu como timeframe. Timeframe
 * real vem do cabeçalho e tem forma "1Min", "5Min", "Diário".
 */
describe("timeframe com cara de contador regressivo (regressão)", () => {
  it("valor de 1–2 dígitos seguido de 's' é descartado para null, com reparo", () => {
    for (const contador of ["41s", "03s", "9 s"]) {
      const r = validatePrintAnalysis({ ...base(), timeframe: contador });
      expect(r.ok).toBe(true);
      expect(r.analysis!.timeframe).toBeNull();
      expect(r.repairs.join(" ")).toContain("contador regressivo");
    }
  });

  it("timeframe de cabeçalho é preservado sem reparo", () => {
    for (const legitimo of ["1Min", "5Min", "Diário"]) {
      const r = validatePrintAnalysis({ ...base(), timeframe: legitimo });
      expect(r.analysis!.timeframe).toBe(legitimo);
      expect(r.repairs).toHaveLength(0);
    }
  });
});

/**
 * REGRESSÃO: MAGNITUDE MISTA ENTRE NÍVEIS (18/08, qwen3.5:35b).
 *
 * Entrada "169" com a escala mostrando "169.875" (169875 pontos no WINFUT): o
 * modelo truncou o separador de milhar em algumas leituras e não em outras.
 * Não há como saber qual leitura está certa — descartar TUDO em bloco, nunca
 * "corrigir" multiplicando por mil.
 */
describe("magnitude mista entre níveis (regressão)", () => {
  it("entrada 169 com stop 169235 derruba os dois, com UM reparo citando as magnitudes", () => {
    const r = validatePrintAnalysis({
      ...base(),
      entry: { value: 169, visible: true },
      stop: { value: 169_235, visible: true },
    });
    expect(r.ok).toBe(true);
    expect(r.analysis!.entry).toEqual({ value: null, visible: false });
    expect(r.analysis!.stop).toEqual({ value: null, visible: false });
    const reparosDeMagnitude = r.repairs.filter((rep) => rep.includes("magnitudes misturadas"));
    expect(reparosDeMagnitude).toHaveLength(1);
    expect(reparosDeMagnitude[0]).toContain("169 vs 169235");
  });

  it("níveis coerentes entre si ficam intactos — a régua não derruba leitura boa", () => {
    const r = validatePrintAnalysis({
      ...base(),
      entry: { value: 169_575, visible: true },
      stop: { value: 169_235, visible: true },
      targets: [{ value: 170_000, visible: true }],
    });
    expect(r.analysis!.entry.value).toBe(169_575);
    expect(r.analysis!.stop.value).toBe(169_235);
    expect(r.analysis!.targets[0]!.value).toBe(170_000);
    expect(r.repairs).toHaveLength(0);
  });

  it("plano condicional cujo gatilho cai no descarte de magnitude é removido", () => {
    // O gatilho "169" truncado convive com níveis completos no mesmo print:
    // o plano perde o gatilho no descarte em bloco e sai da lista inteiro.
    const r = validatePrintAnalysis({
      ...base(),
      entry: { value: 169_575, visible: true },
      stop: { value: 169_235, visible: true },
      conditionalPlans: [
        {
          trigger: "fechamento acima do topo",
          triggerLevel: { value: 169, visible: true },
          side: "COMPRA",
          entry: { value: null, visible: false },
          entryZone: null,
          stop: { value: 168, visible: true },
          targets: [{ value: 172, visible: true }],
          invalidation: "",
          rationale: "",
        },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.analysis!.conditionalPlans).toHaveLength(0);
    expect(r.analysis!.entry).toEqual({ value: null, visible: false });
    expect(r.repairs.join(" ")).toContain("magnitudes misturadas");
  });
});

/**
 * REGRESSÃO: VIÉS EXIBIDO COMO OPERAÇÃO (19/08, print real do operador).
 *
 * A tela mostrava "T4 EM FORMAÇÃO — COMPRA" com ENTRADA, STOP, ALVO e R:R
 * todos NÃO IDENTIFICADOS. `direction` é o VIÉS da estrutura; confirmação
 * exige prova completa. Estes testes trancam a trava determinística: nenhuma
 * análise sai daqui com ENTRADA_CONFIRMADA sem TODAS as pernas.
 */
describe("trava da confirmação — viés não vira ordem", () => {
  /** Um print que TEM como confirmar: cada teste derruba uma perna. */
  function confirmavel(): PrintAnalysis {
    return {
      ...base(),
      status: "ENTRADA_CONFIRMADA",
      direction: "COMPRA",
      confidence: 82,
      entry: { value: 169_500, visible: true },
      stop: { value: 169_300, visible: true },
      // R:R 3,5 sobre risco de 200 pontos — a T4 exige piso 3 (riskGate.MIN_RR).
      targets: [{ value: 170_200, visible: true }],
      criteria: [
        { id: "candle_confirmacao", label: "Candle de confirmação fechado", met: true, detail: "" },
      ],
      confidences: { contexto: 85, estrutura: 82, t4: 78, entrada: 74 },
      dna: dnaValido(),
    };
  }

  it("o print do defeito: COMPRA sem nenhum nível legível NÃO confirma", () => {
    const r = validatePrintAnalysis({
      ...base(),
      status: "ENTRADA_CONFIRMADA",
      direction: "COMPRA",
      confidence: 70,
    });
    expect(r.ok).toBe(true);
    // Sem níveis não há nem PRÉ-ENTRADA: cai para formação.
    expect(r.analysis!.status).toBe("T4_EM_FORMACAO");
    const decisao = deriveEntryDecision(r.analysis!);
    expect(decisao.bias).toBe("COMPRA");
    expect(decisao.status).toBe("EM_FORMACAO");
    expect(decisao.entradaConfirmada).toBe(false);
    expect(decisao.pendencias.join(" ")).toContain(NAO_IDENTIFICADO);
  });

  it("prova completa passa: status preservado e decisão CONFIRMADA", () => {
    const r = validatePrintAnalysis(confirmavel());
    expect(r.analysis!.status).toBe("ENTRADA_CONFIRMADA");
    const decisao = deriveEntryDecision(r.analysis!);
    expect(decisao.entradaConfirmada).toBe(true);
    expect(decisao.status).toBe("CONFIRMADA");
    expect(decisao.pendencias).toEqual([]);
    expect(decisao.rr).toBeCloseTo(3.5, 6);
  });

  it("sem candle FECHADO: rebaixa para PRÉ-ENTRADA (níveis estão completos)", () => {
    const r = validatePrintAnalysis({ ...confirmavel(), criteria: [], dna: null });
    expect(r.analysis!.status).toBe("PRE_ENTRADA");
    expect(r.repairs.join(" ")).toContain("candle de confirmação FECHADO");
  });

  it("R:R abaixo de 1,5 não confirma, mesmo com os três níveis lidos", () => {
    const r = validatePrintAnalysis({
      ...confirmavel(),
      targets: [{ value: 169_550, visible: true }],
    });
    expect(r.analysis!.status).toBe("T4_EM_FORMACAO");
    expect(r.repairs.join(" ")).toContain("R:R");
  });

  it("stop do lado errado numa COMPRA não confirma", () => {
    const r = validatePrintAnalysis({
      ...confirmavel(),
      stop: { value: 169_700, visible: true },
    });
    expect(r.analysis!.status).toBe("T4_EM_FORMACAO");
    expect(r.repairs.join(" ")).toContain("incoerentes");
  });

  it("confiança de ENTRADA baixa não confirma — contexto alto não compra entrada fraca", () => {
    const r = validatePrintAnalysis({
      ...confirmavel(),
      confidences: { contexto: 95, estrutura: 93, t4: 90, entrada: 41 },
    });
    expect(r.analysis!.status).toBe("PRE_ENTRADA");
    expect(r.repairs.join(" ")).toContain("41%");
  });

  it("confianças não reportadas contam como insuficientes", () => {
    const r = validatePrintAnalysis({ ...confirmavel(), confidences: null });
    expect(r.analysis!.status).toBe("PRE_ENTRADA");
    expect(r.repairs.join(" ")).toContain("confianças por camada não reportadas");
  });

  it("auditor reprovado derruba a confirmação com o motivo dele", () => {
    const analysis = validatePrintAnalysis(confirmavel()).analysis!;
    expect(analysis.status).toBe("ENTRADA_CONFIRMADA");
    // O auditor roda DEPOIS da validação: a trava é reaplicada com o carimbo.
    analysis.audit = {
      approved: false,
      issues: ["stop acima da entrada"],
      checkedAt: 1,
      directionContradicted: false,
    };
    const reparos = applyConfirmationGate(analysis);
    expect(analysis.status).toBe("PRE_ENTRADA");
    expect(reparos.join(" ")).toContain("stop acima da entrada");
  });

  it("auditor ausente (null) NUNCA derruba análise válida", () => {
    const analysis = validatePrintAnalysis(confirmavel()).analysis!;
    analysis.audit = null;
    expect(applyConfirmationGate(analysis)).toEqual([]);
    expect(analysis.status).toBe("ENTRADA_CONFIRMADA");
  });

  it("seta de confirmação só sobrevive com entrada confirmada", () => {
    const marca = {
      kind: "CONFIRMATION_CANDLE",
      x1: 0.7,
      y1: 0.4,
      x2: null,
      y2: null,
      label: "candle que confirmou",
      index: null,
      reason: "",
    };
    // Com prova completa a marcação fica.
    const boa = validatePrintAnalysis({ ...confirmavel(), annotations: [marca] });
    expect(boa.analysis!.annotations.some((a) => a.kind === "CONFIRMATION_CANDLE")).toBe(true);

    // Sem prova, a marcação é removida junto com o rebaixamento, e dito.
    const ruim = validatePrintAnalysis({
      ...confirmavel(),
      annotations: [marca],
      criteria: [],
      dna: null,
      confidences: null,
    });
    expect(ruim.analysis!.annotations.some((a) => a.kind === "CONFIRMATION_CANDLE")).toBe(false);
    expect(ruim.repairs.join(" ")).toContain("seta de entrada só existe com entrada confirmada");
  });

  it("status que nega o setup nunca carrega seta de confirmação", () => {
    const r = validatePrintAnalysis({
      ...base(),
      status: "SEM_T4",
      annotations: [
        {
          kind: "CONFIRMATION_CANDLE",
          x1: 0.5,
          y1: 0.5,
          x2: null,
          y2: null,
          label: "",
          index: null,
          reason: "",
        },
      ],
    });
    expect(r.analysis!.annotations).toHaveLength(0);
  });

  /**
   * REGRESSÃO: CARD CONTRADIZENDO O AUDITOR.
   *
   * A tela mostrava "T4 EM FORMAÇÃO — COMPRA" enquanto o auditor reprovava a
   * COMPRA por estrutura de baixa. Dois painéis discordando é pior que
   * qualquer um estar errado sozinho: o operador escolhe o que quer ver.
   */
  describe("veto de direção do auditor", () => {
    const vetado = {
      approved: false,
      issues: ["topos e fundos descendentes contradizem a COMPRA"],
      checkedAt: 1,
      directionContradicted: true,
    };

    it("estrutura de baixa contra COMPRA: viés final vira NEUTRO", () => {
      const analysis = validatePrintAnalysis({ ...confirmavel(), audit: vetado }).analysis!;
      const decisao = deriveEntryDecision(analysis);
      expect(decisao.bias).toBe("NEUTRO");
      expect(decisao.status).toBe("AGUARDANDO");
      expect(decisao.entradaConfirmada).toBe(false);
      expect(decisao.auditorAprovou).toBe(false);
      expect(decisao.direcaoBloqueadaPeloAuditor).toBe(true);
    });

    it("a direção é bloqueada NA ORIGEM — o objeto que vai ao banco já sai NEUTRO", () => {
      const analysis = validatePrintAnalysis(confirmavel()).analysis!;
      analysis.audit = vetado;
      const reparos = applyConfirmationGate(analysis);
      // Nada a jusante (DNA, memória, máquina de setup) vê a direção vetada.
      expect(analysis.direction).toBe("NEUTRO");
      expect(reparos.join(" ")).toContain("AUDITOR VETOU A DIREÇÃO");
      expect(reparos.join(" ")).toContain("COMPRA");
      // E o motivo original do revisor viaja junto, não some.
      expect(reparos.join(" ")).toContain("descendentes");
    });

    it("DNA não aprende com direção vetada: grade vira DESCARTADA", () => {
      const analysis = validatePrintAnalysis({ ...confirmavel(), dna: dnaValido() }).analysis!;
      analysis.audit = vetado;
      applyConfirmationGate(analysis);
      expect(analysis.dna!.grade).toBe("DESCARTADA");
    });

    it("reprovação que NÃO é de direção mantém o lado — só barra a entrada", () => {
      const analysis = validatePrintAnalysis({
        ...confirmavel(),
        audit: {
          approved: false,
          issues: ["stop acima da entrada numa compra"],
          checkedAt: 1,
          directionContradicted: false,
        },
      }).analysis!;
      const decisao = deriveEntryDecision(analysis);
      expect(decisao.bias).toBe("COMPRA");
      expect(decisao.entradaConfirmada).toBe(false);
      expect(decisao.direcaoBloqueadaPeloAuditor).toBe(false);
    });

    it("o sistema NÃO inverte para o lado oposto por conta própria", () => {
      const analysis = validatePrintAnalysis({ ...confirmavel(), audit: vetado }).analysis!;
      // Inverter seria criar um sinal que ninguém leu no gráfico.
      expect(deriveEntryDecision(analysis).bias).not.toBe("VENDA");
    });

    it("auditor ausente não é aprovação por omissão", () => {
      const analysis = validatePrintAnalysis(confirmavel()).analysis!;
      analysis.audit = null;
      expect(deriveEntryDecision(analysis).auditorAprovou).toBeNull();
    });
  });

  it("viés NEUTRO nunca confirma", () => {
    const decisao = deriveEntryDecision({ ...confirmavel(), direction: "NEUTRO" });
    expect(decisao.entradaConfirmada).toBe(false);
    expect(decisao.pendencias.join(" ")).toContain("NEUTRO");
  });

  it("T4_INVALIDADA vira status derivado INVALIDADA", () => {
    const decisao = deriveEntryDecision({ ...base(), status: "T4_INVALIDADA" });
    expect(decisao.status).toBe("INVALIDADA");
    expect(decisao.entradaConfirmada).toBe(false);
  });

  /**
   * REGRESSÃO: análise ANTIGA do histórico (localStorage) volta com campos
   * simplesmente AUSENTES, não com null. `undefined !== null` passava no
   * guard e a leitura de `.approved` derrubava a tela inteira — a trava tem
   * de NEGAR a entrada, nunca explodir.
   */
  it("análise legada com campos ausentes não confirma e NÃO quebra", () => {
    const legada = {
      status: "ENTRADA_CONFIRMADA",
      direction: "COMPRA",
      confidence: 88,
      entry: { value: 169_500, visible: true },
      stop: { value: 169_300, visible: true },
      // Sem targets, criteria, annotations, dna, audit nem confidences.
    } as unknown as PrintAnalysis;

    const decisao = deriveEntryDecision(legada);
    expect(decisao.entradaConfirmada).toBe(false);
    expect(decisao.bias).toBe("COMPRA");
    expect(decisao.pendencias.join(" ")).toContain("confianças por camada não reportadas");

    // E o gate roda sobre ela sem estourar.
    expect(() => applyConfirmationGate(legada)).not.toThrow();
    expect(legada.status).not.toBe("ENTRADA_CONFIRMADA");
  });
});

/**
 * §4 — O AUDITOR CONTINUA SOBERANO, MAS NEM SEMPRE NO CAMINHO CRÍTICO.
 *
 * A pergunta que estes testes trancam: a otimização enfraqueceu a
 * confirmação? Não pode. Tudo que PODE liberar entrada continua esperando o
 * carimbo antes de chegar à tela.
 */
describe("modo do auditor por status", () => {
  function comStatus(status: PrintAnalysis["status"], direction: PrintAnalysis["direction"]) {
    return { ...base(), status, direction };
  }

  it("o que pode LIBERAR ENTRADA bloqueia — a trava não foi afrouxada", () => {
    expect(auditModeFor(comStatus("ENTRADA_CONFIRMADA", "COMPRA"))).toBe("BLOQUEANTE");
    expect(auditModeFor(comStatus("PRE_ENTRADA", "VENDA"))).toBe("BLOQUEANTE");
  });

  it("viés com lado é ADIADO — o auditor ainda roda e pode vetar a direção", () => {
    expect(auditModeFor(comStatus("T4_EM_FORMACAO", "COMPRA"))).toBe("ADIADO");
    expect(auditModeFor(comStatus("APROXIMACAO_T4", "VENDA"))).toBe("ADIADO");
    expect(auditModeFor(comStatus("SEM_T4", "COMPRA"))).toBe("ADIADO");
  });

  it("sem lado nenhum é DISPENSADO — não há direção para contradizer", () => {
    expect(auditModeFor(comStatus("SEM_T4", "NEUTRO"))).toBe("DISPENSADO");
    expect(auditModeFor(comStatus("INCONCLUSIVO", "NEUTRO"))).toBe("DISPENSADO");
  });

  it("nenhum status confirmável escapa do bloqueio", () => {
    // Varre o vocabulário inteiro: se um status novo aparecer e puder
    // confirmar, este teste força a decisão explícita sobre ele.
    for (const status of PRINT_STATUS) {
      const modo = auditModeFor(comStatus(status, "COMPRA"));
      const podeConfirmar = status === "ENTRADA_CONFIRMADA" || status === "PRE_ENTRADA";
      expect(modo === "BLOQUEANTE").toBe(podeConfirmar);
    }
  });
});
