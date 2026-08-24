import { describe, expect, it } from "vitest";

import {
  cabeOutraInferencia,
  decompor,
  formatarTempos,
  RESERVA_DO_CICLO_MS,
  RESIDUO_TOLERAVEL_MS,
  StageClock,
} from "../stageTimings";

/**
 * O objetivo destes tempos não é performance por vaidade: é dar ENDEREÇO ao
 * atraso. Uma análise lenta sem discriminação é indistinguível de outra, e a
 * única reação possível vira aumentar timeout — esconder, não resolver.
 */

/** Relógio controlado: prova a aritmética em vez de confiar nela. */
function relogioFalso(passos: number[]) {
  let i = 0;
  return () => passos[Math.min(i++, passos.length - 1)]!;
}

describe("a origem do cronômetro é a CAPTURA, não o início da análise", () => {
  /**
   * O DEFEITO DE MEDIÇÃO QUE O VÍDEO DO OPERADOR REVELOU: com a fila ocupada,
   * o print espera antes de ser analisado. Medindo do início da inferência,
   * essa espera sumia do registro — e é ela que explode em cascata quando uma
   * análise ultrapassa o ciclo de 60s.
   */
  it("a espera na fila entra no total e aparece com nome próprio", () => {
    // Capturado em 0; a análise só começou aos 18s (fila ocupada).
    const clock = new StageClock(0, relogioFalso([18_000, 24_000]));
    clock.marcarInicioDaAnalise();
    clock.marcarUiSolicitada();
    const t = clock.snapshot();
    expect(t.queueWaitMs).toBe(18_000);
    // O operador cronometra da CAPTURA: 24s, não os 6s da inferência.
    expect(t.totalUntilUiMs).toBe(24_000);
    expect(t.marks.capturedAt).toBe(0);
    expect(t.marks.analysisStartedAt).toBe(18_000);
  });

  it("sem fila, a espera é ~zero e o total é o da análise", () => {
    const clock = new StageClock(1_000, relogioFalso([1_000, 7_000]));
    clock.marcarInicioDaAnalise();
    clock.marcarUiSolicitada();
    const t = clock.snapshot();
    expect(t.queueWaitMs).toBe(0);
    expect(t.totalUntilUiMs).toBe(6_000);
  });

  it("a fila entra na decomposição — não vira resíduo anônimo", () => {
    const clock = new StageClock(0, relogioFalso([18_000, 24_000]));
    clock.marcarInicioDaAnalise();
    clock.registrar("vision1", 5_800);
    clock.marcarUiSolicitada();
    const c = decompor(clock.snapshot());
    expect(c.somaDosEstagiosMs).toBe(23_800); // 18.000 de fila + 5.800 de visão
    expect(c.residuoMs).toBe(200);
    expect(c.residuoSuspeito).toBe(false);
  });
});

describe("StageClock", () => {
  it("mede um estágio e conta a chamada de IA quando ele é pesado", async () => {
    const clock = new StageClock(0, relogioFalso([0, 4_000]));
    await clock.medir("vision1", async () => "ok");
    const t = clock.snapshot();
    expect(t.vision1Ms).toBe(4_000);
    expect(t.callsIA).toBe(1);
  });

  it("estágio LEVE não conta como chamada de IA", async () => {
    const clock = new StageClock(0, relogioFalso([0, 12]));
    await clock.medir("validation", async () => "ok");
    expect(clock.snapshot().callsIA).toBe(0);
    expect(clock.snapshot().validationMs).toBe(12);
  });

  it("a régua conta como inferência, mesmo fora do caminho crítico", () => {
    const clock = new StageClock(0, relogioFalso([0]));
    clock.registrar("scale", 3_300);
    expect(clock.snapshot().callsIA).toBe(1);
    expect(clock.snapshot().scaleMs).toBe(3_300);
  });

  it("estágio repetido SOMA — um 2º passe não apaga o 1º", () => {
    const clock = new StageClock(0, relogioFalso([0]));
    clock.registrar("vision1", 5_000);
    clock.registrar("vision1", 3_000);
    expect(clock.snapshot().vision1Ms).toBe(8_000);
    expect(clock.snapshot().callsIA).toBe(2);
  });

  it("estágio que NÃO rodou fica null, nunca zero", () => {
    const t = new StageClock(0, relogioFalso([0])).snapshot();
    expect(t.vision2Ms).toBeNull();
    expect(t.auditMs).toBeNull();
    expect(t.queueWaitMs).toBeNull();
  });

  it("registrar(null) não inventa medida nem conta chamada", () => {
    const clock = new StageClock(0, relogioFalso([0]));
    clock.registrar("audit", null);
    expect(clock.snapshot().auditMs).toBeNull();
    expect(clock.snapshot().callsIA).toBe(0);
  });

  it("separa o tempo ATÉ A TELA do tempo total", () => {
    const clock = new StageClock(0, relogioFalso([0, 9_000, 25_000]));
    clock.marcarInicioDaAnalise();
    clock.marcarUiSolicitada();
    clock.marcarFim();
    const t = clock.snapshot();
    expect(t.totalUntilUiMs).toBe(9_000);
    expect(t.totalBackgroundMs).toBe(25_000);
    // Metade do tempo roda com o painel já preenchido.
    expect(t.totalUntilUiMs!).toBeLessThan(t.totalBackgroundMs!);
  });

  it("o render (pedir → pintar) é medido à parte", () => {
    const clock = new StageClock(0, relogioFalso([0, 9_000, 9_240]));
    clock.marcarInicioDaAnalise();
    clock.marcarUiSolicitada();
    clock.marcarUiPintada();
    expect(decompor(clock.snapshot()).renderMs).toBe(240);
  });

  it("marcarUiSolicitada só conta a PRIMEIRA vez — a tela aparece uma vez só", () => {
    const clock = new StageClock(0, relogioFalso([5_000, 40_000]));
    clock.marcarUiSolicitada();
    clock.marcarUiSolicitada();
    expect(clock.snapshot().totalUntilUiMs).toBe(5_000);
  });

  it("retries são contados — cada re-prompt custa uma inferência inteira", () => {
    const clock = new StageClock(0, relogioFalso([0]));
    clock.contarRetry(1);
    expect(clock.snapshot().retryCount).toBe(1);
  });

  it("a linha de log carrega captureId, instantes absolutos e contadores", () => {
    const clock = new StageClock(0, relogioFalso([2_000, 8_000]));
    clock.marcarInicioDaAnalise();
    clock.registrar("vision1", 6_000);
    clock.marcarUiSolicitada();
    const linha = formatarTempos("cap_1787_42", clock.snapshot());
    expect(linha).toContain("cap_1787_42");
    expect(linha).toContain("visao1=6000ms");
    expect(linha).toContain("fila=2000ms");
    expect(linha).toContain("chamadasIA=1");
    // Estágio não medido aparece como travessão, não como 0ms.
    expect(linha).toContain("auditor=—");
  });
});

describe("orçamento de tempo do ciclo", () => {
  it("cabe outra inferência quando sobra ciclo de folga", () => {
    expect(
      cabeOutraInferencia({ decorridoMs: 5_000, cicloMs: 60_000, duracaoEstimadaMs: 20_000 }),
    ).toBe(true);
  });

  it("NÃO cabe quando o 2º passe atrasaria a captura do candle seguinte", () => {
    expect(
      cabeOutraInferencia({ decorridoMs: 45_000, cicloMs: 60_000, duracaoEstimadaMs: 20_000 }),
    ).toBe(false);
  });

  it("a reserva protege o próximo candle — sem ela o limite seria outro", () => {
    const args = { decorridoMs: 30_000, cicloMs: 60_000, duracaoEstimadaMs: 25_000 };
    expect(cabeOutraInferencia(args)).toBe(false);
    expect(cabeOutraInferencia({ ...args, reservaMs: 0 })).toBe(true);
    expect(RESERVA_DO_CICLO_MS).toBeGreaterThan(0);
  });
});

/**
 * A CONTA TEM DE FECHAR — foi um resíduo sem nome que escondeu primeiro a
 * régua da escala e depois a espera de fila, as duas no caminho crítico.
 */
describe("decomposição fechada do tempo até a UI", () => {
  it("resíduo pequeno é overhead normal, não alarme", () => {
    const clock = new StageClock(0, relogioFalso([7_200]));
    clock.registrar("vision1", 6_000);
    clock.registrar("validation", 900);
    clock.marcarUiSolicitada();
    const c = decompor(clock.snapshot());
    expect(c.somaDosEstagiosMs).toBe(6_900);
    expect(c.residuoMs).toBe(300);
    expect(c.residuoSuspeito).toBe(false);
  });

  it("o caso do vídeo: visão 6s e UI 39s deixam 33s SEM NOME — e isso é alarme", () => {
    const clock = new StageClock(0, relogioFalso([39_400]));
    clock.registrar("vision1", 6_000);
    clock.marcarUiSolicitada();
    const c = decompor(clock.snapshot());
    expect(c.residuoMs).toBe(33_400);
    expect(c.residuoSuspeito).toBe(true);
  });

  it("com fila e 2º passe medidos, o mesmo 39s fecha a conta", () => {
    const clock = new StageClock(0, relogioFalso([16_000, 39_400]));
    clock.marcarInicioDaAnalise(); // 16s presos na fila
    clock.registrar("vision1", 6_000);
    clock.registrar("vision2", 6_500);
    clock.registrar("audit", 2_500);
    clock.registrar("crop", 8_000);
    clock.marcarUiSolicitada();
    const c = decompor(clock.snapshot());
    expect(c.residuoMs).toBe(400);
    expect(c.residuoSuspeito).toBe(false);
  });

  it("a régua NÃO entra no caminho crítico — ela roda depois da tela", () => {
    const clock = new StageClock(0, relogioFalso([6_200]));
    clock.registrar("vision1", 6_000);
    clock.registrar("scale", 3_300);
    clock.marcarUiSolicitada();
    const c = decompor(clock.snapshot());
    // Se a régua contasse, o resíduo ficaria negativo — sinal de que ela
    // estaria de volta ao caminho crítico sem ninguém perceber.
    expect(c.somaDosEstagiosMs).toBe(6_000);
    expect(c.residuoMs).toBe(200);
  });

  it("sem UI marcada não existe conta a fechar — null, nunca zero", () => {
    const c = decompor(new StageClock(0, relogioFalso([0])).snapshot());
    expect(c.residuoMs).toBeNull();
    expect(c.residuoSuspeito).toBe(false);
  });

  it("o limite tolerável é explícito e maior que zero", () => {
    expect(RESIDUO_TOLERAVEL_MS).toBeGreaterThan(0);
  });
});
