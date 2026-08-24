/**
 * SONDA VISUAL (roda só com SONDA_T4=1) — extrai recortes de UM frame para
 * calibrar os detectores determinísticos. PNGs em t4-learning/reconstrucao/probe/.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { probeVideo } from "./ffmpeg";
import { lerFrames, recorteParaPngDataUrl } from "./frames";
import { detectarLinhasDoEixo, detectarCaixaDePreco } from "./calibration";

const ATIVO = process.env.SONDA_T4 === "1";

describe.skipIf(!ATIVO)("sonda visual", () => {
  it("extrai recortes de calibração", { timeout: 300_000 }, async () => {
    const video = process.env.SONDA_VIDEO ?? "C:/Users/user/Desktop/BACKTEST/marco.mp4";
    const segundo = Number(process.env.SONDA_SEG ?? 30);
    const info = probeVideo(video);
    if ("erro" in info) throw new Error(info.erro);
    console.log("video:", info.largura, "x", info.altura, "dur", info.duracaoSeg);
    mkdirSync("t4-learning/reconstrucao/probe", { recursive: true });

    for await (const f of lerFrames(info, { fps: 1, inicioSeg: segundo, fimSeg: segundo + 1 })) {
      const frame = f.frame;
      const salvar = (
        nome: string,
        regiao: { left: number; top: number; width: number; height: number },
      ) => {
        const url = recorteParaPngDataUrl(frame, regiao);
        if (url) {
          writeFileSync(
            `t4-learning/reconstrucao/probe/${nome}.png`,
            Buffer.from(url.split(",")[1]!, "base64"),
          );
          console.log("salvo:", nome, JSON.stringify(regiao));
        }
      };

      salvar("topo", { left: 0, top: 0, width: frame.width, height: 90 });
      // Banda do contador: acha a caixa colorida na linha do título do gráfico.
      salvar("banda-contador", { left: 560, top: 72, width: 420, height: 22 });
      // Cores dominantes SÓ nessa banda, para calibrar o detector da caixa.
      const contagem = new Map<string, number>();
      for (let y = 74; y < 92; y++) {
        for (let x = 560; x < 980; x++) {
          const i = (y * frame.width + x) * 4;
          const r = frame.data[i]!,
            g = frame.data[i + 1]!,
            b = frame.data[i + 2]!;
          if (Math.max(r, g, b) - Math.min(r, g, b) > 50) {
            const k = `${r >> 3},${g >> 3},${b >> 3}`;
            contagem.set(k, (contagem.get(k) ?? 0) + 1);
          }
        }
      }
      console.log(
        "banda cores:",
        JSON.stringify([...contagem.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)),
      );
      const geo = detectarLinhasDoEixo(frame);
      console.log("colunas do eixo:", geo.colunas, "linhas:", geo.linhas?.length ?? null);
      const yCaixa = detectarCaixaDePreco(frame);
      console.log("yCaixa:", yCaixa);
      if (geo.colunas && yCaixa !== null) {
        const [x0, x1] = geo.colunas;
        salvar("caixa", { left: x0 - 3, top: yCaixa - 10, width: x1 - x0 + 8, height: 21 });
      }
      salvar("candles", {
        left: Math.round(frame.width * 0.55),
        top: Math.round(frame.height * 0.25),
        width: 220,
        height: 200,
      });
      salvar("tempo", {
        left: 0,
        top: frame.height - 45,
        width: Math.round(frame.width * 0.6),
        height: 45,
      });

      const cores = new Map<string, number>();
      for (let y = Math.round(frame.height * 0.1); y < Math.round(frame.height * 0.8); y += 2) {
        for (let x = Math.round(frame.width * 0.1); x < Math.round(frame.width * 0.85); x += 2) {
          const i = (y * frame.width + x) * 4;
          const r = frame.data[i]!;
          const g = frame.data[i + 1]!;
          const b = frame.data[i + 2]!;
          if (Math.max(r, g, b) - Math.min(r, g, b) > 40) {
            const chave = `${r >> 4},${g >> 4},${b >> 4}`;
            cores.set(chave, (cores.get(chave) ?? 0) + 1);
          }
        }
      }
      const top = [...cores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      console.log("cores saturadas dominantes (r,g,b >>4):", JSON.stringify(top));
      break;
    }
    expect(true).toBe(true);
  });
});
