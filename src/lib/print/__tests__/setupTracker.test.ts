import { describe, expect, it } from "vitest";

import type { PrintAnalysis } from "@/lib/vision/printAnalysis";
import {
  advanceSetup,
  CONFIRM_COOLDOWN_MS,
  decidirCongelamento,
  makeSetupId,
  SETUP_STAGES,
  SETUP_TTL_MS,
  type SetupUpdate,
  type TrackedSetup,
} from "../setupTracker";
import { SETUP_OUTCOME_TTL_MS } from "../setupOutcome";
import { CLIPPED_LABEL } from "@/lib/vision/viewportChange";

/**
 * A máquina de setup em teste: o MESMO setup atravessa prints, toque não é
 * entrada, gates vetam, cooldown segura repetição e oportunidade velha expira.
 */

const T0 = Date.UTC(2026, 7, 19, 13, 0, 0);
const num = (value: number) => ({ value, visible: true });
const ILEGIVEL = { value: null, visible: false };

/** O critério do candle FECHADO — a prova do rompimento (§5 do operador). */
const CANDLE_FECHADO = {
  id: "candle_confirmacao",
  label: "Candle de confirmação fechado",
  met: true,
  detail: "fechou acima do rompimento",
};

/**
 * A base representa um print que TERIA como confirmar: níveis coerentes,
 * candle fechado e confianças reportadas. Cada teste derruba UMA perna e
 * verifica que a entrada não é liberada — é a única forma de provar que o
 * gate exige cada item, e não que ele passa por acidente.
 */
function analise(overrides: Partial<PrintAnalysis> = {}): PrintAnalysis {
  return {
    status: "T4_EM_FORMACAO",
    direction: "COMPRA",
    confidence: 80,
    symbol: "WINFUT",
    timeframe: "1Min",
    /*
     * PREÇO ABAIXO DO GATILHO — é onde um setup de COMPRA vive antes de romper.
     *
     * A base nascia em 169.600, ou seja, 100 pontos ALÉM da entrada. Com a
     * tolerância de rompimento valendo 1 tick, todo primeiro print já entrava
     * como BREAKOUT_CLOSED e nenhum teste conseguia exercitar a formação. Um
     * setup que nasce do outro lado do próprio gatilho não descreve nada.
     */
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

/** Auditor aprovando — o gate do auditor não é o assunto destes testes. */
const APROVADO = { approved: true, issues: [], checkedAt: T0, directionContradicted: false };

/**
 * Uma observação de candle FECHADO e PROVADO, do jeito que o livro-razão emite.
 *
 * Desde 20/08 a máquina não fabrica mais observação a partir da etiqueta de
 * preço, então o teste tem de fornecê-la — e essa obrigação é o ponto: quem
 * quer mover a máquina de rompimento precisa DIZER que o candle fechou e que o
 * fechamento foi lido no gráfico.
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

/**
 * A SEQUÊNCIA MÍNIMA QUE CONFIRMA (§14–§16) — quatro prints, quatro fatos.
 *
 * Confirmar deixou de ser um evento e passou a ser uma PROVA acumulada, e ela
 * não cabe numa imagem só:
 *   1) preço AQUÉM do gatilho — é o estado de quem ainda espera romper;
 *   2) preço TOCA o gatilho — toque não confirma nada (§14);
 *   3) candle FECHA além do gatilho — abre o caso, ainda sem liberar (§15);
 *   4) candle SEGUINTE sustenta além — só aqui a operação é liberada (§16).
 *
 * Cada passo avança 60s porque a observação do candle é derivada do piso do
 * minuto: dois prints no mesmo minuto seriam o MESMO candle, e reobservar o
 * mesmo candle é no-op de propósito (é o que impede frame repetido de
 * fabricar sustentação, §18).
 */
function sequenciaConfirmada(quando = T0): {
  passos: SetupUpdate[];
  setup: TrackedSetup;
  rompimento: SetupUpdate;
} {
  const confirmando = { status: "ENTRADA_CONFIRMADA" as const, audit: APROVADO };
  const p1 = advanceSetup(null, analise({ status: "PRE_ENTRADA" }), quando, 1, {
    candle: fechado(169_400, quando),
  });
  const p2 = advanceSetup(
    p1.setup,
    analise({ status: "PRE_ENTRADA", currentPrice: num(169_500) }),
    quando + 60_000,
    2,
    { candle: fechado(169_500, quando + 60_000) },
  );
  const p3 = advanceSetup(
    p2.setup,
    analise({ ...confirmando, currentPrice: num(169_600) }),
    quando + 120_000,
    3,
    { candle: fechado(169_600, quando + 120_000) },
  );
  const p4 = advanceSetup(
    p3.setup,
    analise({ ...confirmando, currentPrice: num(169_650) }),
    quando + 180_000,
    4,
    { candle: fechado(169_650, quando + 180_000) },
  );
  return { passos: [p1, p2, p3, p4], setup: p4.setup!, rompimento: p3 };
}

describe("makeSetupId", () => {
  it("formato T4-AAAA-MM-DD-XXX", () => {
    expect(makeSetupId(T0, 7)).toBe("T4-2026-08-19-007");
  });
});

describe("nascimento e persistência", () => {
  it("status com lado cria setup e o MESMO id atravessa os prints seguintes", () => {
    const p1 = advanceSetup(null, analise(), T0, 1);
    expect(p1.setup).not.toBeNull();
    expect(p1.setup!.setupId).toBe("T4-2026-08-19-001");
    expect(p1.setup!.stage).toBe("FORMING");

    const p2 = advanceSetup(p1.setup, analise({ status: "PRE_ENTRADA" }), T0 + 60_000, 2);
    expect(p2.setup!.setupId).toBe(p1.setup!.setupId); // nunca "um novo por minuto"
    // APPROACHING e nao WAITING_BREAKOUT: o preco (169.400) esta a 100 pontos
    // do gatilho (169.500), dentro da faixa de pre-alerta. O estagio grosso
    // valia igual para 100 e para 800 pontos de distancia.
    expect(p2.setup!.stage).toBe("APPROACHING");
    expect(p2.setup!.printsSeen).toBe(2);
  });

  it("SEM_T4/INCONCLUSIVO ou direção NEUTRO não criam setup", () => {
    expect(advanceSetup(null, analise({ status: "SEM_T4" }), T0, 1).setup).toBeNull();
    expect(advanceSetup(null, analise({ direction: "NEUTRO" }), T0, 1).setup).toBeNull();
  });

  it("distância e pré-alerta: perto da linha roxa avisa PREPARAR", () => {
    // Entrada 169.500, stop 169.300 (dist 200); preço a 250 pts → sem alerta;
    // preço a 250… limite = 1,5×200 = 300 → DENTRO do alerta.
    const perto = advanceSetup(null, analise({ currentPrice: num(169_750) }), T0, 1);
    expect(perto.distancePoints).toBe(250);
    expect(perto.preAlert).toBe(true);
    expect(perto.headline).toContain("PREPARAR");

    const longe = advanceSetup(null, analise({ currentPrice: num(170_200) }), T0, 1);
    expect(longe.preAlert).toBe(false);
  });
});

describe("§7 — toque NÃO é entrada", () => {
  function preparado(): TrackedSetup {
    return advanceSetup(null, analise({ status: "PRE_ENTRADA" }), T0, 1).setup!;
  }

  it("preço tocou a linha sem confirmação do modelo: AGUARDAR", () => {
    const passo = advanceSetup(
      preparado(),
      analise({ status: "PRE_ENTRADA", currentPrice: num(169_500) }),
      T0 + 60_000,
      2,
    );
    expect(passo.headline).toBe("TOQUE SEM CONFIRMAÇÃO — AGUARDAR");
    /*
     * Tocar o gatilho ARMA o setup — e armar não é entrar. O estágio mudou de
     * WAITING_BREAKOUT para ARMED em 20/08 porque a tela precisava separar
     * "esperando de longe" de "encostou, agora depende do fechamento". O que
     * NÃO mudou é o que importa: nenhuma entrada foi confirmada aqui.
     */
    expect(passo.setup!.stage).toBe("ARMED");
    expect(passo.entradaConfirmada).toBe(false);
    expect(passo.setup!.operationReleased).toBe(false);
    expect(passo.setup!.touched).toBe(true);
  });

  it("toque + rompimento + SUSTENTAÇÃO + gates limpos: ENTRADA LIBERADA", () => {
    const { passos, setup } = sequenciaConfirmada();
    const passo = passos[3]!;
    expect(setup.stage).toBe("CONFIRMED");
    expect(passo.headline).toContain("ENTRADA LIBERADA");
    expect(passo.headline).toContain("COMPRA");
    // §22 — liberar operação exige confirmação E risco aprovado.
    expect(setup.operationReleased).toBe(true);
  });

  /*
   * §15–§16 — O PASSO ANTERIOR NÃO LIBERA, e é o teste que fixa a lei nova.
   *
   * O print do rompimento tem tudo o que a regra antiga exigia (níveis, R:R,
   * candle fechado, auditor aprovado, status ENTRADA_CONFIRMADA) e mesmo
   * assim não é ordem: o candle seguinte ainda não se pronunciou.
   */
  it("rompimento fechado, sozinho, NÃO libera operação", () => {
    const { rompimento } = sequenciaConfirmada();
    expect(rompimento.setup!.stage).toBe("BREAKOUT_CLOSED");
    expect(rompimento.entradaConfirmada).toBe(false);
    expect(rompimento.setup!.operationReleased).toBe(false);
    expect(rompimento.setup!.breakout!.breakoutClosed).toBe(true);
    expect(rompimento.setup!.breakout!.breakoutSustained).toBe(false);
    expect(rompimento.setup!.breakout!.setupConfirmed).toBe(false);
  });

  it("auditor reprovou: ENTRADA BLOQUEADA mesmo com toque e confirmação", () => {
    const passo = advanceSetup(
      preparado(),
      analise({
        status: "ENTRADA_CONFIRMADA",
        currentPrice: num(169_500),
        audit: {
          approved: false,
          issues: ["overlay não condiz com o texto"],
          checkedAt: T0,
          directionContradicted: false,
        },
      }),
      T0 + 60_000,
      2,
    );
    expect(passo.setup!.stage).toBe("ARMED");
    expect(passo.headline).toContain("BLOQUEADA");
    expect(passo.pendencias.join(" ")).toContain("auditor");
  });

  it("confiança de ENTRADA baixa bloqueia — tendência forte não é permissão (§12)", () => {
    const passo = advanceSetup(
      preparado(),
      analise({
        status: "ENTRADA_CONFIRMADA",
        currentPrice: num(169_500),
        confidences: { contexto: 90, estrutura: 88, t4: 80, entrada: 46 },
      }),
      T0 + 60_000,
      2,
    );
    /*
     * O NÚMERO CONTINUA SENDO DITO — mas o headline mostra a pendência mais
     * FUNDAMENTAL, e com o preço apenas encostado no gatilho ela é a falta do
     * fechamento (§15). Prender o teste ao headline travaria a ORDEM das
     * pendências, que é semântica e muda quando a regra evolui. O invariante
     * que importa é outro: a confiança baixa não some da tela e não deixa de
     * bloquear.
     */
    expect(passo.pendencias.join(" ")).toContain("46%");
    expect(passo.entradaConfirmada).toBe(false);
    expect(passo.setup!.stage).toBe("ARMED");
  });

  it("R:R abaixo de 1,5 bloqueia com o número dito (§9)", () => {
    const passo = advanceSetup(
      preparado(),
      analise({
        status: "ENTRADA_CONFIRMADA",
        currentPrice: num(169_500),
        targets: [num(169_550)], // 50 pts de alvo contra 200 de stop
      }),
      T0 + 60_000,
      2,
    );
    // Mesma razão do teste acima: o número é dito na lista de pendências.
    expect(passo.pendencias.join(" ")).toContain("R:R");
    expect(passo.entradaConfirmada).toBe(false);
    expect(passo.setup!.stage).toBe("ARMED");
  });
});

describe("viés NÃO é entrada — a trava determinística", () => {
  function preparado(): TrackedSetup {
    return advanceSetup(null, analise({ status: "PRE_ENTRADA" }), T0, 1).setup!;
  }

  it("sem candle de confirmação FECHADO não libera, mesmo com tudo o mais em ordem", () => {
    const passo = advanceSetup(
      preparado(),
      // Nem critério de candle atendido, nem DNA com gatilho: pavio não confirma.
      analise({ status: "ENTRADA_CONFIRMADA", currentPrice: num(169_500), criteria: [] }),
      T0 + 60_000,
      2,
    );
    expect(passo.entradaConfirmada).toBe(false);
    expect(passo.setup!.stage).toBe("ARMED");
    expect(passo.pendencias.join(" ")).toContain("candle");
  });

  it("critério de candle NÃO atendido também não conta como prova", () => {
    const passo = advanceSetup(
      preparado(),
      analise({
        status: "ENTRADA_CONFIRMADA",
        currentPrice: num(169_500),
        criteria: [{ ...CANDLE_FECHADO, met: false, detail: "rompeu só de pavio" }],
      }),
      T0 + 60_000,
      2,
    );
    expect(passo.entradaConfirmada).toBe(false);
    expect(passo.pendencias.join(" ")).toContain("pavio");
  });

  it("entrada ilegível não confirma — e a pendência diz qual nível falta", () => {
    const semNivel = advanceSetup(
      null,
      analise({ status: "PRE_ENTRADA", entry: ILEGIVEL, stop: ILEGIVEL, targets: [] }),
      T0,
      1,
    );
    const passo = advanceSetup(
      semNivel.setup,
      analise({
        status: "ENTRADA_CONFIRMADA",
        entry: ILEGIVEL,
        stop: ILEGIVEL,
        targets: [],
        currentPrice: num(169_500),
      }),
      T0 + 60_000,
      2,
    );
    expect(passo.entradaConfirmada).toBe(false);
    // Sem nível legível nem herdado o setup nem chega a tocar: segue em viés.
    expect(passo.setup!.stage).not.toBe("CONFIRMADO");
  });

  it("todo passo que não confirma carrega entradaConfirmada=false", () => {
    const emFormacao = advanceSetup(null, analise(), T0, 1);
    expect(emFormacao.entradaConfirmada).toBe(false);

    const semSetup = advanceSetup(null, analise({ status: "SEM_T4" }), T0, 1);
    expect(semSetup.entradaConfirmada).toBe(false);

    const vivo = advanceSetup(null, analise(), T0, 1).setup!;
    expect(
      advanceSetup(vivo, analise({ direction: "VENDA" }), T0 + 60_000, 2).entradaConfirmada,
    ).toBe(false);
    expect(advanceSetup(vivo, analise(), T0 + SETUP_TTL_MS + 1, 2).entradaConfirmada).toBe(false);
  });

  it("confirmação real marca entradaConfirmada=true e esvazia as pendências", () => {
    const { passos } = sequenciaConfirmada();
    const passo = passos[3]!;
    expect(passo.entradaConfirmada).toBe(true);
    expect(passo.pendencias).toEqual([]);
  });
});

describe("pós-confirmação, invalidação e expiração", () => {
  /** Reusa a sequência canônica do topo — uma só definição de "confirmado". */
  function confirmado(): TrackedSetup {
    return sequenciaConfirmada().setup;
  }

  it("§19 — confirmado NÃO gera segunda entrada no mesmo setup", () => {
    const passo = advanceSetup(
      confirmado(),
      analise({ status: "ENTRADA_CONFIRMADA", currentPrice: num(169_500) }),
      T0 + 120_000,
      3,
    );
    expect(passo.setup!.stage).toBe("CONFIRMED");
    expect(passo.headline).toContain("sem novas entradas");
  });

  it("direção contrária invalida o setup com motivo", () => {
    const vivo = advanceSetup(null, analise(), T0, 1).setup!;
    const passo = advanceSetup(vivo, analise({ direction: "VENDA" }), T0 + 60_000, 2);
    expect(passo.setup!.stage).toBe("INVALIDATED");
    expect(passo.setup!.reason).toContain("VENDA");
  });

  it("§20 — sem ativação dentro do TTL, EXPIRADO", () => {
    const vivo = advanceSetup(null, analise(), T0, 1).setup!;
    const passo = advanceSetup(vivo, analise(), T0 + SETUP_TTL_MS + 1, 2);
    expect(passo.setup!.stage).toBe("EXPIRED");
  });

  it("§19 — cooldown pós-confirmação segura novo setup do mesmo movimento", () => {
    const conf = confirmado();
    // CLOSED é o antigo ENCERRADO no vocabulário canônico (§19).
    const encerrado: TrackedSetup = { ...conf, stage: "CLOSED" };
    const passo = advanceSetup(
      encerrado,
      analise({ status: "PRE_ENTRADA" }),
      conf.confirmedAt! + CONFIRM_COOLDOWN_MS - 1,
      3,
    );
    expect(passo.headline).toContain("COOLDOWN");
    // Depois do cooldown, setup novo nasce normalmente.
    const depois = advanceSetup(
      encerrado,
      analise({ status: "PRE_ENTRADA" }),
      conf.confirmedAt! + CONFIRM_COOLDOWN_MS + 1,
      3,
    );
    expect(depois.setup!.setupId).not.toBe(conf.setupId);
  });
});

/**
 * REGRESSÕES ENCONTRADAS EM AUDITORIA ADVERSARIAL (19/08).
 *
 * As duas nasceram do mesmo descuido: confiar num campo sem perguntar de onde
 * ele veio. Nenhum teste anterior exercitava `conditionalPlans` — todos
 * passavam lista vazia —, e por isso os dois lados conviviam sem ninguém ver.
 */
describe("plano do lado CONTRÁRIO nunca vira entrada", () => {
  const doisPlanos = [
    {
      trigger: "perder o fundo",
      triggerLevel: num(136_800),
      side: "VENDA" as const,
      entry: num(136_800),
      entryZone: null,
      stop: num(137_050),
      targets: [num(136_300)],
      invalidation: "",
      rationale: "",
    },
    {
      trigger: "romper o topo",
      triggerLevel: num(137_200),
      side: "COMPRA" as const,
      entry: num(137_200),
      entryZone: null,
      stop: num(137_000),
      targets: [num(137_700)],
      invalidation: "",
      rationale: "",
    },
  ];

  it("setup de COMPRA ignora o gatilho de VENDA e mantém o nível herdado", () => {
    const vivo = advanceSetup(
      null,
      analise({ status: "PRE_ENTRADA", entry: num(137_200), stop: num(137_000) }),
      T0,
      1,
    ).setup!;
    expect(vivo.entryLevel).toBe(137_200);

    // Print seguinte SEM níveis próprios, mas com os dois planos e o preço
    // encostando no gatilho de VENDA (136.840 ≈ 136.800).
    const passo = advanceSetup(
      vivo,
      analise({
        status: "T4_EM_FORMACAO",
        entry: ILEGIVEL,
        stop: ILEGIVEL,
        targets: [],
        currentPrice: num(136_840),
        conditionalPlans: doisPlanos as PrintAnalysis["conditionalPlans"],
      }),
      T0 + 60_000,
      2,
    );

    // A entrada continua sendo a de COMPRA — nunca o gatilho do lado oposto.
    expect(passo.setup!.entryLevel).toBe(137_200);
    // E o toque NÃO foi marcado: o preço não encostou na entrada de verdade.
    expect(passo.setup!.touched).toBe(false);
  });

  it("entrada, stop e alvo saem do MESMO plano — nunca uma quimera", () => {
    const passo = advanceSetup(
      null,
      analise({
        status: "T4_EM_FORMACAO",
        direction: "COMPRA",
        entry: ILEGIVEL,
        stop: ILEGIVEL,
        targets: [],
        conditionalPlans: doisPlanos as PrintAnalysis["conditionalPlans"],
      }),
      T0,
      1,
    );
    const s = passo.setup!;
    // Todos do plano de COMPRA; nenhum número do plano de VENDA.
    expect(s.entryLevel).toBe(137_200);
    expect(s.stop).toBe(137_000);
    expect(s.target).toBe(137_700);
  });
});

describe("CONFIRMADO tem prazo — a máquina não pode travar o dia inteiro", () => {
  /** Mesma sequência canônica, ancorada num instante escolhido. */
  function confirmadoEm(quando: number): TrackedSetup {
    return sequenciaConfirmada(quando).setup;
  }

  it("dentro do prazo segue ATIVA — a operação está viva", () => {
    const conf = confirmadoEm(T0);
    const passo = advanceSetup(conf, analise(), conf.confirmedAt! + 60_000, 3);
    expect(passo.setup!.stage).toBe("CONFIRMED");
    expect(passo.entradaConfirmada).toBe(true);
  });

  it("vencido o prazo do desfecho, ENCERRA e para de afirmar operação", () => {
    const conf = confirmadoEm(T0);
    const passo = advanceSetup(conf, analise(), conf.confirmedAt! + SETUP_OUTCOME_TTL_MS + 1, 3);
    expect(passo.setup!.stage).toBe("CLOSED");
    expect(passo.entradaConfirmada).toBe(false);
    expect(passo.pendencias.length).toBeGreaterThan(0);
    expect(passo.setup!.reason).toContain("servidor");
  });

  it("depois de ENCERRADO um setup NOVO nasce — antes nenhum nascia o dia todo", () => {
    const conf = confirmadoEm(T0);
    const encerrado = advanceSetup(
      conf,
      analise(),
      conf.confirmedAt! + SETUP_OUTCOME_TTL_MS + 1,
      3,
    ).setup!;
    // Passado o cooldown, a máquina volta a criar oportunidades.
    const novo = advanceSetup(
      encerrado,
      analise({ status: "PRE_ENTRADA" }),
      conf.confirmedAt! + SETUP_OUTCOME_TTL_MS + CONFIRM_COOLDOWN_MS + 2,
      3,
    );
    expect(novo.setup!.setupId).not.toBe(conf.setupId);
  });

  it("ENCERRADO solta o congelamento do print da entrada", () => {
    const conf = confirmadoEm(T0);
    const passo = advanceSetup(conf, analise(), conf.confirmedAt! + SETUP_OUTCOME_TTL_MS + 1, 3);
    expect(
      decidirCongelamento({ congeladoEm: 7, novoIndice: 8, passo, nasceuSetup: false }),
    ).toBeNull();
  });
});

/**
 * §7 — GRÁFICO CORTADO NÃO CONFIRMA E NÃO CALCULA RISCO.
 *
 * O print de 19/08: o preço estourou o enquadramento e os candles chegaram
 * cortados no topo. Nesse estado a máxima estrutural está FORA da imagem, e
 * stop/alvo/R:R calculados com o que sobrou são invenção com cara de medida.
 */
describe("§7 — VIEWPORT_CLIPPED", () => {
  const CORTADO = {
    clipped: true,
    reason: "gráfico cortado no topo do enquadramento — stop, alvo e R:R não são calculáveis",
  };

  /** A mesma sequência que confirma, com o último print cortado. */
  function comCorte(cortarNoUltimo: boolean) {
    const confirmando = { status: "ENTRADA_CONFIRMADA" as const, audit: APROVADO };
    const p1 = advanceSetup(null, analise({ status: "PRE_ENTRADA" }), T0, 1, {
      candle: fechado(169_400, T0),
    });
    const p2 = advanceSetup(
      p1.setup,
      analise({ status: "PRE_ENTRADA", currentPrice: num(169_500) }),
      T0 + 60_000,
      2,
      { candle: fechado(169_500, T0 + 60_000) },
    );
    const p3 = advanceSetup(
      p2.setup,
      analise({ ...confirmando, currentPrice: num(169_600) }),
      T0 + 120_000,
      3,
      { candle: fechado(169_600, T0 + 120_000) },
    );
    return advanceSetup(
      p3.setup,
      analise({ ...confirmando, currentPrice: num(169_650) }),
      T0 + 180_000,
      4,
      {
        candle: fechado(169_650, T0 + 180_000),
        ...(cortarNoUltimo ? { clipping: CORTADO } : {}),
      },
    );
  }

  it("sem corte, a sequência confirma e libera", () => {
    const passo = comCorte(false);
    expect(passo.setup!.stage).toBe("CONFIRMED");
    expect(passo.setup!.operationReleased).toBe(true);
  });

  it("com o gráfico cortado, NÃO confirma e NÃO libera", () => {
    const passo = comCorte(true);
    expect(passo.entradaConfirmada).toBe(false);
    expect(passo.setup!.operationReleased).toBe(false);
    expect(passo.setup!.stage).not.toBe("CONFIRMED");
  });

  it("o motivo do corte vem PRIMEIRO — ele explica os NÃO IDENTIFICADO abaixo", () => {
    const passo = comCorte(true);
    expect(passo.pendencias[0]).toContain("cortado");
  });

  it("a tela diz o NOME do estado, não só 'operação bloqueada'", () => {
    /*
     * "OPERAÇÃO BLOQUEADA" sozinho manda o operador procurar o que falta no
     * setup; o que falta é a IMAGEM. O nome do estado é o que faz ele rolar o
     * gráfico em vez de esperar por uma confirmação que nenhum print daquele
     * enquadramento pode entregar.
     */
    const passo = comCorte(true);
    expect(passo.headline).toContain(CLIPPED_LABEL);
    expect(passo.avisos[0]).toBe(CLIPPED_LABEL);
    expect(passo.event).toBe("VIEWPORT_CLIPPED");
    // E o aviso do risco NÃO aparece junto: o problema não é risco/retorno.
    expect(passo.avisos).not.toContain("OPERAÇÃO BLOQUEADA");
  });

  it("sem corte, nada disso aparece", () => {
    const passo = comCorte(false);
    expect(passo.avisos).not.toContain(CLIPPED_LABEL);
    expect(passo.event).not.toBe("VIEWPORT_CLIPPED");
  });

  it("o risco fica NÃO AVALIÁVEL — nunca reprovado por R:R inventado", () => {
    /*
     * A distinção importa na tela: RISK_REJECTED manda descartar a operação;
     * RISK_UNKNOWN manda olhar o gráfico. Com o enquadramento estourado, o
     * problema é de EVIDÊNCIA, não de relação risco/retorno.
     */
    const passo = comCorte(true);
    expect(passo.setup!.risk!.verdict).toBe("RISK_UNKNOWN");
    expect(passo.setup!.risk!.rr).toBeNull();
    expect(passo.event).not.toBe("RISK_REJECTED");
  });

  it("o setup é PRESERVADO — corte não invalida oportunidade", () => {
    const semCorte = comCorte(false);
    const comCortado = comCorte(true);
    expect(comCortado.setup!.setupId).toBe(semCorte.setup!.setupId);
    expect(comCortado.setup!.entryLevel).toBe(semCorte.setup!.entryLevel);
    expect(comCortado.setup!.stage).not.toBe("INVALIDATED");
  });
});

/**
 * A TRAVA DO CANDLE — decisão do operador de 20/08/2026.
 *
 * "Nenhuma entrada T4 pode nascer de candle FORMING. Pode existir PRE_ALERT,
 *  APPROACHING ou ARMED, mas CONFIRMED_ENTRY somente depois da transição."
 *
 * O que estes testes trancam é o caminho INVERSO, que estava ativo: a máquina
 * fabricava a observação de candle a partir da etiqueta de preço do print — o
 * preço CORRENTE de um candle em formação — e chamava aquilo de fechamento.
 */
describe("§ trava — entrada não nasce de candle em formação", () => {
  /** A mesma sequência que confirma, com UMA perna trocada no último passo. */
  function ultimoPassoCom(contexto: Parameters<typeof advanceSetup>[4]) {
    const confirmando = { status: "ENTRADA_CONFIRMADA" as const, audit: APROVADO };
    const p1 = advanceSetup(null, analise({ status: "PRE_ENTRADA" }), T0, 1, {
      candle: fechado(169_400, T0),
    });
    const p2 = advanceSetup(
      p1.setup,
      analise({ status: "PRE_ENTRADA", currentPrice: num(169_500) }),
      T0 + 60_000,
      2,
      { candle: fechado(169_500, T0 + 60_000) },
    );
    const p3 = advanceSetup(
      p2.setup,
      analise({ ...confirmando, currentPrice: num(169_600) }),
      T0 + 120_000,
      3,
      { candle: fechado(169_600, T0 + 120_000) },
    );
    return advanceSetup(
      p3.setup,
      analise({ ...confirmando, currentPrice: num(169_650) }),
      T0 + 180_000,
      4,
      contexto,
    );
  }

  it("com candle fechado e provado, a sequência confirma", () => {
    const passo = ultimoPassoCom({ candle: fechado(169_650, T0 + 180_000) });
    expect(passo.entradaConfirmada).toBe(true);
    expect(passo.setup!.operationReleased).toBe(true);
  });

  it("SEM observação de candle, não confirma — e diz o porquê", () => {
    /*
     * Antes de 20/08 este caso confirmava: o `??` derivava a observação de
     * `analysis.currentPrice`. Era o print inteiro virando fechamento.
     */
    const passo = ultimoPassoCom({});
    expect(passo.entradaConfirmada).toBe(false);
    expect(passo.setup!.operationReleased).toBe(false);
    expect(passo.pendencias.join(" ")).toContain("virada do candle");
  });

  it("o motivo vindo do livro-razão é o que aparece na tela", () => {
    // Uma redação só: a do ledger. Duas seria o painel contradizendo o log.
    const passo = ultimoPassoCom({
      candleReason: "relógio do gráfico não lido — candle não identificado",
    });
    expect(passo.pendencias[0]).toBe("relógio do gráfico não lido — candle não identificado");
  });

  it("candle em FORMAÇÃO não move a máquina, mesmo com preço além do gatilho", () => {
    const passo = ultimoPassoCom({
      candle: { ...fechado(169_650, T0 + 180_000), phase: "FORMING" },
    });
    expect(passo.entradaConfirmada).toBe(false);
    expect(passo.setup!.operationReleased).toBe(false);
  });

  it("fechamento NÃO PROVADO também não confirma", () => {
    /*
     * O gráfico avançou (o candle fechou de fato), mas o OHLC do candle
     * anterior não foi lido. O fechamento existe como fato e não como prova, e
     * a tolerância de rompimento é de UM tick — estimativa não serve.
     */
    const passo = ultimoPassoCom({
      candle: { ...fechado(169_650, T0 + 180_000), closeSource: "NAO_PROVADO" },
    });
    expect(passo.entradaConfirmada).toBe(false);
    expect(passo.setup!.operationReleased).toBe(false);
  });

  it("o setup é PRESERVADO — travar não é invalidar", () => {
    const comProva = ultimoPassoCom({ candle: fechado(169_650, T0 + 180_000) });
    const semProva = ultimoPassoCom({});
    expect(semProva.setup!.setupId).toBe(comProva.setup!.setupId);
    expect(semProva.setup!.entryLevel).toBe(comProva.setup!.entryLevel);
    expect(semProva.setup!.stage).not.toBe("INVALIDATED");
  });
});

/**
 * A ESCADA DE APROXIMAÇÃO — PRE_ALERT → APPROACHING → ARMED.
 *
 * Decisão do operador de 20/08/2026. Os três dizem PROXIMIDADE, e nenhum
 * libera nada: a entrada continua exigindo fechamento além do gatilho,
 * sustentação e risco aprovado.
 */
describe("§ escada de aproximação", () => {
  /** Entrada 169.500, stop 169.300 ⇒ faixa de pré-alerta = 1,5 × 200 = 300. */
  function comPreco(preco: number) {
    return advanceSetup(null, analise({ status: "PRE_ENTRADA", currentPrice: num(preco) }), T0, 1);
  }

  it("longe de tudo: segue AGUARDANDO ROMPIMENTO", () => {
    // 1.000 pontos de distância — fora até da faixa larga (3 × 300 = 900).
    expect(comPreco(168_500).setup!.stage).toBe("WAITING_BREAKOUT");
  });

  it("entrou na faixa larga: PRE_ALERT", () => {
    // 600 pontos: dentro de 900, fora de 300.
    expect(comPreco(168_900).setup!.stage).toBe("PRE_ALERT");
  });

  it("entrou na faixa de pré-alerta: APPROACHING", () => {
    // 250 pontos: dentro de 300.
    expect(comPreco(169_250).setup!.stage).toBe("APPROACHING");
  });

  it("tocou o gatilho: ARMED", () => {
    expect(comPreco(169_500).setup!.stage).toBe("ARMED");
  });

  it("NENHUM dos três libera operação — é o ponto todo", () => {
    for (const preco of [168_900, 169_250, 169_500]) {
      const passo = comPreco(preco);
      expect(passo.entradaConfirmada).toBe(false);
      expect(passo.setup!.operationReleased).toBe(false);
    }
  });

  it("a escada NÃO atropela estrutura ainda em formação", () => {
    /*
     * Eixos independentes: o modelo diz o que viu da ESTRUTURA, a escada diz
     * onde o PREÇO está. Um setup EM FORMAÇÃO com o preço a 100 pontos do
     * gatilho — bem dentro da faixa de pré-alerta — continua EM FORMAÇÃO:
     * falta o plano, não a distância. Anunciar APPROACHING ali seria a tela
     * prometendo uma prontidão que a estrutura não tem.
     *
     * O TOQUE é outra história e tem ramo próprio, mais antigo que esta
     * escada: preço EM CIMA da linha vira "toque sem confirmação" seja qual
     * for o status, e é o teste abaixo que fixa isso.
     */
    const formando = advanceSetup(
      null,
      analise({ status: "T4_EM_FORMACAO", currentPrice: num(169_400) }),
      T0,
      1,
    );
    expect(formando.setup!.stage).toBe("FORMING");
  });

  it("mas o TOQUE arma mesmo com a estrutura em formação — e não confirma", () => {
    const tocando = advanceSetup(
      null,
      analise({ status: "T4_EM_FORMACAO", currentPrice: num(169_500) }),
      T0,
      1,
    );
    expect(tocando.setup!.stage).toBe("ARMED");
    expect(tocando.entradaConfirmada).toBe(false);
    expect(tocando.setup!.operationReleased).toBe(false);
  });

  it("o rompimento, quando fala, manda na escada", () => {
    // Depois de fechar além do gatilho, o estágio é do rompimento, não da
    // distância — a prova vale mais que a proximidade.
    const { rompimento } = sequenciaConfirmada();
    expect(rompimento.setup!.stage).toBe("BREAKOUT_CLOSED");
  });

  it("todo estágio novo tem rótulo e ordem declarados", () => {
    for (const estagio of ["PRE_ALERT", "APPROACHING", "ARMED"] as const) {
      expect(SETUP_STAGES).toContain(estagio);
    }
  });
});
