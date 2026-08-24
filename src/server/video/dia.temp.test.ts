import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Experimento de EXPLORACAO arquivado: roda so com EXPLORACAO_T4=1 — uma
// suite normal nunca dispara GPU/video por engano. Guardado porque a evidencia
// que ele produziu esta citada em commits e comentarios do motor.
const exploracao = process.env["EXPLORACAO_T4"] === "1" ? describe : describe.skip;
import { probeVideo } from "@/server/video/ffmpeg";
import { lerPregaoDoVideo } from "@/server/video/pregao";
import { acharPivos, varrerPrecos } from "@/server/video/varredura";

const SAIDA =
  "C:/Users/user/AppData/Local/Temp/claude/C--Users-user-Desktop-projetos--REF-PRODUCAO/802c0c0d-3353-4235-90d1-02a0f0d4faa1/scratchpad/dia";

const PASSO = 0.1;

exploracao("PREGAO 02/mar — FUNIL: scanner permissivo, confirmacao rigorosa", () => {
  it(
    "todos os frames passam pelo scanner; o modelo vai aos candidatos",
    async () => {
      const info = probeVideo("C:/Users/user/Desktop/BACKTEST/marco.mp4");
      if ("erro" in info) throw new Error(info.erro);

      // PASSO 1 — o pregao inteiro so com pixels: serie de precos + pivos.
      const v = await varrerPrecos(info, {
        ativo: "WINFUT",
        inicioSeg: 0,
        fimSeg: 43,
        intervaloSeg: PASSO,
        intervaloOcrSeg: 30,
      });
      const pivos = acharPivos(v.pontos);

      // PASSO 2 — o funil: scanner permissivo decide frame a frame o que
      // merece modelo; a T4 confirma ou recusa com os gates de sempre.
      const r = await lerPregaoDoVideo(info, {
        ativo: "WINFUT",
        inicioSeg: 0,
        fimSeg: 43,
        intervaloSeg: PASSO,
        funil: {
          pivos,
          janelaDoPivo: 8,
          proximidadePontos: 250,
          reanalisarAposFrames: 12,
        },
        recorte: { left: 0, top: 82, width: 1340, height: 590 },
        exigirCandleFechado: false,
        pastaDeSaida: SAIDA,
      });

      // Drawdown em R sobre a sequencia de operacoes fechadas.
      let pico = 0;
      let acumulado = 0;
      let drawdownR = 0;
      for (const op of r.operacoes) {
        acumulado += op.r ?? 0;
        if (acumulado > pico) pico = acumulado;
        if (pico - acumulado > drawdownR) drawdownR = pico - acumulado;
      }

      writeFileSync(
        `${SAIDA}/relatorio.json`,
        JSON.stringify(
          {
            varredura: { ...v, pontos: undefined },
            serie: v.pontos,
            pivos,
            pregao: r,
            drawdownR,
          },
          null,
          1,
        ),
        "utf8",
      );
      const f = r.funil;
      console.log(
        `FUNIL: frames=${f.framesTotais} comPreco=${f.framesComPreco} candidatos=${f.candidatosFrames} ` +
          `episodios=${f.episodios} modelo=${f.chamadasDeModelo} track=${f.trackFrames} ` +
          `setups=${f.setupsNascidos} aprox=${r.aproximacoes} conf=${r.confirmacoes}`,
      );
      console.log(
        `ops=${r.operacoes.length} G=${r.ganhos} P=${r.perdas} pts=${r.pontosLiquidos.toFixed(0)} R=${r.somaR.toFixed(2)} dd=${drawdownR.toFixed(2)}R`,
      );
      console.log(`recusas=${JSON.stringify(f.recusas)}`);
      expect(f.framesTotais).toBeGreaterThan(100);
    },
    4 * 3600 * 1000,
  );
});
