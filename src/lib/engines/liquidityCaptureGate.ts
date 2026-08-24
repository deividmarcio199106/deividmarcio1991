import type { Features } from "./marketFeatures";
import type {
  HSSRead,
  LiquidityCaptureDetail,
  LiquidityCaptureResult,
  LiquidityMap,
} from "./types";

const NO_CAPTURE: LiquidityCaptureDetail = {
  levelId: null,
  type: null,
  price: null,
  side: null,
  at: null,
  strength: 0,
  sweepDepth: null,
  rejection: 0,
  recovery: false,
  displacement: 0,
  closeConfirmed: false,
  status: "sem_captura",
};

/**
 * GATE OBRIGATÓRIO DE CAPTURA DE LIQUIDEZ.
 *
 * Adapter puro sobre liquidityEngine/hssEngine já existentes — nenhuma nova
 * matemática de detecção aqui. `hssEngine.analyzeHSS()` já implementa
 * varredura -> rejeição -> deslocamento -> confirmação estrutural, então
 * "captura válida" = HSS detectado, não invalidado e com confirmação
 * estrutural. Pavio isolado nunca chega a `structuralConfirmation` (exige
 * candles subsequentes sustentando e fechando além do nível — ver
 * hssEngine.ts), então já é rejeitado sem lógica extra.
 *
 * Nenhuma das 4 técnicas pode confirmar (status "confirmada") sem
 * `valid === true` na MESMA direção — ver techniqueTypes.deriveTechniqueStatus.
 */
export function buildCaptureResult(
  liquidity: LiquidityMap,
  hss: HSSRead,
  f: Features,
): LiquidityCaptureResult {
  const level = hss.sweptLevelId
    ? (liquidity.levels.find((l) => l.id === hss.sweptLevelId) ?? null)
    : null;
  const levelEvents = level ? liquidity.events.filter((e) => e.levelId === level.id) : [];
  const lastEventForLevel = levelEvents.sort((a, b) => b.t - a.t)[0] ?? null;

  const status: LiquidityCaptureDetail["status"] = !level
    ? "sem_captura"
    : hss.stage === "invalidado"
      ? "invalidada"
      : hss.detected
        ? "capturada_valida"
        : "em_formacao";

  const detail: LiquidityCaptureDetail = level
    ? {
        levelId: level.id,
        type: status === "invalidada" ? "invalidacao" : (lastEventForLevel?.type ?? null),
        price: level.price,
        side: level.kind,
        at: lastEventForLevel?.t ?? null,
        strength: hss.confidence,
        sweepDepth:
          hss.sweepExtreme !== null
            ? Math.abs(hss.sweepExtreme - level.price) / Math.max(f.atr, 1e-9)
            : null,
        rejection: hss.rejection,
        recovery: hss.structuralConfirmation,
        displacement: hss.displacement,
        closeConfirmed: hss.structuralConfirmation,
        status,
      }
    : { ...NO_CAPTURE };

  // Rompimento aceito nunca é classificado como captura: hssEngine só marca
  // `detected` após varredura + rejeição + deslocamento (nunca a partir de um
  // nível que só rompeu com aceitação). Então "aceito, sem HSS" é sempre e só isso.
  const nearestRelevant = [liquidity.nearestBuy, liquidity.nearestSell].find(
    (l) => l && l.status === "rompida_com_aceitacao",
  );
  const isAcceptedBreakoutOnly = !hss.detected && !!nearestRelevant;

  const valid = hss.detected && hss.stage !== "invalidado" && hss.structuralConfirmation;

  const quality = valid
    ? Math.round(
        Math.max(
          0,
          Math.min(100, hss.rejection * 0.3 + hss.displacement * 0.3 + hss.confidence * 0.4),
        ),
      )
    : 0;

  return {
    valid,
    direction: level ? hss.direction : null,
    detail,
    quality,
    isAcceptedBreakoutOnly,
  };
}
