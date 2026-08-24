import { describe, expect, it } from "vitest";

import { alvosParaAnalise, reparoDoAlvo } from "../confirmacaoH3";

/**
 * O caso MEDIDO que originou H3: setup T4-2026-03-07-013, entrada 190.700,
 * stop 190.200 (risco 500), obstáculo MEDIDO em 191.107 → espaço 0,81R.
 * Alvos 3R/5R da técnica seriam 192.280 e 193.320.
 */
const CASO = {
  target1: 192_280,
  target2: 193_320,
  obstaculo: 191_107,
  espacoR: 0.81,
};

const H3 = { alvoNoObstaculo: true };

describe("baseline — experimento desligado", () => {
  it("com espaço provado, os alvos 3R/5R passam como sempre", () => {
    const a = alvosParaAnalise(CASO.target1, CASO.target2, CASO.obstaculo, true, 4.2, undefined);
    expect(a.origem).toBe("TRES_R");
    expect(a.targets.map((t) => t.value)).toEqual([192_280, 193_320]);
    expect(a.subTresR).toBe(false);
  });

  it("sem espaço provado, NENHUM alvo passa — é o comportamento atual", () => {
    const a = alvosParaAnalise(
      CASO.target1,
      CASO.target2,
      CASO.obstaculo,
      false,
      CASO.espacoR,
      undefined,
    );
    expect(a.origem).toBe("NENHUM");
    expect(a.targets).toEqual([]);
  });

  it("o baseline é idêntico com ou sem obstáculo conhecido", () => {
    const com = alvosParaAnalise(CASO.target1, null, 191_107, false, 0.81, undefined);
    const sem = alvosParaAnalise(CASO.target1, null, null, false, null, undefined);
    expect(com.targets).toEqual([]);
    expect(sem.targets).toEqual([]);
  });
});

describe("H3 ligada", () => {
  it("o caso medido: 0,81R deixa de bloquear e o obstáculo vira o alvo", () => {
    const a = alvosParaAnalise(CASO.target1, CASO.target2, CASO.obstaculo, false, CASO.espacoR, H3);
    expect(a.origem).toBe("OBSTACULO_H3");
    expect(a.targets.map((t) => t.value)).toEqual([191_107]);
    expect(a.subTresR).toBe(true);
  });

  it("NÃO empurra o alvo de 3R adiante — o R:R continua o real", () => {
    const a = alvosParaAnalise(CASO.target1, CASO.target2, CASO.obstaculo, false, 0.81, H3);
    expect(a.targets.map((t) => t.value)).not.toContain(192_280);
    expect(a.espacoR).toBe(0.81);
  });

  it("sem obstáculo conhecido, H3 se comporta como o baseline", () => {
    // Alvo sem obstáculo seria autoprofecia — a regra original está certa aqui.
    const a = alvosParaAnalise(CASO.target1, CASO.target2, null, false, null, H3);
    expect(a.origem).toBe("NENHUM");
    expect(a.targets).toEqual([]);
  });

  it("com espaço provado, H3 não muda nada — só age abaixo do piso", () => {
    const semH3 = alvosParaAnalise(
      CASO.target1,
      CASO.target2,
      CASO.obstaculo,
      true,
      4.2,
      undefined,
    );
    const comH3 = alvosParaAnalise(CASO.target1, CASO.target2, CASO.obstaculo, true, 4.2, H3);
    expect(comH3).toEqual(semH3);
  });

  it("a flag desligada explicitamente também é baseline", () => {
    const a = alvosParaAnalise(CASO.target1, null, CASO.obstaculo, false, 0.81, {
      alvoNoObstaculo: false,
    });
    expect(a.origem).toBe("NENHUM");
  });
});

describe("reparo", () => {
  it("um trade sob H3 diz na cara que nasceu abaixo do piso", () => {
    const a = alvosParaAnalise(CASO.target1, null, CASO.obstaculo, false, 0.81, H3);
    const texto = reparoDoAlvo(a, CASO.obstaculo);
    expect(texto).toContain("H3");
    expect(texto).toContain("SUB_3R");
    expect(texto).toContain("0.8R");
  });

  it("sem obstáculo, o reparo mantém a razão original da recusa", () => {
    const a = alvosParaAnalise(CASO.target1, null, null, false, null, H3);
    expect(reparoDoAlvo(a, null)).toContain("autoprofecia");
  });
});
