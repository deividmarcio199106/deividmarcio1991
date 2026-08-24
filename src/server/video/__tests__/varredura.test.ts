import { describe, expect, it } from "vitest";

import {
  acharPivos,
  acharRegioes,
  agruparPorInstante,
  type PontoDeVarredura,
} from "@/server/video/varredura";

/**
 * Série sintética: cada preço vira um ponto da varredura, em ordem.
 *
 * Tudo na mesma época de régua, salvo quando o teste diz o contrário — é o
 * caso normal, e o caso da troca de régua tem teste próprio.
 */
function serie(precos: Array<number | null>, epocas?: number[]): PontoDeVarredura[] {
  return precos.map((preco, i) => ({
    indice: i,
    segundoNoVideo: i * 0.1,
    preco,
    origemDaEscala: preco === null ? "RETA_RUIM" : "PROPAGADA",
    yDaCaixa: preco === null ? null : 300,
    epocaDaRegua: epocas?.[i] ?? 0,
  }));
}

/** Rampa de `n` pontos de `de` até `ate`, sem repetir o ponto de partida. */
function rampa(de: number, ate: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => Math.round(de + ((ate - de) * (i + 1)) / n));
}

describe("acharPivos", () => {
  const janela = 3;

  it("acha o topo que domina a janela e tem amplitude", () => {
    const precos = [...rampa(100_000, 100_600, 3), 101_000, ...rampa(100_600, 100_000, 3)];
    const pivos = acharPivos(serie(precos), { janelaDoPivo: janela, amplitudeMinima: 300 });
    expect(pivos).toHaveLength(1);
    expect(pivos[0]!.tipo).toBe("TOPO");
    expect(pivos[0]!.preco).toBe(101_000);
  });

  it("ignora o extremo cuja amplitude cabe dentro do erro da régua", () => {
    // 100 pontos de amplitude — o erro medido da calibração é ~101 pontos.
    const precos = [100_000, 100_030, 100_060, 100_100, 100_060, 100_030, 100_000];
    expect(acharPivos(serie(precos), { janelaDoPivo: janela, amplitudeMinima: 300 })).toHaveLength(
      0,
    );
  });

  it("não olha pontos sem preço", () => {
    const precos = [100_000, null, 100_600, null, 101_000, null, 100_600, null, 100_000];
    const pivos = acharPivos(serie(precos), { janelaDoPivo: 2, amplitudeMinima: 300 });
    expect(pivos.map((p) => p.preco)).toEqual([101_000]);
  });

  it("acha fundo e topo na mesma série", () => {
    const precos = [
      101_000,
      100_600,
      100_300,
      100_000, // fundo
      100_300,
      100_600,
      101_000,
      101_400,
      101_800, // topo
      101_400,
      101_000,
      100_600,
    ];
    const pivos = acharPivos(serie(precos), { janelaDoPivo: 3, amplitudeMinima: 300 });
    expect(pivos.map((p) => `${p.tipo}:${p.preco}`)).toEqual(["FUNDO:100000", "TOPO:101800"]);
  });
});

describe("acharPivos — o que a janela precisa garantir", () => {
  /** Pontos com índice explícito: é assim que se desenha um buraco de leitura. */
  function comIndices(
    entradas: Array<{ indice: number; preco: number; epoca?: number }>,
  ): PontoDeVarredura[] {
    return entradas.map((e) => ({
      indice: e.indice,
      segundoNoVideo: e.indice * 0.1,
      preco: e.preco,
      origemDaEscala: "PROPAGADA",
      yDaCaixa: 300,
      epocaDaRegua: e.epoca ?? 0,
    }));
  }

  const precos = [101_000, 100_600, 100_300, 100_000, 100_300, 100_600, 101_000];

  it("aceita o pivô quando a janela é contígua", () => {
    const pontos = comIndices(precos.map((preco, i) => ({ indice: i, preco })));
    expect(acharPivos(pontos, { janelaDoPivo: 3, amplitudeMinima: 300 })).toHaveLength(1);
  });

  it("recusa o pivô cuja janela atravessa um buraco de leitura", () => {
    /*
     * Os três pontos da esquerda ficaram 40 frames atrás: entre eles e o centro
     * a régua não leu nada. "Extremo local" aqui seria o extremo de dois
     * trechos distantes colados um no outro.
     */
    const indices = [0, 1, 2, 42, 43, 44, 45];
    const pontos = comIndices(precos.map((preco, i) => ({ indice: indices[i]!, preco })));
    expect(acharPivos(pontos, { janelaDoPivo: 3, amplitudeMinima: 300 })).toHaveLength(0);
  });

  it("recusa o pivô cuja janela atravessa uma troca de régua", () => {
    // A OCR reancorou o eixo no meio da janela: o degrau pode ser da medição.
    const pontos = comIndices(
      precos.map((preco, i) => ({ indice: i, preco, epoca: i < 3 ? 0 : 1 })),
    );
    expect(acharPivos(pontos, { janelaDoPivo: 3, amplitudeMinima: 300 })).toHaveLength(0);
  });
});

describe("acharRegioes", () => {
  const opcoes = {
    janelaDoPivo: 3,
    amplitudeMinima: 300,
    toleranciaDaRegiao: 120,
    afastamentoMinimo: 250,
  };

  it("marca o retorno ao fundo defendido como COMPRA", () => {
    const precos = [
      101_000,
      100_600,
      100_300,
      100_000, // fundo, índice 3
      100_300,
      100_600,
      101_000, // sai da região (afastamento 1000)
      100_700,
      100_050, // volta para dentro da tolerância
    ];
    const candidatos = acharRegioes(serie(precos), opcoes);
    expect(candidatos).toHaveLength(1);
    expect(candidatos[0]!.direcaoEsperada).toBe("COMPRA");
    expect(candidatos[0]!.nivel).toBe(100_000);
    expect(candidatos[0]!.indice).toBe(8);
  });

  it("não marca retorno antes de o pivô ser conhecível", () => {
    /*
     * O fundo do índice 3 só se sabe fundo depois da janela à direita — índice
     * 6. Um retorno no índice 5 é informação que o operador não tinha.
     */
    const precos = [
      101_000, 100_600, 100_300, 100_000, 100_400, 100_050, 100_300, 100_600, 101_000,
    ];
    expect(acharRegioes(serie(precos), opcoes)).toHaveLength(0);
  });

  it("exige que o preço tenha SAÍDO da região antes de voltar", () => {
    // Preço colado no nível: sem afastamento, nenhum retorno é candidato.
    const precos = [
      101_000, 100_600, 100_300, 100_000, 100_050, 100_040, 100_030, 100_060, 100_020, 100_010,
    ];
    expect(acharRegioes(serie(precos), opcoes)).toHaveLength(0);
  });

  it("conta as visitas anteriores ao mesmo nível", () => {
    const precos = [
      101_000,
      100_600,
      100_300,
      100_000, // fundo
      100_300,
      100_600,
      101_000,
      100_050, // 1ª volta
      101_000,
      100_060, // 2ª volta
    ];
    const candidatos = acharRegioes(serie(precos), opcoes);
    expect(candidatos.map((c) => c.visitasAnteriores)).toEqual([0, 1]);
  });
});

describe("agruparPorInstante", () => {
  it("mantém um candidato por instante, o de mais história", () => {
    const base = {
      segundoNoVideo: 1,
      preco: 100_000,
      direcaoEsperada: "COMPRA" as const,
    };
    const agrupados = agruparPorInstante([
      { ...base, indice: 10, nivel: 100_000, visitasAnteriores: 0, afastamentoMaximo: 400 },
      { ...base, indice: 10, nivel: 100_050, visitasAnteriores: 2, afastamentoMaximo: 300 },
      { ...base, indice: 20, nivel: 100_000, visitasAnteriores: 0, afastamentoMaximo: 900 },
    ]);
    expect(agrupados).toHaveLength(2);
    expect(agrupados[0]!.visitasAnteriores).toBe(2);
    expect(agrupados[1]!.indice).toBe(20);
  });

  it("desempata por afastamento quando as visitas empatam", () => {
    const base = {
      indice: 7,
      segundoNoVideo: 0.7,
      preco: 100_000,
      direcaoEsperada: "VENDA" as const,
      visitasAnteriores: 1,
    };
    const agrupados = agruparPorInstante([
      { ...base, nivel: 100_000, afastamentoMaximo: 300 },
      { ...base, nivel: 100_100, afastamentoMaximo: 800 },
    ]);
    expect(agrupados).toHaveLength(1);
    expect(agrupados[0]!.afastamentoMaximo).toBe(800);
  });
});
