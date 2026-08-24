import { describe, expect, it } from "vitest";

import { CAPTURE_PERIOD_MS } from "@/lib/capture/marketMonitor";
import {
  advanceSetup,
  decidirCongelamento,
  SETUP_TTL_MS,
  type SetupUpdate,
  type TrackedSetup,
} from "../setupTracker";
import { readingIsWeak } from "../printCrop";
import {
  deriveEntryDecision,
  podeDesenharAnotacao,
  validatePrintAnalysis,
  type PrintAnalysis,
} from "@/lib/vision/printAnalysis";

/**
 * TESTE DE ACEITE DO OPERADOR — os 13 itens, encostados no código de verdade.
 *
 * Cada `it` abaixo nomeia o item da lista que ele prova. Os que dependem de
 * MERCADO REAL (sessão ao vivo, GPU no ar, CSV do WIN) NÃO são simulados aqui:
 * simular resultado seria a mentira que este projeto inteiro existe para
 * evitar. Eles estão listados no fim do arquivo, nomeados, como pendência
 * declarada — e os itens 8, 9 e 11 são cobertos pelos testes do lado servidor
 * (setupOutcome / repositório), não daqui.
 */

const T0 = Date.UTC(2026, 7, 19, 13, 0, 0);
const num = (value: number) => ({ value, visible: true });
const ILEGIVEL = { value: null, visible: false };

const CANDLE_FECHADO = {
  id: "candle_confirmacao",
  label: "Candle de confirmação fechado",
  met: true,
  detail: "fechou acima do rompimento",
};

function analise(overrides: Partial<PrintAnalysis> = {}): PrintAnalysis {
  return {
    status: "T4_EM_FORMACAO",
    direction: "COMPRA",
    confidence: 80,
    symbol: "WINFUT",
    timeframe: "1Min",
    // Abaixo do gatilho: é onde um setup de COMPRA espera o rompimento.
    // Nascer 100 pontos ALÉM da entrada fazia todo primeiro print já entrar
    // como rompimento fechado, e nenhum teste exercitava a formação.
    // Campos do ciclo de vida do candle: o fixture-padrao nao le relogio nem
    // candle fechado — quem testa isso preenche explicitamente.
    chartClock: { date: null, time: null },
    lastClosedCandle: null,
    currentPrice: num(169_400),
    entry: num(169_500),
    entryZone: null,
    stop: num(169_300),
    // R:R 3,5 sobre risco de 200 pontos — a T4 exige piso 3 (riskGate.MIN_RR).
    targets: [num(170_200)],
    invalidation: "",
    criteria: [CANDLE_FECHADO],
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
    confidences: { contexto: 82, estrutura: 80, t4: 76, entrada: 72 },
    ...overrides,
  } as PrintAnalysis;
}

/**
 * Um passo confirmado de verdade, passando por toda a máquina.
 *
 * Quatro prints, porque a confirmação deixou de ser um evento e virou prova
 * acumulada (§14–§16): preço aquém do gatilho, toque, fechamento além e — só
 * então — o candle SEGUINTE sustentando. Confirmar em dois passos era o que
 * liberava operação num rompimento que ainda ia falhar.
 */
/**
 * Candle FECHADO e PROVADO — o insumo que a maquina passou a exigir em 20/08.
 *
 * A sequencia de aceite descreve quatro CANDLES, e nao quatro prints: e por
 * isso que cada passo precisa declarar o seu. Antes a observacao era fabricada
 * da etiqueta de preco, e a etiqueta e o preco corrente de um candle aberto.
 */
function fechado(close: number, candleTime: number) {
  return {
    close,
    candleTime,
    at: candleTime + 900,
    phase: "CLOSED" as const,
    closeSource: "MODELO" as const,
  };
}

function passoConfirmado(inicio = T0): SetupUpdate {
  const confirmando = {
    status: "ENTRADA_CONFIRMADA" as const,
    audit: { approved: true, issues: [], checkedAt: inicio, directionContradicted: false },
  };
  const p1 = advanceSetup(null, analise({ status: "PRE_ENTRADA" }), inicio, 1, {
    candle: fechado(169_400, inicio),
  });
  const p2 = advanceSetup(
    p1.setup,
    analise({ status: "PRE_ENTRADA", currentPrice: num(169_500) }),
    inicio + 60_000,
    2,
    { candle: fechado(169_500, inicio + 60_000) },
  );
  const p3 = advanceSetup(
    p2.setup,
    analise({ ...confirmando, currentPrice: num(169_600) }),
    inicio + 120_000,
    3,
    { candle: fechado(169_600, inicio + 120_000) },
  );
  return advanceSetup(
    p3.setup,
    analise({ ...confirmando, currentPrice: num(169_650) }),
    inicio + 180_000,
    4,
    { candle: fechado(169_650, inicio + 180_000) },
  );
}

describe("aceite 1 e 2 — captura de 60s, sem duplicar", () => {
  it("item 1: a cadência é 60 segundos, fixa", () => {
    expect(CAPTURE_PERIOD_MS).toBe(60_000);
  });

  it("item 2: o MESMO print não vira duas análises (fila de um slot)", () => {
    // A fila do monitor guarda só o frame mais fresco — o comportamento tem
    // teste próprio em marketMonitor.test.ts. Aqui a garantia é do outro lado:
    // reenviar o mesmo print ao setup não conta duas vezes o mesmo passo.
    const p1 = advanceSetup(null, analise(), T0, 1);
    expect(p1.setup!.printsSeen).toBe(1);
    const p2 = advanceSetup(p1.setup, analise(), T0 + 60_000, 2);
    expect(p2.setup!.printsSeen).toBe(2);
  });
});

describe("aceite 3 e 4 — a mesma oportunidade atravessa os prints", () => {
  it("item 3: a linha roxa (nível de entrada) persiste no MESMO setupId", () => {
    const p1 = advanceSetup(null, analise(), T0, 1);
    const p2 = advanceSetup(p1.setup, analise({ entry: ILEGIVEL }), T0 + 60_000, 2);
    // Print seguinte sem entrada legível NÃO perde a linha: ela é herdada.
    expect(p2.setup!.setupId).toBe(p1.setup!.setupId);
    expect(p2.setup!.entryLevel).toBe(169_500);
  });

  it("item 4: aproximação gera SÓ pré-alerta, nunca entrada", () => {
    const perto = advanceSetup(null, analise({ currentPrice: num(169_750) }), T0, 1);
    expect(perto.preAlert).toBe(true);
    expect(perto.entradaConfirmada).toBe(false);
    expect(perto.headline).toContain("PREPARAR");
  });
});

describe("aceite 5, 6 e 7 — toque, congelamento e novo ciclo", () => {
  it("item 5: toque sozinho NÃO confirma", () => {
    const preparado = advanceSetup(null, analise({ status: "PRE_ENTRADA" }), T0, 1).setup;
    const toque = advanceSetup(
      preparado,
      analise({ status: "PRE_ENTRADA", currentPrice: num(169_500) }),
      T0 + 60_000,
      2,
    );
    expect(toque.setup!.touched).toBe(true);
    expect(toque.entradaConfirmada).toBe(false);
    expect(toque.headline).toBe("TOQUE SEM CONFIRMAÇÃO — AGUARDAR");
  });

  it("item 6: confirmação real congela ESTE print", () => {
    const passo = passoConfirmado();
    expect(passo.entradaConfirmada).toBe(true);
    expect(
      decidirCongelamento({ congeladoEm: null, novoIndice: 7, passo, nasceuSetup: false }),
    ).toBe(7);
  });

  it("item 6b: print NÃO confirmado nunca congela nada", () => {
    const emFormacao = advanceSetup(null, analise(), T0, 1);
    expect(
      decidirCongelamento({
        congeladoEm: null,
        novoIndice: 3,
        passo: emFormacao,
        nasceuSetup: true,
      }),
    ).toBeNull();
  });

  it("item 6c: congelado PERMANECE enquanto a mesma oportunidade segue viva", () => {
    const seguindo = advanceSetup(
      passoConfirmado().setup,
      analise({ status: "ENTRADA_CONFIRMADA", currentPrice: num(169_520) }),
      T0 + 120_000,
      3,
    );
    expect(
      decidirCongelamento({ congeladoEm: 7, novoIndice: 8, passo: seguindo, nasceuSetup: false }),
    ).toBe(7);
  });

  it("item 7: setup NOVO, invalidação ou expiração liberam o ciclo", () => {
    // Setup novo nasce (ainda sem confirmar): o print antigo sai da tela.
    const novo = advanceSetup(null, analise(), T0 + 600_000, 2);
    expect(
      decidirCongelamento({ congeladoEm: 7, novoIndice: 8, passo: novo, nasceuSetup: true }),
    ).toBeNull();

    const vivo = advanceSetup(null, analise(), T0, 1).setup!;
    const invalidado = advanceSetup(vivo, analise({ direction: "VENDA" }), T0 + 60_000, 2);
    expect(
      decidirCongelamento({ congeladoEm: 7, novoIndice: 8, passo: invalidado, nasceuSetup: false }),
    ).toBeNull();

    const expirado = advanceSetup(vivo, analise(), T0 + SETUP_TTL_MS + 1, 2);
    expect(
      decidirCongelamento({ congeladoEm: 7, novoIndice: 8, passo: expirado, nasceuSetup: false }),
    ).toBeNull();
  });

  it("item 7b: oportunidade NOVA que já nasce confirmada congela no print novo", () => {
    // A confirmação fresca manda: congelar no print velho esconderia a
    // entrada que acabou de ser liberada.
    const passo = passoConfirmado();
    expect(decidirCongelamento({ congeladoEm: 7, novoIndice: 8, passo, nasceuSetup: true })).toBe(
      8,
    );
  });
});

describe("aceite 10 — confiança baixa dispara o 2º passe", () => {
  it("item 10: leitura fraca pede crop/zoom; leitura boa não paga chamada extra", () => {
    expect(readingIsWeak(analise({ status: "INCONCLUSIVO" })).weak).toBe(true);
    expect(readingIsWeak(analise({ confidence: 38 })).weak).toBe(true);
    expect(readingIsWeak(analise({ imageIssues: ["candles pequenos demais"] })).weak).toBe(true);
    // Leitura completa e nítida não repete.
    const boa = analise({
      priceLevels: [
        { kind: "SUPORTE", label: "Fundo", priceMin: num(169_200), priceMax: null },
      ] as PrintAnalysis["priceLevels"],
    });
    expect(readingIsWeak(boa).weak).toBe(false);
  });
});

describe("aceite 12 — nenhum preço é inventado", () => {
  it("item 12: número marcado como não legível nunca carrega valor", () => {
    const r = validatePrintAnalysis({
      ...analise(),
      entry: { value: 169_500, visible: false },
    });
    expect(r.analysis!.entry).toEqual({ value: null, visible: false });
    expect(r.repairs.join(" ")).toContain("não estava legível");
  });

  it("item 12b: entrada legível sem stop legível NÃO é publicada", () => {
    const r = validatePrintAnalysis({ ...analise(), stop: ILEGIVEL });
    expect(r.analysis!.entry).toEqual({ value: null, visible: false });
    expect(r.repairs.join(" ")).toContain("sem stop legível");
  });
});

describe("aceite 13 — nenhum COMPRA/VENDA sem entradaConfirmada", () => {
  it("item 13: o print do defeito (COMPRA sem níveis) não confirma", () => {
    const r = validatePrintAnalysis({
      ...analise(),
      status: "ENTRADA_CONFIRMADA",
      entry: ILEGIVEL,
      stop: ILEGIVEL,
      targets: [],
      criteria: [],
      confidences: null,
    });
    const decisao = deriveEntryDecision(r.analysis!);
    expect(decisao.bias).toBe("COMPRA");
    expect(decisao.entradaConfirmada).toBe(false);
    expect(decisao.status).toBe("EM_FORMACAO");
  });

  it("item 13b: a seta de entrada não é desenhada em NENHUMA superfície sem lado liberado", () => {
    const seta = {
      kind: "CONFIRMATION_CANDLE" as const,
      x1: 0.7,
      y1: 0.4,
      x2: null,
      y2: null,
      label: "confirmou",
      index: null,
      reason: "",
    };
    expect(podeDesenharAnotacao(seta, null)).toBe(false);
    expect(podeDesenharAnotacao(seta, "NEUTRO")).toBe(false);
    expect(podeDesenharAnotacao(seta, "COMPRA")).toBe(true);
  });

  it("item 13c: TODO passo da máquina que não confirma diz o motivo", () => {
    // Bloquear em silêncio é tão ruim quanto liberar errado: o operador fica
    // sem saber o que esperar. Nenhum passo não-confirmado sai sem pendência.
    const passos: SetupUpdate[] = [];
    const vivo: TrackedSetup = advanceSetup(null, analise(), T0, 1).setup!;
    passos.push(advanceSetup(null, analise(), T0, 1));
    passos.push(advanceSetup(null, analise({ status: "SEM_T4" }), T0, 1));
    passos.push(advanceSetup(vivo, analise({ direction: "VENDA" }), T0 + 60_000, 2));
    passos.push(advanceSetup(vivo, analise(), T0 + SETUP_TTL_MS + 1, 2));
    passos.push(
      advanceSetup(vivo, analise({ status: "ENTRADA_CONFIRMADA", criteria: [] }), T0 + 60_000, 2),
    );
    for (const passo of passos) {
      expect(passo.entradaConfirmada).toBe(false);
      expect(passo.pendencias.length).toBeGreaterThan(0);
    }
  });
});

/**
 * ITENS QUE DEPENDEM DE MERCADO REAL — NÃO simulados aqui, de propósito:
 *
 * 8. setup confirmado fecha em WIN/LOSS/EXPIRADO/INVALIDADO
 *    → lógica pura coberta em setupOutcome.test.ts; o fechamento ponta a ponta
 *      exige preços reais chegando pelos prints de uma sessão ao vivo.
 * 9. memória recebe o resultado apenas uma vez
 *    → trava `learned` coberta nos testes do repositório; a prova definitiva é
 *      uma sessão real com setup fechando.
 * 11. reiniciar backend não perde setup ativo
 *    → persistência coberta nos testes do repositório (upsert + listOpenSetups);
 *      o restart de verdade é verificação de operação, não de unidade.
 *
 * Nenhum destes é "simulado como se tivesse passado": o que não foi exercido
 * com dado real fica dito.
 */
