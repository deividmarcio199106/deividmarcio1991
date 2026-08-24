import { describe, expect, it } from "vitest";

import {
  buildTimeframeContext,
  timeframeEmMinutos,
  type HigherTimeframeReading,
  type TimeframeBias,
} from "../multiTimeframe";
import { NAO_IDENTIFICADO } from "@/lib/vision/printAnalysis";

const superior = (over: Partial<HigherTimeframeReading> = {}): HigherTimeframeReading => ({
  timeframe: "15Min",
  bias: "COMPRA",
  confidence: 80,
  source: "print #3",
  ...over,
});

describe("timeframeEmMinutos", () => {
  it("lê o vocabulário que aparece de verdade", () => {
    expect(timeframeEmMinutos("1Min")).toBe(1);
    expect(timeframeEmMinutos("15 Min")).toBe(15);
    expect(timeframeEmMinutos("60min")).toBe(60);
    expect(timeframeEmMinutos("5m")).toBe(5);
    expect(timeframeEmMinutos("1h")).toBe(60);
    expect(timeframeEmMinutos("4 horas")).toBe(240);
    expect(timeframeEmMinutos("H1")).toBe(60);
    expect(timeframeEmMinutos("M15")).toBe(15);
    expect(timeframeEmMinutos("Diário")).toBe(1440);
    expect(timeframeEmMinutos("Semanal")).toBe(1440 * 7);
  });

  it("devolve null para o que NÃO reconhece — nunca um palpite", () => {
    expect(timeframeEmMinutos(null)).toBeNull();
    expect(timeframeEmMinutos("")).toBeNull();
    expect(timeframeEmMinutos("gráfico maior")).toBeNull();
    expect(timeframeEmMinutos("0min")).toBeNull();
    expect(timeframeEmMinutos(NAO_IDENTIFICADO)).toBeNull();
  });
});

describe("buildTimeframeContext — concordância NUNCA eleva a confiança", () => {
  /**
   * A PROPRIEDADE MAIS IMPORTANTE DO MÓDULO: para qualquer combinação de
   * execução e superiores, o ajuste é ≤ 0. É o que impede dois vieses
   * concordantes de virarem, na tela, uma confirmação que nenhum candle deu.
   */
  it("propriedade: confidenceAdjustment <= 0 para qualquer entrada", () => {
    const lados: TimeframeBias[] = ["COMPRA", "VENDA", "NEUTRO"];
    const timeframes = ["1Min", "5Min", "15Min", "Diário", "gráfico maior", null];
    const confiancas = [0, 59, 60, 90, 100, Number.NaN];

    for (const execBias of lados) {
      for (const execTf of timeframes) {
        for (const bias of lados) {
          for (const tf of timeframes) {
            for (const confidence of confiancas) {
              const contexto = buildTimeframeContext({ timeframe: execTf, bias: execBias }, [
                superior({ timeframe: tf, bias, confidence }),
                superior({ timeframe: "Diário", bias, confidence, source: "print #1" }),
              ]);
              expect(contexto.confidenceAdjustment).toBeLessThanOrEqual(0);
              expect(Number.isFinite(contexto.confidenceAdjustment)).toBe(true);
              expect(contexto.note.trim().length).toBeGreaterThan(0);
            }
          }
        }
      }
    }
  });

  it("concordância deixa o ajuste em 0 e diz que não é confirmação", () => {
    const contexto = buildTimeframeContext({ timeframe: "1Min", bias: "COMPRA" }, [
      superior({ timeframe: "15Min", bias: "COMPRA" }),
      superior({ timeframe: "Diário", bias: "COMPRA", source: "print #1" }),
    ]);
    expect(contexto.agreement).toBe("CONCORDA");
    expect(contexto.confidenceAdjustment).toBe(0);
    expect(contexto.note).toContain("Concordância NÃO confirma entrada");
    expect(contexto.higher).toHaveLength(2);
  });
});

describe("buildTimeframeContext — divergência rebaixa, não bloqueia", () => {
  it("um superior contrário marca DIVERGE com ajuste negativo e teto respeitado", () => {
    const contexto = buildTimeframeContext({ timeframe: "1Min", bias: "COMPRA" }, [
      superior({ timeframe: "15Min", bias: "VENDA", confidence: 80 }),
    ]);
    expect(contexto.agreement).toBe("DIVERGE");
    expect(contexto.confidenceAdjustment).toBe(-18);
    expect(contexto.note).toContain("Contexto contrário NÃO impede a técnica");
  });

  it("vários divergentes não passam do teto — filtro rebaixa, nunca veta", () => {
    const contexto = buildTimeframeContext({ timeframe: "1Min", bias: "VENDA" }, [
      superior({ timeframe: "5Min", bias: "COMPRA", confidence: 100 }),
      superior({ timeframe: "15Min", bias: "COMPRA", confidence: 100, source: "print #2" }),
      superior({ timeframe: "Diário", bias: "COMPRA", confidence: 100, source: "print #1" }),
    ]);
    expect(contexto.agreement).toBe("DIVERGE");
    expect(contexto.confidenceAdjustment).toBe(-30);
  });

  it("divergente vence concordante e os dois são ditos na nota", () => {
    const contexto = buildTimeframeContext({ timeframe: "1Min", bias: "COMPRA" }, [
      superior({ timeframe: "5Min", bias: "COMPRA" }),
      superior({ timeframe: "Diário", bias: "VENDA", source: "print #1" }),
    ]);
    expect(contexto.agreement).toBe("DIVERGE");
    expect(contexto.confidenceAdjustment).toBeLessThan(0);
    expect(contexto.note).toContain("Diário VENDA");
    expect(contexto.note).toContain("5Min COMPRA");
  });
});

describe("buildTimeframeContext — sem dado confiável não se inventa viés", () => {
  it("lista vazia dá SEM_DADOS com ajuste 0 e nota dizendo que nada foi suposto", () => {
    const contexto = buildTimeframeContext({ timeframe: "1Min", bias: "COMPRA" }, []);
    expect(contexto.agreement).toBe("SEM_DADOS");
    expect(contexto.confidenceAdjustment).toBe(0);
    expect(contexto.higher).toEqual([]);
    expect(contexto.note).toContain("nada foi suposto");
  });

  it("confiança abaixo do piso é descartada com o motivo, e sozinha dá SEM_DADOS", () => {
    const contexto = buildTimeframeContext({ timeframe: "1Min", bias: "COMPRA" }, [
      superior({ timeframe: "15Min", bias: "VENDA", confidence: 40 }),
    ]);
    expect(contexto.agreement).toBe("SEM_DADOS");
    expect(contexto.confidenceAdjustment).toBe(0);
    expect(contexto.note).toContain("abaixo do piso");
  });

  it("confiança não numérica NÃO passa pelo piso por acidente", () => {
    const contexto = buildTimeframeContext({ timeframe: "1Min", bias: "COMPRA" }, [
      superior({ timeframe: "15Min", bias: "VENDA", confidence: Number.NaN }),
    ]);
    expect(contexto.agreement).toBe("SEM_DADOS");
    expect(contexto.note).toContain("confiança não reportada");
  });

  it("timeframe não identificado ou irreconhecível não vira contexto", () => {
    const contexto = buildTimeframeContext({ timeframe: "1Min", bias: "COMPRA" }, [
      superior({ timeframe: null, bias: "VENDA" }),
      superior({ timeframe: "gráfico maior", bias: "VENDA", source: "print #1" }),
    ]);
    expect(contexto.agreement).toBe("SEM_DADOS");
    expect(contexto.higher).toEqual([]);
    expect(contexto.note).toContain("timeframe não identificado");
    expect(contexto.note).toContain("não reconhecido");
  });

  it("timeframe igual ou menor que a execução NÃO é contexto superior", () => {
    const contexto = buildTimeframeContext({ timeframe: "15Min", bias: "COMPRA" }, [
      superior({ timeframe: "1Min", bias: "VENDA" }),
      superior({ timeframe: "15Min", bias: "VENDA", source: "print #1" }),
    ]);
    expect(contexto.agreement).toBe("SEM_DADOS");
    expect(contexto.note).toContain("não é SUPERIOR à execução");
  });

  it("execução sem timeframe identificado: as leituras entram, mas a hierarquia é declarada não verificada", () => {
    const contexto = buildTimeframeContext({ timeframe: null, bias: "COMPRA" }, [
      superior({ timeframe: "15Min", bias: "VENDA" }),
    ]);
    expect(contexto.execution.timeframe).toBe(NAO_IDENTIFICADO);
    expect(contexto.agreement).toBe("DIVERGE");
    expect(contexto.note).toContain("Hierarquia NÃO verificada");
  });
});

describe("buildTimeframeContext — neutro é neutro", () => {
  it("execução sem lado não tem do que divergir", () => {
    const contexto = buildTimeframeContext({ timeframe: "1Min", bias: "NEUTRO" }, [
      superior({ timeframe: "Diário", bias: "VENDA" }),
    ]);
    expect(contexto.agreement).toBe("NEUTRO");
    expect(contexto.confidenceAdjustment).toBe(0);
    expect(contexto.note).toContain("não tem lado definido");
  });

  it("superiores todos sem lado: NEUTRO, sem nada a favor nem contra", () => {
    const contexto = buildTimeframeContext({ timeframe: "1Min", bias: "COMPRA" }, [
      superior({ timeframe: "Diário", bias: "NEUTRO" }),
    ]);
    expect(contexto.agreement).toBe("NEUTRO");
    expect(contexto.confidenceAdjustment).toBe(0);
    expect(contexto.note).toContain("Nada a favor, nada contra");
  });
});

describe("buildTimeframeContext — determinismo", () => {
  it("mesma entrada, mesmo contexto", () => {
    const entradas: [Parameters<typeof buildTimeframeContext>[0], HigherTimeframeReading[]] = [
      { timeframe: "1Min", bias: "VENDA" },
      [superior({ timeframe: "Diário", bias: "COMPRA" }), superior({ timeframe: "5Min" })],
    ];
    expect(buildTimeframeContext(...entradas)).toEqual(buildTimeframeContext(...entradas));
  });
});
