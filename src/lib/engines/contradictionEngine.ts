import type { Features } from "./marketFeatures";
import type { Regime } from "./regimeEngine";
import type {
  Direction,
  LiquidityCaptureResult,
  POI,
  PriceActionRead,
  SMSRead,
  TradePlan,
} from "./types";

/**
 * Motor adversarial (spec V5 §18–§19) — procura ativamente motivos para NÃO
 * operar, ANTES de qualquer setup ser aceito.
 *
 * Cada contradição possui id, severidade, descrição e evidência objetiva.
 * O módulo é determinístico: mesmas entradas, mesmas contradições. Alertas não
 * viram pontos nem notas agregadas; bloqueios impedem a configuração técnica.
 */

export type ContradictionSeverity = "bloqueia" | "alerta" | "informativa";

export interface Contradiction {
  id: string;
  severity: ContradictionSeverity;
  description: string;
  /** Evidência numérica objetiva que sustenta a contradição. */
  evidence: string;
  region: string;
  candleAt: number | null;
}

export interface ContradictionInput {
  direction: Direction;
  regime: Regime;
  f: Features;
  priceAction: PriceActionRead;
  capture: LiquidityCaptureResult;
  mainPoi: POI | null;
  plan: TradePlan | null;
  sms: SMSRead;
  targetLiquidityPrice: number | null;
  lastCandleAt: number | null;
}

export function buildContradictions(input: ContradictionInput): Contradiction[] {
  const out: Contradiction[] = [];
  const { direction, regime, f, priceAction, capture, mainPoi, plan, sms } = input;
  if (direction === "NEUTRO") return out;
  const dir = direction === "COMPRA" ? 1 : -1;
  const at = input.lastCandleAt;

  // 1. Operar contra o regime dominante — bloqueia.
  if (
    (direction === "COMPRA" && regime === "TREND_DOWN") ||
    (direction === "VENDA" && regime === "TREND_UP")
  ) {
    out.push({
      id: "contra-regime",
      severity: "bloqueia",
      description: `Setup de ${direction} contra regime ${regime}.`,
      evidence: `trend=${f.trend.toFixed(2)}`,
      region: "estrutura geral",
      candleAt: at,
    });
  }

  // 2. Captura de liquidez fraca (válida, mas de baixa qualidade) — alerta.
  if (capture.valid && capture.quality < 55) {
    out.push({
      id: "captura-fraca",
      severity: "alerta",
      description:
        "Captura de liquidez confirmada porém de baixa qualidade — possível sweep falso.",
      evidence: `captureQuality=${Math.round(capture.quality)}<55`,
      region: capture.detail.side === "compradora" ? "liquidez acima" : "liquidez abaixo",
      candleAt: capture.detail.at,
    });
  }

  // 3. Ausência de reação após o evento — alerta.
  const reactionOk =
    direction === "COMPRA"
      ? priceAction.imbalance >= 10 && priceAction.conviction >= 35
      : priceAction.imbalance <= -10 && priceAction.conviction >= 35;
  if (capture.valid && !reactionOk) {
    out.push({
      id: "sem-reacao",
      severity: "alerta",
      description: "Evento de liquidez sem reação de preço na direção do setup.",
      evidence: `imbalance=${priceAction.imbalance.toFixed(0)}, conviction=${priceAction.conviction.toFixed(0)}`,
      region: "candles recentes",
      candleAt: at,
    });
  }

  // 4. POI fraco ou distante — alerta.
  if (mainPoi && mainPoi.strength < 60) {
    out.push({
      id: "poi-fraco",
      severity: "alerta",
      description: `POI principal com força ${mainPoi.strength}/100 — reteste pouco confiável.`,
      evidence: `poiStrength=${mainPoi.strength}<60`,
      region: `${mainPoi.lower.toFixed(2)}–${mainPoi.upper.toFixed(2)}`,
      candleAt: mainPoi.originAt,
    });
  }

  // 5. Stop largo em ATR — alerta (perseguição de preço com risco esticado).
  if (plan && f.atr > 0 && plan.stopDistance / f.atr > 2) {
    out.push({
      id: "stop-largo",
      severity: "alerta",
      description: "Stop maior que 2 ATR — invalidação distante demais do gatilho.",
      evidence: `stopDistance=${plan.stopDistance.toFixed(2)} (${(plan.stopDistance / f.atr).toFixed(1)} ATR)`,
      region: "plano operacional",
      candleAt: at,
    });
  }

  // 6. Alvo curto: liquidez oposta antes da parcial — bloqueia.
  if (plan && input.targetLiquidityPrice !== null) {
    const beforePartial =
      dir > 0
        ? input.targetLiquidityPrice > plan.entry && input.targetLiquidityPrice < plan.target1
        : input.targetLiquidityPrice < plan.entry && input.targetLiquidityPrice > plan.target1;
    if (beforePartial) {
      out.push({
        id: "liquidez-antes-da-parcial",
        severity: "bloqueia",
        description: "Liquidez oposta relevante ANTES da parcial — espaço insuficiente.",
        evidence: `liquidez=${input.targetLiquidityPrice.toFixed(2)} entre entrada ${plan.entry.toFixed(2)} e parcial ${plan.target1.toFixed(2)}`,
        region: "caminho até o alvo",
        candleAt: at,
      });
    }
  }

  // 7. Estrutura interna contraditória: SMS confirmado na direção oposta — bloqueia.
  if (sms.confirmed && sms.direction !== "NEUTRO" && sms.direction !== direction) {
    out.push({
      id: "sms-contrario",
      severity: "bloqueia",
      description: `Mudança estrutural confirmada em ${sms.direction}, oposta ao setup de ${direction}.`,
      evidence: `smsDirection=${sms.direction}`,
      region: "estrutura interna",
      candleAt: at,
    });
  }

  // 8. Movimento esticado — informativa (o plano já bloqueia entrada direta).
  if (f.locationInTrend > 0.8) {
    out.push({
      id: "movimento-esticado",
      severity: "informativa",
      description: "Preço no fim do movimento — evitar perseguir; aguardar reteste.",
      evidence: `locationInTrend=${f.locationInTrend.toFixed(2)}>0.8`,
      region: "tendência vigente",
      candleAt: at,
    });
  }

  return out;
}
