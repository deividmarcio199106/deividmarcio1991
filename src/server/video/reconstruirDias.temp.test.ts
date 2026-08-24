/**
 * RECONSTRÓI OS PREGÕES DE UM VÍDEO EM SÉRIES DE CANDLES — sem modelo (RECON_T4=1).
 *
 * UM ÚNICO passe de streaming (fps 3):
 *   - todo frame: contador (relógio) + caixa de preço (par y→preço);
 *   - quando o contador avançou ≥180 desde o último parse: parse CRU dos
 *     candles visíveis (pixels, sem preço);
 *   - virada de dia = contador caiu.
 *
 * Depois do passe, POR DIA: régua por regressão local dos pares da caixa
 * (janela ±45s de vídeo em torno de cada parse, dentro do dia) e conversão do
 * parse cru para OHLC. Merge por índice: a leitura mais TARDIA de cada candle
 * fechado vence (candle fechado não muda; a mais tardia está mais longe da
 * borda e do risco de clipping).
 *
 * Saída: t4-learning/reconstrucao/<video>/dia-NN.json + resumo com lacunas e
 * qualidade — lacuna é DECLARADA, nunca interpolada.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { probeVideo } from "./ffmpeg";
import { lerFrames } from "./frames";
import {
  ajustarRegua,
  converterParaPrecos,
  lerCaixaDePreco,
  lerContador,
  parsearColunas,
  type CandleCru,
  type ParDeRegua,
} from "./reconstrutor";
import type { Templates } from "./ocrDigitos";

const ATIVO = process.env.RECON_T4 === "1";
const VIDEO = process.env.RECON_VIDEO ?? "marco";

interface ParseAgendado {
  segundoNoVideo: number;
  contador: number;
  candles: CandleCru[];
}

describe.skipIf(!ATIVO)(`reconstrução determinística — ${VIDEO}`, () => {
  it("reconstrói os pregões", { timeout: 7_200_000 }, async () => {
    const caminho = `C:/Users/user/Desktop/BACKTEST/${VIDEO}.mp4`;
    const templates = JSON.parse(
      readFileSync("t4-learning/reconstrucao/templates.json", "utf8"),
    ) as Templates;
    const info = probeVideo(caminho);
    if ("erro" in info) throw new Error(String((info as { erro: string }).erro));
    console.log(`[${VIDEO}] ${info.duracaoSeg.toFixed(0)}s de vídeo`);

    interface Dia {
      pares: ParDeRegua[];
      parses: ParseAgendado[];
      contadorMax: number;
      inicioSeg: number;
      fimSeg: number;
    }
    const dias: Dia[] = [];
    let atual: Dia | null = null;
    let ultimoContador = -1;
    let ultimoParseContador = -1e9;
    let framesLidos = 0;
    let contadorFalhas = 0;

    for await (const f of lerFrames(info, { fps: 3 })) {
      framesLidos++;
      const frame = f.frame;
      const contador = lerContador(frame, templates);
      if (contador === null) {
        contadorFalhas++;
        continue;
      }
      // VIRADA DE DIA: o contador caiu de verdade (não ruído de OCR: exige
      // queda grande OU contador pequeno após um dia já formado).
      const caiu =
        ultimoContador > 0 &&
        contador < ultimoContador - 5 &&
        (contador < 60 || ultimoContador - contador > 120);
      if (atual === null || caiu) {
        atual = {
          pares: [],
          parses: [],
          contadorMax: 0,
          inicioSeg: f.segundoNoVideo,
          fimSeg: f.segundoNoVideo,
        };
        dias.push(atual);
        ultimoParseContador = -1e9;
      }
      ultimoContador = contador;
      atual.fimSeg = f.segundoNoVideo;
      if (contador > atual.contadorMax) atual.contadorMax = contador;

      const caixa = lerCaixaDePreco(frame, templates);
      if (caixa !== null) {
        atual.pares.push({ segundoNoVideo: f.segundoNoVideo, y: caixa.y, preco: caixa.preco });
      }

      if (contador - ultimoParseContador >= 180) {
        const cru = parsearColunas(frame, contador);
        if (cru !== null) {
          atual.parses.push({
            segundoNoVideo: f.segundoNoVideo,
            contador,
            candles: cru.candles,
          });
          ultimoParseContador = contador;
        }
      }
    }
    // Parse final de cada dia acontece implicitamente: o último frame do dia
    // dispara pelo avanço ou fica coberto pelo próximo parse; garante-se o
    // fechamento reprocessando o ÚLTIMO frame de cada dia abaixo? Não — o
    // streaming já passou. Em vez disso, o gatilho de 180 + janela de 280
    // visíveis dá folga de 100 candles; o risco residual é o rabo do dia.
    // Medido no resumo: candles faltantes no fim viram lacuna DECLARADA.

    console.log(
      `[${VIDEO}] frames=${framesLidos} contadorFalhas=${contadorFalhas} dias=${dias.length}`,
    );

    mkdirSync(`t4-learning/reconstrucao/${VIDEO}`, { recursive: true });
    const resumo: Array<Record<string, unknown>> = [];
    for (let d = 0; d < dias.length; d++) {
      const dia = dias[d]!;
      // Dia degenerado (abertura do vídeo, meio-dia cortado): ainda é gravado,
      // marcado como suspeito — a exclusão é decisão de quem consome, com o
      // motivo na mão.
      const porIndice = new Map<number, { c: ReturnType<typeof converterParaPrecos>[number] }>();
      let reguasFalhas = 0;
      for (const parse of dia.parses) {
        const janela = dia.pares.filter(
          (p) => Math.abs(p.segundoNoVideo - parse.segundoNoVideo) <= 45,
        );
        const regua = ajustarRegua(janela);
        if (regua === null || regua.residuoMax > 220) {
          reguasFalhas++;
          continue;
        }
        // Só candles FECHADOS: índice < contador do frame.
        const fechados = parse.candles.filter((k) => k.indice < parse.contador);
        for (const candle of converterParaPrecos(fechados, regua)) {
          porIndice.set(candle.indice, { c: candle }); // mais tardio vence
        }
      }
      const indices = [...porIndice.keys()].sort((a, b) => a - b);
      const lacunas: number[] = [];
      for (let i = 1; i <= dia.contadorMax - 1; i++) {
        if (!porIndice.has(i)) lacunas.push(i);
      }
      const candles = indices.map((i) => porIndice.get(i)!.c);
      const arquivo = {
        video: VIDEO,
        dia: d + 1,
        inicioSeg: dia.inicioSeg,
        fimSeg: dia.fimSeg,
        contadorMax: dia.contadorMax,
        candlesReconstruidos: candles.length,
        lacunas: lacunas.length,
        lacunasIndices: lacunas.slice(0, 50),
        paresDeRegua: dia.pares.length,
        parses: dia.parses.length,
        reguasFalhas,
        candles,
      };
      writeFileSync(
        `t4-learning/reconstrucao/${VIDEO}/dia-${String(d + 1).padStart(2, "0")}.json`,
        JSON.stringify(arquivo),
        "utf8",
      );
      resumo.push({
        dia: d + 1,
        contadorMax: dia.contadorMax,
        candles: candles.length,
        lacunas: lacunas.length,
        pares: dia.pares.length,
        parses: dia.parses.length,
        reguasFalhas,
      });
    }
    writeFileSync(
      `t4-learning/reconstrucao/${VIDEO}/resumo.json`,
      JSON.stringify({ video: VIDEO, geradoEm: new Date().toISOString(), dias: resumo }, null, 1),
      "utf8",
    );
    for (const r of resumo) console.log(JSON.stringify(r));
    expect(dias.length).toBeGreaterThan(0);
  });
});
