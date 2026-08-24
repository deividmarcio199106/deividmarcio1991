/**
 * OCR AUXILIAR — o "olho para números" da T4.
 *
 * O navegador manda apenas dois recortes pequenos: a faixa do eixo de preço e a
 * do relógio. Nunca a tela inteira. Isso mantém o payload pequeno, não expõe o
 * gráfico do operador e faz a leitura caber no orçamento de latência.
 *
 * MEDIDO, NÃO ESTIMADO: o qwen3.5:4b na RTX 5090 leva ~8,6s por recorte do eixo
 * e lê 4/4 rótulos corretos. Por isso este endpoint é CALIBRADOR, não
 * acompanhante: depois que a escala existe, converter pixel em preço é
 * aritmética local instantânea e a IA não é chamada de novo até a geometria
 * mudar.
 *
 * A RÉGUA PERCENTUAL É OBRIGATÓRIA
 * Medi que as coordenadas Y cruas do modelo vêm com alongamento sistemático de
 * ~13%: rótulos em y=20,160,300,440 foram reportados como 38,196,354,512. A
 * relação continua linear, então nada parece errado — e a conversão sairia com
 * inclinação errada, produzindo preços plausíveis e falsos. Por isso o recorte
 * leva uma régua desenhada e o modelo responde POSIÇÃO PERCENTUAL contra marcas
 * visíveis, nunca pixel estimado.
 */

import { createServerFn } from "@tanstack/react-start";

import { normalizeScaleAnchorsForAsset, type ScaleAnchor } from "@/lib/vision/priceScale";
import { validateYPercent, yPercentToPixel } from "@/lib/vision/yPercent";
import { parseClockLabel, resolveInstant } from "@/lib/vision/timeAxis";

/** Recorte maior que isto não é eixo de preço — é a tela inteira por engano. */
const MAX_IMAGE_BYTES = 900_000;
const DEFAULT_MODEL = "qwen3.5:4b";
const TIMEOUT_MS = 45_000;

function visionUrl(): string {
  return process.env.OLLAMA_VISION_URL ?? process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11435";
}

function visionModel(): string {
  return process.env.OLLAMA_VISION_MODEL ?? DEFAULT_MODEL;
}

/**
 * Aceita só imagem, e pequena.
 *
 * A validação é de conteúdo, não de nome: um cliente pode dizer que manda PNG e
 * mandar outra coisa. O prefixo data:image e o tamanho são o que de fato limita.
 */
function validateImage(dataUrl: string): string | null {
  if (!dataUrl.startsWith("data:image/")) return "conteúdo não é imagem";
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return "data URL malformada";
  const base64 = dataUrl.slice(comma + 1);
  // 4 caracteres base64 = 3 bytes.
  if ((base64.length * 3) / 4 > MAX_IMAGE_BYTES)
    return "imagem grande demais para um recorte de eixo";
  if (base64.length === 0) return "imagem vazia";
  return null;
}

async function askVision(imageDataUrl: string, prompt: string): Promise<string | null> {
  const base64 = imageDataUrl.slice(imageDataUrl.indexOf(",") + 1);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${visionUrl()}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: visionModel(),
        stream: false,
        options: { temperature: 0 },
        prompt,
        images: [base64],
      }),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { response?: string };
    return payload.response ?? null;
  } catch {
    // Falha de OCR nunca derruba a leitura estrutural: devolve null e o
    // priceScaleTracker segue com priceScaleReady=false.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const PRICE_PROMPT = [
  "Esta imagem mostra o eixo de precos de um grafico, com uma REGUA percentual",
  "desenhada a esquerda (0% no topo, 100% embaixo, marcas a cada 5%).",
  "Para CADA numero de preco visivel, diga o texto exato e a posicao dele em",
  "PERCENTUAL segundo a regua ao lado. Nao estime pixels.",
  'Responda SOMENTE JSON: {"labels":[{"text":"172.410","yPercent":6.5}]}',
].join(" ");

const CLOCK_PROMPT = [
  "Esta imagem mostra o eixo de tempo de um grafico de mercado.",
  "Liste os horarios visiveis no formato HH:MM ou HH:MM:SS e a posicao",
  "HORIZONTAL de cada um em percentual da largura (0% esquerda, 100% direita).",
  'Responda SOMENTE JSON: {"labels":[{"text":"18:04","xPercent":12.0}]}',
].join(" ");

/** Extrai o primeiro objeto JSON da resposta, que costuma vir com texto em volta. */
function extractJson(raw: string): unknown | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

export interface PriceScaleResult {
  anchors: { y: number; price: number }[];
  confidence: number;
  valid: boolean;
  reason: string;
}

export const readPriceScale = createServerFn({ method: "POST" })
  .validator((input: { imageDataUrl: string; frameHeight: number; symbol: string }) => input)
  .handler(async ({ data }): Promise<PriceScaleResult> => {
    const problem = validateImage(data.imageDataUrl);
    if (problem !== null) {
      return { anchors: [], confidence: 0, valid: false, reason: problem };
    }

    const raw = await askVision(data.imageDataUrl, PRICE_PROMPT);
    if (raw === null) {
      return { anchors: [], confidence: 0, valid: false, reason: "modelo de visão não respondeu" };
    }

    const parsed = extractJson(raw) as { labels?: { text?: string; yPercent?: number }[] } | null;
    if (parsed === null || !Array.isArray(parsed.labels)) {
      return {
        anchors: [],
        confidence: 0,
        valid: false,
        reason: "resposta do modelo não é JSON de rótulos",
      };
    }

    const candidates: ScaleAnchor[] = [];
    for (const label of parsed.labels) {
      if (typeof label.text !== "string") continue;
      // Percentual fora de 0–100 é RECUSADO, nunca ajustado para caber: o
      // modelo errou, e forçar o valor esconderia o erro dentro da escala.
      const check = validateYPercent(label.yPercent);
      if (!check.valid) continue;
      const y = yPercentToPixel(label.yPercent as number, data.frameHeight);
      if (y === null) continue;
      // Formato brasileiro: 172.410 é separador de milhar, não decimal.
      const price = Number(label.text.replace(/\./g, "").replace(",", "."));
      if (!Number.isFinite(price)) continue;
      candidates.push({ y, price, raw: label.text, source: "ocr", confidence: 0.85 });
    }

    // A faixa do ativo impede que um número de indicador vire escala.
    const anchors = normalizeScaleAnchorsForAsset(data.symbol, candidates);
    if (anchors.length < 2) {
      return {
        anchors: [],
        confidence: 0,
        valid: false,
        reason: `apenas ${anchors.length} rótulo(s) utilizável(is) na faixa do ativo`,
      };
    }

    return {
      anchors: anchors.map((a) => ({ y: a.y, price: a.price })),
      confidence: Math.round(85),
      valid: true,
      reason: `${anchors.length} rótulos lidos`,
    };
  });

export interface ChartClockResult {
  labels: { xPercent: number; t: number; raw: string }[];
  confidence: number;
  valid: boolean;
  reason: string;
}

export const readChartClockAxis = createServerFn({ method: "POST" })
  .validator((input: { imageDataUrl: string; tradingDayStart: number }) => input)
  .handler(async ({ data }): Promise<ChartClockResult> => {
    const problem = validateImage(data.imageDataUrl);
    if (problem !== null) {
      return { labels: [], confidence: 0, valid: false, reason: problem };
    }

    const raw = await askVision(data.imageDataUrl, CLOCK_PROMPT);
    if (raw === null) {
      return { labels: [], confidence: 0, valid: false, reason: "modelo de visão não respondeu" };
    }

    const parsed = extractJson(raw) as { labels?: { text?: string; xPercent?: number }[] } | null;
    if (parsed === null || !Array.isArray(parsed.labels)) {
      return {
        labels: [],
        confidence: 0,
        valid: false,
        reason: "resposta do modelo não é JSON de rótulos",
      };
    }

    const labels: ChartClockResult["labels"] = [];
    for (const label of parsed.labels) {
      if (typeof label.text !== "string" || typeof label.xPercent !== "number") continue;
      const ms = parseClockLabel(label.text);
      // Rótulo de data no eixo é recusado aqui: misturar com horário produziria
      // um instante absurdo.
      if (ms === null) continue;
      if (label.xPercent < 0 || label.xPercent > 100) continue;
      labels.push({
        xPercent: label.xPercent,
        t: resolveInstant(data.tradingDayStart, ms),
        raw: label.text,
      });
    }

    if (labels.length < 2) {
      return {
        labels: [],
        confidence: 0,
        valid: false,
        reason: `apenas ${labels.length} horário(s) legível(is) — insuficiente para a reta`,
      };
    }

    return { labels, confidence: 85, valid: true, reason: `${labels.length} horários lidos` };
  });
