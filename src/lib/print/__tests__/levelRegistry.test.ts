import { describe, expect, it } from "vitest";

import type { PriceLevel } from "@/lib/vision/printAnalysis";
import {
  contaComoPrevisao,
  elegivelParaBacktest,
  elegivelParaEntrada,
  emptyLevelRegistry,
  niveisPostHoc,
  niveisPrevistos,
  observeLevels,
  rotuloDoNivel,
  transitionLevel,
  type LevelRegistry,
} from "../levelRegistry";

/**
 * IDENTIDADE DOS NÍVEIS (§10) E POST_HOC (§11, §13).
 *
 * Duas queixas do operador viram teste aqui:
 *
 * 1. o MESMO nível trocava de nome entre prints — "suporte estrutural", "zona
 *    de reação", "POI" — e cada nome virava um nível novo na tela;
 * 2. níveis nasciam com o preço JÁ neles. Descrever um nível que o preço já
 *    tocou não é previsão: é legenda do passado. Contado como acerto, ele
 *    infla a estatística sem que decisão nenhuma tenha sido antecipada.
 */

const T0 = Date.UTC(2026, 7, 19, 15, 0, 0);
const MIN = 60_000;
const ATIVO = "WINFUT";

function nivel(type: PriceLevel["kind"], preco: number, label = "nível"): PriceLevel {
  return {
    kind: type,
    label,
    priceMin: { value: preco, visible: true },
    priceMax: null,
  } as PriceLevel;
}

/** Roda prints pelo registro, carregando o estado como em produção. */
function rodar(prints: { levels: PriceLevel[]; price: number | null }[]): {
  registro: LevelRegistry;
  passos: ReturnType<typeof observeLevels>[];
} {
  let registro = emptyLevelRegistry();
  const passos = prints.map((p, i) => {
    const passo = observeLevels(registro, {
      levels: p.levels,
      price: p.price,
      now: T0 + i * MIN,
      symbol: ATIVO,
    });
    registro = passo.registry;
    return passo;
  });
  return { registro, passos };
}

describe("§10 — a identidade é o PREÇO, não o nome", () => {
  it("o mesmo preço com nomes diferentes continua sendo UM nível", () => {
    const { registro } = rodar([
      { levels: [nivel("SUPORTE", 169_500, "suporte estrutural")], price: 170_400 },
      { levels: [nivel("ZONA_COMPRA", 169_500, "zona de reação")], price: 170_400 },
      { levels: [nivel("FUNDO", 169_500, "POI")], price: 170_400 },
    ]);
    expect(registro.levels).toHaveLength(1);
    const unico = registro.levels[0]!;
    expect(unico.type).toBe("FUNDO");
    expect(unico.detectedAt).toBe(T0);
    // As trocas de nome ficaram como EVENTO do mesmo nível.
    expect(unico.history.filter((e) => e.kind === "RENAMED").length).toBeGreaterThanOrEqual(2);
  });

  it("ruído de leitura no preço não cria nível novo", () => {
    const { registro } = rodar([
      { levels: [nivel("SUPORTE", 169_500)], price: 170_400 },
      { levels: [nivel("SUPORTE", 169_515)], price: 170_400 },
    ]);
    expect(registro.levels).toHaveLength(1);
    expect(registro.levels[0]!.detectedAt).toBe(T0);
  });

  it("preços realmente distintos são níveis distintos, com ids distintos", () => {
    const { registro } = rodar([
      {
        levels: [nivel("SUPORTE", 169_500), nivel("RESISTENCIA", 170_900)],
        price: 170_100,
      },
    ]);
    expect(registro.levels).toHaveLength(2);
    const ids = registro.levels.map((n) => n.levelId);
    expect(new Set(ids).size).toBe(2);
  });

  it("nível que some de UM print não é apagado — a imagem lista menos, não menos existe", () => {
    const { registro } = rodar([
      { levels: [nivel("SUPORTE", 169_500)], price: 170_400 },
      { levels: [], price: 170_400 },
    ]);
    expect(registro.levels).toHaveLength(1);
  });

  it("nível ilegível não entra — ausência não vira nível", () => {
    const ilegivel = {
      kind: "SUPORTE",
      label: "x",
      priceMin: { value: null, visible: false },
      priceMax: null,
    } as PriceLevel;
    expect(rodar([{ levels: [ilegivel], price: 170_000 }]).registro.levels).toHaveLength(0);
  });

  it("mudança de função é EVENTO explícito, não nível novo", () => {
    const { registro } = rodar([{ levels: [nivel("RESISTENCIA", 170_900)], price: 170_100 }]);
    const alvo = registro.levels[0]!;
    const rompido = transitionLevel(
      registro,
      alvo.levelId,
      "BROKEN",
      "fechou acima da resistência",
      T0 + MIN,
    );
    const depois = transitionLevel(
      rompido,
      alvo.levelId,
      "SUPPORT_RETEST",
      "voltou e respeitou como suporte",
      T0 + 2 * MIN,
    );
    // UM nível, com a história inteira: a região já testada é o que dá peso
    // ao reteste, e recriar o nível a cada etapa apagaria exatamente isso.
    expect(depois.levels).toHaveLength(1);
    const virouSuporte = depois.levels[0]!;
    expect(virouSuporte.levelId).toBe(alvo.levelId);
    expect(virouSuporte.status).toBe("SUPPORT_RETEST");
    expect(virouSuporte.history.filter((e) => e.kind === "TRANSITION")).toHaveLength(2);
  });

  it("transição para o MESMO status não polui o histórico", () => {
    const { registro } = rodar([{ levels: [nivel("RESISTENCIA", 170_900)], price: 170_100 }]);
    const id = registro.levels[0]!.levelId;
    const igual = transitionLevel(registro, id, registro.levels[0]!.status, "sem novidade", T0);
    expect(igual).toBe(registro);
  });
});

describe("§11/§13 — POST_HOC não é previsão", () => {
  it("nível descrito com o preço JÁ nele nasce POST_HOC", () => {
    const { registro, passos } = rodar([{ levels: [nivel("SUPORTE", 169_500)], price: 169_500 }]);
    const n = registro.levels[0]!;
    expect(n.postHoc).toBe(true);
    expect(n.predictedBeforeTouch).toBe(false);
    expect(passos[0]!.postHoc).toHaveLength(1);
    expect(n.history.some((e) => e.kind === "POST_HOC")).toBe(true);
  });

  it("nível descrito LONGE e tocado depois é PREVISÃO legítima", () => {
    const { registro } = rodar([
      { levels: [nivel("SUPORTE", 169_500)], price: 170_400 },
      { levels: [nivel("SUPORTE", 169_500)], price: 169_500 },
    ]);
    const n = registro.levels[0]!;
    expect(n.postHoc).toBe(false);
    expect(n.predictedBeforeTouch).toBe(true);
    expect(n.detectedAt).toBe(T0);
    expect(n.firstTouchAt).toBe(T0 + MIN);
    expect(n.firstTouchAt!).toBeGreaterThan(n.detectedAt);
  });

  it("o PRIMEIRO toque não se reescreve — a antecedência é a prova", () => {
    const { registro } = rodar([
      { levels: [nivel("SUPORTE", 169_500)], price: 170_400 },
      { levels: [nivel("SUPORTE", 169_500)], price: 169_500 },
      { levels: [nivel("SUPORTE", 169_500)], price: 169_500 },
      { levels: [nivel("SUPORTE", 169_500)], price: 169_500 },
    ]);
    expect(registro.levels[0]!.firstTouchAt).toBe(T0 + MIN);
  });

  it("POST_HOC não conta como previsão, entrada nem backtest", () => {
    const { registro } = rodar([
      { levels: [nivel("SUPORTE", 169_500), nivel("RESISTENCIA", 170_900)], price: 169_500 },
    ]);
    const postHoc = niveisPostHoc(registry(registro));
    const previstos = niveisPrevistos(registry(registro));
    expect(postHoc).toHaveLength(1);
    expect(previstos).toHaveLength(1);
    expect(previstos[0]!.price).toBe(170_900);

    const marcado = postHoc[0]!;
    expect(contaComoPrevisao(marcado)).toBe(false);
    expect(elegivelParaEntrada(marcado)).toBe(false);
    expect(elegivelParaBacktest(marcado)).toBe(false);
    // E continua VISÍVEL no registro: excluído da conta, não do histórico.
    expect(registro.levels).toHaveLength(2);
  });

  it("o rótulo DIZ o que o nível é — POST_HOC não se disfarça de previsão", () => {
    const { registro } = rodar([{ levels: [nivel("SUPORTE", 169_500)], price: 169_500 }]);
    expect(rotuloDoNivel(registro.levels[0]!)).toMatch(/POST_HOC/i);
  });

  it("sem preço legível, nenhum toque é afirmado", () => {
    const { registro } = rodar([{ levels: [nivel("SUPORTE", 169_500)], price: null }]);
    const n = registro.levels[0]!;
    expect(n.firstTouchAt).toBeNull();
    expect(n.status).toBe("ACTIVE");
  });

  it("nível ANTIGO não perde o primeiro toque para um nível criado no mesmo print", () => {
    /*
     * A ordem interna importa: o toque dos níveis conhecidos é marcado ANTES
     * de criar os novos. Sem isso, um nível descrito agora, no mesmo preço,
     * roubaria o toque do antigo — e o antigo perderia a prova de que havia
     * sido previsto.
     */
    const { registro } = rodar([
      { levels: [nivel("SUPORTE", 169_500)], price: 170_400 },
      {
        levels: [nivel("SUPORTE", 169_500), nivel("ZONA_COMPRA", 170_900)],
        price: 169_500,
      },
    ]);
    const antigo = registro.levels.find((n) => Math.abs(n.price - 169_500) < 50)!;
    expect(antigo.predictedBeforeTouch).toBe(true);
    expect(antigo.postHoc).toBe(false);
    expect(antigo.firstTouchAt).toBe(T0 + MIN);
  });
});

/** Açúcar: as funções de consulta recebem o registro inteiro. */
function registry(r: LevelRegistry): LevelRegistry {
  return r;
}
