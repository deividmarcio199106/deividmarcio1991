import * as z from "zod";

import type { ScaleAnchor } from "@/lib/vision/priceScale";
import { validateYPercent } from "@/lib/vision/yPercent";
import {
  classifyAudit,
  classifyThrown,
  scaleReject,
  EMPTY_AUDIT,
  type LabelAudit,
  type ScaleReject,
} from "@/lib/vision/scaleReject";
import { selectLabels, type LabelReading, type Regression } from "@/lib/vision/scaleLabels";
import { extractJsonObject } from "@/lib/jsonExtract";

import { aiConfig } from "./config";
import { aiBreaker, describeAIError } from "./gateway";

const VisionPayload = z.object({
  labels: z
    .array(
      z.object({
        raw: z.string().min(1).max(40),
        price: z.number().finite(),
        // Validação fina label a label em selectScaleAnchors (spec V5 §12) —
        // uma label fisicamente impossível é descartada com motivo, sem
        // derrubar a leitura inteira das demais.
        yPercent: z.number().finite(),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(20),
  linearScale: z.boolean().default(true),
});

export interface VisionScaleResult {
  anchors: ScaleAnchor[];
  model: string;
  error: string | null;
  /**
   * Código estável do motivo, quando não deu. A UI depende DELE, não da frase:
   * o texto muda com a redação, o código não. Null quando as âncoras saíram.
   */
  reject: ScaleReject | null;
  /** De onde os rótulos se perderam — antes ou depois da régua percentual. */
  audit: LabelAudit;
}

function imageBase64(dataUrl: string): string | null {
  const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  return match?.[1] ?? null;
}

type VisionLabel = z.infer<typeof VisionPayload>["labels"][number];

/**
 * Seleciona TODAS as âncoras consistentes da leitura do Qwen-VL — não apenas
 * um par. Motivos:
 *
 * 1. Com apenas 2 âncoras o R² da regressão é sempre 1, então a proteção
 *    contra escala não linear / dígito trocado pelo OCR (priceScale.ts) fica
 *    inoperante. Com 3+ âncoras a validação de linearidade volta a funcionar.
 * 2. `calibrateFromAnchors` dá bônus de robustez a partir de 3 âncoras
 *    (preferredAnchors); descartar rótulos válidos reprovava calibrações boas.
 *
 * Consistência exigida: preço estritamente decrescente conforme y cresce
 * (escala de preço normal). Rótulos que quebram a monotonicidade (horários,
 * indicadores, dígito trocado) são descartados via maior cadeia consistente.
 */
/** Faixa plausivel do contrato — desempata "203.625" entre 203625 e 203,625. */
function expectedRangeFor(asset: string | null): { min: number; max: number } | null {
  if (!asset) return null;
  const symbol = asset.trim().toUpperCase();
  if (symbol.startsWith("WIN") || symbol.startsWith("IND")) return { min: 10_000, max: 500_000 };
  if (symbol.startsWith("WDO") || symbol.startsWith("DOL")) return { min: 1_000, max: 20_000 };
  return null;
}

export function selectScaleAnchors(labels: VisionLabel[], frameHeight: number): ScaleAnchor[] {
  return auditScaleAnchors(labels, frameHeight).anchors;
}

/**
 * Mesma seleção, com o RASTRO de onde cada rótulo se perdeu.
 *
 * Sem esse rastro, toda falha desemboca em "âncoras insuficientes" — inclusive
 * quando a causa foi percentY fora da régua em TODOS os rótulos, que é defeito
 * da leitura e não do gráfico. Os dois pedem conserto em lugares diferentes.
 */
export function auditScaleAnchors(
  labels: VisionLabel[],
  frameHeight: number,
  asset: string | null = null,
): {
  anchors: ScaleAnchor[];
  audit: LabelAudit;
  reject: ScaleReject | null;
  labels: LabelReading[];
  regression: Regression | null;
} {
  // A selecao inteira vive em `scaleLabels`: regua, formato BR, duplicata,
  // ordem e reta, cada descarte com nome proprio. Antes estava espalhada entre
  // este arquivo e `priceScale`, e por isso um unico rotulo fora de ordem
  // reprovava a leitura toda com NON_MONOTONIC.
  const selection = selectLabels(labels, frameHeight, expectedRangeFor(asset));

  const audit: LabelAudit = {
    received: selection.labels.length,
    invalidPercent: selection.labels.filter((l) => l.drop === "PERCENT_FORA_DA_REGUA").length,
    lowConfidence: selection.labels.filter((l) => l.drop === "CONFIANCA_BAIXA").length,
    nonMonotonic: selection.labels.filter((l) => l.drop === "QUEBRA_ORDEM").length,
    kept: selection.kept.length,
  };

  const anchors: ScaleAnchor[] = selection.kept.map((l) => ({
    y: l.y,
    price: l.price,
    raw: l.raw,
    source: "ocr" as const,
    confidence: l.confidence,
  }));

  return {
    anchors,
    audit,
    reject: selection.reason === null ? null : classifyAudit(audit),
    labels: selection.labels,
    regression: selection.regression,
  };
}

/** Nome antigo mantido por compatibilidade — hoje devolve todas as âncoras consistentes. */
export const selectBestScalePair = selectScaleAnchors;

export async function readPriceScaleWithVision(
  dataUrl: string,
  frameHeight: number,
  asset: string | null = null,
): Promise<VisionScaleResult> {
  const config = aiConfig();
  const image = imageBase64(dataUrl);
  if (!config.baseUrl || config.provider !== "ollama") {
    return {
      anchors: [],
      model: config.visionModel,
      error: "O OCR automático exige Ollama.",
      reject: scaleReject("GPU_OFFLINE", "provedor de visão não é Ollama ou não está configurado"),
      audit: EMPTY_AUDIT,
    };
  }
  if (!config.visionModel) {
    return {
      anchors: [],
      model: "",
      error: "Modelo visual não configurado. Defina OLLAMA_VISION_MODEL.",
      reject: scaleReject("GPU_OFFLINE", "OLLAMA_VISION_MODEL não definido"),
      audit: EMPTY_AUDIT,
    };
  }
  if (!image) {
    return {
      anchors: [],
      model: config.visionModel,
      error: "Imagem de escala inválida.",
      reject: scaleReject("ROI_INVALID", "o recorte enviado não é uma imagem base64 válida"),
      audit: EMPTY_AUDIT,
    };
  }

  try {
    const response = await aiBreaker.run(() =>
      fetch(`${config.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(config.timeoutMs),
        body: JSON.stringify({
          model: config.visionModel,
          stream: false,
          think: false,
          format: {
            type: "object",
            properties: {
              labels: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    raw: { type: "string" },
                    price: { type: "number" },
                    yPercent: { type: "number" },
                    confidence: { type: "number" },
                  },
                  required: ["raw", "price", "yPercent", "confidence"],
                },
              },
              linearScale: { type: "boolean" },
            },
            required: ["labels", "linearScale"],
          },
          options: { temperature: 0 },
          messages: [
            {
              role: "user",
              content:
                // OS EXTREMOS SÃO OBRIGATÓRIOS. Sem pedi-los explicitamente, o
                // modelo devolvia rótulos vizinhos ao preço atual, separados por
                // 16% da altura — e uma reta ajustada em 16% do eixo é
                // extrapolada para os outros 84%, que é onde ficam os alvos.
                "Faça somente OCR da escala vertical de PREÇOS deste gráfico do Profit. O recorte contém uma régua percentual à esquerda. Copie os rótulos numéricos da escala de preços à direita e informe o centro vertical de cada rótulo usando a régua (0 no topo, 100 na base). COMECE pelo rótulo MAIS ALTO visível e pelo rótulo MAIS BAIXO visível — eles são obrigatórios — e depois inclua os intermediários. Os rótulos devem cobrir a maior extensão vertical possível do recorte, não apenas a região central. Ignore horários, indicadores, volume, contadores de candle e números fora da escala. Atenção ao formato brasileiro: em contratos como WIN, um rótulo visual 203.625 representa 203625 pontos (ponto de milhar), não o decimal 203.625. Preserve também o texto original em raw. O preço deve diminuir de cima para baixo. Retorne preferencialmente quatro ou mais rótulos bem separados; dois são o mínimo absoluto. Não estime número ilegível.",
              images: [image],
            },
          ],
        }),
      }).then(async (result) => {
        if (!result.ok) throw new Error(`status ${result.status}`);
        return result;
      }),
    );
    const payload = (await response.json()) as { message?: { content?: string } };
    const raw = payload.message?.content?.trim() ?? "";
    // Extração robusta (spec §92): tolera cercas markdown e texto ao redor;
    // sem objeto válido, falha controlada — nunca palpite.
    const extracted = extractJsonObject(raw);
    if (extracted === null) {
      return {
        anchors: [],
        model: config.visionModel,
        error: "A resposta da IA não contém JSON válido de escala.",
        reject: scaleReject("OCR_EMPTY", "resposta sem objeto JSON de escala"),
        audit: EMPTY_AUDIT,
      };
    }
    const parsed = VisionPayload.parse(extracted);
    if (!parsed.linearScale) {
      return {
        anchors: [],
        model: config.visionModel,
        error: "A escala visual não parece linear.",
        reject: scaleReject("BAD_LINEARITY", "o modelo reportou escala não linear no eixo"),
        audit: { ...EMPTY_AUDIT, received: parsed.labels.length },
      };
    }
    const { anchors, audit, reject, labels, regression } = auditScaleAnchors(
      parsed.labels,
      frameHeight,
      asset,
    );
    return {
      anchors,
      model: config.visionModel,
      error:
        anchors.length >= 2
          ? null
          : "O Qwen-VL não encontrou dois preços legíveis e suficientemente separados.",
      reject,
      audit,
    };
  } catch (error) {
    return {
      anchors: [],
      model: config.visionModel,
      error: describeAIError(error, config.visionModel, config.timeoutMs),
      // Serviço lento e serviço ausente pedem consertos diferentes; a frase
      // localizada não distingue, o código sim.
      reject: classifyThrown(error),
      audit: EMPTY_AUDIT,
    };
  }
}
