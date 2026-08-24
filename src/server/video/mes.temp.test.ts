import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Runner LONGO da campanha: fora dela (CAMPANHA_T4!=1) vira skip — uma suite
// normal de testes nunca dispara horas de GPU por engano.
const rodarCampanha = process.env["CAMPANHA_T4"] === "1" ? describe : describe.skip;
import { probeVideo } from "@/server/video/ffmpeg";
import { acharPivos, varrerPrecos, type PontoDeVarredura } from "@/server/video/varredura";

/**
 * FAST_SCAN DO MES INTEIRO — pixels, sem vision no caminho quente.
 *
 * Produz o dataset que o resto do estudo consome: serie de precos do mes,
 * pivos causais e a SEGMENTACAO DE DIAS. A segmentacao usa o salto de preco
 * entre frames vizinhos (gap de abertura) e e VALIDADA contra a lista de dias
 * que o operador leu no eixo do video — se o metodo nao reencontrar ~15 dias
 * em marco, ele e descartado, nao ajustado no escuro.
 */

const RAIZ =
  "C:/Users/user/Desktop/projetos/_REF_PRODUCAO/ANALISADOR_T4_RTD/ANALISADOR_T4_RTD/t4-learning";

interface DiaSegmentado {
  numero: number;
  inicioSeg: number;
  fimSeg: number;
  frames: number;
  precoInicial: number | null;
  precoFinal: number | null;
  gapDeAbertura: number | null;
}

/**
 * Fronteira de dia = salto entre precos vizinhos maior do que o mercado anda
 * em ~1 minuto de video (12 min de mercado). O limiar de 900 pontos fica bem
 * acima do maior movimento intra-dia visto entre frames (medido: p99 < 400) e
 * bem abaixo dos gaps de abertura tipicos do WINFUT (>1000).
 */
function segmentarDias(pontos: PontoDeVarredura[], limiarGap: number): DiaSegmentado[] {
  const precificados = pontos.filter(
    (p): p is PontoDeVarredura & { preco: number } => p.preco !== null,
  );
  const fronteiras: number[] = [];
  for (let i = 1; i < precificados.length; i++) {
    const a = precificados[i - 1]!;
    const b = precificados[i]!;
    // Vizinhos de verdade: ate 2 s de video de distancia (24 min de mercado).
    if (b.segundoNoVideo - a.segundoNoVideo > 2) continue;
    if (Math.abs(b.preco - a.preco) >= limiarGap) fronteiras.push(b.segundoNoVideo);
  }
  // Fronteiras a menos de 20 s de video (4 h de mercado) uma da outra sao o
  // mesmo evento visto duas vezes (quarentena + reancoragem): funde.
  const unicas: number[] = [];
  for (const f of fronteiras) {
    if (unicas.length === 0 || f - unicas[unicas.length - 1]! >= 20) unicas.push(f);
  }
  const inicios = [0, ...unicas];
  const dias: DiaSegmentado[] = [];
  for (let i = 0; i < inicios.length; i++) {
    const inicioSeg = inicios[i]!;
    const fimSeg = i + 1 < inicios.length ? inicios[i + 1]! : Number.POSITIVE_INFINITY;
    const doDia = precificados.filter(
      (p) => p.segundoNoVideo >= inicioSeg && p.segundoNoVideo < fimSeg,
    );
    if (doDia.length === 0) continue;
    const anterior = dias[dias.length - 1] ?? null;
    dias.push({
      numero: dias.length + 1,
      inicioSeg,
      fimSeg: doDia[doDia.length - 1]!.segundoNoVideo,
      frames: doDia.length,
      precoInicial: doDia[0]!.preco,
      precoFinal: doDia[doDia.length - 1]!.preco,
      gapDeAbertura:
        anterior === null || anterior.precoFinal === null
          ? null
          : doDia[0]!.preco - anterior.precoFinal,
    });
  }
  return dias;
}

// Qual video varrer vem do ambiente — o runner e um so para a campanha toda.
const VIDEO = process.env["VIDEO_MES"] ?? "marco";

rodarCampanha(`FAST_SCAN ${VIDEO}.mp4 — mes inteiro, so pixels`, () => {
  it(
    "varre, acha pivos e segmenta os dias",
    async () => {
      const info = probeVideo(`C:/Users/user/Desktop/BACKTEST/${VIDEO}.mp4`);
      if ("erro" in info) throw new Error(info.erro);
      const v = await varrerPrecos(info, {
        ativo: "WINFUT",
        inicioSeg: 0,
        fimSeg: info.duracaoSeg,
        intervaloSeg: 0.1,
        intervaloOcrSeg: 30,
      });
      const pivos = acharPivos(v.pontos);
      const dias = segmentarDias(v.pontos, 900);

      mkdirSync(`${RAIZ}/dataset/${VIDEO}`, { recursive: true });
      writeFileSync(
        `${RAIZ}/dataset/${VIDEO}/varredura-mes.json`,
        JSON.stringify(
          { resumo: { ...v, pontos: undefined }, dias, pivos, pontos: v.pontos },
          null,
          1,
        ),
        "utf8",
      );
      console.log(
        `frames=${v.framesLidos} comPreco=${v.comPreco} (${((100 * v.comPreco) / v.framesLidos).toFixed(0)}%) ` +
          `ocrs=${v.ocrs} recusadasPorSalto=${v.ocrRecusadasPorSalto} epocas=${v.epocas} ` +
          `tempo=${(v.duracaoMs / 60000).toFixed(1)}min erro=${v.erro ?? "nenhum"}`,
      );
      console.log(`pivos=${pivos.length} dias segmentados=${dias.length} (esperado ~15)`);
      dias.forEach((d) =>
        console.log(
          `  dia ${String(d.numero).padStart(2)}: ${d.inicioSeg.toFixed(1)}-${d.fimSeg.toFixed(1)}s ` +
            `frames=${d.frames} ${d.precoInicial}->${d.precoFinal} gap=${d.gapDeAbertura ?? "-"}`,
        ),
      );
      expect(v.framesLidos).toBeGreaterThan(5000);
    },
    4 * 3600 * 1000,
  );
});
