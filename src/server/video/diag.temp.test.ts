import { describe, expect, it } from "vitest";

// Experimento de EXPLORACAO arquivado: roda so com EXPLORACAO_T4=1 — uma
// suite normal nunca dispara GPU/video por engano. Guardado porque a evidencia
// que ele produziu esta citada em commits e comentarios do motor.
const exploracao = process.env["EXPLORACAO_T4"] === "1" ? describe : describe.skip;
import { writeFileSync } from "node:fs";
import { probeVideo } from "@/server/video/ffmpeg";
import { lerFrames } from "@/server/video/frames";
import { CalibradorDeVideo } from "@/server/video/calibration";

const SAIDA =
  "C:/Users/user/AppData/Local/Temp/claude/C--Users-user-Desktop-projetos--REF-PRODUCAO/802c0c0d-3353-4235-90d1-02a0f0d4faa1/scratchpad";

exploracao("DIAG — por que a propagacao da regua falha", () => {
  it(
    "30 frames a cada 0.1s",
    async () => {
      const info = probeVideo("C:/Users/user/Desktop/BACKTEST/marco.mp4");
      if ("erro" in info) throw new Error(info.erro);
      const cal = new CalibradorDeVideo("WINFUT", { intervaloOcrSeg: 30 });
      const linhas: string[] = [];
      for await (const f of lerFrames(info, { fps: 10, inicioSeg: 0, fimSeg: 3 })) {
        const e = await cal.atualizar(f.frame, f.segundoNoVideo);
        linhas.push(
          `${f.segundoNoVideo.toFixed(1)}s util=${e.utilizavel} origem=${e.origem} motivo=${e.motivo ?? "-"} ` +
            `linhas=${e.linhasDetectadas} passoPx=${e.passoPx?.toFixed(2) ?? "-"} passoPreco=${e.passoPreco ?? "-"} ` +
            `r2=${e.r2.toFixed(6)} desvio=${Number.isFinite(e.desvioMaxPx) ? e.desvioMaxPx.toFixed(2) : "inf"} ` +
            `ancoras=${e.calibracao.anchors.length} prop=${e.propagacoes} | ${e.ultimaMensagem}`,
        );
        if (e.grade.length > 0) {
          linhas.push(
            `      grade: ${e.grade.map((g) => `${g.y.toFixed(0)}:${g.price ?? "?"}`).join(" ")}`,
          );
        }
      }
      writeFileSync(`${SAIDA}/diag.txt`, linhas.join("\n"), "utf8");
      expect(linhas.length).toBeGreaterThan(0);
    },
    20 * 60 * 1000,
  );
});
