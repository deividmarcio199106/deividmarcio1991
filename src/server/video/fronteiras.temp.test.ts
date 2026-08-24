import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Runner LONGO da campanha: fora dela (CAMPANHA_T4!=1) vira skip — uma suite
// normal de testes nunca dispara horas de GPU por engano.
const rodarCampanha = process.env["CAMPANHA_T4"] === "1" ? describe : describe.skip;
import { probeVideo } from "@/server/video/ffmpeg";
import { lerFrames, recorteAmpliado, recorteParaPngDataUrl } from "@/server/video/frames";
import { extractJsonObject } from "@/lib/jsonExtract";
import { aiConfig } from "@/services/ai/config";
import type { PontoDeVarredura } from "@/server/video/varredura";

/**
 * FRONTEIRAS DE PREGAO — candidato barato, prova cara, veredito por VOTO.
 *
 * O gap de preco sozinho foi REPROVADO (23 fronteiras onde ha ~15 dias). E o
 * booleano "viradaDeDia" do modelo tambem: ele negou viradas que os proprios
 * horarios que leu comprovavam (15:57 -> 09:20). Entao a regra e:
 *
 *   candidato  = gap de preco (limiar BAIXO, 600 — sensibilidade alta);
 *   prova      = leitura do eixo de tempo na fronteira;
 *   veredito   = DETERMINISTICO sobre o que foi lido: horario RESETOU
 *                (ultimo < primeiro, com folga de 3h) ou ha rotulo de DATA;
 *   confianca  = 3 leituras votam; 2 iguais decidem; sem maioria = AMBIGUOUS.
 *
 * AMBIGUOUS isola so aquele trecho — os outros dias seguem. O resultado e
 * CONGELADO em day-boundaries-frozen.json: baseline, H1, H2 e H1+H2 usam
 * exatamente os mesmos cortes.
 */

const RAIZ =
  "C:/Users/user/Desktop/projetos/_REF_PRODUCAO/ANALISADOR_T4_RTD/ANALISADOR_T4_RTD/t4-learning";
const VIDEO = process.env["VIDEO_MES"] ?? "marco";

const PERGUNTA =
  "Esta imagem é o EIXO DE TEMPO (horizontal) de um gráfico de candles intradiário. " +
  "Os rótulos são horários (ex.: 15:49) e, nas viradas de pregão, datas (ex.: 05/mar). " +
  'Responda APENAS JSON: {"dataVisivel": "texto exato da data" ou null, ' +
  '"primeiroHorario": "HH:MM" ou null, "ultimoHorario": "HH:MM" ou null}.';

function minutos(hhmm: unknown): number | null {
  if (typeof hhmm !== "string") return null;
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (m === null) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

const DATA_RE = /\b(\d{1,2})\s*[/\- ]\s*(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\b/i;

/** O veredito de UMA leitura — determinístico, o modelo só transcreve. */
function julgar(leitura: Record<string, unknown> | null): {
  voto: "VIRADA" | "MESMO_DIA" | "ILEGIVEL";
  data: string | null;
} {
  if (leitura === null) return { voto: "ILEGIVEL", data: null };
  const dataBruta = typeof leitura["dataVisivel"] === "string" ? leitura["dataVisivel"] : null;
  const data = dataBruta !== null && DATA_RE.test(dataBruta) ? dataBruta : null;
  const primeiro = minutos(leitura["primeiroHorario"]);
  const ultimo = minutos(leitura["ultimoHorario"]);
  // Reset com folga de 3h: 18:19 -> 09:03 e virada; 12:05 -> 11:58 e ruido.
  if (primeiro !== null && ultimo !== null && primeiro - ultimo >= 180) {
    return { voto: "VIRADA", data };
  }
  /*
   * DATA SOZINHA NAO E VIRADA — defeito medido: o rotulo de data fica
   * visivel no eixo a manha INTEIRA, entao frames do meio do dia viravam
   * falsas fronteiras (36 dias onde ha ~15). A data segue como METADADO
   * para nomear o pregao; quem decide virada e o RESET de horario.
   */
  if (primeiro !== null && ultimo !== null) return { voto: "MESMO_DIA", data };
  return { voto: "ILEGIVEL", data: null };
}

rodarCampanha(`FRONTEIRAS ${VIDEO}.mp4 — voto sobre o eixo de tempo`, () => {
  it(
    "confirma, rejeita ou isola cada fronteira candidata",
    async () => {
      const saida = `${RAIZ}/dataset/${VIDEO}/day-boundaries-frozen.json`;
      if (existsSync(saida)) {
        console.log("JA CONGELADO — nao se recalcula fronteira congelada.");
        expect(true).toBe(true);
        return;
      }
      const config = aiConfig();
      const dataset = JSON.parse(
        readFileSync(`${RAIZ}/dataset/${VIDEO}/varredura-mes.json`, "utf8"),
      ) as { pontos: PontoDeVarredura[] };
      const info = probeVideo(`C:/Users/user/Desktop/BACKTEST/${VIDEO}.mp4`);
      if ("erro" in info) throw new Error(info.erro);

      // CANDIDATOS: gap >= 600 (sensibilidade alta — a prova e quem decide).
      const precificados = dataset.pontos.filter(
        (p): p is PontoDeVarredura & { preco: number } => p.preco !== null,
      );
      const candidatos: number[] = [];
      for (let i = 1; i < precificados.length; i++) {
        const a = precificados[i - 1]!;
        const b = precificados[i]!;
        if (b.segundoNoVideo - a.segundoNoVideo > 2) continue;
        if (Math.abs(b.preco - a.preco) < 600) continue;
        if (candidatos.length > 0 && b.segundoNoVideo - candidatos[candidatos.length - 1]! < 20)
          continue;
        candidatos.push(b.segundoNoVideo);
      }
      console.log(`candidatos por gap>=600: ${candidatos.length}`);

      const fronteiras: Array<{
        seg: number;
        estado: "CONFIRMED" | "AMBIGUOUS" | "REJECTED";
        votos: string[];
        data: string | null;
        provas: unknown[];
      }> = [];

      for (const seg of candidatos) {
        const votos: string[] = [];
        const provas: unknown[] = [];
        let data: string | null = null;
        // Ate 3 leituras, em instantes levemente diferentes — voto de verdade.
        for (const deslocamento of [1.0, 0.5, 1.6]) {
          const alvo = seg + deslocamento;
          let cru: string | null = null;
          let zoom: string | null = null;
          for await (const f of lerFrames(info, {
            fps: 10,
            inicioSeg: alvo,
            fimSeg: alvo + 0.15,
          })) {
            cru = recorteParaPngDataUrl(f.frame, { left: 0, top: 640, width: 1340, height: 128 });
            zoom = recorteAmpliado(f.frame, { left: 600, top: 690, width: 740, height: 60 }, 2);
            break;
          }
          if (cru === null) continue;
          for (const imagem of [cru, zoom]) {
            if (imagem === null) continue;
            try {
              const base64 = imagem.split(",")[1]!;
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
              const leitura = extractJsonObject(json.message?.content ?? "") as Record<
                string,
                unknown
              > | null;
              const veredito = julgar(leitura);
              provas.push({ alvo, leitura, veredito });
              if (veredito.voto !== "ILEGIVEL") {
                votos.push(veredito.voto);
                if (veredito.data !== null && data === null) data = veredito.data;
                break; // esta tentativa votou; proxima leitura em outro instante
              }
            } catch {
              provas.push({ alvo, erro: "timeout/rede" });
            }
          }
          const viradas = votos.filter((v) => v === "VIRADA").length;
          const mesmos = votos.filter((v) => v === "MESMO_DIA").length;
          if (viradas >= 2 || mesmos >= 2) break; // maioria fechada
        }
        const viradas = votos.filter((v) => v === "VIRADA").length;
        const mesmos = votos.filter((v) => v === "MESMO_DIA").length;
        const estado = viradas >= 2 ? "CONFIRMED" : mesmos >= 2 ? "REJECTED" : "AMBIGUOUS";
        fronteiras.push({ seg, estado, votos, data, provas });
        console.log(`  ${seg.toFixed(1)}s → ${estado} (${votos.join(",")}) data=${data ?? "-"}`);
      }

      // DIAS a partir das fronteiras CONFIRMADAS; trecho com AMBIGUOUS e isolado.
      const confirmadas = fronteiras.filter((f) => f.estado === "CONFIRMED").map((f) => f.seg);
      const ambiguas = fronteiras.filter((f) => f.estado === "AMBIGUOUS").map((f) => f.seg);
      const inicios = [0, ...confirmadas];
      const dias = inicios.map((inicioSeg, i) => {
        const fimSeg = i + 1 < inicios.length ? inicios[i + 1]! : info.duracaoSeg;
        const temAmbigua = ambiguas.some((a) => a > inicioSeg && a < fimSeg);
        const fronteira = fronteiras.find((f) => f.seg === inicioSeg);
        return {
          videoId: `${VIDEO}.mp4`,
          dayId: i + 1,
          data: fronteira?.data ?? null,
          startTimestamp: inicioSeg,
          endTimestamp: fimSeg,
          frameInicial: Math.round(inicioSeg * 10),
          frameFinal: Math.round(fimSeg * 10),
          estado: temAmbigua ? ("AMBIGUOUS" as const) : ("CONFIRMED" as const),
          confidence: fronteira
            ? fronteira.votos.filter((v) => v === "VIRADA").length /
              Math.max(1, fronteira.votos.length)
            : 1,
        };
      });

      writeFileSync(
        saida,
        JSON.stringify(
          {
            video: `${VIDEO}.mp4`,
            criadoEm: new Date().toISOString(),
            metodo:
              "gap>=600 como candidato; veredito deterministico por reset de horario (folga 3h) ou rotulo de data; 3 votos, maioria 2",
            candidatos: candidatos.length,
            fronteiras,
            dias,
          },
          null,
          1,
        ),
        "utf8",
      );
      console.log(
        `DIAS: ${dias.length} · confirmados=${dias.filter((d) => d.estado === "CONFIRMED").length} ambiguos=${dias.filter((d) => d.estado === "AMBIGUOUS").length}`,
      );
      expect(dias.length).toBeGreaterThan(0);
    },
    3 * 3600 * 1000,
  );
});
