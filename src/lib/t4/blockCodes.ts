/**
 * CÓDIGOS DE BLOQUEIO — o fim do `return null` mudo.
 *
 * O QUE ESTAVA ERRADO: caminhos que recusavam uma operação devolviam `null` e
 * a informação de POR QUÊ morria ali. Na tela isso virava "aguardando" — o
 * operador não distingue "aguardando candle fechar" de "recusado por R:R" de
 * "travado por horário", e os três pedem ações diferentes dele.
 *
 * A REGRA: recusa devolve `{ allowed: false, code, reason }`. O `code` é
 * estável e enumerado aqui (é o que log, UI e teste comparam); o `reason` é a
 * frase humana com os números do caso. Nenhum módulo inventa código próprio —
 * um código novo entra NESTE arquivo ou não existe.
 *
 * Bloqueio NÃO é erro: é o sistema dizendo não com motivo. Nenhum destes
 * códigos lança exceção, e nenhum deles para a captura.
 */

export type BlockCode =
  // Risco
  | "RR_LT_3"
  | "STOP_TOO_SMALL"
  | "STOP_TOO_LARGE"
  | "TARGET_5R_NO_ROOM"
  // E2 / pullback ordenado (NEW_SETUP_04)
  | "E2_OPEN_OR_UNKNOWN"
  | "E2_NOT_CONFIRMED"
  | "PULLBACK_LENGTH"
  | "TREND_WEAK"
  | "IMPULSE_INVALID"
  | "CORRECTION_AGGRESSIVE"
  | "PIVOT_BROKEN"
  // Execução T4.2 (motor de fill)
  | "EXPIRED_NO_FILL"
  | "NO_RETEST"
  // Dado / contexto
  | "PRICE_UNRELIABLE"
  | "AUDITOR"
  | "CONFIDENCE"
  | "AI_INCONCLUSIVE"
  | "CLOCK";

export interface Block {
  allowed: false;
  code: BlockCode;
  /** A frase com os números do caso. Nunca vazia. */
  reason: string;
}

export interface Allowed<T> {
  allowed: true;
  value: T;
}

/** Resultado de qualquer decisão que pode recusar: valor OU bloqueio nomeado. */
export type Decision<T> = Allowed<T> | Block;

export function allow<T>(value: T): Allowed<T> {
  return { allowed: true, value };
}

export function block(code: BlockCode, reason: string): Block {
  if (reason.trim().length === 0) {
    // Um bloqueio sem motivo é exatamente o `null` mudo com outra roupa.
    throw new Error(`Bloqueio ${code} sem motivo declarado.`);
  }
  return { allowed: false, code, reason };
}
