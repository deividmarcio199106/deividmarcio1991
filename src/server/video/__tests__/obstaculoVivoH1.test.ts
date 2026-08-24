import { describe, expect, it } from "vitest";

import { excessoAlemDoNivel } from "../pregao";
import type { Pivo } from "../varredura";

/**
 * A regra de vida do nível (H1): só ACEITAÇÃO além do nível mata — toque e
 * furo pequeno mantêm o obstáculo vivo, porque falso rompimento é exatamente
 * o caso em que o nível prova que segura.
 */
const serie = (precos: number[], aPartir = 0) =>
  precos.map((preco, i) => ({ preco, indice: aPartir + i }));

const topo: Pivo = { indice: 10, segundoNoVideo: 1, preco: 100_000, tipo: "TOPO" };
const fundo: Pivo = { indice: 10, segundoNoVideo: 1, preco: 100_000, tipo: "FUNDO" };
const JANELA = 8;

describe("excessoAlemDoNivel (H1)", () => {
  it("TOPO: excesso é o máximo ACIMA do nível depois de conhecível", () => {
    const precos = serie([99_900, 100_050, 100_180, 100_020], 18);
    expect(excessoAlemDoNivel(topo, precos, JANELA)).toBe(180);
  });

  it("FUNDO é simétrico: excesso é o máximo ABAIXO", () => {
    const precos = serie([100_100, 99_940, 99_820, 99_990], 18);
    expect(excessoAlemDoNivel(fundo, precos, JANELA)).toBe(180);
  });

  it("toque sem atravessar devolve zero — nível intacto", () => {
    const precos = serie([99_800, 100_000, 99_850], 18);
    expect(excessoAlemDoNivel(topo, precos, JANELA)).toBe(0);
  });

  it("preços ANTES de o pivô ser conhecível não contam", () => {
    // Excesso de 500 no índice 12 — mas o pivô só é conhecível no 18.
    const antes = serie([100_500], 12);
    const depois = serie([100_040], 20);
    expect(excessoAlemDoNivel(topo, [...antes, ...depois], JANELA)).toBe(40);
  });

  it("furo pequeno fica abaixo da aceitação — quem decide DEAD é o limiar", () => {
    const precos = serie([100_060], 18); // furo de 60 pts
    const excesso = excessoAlemDoNivel(topo, precos, JANELA);
    expect(excesso).toBe(60);
    expect(excesso >= 150).toBe(false); // com aceitação 150, continua VIVO
  });
});
