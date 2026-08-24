/**
 * yPercent (spec V5 §12–13) — a ponte entre a resposta visual da IA e o pixel real.
 *
 * REGRAS:
 * - yPercent = ((pixelY - cropTop) / cropHeight) * 100, com cropHeight > 0;
 * - só é válido em [0, 100]; fora disso a label é FISICAMENTE impossível no
 *   recorte e deve ser rejeitada com motivo — nunca mascarada com clamp;
 * - yPercent NUNCA vira preço diretamente: yPercent → pixelY real → calibração.
 */

export interface YPercentResult {
  value: number | null;
  valid: boolean;
  reason: string;
}

/** Converte pixel absoluto em yPercent do recorte. Rejeita entradas impossíveis. */
export function normalizeYPercent(
  pixelY: number,
  cropTop: number,
  cropHeight: number,
): YPercentResult {
  if (!Number.isFinite(pixelY) || !Number.isFinite(cropTop) || !Number.isFinite(cropHeight)) {
    return { value: null, valid: false, reason: "Entrada não numérica (NaN/Infinity/undefined)." };
  }
  if (cropHeight <= 0) {
    return {
      value: null,
      valid: false,
      reason: `cropHeight inválido (${cropHeight}); deve ser > 0.`,
    };
  }
  const value = ((pixelY - cropTop) / cropHeight) * 100;
  const check = validateYPercent(value);
  return { value: check.valid ? value : null, valid: check.valid, reason: check.reason };
}

/** Valida um yPercent já calculado (ex.: vindo da resposta da IA). */
export function validateYPercent(value: unknown): { valid: boolean; reason: string } {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { valid: false, reason: "yPercent não numérico (NaN/Infinity/undefined)." };
  }
  if (value < 0) {
    return {
      valid: false,
      reason: `yPercent ${value} < 0: label acima do recorte — fisicamente fora da região útil.`,
    };
  }
  if (value > 100) {
    return {
      valid: false,
      reason: `yPercent ${value} > 100: label abaixo do recorte — fisicamente fora da região útil.`,
    };
  }
  return { valid: true, reason: "" };
}

/** yPercent → pixel real do frame. Único caminho permitido até o preço (via calibração). */
export function yPercentToPixel(yPercent: number, frameHeight: number): number | null {
  const check = validateYPercent(yPercent);
  if (!check.valid || !Number.isFinite(frameHeight) || frameHeight <= 0) return null;
  return (yPercent / 100) * frameHeight;
}
