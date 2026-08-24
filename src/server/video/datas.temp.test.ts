import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Experimento de EXPLORACAO arquivado: roda so com EXPLORACAO_T4=1 — uma
// suite normal nunca dispara GPU/video por engano. Guardado porque a evidencia
// que ele produziu esta citada em commits e comentarios do motor.
const exploracao = process.env["EXPLORACAO_T4"] === "1" ? describe : describe.skip;
import { probeVideo } from "@/server/video/ffmpeg";
import { lerFrames, recorteAmpliado, recorteParaPngDataUrl } from "@/server/video/frames";
import { extractJsonObject } from "@/lib/jsonExtract";
import { aiConfig } from "@/services/ai/config";

/**
 * CONFIRMAR FRONTEIRAS DE DIA PELO EIXO DE TEMPO.
 *
 * O metodo de gap sozinho foi reprovado (23 fronteiras onde ha ~15 dias). Mas
 * a virada de pregao esta ESCRITA no eixo: os rotulos resetam de ~18:xx para
 * ~09:xx, e a data ("05/mar") aparece na fronteira. Entao cada fronteira
 * candidata recebe uma pergunta FOCADA — "ha virada de dia visivel?" — em vez
 * de transcricao completa, que se provou fragil (14 de 23 leituras vazias).
 */

const SAIDA =
  "C:/Users/user/AppData/Local/Temp/claude/C--Users-user-Desktop-projetos--REF-PRODUCAO/802c0c0d-3353-4235-90d1-02a0f0d4faa1/scratchpad";

const DATASET =
  process.env["DATASET_DIAS"] ??
  "C:/Users/user/Desktop/projetos/_REF_PRODUCAO/ANALISADOR_T4_RTD/ANALISADOR_T4_RTD/t4-learning/dataset/marco/varredura-parcial-959s.json";

const PERGUNTA =
  "Esta imagem é o EIXO DE TEMPO (horizontal) de um gráfico de candles intradiário. " +
  "Os rótulos são horários (ex.: 15:49) e, nas viradas de pregão, datas (ex.: 05/mar). " +
  'Responda APENAS JSON: {"viradaDeDia": true ou false, "dataVisivel": "texto da data" ou null, ' +
  '"primeiroHorario": "HH:MM" ou null, "ultimoHorario": "HH:MM" ou null}. ' +
  "viradaDeDia é true quando os horários RESETAM no meio do eixo (ex.: 18:13 seguido de 09:03) " +
  "ou quando há um rótulo de data no meio.";

async function perguntar(config: ReturnType<typeof aiConfig>, dataUrl: string) {
  const base64 = dataUrl.split(",")[1]!;
  const resposta = await fetch(`${config.baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.visionModel,
      stream: false,
      think: false,
      format: "json",
      messages: [{ role: "user", content: PERGUNTA, images: [base64] }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const json = (await resposta.json()) as { message?: { content?: string } };
  return extractJsonObject(json.message?.content ?? "");
}

exploracao("FRONTEIRAS DE DIA — pergunta focada ao eixo", () => {
  it(
    "confirma ou derruba cada fronteira candidata",
    async () => {
      const config = aiConfig();
      const dataset = JSON.parse(readFileSync(DATASET, "utf8")) as {
        dias: Array<{ numero: number; inicioSeg: number; fimSeg: number }>;
      };
      const info = probeVideo("C:/Users/user/Desktop/BACKTEST/marco.mp4");
      if ("erro" in info) throw new Error(info.erro);

      const resultados: unknown[] = [];
      // A primeira "fronteira" e o inicio do video — nao ha virada para conferir.
      for (const dia of dataset.dias.slice(1)) {
        // Na fronteira exata a virada esta na DIREITA da tela; 1 s depois ainda esta visivel.
        const alvo = dia.inicioSeg + 1;
        let cru: string | null = null;
        let ampliado: string | null = null;
        for await (const f of lerFrames(info, { fps: 10, inicioSeg: alvo, fimSeg: alvo + 0.15 })) {
          cru = recorteParaPngDataUrl(f.frame, { left: 0, top: 640, width: 1340, height: 128 });
          ampliado = recorteAmpliado(f.frame, { left: 670, top: 690, width: 670, height: 60 }, 2);
          break;
        }
        if (cru === null) {
          resultados.push({ segmento: dia.numero, erro: "sem frame" });
          continue;
        }
        const t0 = Date.now();
        try {
          // 1a tentativa: faixa inteira. Fallback: metade direita ampliada 2x —
          // e onde a virada mora quando o pregao acabou de trocar.
          let objeto = await perguntar(config, cru);
          let origem = "faixa";
          if (objeto === null && ampliado !== null) {
            objeto = await perguntar(config, ampliado);
            origem = "ampliado";
          }
          resultados.push({
            segmento: dia.numero,
            inicioSeg: dia.inicioSeg,
            origem,
            latenciaMs: Date.now() - t0,
            leitura: objeto,
          });
        } catch (e) {
          resultados.push({ segmento: dia.numero, erro: String(e).slice(0, 120) });
        }
      }
      writeFileSync(`${SAIDA}/datas.json`, JSON.stringify(resultados, null, 1), "utf8");
      for (const r of resultados as Array<Record<string, unknown>>) {
        const l = r["leitura"] as Record<string, unknown> | null | undefined;
        console.log(
          `seg ${r["segmento"]} @${r["inicioSeg"]}s [${r["origem"] ?? "-"}] virada=${l?.["viradaDeDia"] ?? "?"} data=${l?.["dataVisivel"] ?? "-"} ${l?.["primeiroHorario"] ?? ""}→${l?.["ultimoHorario"] ?? ""} ${r["erro"] ?? ""}`,
        );
      }
      expect(resultados.length).toBeGreaterThan(0);
    },
    3600 * 1000,
  );
});
