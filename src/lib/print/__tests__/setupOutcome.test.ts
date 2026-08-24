import { describe, expect, it } from "vitest";

import {
  SETUP_OUTCOME_TTL_MS,
  evaluateSetup,
  type OpenSetup,
  type SetupObservation,
} from "../setupOutcome";

/**
 * O QUE ESTES TESTES PROVAM: que o veredito do setup nasce SÓ do que foi
 * observado. Cada caso amarra uma regra que o operador declarou inegociável —
 * ordem alvo/stop, ambiguidade resolvida contra o operador, anti-look-ahead,
 * expiração e "sem observação = ABERTO".
 */

const T0 = 1_700_000_000_000;
const MIN = 60_000;

function compra(over: Partial<OpenSetup> = {}): OpenSetup {
  return {
    direction: "COMPRA",
    entry: 138_000,
    stop: 137_800,
    target: 138_600,
    confirmedAt: T0,
    expiresAt: T0 + SETUP_OUTCOME_TTL_MS,
    ...over,
  };
}

function venda(over: Partial<OpenSetup> = {}): OpenSetup {
  return {
    direction: "VENDA",
    entry: 138_000,
    stop: 138_200,
    target: 137_400,
    confirmedAt: T0,
    expiresAt: T0 + SETUP_OUTCOME_TTL_MS,
    ...over,
  };
}

function obs(minutos: number, price: number): SetupObservation {
  return { at: T0 + minutos * MIN, price };
}

describe("evaluateSetup — desfecho automático do setup confirmado", () => {
  it("COMPRA: alvo antes do stop é WIN, com o alvo dito no motivo", () => {
    const verdict = evaluateSetup(
      compra(),
      [obs(1, 138_100), obs(2, 138_350), obs(3, 138_620)],
      T0 + 4 * MIN,
    );

    expect(verdict.outcome).toBe("WIN");
    expect(verdict.at).toBe(T0 + 3 * MIN);
    expect(verdict.ambiguous).toBe(false);
    expect(verdict.reason).toContain("alvo");
    expect(verdict.reason).toContain("sem stop antes");
  });

  it("COMPRA: stop antes do alvo é LOSS", () => {
    const verdict = evaluateSetup(
      compra(),
      [obs(1, 137_950), obs(2, 137_790), obs(3, 138_700)],
      T0 + 4 * MIN,
    );

    expect(verdict.outcome).toBe("LOSS");
    expect(verdict.at).toBe(T0 + 2 * MIN);
    expect(verdict.ambiguous).toBe(false);
    expect(verdict.reason).toContain("stop");
  });

  it("VENDA: o lado inverte — alvo embaixo é WIN, stop em cima é LOSS", () => {
    const ganho = evaluateSetup(venda(), [obs(1, 137_900), obs(2, 137_380)], T0 + 3 * MIN);
    expect(ganho.outcome).toBe("WIN");
    expect(ganho.at).toBe(T0 + 2 * MIN);

    const perda = evaluateSetup(venda(), [obs(1, 138_100), obs(2, 138_250)], T0 + 3 * MIN);
    expect(perda.outcome).toBe("LOSS");
    expect(perda.at).toBe(T0 + 2 * MIN);
    expect(perda.ambiguous).toBe(false);
  });

  it("alvo E stop atravessados no mesmo passo: LOSS conservador com ambiguous=true", () => {
    /*
     * Níveis INCOERENTES saídos de uma leitura ruim de print (stop acima do
     * alvo numa COMPRA). Uma única amostra de 60s satisfaz as duas pontas ao
     * mesmo tempo: qual veio primeiro é informação que NÃO existe. A casa
     * resolve contra o operador — e diz que resolveu.
     */
    const verdict = evaluateSetup(
      compra({ entry: null, stop: 138_500, target: 138_400 }),
      [obs(1, 138_450)],
      T0 + 2 * MIN,
    );

    expect(verdict.outcome).toBe("LOSS");
    expect(verdict.ambiguous).toBe(true);
    expect(verdict.reason).toContain("ordem desconhecida");
    expect(verdict.reason).toContain("conservador");
  });

  it("salto entre duas amostras conta a travessia: nível ENTRE as leituras foi atingido", () => {
    // 138_100 → 137_700: o preço não podia chegar lá sem passar pelo stop
    // 137_800, mesmo que amostra nenhuma tenha caído exatamente nele.
    const verdict = evaluateSetup(compra(), [obs(1, 138_100), obs(2, 137_700)], T0 + 3 * MIN);

    expect(verdict.outcome).toBe("LOSS");
    expect(verdict.at).toBe(T0 + 2 * MIN);
    expect(verdict.ambiguous).toBe(false);
  });

  it("observação ANTERIOR à confirmação não conta (anti-look-ahead literal)", () => {
    const antes: SetupObservation = { at: T0 - MIN, price: 138_900 };
    const verdict = evaluateSetup(compra(), [antes, obs(1, 138_050)], T0 + 2 * MIN);

    // O alvo foi visitado ANTES de o setup existir — não é resultado dele.
    expect(verdict.outcome).toBe("ABERTO");
    expect(verdict.reason).toContain("1 observação");
  });

  it("sem alvo nem stop até o vencimento: EXPIRADO carimbado no vencimento", () => {
    const setup = compra();
    const verdict = evaluateSetup(setup, [obs(5, 138_050), obs(20, 138_120)], T0 + 60 * MIN);

    expect(verdict.outcome).toBe("EXPIRADO");
    expect(verdict.at).toBe(setup.expiresAt);
    expect(verdict.reason).toContain("45 min");
    expect(verdict.ambiguous).toBe(false);
  });

  it("observação DEPOIS do vencimento não ressuscita o setup", () => {
    // O alvo só apareceu 50 min depois; o setup já tinha expirado aos 45.
    const verdict = evaluateSetup(compra(), [obs(50, 139_000)], T0 + 55 * MIN);

    expect(verdict.outcome).toBe("EXPIRADO");
    expect(verdict.at).toBe(T0 + SETUP_OUTCOME_TTL_MS);
  });

  it("TTL sobrescrito por parâmetro quando o setup não trouxe prazo utilizável", () => {
    const semPrazo = compra({ expiresAt: 0 });

    // Aos 8 min ainda vive sob um TTL de 10 min...
    expect(evaluateSetup(semPrazo, [], T0 + 8 * MIN, 10 * MIN).outcome).toBe("ABERTO");
    // ...e aos 12 min já expirou por ele.
    const expirado = evaluateSetup(semPrazo, [], T0 + 12 * MIN, 10 * MIN);
    expect(expirado.outcome).toBe("EXPIRADO");
    expect(expirado.at).toBe(T0 + 10 * MIN);
    expect(expirado.reason).toContain("10 min");
  });

  it("setup sem observação nenhuma continua ABERTO, com o motivo dito", () => {
    const verdict = evaluateSetup(compra(), [], T0 + 5 * MIN);

    expect(verdict.outcome).toBe("ABERTO");
    expect(verdict.at).toBeNull();
    expect(verdict.reason).toContain("aguardando a primeira observação");
  });

  it("stop/alvo não numéricos fecham como INVALIDADO — nunca ficam pendurados", () => {
    const verdict = evaluateSetup(
      compra({ stop: Number.NaN, target: Number.NaN }),
      [obs(1, 138_500)],
      T0 + 2 * MIN,
    );

    expect(verdict.outcome).toBe("INVALIDADO");
    expect(verdict.reason).toContain("sem critério pré-definido");
  });

  it("preço ilegível na amostra é ignorado, não vira desfecho", () => {
    const verdict = evaluateSetup(
      compra(),
      [{ at: T0 + MIN, price: Number.NaN }, obs(2, 138_100)],
      T0 + 3 * MIN,
    );

    expect(verdict.outcome).toBe("ABERTO");
    expect(verdict.reason).toContain("1 observação");
  });
});
