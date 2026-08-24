/**
 * FRAMES DO VÍDEO, EM ORDEM, SEM FUTURO.
 *
 * Este módulo entrega ao pipeline o MESMO objeto que a captura de tela entrega
 * — `PixelFrame` (RGBA, largura, altura). É essa igualdade que garante que
 * vídeo e ao vivo não virem duas T4 diferentes: daqui para frente, nenhum
 * módulo consegue saber de onde o pixel veio.
 *
 * A DISCIPLINA CAUSAL É ESTRUTURAL, NÃO UMA PROMESSA.
 *
 * O ffmpeg é lido como FLUXO: os bytes chegam em ordem cronológica e são
 * consumidos um frame por vez, via gerador assíncrono. Não existe array com o
 * vídeo inteiro, não existe índice para "espiar adiante" e não existe forma de
 * um consumidor alcançar o frame T+1 antes de terminar o T. A proibição de
 * hindsight deixa de depender de disciplina do chamador e passa a depender da
 * forma do dado — que é como ela deveria ter nascido.
 *
 * POR QUE `rawvideo rgba` E NÃO PNG. PNG exigiria decodificar de novo do lado
 * de cá (outra dependência, outro ponto de falha) e custaria compressão inútil:
 * o consumidor quer justamente os bytes crus. O preço é volume — a vazão é
 * controlada pelo `fps` pedido, não pelo fps do arquivo.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import type { PixelFrame } from "@/lib/capture/frameProcessor";
import { resolveFfmpeg, type VideoInfo } from "./ffmpeg";

export interface FrameDoVideo {
  /** Índice sequencial na amostragem pedida — 0, 1, 2... */
  indice: number;
  /** Instante DENTRO do vídeo, em segundos. É a base do tempo de mercado. */
  segundoNoVideo: number;
  frame: PixelFrame;
}

export interface OpcoesDeLeitura {
  /** Quantos frames por segundo de vídeo serão analisados. */
  fps: number;
  /** Início do recorte, em segundos de vídeo. */
  inicioSeg?: number;
  /** Fim do recorte, em segundos de vídeo (exclusivo). */
  fimSeg?: number;
  /**
   * Largura máxima de trabalho. O vídeo é reduzido proporcionalmente quando
   * excede — a leitura estrutural não melhora com pixels a mais, e a memória
   * por frame cresce com o quadrado da escala.
   */
  larguraMaxima?: number;
}

/** Erro que o chamador precisa DECLARAR — nunca engolir como pregão vazio. */
export class ErroDeVideo extends Error {}

/**
 * Lê o vídeo como sequência causal de frames.
 *
 * O gerador só produz o frame seguinte depois que o consumidor terminou o
 * anterior — o `await` do consumidor é o que libera o T+1.
 */
export async function* lerFrames(
  info: VideoInfo,
  opcoes: OpcoesDeLeitura,
): AsyncGenerator<FrameDoVideo> {
  const tools = resolveFfmpeg();
  if (tools === null) throw new ErroDeVideo("ffmpeg não encontrado.");

  const fps = opcoes.fps > 0 ? opcoes.fps : 1;
  const inicio = Math.max(0, opcoes.inicioSeg ?? 0);
  const fim =
    opcoes.fimSeg === undefined ? info.duracaoSeg : Math.min(opcoes.fimSeg, info.duracaoSeg);
  if (fim <= inicio) throw new ErroDeVideo("recorte vazio: fim <= início.");

  // Escala: largura par (exigência de vários filtros) e altura proporcional.
  const limite = opcoes.larguraMaxima ?? info.largura;
  const escalar = info.largura > limite;
  const largura = escalar ? Math.floor(limite / 2) * 2 : info.largura;
  const altura = escalar
    ? Math.floor((info.altura * (largura / info.largura)) / 2) * 2
    : info.altura;

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    // -ss ANTES de -i: busca por keyframe, ordens de grandeza mais rápida em
    // arquivos longos. A precisão perdida é de frames, não de minutos.
    "-ss",
    inicio.toFixed(3),
    "-i",
    info.caminho,
    "-t",
    (fim - inicio).toFixed(3),
    "-vf",
    escalar ? `fps=${fps},scale=${largura}:${altura}` : `fps=${fps}`,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "-",
  ];

  const proc = spawn(tools.ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
  const bytesPorFrame = largura * altura * 4;

  let erroDoProcesso = "";
  proc.stderr.on("data", (d: Buffer) => {
    erroDoProcesso += d.toString("utf8").slice(0, 2000);
  });

  let restante: Buffer = Buffer.alloc(0);
  let indice = 0;

  try {
    for await (const pedaco of proc.stdout) {
      restante =
        restante.length === 0 ? (pedaco as Buffer) : Buffer.concat([restante, pedaco as Buffer]);

      while (restante.length >= bytesPorFrame) {
        const bruto = restante.subarray(0, bytesPorFrame);
        restante = restante.subarray(bytesPorFrame);

        // Cópia deliberada: `subarray` compartilha memória com o buffer que
        // será reaproveitado, e um frame que muda depois de entregue é o tipo
        // de defeito que só aparece em produção.
        const dados = new Uint8ClampedArray(bruto.length);
        dados.set(bruto);

        yield {
          indice,
          segundoNoVideo: inicio + indice / fps,
          frame: { data: dados, width: largura, height: altura },
        };
        indice++;
      }
    }
  } finally {
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }

  if (indice === 0) {
    throw new ErroDeVideo(
      `nenhum frame decodificado${erroDoProcesso ? ` — ffmpeg: ${erroDoProcesso.slice(0, 300)}` : ""}`,
    );
  }
}

/**
 * Recorta uma faixa do frame e devolve PNG em data URL.
 *
 * É assim que o eixo de preços e o relógio do gráfico chegam ao leitor visual:
 * o MESMO caminho do ao vivo (que recorta do canvas), com o recorte feito aqui
 * porque no servidor não existe canvas. O ffmpeg codifica o PNG — nenhuma
 * biblioteca de imagem entra no projeto por causa disto.
 */
export function recorteParaPngDataUrl(
  frame: PixelFrame,
  regiao: { left: number; top: number; width: number; height: number },
): string | null {
  const tools = resolveFfmpeg();
  if (tools === null) return null;

  const left = Math.max(0, Math.min(frame.width - 1, Math.round(regiao.left)));
  const top = Math.max(0, Math.min(frame.height - 1, Math.round(regiao.top)));
  const width = Math.max(1, Math.min(frame.width - left, Math.round(regiao.width)));
  const height = Math.max(1, Math.min(frame.height - top, Math.round(regiao.height)));

  // Extrai o retângulo em memória para não empurrar o frame inteiro ao ffmpeg.
  const recorte = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const origem = ((top + y) * frame.width + left) * 4;
    const destino = y * width * 4;
    for (let i = 0; i < width * 4; i++) recorte[destino + i] = frame.data[origem + i]!;
  }

  const r = spawnSyncPng(tools.ffmpeg, width, height, recorte);
  return r === null ? null : `data:image/png;base64,${r.toString("base64")}`;
}

function spawnSyncPng(ffmpeg: string, width: number, height: number, rgba: Buffer): Buffer | null {
  const r = spawnSync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-s",
      `${width}x${height}`,
      "-i",
      "-",
      "-f",
      "image2",
      "-vcodec",
      "png",
      "-",
    ],
    { input: rgba, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
  );
  if (r.status !== 0 || !r.stdout || r.stdout.length === 0) return null;
  return r.stdout;
}

/**
 * LARGURA DA RÉGUA PERCENTUAL, em pixels — a mesma do caminho ao vivo.
 *
 * O prompt de OCR da escala manda o modelo informar "o centro vertical de cada
 * rótulo usando a régua (0 no topo, 100 na base)". Sem a régua desenhada no
 * recorte, o modelo devolve preço sem posição — e preço sem posição não vira
 * reta. No navegador ela é pintada no canvas; aqui, pelo ffmpeg. Só o MEIO de
 * desenhar muda: o contrato com o modelo é idêntico.
 */
const LARGURA_DA_REGUA = 64;

/**
 * Fonte monoespaçada para os números da régua.
 *
 * O CAMINHO PRECISA DE ESCAPE DUPLO. No parser de filtros do ffmpeg os dois
 * pontos separam opções, então `C:/...` quebra a expressão inteira — e um
 * escape simples é consumido antes de chegar ao parser da opção. `C\\:` sai
 * como `C\:` para o ffmpeg, que é a forma que sobrevive às duas camadas.
 *
 * A lista existe porque a VPS é Linux e esta máquina é Windows: sem uma fonte
 * presente o ffmpeg recusa o `drawtext` inteiro, e a régua sairia sem números.
 */
const FONTES_CANDIDATAS = [
  "C\\\\:/Windows/Fonts/consola.ttf",
  "C\\\\:/Windows/Fonts/cour.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
];

/** Caminho real da fonte no sistema, para conferir existência antes de usar. */
function caminhoReal(candidato: string): string {
  return candidato.replace(/\\\\:/g, ":");
}

let fonteResolvida: string | null | undefined;

/** A primeira fonte que existir. `null` = desenhar só os traços, sem números. */
function fonteDaRegua(): string | null {
  if (fonteResolvida !== undefined) return fonteResolvida;
  fonteResolvida = FONTES_CANDIDATAS.find((c) => existsSync(caminhoReal(c))) ?? null;
  return fonteResolvida;
}

/**
 * Recorte do eixo de preços COM a régua percentual coladas à esquerda.
 *
 * `faixaInicial` é a fração da largura onde a escala começa. A margem direita
 * existe porque o Profit encosta a barra de ferramentas na borda: ícones
 * coloridos ali dentro só dão ao modelo mais coisa para confundir com rótulo.
 */
export function recorteDoEixoComRegua(
  frame: PixelFrame,
  faixaInicial: number,
  margemDireita = 0.025,
): string | null {
  const tools = resolveFfmpeg();
  if (tools === null) return null;

  const left = Math.max(0, Math.min(frame.width - 2, Math.round(frame.width * faixaInicial)));
  const right = Math.max(left + 1, frame.width - Math.round(frame.width * margemDireita));
  const width = right - left;
  const height = frame.height;

  const recorte = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const origem = (y * frame.width + left) * 4;
    const destino = y * width * 4;
    for (let i = 0; i < width * 4; i++) recorte[destino + i] = frame.data[origem + i]!;
  }

  // Traço a cada 10%, com o número ao lado. O ciano destaca a régua de
  // qualquer coisa que o gráfico desenhe por baixo.
  const fonte = fonteDaRegua();
  const marcas: string[] = [];
  for (let p = 0; p <= 100; p += 10) {
    const y = Math.round((height * p) / 100);
    const yTraço = Math.min(height - 1, y);
    marcas.push(`drawbox=x=${LARGURA_DA_REGUA - 14}:y=${yTraço}:w=14:h=1:color=cyan@0.9:t=fill`);
    if (fonte !== null) {
      marcas.push(
        `drawtext=fontfile=${fonte}:text=${p}:x=4:y=${Math.max(0, y - 6)}:fontsize=12:fontcolor=cyan`,
      );
    }
  }

  const filtro = [`pad=iw+${LARGURA_DA_REGUA}:ih:${LARGURA_DA_REGUA}:0:black`, ...marcas].join(",");

  const r = spawnSync(
    tools.ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-s",
      `${width}x${height}`,
      "-i",
      "-",
      "-vf",
      filtro,
      "-f",
      "image2",
      "-vcodec",
      "png",
      "-",
    ],
    { input: recorte, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
  );
  if (r.status !== 0 || !r.stdout || r.stdout.length === 0) return null;
  return `data:image/png;base64,${r.stdout.toString("base64")}`;
}

/**
 * Grava o frame como PNG em disco — o FRAME DE PROVA de uma operação.
 *
 * Quando a T4 confirma uma entrada no vídeo, a imagem que ela viu naquele
 * instante é congelada aqui. Sem isso, a confirmação seria um número num
 * relatório; com isso, é um frame que qualquer pessoa pode abrir e conferir.
 */
export function salvarFramePng(frame: PixelFrame, caminho: string): boolean {
  const tools = resolveFfmpeg();
  if (tools === null) return false;
  const r = spawnSync(
    tools.ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-s",
      `${frame.width}x${frame.height}`,
      "-i",
      "-",
      "-frames:v",
      "1",
      "-y",
      caminho,
    ],
    {
      input: Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
      timeout: 60_000,
    },
  );
  return r.status === 0;
}

/**
 * Recorta uma região e AMPLIA — para ler um rótulo isolado do eixo.
 *
 * POR QUE AMPLIAR. Um rótulo de preço do Profit tem ~9 px de altura numa
 * captura de 1366×768. Entregue nesse tamanho, o leitor visual erra dígito.
 * Ampliado por interpolação de vizinho mais próximo (que preserva a forma da
 * fonte em vez de borrá-la), o mesmo rótulo é lido sem esforço — e é UM número,
 * não uma régua inteira, então a leitura é curta e barata.
 */
export function recorteAmpliado(
  frame: PixelFrame,
  regiao: { left: number; top: number; width: number; height: number },
  fator = 4,
): string | null {
  const tools = resolveFfmpeg();
  if (tools === null) return null;

  const left = Math.max(0, Math.min(frame.width - 1, Math.round(regiao.left)));
  const top = Math.max(0, Math.min(frame.height - 1, Math.round(regiao.top)));
  const width = Math.max(1, Math.min(frame.width - left, Math.round(regiao.width)));
  const height = Math.max(1, Math.min(frame.height - top, Math.round(regiao.height)));

  const recorte = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const origem = ((top + y) * frame.width + left) * 4;
    const destino = y * width * 4;
    for (let i = 0; i < width * 4; i++) recorte[destino + i] = frame.data[origem + i]!;
  }

  const r = spawnSync(
    tools.ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-s",
      `${width}x${height}`,
      "-i",
      "-",
      "-vf",
      `scale=${width * fator}:${height * fator}:flags=neighbor`,
      "-f",
      "image2",
      "-vcodec",
      "png",
      "-",
    ],
    { input: recorte, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
  );
  if (r.status !== 0 || !r.stdout || r.stdout.length === 0) return null;
  return `data:image/png;base64,${r.stdout.toString("base64")}`;
}
