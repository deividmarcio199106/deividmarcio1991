import {
  ANNOTATION_COLOR,
  podeDesenharAnotacao,
  type Annotation,
} from "@/lib/vision/printAnalysis";

/**
 * EXPORTAÇÃO DO PRINT MODIFICADO — a imagem COM as marcações, para baixar.
 *
 * Na tela, o overlay é SVG por cima do <img> (nunca queima a imagem — isso
 * preserva original × analisado e as camadas ligáveis). Para DOWNLOAD a
 * conta muda: o operador quer UM arquivo que carrega a leitura inteira, para
 * arquivar, compartilhar ou revisar fora do sistema. Aqui as marcações são
 * desenhadas de verdade sobre um canvas com a MESMA geometria normalizada
 * do overlay (frações 0–1 vezes o tamanho natural da imagem).
 *
 * O pacote completo sai em .zip SEM compressão (método store): PNG já é
 * comprimido, e um zip store é ~40 linhas de formato — sem dependência nova.
 * (.rar não existe aqui: é formato proprietário que o navegador não gera;
 * o .zip abre no WinRAR/Explorer normalmente.)
 */

const LINE_KINDS = new Set<Annotation["kind"]>([
  "ENTRY_LINE",
  "STOP",
  "TARGET",
  "INVALIDATION",
  "SUPPORT",
  "RESISTANCE",
]);
const ZONE_KINDS = new Set<Annotation["kind"]>([
  "ENTRY_ZONE",
  "SUPPLY_ZONE",
  "DEMAND_ZONE",
  "ATTENTION_ZONE",
  "T4_PAST",
]);
const DASHED_KINDS = new Set<Annotation["kind"]>([
  "SUPPORT",
  "RESISTANCE",
  "INVALIDATION",
  "ATTENTION_ZONE",
]);

/** Mesmo padrão do overlay: o trecho numérico do label vira etiqueta de preço. */
const PRICE_IN_LABEL = /\d{3}\.\d{3}|\d+[.,]\d+/;

function pill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  color: string,
  align: "left" | "right" = "left",
): void {
  ctx.font = "bold 15px monospace";
  const paddingX = 8;
  const width = ctx.measureText(text).width + paddingX * 2;
  const height = 24;
  const px = align === "right" ? x - width : x;
  ctx.fillStyle = "rgba(11, 18, 32, 0.88)";
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(px, y, width, height, 4);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.fillText(text, px + paddingX, y + height / 2 + 1);
}

function drawAnnotation(
  ctx: CanvasRenderingContext2D,
  a: Annotation,
  w: number,
  h: number,
  entrySide: "COMPRA" | "VENDA" | null = null,
): void {
  const cor =
    a.kind === "CONFIRMATION_CANDLE" && entrySide === "VENDA"
      ? "#ef4444" // §7: a seta da confirmação segue o lado da ordem.
      : ANNOTATION_COLOR[a.kind];
  const y1 = a.y1 * h;
  const y2 = (a.y2 ?? a.y1) * h;
  const dashed = DASHED_KINDS.has(a.kind);
  ctx.setLineDash(dashed ? [10, 7] : []);

  if (ZONE_KINDS.has(a.kind) && Math.abs(y2 - y1) > 1) {
    const top = Math.min(y1, y2);
    ctx.fillStyle = `${cor}22`;
    ctx.fillRect(0, top, w, Math.abs(y2 - y1));
    ctx.strokeStyle = cor;
    ctx.lineWidth = 2;
    ctx.strokeRect(0, top, w, Math.abs(y2 - y1));
    if (a.label) pill(ctx, 10, top + 6, a.label, cor);
  } else if (LINE_KINDS.has(a.kind) || ZONE_KINDS.has(a.kind)) {
    // Zona degenerada (sem altura) desenha como a linha que ela é.
    const destaque = a.kind === "ENTRY_LINE";
    if (destaque) {
      // O brilho da entrada: uma passada larga e translúcida por baixo.
      ctx.setLineDash([]);
      ctx.strokeStyle = `${cor}44`;
      ctx.lineWidth = 11;
      ctx.beginPath();
      ctx.moveTo(0, y1);
      ctx.lineTo(w, y1);
      ctx.stroke();
    }
    ctx.strokeStyle = cor;
    ctx.lineWidth = destaque ? 4 : 3;
    ctx.beginPath();
    ctx.moveTo(0, y1);
    ctx.lineTo(w, y1);
    ctx.stroke();
    if (a.label) pill(ctx, 10, Math.max(4, y1 - 30), a.label, cor);
  } else if (a.kind === "SCENARIO_ARROW") {
    const x1 = a.x1 * w;
    const x2 = (a.x2 ?? a.x1) * w;
    ctx.strokeStyle = cor;
    ctx.lineWidth = 3;
    ctx.setLineDash([12, 8]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    // Ponta da seta: dois traços curtos no ângulo da reta.
    const angulo = Math.atan2(y2 - y1, x2 - x1);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - 14 * Math.cos(angulo - 0.5), y2 - 14 * Math.sin(angulo - 0.5));
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - 14 * Math.cos(angulo + 0.5), y2 - 14 * Math.sin(angulo + 0.5));
    ctx.stroke();
  } else if (a.kind === "CONFIRMATION_CANDLE") {
    // A seta do candle que confirmou: haste vertical + ponta encostando nele.
    const x = a.x1 * w;
    const venda = entrySide === "VENDA";
    const comprimento = h * 0.08;
    const origem = venda ? y1 - comprimento : y1 + comprimento;
    ctx.setLineDash([]);
    ctx.strokeStyle = cor;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(x, origem);
    ctx.lineTo(x, y1);
    ctx.stroke();
    ctx.fillStyle = cor;
    ctx.beginPath();
    ctx.moveTo(x, y1);
    ctx.lineTo(x - 9, venda ? y1 - 15 : y1 + 15);
    ctx.lineTo(x + 9, venda ? y1 - 15 : y1 + 15);
    ctx.closePath();
    ctx.fill();
    const texto = a.label.trim().length > 0 ? `✓ ${a.label.trim()}` : "✓ CONFIRMOU AQUI";
    pill(ctx, Math.min(x + 12, w - 240), venda ? y1 + 8 : Math.max(4, y1 - 34), texto, cor);
  } else {
    // BREAKOUT/PULLBACK/NOTE: marcador pontual com rótulo.
    const x1 = a.x1 * w;
    ctx.setLineDash([]);
    ctx.fillStyle = cor;
    ctx.beginPath();
    ctx.arc(x1, y1, 6, 0, Math.PI * 2);
    ctx.fill();
    if (a.label) pill(ctx, Math.min(x1 + 10, w - 220), Math.max(4, y1 - 30), a.label, cor);
  }

  // Etiqueta de preço na borda direita, como no overlay da tela.
  const preco = PRICE_IN_LABEL.exec(a.label)?.[0];
  if (preco && (LINE_KINDS.has(a.kind) || ZONE_KINDS.has(a.kind))) {
    const yPill = ZONE_KINDS.has(a.kind) && Math.abs(y2 - y1) > 1 ? (y1 + y2) / 2 - 12 : y1 - 12;
    pill(ctx, w - 6, Math.max(4, yPill), preco, cor, "right");
  }
  ctx.setLineDash([]);
}

/** Renderiza o print com as marcações queimadas e devolve o PNG. */
export async function renderAnnotatedPrint(
  imageDataUrl: string,
  annotations: Annotation[],
  /** Lado da entrada CONFIRMADA — só colore a seta da confirmação. */
  entrySide: "COMPRA" | "VENDA" | null = null,
): Promise<Blob> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("print ilegível para exportação"));
    el.src = imageDataUrl;
  });

  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D indisponível para exportação.");
  ctx.drawImage(image, 0, 0);
  /*
   * A seta de confirmação só é queimada com `entrySide` — que significa
   * "entrada confirmada". O PNG viaja SOZINHO: é compartilhado, arquivado e
   * relido fora do sistema, sem card lateral para contradizê-lo. Um "✓
   * CONFIRMOU" num arquivo assim afirma entrada liberada por conta própria.
   */
  const desenhaveis = annotations.filter((a) => podeDesenharAnotacao(a, entrySide));
  for (const a of desenhaveis) drawAnnotation(ctx, a, canvas.width, canvas.height, entrySide);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("exportação do PNG falhou"))),
      "image/png",
    );
  });
}

/* ------------------------------------------------------------------------ *
 * ZIP (método store) — formato mínimo, puro e testável.
 * ------------------------------------------------------------------------ */

let CRC_TABLE: Uint32Array | null = null;
export function crc32(data: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntryInput {
  /** Nome ASCII — acentos ficam fora do zip para abrir em qualquer descompactador. */
  name: string;
  data: Uint8Array;
}

/**
 * Monta um .zip com entradas SEM compressão (store). `at` entra por parâmetro
 * — data embutida em arquivo é dado, e dado não sai de relógio implícito.
 */
export function buildZipStore(entries: ZipEntryInput[], at: number): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const d = new Date(at);
  // Data/hora no formato MS-DOS do zip (resolução de 2s, ano desde 1980).
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const dosDate =
    ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  const u16 = (v: number) => [v & 0xff, (v >>> 8) & 0xff];
  const u32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const local = new Uint8Array([
      0x50,
      0x4b,
      0x03,
      0x04, // assinatura local
      ...u16(20),
      ...u16(0),
      ...u16(0), // versão, flags, método 0 (store)
      ...u16(dosTime),
      ...u16(dosDate),
      ...u32(crc),
      ...u32(entry.data.length),
      ...u32(entry.data.length),
      ...u16(name.length),
      ...u16(0),
      ...name,
    ]);
    const central = new Uint8Array([
      0x50,
      0x4b,
      0x01,
      0x02, // assinatura central
      ...u16(20),
      ...u16(20),
      ...u16(0),
      ...u16(0),
      ...u16(dosTime),
      ...u16(dosDate),
      ...u32(crc),
      ...u32(entry.data.length),
      ...u32(entry.data.length),
      ...u16(name.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(offset),
      ...name,
    ]);
    locals.push(local, entry.data);
    centrals.push(central);
    offset += local.length + entry.data.length;
  }

  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const end = new Uint8Array([
    0x50,
    0x4b,
    0x05,
    0x06, // fim do diretório central
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(centralSize),
    ...u32(offset),
    ...u16(0),
  ]);

  const total = offset + centralSize + end.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const parte of [...locals, ...centrals, end]) {
    out.set(parte, cursor);
    cursor += parte.length;
  }
  return out;
}

/** Dispara o download no navegador e libera o ObjectURL na sequência. */
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revogação adiada: revogar síncrono cancela o download em alguns Chromium.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
