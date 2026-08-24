/**
 * O QUE ESTES TESTES TRANCAM.
 *
 * O operador não fica olhando a tela. Isso só funciona se duas coisas forem
 * verdade sempre: (1) o print do instante da decisão é IMUTÁVEL — o que ele viu
 * quando o alerta tocou é o que fica registrado; (2) cada instante alerta UMA
 * vez, na BORDA, e a aproximação nunca é confundida com a entrada.
 *
 * O defeito histórico que motiva o segundo grupo: só existia um alerta e ele
 * tocava no ARMAMENTO. Como `justArmed` é falso em ENTRADA_CONFIRMADA por
 * construção, a chave de dedupe já tinha sido consumida quando a entrada
 * confirmava — o operador ouvia "entrou" no "pode acontecer", e silêncio no
 * momento em que a técnica de fato fechava.
 */

import { describe, expect, it } from "vitest";

import { CofreDeEvidencias, type PrintCongelado } from "../entryFreeze";
import { justArmed, justConfirmed, IDLE_OPERATION, type T4Operation } from "../preEntry";

function print(over: Partial<PrintCongelado> = {}): PrintCongelado {
  return {
    setupId: "COMPRA:170500.0:170300.0",
    momento: "ENTRADA_CONFIRMADA",
    chartTimestamp: Date.UTC(2026, 7, 21, 13, 45, 0),
    capturadoEm: 1_777_000_000_000,
    asset: "WINFUT",
    direcao: "COMPRA",
    familia: "TREND_FIRST_PULLBACK",
    estagio: "ENTRADA_CONFIRMADA",
    maturidade: 100,
    niveis: { entrada: 170_500, stop: 170_300, alvo1: 171_100, alvo2: 171_500, rr: 3 },
    precoAtual: 170_520,
    precoConfiavel: true,
    motivo: "gatilho cumprido com candle fechado",
    confluencias: ["estrutura", "liquidez"],
    candle: { t: 1, o: 170_400, h: 170_560, l: 170_380, c: 170_520, v: 0 },
    imagem: "data:image/jpeg;base64,AAAA",
    frameHash: "hash-1",
    versaoDaTecnica: "T4.0.0",
    ...over,
  };
}

function op(over: Partial<T4Operation> = {}): T4Operation {
  return { ...IDLE_OPERATION, ...over };
}

describe("cofre de evidências — o print congelado é imutável", () => {
  it("congela e devolve o registro dos dois instantes separados", () => {
    const cofre = new CofreDeEvidencias();
    expect(cofre.congelar(print({ momento: "APROXIMACAO", maturidade: 70 }))).toBe(true);
    expect(cofre.congelar(print())).toBe(true);

    const r = cofre.registro("COMPRA:170500.0:170300.0");
    expect(r?.aproximacao?.maturidade).toBe(70);
    expect(r?.confirmacao?.maturidade).toBe(100);
  });

  it("a SEGUNDA gravação do mesmo instante é recusada — nunca sobrescreve", () => {
    const cofre = new CofreDeEvidencias();
    expect(
      cofre.congelar(
        print({ niveis: { entrada: 170_500, stop: 170_300, alvo1: null, alvo2: null, rr: 3 } }),
      ),
    ).toBe(true);
    // Uma decisão nova chegou com outros níveis: NÃO pode reescrever o que o
    // operador viu quando o alerta tocou.
    expect(
      cofre.congelar(
        print({ niveis: { entrada: 999_999, stop: 1, alvo1: null, alvo2: null, rr: 9 } }),
      ),
    ).toBe(false);
    expect(cofre.registro("COMPRA:170500.0:170300.0")?.confirmacao?.niveis.entrada).toBe(170_500);
  });

  it("o registro gravado é congelado de fato — mutação silenciosa não passa", () => {
    const cofre = new CofreDeEvidencias();
    cofre.congelar(print());
    const gravado = cofre.registro("COMPRA:170500.0:170300.0")!.confirmacao!;
    expect(Object.isFrozen(gravado)).toBe(true);
    expect(Object.isFrozen(gravado.niveis)).toBe(true);
  });

  it("jaCongelado responde por instante, não por setup", () => {
    const cofre = new CofreDeEvidencias();
    cofre.congelar(print({ momento: "APROXIMACAO" }));
    expect(cofre.jaCongelado("COMPRA:170500.0:170300.0", "APROXIMACAO")).toBe(true);
    expect(cofre.jaCongelado("COMPRA:170500.0:170300.0", "ENTRADA_CONFIRMADA")).toBe(false);
  });

  it("confirmacoes() lista só as entradas confirmadas", () => {
    const cofre = new CofreDeEvidencias();
    cofre.congelar(print({ setupId: "a", momento: "APROXIMACAO" }));
    cofre.congelar(print({ setupId: "b", momento: "APROXIMACAO" }));
    cofre.congelar(print({ setupId: "b" }));
    expect(cofre.confirmacoes().map((p) => p.setupId)).toEqual(["b"]);
  });

  it("o teto de setups não deixa a sessão crescer sem fim", () => {
    const cofre = new CofreDeEvidencias(2);
    cofre.congelar(print({ setupId: "1" }));
    cofre.congelar(print({ setupId: "2" }));
    cofre.congelar(print({ setupId: "3" }));
    expect(cofre.todos().map((r) => r.setupId)).toEqual(["2", "3"]);
  });
});

describe("as duas bordas: aproximação e confirmação", () => {
  const armado = op({ stage: "GATILHO_PROXIMO", setupId: "s1", direction: "COMPRA" });
  const confirmado = op({
    stage: "ENTRADA_CONFIRMADA",
    setupId: "s1",
    direction: "COMPRA",
    confirmed: true,
  });

  it("APROXIMAÇÃO dispara ao entrar em armado, e não na confirmação", () => {
    expect(justArmed(null, armado)).toBe(true);
    // A regra que criou o defeito: armado é falso em ENTRADA_CONFIRMADA.
    expect(justArmed(armado, confirmado)).toBe(false);
  });

  it("CONFIRMAÇÃO dispara na entrada em ENTRADA_CONFIRMADA — o que faltava", () => {
    expect(justConfirmed(armado, confirmado)).toBe(true);
    expect(justConfirmed(null, confirmado)).toBe(true);
  });

  it("confirmado que SEGUE confirmado não dispara de novo — é borda, não estado", () => {
    expect(justConfirmed(confirmado, confirmado)).toBe(false);
  });

  it("outro setup no mesmo estágio é outra oportunidade: dispara", () => {
    const outro = op({ ...confirmado, setupId: "s2" });
    expect(justConfirmed(confirmado, outro)).toBe(true);
  });

  it("estágio que não é confirmação nunca dispara a confirmação", () => {
    for (const stage of [
      "OBSERVANDO",
      "PREPARANDO_COMPRA",
      "GATILHO_PROXIMO",
      "INVALIDADA",
    ] as const) {
      expect(justConfirmed(null, op({ stage, setupId: "s1" }))).toBe(false);
    }
  });
});
