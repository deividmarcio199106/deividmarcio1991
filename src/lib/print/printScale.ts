import { capturePriceScaleImage } from "@/lib/capture/frameProcessor";
import {
  calibrateFromAnchors,
  normalizeScaleAnchorsForAsset,
  yAt,
  type Calibration,
  type ScaleAnchor,
} from "@/lib/vision/priceScale";
import type {
  Annotation,
  ConditionalPlan,
  PriceLevel,
  PriceLevelKind,
  PrintAnalysis,
} from "@/lib/vision/printAnalysis";

/**
 * NÍVEIS POSICIONADOS PELA RÉGUA — a correção de "não está marcando direito".
 *
 * A lição veio da escala ao vivo e vale dobrado aqui: COORDENADA CRUA DE
 * MODELO VEM COM ALONGAMENTO SISTEMÁTICO. Pedir para a IA devolver o y da
 * linha de entrada é pedir um palpite de pixel; a linha cai perto, nunca em
 * cima. A divisão de trabalho correta é a da casa:
 *
 *   a IA LÊ os números (entrada, stop, alvo — só quando legíveis);
 *   a RÉGUA da escala do PRÓPRIO print converte preço em altura;
 *   o front DESENHA a linha exatamente ali.
 *
 * A calibração reutiliza o mesmo caminho da operação ao vivo: recorte do eixo
 * de preços com régua percentual desenhada → OCR → reta por mínimos
 * quadrados robustos → `yAt(preço)`. Se a escala do print não calibrar, as
 * marcações do modelo ficam como estão — impreciso e dito, nunca inventado.
 */

export interface PrintScaleResult {
  ok: boolean;
  calibration: Calibration | null;
  /** Altura do canvas em que a calibração vive — o y é fração DESTA altura. */
  frameHeight: number;
  reason: string;
}

interface CalibrateServerFn {
  (input: {
    data: { imageDataUrl: string; frameHeight: number; asset?: string };
  }): Promise<{ anchors: ScaleAnchor[]; error: string | null }>;
}

/** Carrega o print num <img> para o recorte da escala (CanvasImageSource). */
function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("print ilegível como imagem"));
    image.src = dataUrl;
  });
}

/**
 * Calibra a escala de preços do próprio print. Uma chamada de visão a mais
 * (~2–5 s com o modelo quente) — é o preço de linha no lugar certo.
 */
export async function calibratePrintImage(
  dataUrl: string,
  asset: string,
  calibrate: CalibrateServerFn,
): Promise<PrintScaleResult> {
  try {
    const image = await loadImage(dataUrl);
    const snapshot = capturePriceScaleImage(image);
    const response = await calibrate({
      data: {
        imageDataUrl: snapshot.imageDataUrl,
        frameHeight: snapshot.frameHeight,
        asset,
      },
    });
    if (response.error) {
      return { ok: false, calibration: null, frameHeight: 0, reason: response.error };
    }
    const anchors = normalizeScaleAnchorsForAsset(asset, response.anchors);
    const calibration = calibrateFromAnchors(anchors);
    if (!calibration.usable) {
      return { ok: false, calibration: null, frameHeight: 0, reason: calibration.reason };
    }
    return { ok: true, calibration, frameHeight: snapshot.frameHeight, reason: "calibrada" };
  } catch (problem) {
    return {
      ok: false,
      calibration: null,
      frameHeight: 0,
      reason: problem instanceof Error ? problem.message : String(problem),
    };
  }
}

/** preço → fração 0–1 da altura do print. Null fora do enquadramento. */
export function priceToFraction(
  calibration: Calibration,
  frameHeight: number,
  price: number,
): number | null {
  if (frameHeight <= 0) return null;
  const y = yAt(calibration, price);
  if (y === null) return null;
  const fraction = y / frameHeight;
  // Nível fora da parte visível do gráfico não vira linha voadora na borda.
  if (fraction < 0 || fraction > 1) return null;
  return Number(fraction.toFixed(4));
}

const BRL = (price: number) => price.toLocaleString("pt-BR");

type ToFraction = (price: number) => number | null;

function line(kind: Annotation["kind"], y: number, label: string, reason: string): Annotation {
  return { kind, x1: 0, y1: y, x2: 1, y2: y, label, index: null, reason };
}

const RULER_REASON = "Posicionada pela régua da escala do print — preço lido, não pixel estimado.";

/**
 * Constrói as marcações de nível a partir dos NÚMEROS LEGÍVEIS da análise.
 *
 * PURA e determinística: recebe o conversor preço→fração e devolve as
 * anotações. Nível ilegível não gera linha (a lei do `visible` atravessa);
 * nível fora do enquadramento também não — linha "espremida na borda" é o
 * jeito visual de inventar.
 */
/**
 * Nível de leitura completa → kind de marcação. TOPO/FUNDO são linhas de
 * estrutura (resistência/suporte com nome); PERDA_ESTRUTURAL é invalidação.
 */
const LEVEL_TO_KIND: Record<PriceLevelKind, Annotation["kind"]> = {
  SUPORTE: "SUPPORT",
  RESISTENCIA: "RESISTANCE",
  ZONA_VENDA: "SUPPLY_ZONE",
  ZONA_COMPRA: "DEMAND_ZONE",
  ZONA_ATENCAO: "ATTENTION_ZONE",
  TOPO: "RESISTANCE",
  FUNDO: "SUPPORT",
  PERDA_ESTRUTURAL: "INVALIDATION",
};

export interface CalibratedAnnotations {
  annotations: Annotation[];
  /**
   * Kinds cuja versão da régua SUBSTITUI o palpite do modelo. Calculado pelo
   * que foi de fato recalculado: a linha de gatilho do plano reusa o kind
   * S/R, mas NÃO autoriza apagar as S/R estruturais que o modelo enxergou —
   * a régua só venceu os níveis que ela mesma reposicionou.
   */
  replaceKinds: Set<Annotation["kind"]>;
}

export function buildPriceAnnotations(
  analysis: Pick<
    PrintAnalysis,
    "entry" | "entryZone" | "stop" | "targets" | "conditionalPlans" | "priceLevels"
  >,
  toFraction: ToFraction,
): CalibratedAnnotations {
  const out: Annotation[] = [];
  const replaceKinds = new Set<Annotation["kind"]>();
  const marcar = (a: Annotation): void => {
    replaceKinds.add(a.kind);
    out.push(a);
  };

  // ZONAS E NÍVEIS DA LEITURA COMPLETA — o vocabulário do mockup do operador.
  // O validador já garantiu: priceMin legível, faixa em ordem. Aqui só resta
  // a geometria: faixa legível dos dois lados vira BANDA; nível único, LINHA.
  for (const nivel of analysis.priceLevels as PriceLevel[]) {
    if (!nivel.priceMin.visible || nivel.priceMin.value === null) continue;
    const yMin = toFraction(nivel.priceMin.value);
    if (yMin === null) continue;
    const kind = LEVEL_TO_KIND[nivel.kind];
    const temFaixa =
      nivel.priceMax !== null && nivel.priceMax.visible && nivel.priceMax.value !== null;
    if (temFaixa) {
      const yMax = toFraction(nivel.priceMax!.value!);
      if (yMax === null) continue;
      marcar({
        kind,
        x1: 0,
        y1: Math.min(yMin, yMax),
        x2: 1,
        y2: Math.max(yMin, yMax),
        label: `${nivel.label} · ${BRL(nivel.priceMin.value)} – ${BRL(nivel.priceMax!.value!)}`,
        index: null,
        reason: RULER_REASON,
      });
    } else {
      marcar(line(kind, yMin, `${nivel.label} · ${BRL(nivel.priceMin.value)}`, RULER_REASON));
    }
  }

  if (analysis.entry.visible && analysis.entry.value !== null) {
    const y = toFraction(analysis.entry.value);
    if (y !== null)
      marcar(line("ENTRY_LINE", y, `ENTRADA ${BRL(analysis.entry.value)}`, RULER_REASON));
  }

  if (analysis.entryZone) {
    const { min, max } = analysis.entryZone;
    if (min.visible && min.value !== null && max.visible && max.value !== null) {
      const yMin = toFraction(min.value);
      const yMax = toFraction(max.value);
      if (yMin !== null && yMax !== null) {
        marcar({
          kind: "ENTRY_ZONE",
          x1: 0,
          y1: Math.min(yMin, yMax),
          x2: 1,
          y2: Math.max(yMin, yMax),
          label: `ZONA ${BRL(min.value)} – ${BRL(max.value)}`,
          index: null,
          reason: RULER_REASON,
        });
      }
    }
  }

  if (analysis.stop.visible && analysis.stop.value !== null) {
    const y = toFraction(analysis.stop.value);
    if (y !== null) marcar(line("STOP", y, `STOP ${BRL(analysis.stop.value)}`, RULER_REASON));
  }

  analysis.targets.forEach((target, i) => {
    if (target.visible && target.value !== null) {
      const y = toFraction(target.value);
      if (y !== null) {
        marcar(line("TARGET", y, `ALVO ${i + 1} · ${BRL(target.value)}`, RULER_REASON));
      }
    }
  });

  // O gatilho do plano condicional é a linha mais acionável da tela: "SE
  // fechar acima/abaixo DAQUI". Vira linha de S/R tracejada no nível lido —
  // acima = resistência a romper (COMPRA), abaixo = suporte a perder (VENDA).
  for (const plano of analysis.conditionalPlans as ConditionalPlan[]) {
    if (plano.triggerLevel.visible && plano.triggerLevel.value !== null) {
      const y = toFraction(plano.triggerLevel.value);
      if (y !== null) {
        out.push(
          line(
            plano.side === "COMPRA" ? "RESISTANCE" : "SUPPORT",
            y,
            `PLANO: SE ${plano.trigger} (${BRL(plano.triggerLevel.value)}) → ${plano.side}`,
            RULER_REASON,
          ),
        );
      }
    }
  }

  return { annotations: out, replaceKinds };
}

/**
 * Funde as marcações: os kinds que a régua RECALCULOU substituem o palpite
 * do modelo; o resto do modelo fica (T4 passadas, rompimentos, notas, setas,
 * e S/R estruturais sem versão calibrada). A decisão vem de `replaceKinds`,
 * calculado por quem foi de fato reposicionado — a linha de gatilho do plano
 * reusa o kind S/R e NÃO autoriza apagar as S/R que o modelo enxergou.
 * Linha imprecisa avisada é melhor que nível sumido.
 */
export function mergeCalibratedAnnotations(
  original: Annotation[],
  calibrated: CalibratedAnnotations,
): Annotation[] {
  if (calibrated.annotations.length === 0) return original;
  const kept = original.filter((a) => !calibrated.replaceKinds.has(a.kind));
  return [...kept, ...calibrated.annotations];
}
