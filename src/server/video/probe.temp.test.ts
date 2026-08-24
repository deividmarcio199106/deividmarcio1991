import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Experimento de EXPLORACAO arquivado: roda so com EXPLORACAO_T4=1 — uma
// suite normal nunca dispara GPU/video por engano. Guardado porque a evidencia
// que ele produziu esta citada em commits e comentarios do motor.
const exploracao = process.env["EXPLORACAO_T4"] === "1" ? describe : describe.skip;
import { probeVideo } from "@/server/video/ffmpeg";
import { lerFrames, recorteParaPngDataUrl } from "@/server/video/frames";
import { CalibradorDeVideo } from "@/server/video/calibration";
import { aiConfig } from "@/services/ai/config";

const SAIDA =
  "C:/Users/user/AppData/Local/Temp/claude/C--Users-user-Desktop-projetos--REF-PRODUCAO/802c0c0d-3353-4235-90d1-02a0f0d4faa1/scratchpad";

/** O MESMO texto que `lerNiveisDedicado` manda — para medir o que ele devolve. */
function pedido(ativo: string, min: number, max: number): string {
  return (
    `Este é um gráfico de candles do ${ativo}. A escala de preços visível vai de ` +
    `${min} (base) a ${max} (topo), em pontos.\n\n` +
    `Leia a ESTRUTURA como um operador leria: topos e fundos, suporte e ` +
    `resistência, acumulação ou distribuição, onde o preço foi defendido e onde ` +
    `foi rejeitado.\n\n` +
    `Defina a REGIÃO OPERACIONAL mais próxima do preço atual — a faixa onde vale ` +
    `entrar, não uma linha única — e diga se essa região é de COMPRA (suporte/ ` +
    `demanda, entra comprado) ou de VENDA (resistência/oferta, entra vendido). ` +
    `Escolha pela estrutura, não por viés: se a região próxima é de resistência, ` +
    `a resposta é VENDA.\n\n` +
    `O STOP fica FORA da região, do lado da invalidação: abaixo de zonaMin numa ` +
    `COMPRA, acima de zonaMax numa VENDA.\n\n` +
    `Diga também onde está o PRÓXIMO OBSTÁCULO ESTRUTURAL na direção do ` +
    `trade — a primeira resistência acima numa COMPRA, o primeiro suporte ` +
    `abaixo numa VENDA. É o que limita o quanto o preço pode andar a favor.\n\n` +
    `Responda APENAS um JSON com inteiros dentro da faixa (ou null): ` +
    `{"direcao": "COMPRA" ou "VENDA", "zonaMin": limite inferior da região, ` +
    `"zonaMax": limite superior, "entry": referência dentro da região, ` +
    `"stop": invalidação fora da região, "obstaculo": próximo obstáculo ` +
    `estrutural a favor}.`
  );
}

exploracao("PROBE — o que o leitor devolve de verdade para os niveis", () => {
  it(
    "tres instantes de marco",
    async () => {
      const info = probeVideo("C:/Users/user/Desktop/BACKTEST/marco.mp4");
      if ("erro" in info) throw new Error(info.erro);
      const config = aiConfig();
      const cal = new CalibradorDeVideo("WINFUT", { intervaloOcrSeg: 30 });
      const alvos = new Set([82, 124, 149]); // décimos de segundo
      const saida: unknown[] = [];

      for await (const f of lerFrames(info, { fps: 10, inicioSeg: 0, fimSeg: 15.2 })) {
        const estado = await cal.atualizar(f.frame, f.segundoNoVideo);
        const chave = Math.round(f.segundoNoVideo * 10);
        if (!alvos.has(chave)) continue;
        const precos = estado.calibracao.anchors.map((a) => a.price).filter(Number.isFinite);
        if (!estado.utilizavel || precos.length < 2) {
          saida.push({ segundo: f.segundoNoVideo, erro: "sem regua", motivo: estado.motivo });
          continue;
        }
        const min = Math.round(Math.min(...precos));
        const max = Math.round(Math.max(...precos));
        const dataUrl = recorteParaPngDataUrl(f.frame, {
          left: 0,
          top: 82,
          width: 1340,
          height: 590,
        });
        const base64 = dataUrl?.split(",")[1];
        if (base64 === undefined) continue;
        const t0 = Date.now();
        const resposta = await fetch(`${config.baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: config.visionModel,
            stream: false,
            think: false,
            format: "json",
            messages: [{ role: "user", content: pedido("WINFUT", min, max), images: [base64] }],
          }),
          signal: AbortSignal.timeout(120_000),
        });
        const json = (await resposta.json()) as { message?: { content?: string } };
        saida.push({
          segundo: f.segundoNoVideo,
          faixa: [min, max],
          latenciaMs: Date.now() - t0,
          bruto: json.message?.content ?? null,
        });
      }
      writeFileSync(`${SAIDA}/probe.json`, JSON.stringify(saida, null, 1), "utf8");
      expect(saida.length).toBeGreaterThan(0);
    },
    30 * 60 * 1000,
  );
});
