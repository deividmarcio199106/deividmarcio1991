/**
 * O VÍDEO COMO FONTE DE MERCADO — a dependência externa, isolada aqui.
 *
 * POR QUE ISTO EXISTE. Até aqui só havia UMA porta de entrada visual: o
 * `MediaStream` do `getDisplayMedia`. Isso obrigava um humano a compartilhar a
 * tela em tempo real para qualquer leitura — e tornava impossível usar as
 * gravações históricas do pregão como mercado. Os meses gravados existiam, mas
 * o sistema não tinha como olhar para eles.
 *
 * A REGRA QUE ESTE MÓDULO NÃO PODE QUEBRAR: vídeo não ganha um pipeline
 * próprio. Ele entrega exatamente o que o `MediaStream` entrega — um retângulo
 * de pixels RGBA — e daí para frente o caminho é o MESMO do ao vivo
 * (`inspectPixelFrame`, `extractCandlesFromPixels`, `ChartTracker`, `analyze`).
 * Um segundo algoritmo "simplificado para vídeo" produziria uma segunda T4, e
 * é justamente isso que a auditoria de paridade proíbe.
 *
 * ONDE O FFMPEG ENTRA. Decodificar MP4/MKV/AVI/MOV é trabalho especializado e
 * resolvido; reimplementar seria um defeito ambulante. O ffmpeg é chamado como
 * PROCESSO, nunca como biblioteca ligada ao servidor: se ele faltar, este
 * módulo devolve um diagnóstico legível em vez de derrubar o analisador.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";

/** Onde os binários foram encontrados, e como. */
export interface FfmpegTools {
  ffmpeg: string;
  ffprobe: string;
  /** De onde veio: variável de ambiente, PATH ou instalação conhecida. */
  origem: string;
}

/**
 * Candidatos fixos do Windows. O winget instala o Gyan.FFmpeg em um caminho
 * versionado sob `WinGet\Packages`, que NÃO entra no PATH do processo já em
 * execução — por isso procuramos direto, em vez de exigir reiniciar o servidor.
 */
function candidatosConhecidos(nome: string): string[] {
  const local = process.env["LOCALAPPDATA"];
  if (!local) return [];
  const base = `${local}\\Microsoft\\WinGet`;
  const pacote = `${base}\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe`;
  const caminhos = [`${base}\\Links\\${nome}.exe`];
  // O build do Gyan instala numa pasta versionada (`ffmpeg-9.0-full_build`).
  // Procuramos a versão presente em vez de fixar o número, que muda a cada
  // atualização — e o `Links` só é populado depois que o PATH é reprocessado.
  try {
    for (const dir of readdirSync(pacote)) {
      caminhos.push(`${pacote}\\${dir}\\bin\\${nome}.exe`);
    }
  } catch {
    // Pacote ausente é caso normal: seguimos com os outros candidatos.
  }
  return caminhos;
}

function executavel(caminho: string, args: string[] = ["-version"]): boolean {
  try {
    const r = spawnSync(caminho, args, { encoding: "utf8", timeout: 15_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

let cache: FfmpegTools | null = null;

/**
 * Localiza ffmpeg e ffprobe. Ordem: variável de ambiente (o operador manda),
 * PATH, instalação do winget.
 *
 * Devolve null quando não existe — quem chama DECLARA a ausência ao usuário.
 * Nunca inventamos um caminho nem seguimos sem decodificador: um vídeo que não
 * pôde ser lido precisa aparecer como vídeo não lido, não como pregão vazio.
 */
export function resolveFfmpeg(): FfmpegTools | null {
  if (cache !== null) return cache;

  const doAmbiente = process.env["FFMPEG_PATH"];
  const probeDoAmbiente = process.env["FFPROBE_PATH"];
  if (doAmbiente && existsSync(doAmbiente) && executavel(doAmbiente)) {
    const probe =
      probeDoAmbiente && existsSync(probeDoAmbiente)
        ? probeDoAmbiente
        : doAmbiente.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace(/ffmpeg/i, "ffprobe"));
    cache = { ffmpeg: doAmbiente, ffprobe: probe, origem: "FFMPEG_PATH" };
    return cache;
  }

  if (executavel("ffmpeg") && executavel("ffprobe")) {
    cache = { ffmpeg: "ffmpeg", ffprobe: "ffprobe", origem: "PATH" };
    return cache;
  }

  const ffmpegLocal = candidatosConhecidos("ffmpeg").find((c) => existsSync(c) && executavel(c));
  const ffprobeLocal = candidatosConhecidos("ffprobe").find((c) => existsSync(c) && executavel(c));
  if (ffmpegLocal && ffprobeLocal) {
    cache = { ffmpeg: ffmpegLocal, ffprobe: ffprobeLocal, origem: "winget" };
    return cache;
  }

  return null;
}

/** Só para os testes: esquece o que foi descoberto. */
export function resetFfmpegCache(): void {
  cache = null;
}

export interface VideoInfo {
  caminho: string;
  duracaoSeg: number;
  largura: number;
  altura: number;
  /** Quadros por segundo declarados pelo contêiner. */
  fps: number;
  codec: string;
  /** Total de frames declarado, quando o contêiner informa. */
  frames: number | null;
}

/** Formatos aceitos. A lista é explícita: extensão desconhecida é recusada. */
export const EXTENSOES_DE_VIDEO = [".mp4", ".mkv", ".avi", ".mov", ".webm"] as const;

export function extensaoSuportada(caminho: string): boolean {
  const lower = caminho.toLowerCase();
  return EXTENSOES_DE_VIDEO.some((ext) => lower.endsWith(ext));
}

/**
 * Metadados reais do arquivo, lidos do contêiner — nunca presumidos.
 *
 * A duração importa mais do que parece: é ela que transforma "frame 4218" em
 * um instante do pregão, e é o instante que a T4 usa para saber se um candle
 * fechou. Um vídeo cuja duração não pode ser lida não vira sessão de mercado.
 */
export function probeVideo(caminho: string): VideoInfo | { erro: string } {
  const tools = resolveFfmpeg();
  if (tools === null) {
    return { erro: "ffmpeg/ffprobe não encontrados — instale ou defina FFMPEG_PATH." };
  }
  if (!existsSync(caminho)) return { erro: `arquivo não encontrado: ${caminho}` };
  if (!extensaoSuportada(caminho)) {
    return {
      erro: `extensão não suportada: ${caminho} (aceitos: ${EXTENSOES_DE_VIDEO.join(", ")})`,
    };
  }

  const r = spawnSync(
    tools.ffprobe,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,avg_frame_rate,codec_name,nb_frames:format=duration",
      "-of",
      "json",
      caminho,
    ],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 120_000 },
  );
  if (r.status !== 0) return { erro: `ffprobe falhou: ${(r.stderr || "").slice(0, 400)}` };

  try {
    const j = JSON.parse(r.stdout) as {
      streams?: Array<{
        width?: number;
        height?: number;
        avg_frame_rate?: string;
        codec_name?: string;
        nb_frames?: string;
      }>;
      format?: { duration?: string };
    };
    const s = j.streams?.[0];
    if (!s || !s.width || !s.height) return { erro: "vídeo sem stream de vídeo legível." };

    // avg_frame_rate vem como "30000/1001". Divisão por zero = fps desconhecido.
    const [num, den] = (s.avg_frame_rate ?? "0/1").split("/").map(Number);
    const fps = den && den !== 0 && num ? num / den : 0;
    const duracao = Number(j.format?.duration ?? 0);
    if (!Number.isFinite(duracao) || duracao <= 0) {
      return { erro: "duração do vídeo ilegível — sem ela não há linha do tempo de mercado." };
    }

    return {
      caminho,
      duracaoSeg: duracao,
      largura: s.width,
      altura: s.height,
      fps: Number.isFinite(fps) && fps > 0 ? fps : 0,
      codec: s.codec_name ?? "desconhecido",
      frames: s.nb_frames ? Number(s.nb_frames) : null,
    };
  } catch (error) {
    return { erro: `resposta do ffprobe ilegível: ${String(error).slice(0, 200)}` };
  }
}
