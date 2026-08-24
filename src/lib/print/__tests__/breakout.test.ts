import { describe, expect, it } from "vitest";

import {
  breakoutTolerance,
  initBreakout,
  isTerminalBreakout,
  observeClose,
  pendenciasDoRompimento,
  rearm,
  rompimentoLibera,
  type BreakoutState,
  type CandleObservation,
} from "../breakout";

/**
 * A MÁQUINA DO ROMPIMENTO EM TESTE (§14–§18).
 *
 * Os números não são inventados: são os do print que o operador mandou em
 * 19/08 — gatilho 170.925, o candle que fechou em 171.050 e o seguinte que
 * devolveu para 170.800. Reproduzir a sessão real aqui é o que impede a regra
 * antiga ("um fechamento basta") de voltar sem que ninguém perceba.
 */

const T0 = Date.UTC(2026, 7, 19, 13, 0, 0);
const CANDLE = 60_000;
const GATILHO = 170_925;

/** Um estado novo de COMPRA sobre o gatilho da sessão real. */
function compra(tolerance = 5): BreakoutState {
  return initBreakout({ side: "COMPRA", trigger: GATILHO, tolerance });
}

function venda(tolerance = 5): BreakoutState {
  return initBreakout({ side: "VENDA", trigger: GATILHO, tolerance });
}

/**
 * Observação de um candle FECHADO, um por minuto a partir de T0.
 *
 * `phase`/`closeSource` explícitos: desde 20/08 a máquina só aceita fechamento
 * PROVADO (lido do desenho do candle anterior), e o padrão do helper é a
 * observação boa — cada teste que quer exercitar a recusa passa a sua.
 */
function obs(indice: number, close: number, extra: Partial<CandleObservation> = {}) {
  return {
    close,
    candleTime: T0 + indice * CANDLE,
    at: T0 + indice * CANDLE + 900,
    phase: "CLOSED" as const,
    closeSource: "MODELO" as const,
    ...extra,
  };
}

/** Roda uma sequência de fechamentos e devolve todos os estados. */
function rodar(inicial: BreakoutState, closes: number[]): BreakoutState[] {
  const estados: BreakoutState[] = [];
  let atual = inicial;
  closes.forEach((close, i) => {
    atual = observeClose(atual, obs(i, close));
    estados.push(atual);
  });
  return estados;
}

describe("tolerância de rompimento", () => {
  it("um fechamento tem de ser além DE VERDADE — a tolerância é o tick", () => {
    // Sem instrumento conhecido, uma fração pequena do preço. O ponto é ela
    // ser MUITO menor que a tolerância de toque (0,03% = 51 pts em 170.925):
    // com 51 pontos de folga, um candle que devolvesse 45 pontos abaixo do
    // gatilho não contaria como devolução — e o falso rompimento passaria.
    const t = breakoutTolerance(GATILHO, null);
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThan(GATILHO * 0.0003);
  });

  it("estado novo nasce esperando o rompimento, sem nada provado", () => {
    const s = compra();
    expect(s.phase).toBe("WAITING_BREAKOUT");
    expect(s.triggerTouched).toBe(false);
    expect(s.breakoutClosed).toBe(false);
    expect(s.breakoutSustained).toBe(false);
    expect(s.retestConfirmed).toBe(false);
    expect(s.setupConfirmed).toBe(false);
    expect(rompimentoLibera(s)).toBe(false);
    expect(rompimentoLibera(null)).toBe(false);
  });
});

describe("§14 — toque e pavio NÃO confirmam", () => {
  it("pavio cruzando o gatilho marca TOQUE e nada mais", () => {
    // O candle vai até 171.100 (acima do gatilho) mas FECHA em 170.880.
    const s = observeClose(compra(), obs(0, 170_880, { high: 171_100 }));
    expect(s.triggerTouched).toBe(true);
    expect(s.breakoutClosed).toBe(false);
    expect(s.phase).toBe("WAITING_BREAKOUT");
    expect(rompimentoLibera(s)).toBe(false);
    expect(pendenciasDoRompimento(s).join(" ")).not.toBe("");
  });

  it("fechamento EM CIMA do gatilho não é além dele", () => {
    const s = observeClose(compra(), obs(0, GATILHO));
    expect(s.breakoutClosed).toBe(false);
    expect(s.phase).toBe("WAITING_BREAKOUT");
  });

  it("na VENDA, o pavio para baixo também só marca toque", () => {
    const s = observeClose(venda(), obs(0, 170_960, { low: 170_800 }));
    expect(s.triggerTouched).toBe(true);
    expect(s.breakoutClosed).toBe(false);
    expect(s.phase).toBe("WAITING_BREAKOUT");
  });
});

describe("§15–§16 — fechar não basta; sustentar ou retestar confirma", () => {
  it("o fechamento além ABRE o caso e NÃO libera", () => {
    const s = observeClose(compra(), obs(0, 171_050));
    expect(s.breakoutClosed).toBe(true);
    expect(s.phase).toBe("BREAKOUT_CLOSED");
    expect(s.setupConfirmed).toBe(false);
    expect(rompimentoLibera(s)).toBe(false);
    expect(pendenciasDoRompimento(s).join(" ")).toContain("sustent");
  });

  it("o candle SEGUINTE sustentando confirma (§16)", () => {
    const [, segundo] = rodar(compra(), [171_050, 171_120]);
    expect(segundo!.breakoutSustained).toBe(true);
    expect(segundo!.setupConfirmed).toBe(true);
    expect(segundo!.phase).toBe("CONFIRMED");
    expect(rompimentoLibera(segundo!)).toBe(true);
    expect(pendenciasDoRompimento(segundo!)).toEqual([]);
  });

  it("reteste com rejeição confirma pelo outro caminho", () => {
    // Fecha acima, volta a encostar no gatilho e fecha de novo acima.
    const estados = rodar(compra(), [171_050, GATILHO, 171_060]);
    expect(estados[1]!.phase).toBe("WAITING_SUSTAIN");
    expect(estados[1]!.setupConfirmed).toBe(false);
    const final = estados[2]!;
    expect(final.setupConfirmed).toBe(true);
    expect(final.phase).toBe("CONFIRMED");
  });

  it("VENDA é simétrica: rompe para baixo e sustenta", () => {
    const [, segundo] = rodar(venda(), [170_800, 170_730]);
    expect(segundo!.breakoutClosed).toBe(true);
    expect(segundo!.breakoutSustained).toBe(true);
    expect(segundo!.phase).toBe("CONFIRMED");
  });

  it("a fórmula é derivada, nunca escrita à mão", () => {
    const [, segundo] = rodar(compra(), [171_050, 171_120]);
    expect(segundo!.setupConfirmed).toBe(
      segundo!.breakoutClosed && (segundo!.breakoutSustained || segundo!.retestConfirmed),
    );
  });
});

describe("§17 — CASO A do aceite: o falso rompimento da sessão de 19/08", () => {
  /** 170.800 → gatilho 170.925 → fecha 171.050 → o seguinte fecha 170.800. */
  function casoA(): BreakoutState[] {
    return rodar(compra(), [170_800, 171_050, 170_800]);
  }

  it("o desfecho é BREAKOUT_FAILED, sem entrada e sem liberação", () => {
    const final = casoA()[2]!;
    expect(final.phase).toBe("BREAKOUT_FAILED");
    expect(final.setupConfirmed).toBe(false);
    expect(rompimentoLibera(final)).toBe(false);
    expect(final.failureReason).not.toBeNull();
  });

  it("o passo ANTERIOR — o que a regra antiga liberava — não libera", () => {
    const rompimento = casoA()[1]!;
    expect(rompimento.breakoutClosed).toBe(true);
    expect(rompimento.setupConfirmed).toBe(false);
    expect(rompimento.phase).toBe("BREAKOUT_CLOSED");
  });

  it("o evento fica no histórico — o caso ensina, não some", () => {
    const final = casoA()[2]!;
    expect(final.history.some((e) => e.kind === "BREAKOUT_FAILED")).toBe(true);
    expect(final.history.some((e) => e.kind === "BREAKOUT_CLOSED")).toBe(true);
  });

  it("falha é TERMINAL: nem um fechamento excelente depois a ressuscita", () => {
    const falho = casoA()[2]!;
    expect(isTerminalBreakout(falho.phase)).toBe(true);
    const depois = observeClose(falho, obs(9, 171_500));
    expect(depois.phase).toBe("BREAKOUT_FAILED");
    expect(depois.setupConfirmed).toBe(false);
  });

  it("na VENDA o espelho vale igual", () => {
    const final = rodar(venda(), [171_050, 170_800, 171_050])[2]!;
    expect(final.phase).toBe("BREAKOUT_FAILED");
    expect(final.setupConfirmed).toBe(false);
  });

  it("rearmar é EXPLÍCITO e registrado — nunca automático", () => {
    const falho = rodar(compra(), [170_800, 171_050, 170_800])[2]!;
    const novo = rearm(
      falho,
      171_200,
      "estrutura nova depois do falso rompimento",
      T0 + 9 * CANDLE,
    );
    expect(novo.phase).toBe("WAITING_BREAKOUT");
    expect(novo.trigger).toBe(171_200);
    expect(novo.setupConfirmed).toBe(false);
    expect(novo.breakoutClosed).toBe(false);
  });
});

describe("§18 — o mesmo candle não anda a máquina duas vezes", () => {
  it("reobservar o MESMO candle é no-op", () => {
    const um = observeClose(compra(), obs(0, 171_050));
    const dois = observeClose(um, obs(0, 171_050));
    expect(dois).toBe(um);
    expect(dois.phase).toBe("BREAKOUT_CLOSED");
  });

  it("dez observações do mesmo candle produzem UMA transição", () => {
    let s = compra();
    for (let i = 0; i < 10; i += 1) s = observeClose(s, obs(0, 171_050));
    expect(s.phase).toBe("BREAKOUT_CLOSED");
    expect(s.setupConfirmed).toBe(false);
    // E nenhuma sustentação fabricada por repetição.
    expect(s.breakoutSustained).toBe(false);
    expect(s.history.filter((e) => e.kind === "BREAKOUT_CLOSED")).toHaveLength(1);
  });

  it("observação FORA DE ORDEM não move a fase — e fica registrada", () => {
    /*
     * Estado NÃO terminal de propósito: uma fase terminal (CONFIRMED,
     * BREAKOUT_FAILED) sai antes de qualquer leitura, e é o comportamento
     * certo — caso encerrado não reabre nem para registrar. O que este teste
     * protege é o meio do caminho: análise lenta que volta depois de um candle
     * mais novo continua valendo como registro e NÃO como estado.
     */
    const rompeu = observeClose(compra(), obs(5, 171_050));
    expect(rompeu.phase).toBe("BREAKOUT_CLOSED");
    const atrasada = observeClose(rompeu, obs(2, 170_500));
    expect(atrasada.phase).toBe("BREAKOUT_CLOSED");
    expect(atrasada.setupConfirmed).toBe(false);
    expect(atrasada.history.some((e) => e.kind === "OUT_OF_ORDER")).toBe(true);
  });

  it("fase terminal não aceita nem registro — caso encerrado é encerrado", () => {
    const confirmado = rodar(compra(), [171_050, 171_120])[1]!;
    expect(isTerminalBreakout(confirmado.phase)).toBe(true);
    expect(observeClose(confirmado, obs(0, 170_500))).toBe(confirmado);
  });
});

describe("pendências: bloquear em silêncio nunca", () => {
  it("estado que não libera SEMPRE diz o que falta", () => {
    const casos: BreakoutState[] = [
      compra(),
      observeClose(compra(), obs(0, 170_880, { high: 171_100 })),
      observeClose(compra(), obs(0, 171_050)),
      rodar(compra(), [170_800, 171_050, 170_800])[2]!,
    ];
    for (const estado of casos) {
      expect(rompimentoLibera(estado)).toBe(false);
      expect(pendenciasDoRompimento(estado).length).toBeGreaterThan(0);
    }
  });

  it("sem estado, este módulo se cala — quem fala é a camada de setup", () => {
    /*
     * Lista vazia aqui NÃO é bloqueio silencioso: sem estado de rompimento não
     * existe gatilho legível, e a pendência correta ("sem gatilho") pertence à
     * máquina de setup, que é quem sabe disso. Fabricar uma frase aqui faria
     * este módulo afirmar sobre algo que ele não observou — e a tela mostraria
     * duas explicações para a mesma falta.
     */
    expect(pendenciasDoRompimento(null)).toEqual([]);
    // O que importa continua garantido: sem estado, nada é liberado.
    expect(rompimentoLibera(null)).toBe(false);
  });

  it("confirmado é o ÚNICO que não tem pendência", () => {
    const confirmado = rodar(compra(), [171_050, 171_120])[1]!;
    expect(pendenciasDoRompimento(confirmado)).toEqual([]);
  });
});
