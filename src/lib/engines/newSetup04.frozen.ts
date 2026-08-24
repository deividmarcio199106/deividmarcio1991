/**
 * NEW_SETUP_04 — ORDERED_PULLBACK_TREND: CONGELAMENTO E PORTÃO DE PROMOÇÃO.
 *
 * A T4 não aceita "tendência clara", "impulso válido" ou "corpos agressivos"
 * como adjetivo: cada um desses julgamentos precisa de um limiar NUMÉRICO,
 * congelado ANTES do teste fora da amostra, com a origem declarada. Sem isso o
 * limiar acaba sendo escolhido depois de ver o resultado — que é exatamente o
 * jeito de fabricar um backtest bonito e um prejuízo real.
 *
 * Este módulo faz duas coisas e só elas:
 *
 * 1. guarda os parâmetros do detector com a PROVENIÊNCIA de cada um. Quem veio
 *    do texto da técnica é "TECNICA_DECLARADA"; quem é número que ninguém
 *    derivou de DESCOBERTA é "SEM_ORIGEM_DECLARADA" — e fica escrito assim, com
 *    todas as letras, em vez de virar default silencioso;
 * 2. calcula o hash canônico do conjunto, para que qualquer alteração de valor
 *    (ou de proveniência) seja detectável por quem auditar depois.
 *
 * E impede uma terceira: `canPromoteNewSetup04` é o portão que impede a família
 * nova de virar sinal de produção por engano. Hoje ela responde NÃO, e lista os
 * motivos um a um. Isso é o esperado — a família nasce em LABORATÓRIO.
 */

import type { OrderedPullbackConfig } from "./orderedPullback";

/**
 * De onde veio o número.
 *
 * - TECNICA_DECLARADA: está escrito no texto da técnica do dono (3–5 candles
 *   armam, mais de 7 invalida, buffer de 1 tick no stop).
 * - SEM_ORIGEM_DECLARADA: número plausível que NINGUÉM derivou de descoberta
 *   sobre dado real ainda. Serve para o laboratório rodar; não serve para
 *   promover nada.
 */
export type ProvenienciaParametro = "TECNICA_DECLARADA" | "SEM_ORIGEM_DECLARADA";

export interface ParametroCongelado {
  valor: number;
  proveniencia: ProvenienciaParametro;
  /** Texto curto dizendo de onde o número veio — ou por que ele ainda não tem origem. */
  origem: string;
}

export const NEW_SETUP_04_ID = "NEW_SETUP_04";
export const NEW_SETUP_04_FAMILIA = "ORDERED_PULLBACK_TREND";

/**
 * Parâmetros congelados do detector.
 *
 * `as const` não é enfeite: ele trava os valores no tipo, de modo que trocar um
 * número em outro arquivo não passa despercebido pelo compilador — e o hash
 * abaixo pega a troca feita aqui mesmo.
 */
export const NEW_SETUP_04_FROZEN = {
  id: NEW_SETUP_04_ID,
  familia: NEW_SETUP_04_FAMILIA,
  versao: "0.1.0-LAB",
  congeladoEm: "2026-08-23",
  parametros: {
    minPullbackCandles: {
      valor: 3,
      proveniencia: "TECNICA_DECLARADA",
      origem: "Texto da técnica: a correção ordenada arma com 3 a 5 candles.",
    },
    maxPullbackCandles: {
      valor: 5,
      proveniencia: "TECNICA_DECLARADA",
      origem: "Texto da técnica: a correção ordenada arma com 3 a 5 candles.",
    },
    invalidationCandles: {
      valor: 7,
      proveniencia: "TECNICA_DECLARADA",
      origem:
        "Texto da técnica: acima de 7 candles a correção deixou de ser pullback e o setup está invalidado. 6 e 7 ficam no limbo declarado: não armam e não invalidam.",
    },
    stopBufferTicks: {
      valor: 1,
      proveniencia: "TECNICA_DECLARADA",
      origem: "Texto da técnica: stop 1 tick além do extremo do pullback.",
    },
    pivotLookback: {
      valor: 10,
      proveniencia: "SEM_ORIGEM_DECLARADA",
      origem:
        "Quantos candles antes do impulso definem o pivô estrutural. Ninguém mediu isto sobre dado real nesta sessão — número de laboratório.",
    },
    minTrendStrength: {
      valor: 0.4,
      proveniencia: "SEM_ORIGEM_DECLARADA",
      origem:
        "Ecoa o 0.4 que TREND_FIRST_PULLBACK já usa no roteador, mas aquele 0.4 também nunca foi derivado de descoberta. Copiar um número sem origem não cria origem.",
    },
    maxCorrectionBodyRatio: {
      valor: 0.6,
      proveniencia: "SEM_ORIGEM_DECLARADA",
      origem:
        "Teto para corpo médio da correção sobre corpo médio do impulso ('correção mais agressiva que o impulso'). Não foi derivado de fevereiro nem de nenhum OOS.",
    },
    neutralBodyRatio: {
      valor: 0.3,
      proveniencia: "SEM_ORIGEM_DECLARADA",
      origem:
        "Abaixo desta fração corpo/range o candle é tratado como neutro (indecisão conta como corretivo). Não foi derivado de dado real.",
    },
  },
} as const;

export type NomeParametroCongelado = keyof typeof NEW_SETUP_04_FROZEN.parametros;

/**
 * Config do detector montada A PARTIR do congelamento.
 *
 * O detector não carrega números próprios: se quiser saber por que ele decidiu
 * algo, a resposta está aqui, com proveniência. Isso é o que impede o limiar de
 * ser ajustado no detector "só para esse caso passar".
 */
export function orderedPullbackConfigCongelada(): OrderedPullbackConfig {
  const p = NEW_SETUP_04_FROZEN.parametros;
  return {
    minPullbackCandles: p.minPullbackCandles.valor,
    maxPullbackCandles: p.maxPullbackCandles.valor,
    invalidationCandles: p.invalidationCandles.valor,
    pivotLookback: p.pivotLookback.valor,
    minTrendStrength: p.minTrendStrength.valor,
    maxCorrectionBodyRatio: p.maxCorrectionBodyRatio.valor,
    neutralBodyRatio: p.neutralBodyRatio.valor,
    stopBufferTicks: p.stopBufferTicks.valor,
  };
}

/** Parâmetros que ainda não têm origem declarada — o bloqueio nº 1 da promoção. */
export function parametrosSemOrigem(): NomeParametroCongelado[] {
  return (Object.keys(NEW_SETUP_04_FROZEN.parametros) as NomeParametroCongelado[])
    .filter((nome) => NEW_SETUP_04_FROZEN.parametros[nome].proveniencia === "SEM_ORIGEM_DECLARADA")
    .sort();
}

// ---------------------------------------------------------------------------
// Hash canônico
// ---------------------------------------------------------------------------

/**
 * Serialização canônica: chaves ordenadas por código de caractere, sem espaços.
 *
 * `JSON.stringify` normal não serve porque a ordem das chaves depende da ordem
 * de escrita do objeto — reordenar duas linhas mudaria o hash sem mudar nenhum
 * valor, e o hash deixaria de significar "os parâmetros mudaram".
 */
export function jsonCanonico(valor: unknown): string {
  if (valor === null) return "null";
  if (typeof valor === "number") {
    if (!Number.isFinite(valor)) {
      throw new Error("Congelamento inválido: parâmetro NaN/Infinity não é auditável.");
    }
    return JSON.stringify(valor);
  }
  if (typeof valor === "string" || typeof valor === "boolean") return JSON.stringify(valor);
  if (Array.isArray(valor)) return `[${valor.map((item) => jsonCanonico(item)).join(",")}]`;
  if (typeof valor === "object") {
    const entradas = Object.entries(valor as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      // Comparação por código de caractere, não localeCompare: ordenação de
      // locale muda entre máquinas e mudaria o hash sem mudar o conteúdo.
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entradas.map(([k, v]) => `${JSON.stringify(k)}:${jsonCanonico(v)}`).join(",")}}`;
  }
  throw new Error("Congelamento inválido: tipo não serializável no bloco de parâmetros.");
}

const K_SHA256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** UTF-8 sem depender de TextEncoder: este módulo roda no navegador e no node. */
function bytesUtf8(texto: string): number[] {
  const saida: number[] = [];
  for (let i = 0; i < texto.length; i++) {
    const ponto = texto.codePointAt(i)!;
    if (ponto > 0xffff) i++;
    if (ponto < 0x80) saida.push(ponto);
    else if (ponto < 0x800) saida.push(0xc0 | (ponto >> 6), 0x80 | (ponto & 63));
    else if (ponto < 0x10000)
      saida.push(0xe0 | (ponto >> 12), 0x80 | ((ponto >> 6) & 63), 0x80 | (ponto & 63));
    else
      saida.push(
        0xf0 | (ponto >> 18),
        0x80 | ((ponto >> 12) & 63),
        0x80 | ((ponto >> 6) & 63),
        0x80 | (ponto & 63),
      );
  }
  return saida;
}

function girar(valor: number, bits: number): number {
  return ((valor >>> bits) | (valor << (32 - bits))) >>> 0;
}

/**
 * SHA-256 em TypeScript puro.
 *
 * Não usa `node:crypto` de propósito: este arquivo é importado pela cadeia de
 * análise que também roda no navegador, e uma importação de módulo de node
 * quebraria o bundle. Função pura, sem estado, sem I/O.
 */
export function sha256Hex(texto: string): string {
  const bytes = bytesUtf8(texto);
  const bits = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const alto = Math.floor(bits / 0x100000000);
  const baixo = bits >>> 0;
  bytes.push((alto >>> 24) & 255, (alto >>> 16) & 255, (alto >>> 8) & 255, alto & 255);
  bytes.push((baixo >>> 24) & 255, (baixo >>> 16) & 255, (baixo >>> 8) & 255, baixo & 255);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Array<number>(64);
  for (let bloco = 0; bloco < bytes.length; bloco += 64) {
    for (let i = 0; i < 16; i++) {
      const j = bloco + i * 4;
      w[i] =
        ((bytes[j]! << 24) | (bytes[j + 1]! << 16) | (bytes[j + 2]! << 8) | bytes[j + 3]!) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = (girar(w[i - 15]!, 7) ^ girar(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)) >>> 0;
      const s1 = (girar(w[i - 2]!, 17) ^ girar(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)) >>> 0;
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = (girar(e, 6) ^ girar(e, 11) ^ girar(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + S1 + ch + K_SHA256[i]! + w[i]!) >>> 0;
      const S0 = (girar(a, 2) ^ girar(a, 13) ^ girar(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((parte) => parte.toString(16).padStart(8, "0"))
    .join("");
}

/**
 * Hash do congelamento.
 *
 * Entra o bloco INTEIRO (id, família, versão, data e todos os parâmetros com
 * valor + proveniência + origem). Proveniência entra de propósito: mudar um
 * "SEM_ORIGEM_DECLARADA" para "TECNICA_DECLARADA" sem mudar o número é uma
 * alteração material — é ela que libera o portão — e precisa aparecer no hash.
 */
export function hashCongelamento(bloco: unknown = NEW_SETUP_04_FROZEN): string {
  return sha256Hex(jsonCanonico(bloco));
}

/** Hash do congelamento vigente. Qualquer edição neste arquivo muda este valor. */
export const NEW_SETUP_04_FROZEN_HASH = hashCongelamento(NEW_SETUP_04_FROZEN);

// ---------------------------------------------------------------------------
// Portão de promoção
// ---------------------------------------------------------------------------

export interface RelatorioOosEvidencia {
  presente: boolean;
  periodo: string;
  trades: number;
}

export interface WalkForwardEvidencia {
  presente: boolean;
  janelas: number;
}

export interface AmostraEvidencia {
  /** Quantas operações a família de fato produziu na avaliação. */
  trades: number | null;
  /**
   * Amostra mínima DECLARADA para esta família. Sem alguém declarar (e dizer de
   * onde veio), não existe gate: número inventado aqui seria exatamente o
   * "default silencioso" que a técnica proíbe.
   */
  minimoDeclarado: number | null;
}

export interface NewSetup04PromotionEvidence {
  /** Hash observado no artefato de auditoria; precisa bater com o do código. */
  hashObservado?: string | null;
  relatorioOos?: RelatorioOosEvidencia | null;
  walkForward?: WalkForwardEvidencia | null;
  /** Ledger de leituras íntegro (encadeamento verificado), não "provavelmente ok". */
  ledgerIntegro?: boolean | null;
  amostra?: AmostraEvidencia | null;
}

export interface NewSetup04PromotionVerdict {
  promotable: boolean;
  reasons: string[];
}

/**
 * PORTÃO DE PROMOÇÃO — é isto que impede NEW_SETUP_04 de virar sinal ao vivo.
 *
 * A regra do dono: família nova nasce em LABORATÓRIO e só sai de lá com prova.
 * A função não tem "modo permissivo": ausência de evidência é motivo de recusa,
 * nunca de aprovação. Chamada sem argumento — que é como o roteador a chama
 * hoje, porque nenhuma dessas provas existe — ela devolve `false` e lista tudo
 * que falta.
 */
export function canPromoteNewSetup04(
  evidence: NewSetup04PromotionEvidence = {},
): NewSetup04PromotionVerdict {
  const reasons: string[] = [];

  const hashAtual = hashCongelamento(NEW_SETUP_04_FROZEN);
  if (hashAtual !== NEW_SETUP_04_FROZEN_HASH) {
    reasons.push(
      `Hash do congelamento não confere com o do módulo (${hashAtual} != ${NEW_SETUP_04_FROZEN_HASH}).`,
    );
  }
  if (!evidence.hashObservado) {
    reasons.push(
      "Hash do congelamento não foi conferido contra o artefato de auditoria (nenhum hash observado foi informado).",
    );
  } else if (evidence.hashObservado !== hashAtual) {
    reasons.push(
      `Congelamento divergente: artefato traz ${evidence.hashObservado}, código calcula ${hashAtual}.`,
    );
  }

  const semOrigem = parametrosSemOrigem();
  if (semOrigem.length > 0) {
    reasons.push(
      `Parâmetros sem origem declarada (${semOrigem.join(", ")}): número que ninguém derivou não pode virar gate de produção.`,
    );
  }

  if (!evidence.relatorioOos?.presente) {
    reasons.push("Relatório fora da amostra (OOS) ausente.");
  }

  if (!evidence.walkForward?.presente) {
    reasons.push("Walk-forward ausente.");
  } else if (evidence.walkForward.janelas < 2) {
    reasons.push(
      `Walk-forward com ${evidence.walkForward.janelas} janela(s): uma janela só não é walk-forward.`,
    );
  }

  if (evidence.ledgerIntegro !== true) {
    reasons.push("Integridade do ledger de leituras não verificada.");
  }

  const amostra = evidence.amostra ?? null;
  if (amostra === null || amostra.minimoDeclarado === null) {
    reasons.push(
      "Amostra mínima não declarada: sem alguém declarar o número e a origem dele, não há gate de amostra.",
    );
  } else if (amostra.trades === null) {
    reasons.push("Amostra observada desconhecida — nada foi contado.");
  } else if (amostra.trades < amostra.minimoDeclarado) {
    reasons.push(
      `Amostra de ${amostra.trades} operações abaixo do mínimo declarado (${amostra.minimoDeclarado}).`,
    );
  }

  return { promotable: reasons.length === 0, reasons };
}
