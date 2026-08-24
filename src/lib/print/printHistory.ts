/**
 * HISTÓRICO DE ANÁLISES DE PRINT — no navegador, com miniatura reduzida.
 *
 * A escolha de guardar em localStorage é deliberada e tem um custo declarado:
 * o histórico é DESTA máquina e DESTE navegador. A alternativa — tabela no
 * SQLite com upload das imagens — guardaria prints de gráfico no servidor sem
 * necessidade operacional; o histórico existe para o operador rever as próprias
 * análises, não para alimentar o motor.
 *
 * O QUE IMPEDE O ESTOURO DA COTA: a imagem original NÃO é guardada. Cada
 * entrada leva uma miniatura reduzida (máx. 900px, JPEG 0.75) — legível para
 * revisão e reanálise, ~10× menor que o print cru. Máximo de 8 entradas; a mais
 * antiga sai. Se ainda assim a cota estourar, descartamos as mais antigas até
 * caber, e o descarte é reportado ao chamador.
 *
 * REANÁLISE DE UMA ENTRADA ANTIGA usa a miniatura, e a UI diz isso: o resultado
 * pode diferir do original porque a imagem tem menos detalhe.
 */

import type { PrintAnalysis } from "@/lib/vision/printAnalysis";

const KEY = "t4.print.history";
const MAX_ENTRIES = 8;
const THUMB_MAX_PX = 900;

export interface PrintFeedback {
  verdict: "CORRETA" | "INCORRETA";
  reasons: string[];
  at: number;
}

/** Como e por que esta captura existiu — presente só nas automáticas. */
export interface CaptureOrigin {
  /** Motivo humano do disparo ("novo candle fechado…", "análise manual…"). */
  motivo: string;
  /** Código estável do gatilho do detector, ou MANUAL. */
  code: string;
  /** Latência captura→análise pronta, medida de verdade. */
  latencyMs: number | null;
}

export interface PrintHistoryEntry {
  id: string;
  at: number;
  /** Miniatura JPEG reduzida — NÃO é o print original. */
  thumb: string;
  analysis: PrintAnalysis;
  feedback: PrintFeedback | null;
  /** Ausente nas análises coladas manualmente (entradas antigas inclusive). */
  capture?: CaptureOrigin | null;
}

function read(): PrintHistoryEntry[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as PrintHistoryEntry[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(entries: PrintHistoryEntry[]): { dropped: number } {
  if (typeof localStorage === "undefined") return { dropped: 0 };
  let atual = [...entries];
  let dropped = 0;
  // Cota é imprevisível entre navegadores: tenta, e encolhe até caber.
  for (;;) {
    try {
      localStorage.setItem(KEY, JSON.stringify(atual));
      return { dropped };
    } catch {
      if (atual.length <= 1) return { dropped };
      atual = atual.slice(0, atual.length - 1);
      dropped++;
    }
  }
}

/** Reduz o print para miniatura. Roda só no navegador (usa canvas). */
export async function makeThumb(dataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error("Falha ao carregar a imagem para miniatura."));
    img.onload = () => {
      const escala = Math.min(1, THUMB_MAX_PX / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * escala));
      canvas.height = Math.max(1, Math.round(img.height * escala));
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Canvas indisponível."));
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.75));
    };
    img.src = dataUrl;
  });
}

export async function saveToHistory(
  imageDataUrl: string,
  analysis: PrintAnalysis,
  capture: CaptureOrigin | null = null,
): Promise<{ entry: PrintHistoryEntry; dropped: number }> {
  const thumb = await makeThumb(imageDataUrl);
  const entry: PrintHistoryEntry = {
    id: `print_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    at: Date.now(),
    thumb,
    analysis,
    feedback: null,
    capture,
  };
  const entries = [entry, ...read()].slice(0, MAX_ENTRIES);
  const { dropped } = write(entries);
  return { entry, dropped };
}

export function listHistory(): PrintHistoryEntry[] {
  return read();
}

export function getHistoryEntry(id: string): PrintHistoryEntry | null {
  return read().find((e) => e.id === id) ?? null;
}

export function removeHistoryEntry(id: string): void {
  write(read().filter((e) => e.id !== id));
}

/**
 * Feedback do operador sobre uma análise.
 *
 * Guardado junto da entrada: é a matéria-prima da calibração futura, e ela só
 * serve se ficar amarrada à análise exata que o operador julgou.
 */
export function setHistoryFeedback(id: string, feedback: PrintFeedback): boolean {
  const entries = read();
  const alvo = entries.find((e) => e.id === id);
  if (!alvo) return false;
  alvo.feedback = feedback;
  write(entries);
  return true;
}

/** Handoff para reabrir uma entrada no analisador. Sobrevive só à navegação. */
const REOPEN_KEY = "t4.print.reopen";

export function requestReopen(id: string): void {
  if (typeof sessionStorage !== "undefined") sessionStorage.setItem(REOPEN_KEY, id);
}

export function takeReopenRequest(): PrintHistoryEntry | null {
  if (typeof sessionStorage === "undefined") return null;
  const id = sessionStorage.getItem(REOPEN_KEY);
  if (!id) return null;
  sessionStorage.removeItem(REOPEN_KEY);
  return getHistoryEntry(id);
}
