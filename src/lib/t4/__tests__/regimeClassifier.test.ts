import { describe, expect, it } from "vitest";

import type { Candle } from "@/lib/engines/types";
import {
  EXTREMO_BANDA,
  GAP_COOLDOWN_CANDLES,
  GAP_LIMITE_PONTOS,
  LATERALIDADE_MIN_CANDLES,
  classifyRegime,
  noExtremoDoRange,
  playAutorizado,
  posicaoNoRange,
} from "../regimeClassifier";

/** Candle sintético fechado. `t` é só ordem — o classificador não usa relógio. */
function candle(i: number, o: number, h: number, l: number, c: number): Candle {
  return { t: i * 60_000, o, h, l, c, v: 0 };
}

/** Tendência de alta: topos e fundos ascendentes em toda a janela. */
function tendenciaDeAlta(n = 45): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const base = 100_000 + i * 40;
    return candle(i, base, base + 30, base - 20, base + 20);
  });
}

/** Lateralidade: oscila dentro de uma faixa e volta para perto de onde saiu. */
function lateralidade(n = 45): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const onda = Math.sin(i / 2) * 100;
    const base = 100_000 + onda;
    return candle(i, base, base + 25, base - 25, base);
  });
}

describe("classifyRegime", () => {
  it("sem janela suficiente não autoriza nada", () => {
    const p = classifyRegime({ window: tendenciaDeAlta(5), gapPoints: null, candlesSinceOpen: 30 });
    expect(p.regime).toBe("REGIME_INDEFINIDO");
    expect(p.allowedPlays).toHaveLength(0);
  });

  it("tendência autoriza T4.1 com 3R, 5R e runner", () => {
    const p = classifyRegime({ window: tendenciaDeAlta(), gapPoints: null, candlesSinceOpen: 60 });
    expect(p.regime).toBe("REGIME_A_TENDENCIA");
    expect(p.allowedPlays).toEqual(["T4.1_PULLBACK_LIMPO"]);
    expect(p.targetsR).toEqual([3, 5, null]);
    expect(p.runnerAllowed).toBe(true);
    expect(p.maxPerna).toBe(2);
    expect(p.evidences.length).toBeGreaterThan(0);
  });

  it("lateralidade proíbe runner e troca para alvos curtos", () => {
    const p = classifyRegime({ window: lateralidade(), gapPoints: null, candlesSinceOpen: 60 });
    expect(p.regime).toBe("REGIME_B_LATERALIDADE");
    expect(p.allowedPlays).toEqual(["T4.3_EXTREMO_COM_SWEEP"]);
    expect(p.targetsR).toEqual([1.5, 2.5]);
    expect(p.runnerAllowed).toBe(false);
    expect(p.zonaDeEntrada?.banda).toBe(EXTREMO_BANDA);
  });

  it("lateralidade exige a janela mínima de candles", () => {
    const curta = lateralidade(LATERALIDADE_MIN_CANDLES - 5);
    const p = classifyRegime({ window: curta, gapPoints: null, candlesSinceOpen: 60 });
    expect(p.regime).not.toBe("REGIME_B_LATERALIDADE");
  });

  it("gap acima do limite trava tudo enquanto o cooldown corre", () => {
    const p = classifyRegime({
      window: tendenciaDeAlta(),
      gapPoints: GAP_LIMITE_PONTOS + 1,
      candlesSinceOpen: 5,
    });
    expect(p.regime).toBe("REGIME_C_GAP_VOLATILIDADE");
    expect(p.allowedPlays).toHaveLength(0);
    expect(p.cooldownCandlesRemaining).toBe(GAP_COOLDOWN_CANDLES - 5);
  });

  it("gap com cooldown cumprido volta a classificar pela estrutura", () => {
    const p = classifyRegime({
      window: tendenciaDeAlta(),
      gapPoints: GAP_LIMITE_PONTOS + 500,
      candlesSinceOpen: GAP_COOLDOWN_CANDLES,
    });
    expect(p.regime).toBe("REGIME_A_TENDENCIA");
    expect(p.cooldownCandlesRemaining).toBe(0);
    expect(p.evidences.join(" ")).toContain("cooldown");
  });

  it("gap no limite exato NÃO trava — o critério é estritamente maior", () => {
    const p = classifyRegime({
      window: tendenciaDeAlta(),
      gapPoints: GAP_LIMITE_PONTOS,
      candlesSinceOpen: 0,
    });
    expect(p.regime).not.toBe("REGIME_C_GAP_VOLATILIDADE");
  });

  it("sem contagem de candles o cooldown é assumido CHEIO, não cumprido", () => {
    const p = classifyRegime({
      window: tendenciaDeAlta(),
      gapPoints: GAP_LIMITE_PONTOS + 1,
      candlesSinceOpen: null,
    });
    expect(p.regime).toBe("REGIME_C_GAP_VOLATILIDADE");
    expect(p.cooldownCandlesRemaining).toBe(GAP_COOLDOWN_CANDLES);
  });
});

describe("posicaoNoRange / noExtremoDoRange", () => {
  it("mede onde o último fechamento está na faixa", () => {
    const janela = [candle(0, 100, 110, 90, 100), candle(1, 100, 110, 90, 90)];
    expect(posicaoNoRange(janela)).toBeCloseTo(0, 5);
  });

  it("meio do range não é extremo para nenhum lado", () => {
    expect(noExtremoDoRange(0.5, "COMPRA")).toBe(false);
    expect(noExtremoDoRange(0.5, "VENDA")).toBe(false);
  });

  it("compra só embaixo, venda só em cima", () => {
    expect(noExtremoDoRange(0.1, "COMPRA")).toBe(true);
    expect(noExtremoDoRange(0.1, "VENDA")).toBe(false);
    expect(noExtremoDoRange(0.9, "VENDA")).toBe(true);
    expect(noExtremoDoRange(0.9, "COMPRA")).toBe(false);
  });

  it("posição desconhecida nunca é extremo", () => {
    expect(noExtremoDoRange(null, "COMPRA")).toBe(false);
  });
});

describe("playAutorizado", () => {
  const tendencia = classifyRegime({
    window: tendenciaDeAlta(),
    gapPoints: null,
    candlesSinceOpen: 60,
  });
  const lateral = classifyRegime({
    window: lateralidade(),
    gapPoints: null,
    candlesSinceOpen: 60,
  });

  it("T4.1 passa em tendência na 1ª e 2ª perna", () => {
    expect(playAutorizado(tendencia, "T4.1_PULLBACK_LIMPO", { perna: 1 }).autorizado).toBe(true);
    expect(playAutorizado(tendencia, "T4.1_PULLBACK_LIMPO", { perna: 2 }).autorizado).toBe(true);
  });

  it("T4.1 é vetada na 3ª perna", () => {
    const r = playAutorizado(tendencia, "T4.1_PULLBACK_LIMPO", { perna: 3 });
    expect(r.autorizado).toBe(false);
    expect(r.motivo).toContain("3ª perna");
  });

  it("T4.1 é vetada dentro da lateralidade", () => {
    const r = playAutorizado(lateral, "T4.1_PULLBACK_LIMPO", { side: "COMPRA", perna: 1 });
    expect(r.autorizado).toBe(false);
    expect(r.motivo).toContain("REGIME_B_LATERALIDADE");
  });

  it("T4.3 sem lado informado não passa no regime que exige extremo", () => {
    const r = playAutorizado(lateral, "T4.3_EXTREMO_COM_SWEEP", {});
    expect(r.autorizado).toBe(false);
    expect(r.motivo).toContain("lado");
  });

  it("cooldown de gap veta qualquer play", () => {
    const gap = classifyRegime({
      window: tendenciaDeAlta(),
      gapPoints: GAP_LIMITE_PONTOS + 1,
      candlesSinceOpen: 1,
    });
    const r = playAutorizado(gap, "T4.1_PULLBACK_LIMPO", { perna: 1 });
    expect(r.autorizado).toBe(false);
    expect(r.motivo).toContain("Cooldown");
  });
});
