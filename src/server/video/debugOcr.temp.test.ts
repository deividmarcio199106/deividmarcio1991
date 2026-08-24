/** DEBUG do OCR (DEBUG_OCR=1): segmentação de UMA caixa com verdade conhecida. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { probeVideo } from "./ffmpeg";
import { lerFrames } from "./frames";
import { detectarLinhasDoEixo, detectarCaixaDePreco } from "./calibration";
import { binarizar, segmentar } from "./ocrDigitos";

describe.skipIf(process.env.DEBUG_OCR !== "1")("debug ocr", () => {
  it("segmenta a caixa de amostras conhecidas", { timeout: 300_000 }, async () => {
    const varredura = JSON.parse(
      readFileSync("t4-learning/dataset/marco/varredura-mes.json", "utf8"),
    ) as { pontos: Array<{ segundoNoVideo: number; preco: number | null }> };
    const verdade = varredura.pontos.filter((p) => p.preco !== null).slice(0, 2000);
    const amostras = [verdade[100]!, verdade[600]!, verdade[1200]!, verdade[1900]!];
    const info = probeVideo("C:/Users/user/Desktop/BACKTEST/marco.mp4");
    if ("erro" in info) throw new Error("probe");
    for (const amostra of amostras) {
      for await (const f of lerFrames(info, {
        fps: 10,
        inicioSeg: amostra.segundoNoVideo,
        fimSeg: amostra.segundoNoVideo + 0.15,
      })) {
        const frame = f.frame;
        const geo = detectarLinhasDoEixo(frame);
        const yCaixa = detectarCaixaDePreco(frame);
        if (geo.colunas === null || yCaixa === null) {
          console.log(`s=${amostra.segundoNoVideo}: sem geometria`);
          break;
        }
        const [x0, x1] = geo.colunas;
        const regiao = {
          left: x0 - 2,
          top: Math.round(yCaixa) - 9,
          width: x1 - x0 + 6,
          height: 19,
        };
        const { grade, w, h } = binarizar(frame, regiao);
        const caixas = segmentar(grade, w, h);
        let arte = "";
        for (let y = 0; y < h; y++) {
          let linha = "";
          for (let x = 0; x < w; x++) linha += grade[y * w + x] ? "#" : ".";
          arte += linha + "\n";
        }
        console.log(
          `s=${amostra.segundoNoVideo} verdade=${amostra.preco} glifos=${caixas.length} larguras=${caixas.map((c) => c[1] - c[0] + 1).join(",")}\n${arte}`,
        );
        break;
      }
    }
    expect(true).toBe(true);
  });
});
