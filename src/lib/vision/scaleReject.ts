/**
 * POR QUE A ESCALA NÃO CALIBROU — um código, nunca "CALIBRANDO" sem motivo.
 *
 * O DEFEITO QUE ISSO ENCERRA: o painel ficava em CALIBRANDO com "3 tentativas,
 * 0/2 âncoras" e mais nada. Três tentativas fracassadas podem significar coisas
 * completamente diferentes — GPU fora do ar, ROI na região errada, rótulos
 * ilegíveis, resposta chegando velha demais — e cada uma pede uma ação diferente
 * do operador. Um estado que não diz qual delas é não é diagnóstico, é espera.
 *
 * Cada código abaixo aponta para UM conserto:
 *
 *   GPU_OFFLINE          → o túnel/Ollama caiu: nada de OCR até voltar
 *   TIMEOUT              → modelo respondendo devagar demais para servir
 *   ROI_INVALID          → o recorte enviado não é a faixa da escala
 *   OCR_EMPTY            → o modelo respondeu, mas sem JSON aproveitável
 *   NO_LABELS            → respondeu JSON, nenhum rótulo dentro
 *   INVALID_PERCENT      → percentY fora de [0,100]: régua não foi respeitada
 *   INSUFFICIENT_ANCHORS → rótulos de menos (ou colados) para uma reta
 *   NON_MONOTONIC        → preço não cai de cima para baixo: não é escala
 *   BAD_LINEARITY        → R² abaixo do mínimo: log, ou dígito trocado
 *   BAD_TICK             → incremento incompatível com o contrato
 *   STALE_RESPONSE       → chegou depois de a geometria mudar
 *
 * REGRA QUE ESTE ARQUIVO PROTEGE: percentY fora de [0,100] é REJEIÇÃO, nunca
 * clamp. O Y cru do Qwen apresentou distorção sistemática de ~13%; um clamp
 * transformaria essa distorção em âncora plausível e a escala inteira sairia
 * torta com aparência de calibrada.
 */

import type { Calibration } from "./priceScale";

export type ScaleRejectCode =
  | "OCR_EMPTY"
  | "NO_LABELS"
  | "INVALID_PERCENT"
  | "INSUFFICIENT_ANCHORS"
  | "NON_MONOTONIC"
  | "BAD_LINEARITY"
  | "BAD_TICK"
  | "STALE_RESPONSE"
  | "TIMEOUT"
  | "ROI_INVALID"
  | "GPU_OFFLINE";

export interface ScaleReject {
  code: ScaleRejectCode;
  /** Frase específica desta ocorrência — números reais, não o texto genérico. */
  detail: string;
}

/** O que o operador deve fazer, por código. */
export const SCALE_REJECT_LABEL: Record<ScaleRejectCode, string> = {
  OCR_EMPTY: "OCR não devolveu leitura utilizável",
  NO_LABELS: "nenhum rótulo de preço na resposta",
  INVALID_PERCENT: "percentY fora da régua (0–100)",
  INSUFFICIENT_ANCHORS: "âncoras insuficientes para uma reta",
  NON_MONOTONIC: "preços não decrescem de cima para baixo",
  BAD_LINEARITY: "ajuste linear reprovado (R² baixo)",
  BAD_TICK: "incremento incompatível com o contrato",
  STALE_RESPONSE: "resposta chegou após a geometria mudar",
  TIMEOUT: "o modelo não respondeu a tempo",
  ROI_INVALID: "recorte da escala inválido",
  GPU_OFFLINE: "serviço de visão indisponível",
};

export function scaleReject(code: ScaleRejectCode, detail?: string): ScaleReject {
  return { code, detail: detail?.trim() || SCALE_REJECT_LABEL[code] };
}

/** `INSUFFICIENT_ANCHORS · só 1 rótulo legível` — o formato que o painel mostra. */
export function describeReject(reject: ScaleReject | null): string {
  if (reject === null) return "—";
  return `${reject.code} · ${reject.detail}`;
}

/**
 * Erro lançado durante a chamada ao modelo.
 *
 * Só duas famílias importam aqui, e a distinção é operacional: TIMEOUT significa
 * serviço vivo e lento (esperar/ajustar cadência); GPU_OFFLINE significa serviço
 * ausente (consertar túnel/Ollama). Tratar as duas como "erro" mandaria o
 * operador procurar no lugar errado.
 */
export function classifyThrown(error: unknown): ScaleReject {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return scaleReject("TIMEOUT", "o modelo não respondeu dentro do limite");
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out|abort/i.test(message)) {
    return scaleReject("TIMEOUT", message);
  }
  if (
    /ECONNREFUSED|ENOTFOUND|fetch failed|circuito|circuit|socket hang up|503|502/i.test(message)
  ) {
    return scaleReject("GPU_OFFLINE", message);
  }
  if (/\b404\b/.test(message)) {
    return scaleReject("GPU_OFFLINE", `modelo não encontrado no provedor: ${message}`);
  }
  return scaleReject("GPU_OFFLINE", message);
}

/**
 * Traduz o veredito da regressão em código.
 *
 * `calibrateFromAnchors` já distingue os casos; o que faltava era um código
 * estável para o painel, porque a frase em português muda com a redação e a UI
 * não pode depender dela.
 */
export function classifyCalibration(calibration: Calibration): ScaleReject | null {
  if (calibration.usable) return null;
  switch (calibration.status) {
    case "ancoras_insuficientes":
      return scaleReject("INSUFFICIENT_ANCHORS", calibration.reason);
    case "escala_nao_linear":
      return scaleReject("BAD_LINEARITY", calibration.reason);
    case "confianca_baixa":
      // Confiança baixa com reta boa é falta de sustentação, não curvatura.
      return scaleReject("INSUFFICIENT_ANCHORS", calibration.reason);
    case "geometrica":
    case "ausente":
      return scaleReject("OCR_EMPTY", calibration.reason);
    default:
      return scaleReject("OCR_EMPTY", calibration.reason);
  }
}

/**
 * Diagnóstico dos rótulos ANTES da regressão.
 *
 * A regressão só enxerga o que sobrou; quando ela reclama de "âncoras
 * insuficientes", a causa real pode ter sido percentY inválido em todos os
 * rótulos — e essa é uma falha de PROMPT/régua, não de leitura. Separar as duas
 * é o que impede meia hora procurando o problema no lugar errado.
 */
export interface LabelAudit {
  received: number;
  /** Descartados por percentY fora de [0,100]. Nunca corrigidos por clamp. */
  invalidPercent: number;
  /** Descartados por confiança abaixo do mínimo. */
  lowConfidence: number;
  /** Sobraram, mas não formam cadeia decrescente de preço. */
  nonMonotonic: number;
  kept: number;
}

export const EMPTY_AUDIT: LabelAudit = {
  received: 0,
  invalidPercent: 0,
  lowConfidence: 0,
  nonMonotonic: 0,
  kept: 0,
};

/**
 * Escolhe o código que explica a perda dos rótulos.
 *
 * Ordem deliberada: começa pelo que aconteceu ANTES na cadeia. Anunciar
 * NON_MONOTONIC quando todos os percentY vieram inválidos culparia o gráfico por
 * um erro da leitura.
 */
export function classifyAudit(audit: LabelAudit): ScaleReject | null {
  if (audit.kept >= 2) return null;
  if (audit.received === 0) {
    return scaleReject("NO_LABELS", "o modelo respondeu sem nenhum rótulo de preço");
  }
  if (audit.invalidPercent > 0 && audit.invalidPercent >= audit.received - audit.lowConfidence) {
    return scaleReject(
      "INVALID_PERCENT",
      `${audit.invalidPercent}/${audit.received} rótulos com percentY fora de 0–100 — régua não respeitada`,
    );
  }
  if (audit.nonMonotonic > 0) {
    return scaleReject(
      "NON_MONOTONIC",
      `${audit.nonMonotonic} rótulo(s) quebram a queda de preço de cima para baixo`,
    );
  }
  return scaleReject(
    "INSUFFICIENT_ANCHORS",
    `${audit.kept}/${audit.received} rótulos aproveitáveis — mínimo 2 bem separados`,
  );
}
