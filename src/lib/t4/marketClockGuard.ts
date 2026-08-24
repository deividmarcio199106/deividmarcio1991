/**
 * RELÓGIO INSTITUCIONAL DA B3 — a hora também é um gate.
 *
 * O motor tratava 09:02 e 11:02 como o mesmo mercado. Não são. Existem faixas do
 * pregão em que o preço se move por motivo estrutural alheio à técnica, e operar
 * dentro delas não é assumir o risco da T4 — é assumir outro risco, sem medi-lo.
 *
 * AS QUATRO FAIXAS, e o que cada uma protege:
 *
 *   09:00–09:20  ABERTURA. O gap ainda está sendo digerido e a estrutura do dia
 *                não existe. Bloqueia ENTRADA NOVA. Não encerra nada.
 *   09:55–10:15  CHOQUE DO À VISTA. Vale e Petrobras abrem e arrastam o índice
 *                por fluxo de cesta. Bloqueia entrada nova E força proteção no
 *                break-even em quem já está posicionado — a posição não é
 *                encerrada, mas para de arriscar capital contra um evento que a
 *                técnica não lê.
 *   10:30–10:45  ABERTURA DE NY. Janela de alta liquidez. NÃO é um bloqueio: é
 *                uma marcação, e está aqui para que "liberado" tenha motivo.
 *   16:30→       FECHAMENTO. Bloqueia entrada nova e ENCERRA posição aberta. O
 *                encerramento compulsório vai até 17:30; depois disso não há
 *                mais o que encerrar dentro do pregão regular.
 *
 * DE ONDE VEM A HORA. Do relógio DO GRÁFICO (`@/lib/vision/marketClock`), nunca
 * de `Date.now()`. Este módulo recebe minutos e é puro de propósito: no replay
 * de vídeo o relógio de parede é o de hoje, e usá-lo faria a trava das 16:30
 * disparar no meio de um pregão de março.
 */

import type { BlockCode } from "./blockCodes";

export type ClockVerdict = "LIBERADO" | "BLOQUEIO_NOVAS" | "BLOQUEIO_TOTAL";

export type ClockWindow =
  | "PRE_ABERTURA"
  | "ABERTURA"
  | "PREGAO"
  | "CHOQUE_A_VISTA"
  | "ALTA_LIQUIDEZ"
  | "FECHAMENTO"
  | "POS_PREGAO";

export interface ClockGuard {
  verdict: ClockVerdict;
  window: ClockWindow;
  /** Pode ARMAR e confirmar uma entrada nova? */
  novasEntradas: boolean;
  /** Posição aberta deve ter o stop movido para o break-even protegido? */
  forcarBreakEven: boolean;
  /** Posição aberta deve ser encerrada a mercado? */
  encerrarPosicoes: boolean;
  /** CLOCK quando o horário veta entrada nova; null quando liberado. */
  blockCode: Extract<BlockCode, "CLOCK"> | null;
  detail: string;
}

const hhmm = (h: number, m: number) => h * 60 + m;

/** 09:00 — abertura do pregão regular do índice. */
export const ABERTURA_MIN = hhmm(9, 0);
/** 09:20 — fim da construção de estrutura pós-gap. */
export const FIM_ABERTURA_MIN = hhmm(9, 20);
/** 09:55–10:15 — abertura do mercado à vista. */
export const CHOQUE_INICIO_MIN = hhmm(9, 55);
export const CHOQUE_FIM_MIN = hhmm(10, 15);
/** 10:30–10:45 — abertura de NY. */
export const NY_INICIO_MIN = hhmm(10, 30);
export const NY_FIM_MIN = hhmm(10, 45);
/** 16:30 — corte de novas operações. */
export const CORTE_NOVAS_MIN = hhmm(16, 30);
/** 17:30 — limite do encerramento compulsório. */
export const ENCERRAMENTO_LIMITE_MIN = hhmm(17, 30);

/**
 * Converte "HH:MM" do gráfico em minutos desde a meia-noite.
 *
 * Devolve `null` em qualquer coisa que não seja uma hora legível. Null aqui é
 * informação: significa "não sei que horas são", e quem não sabe a hora não pode
 * afirmar que a janela está liberada.
 */
export function minutosDoRelogio(texto: string | null | undefined): number | null {
  if (typeof texto !== "string") return null;
  const m = texto.trim().match(/^(\d{1,2})\s*:\s*(\d{2})/);
  if (m === null) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Veredito do relógio para um instante do pregão.
 *
 * `minuteOfDay` null = hora desconhecida. Nesse caso NADA é liberado: sem hora
 * não há como afirmar que não estamos às 16:45, e a trava mais cara de errar é a
 * do fechamento.
 */
export function marketClockGuard(
  minuteOfDay: number | null,
  /**
   * Janela da abertura de NY NO RELÓGIO DE SÃO PAULO. O default mantém os
   * valores históricos (10:30–10:45, corretos sob EDT), mas quem conhece a
   * DATA do pregão deve passar `janelaNyEmSp(dataIso)` (datasetEnforcement):
   * sob EST a abertura cai 11:30 em SP, e o valor fixo erra metade do ano
   * (auditoria sênior, B9 — NY vem do fuso America/New_York, nunca BRT fixo).
   */
  janelaNy: { inicio: number; fim: number } = { inicio: NY_INICIO_MIN, fim: NY_FIM_MIN },
): ClockGuard {
  if (minuteOfDay === null || !Number.isFinite(minuteOfDay)) {
    return {
      verdict: "BLOQUEIO_NOVAS",
      window: "PRE_ABERTURA",
      novasEntradas: false,
      blockCode: "CLOCK",
      forcarBreakEven: false,
      encerrarPosicoes: false,
      detail: "Hora do gráfico desconhecida — entrada nova bloqueada até o relógio ser lido.",
    };
  }

  if (minuteOfDay < ABERTURA_MIN) {
    return {
      verdict: "BLOQUEIO_NOVAS",
      window: "PRE_ABERTURA",
      novasEntradas: false,
      blockCode: "CLOCK",
      forcarBreakEven: false,
      encerrarPosicoes: false,
      detail: "Antes da abertura do pregão regular (09:00).",
    };
  }

  if (minuteOfDay >= CORTE_NOVAS_MIN) {
    const dentroDoLimite = minuteOfDay <= ENCERRAMENTO_LIMITE_MIN;
    return {
      verdict: "BLOQUEIO_TOTAL",
      window: dentroDoLimite ? "FECHAMENTO" : "POS_PREGAO",
      novasEntradas: false,
      blockCode: "CLOCK",
      forcarBreakEven: false,
      encerrarPosicoes: dentroDoLimite,
      detail: dentroDoLimite
        ? "16:30 em diante: nenhuma operação nova e encerramento compulsório até 17:30."
        : "Após 17:30 — fora da janela operacional.",
    };
  }

  if (minuteOfDay < FIM_ABERTURA_MIN) {
    return {
      verdict: "BLOQUEIO_NOVAS",
      window: "ABERTURA",
      novasEntradas: false,
      blockCode: "CLOCK",
      forcarBreakEven: false,
      encerrarPosicoes: false,
      detail: "09:00–09:20: estrutura do dia em construção pós-gap — sem entrada nova.",
    };
  }

  if (minuteOfDay >= CHOQUE_INICIO_MIN && minuteOfDay < CHOQUE_FIM_MIN) {
    return {
      verdict: "BLOQUEIO_NOVAS",
      window: "CHOQUE_A_VISTA",
      novasEntradas: false,
      blockCode: "CLOCK",
      // Não encerra: protege. A posição continua viva, sem arriscar capital.
      forcarBreakEven: true,
      encerrarPosicoes: false,
      detail:
        "09:55–10:15: abertura do à vista (Vale/Petrobras). Sem T4 nova; posição aberta vai para break-even.",
    };
  }

  if (minuteOfDay >= janelaNy.inicio && minuteOfDay < janelaNy.fim) {
    const hhmmDe = (min: number) =>
      `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
    return {
      verdict: "LIBERADO",
      window: "ALTA_LIQUIDEZ",
      novasEntradas: true,
      blockCode: null,
      forcarBreakEven: false,
      encerrarPosicoes: false,
      detail: `${hhmmDe(janelaNy.inicio)}–${hhmmDe(janelaNy.fim)}: abertura de NY, janela de alta liquidez.`,
    };
  }

  return {
    verdict: "LIBERADO",
    window: "PREGAO",
    novasEntradas: true,
    blockCode: null,
    forcarBreakEven: false,
    encerrarPosicoes: false,
    detail: "Pregão regular — sem restrição de horário.",
  };
}
