import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Experimento de EXPLORACAO arquivado: roda so com EXPLORACAO_T4=1 — uma
// suite normal nunca dispara GPU/video por engano. Guardado porque a evidencia
// que ele produziu esta citada em commits e comentarios do motor.
const exploracao = process.env["EXPLORACAO_T4"] === "1" ? describe : describe.skip;
import { probeVideo } from "@/server/video/ffmpeg";
import {
  acharPivos,
  acharRegioes,
  agruparPorInstante,
  varrerPrecos,
} from "@/server/video/varredura";

const SAIDA =
  "C:/Users/user/AppData/Local/Temp/claude/C--Users-user-Desktop-projetos--REF-PRODUCAO/802c0c0d-3353-4235-90d1-02a0f0d4faa1/scratchpad";

exploracao("VARREDURA DE PRECO — pixel puro, sem modelo", () => {
  it(
    "marco 0-43s a cada 0.1s",
    async () => {
      const info = probeVideo("C:/Users/user/Desktop/BACKTEST/marco.mp4");
      if ("erro" in info) throw new Error(info.erro);
      const r = await varrerPrecos(info, {
        ativo: "WINFUT",
        inicioSeg: 0,
        fimSeg: 43,
        intervaloSeg: 0.1,
        intervaloOcrSeg: 30,
      });
      const pivos = acharPivos(r.pontos);
      const regioes = agruparPorInstante(acharRegioes(r.pontos));

      /*
       * O ERRO DE MEDIÇÃO MEDIDO NO PRÓPRIO MATERIAL — não herdado de uma nota.
       *
       * A discordância entre duas réguas sucessivas é o degrau de preço no frame
       * em que a época vira. É esse número, e não o erro de UMA reconstrução
       * contra referência, que precisa ficar abaixo dos limiares de pivô e de
       * região — senão a estrutura detectada é ruído de calibração.
       */
      const validos = r.pontos.filter((p): p is typeof p & { preco: number } => p.preco !== null);
      const degraus: Array<{ seg: number; degrau: number }> = [];
      for (let i = 1; i < validos.length; i++) {
        const a = validos[i - 1]!;
        const b = validos[i]!;
        if (b.epocaDaRegua !== a.epocaDaRegua) {
          degraus.push({ seg: b.segundoNoVideo, degrau: Math.abs(b.preco - a.preco) });
        }
      }
      degraus.sort((x, y) => x.degrau - y.degrau);

      writeFileSync(
        `${SAIDA}/varredura.json`,
        JSON.stringify(
          { resumo: { ...r, pontos: undefined }, degraus, pontos: r.pontos, pivos, regioes },
          null,
          1,
        ),
        "utf8",
      );
      console.log(`frames=${r.framesLidos} comPreco=${r.comPreco} pivos=${pivos.length}`);
      expect(r.framesLidos).toBeGreaterThan(100);
    },
    30 * 60 * 1000,
  );
});
