/**
 * O VÍDEO COMO FONTE — o que estes testes trancam.
 *
 * Dois grupos, e a diferença entre eles é deliberada:
 *
 * 1. CONTRATO (sempre roda): extensões aceitas, recusa declarada quando o
 *    arquivo não existe, recusa declarada quando o ffmpeg falta. São as regras
 *    que impedem "vídeo ilegível" de virar "pregão sem operação" — o pior
 *    resultado possível, porque mente com cara de dado.
 *
 * 2. VÍDEO REAL (pula quando o material não está na máquina): decodifica
 *    frames de verdade e prova que eles atravessam o MESMO pipeline do ao
 *    vivo. Este é o teste que prova a paridade de núcleo; ele pula em vez de
 *    falhar porque as gravações são do operador, não do repositório.
 */

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { FrameProcessor } from "@/lib/capture/frameProcessor";
import { ChartTracker } from "@/lib/vision/chartTracker";
import { extensaoSuportada, probeVideo, resolveFfmpeg } from "../ffmpeg";
import { lerFrames } from "../frames";

const PASTA = "C:/Users/user/Desktop/BACKTEST";
const AMOSTRA = `${PASTA}/marco.mp4`;
const temFfmpeg = resolveFfmpeg() !== null;
const temVideo = existsSync(AMOSTRA);

describe("contrato da fonte de vídeo", () => {
  it("aceita os contêineres declarados e recusa o resto", () => {
    for (const ok of ["a.mp4", "b.MKV", "c.avi", "d.mov", "e.webm"]) {
      expect(extensaoSuportada(ok)).toBe(true);
    }
    for (const nao of ["planilha.csv", "print.png", "video.mp3", "sem-extensao"]) {
      expect(extensaoSuportada(nao)).toBe(false);
    }
  });

  it("arquivo inexistente vira ERRO DECLARADO, nunca vídeo vazio", () => {
    const r = probeVideo(`${PASTA}/mes-que-nao-existe.mp4`);
    expect("erro" in r).toBe(true);
    if ("erro" in r) expect(r.erro).toContain("não encontrado");
  });

  it("extensão não suportada é recusada antes de chamar o decodificador", () => {
    const r = probeVideo("C:/tmp/planilha.csv");
    expect("erro" in r).toBe(true);
  });
});

describe.skipIf(!temFfmpeg || !temVideo)("vídeo real atravessa o pipeline do ao vivo", () => {
  it("frames decodificados viram candles pelas MESMAS funções da captura de tela", async () => {
    const info = probeVideo(AMOSTRA);
    expect("erro" in info).toBe(false);
    if ("erro" in info) return;

    expect(info.largura).toBeGreaterThan(320);
    expect(info.duracaoSeg).toBeGreaterThan(1);

    const processor = new FrameProcessor();
    const tracker = new ChartTracker();
    // Instante de MERCADO derivado da posição no arquivo — nunca Date.now().
    const base = Date.UTC(2026, 2, 10, 13, 0, 0);

    let lidos = 0;
    let comCandles = 0;
    let ordemOk = true;
    let anterior = -1;

    for await (const f of lerFrames(info, { fps: 1, inicioSeg: 120, fimSeg: 150 })) {
      if (f.indice <= anterior) ordemOk = false;
      anterior = f.indice;
      lidos++;

      const read = processor.processPixels(f.frame, base + Math.round(f.segundoNoVideo * 1000));
      if (read === null) continue;
      if (read.candles.length > 0) comCandles++;
      tracker.push(read.candles, read.t);
    }

    // Os frames chegam em ordem estrita: é o que impede leitura de futuro.
    expect(ordemOk).toBe(true);
    expect(lidos).toBeGreaterThan(20);
    // O material real do Profit produz candles — se parar de produzir, algo
    // no caminho visual regrediu, e o teste tem de gritar.
    expect(comCandles).toBeGreaterThan(0);
  }, 600_000);

  it("o instante de cada frame cresce e vem do VÍDEO, não do relógio da máquina", async () => {
    const info = probeVideo(AMOSTRA);
    if ("erro" in info) return;

    const segundos: number[] = [];
    for await (const f of lerFrames(info, { fps: 2, inicioSeg: 60, fimSeg: 65 })) {
      segundos.push(f.segundoNoVideo);
    }

    expect(segundos.length).toBeGreaterThan(4);
    // Estritamente crescente e ancorado no recorte pedido.
    for (let i = 1; i < segundos.length; i++) {
      expect(segundos[i]!).toBeGreaterThan(segundos[i - 1]!);
    }
    expect(segundos[0]).toBeGreaterThanOrEqual(60);
    expect(segundos[segundos.length - 1]!).toBeLessThan(66);
  }, 600_000);
});
