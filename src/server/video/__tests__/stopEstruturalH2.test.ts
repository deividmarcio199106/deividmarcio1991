import { describe, expect, it } from "vitest";

import { stopEstruturalH2 } from "../pregao";

/**
 * A regra do stop da H2, testada com o exemplo CANÔNICO do dono da técnica —
 * e com os dois abusos que ela proíbe: maquiar o denominador com stop abaixo
 * do piso, e apertar o stop sem estrutura.
 */
const H2 = { bufferPontos: 100, pisoPontos: 200 };

describe("stopEstruturalH2", () => {
  it("experimento desligado: o stop do modelo passa intacto", () => {
    const r = stopEstruturalH2(true, 100_000, 99_740, 99_880, 100_200, undefined);
    expect(r).toEqual({ stop: 99_740, origem: "MODELO" });
  });

  it("o exemplo canônico: borda 120 + piso 200 ⇒ risco REAL 200, e 620 pts viram 3,1R", () => {
    // entrada 100.000, zona começa em 99.880 (borda a 120), stop do modelo 260.
    const r = stopEstruturalH2(true, 100_000, 99_740, 99_880, 100_200, H2);
    // borda 120 + buffer 100 = 220 ≥ piso ⇒ ESTRUTURAL com risco 220...
    expect(r.origem).toBe("ESTRUTURAL");
    expect(100_000 - r.stop).toBe(220);
    // ...e o espaço de 620 pts: 620/220 = 2,8R. Com borda mais colada (20),
    // o piso assume: risco executável 200, nunca 120.
    const colada = stopEstruturalH2(true, 100_000, 99_740, 99_980, 100_200, H2);
    expect(colada.origem).toBe("PISO");
    expect(100_000 - colada.stop).toBe(200);
    expect(620 / (100_000 - colada.stop)).toBeCloseTo(3.1, 5);
  });

  it("nunca usa risco menor que o piso — o denominador não se maquia", () => {
    // Borda a 10 pts: estrutural+buffer = 110 < piso 200 ⇒ stop executável 200.
    const r = stopEstruturalH2(true, 100_000, 99_990, 99_990, 100_100, H2);
    expect(100_000 - r.stop).toBe(200);
    expect(r.origem).toBe("PISO");
  });

  it("VENDA é simétrica: borda é o TETO da zona", () => {
    const r = stopEstruturalH2(false, 100_000, 100_260, 99_800, 100_120, H2);
    expect(r.origem).toBe("ESTRUTURAL");
    expect(r.stop - 100_000).toBe(220); // 120 até o teto + 100 de buffer
  });

  it("sem zona legível não há estrutura: o stop do modelo fica, só o piso alarga", () => {
    const largo = stopEstruturalH2(true, 100_000, 99_500, null, null, H2);
    expect(100_000 - largo.stop).toBe(500); // 500 ≥ piso: intacto
    expect(largo.origem).toBe("SEM_ZONA_PISO");
    const curto = stopEstruturalH2(true, 100_000, 99_900, null, null, H2);
    expect(100_000 - curto.stop).toBe(200); // 100 < piso: alarga até o piso
  });

  it("estrutura mais larga que o stop do modelo VENCE — alargar é permitido", () => {
    // Modelo deu 150 de risco; a borda está a 300+100=400: estrutura manda.
    const r = stopEstruturalH2(true, 100_000, 99_850, 99_700, 100_150, H2);
    expect(100_000 - r.stop).toBe(400);
    expect(r.origem).toBe("ESTRUTURAL");
  });
});
