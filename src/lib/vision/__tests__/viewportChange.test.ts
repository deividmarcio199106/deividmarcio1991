import { describe, expect, it } from "vitest";

import {
  CLIPPED_LABEL,
  detectClipping,
  detectViewportChange,
  emptyViewportGate,
  FRAMES_ESTAVEIS_EXIGIDOS,
  stepViewportGate,
  type ViewportGateState,
  type ViewportSignature,
} from "../viewportChange";

/**
 * MUDANÇA DE ESCALA E DE JANELA (§7) — e o CASO C do aceite.
 *
 * A evidência: no print 024 da sessão de 19/08 o operador mexeu fortemente na
 * escala e depois voltou. Entre esses prints o mesmo movimento de preço ocupava
 * outra quantidade de pixels, e o sistema seguiu comparando distâncias visuais
 * e confirmando estrutura como se a régua fosse a mesma.
 *
 * O que o §7 exige: detectar, PRESERVAR os níveis, bloquear a confirmação e
 * exigir frame estável antes de voltar a liberar.
 */

/** Enquadramento de referência: WINFUT 1-min, ~120 candles, tela 1920×1080. */
function base(over: Partial<ViewportSignature> = {}): ViewportSignature {
  return {
    priceMin: 170_000,
    priceMax: 171_500,
    pixelsPerPoint: 0.62,
    candleCount: 120,
    candleWidthPx: 12,
    timeSpanMinutes: 120,
    layoutHash: "1920x1080|0.00,0.06,0.90,0.88|WINFUT",
    ...over,
  };
}

describe("§7 — detecção de mudança", () => {
  it("sem enquadramento anterior não existe mudança — nunca alarme por falta de dado", () => {
    const r = detectViewportChange(null, base());
    expect(r.changed).toBe(false);
    expect(r.kinds).toEqual([]);
    expect(r.bloqueiaConfirmacao).toBe(false);
  });

  it("o MESMO enquadramento não é mudança", () => {
    expect(detectViewportChange(base(), base()).changed).toBe(false);
  });

  it("ruído de leitura não vira alarme", () => {
    // Duas leituras de OCR do mesmo gráfico raramente dão o mesmo número.
    const ruido = base({ priceMax: 171_505, pixelsPerPoint: 0.621, candleCount: 121 });
    expect(detectViewportChange(base(), ruido).changed).toBe(false);
  });

  it("zoom vertical (dobro da escala) é detectado e bloqueia confirmação", () => {
    const zoom = base({ priceMin: 170_600, priceMax: 171_350, pixelsPerPoint: 1.24 });
    const r = detectViewportChange(base(), zoom);
    expect(r.changed).toBe(true);
    expect(r.bloqueiaConfirmacao).toBe(true);
    expect(r.kinds.length).toBeGreaterThan(0);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("zoom horizontal (metade dos candles, o dobro da largura) é detectado", () => {
    const r = detectViewportChange(base(), base({ candleCount: 60, candleWidthPx: 24 }));
    expect(r.changed).toBe(true);
    expect(r.bloqueiaConfirmacao).toBe(true);
  });

  it("janela temporal diferente é detectada", () => {
    const r = detectViewportChange(base(), base({ timeSpanMinutes: 480 }));
    expect(r.changed).toBe(true);
  });

  it("layout diferente (outra janela, outro ativo) é detectado", () => {
    const r = detectViewportChange(base(), base({ layoutHash: "1280x720|0,0,1,1|WDOFUT" }));
    expect(r.changed).toBe(true);
    expect(r.exigeRecalibracao).toBe(true);
  });

  it("leitura ausente não vira mudança — ausência não é evidência", () => {
    const cego = base({ priceMin: null, priceMax: null, pixelsPerPoint: null });
    expect(detectViewportChange(base(), cego).changed).toBe(false);
  });
});

describe("§7 — CASO C: mudança forte bloqueia até estabilizar", () => {
  /** Roda uma sequência de enquadramentos pelo portão. */
  function rodar(sequencia: ViewportSignature[]) {
    let estado: ViewportGateState = emptyViewportGate();
    return sequencia.map((assinatura) => {
      const passo = stepViewportGate(estado, assinatura);
      estado = passo.state;
      return passo;
    });
  }

  const ZOOM = base({ priceMin: 170_600, priceMax: 171_350, pixelsPerPoint: 1.24 });

  it("o primeiro frame da sessão NÃO é tratado como instabilidade", () => {
    /*
     * Decisão deliberada do portão: sem enquadramento anterior não houve
     * mudança, e o primeiro frame conta como estável. Bloquear aqui pausaria a
     * T4 na ABERTURA do pregão — todo dia, sem que nada tivesse acontecido com
     * a régua. O portão existe para reagir a mudança observada, não à falta de
     * histórico.
     */
    const [primeiro] = rodar([base()]);
    expect(primeiro!.change.changed).toBe(false);
    expect(primeiro!.liberaConfirmacao).toBe(true);
    expect(primeiro!.motivo).toBeNull();
  });

  it("estabilizado, o portão libera", () => {
    const passos = rodar([base(), base(), base(), base()]);
    expect(passos[passos.length - 1]!.liberaConfirmacao).toBe(true);
    expect(passos[passos.length - 1]!.motivo).toBeNull();
  });

  it("o zoom fecha o portão na hora, com motivo dito", () => {
    const passos = rodar([base(), base(), base(), ZOOM]);
    const noZoom = passos[3]!;
    expect(noZoom.change.changed).toBe(true);
    expect(noZoom.liberaConfirmacao).toBe(false);
    expect(noZoom.motivo).toContain("confirmação suspensa");
  });

  it("e o portão só reabre depois de frames ESTÁVEIS — não no primeiro seguinte", () => {
    const passos = rodar([base(), base(), base(), ZOOM, ZOOM, ZOOM, ZOOM]);
    // Logo após a mudança, ainda bloqueado.
    expect(passos[4]!.liberaConfirmacao).toBe(false);
    // Depois de acumular a estabilidade exigida, volta a liberar.
    const liberou = passos.slice(4).some((p) => p.liberaConfirmacao);
    expect(liberou).toBe(true);
    expect(FRAMES_ESTAVEIS_EXIGIDOS).toBeGreaterThan(1);
  });

  it("mudar e VOLTAR também é mudança — o print 024 da sessão", () => {
    // O operador mexeu na escala e desfez. Os dois gestos alteram a régua.
    const passos = rodar([base(), base(), base(), ZOOM, base()]);
    expect(passos[3]!.change.changed).toBe(true);
    expect(passos[4]!.change.changed).toBe(true);
    expect(passos[4]!.liberaConfirmacao).toBe(false);
  });

  it("enquanto oscila, NUNCA libera", () => {
    const passos = rodar([base(), base(), base(), ZOOM, base(), ZOOM, base()]);
    for (const passo of passos.slice(3)) {
      expect(passo.liberaConfirmacao).toBe(false);
      expect(passo.motivo).not.toBeNull();
    }
  });
});

/**
 * §7 — GRÁFICO CORTADO (VIEWPORT_CLIPPED).
 *
 * O print de 19/08 que o operador mandou: o preço estourou o enquadramento e
 * os candles chegaram cortados no topo. Nesse estado não existe máxima
 * estrutural, resistência seguinte nem espaço até o alvo — e stop, alvo e R:R
 * calculados ali são invenção sobre o que ficou fora da imagem.
 */
describe("§7 — detecção de gráfico cortado", () => {
  const L = 400;
  const A = 300;
  const FUNDO = 20;
  const TINTA = 200;

  /** Grade de luma com barras verticais. `topo`/`altura` em pixels. */
  function grafico(barras: { x: number; largura: number; topo: number; altura: number }[]) {
    const luma = new Float64Array(L * A).fill(FUNDO);
    for (const b of barras) {
      for (let x = b.x; x < b.x + b.largura && x < L; x += 1) {
        for (let y = b.topo; y < b.topo + b.altura && y < A; y += 1) {
          luma[y * L + x] = TINTA;
        }
      }
    }
    return luma;
  }

  /** Série normal: barras com folga do topo e do fundo. */
  const COM_MARGEM = Array.from({ length: 40 }, (_, i) => ({
    x: 20 + i * 9,
    largura: 4,
    topo: 60 + ((i * 7) % 40),
    altura: 100 + ((i * 11) % 60),
  }));

  it("gráfico com margem NÃO é cortado", () => {
    const r = detectClipping(grafico(COM_MARGEM), L, A);
    expect(r.clipped).toBe(false);
    expect(r.reason).toBe("");
  });

  it("candles encostando no TOPO são corte, com o motivo dito", () => {
    // O preço subiu além do enquadramento: as barras começam na linha 0.
    const estourou = COM_MARGEM.map((b) => ({ ...b, topo: 0, altura: 180 }));
    const r = detectClipping(grafico(estourou), L, A);
    expect(r.clipped).toBe(true);
    expect(r.topo).toBe(true);
    expect(r.fundo).toBe(false);
    expect(r.reason).toContain("cortado no topo");
    expect(r.reason).toContain("R:R");
  });

  it("candles encostando no FUNDO também são corte", () => {
    const estourou = COM_MARGEM.map((b) => ({ ...b, topo: A - 120, altura: 200 }));
    const r = detectClipping(grafico(estourou), L, A);
    expect(r.clipped).toBe(true);
    expect(r.fundo).toBe(true);
  });

  it("UM candle alto isolado não é corte — é um candle alto", () => {
    /*
     * A distinção que importa: gráfico estourado tem tinta espalhada pela
     * borda inteira; um candle que por acaso ficou alto toca a borda em uma
     * coluna. Confundir os dois pausaria a T4 em todo repique forte.
     */
    const umAlto = [...COM_MARGEM, { x: 200, largura: 4, topo: 0, altura: 250 }];
    expect(detectClipping(grafico(umAlto), L, A).clipped).toBe(false);
  });

  it("grade vazia ou incompleta NÃO acusa corte — quem não sabe não acusa", () => {
    expect(detectClipping(new Float64Array(0), 0, 0).clipped).toBe(false);
    expect(detectClipping(new Float64Array(10), L, A).clipped).toBe(false);
  });

  it("funciona em tema claro — o fundo é o tom dominante, não uma cor fixa", () => {
    // Fundo claro, barras escuras: a mesma detecção, invertida.
    const luma = new Float64Array(L * A).fill(230);
    for (const b of COM_MARGEM.map((x) => ({ ...x, topo: 0, altura: 180 }))) {
      for (let x = b.x; x < b.x + b.largura; x += 1) {
        for (let y = b.topo; y < b.topo + b.altura; y += 1) luma[y * L + x] = 30;
      }
    }
    expect(detectClipping(luma, L, A).clipped).toBe(true);
  });

  it("o rótulo da tela é único e diz o que é", () => {
    expect(CLIPPED_LABEL).toContain("VIEWPORT_CLIPPED");
    expect(CLIPPED_LABEL).toContain("CORTADO");
  });
});

/**
 * §7 — A FAIXA MEDIDA É GEOMÉTRICA, E ISSO NÃO É DETALHE.
 *
 * A primeira tentativa mediu o corte dentro da ROI detectada por tinta
 * (`detectRoi`). Ela é VACUOSA por construção: a ROI é o envelope da tinta —
 * seu topo É o topo do candle mais alto — então a tinta encosta na borda dela
 * em todo gráfico, cortado ou não. O detector acusava sempre.
 *
 * A faixa que a captura usa é uma fração FIXA da janela compartilhada, e não
 * se move com o desenho. É por isso que "encostou na borda" volta a significar
 * alguma coisa.
 */
describe("§7 — a faixa medida não pode ser o envelope da tinta", () => {
  const L = 300;
  const A = 200;
  const FUNDO = 20;
  const TINTA = 210;

  /**
   * Série de candles dentro de uma faixa fixa, com `margem` livre no topo.
   *
   * A variação de altura é curta (6 px) de propósito: com ela, `margem = 0`
   * põe TODOS os topos dentro da faixa de borda, que é o que "o preço estourou
   * o enquadramento" parece de verdade — uma sequência de candles rente ao
   * topo, não um pico solitário. Amplitude grande faria o teste medir a sorte
   * do módulo em vez da regra.
   */
  function faixaFixa(margem: number): Float64Array {
    const luma = new Float64Array(L * A).fill(FUNDO);
    for (let c = 10; c < L - 6; c += 6) {
      const topo = margem + ((c * 17) % 6);
      for (let x = c; x < c + 3; x += 1) {
        for (let y = topo; y < A - 30; y += 1) luma[y * L + x] = TINTA;
      }
    }
    return luma;
  }

  it("com margem no topo da faixa, não há corte", () => {
    const r = detectClipping(faixaFixa(50), L, A);
    expect(r.avaliavel).toBe(true);
    expect(r.clipped).toBe(false);
  });

  it("candles encostando no topo da faixa SÃO corte — só a altura mudou", () => {
    const r = detectClipping(faixaFixa(0), L, A);
    expect(r.avaliavel).toBe(true);
    expect(r.clipped).toBe(true);
    expect(r.topo).toBe(true);
  });

  it("grade incompleta responde NÃO AVALIÁVEL, não 'não cortado'", () => {
    /*
     * A distinção que este campo existe para fazer: "medi e está inteiro" e
     * "não enxerguei" são as duas a mesma tela silenciosa sem ele, e um
     * detector cego passaria por um detector calmo.
     */
    const r = detectClipping(new Float64Array(10), L, A);
    expect(r.clipped).toBe(false);
    expect(r.avaliavel).toBe(false);
  });

  it("uma faixa de cromo de largura total é DESCASCADA, não confundida com corte", () => {
    /*
     * ESTE TESTE MUDOU DE LADO, E A MUDANÇA É O CONSERTO.
     *
     * Antes ele afirmava o contrário — que passar a janela inteira acusava
     * corte — e tratava isso como responsabilidade do chamador, que deveria
     * recortar antes. Era a descrição de um defeito, não de uma regra: medido
     * nas 83 capturas reais de 20/08, o detector acusava "cortado no topo E no
     * fundo" em 83 delas, todas com margem sobrando dos dois lados.
     *
     * Agora `detectClipping` acha a MOLDURA sozinho (`detectChartBounds`) e
     * mede dentro dela. Barra de ferramentas e eixo de tempo são descascados
     * porque saturam a linha; candle não satura. O detector deixou de depender
     * de o chamador ter recortado certo.
     */
    const comBarra = faixaFixa(50);
    for (let x = 0; x < L; x += 1) {
      for (let y = 0; y < 6; y += 1) comBarra[y * L + x] = TINTA;
      for (let y = A - 6; y < A; y += 1) comBarra[y * L + x] = TINTA;
    }
    const r = detectClipping(comBarra, L, A);
    expect(r.avaliavel).toBe(true);
    expect(r.clipped).toBe(false);
  });

  it("e com o cromo no lugar, o gráfico ESTOURADO continua sendo acusado", () => {
    // O par do teste acima: mesma moldura de cromo, candles rente ao topo.
    const estourado = faixaFixa(0);
    for (let x = 0; x < L; x += 1) {
      for (let y = 0; y < 6; y += 1) estourado[y * L + x] = TINTA;
      for (let y = A - 6; y < A; y += 1) estourado[y * L + x] = TINTA;
    }
    expect(detectClipping(estourado, L, A).clipped).toBe(true);
  });
});
