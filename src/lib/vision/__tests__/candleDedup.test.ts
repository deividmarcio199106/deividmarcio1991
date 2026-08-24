import { describe, expect, it } from "vitest";

import {
  ChartTracker,
  MAX_NEW_CLOSED_PER_FRAME,
  RESYNC_AFTER,
  frameFingerprint,
} from "../chartTracker";
import type { ExtractedCandle } from "@/lib/capture/frameProcessor";

/**
 * O DEFEITO QUE ESTES TESTES TRANCAM.
 *
 * Ao vivo, a série pulou de ~212 para ~258 candles em poucos segundos num
 * gráfico de 1 minuto, enquanto o diagnóstico mostrava 69 visíveis e 69
 * parseados. Não existe mercado que feche 46 candles de um minuto em segundos:
 * era a mesma história entrando de novo, e estrutura, regime e viés estavam
 * sendo calculados sobre um passado repetido.
 */

/**
 * Passeio determinístico — NÃO uma progressão aritmética.
 *
 * Uma rampa linear é afimemente auto-similar: qualquer trecho pode ser mapeado
 * sobre qualquer outro por escala+deslocamento, e o costurador (que aceita
 * casamento afim para sobreviver à autoescala do Profit) casaria posições
 * erradas por construção. Preço real não tem essa degenerescência, e o teste
 * também não pode ter — senão mede o artefato, não o comportamento.
 */
function priceAt(index: number): number {
  let value = 1_000;
  let seed = 7;
  for (let i = 0; i <= index; i++) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    value += ((seed % 200) - 100) / 10;
  }
  return value;
}

function series(from: number, count: number): ExtractedCandle[] {
  return Array.from({ length: count }, (_, i) => {
    const open = priceAt(from + i);
    const close = priceAt(from + i + 1);
    return {
      t: (from + i) * 60_000,
      o: open,
      h: Math.max(open, close) + 1.5,
      l: Math.min(open, close) - 1.5,
      c: close,
      v: 100,
      quality: 1,
    } as ExtractedCandle;
  });
}

const NOW = 1_770_000_000_000;

describe("ChartTracker — antiduplicação", () => {
  it("mesmo frame 100 vezes não cria nenhum candle novo", () => {
    const tracker = new ChartTracker();
    const frame = series(0, 40);

    expect(tracker.push(frame, NOW)).toBe(true);
    const afterBootstrap = tracker.snapshot().closedCandlesAccepted;

    for (let i = 0; i < 100; i++) {
      expect(tracker.push(frame, NOW + i * 500)).toBe(false);
    }

    const state = tracker.snapshot();
    expect(state.closedCandlesAccepted).toBe(afterBootstrap);
    expect(state.identicalFrames).toBe(100);
    expect(state.newClosedCandles).toBe(0);
    // Frame repetido não é erro: é o estado normal de gráfico parado.
    expect(state.rejectReason).toBeNull();
  });

  it("um candle novo de verdade entra exatamente uma vez", () => {
    const tracker = new ChartTracker();
    tracker.push(series(0, 40), NOW);
    const before = tracker.snapshot().closedCandlesAccepted;

    // O gráfico rolou uma coluna: o mais antigo saiu, um novo entrou.
    tracker.push(series(1, 40), NOW + 60_000);

    const state = tracker.snapshot();
    expect(state.closedCandlesAccepted).toBe(before + 1);
    expect(state.newClosedCandles).toBe(1);
    expect(state.duplicatesRejected).toBe(0);
  });

  it("o mesmo histórico reaparecendo não duplica a série", () => {
    const tracker = new ChartTracker();
    tracker.push(series(0, 40), NOW);
    const before = tracker.snapshot().closedCandlesAccepted;

    // Frames seguintes mostram a MESMA história com o candle em formação
    // variando de leitura — é o que acontece na tela a cada 500ms.
    for (let i = 1; i <= 20; i++) {
      const frame = series(0, 40);
      frame[frame.length - 1] = {
        ...frame[frame.length - 1]!,
        c: frame[frame.length - 1]!.c + 0.01 * i,
      };
      tracker.push(frame, NOW + i * 500);
    }

    expect(tracker.snapshot().closedCandlesAccepted).toBe(before);
  });

  it("frame que tenta revelar 46 candles de uma vez é RECUSADO com motivo", () => {
    const tracker = new ChartTracker();
    tracker.push(series(0, 69), NOW);
    const before = tracker.snapshot().closedCandlesAccepted;

    // Exatamente o salto observado no vídeo: 46 candles fechados aparecendo
    // entre dois frames de meio segundo num gráfico de 1 minuto.
    tracker.push(series(46, 69), NOW + 500);

    const state = tracker.snapshot();
    expect(state.closedCandlesAccepted).toBe(before);
    expect(state.duplicatesRejected).toBe(1);
    expect(state.rejectReason).toContain("46");
    expect(state.rejectReason).toContain("história repetida");
  });

  it("o teto vale por frame, e não impede o bootstrap inicial", () => {
    const tracker = new ChartTracker();
    // O primeiro frame é o bootstrap: 69 candles de uma vez é legítimo.
    expect(tracker.push(series(0, 69), NOW)).toBe(true);
    expect(tracker.snapshot().closedCandlesAccepted).toBe(69);
    expect(tracker.snapshot().duplicatesRejected).toBe(0);
    expect(MAX_NEW_CLOSED_PER_FRAME).toBeLessThan(69);
  });

  it("candles fechados nunca crescem mais rápido que o relógio de 1 minuto", () => {
    const tracker = new ChartTracker();
    tracker.push(series(0, 60), NOW);

    // 120 frames em 60 segundos (500ms cada), com o gráfico avançando um candle
    // a cada 120 frames — ou seja, um minuto.
    let offset = 0;
    for (let frame = 1; frame <= 120; frame++) {
      if (frame % 120 === 0) offset += 1;
      tracker.push(series(offset, 60), NOW + frame * 500);
    }

    const state = tracker.snapshot();
    // No máximo um candle novo em um minuto de frames.
    expect(state.closedSinceBootstrap).toBeLessThanOrEqual(1);
  });
});

describe("frameFingerprint", () => {
  it("séries idênticas têm a mesma assinatura", () => {
    expect(frameFingerprint(series(0, 30))).toBe(frameFingerprint(series(0, 30)));
  });

  it("um candle diferente muda a assinatura", () => {
    const a = series(0, 30);
    const b = series(0, 30);
    b[29] = { ...b[29]!, c: b[29]!.c + 5 };
    expect(frameFingerprint(a)).not.toBe(frameFingerprint(b));
  });
});

/**
 * A RECUSA NÃO PODE VIRAR CONGELAMENTO.
 *
 * O teto supõe continuidade — um frame revela zero ou um candle fechado. Isso
 * QUEBRA em eventos legítimos: janela minimizada por dez minutos, notebook
 * suspenso, leilão. Sem uma saída, o primeiro salto verdadeiro recusaria todo
 * frame seguinte para sempre, e a T4 seguiria analisando um passado obsoleto
 * sem que nada na tela indicasse o problema.
 */
describe("ChartTracker — resync após gap legítimo", () => {
  it("gap grande e persistente faz a série recomeçar em vez de congelar", () => {
    const tracker = new ChartTracker();
    tracker.push(series(0, 60), NOW);
    const antes = tracker.snapshot().closedCandlesAccepted;

    // Janela minimizada por 10 minutos: ao voltar, o gráfico saltou 10 candles
    // e continua andando. Cada frame novo mostra o mesmo salto.
    let aceitou = false;
    for (let i = 0; i < RESYNC_AFTER + 2; i++) {
      if (tracker.push(series(10 + i, 60), NOW + 600_000 + i * 500)) aceitou = true;
    }

    const estado = tracker.snapshot();
    expect(aceitou).toBe(true);
    expect(estado.closedCandlesAccepted).toBeGreaterThan(0);
    expect(estado.discontinuities).toBeGreaterThan(0);
    // A série voltou a acompanhar o gráfico, não ficou presa no passado.
    expect(estado.rejectReason).toBeNull();
    expect(antes).toBeGreaterThan(0);
  });

  it("um salto isolado ainda é recusado — o resync exige insistência", () => {
    const tracker = new ChartTracker();
    tracker.push(series(0, 60), NOW);
    const antes = tracker.snapshot().closedCandlesAccepted;

    expect(tracker.push(series(46, 60), NOW + 500)).toBe(false);
    expect(tracker.snapshot().closedCandlesAccepted).toBe(antes);
    expect(tracker.snapshot().duplicatesRejected).toBe(1);
  });
});
