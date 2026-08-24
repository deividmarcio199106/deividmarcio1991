import { describe, expect, it } from "vitest";

import {
  classifyFrame,
  emptyFreshnessMemory,
  estimateClockOffset,
  FRAME_STALE_AFTER_MS,
  PAUSA_LABEL,
  podeMostrarSincronizado,
  rotuloDeSincronismo,
  type FrameFreshness,
  type FreshnessMemory,
  type FrameObservation,
} from "../frameFreshness";

/**
 * FRESCOR DA CAPTURA (§5) — e o CASO B do aceite.
 *
 * A evidência da sessão de 19/08: os prints 012–016 eram idênticos, 017–018
 * idênticos e 031–040 ficaram congelados por dez capturas. Cada um virou uma
 * análise. O que este módulo garante é que dez capturas iguais produzam UMA
 * análise — e que a tela pare de dizer SINCRONIZADO enquanto isso acontece.
 */

const T0 = Date.UTC(2026, 7, 19, 13, 0, 0);
const MINUTO = 60_000;

/** Hashes distintos o bastante para não serem lidos como o mesmo frame. */
const HASH_A = "00".repeat(576);
const HASH_B = "ff".repeat(576);
const HASH_C = `${"ff".repeat(288)}${"00".repeat(288)}`;

function obs(over: Partial<FrameObservation> = {}): FrameObservation {
  return { capturedAt: T0, marketFrameAt: T0, frameHash: HASH_A, ...over };
}

/** Roda uma sequência de capturas carregando a memória, como em produção. */
function rodar(observacoes: FrameObservation[]): {
  frescores: FrameFreshness[];
  memoria: FreshnessMemory;
} {
  let memoria = emptyFreshnessMemory();
  const frescores = observacoes.map((o) => {
    const passo = classifyFrame(memoria, o);
    memoria = passo.memory;
    return passo.freshness;
  });
  return { frescores, memoria };
}

describe("§5 — frame novo", () => {
  it("a primeira captura é FRESH e analisável", () => {
    const [f] = rodar([obs()]).frescores;
    expect(f!.captureStatus).toBe("FRESH");
    expect(f!.analisavel).toBe(true);
    expect(f!.reason).not.toBe("");
    expect(f!.duplicateStreak).toBe(0);
  });

  it("imagem diferente é frame novo, e a memória guarda o último ÚNICO", () => {
    const { frescores, memoria } = rodar([
      obs(),
      obs({ capturedAt: T0 + MINUTO, marketFrameAt: T0 + MINUTO, frameHash: HASH_B }),
    ]);
    expect(frescores[1]!.captureStatus).toBe("FRESH");
    expect(memoria.lastUniqueHash).toBe(HASH_B);
    expect(memoria.lastUniqueFrameAt).toBe(T0 + MINUTO);
  });
});

describe("§5 — CASO B: dez capturas iguais, UMA análise", () => {
  /** Dez capturas com a MESMA imagem, um minuto entre elas. */
  function dezIguais() {
    return rodar(
      Array.from({ length: 10 }, (_, i) =>
        obs({ capturedAt: T0 + i * MINUTO, marketFrameAt: T0 + i * MINUTO }),
      ),
    );
  }

  it("exatamente UMA captura é analisável; as outras nove, não", () => {
    const { frescores } = dezIguais();
    const analisaveis = frescores.filter((f) => f.analisavel);
    expect(analisaveis).toHaveLength(1);
    expect(frescores[0]!.analisavel).toBe(true);
    expect(frescores.slice(1).every((f) => !f.analisavel)).toBe(true);
  });

  it("as repetidas são DUPLICATE e depois STALE — a fonte parou", () => {
    const { frescores } = dezIguais();
    expect(frescores[1]!.captureStatus).toBe("DUPLICATE");
    // Esgotadas as tentativas, deixa de ser "frame perdido" e vira fonte parada.
    expect(frescores[frescores.length - 1]!.captureStatus).toBe("STALE");
  });

  it("a contagem de repetições cresce e é dita", () => {
    const { frescores, memoria } = dezIguais();
    expect(frescores[frescores.length - 1]!.duplicateStreak).toBe(9);
    expect(memoria.duplicateStreak).toBe(9);
    for (const f of frescores.slice(1)) expect(f.reason).not.toBe("");
  });

  it("§3 — recapturar tem limite: passa de 'tente de novo' para 'parou'", () => {
    const { frescores } = dezIguais();
    expect(frescores[1]!.podeRecapturar).toBe(true);
    expect(frescores[frescores.length - 1]!.podeRecapturar).toBe(false);
  });

  it("o último frame ÚNICO não se move enquanto a imagem repete", () => {
    const { memoria } = dezIguais();
    expect(memoria.lastUniqueFrameAt).toBe(T0);
    expect(memoria.lastUniqueHash).toBe(HASH_A);
  });

  it("quando a imagem finalmente muda, volta a ser analisável", () => {
    const iguais = Array.from({ length: 10 }, (_, i) =>
      obs({ capturedAt: T0 + i * MINUTO, marketFrameAt: T0 + i * MINUTO }),
    );
    const { frescores, memoria } = rodar([
      ...iguais,
      obs({ capturedAt: T0 + 10 * MINUTO, marketFrameAt: T0 + 10 * MINUTO, frameHash: HASH_C }),
    ]);
    const ultimo = frescores[frescores.length - 1]!;
    expect(ultimo.captureStatus).toBe("FRESH");
    expect(ultimo.analisavel).toBe(true);
    expect(memoria.duplicateStreak).toBe(0);
  });
});

describe("§5 — horário regressivo e envelhecimento", () => {
  it("horário do mercado andando para TRÁS é OUT_OF_ORDER, não atraso", () => {
    const { frescores } = rodar([
      obs(),
      obs({ capturedAt: T0 + MINUTO, marketFrameAt: T0 + MINUTO, frameHash: HASH_B }),
      obs({ capturedAt: T0 + 2 * MINUTO, marketFrameAt: T0 - 10 * MINUTO, frameHash: HASH_C }),
    ]);
    const ultimo = frescores[2]!;
    expect(ultimo.captureStatus).toBe("OUT_OF_ORDER");
    expect(ultimo.analisavel).toBe(false);
    expect(ultimo.reason).not.toBe("");
  });

  it("frame muito velho, já descontado o offset, é STALE", () => {
    const atrasado = obs({
      capturedAt: T0 + 10 * MINUTO,
      marketFrameAt: T0 + MINUTO,
      frameHash: HASH_B,
    });
    const { frescores } = rodar([obs(), atrasado]);
    expect(frescores[1]!.captureStatus).toBe("STALE");
    expect(frescores[1]!.analisavel).toBe(false);
    expect(FRAME_STALE_AFTER_MS).toBeGreaterThan(0);
  });

  it("sem horário do mercado, a idade real NÃO é afirmada", () => {
    const [f] = rodar([obs({ marketFrameAt: null })]).frescores;
    expect(f!.frameAgeSec).toBeNull();
    expect(f!.frameAgeRealSec).toBeNull();
  });

  it("vídeo congelado detectado pelo heartbeat também bloqueia", () => {
    const { frescores } = rodar([
      obs(),
      obs({ capturedAt: T0 + MINUTO, frameHash: HASH_B, frozen: true }),
    ]);
    expect(frescores[1]!.analisavel).toBe(false);
  });
});

describe("§6 — offset de relógio não é atraso", () => {
  it("sem amostras suficientes o offset não é afirmado", () => {
    expect(estimateClockOffset([])).toBeNull();
  });

  it("o offset é a parte CONSTANTE da diferença", () => {
    expect(estimateClockOffset([120_000, 120_050, 119_980, 120_010, 120_000])).toBeCloseTo(
      120_000,
      -2,
    );
  });

  it("amostras dispersas NÃO viram offset — null, nunca zero", () => {
    /*
     * Um OCR que leu 18:07 onde estava 13:07 envenena a janela. A resposta é
     * recusar-se a afirmar, e não "tirar a mediana e seguir": offset é uma
     * afirmação sobre o AMBIENTE, e afirmá-lo errado converte atraso real em
     * atraso compensado — que é o modo de falha caro deste módulo.
     */
    expect(estimateClockOffset([120_000, 120_000, 18_000_000, 120_000, 120_000])).toBeNull();
  });

  it("passada a leitura ruim, o offset volta a ser afirmável", () => {
    const boas = [120_000, 120_000, 120_000, 120_000, 120_000];
    expect(estimateClockOffset(boas)).not.toBeNull();
  });

  it("dois minutos de fuso constante NÃO derrubam a T4", () => {
    // Sem compensar, 120s de diferença estouraria o limite de envelhecimento.
    const DOIS_MIN = 2 * MINUTO;
    expect(DOIS_MIN).toBeGreaterThan(FRAME_STALE_AFTER_MS);
    const hashes = [HASH_A, HASH_B, HASH_C, HASH_A, HASH_B, HASH_C];
    const { frescores } = rodar(
      hashes.map((h, i) => ({
        capturedAt: T0 + i * MINUTO,
        marketFrameAt: T0 + i * MINUTO - DOIS_MIN,
        frameHash: h,
      })),
    );
    const ultimo = frescores[frescores.length - 1]!;
    expect(ultimo.clockOffsetMs).not.toBeNull();
    expect(ultimo.captureStatus).toBe("FRESH");
    expect(ultimo.analisavel).toBe(true);
  });
});

describe("§5 — a tela nunca mente sobre sincronismo", () => {
  it("frame repetido NUNCA aparece como SINCRONIZADO", () => {
    const { frescores } = rodar([obs(), obs({ capturedAt: T0 + MINUTO })]);
    const duplicado = frescores[1]!;
    expect(podeMostrarSincronizado(duplicado, "SINCRONIZADO")).toBe(false);
    expect(rotuloDeSincronismo(duplicado, "SINCRONIZADO")).toBe(PAUSA_LABEL);
  });

  it("frame novo e no horário PODE aparecer como sincronizado", () => {
    const [f] = rodar([obs()]).frescores;
    expect(podeMostrarSincronizado(f!, "SINCRONIZADO")).toBe(true);
    expect(rotuloDeSincronismo(f!, "SINCRONIZADO")).toBe("SINCRONIZADO");
  });

  it("captura atrasada continua sendo dita como atraso, não como pausa", () => {
    const [f] = rodar([obs()]).frescores;
    expect(podeMostrarSincronizado(f!, "ATRASADO")).toBe(false);
    expect(rotuloDeSincronismo(f!, "ATRASADO")).toBe("ATRASADO");
  });

  it("sem frescor medido, o rótulo do atraso prevalece — nada é inventado", () => {
    expect(rotuloDeSincronismo(null, "PROCESSANDO")).toBe("PROCESSANDO");
    expect(podeMostrarSincronizado(null, "SINCRONIZADO")).toBe(true);
  });
});
