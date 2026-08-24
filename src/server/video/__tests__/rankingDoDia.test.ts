import { describe, expect, it } from "vitest";

import { type CandidatoDoDia, compararCandidatos, elegivel, ranquearDia } from "../rankingDoDia";

/**
 * O ranking do dia, testado nos dois abusos que ele existe para impedir:
 * promover recusa para não fechar o dia zerado, e ordenar por resultado.
 */
function candidato(over: Partial<CandidatoDoDia> = {}): CandidatoDoDia {
  return {
    setupId: "T4-TESTE-001",
    segundoNoVideo: 10,
    dataDoGrafico: "2026-03-02",
    horaDoGrafico: "10:00",
    direcao: "COMPRA",
    entrada: 100_000,
    stop: 99_800,
    riscoPontos: 200,
    obstaculo: 100_800,
    espacoR: 4,
    origemDoObstaculo: "MEDIDO",
    origemDoStop: "ESTRUTURAL",
    confianca: 80,
    aprovadoNoGate: true,
    motivoDaRecusa: null,
    ...over,
  };
}

describe("elegibilidade", () => {
  it("recusado no gate NUNCA é elegível, por melhor que pareça", () => {
    // Espaço de 12R, obstáculo medido, stop estrutural — e recusado.
    const otimo = candidato({ espacoR: 12, aprovadoNoGate: false });
    expect(elegivel(otimo)).toBe(false);
  });

  it("risco zero é inelegível — não existe R com denominador zero", () => {
    expect(elegivel(candidato({ riscoPontos: 0 }))).toBe(false);
    expect(elegivel(candidato({ riscoPontos: -50 }))).toBe(false);
  });

  it("sem obstáculo conhecido não há espaço medido: inelegível", () => {
    expect(elegivel(candidato({ obstaculo: null }))).toBe(false);
    expect(elegivel(candidato({ espacoR: null }))).toBe(false);
  });

  it("aprovado no gate com tudo legível é elegível", () => {
    expect(elegivel(candidato())).toBe(true);
  });
});

describe("cascata de desempate", () => {
  it("1º critério: mais espaço em R vence", () => {
    const a = candidato({ espacoR: 5 });
    const b = candidato({ espacoR: 3 });
    expect(compararCandidatos(a, b)).toBeLessThan(0);
  });

  it("2º critério: com o mesmo espaço, obstáculo MEDIDO vence LIDO", () => {
    const medido = candidato({ origemDoObstaculo: "MEDIDO" });
    const lido = candidato({ origemDoObstaculo: "LIDO" });
    expect(compararCandidatos(medido, lido)).toBeLessThan(0);
  });

  it("3º critério: stop ESTRUTURAL vence PISO, que vence MODELO", () => {
    const estrutural = candidato({ origemDoStop: "ESTRUTURAL" });
    const piso = candidato({ origemDoStop: "PISO" });
    const modelo = candidato({ origemDoStop: "MODELO" });
    expect(compararCandidatos(estrutural, piso)).toBeLessThan(0);
    expect(compararCandidatos(piso, modelo)).toBeLessThan(0);
  });

  it("4º critério: para o mesmo R, arriscar menos pontos vence", () => {
    const magro = candidato({ riscoPontos: 150 });
    const gordo = candidato({ riscoPontos: 400 });
    expect(compararCandidatos(magro, gordo)).toBeLessThan(0);
  });

  it("6º critério garante ordem TOTAL: nada empata de verdade", () => {
    const cedo = candidato({ segundoNoVideo: 10 });
    const tarde = candidato({ segundoNoVideo: 90 });
    expect(compararCandidatos(cedo, tarde)).toBeLessThan(0);
    expect(compararCandidatos(tarde, cedo)).toBeGreaterThan(0);
  });

  it("é determinístico: a mesma lista ordena igual em qualquer ordem inicial", () => {
    const lista = [
      candidato({ setupId: "C", espacoR: 3, segundoNoVideo: 30 }),
      candidato({ setupId: "A", espacoR: 6, segundoNoVideo: 50 }),
      candidato({ setupId: "B", espacoR: 4, segundoNoVideo: 20 }),
    ];
    const direto = ranquearDia(lista).aprovados.map((c) => c.setupId);
    const invertido = ranquearDia([...lista].reverse()).aprovados.map((c) => c.setupId);
    expect(direto).toEqual(["A", "B", "C"]);
    expect(invertido).toEqual(direto);
  });
});

describe("ranquearDia", () => {
  it("dia sem aprovado é NO_TRADE — a recusa não sobe para o topo", () => {
    const r = ranquearDia([
      candidato({
        setupId: "R1",
        aprovadoNoGate: false,
        espacoR: 2.6,
        motivoDaRecusa: "SEM_ESPACO_3R:LIDO",
      }),
      candidato({
        setupId: "R2",
        aprovadoNoGate: false,
        espacoR: 1.1,
        motivoDaRecusa: "SEM_ESPACO_3R:LIDO",
      }),
    ]);
    expect(r.noTrade).toBe(true);
    expect(r.melhor).toBeNull();
    expect(r.aprovados).toHaveLength(0);
    expect(r.recusados).toHaveLength(2);
  });

  it("todo NO_TRADE traz o gate responsável CONTADO — regra absoluta nº 2", () => {
    const r = ranquearDia([
      candidato({ aprovadoNoGate: false, motivoDaRecusa: "SEM_ESPACO_3R:LIDO" }),
      candidato({ aprovadoNoGate: false, motivoDaRecusa: "SEM_ESPACO_3R:LIDO" }),
      candidato({ aprovadoNoGate: false, motivoDaRecusa: "SEM_ESPACO_3R:LADO_ERRADO" }),
    ]);
    expect(r.gatesResponsaveis).toEqual([
      { motivo: "SEM_ESPACO_3R:LIDO", ocorrencias: 2 },
      { motivo: "SEM_ESPACO_3R:LADO_ERRADO", ocorrencias: 1 },
    ]);
  });

  it("o melhor é o 1º da cascata, e recusados nunca entram em aprovados", () => {
    const r = ranquearDia([
      candidato({ setupId: "OK-1", espacoR: 3.2 }),
      candidato({ setupId: "OK-2", espacoR: 7.5 }),
      candidato({ setupId: "REC", aprovadoNoGate: false, espacoR: 99 }),
    ]);
    expect(r.noTrade).toBe(false);
    expect(r.melhor?.setupId).toBe("OK-2");
    expect(r.melhor?.posicao).toBe(1);
    expect(r.aprovados.map((c) => c.setupId)).toEqual(["OK-2", "OK-1"]);
    expect(r.recusados.map((c) => c.setupId)).toEqual(["REC"]);
    expect(r.totalCandidatos).toBe(3);
  });

  it("dia com aprovado não lista gate responsável — não há dia a explicar", () => {
    const r = ranquearDia([candidato()]);
    expect(r.gatesResponsaveis).toEqual([]);
  });

  it("não muta a lista recebida", () => {
    const lista = [
      candidato({ setupId: "X", espacoR: 3 }),
      candidato({ setupId: "Y", espacoR: 9 }),
    ];
    const antes = lista.map((c) => c.setupId);
    ranquearDia(lista);
    expect(lista.map((c) => c.setupId)).toEqual(antes);
  });

  it("lista vazia é NO_TRADE sem gate — não houve nem candidato", () => {
    const r = ranquearDia([]);
    expect(r.noTrade).toBe(true);
    expect(r.melhor).toBeNull();
    expect(r.gatesResponsaveis).toEqual([]);
    expect(r.totalCandidatos).toBe(0);
  });

  it("a justificativa expõe a cascata em texto conferível", () => {
    const r = ranquearDia([candidato({ espacoR: 4.25, riscoPontos: 220, confianca: 85 })]);
    expect(r.melhor?.justificativa).toBe(
      "espaço 4.3R · obstáculo MEDIDO · stop ESTRUTURAL · risco 220 pts · confiança 85",
    );
  });
});
