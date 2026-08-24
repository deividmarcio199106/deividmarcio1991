/**
 * ENFORCEMENT DE DATASET (auditoria sênior, BLOCO 9).
 *
 * O plano cronológico da T4.2 vivia em PROSA (rules_json, GPT_MEMORIA §8) e
 * nenhuma linha de código o aplicava: nada impedia abrir julho (OOS FINAL
 * SELADO) antes do congelamento verificado, `datasetSeen` era escrito e nunca
 * lido, e o papel de cada mês era um acordo verbal. Este módulo transforma o
 * plano em GATE:
 *
 *   - cada data tem um PAPEL derivado do mês (mapa explícito, não inferência);
 *   - fim de semana e feriado B3 NÃO são pregão — data assim é leitura errada
 *     (OCR trocando dígito) ou material errado, e as duas coisas bloqueiam;
 *   - JULHO/OOS só abre com o congelamento VERIFICADO (hash recalculado ok);
 *   - os meses de `datasetSeen` (lidos do REGISTRO da candidata, não
 *     redigitados) são CONTAMINADOS: servem de referência, nunca de validação.
 *
 * A janela de NY sai do FUSO REAL (America/New_York → America/Sao_Paulo),
 * nunca de um horário BRT fixo: o Brasil aboliu o horário de verão em 2019 e
 * os EUA não — a abertura de NY cai 10:30 em São Paulo no verão deles (EDT) e
 * 11:30 no inverno (EST). O 10:30 fixo estava certo metade do ano.
 */

import { block, type Decision } from "./blockCodes";

/* ------------------------------------------------------------------------ *
 * CALENDÁRIO B3 — pregões reais do período do estudo
 * ------------------------------------------------------------------------ */

/**
 * Feriados B3 de 2026 no período fevereiro–julho (bolsa FECHADA).
 * Derivados do calendário nacional: Carnaval 16–17/02, Sexta-feira Santa
 * 03/04 (Páscoa 05/04), Tiradentes 21/04, Dia do Trabalho 01/05, Corpus
 * Christi 04/06. Formato ISO yyyy-mm-dd.
 */
export const FERIADOS_B3_2026: ReadonlyMap<string, string> = new Map([
  ["2026-01-01", "Confraternização Universal"],
  ["2026-02-16", "Carnaval"],
  ["2026-02-17", "Carnaval"],
  ["2026-04-03", "Sexta-feira Santa"],
  ["2026-04-21", "Tiradentes"],
  ["2026-05-01", "Dia do Trabalho"],
  ["2026-06-04", "Corpus Christi"],
  ["2026-07-09", "feriado estadual SP observado no calendário local"],
]);

export type PapelDoDataset =
  "REFERENCIA_CONTAMINADA" | "VALIDATION" | "WALK_FORWARD" | "OOS_FINAL_SELADO" | "ROBUSTNESS";

/**
 * O papel de cada mês do estudo — o §8 do comando, em código. Mês fora do
 * mapa não tem papel declarado e NÃO processa: silêncio não é permissão.
 */
export const PAPEL_POR_MES: ReadonlyMap<string, PapelDoDataset> = new Map([
  ["2026-02", "ROBUSTNESS"],
  ["2026-03", "REFERENCIA_CONTAMINADA"],
  ["2026-04", "VALIDATION"],
  ["2026-05", "WALK_FORWARD"],
  ["2026-06", "WALK_FORWARD"],
  ["2026-07", "OOS_FINAL_SELADO"],
]);

/** Aceita dd/mm/yyyy (OCR do gráfico) e yyyy-mm-dd; devolve ISO ou null. */
export function normalizarData(texto: string | null | undefined): string | null {
  if (!texto) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto.trim());
  if (iso) return texto.trim();
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(texto.trim());
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return null;
}

export interface AutorizacaoDeDataset {
  dataIso: string;
  papel: PapelDoDataset;
}

export interface CongelamentoParaOGate {
  ok: boolean;
  motivo: string | null;
}

/**
 * O GATE: uma data de pregão só abre com papel declarado, dia útil de bolsa,
 * mês não contaminado (a menos do uso declarado como referência) e — para o
 * OOS FINAL — congelamento VERIFICADO.
 *
 * `datasetSeen` chega de fora DE PROPÓSITO: o chamador o lê do REGISTRO da
 * candidata congelada (rules_json), nunca de uma constante local. É isso que
 * torna a contaminação um fato do banco, não uma opinião do código.
 */
export function autorizarDataset(input: {
  data: string | null | undefined;
  congelamento: CongelamentoParaOGate;
  /** Meses já vistos pela candidata, como gravados no freeze (ex.: ["MARCO"]). */
  datasetSeen: readonly string[];
  /** true = o chamador declara uso como REFERÊNCIA (março permitido, sem validação). */
  usoComoReferencia?: boolean;
}): Decision<AutorizacaoDeDataset> {
  const dataIso = normalizarData(input.data);
  if (dataIso === null) {
    return block(
      "PRICE_UNRELIABLE",
      `Data do pregão ilegível ou fora do formato (${String(input.data)}) — sem data não há papel de dataset.`,
    );
  }

  const feriado = FERIADOS_B3_2026.get(dataIso);
  if (feriado !== undefined) {
    return block(
      "PRICE_UNRELIABLE",
      `${dataIso} é feriado B3 (${feriado}) — não existe pregão nesta data; a leitura da data está errada ou o material não é de mercado.`,
    );
  }
  // Meio-dia UTC evita o dia anterior em qualquer fuso.
  const diaDaSemana = new Date(`${dataIso}T12:00:00Z`).getUTCDay();
  if (diaDaSemana === 0 || diaDaSemana === 6) {
    return block(
      "PRICE_UNRELIABLE",
      `${dataIso} cai num ${diaDaSemana === 0 ? "domingo" : "sábado"} — não existe pregão; a data lida está errada.`,
    );
  }

  const mes = dataIso.slice(0, 7);
  const papel = PAPEL_POR_MES.get(mes);
  if (papel === undefined) {
    return block(
      "AUDITOR",
      `Mês ${mes} não tem papel declarado no plano cronológico — abrir dado sem papel é validação por acidente.`,
    );
  }

  // datasetSeen LIDO de verdade: mês visto no desenho da técnica é
  // contaminado e só abre com uso declarado como referência.
  const marcadoComoVisto =
    papel === "REFERENCIA_CONTAMINADA" ||
    input.datasetSeen.some((visto) => mesDoRotulo(visto) === mes);
  if (marcadoComoVisto && input.usoComoReferencia !== true) {
    return block(
      "AUDITOR",
      `Mês ${mes} está em datasetSeen (contaminado no desenho da técnica) — só abre com usoComoReferencia:true, e nunca conta como validação.`,
    );
  }

  if (papel === "OOS_FINAL_SELADO" && !input.congelamento.ok) {
    return block(
      "AUDITOR",
      `OOS FINAL SELADO (${mes}) não abre sem congelamento VERIFICADO: ${input.congelamento.motivo ?? "veredito ausente"}.`,
    );
  }

  return { allowed: true, value: { dataIso, papel } };
}

/** Traduz o rótulo humano gravado no freeze ("MARCO") para o mês ISO. */
function mesDoRotulo(rotulo: string): string | null {
  const mapa: Record<string, string> = {
    FEVEREIRO: "2026-02",
    MARCO: "2026-03",
    ABRIL: "2026-04",
    MAIO: "2026-05",
    JUNHO: "2026-06",
    JULHO: "2026-07",
  };
  return mapa[rotulo.trim().toUpperCase()] ?? null;
}

/* ------------------------------------------------------------------------ *
 * JANELA DE NY PELO FUSO REAL — nunca BRT fixo
 * ------------------------------------------------------------------------ */

function partesLocais(
  timeZone: string,
  instantUtcMs: number,
): { y: number; m: number; d: number; hh: number; mm: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const partes = Object.fromEntries(
    dtf.formatToParts(new Date(instantUtcMs)).map((p) => [p.type, p.value]),
  );
  return {
    y: Number(partes["year"]),
    m: Number(partes["month"]),
    d: Number(partes["day"]),
    // "24" aparece em meia-noite em alguns runtimes; normaliza.
    hh: Number(partes["hour"]) % 24,
    mm: Number(partes["minute"]),
  };
}

/** O instante UTC em que o relógio local de `timeZone` marca a hora pedida. */
function instanteUtcDoLocal(
  timeZone: string,
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
): number {
  let palpite = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 3; i += 1) {
    const local = partesLocais(timeZone, palpite);
    const diff =
      Date.UTC(local.y, local.m - 1, local.d, local.hh, local.mm) - Date.UTC(y, m - 1, d, hh, mm);
    if (diff === 0) return palpite;
    palpite -= diff;
  }
  return palpite;
}

/**
 * A abertura de NY (09:30 America/New_York) do dia, em MINUTOS do relógio de
 * São Paulo. EDT ⇒ 10:30 SP; EST ⇒ 11:30 SP — a diferença que o valor fixo
 * ignorava metade do ano.
 */
export function aberturaNyEmMinutosSp(dataIso: string): number {
  const [y, m, d] = dataIso.split("-").map(Number) as [number, number, number];
  const instante = instanteUtcDoLocal("America/New_York", y, m, d, 9, 30);
  const sp = partesLocais("America/Sao_Paulo", instante);
  return sp.hh * 60 + sp.mm;
}

/** Janela de atenção da abertura de NY (15 minutos), no relógio de SP. */
export function janelaNyEmSp(dataIso: string): { inicio: number; fim: number } {
  const inicio = aberturaNyEmMinutosSp(dataIso);
  return { inicio, fim: inicio + 15 };
}
