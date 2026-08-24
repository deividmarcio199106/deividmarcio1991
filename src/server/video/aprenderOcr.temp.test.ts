/**
 * APRENDE E VALIDA OS TEMPLATES DE DÍGITO (APRENDER_OCR=1) — um único passe.
 *
 * A PRIMEIRA VERSÃO FALHOU POR SEEK: `-ss` busca por keyframe e entrega um
 * frame SEGUNDOS antes do pedido; o rótulo "verdade" era de um instante e a
 * imagem de outro — templates envenenados com dígitos de outro preço.
 *
 * AGORA: streaming fps 10 do zero, EXATAMENTE como a varredura original foi
 * feita, casando cada frame com o ponto da varredura pelo timestamp
 * (|Δt| < 0,06 s). Frames pares treinam, ímpares testam — conjuntos disjuntos
 * do MESMO passe, sem seek nenhum.
 *
 * No mesmo passe, o CONTADOR é lido e validado: monotônico dentro do dia,
 * ~22 quedas no março (as viradas de pregão conhecidas).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { probeVideo } from "./ffmpeg";
import { lerFrames } from "./frames";
import { detectarLinhasDoEixo, detectarCaixaDePreco } from "./calibration";
import {
  GLIFO_H,
  GLIFO_W,
  binarizar,
  lerNumero,
  normalizar,
  refinarCaixas,
  segmentar,
  type Templates,
} from "./ocrDigitos";
import { lerContador } from "./reconstrutor";

const ATIVO = process.env.APRENDER_OCR === "1";

describe.skipIf(!ATIVO)("aprender e validar OCR num único passe", () => {
  it("templates + contador contra a verdade de março", { timeout: 7_200_000 }, async () => {
    const video = "C:/Users/user/Desktop/BACKTEST/marco.mp4";
    const varredura = JSON.parse(
      readFileSync("t4-learning/dataset/marco/varredura-mes.json", "utf8"),
    ) as { pontos: Array<{ segundoNoVideo: number; preco: number | null }> };
    const verdadePorDecimo = new Map<number, number>();
    for (const p of varredura.pontos) {
      if (p.preco !== null) verdadePorDecimo.set(Math.round(p.segundoNoVideo * 10), p.preco);
    }

    const info = probeVideo(video);
    if ("erro" in info) throw new Error(String((info as { erro: string }).erro));

    const somas = new Map<string, { soma: Float32Array; n: number }>();
    interface Pendente {
      s: number;
      preco: number;
      grade: Uint8Array;
      w: number;
      h: number;
      caixas: Array<[number, number]>;
    }
    const paraTeste: Pendente[] = [];
    let treinadas = 0;
    let contagemErrada = 0;
    let semGeometria = 0;
    let semVerdade = 0;

    // Validação do contador no MESMO passe.
    let contadorLidos = 0;
    let contadorNulos = 0;
    let quedas = 0;
    let regressoesPequenas = 0;
    let anterior = -1;

    for await (const f of lerFrames(info, { fps: 10 })) {
      const frame = f.frame;
      const decimo = Math.round(f.segundoNoVideo * 10);

      if (decimo % 20 === 0) {
        const contador = lerContador(frame, {
          chars: Object.fromEntries(
            [...somas.entries()].map(([ch, { soma, n }]) => {
              const ref: number[] = [];
              for (let i = 0; i < soma.length; i++) ref.push(soma[i]! / n >= 0.5 ? 1 : 0);
              return [ch, [ref]];
            }),
          ),
        });
        if (contador === null) contadorNulos++;
        else {
          contadorLidos++;
          if (anterior > 0 && contador < anterior) {
            if (anterior - contador > 120) quedas++;
            else regressoesPequenas++;
          }
          anterior = contador;
        }
      }

      const preco = verdadePorDecimo.get(decimo);
      if (preco === undefined) {
        semVerdade++;
        continue;
      }
      const geo = detectarLinhasDoEixo(frame);
      const yCaixa = detectarCaixaDePreco(frame);
      if (geo.colunas === null || yCaixa === null) {
        semGeometria++;
        continue;
      }
      const [x0, x1] = geo.colunas;
      const regiao = { left: x0 - 2, top: Math.round(yCaixa) - 9, width: x1 - x0 + 6, height: 19 };
      const { grade, w, h } = binarizar(frame, regiao);
      const caixas = refinarCaixas(grade, w, h, segmentar(grade, w, h));
      const esperadoStr = String(preco);
      const comPonto = `${esperadoStr.slice(0, -3)}.${esperadoStr.slice(-3)}`;

      if (decimo % 2 === 0) {
        // TREINO — só quando a contagem de glifos bate com a resposta.
        if (caixas.length !== comPonto.length) {
          contagemErrada++;
          continue;
        }
        for (let k = 0; k < caixas.length; k++) {
          const ch = comPonto[k]!;
          const glifo = normalizar(grade, w, h, caixas[k]![0], caixas[k]![1]);
          const atual = somas.get(ch) ?? { soma: new Float32Array(GLIFO_W * GLIFO_H), n: 0 };
          for (let i = 0; i < glifo.bits.length; i++) atual.soma[i]! += glifo.bits[i]!;
          atual.n += 1;
          somas.set(ch, atual);
        }
        treinadas++;
      } else if (paraTeste.length < 4_000) {
        paraTeste.push({ s: f.segundoNoVideo, preco, grade, w, h, caixas });
      }
    }

    const templates: Templates = { chars: {} };
    for (const [ch, { soma, n }] of somas) {
      const ref: number[] = [];
      for (let i = 0; i < soma.length; i++) ref.push(soma[i]! / n >= 0.5 ? 1 : 0);
      templates.chars[ch] = [ref];
    }
    console.log(
      `treino: usadas=${treinadas} contagemErrada=${contagemErrada} semGeom=${semGeometria} chars=${[...somas.keys()].sort().join("")}`,
    );

    // TESTE nos frames ímpares — o matching roda sobre as grades já extraídas.
    const { lerTextoDeGrade } = await import("./ocrDigitos");
    let ok = 0;
    let errado = 0;
    let semLeitura = 0;
    const erros: string[] = [];
    for (const t of paraTeste) {
      const leitura = lerTextoDeGrade(t.grade, t.w, t.h, t.caixas, templates);
      if (leitura === null) {
        semLeitura++;
        continue;
      }
      const lido = Number(leitura.texto.replace(/\./g, ""));
      if (!Number.isFinite(lido)) {
        semLeitura++;
        continue;
      }
      if (lido === t.preco) ok++;
      else {
        errado++;
        if (erros.length < 8) erros.push(`${t.s}s lido=${lido} verdade=${t.preco}`);
      }
    }
    console.log(`TESTE: ok=${ok} errado=${errado} semLeitura=${semLeitura}`);
    for (const e of erros) console.log("  ERRO:", e);
    const acuracia = ok / Math.max(1, ok + errado);
    const emissao = (ok + errado) / Math.max(1, ok + errado + semLeitura);
    console.log(`acurácia=${(acuracia * 100).toFixed(3)}% emissão=${(emissao * 100).toFixed(1)}%`);
    console.log(
      `CONTADOR: lidos=${contadorLidos} nulos=${contadorNulos} quedas(dia)=${quedas} regressõesPequenas=${regressoesPequenas}`,
    );

    mkdirSync("t4-learning/reconstrucao", { recursive: true });
    writeFileSync(
      "t4-learning/reconstrucao/templates.json",
      JSON.stringify(templates, null, 1),
      "utf8",
    );
    writeFileSync(
      "t4-learning/reconstrucao/ocr-validacao.json",
      JSON.stringify(
        {
          video: "marco",
          treino: { usadas: treinadas, contagemErrada },
          teste: { ok, errado, semLeitura, acuracia, emissao },
          contador: { lidos: contadorLidos, nulos: contadorNulos, quedas, regressoesPequenas },
          errosExemplo: erros,
        },
        null,
        1,
      ),
      "utf8",
    );

    expect(ok + errado).toBeGreaterThan(1_000);
    expect(acuracia).toBeGreaterThanOrEqual(0.998);
    expect(quedas).toBeGreaterThanOrEqual(18);
    expect(quedas).toBeLessThanOrEqual(26);
  });
});
