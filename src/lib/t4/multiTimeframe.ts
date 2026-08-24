/**
 * MULTI-TIMEFRAME COMO CONTEXTO (§16) — filtro que só sabe RENDER, nunca somar.
 *
 * POR QUE ESTE MÓDULO EXISTE
 * O operador foi explícito: **o 1min é a execução**. Os timeframes superiores
 * entram para responder "o contexto maior está contra?" — e só isso. Sem um
 * lugar único que diga isso em código, a leitura de um gráfico de 15min viraria
 * mais um voto a favor da entrada, e a soma de dois vieses concordantes vira,
 * na tela, uma confirmação que nenhum candle produziu.
 *
 * AS TRÊS RESTRIÇÕES QUE GOVERNAM O ARQUIVO
 *
 * 1. CONCORDÂNCIA NUNCA VIRA CONFIRMAÇÃO ARTIFICIAL.
 *    `confidenceAdjustment` é **sempre ≤ 0**: divergência rebaixa, concordância
 *    deixa como está. Um ajuste positivo por concordância seria comprar
 *    confiança com contexto — exatamente o que a regra §12 já proíbe entre as
 *    camadas ("contexto alto NÃO compra entrada fraca"). Há teste de
 *    propriedade travando o sinal para qualquer entrada.
 *
 * 2. NUNCA INVENTAR CANDLE OU TIMEFRAME A PARTIR DE IMAGEM INSUFICIENTE.
 *    Leitura sem timeframe identificado, sem confiança reportada, com confiança
 *    abaixo do piso, com timeframe irreconhecível ou que não é superior à
 *    execução é DESCARTADA com o motivo dito. Sem nenhuma sobrando o resultado
 *    é `SEM_DADOS` com ajuste 0 — jamais um viés "provável" do gráfico maior.
 *
 * 3. CONTEXTO CONTRÁRIO NÃO IMPEDE A TÉCNICA.
 *    Divergir rebaixa a confiança e é dito na nota; não bloqueia. Quem bloqueia
 *    é a trava determinística de `printAnalysis`, que este módulo não toca e
 *    não duplica. Um segundo bloqueio aqui viraria uma regra paralela que
 *    ninguém consegue auditar junto com a primeira.
 *
 * Determinístico: mesma entrada, mesmo contexto. Sem relógio, sem sorteio.
 */

import { MIN_ENTRY_CONFIDENCE, NAO_IDENTIFICADO } from "@/lib/vision/printAnalysis";

export type TimeframeBias = "COMPRA" | "VENDA" | "NEUTRO";

export type TimeframeAgreement = "CONCORDA" | "DIVERGE" | "NEUTRO" | "SEM_DADOS";

/** A leitura do timeframe de EXECUÇÃO (o 1min, na operação do operador). */
export interface ExecutionTimeframeReading {
  /** Null = não identificado no print. Nunca preenchido por suposição. */
  timeframe: string | null;
  bias: TimeframeBias;
}

/** Uma leitura de timeframe SUPERIOR, candidata a entrar como contexto. */
export interface HigherTimeframeReading {
  timeframe: string | null;
  bias: TimeframeBias;
  /** 0–100. Abaixo do piso, a leitura NÃO entra como contexto. */
  confidence: number;
  /** DE ONDE veio ("print #3", "análise 15min"): sem origem não há auditoria. */
  source: string;
}

export interface TimeframeContext {
  execution: { timeframe: string; bias: TimeframeBias };
  /** SOMENTE as leituras que passaram no filtro. As descartadas vão na nota. */
  higher: Array<{ timeframe: string; bias: TimeframeBias; confidence: number; source: string }>;
  agreement: TimeframeAgreement;
  /** Filtro: rebaixa confiança quando diverge. NUNCA eleva por concordar. */
  confidenceAdjustment: number;
  note: string;
}

/**
 * Piso de confiança para uma leitura valer como contexto.
 *
 * É o MESMO piso da entrada (`MIN_ENTRY_CONFIDENCE`), reusado de propósito: um
 * segundo número mágico aqui divergiria do primeiro no dia em que um deles
 * fosse ajustado, e passaríamos a rebaixar entrada com base numa leitura de
 * contexto que o próprio sistema considera fraca demais para outra coisa.
 */
const MIN_CONTEXT_CONFIDENCE = MIN_ENTRY_CONFIDENCE;

/** Penalidade base por leitura superior divergente, em pontos de confiança. */
const PENALIDADE_BASE = 10;
/**
 * Teto da penalidade. Existe porque contexto contrário REBAIXA, não bloqueia:
 * sem teto, três gráficos maiores discordando zerariam a leitura e o filtro
 * viraria o veto que a restrição 3 do cabeçalho proíbe.
 */
const PENALIDADE_MAXIMA = 30;

function clamp01(valor: number): number {
  if (!Number.isFinite(valor)) return 0;
  if (valor < 0) return 0;
  if (valor > 1) return 1;
  return valor;
}

function normalizar(texto: string): string {
  let saida = "";
  for (const caractere of texto.normalize("NFD")) {
    const code = caractere.codePointAt(0) ?? 0;
    // Faixa dos diacríticos combinantes do Unicode (U+0300–U+036F).
    if (code >= 0x0300 && code <= 0x036f) continue;
    saida += caractere;
  }
  return saida.toLowerCase();
}

const MINUTOS_POR_DIA = 60 * 24;

/**
 * Timeframe escrito → minutos. Null quando NÃO RECONHECIDO.
 *
 * Null é a resposta honesta e tem consequência: sem saber quantos minutos vale
 * a leitura, não dá para AFIRMAR que ela é superior à execução — e uma leitura
 * de contexto que talvez seja do mesmo timeframe da execução é a porta pela
 * qual "o 1min concorda com o 1min" viraria confirmação.
 *
 * O vocabulário coberto é o que aparece de verdade: cabeçalho do Profit
 * ("1Min", "15Min", "Diário", "Semanal"), forma curta ("5m", "1h") e forma
 * MetaTrader ("M5", "H1").
 */
export function timeframeEmMinutos(texto: string | null): number | null {
  if (texto === null) return null;
  const t = normalizar(texto).replace(/\s+/g, "");
  if (t === "") return null;

  if (/^(d|d1|1d|diario|daily)$/.test(t)) return MINUTOS_POR_DIA;
  if (/^(w|w1|1w|semanal|weekly)$/.test(t)) return MINUTOS_POR_DIA * 7;
  if (/^(mn|mn1|1mo|mensal|monthly)$/.test(t)) return MINUTOS_POR_DIA * 30;

  // Forma MetaTrader: M15, H4.
  const mt = /^([mh])(\d{1,4})$/.exec(t);
  if (mt !== null) {
    const valor = Number(mt[2]);
    if (!Number.isFinite(valor) || valor <= 0) return null;
    return mt[1] === "h" ? valor * 60 : valor;
  }

  // Forma numérica: "15", "15min", "1h", "4 horas".
  const num = /^(\d{1,4})(min|m|h|hora|horas|hour|hours)?$/.exec(t);
  if (num === null) return null;
  const valor = Number(num[1]);
  if (!Number.isFinite(valor) || valor <= 0) return null;
  const unidade = num[2] ?? "min";
  const emHoras = unidade === "h" || unidade.startsWith("hor") || unidade.startsWith("hour");
  return emHoras ? valor * 60 : valor;
}

/** Como um timeframe aparece na tela quando a análise não o identificou. */
function rotulo(timeframe: string | null): string {
  const texto = (timeframe ?? "").trim();
  return texto === "" ? NAO_IDENTIFICADO : texto;
}

/**
 * Monta o contexto multi-timeframe.
 *
 * Puro: recebe as leituras já feitas e devolve o julgamento. Não vai buscar
 * print, não chama IA e não deduz timeframe de imagem — quem lê é quem chama.
 */
export function buildTimeframeContext(
  execucao: ExecutionTimeframeReading,
  superiores: HigherTimeframeReading[],
): TimeframeContext {
  const execRotulo = rotulo(execucao.timeframe);
  const minutosExecucao = timeframeEmMinutos(execucao.timeframe);
  const entrada = superiores ?? [];

  const usaveis: TimeframeContext["higher"] = [];
  const descartes: string[] = [];

  for (const leitura of entrada) {
    const nome = rotulo(leitura.timeframe);
    /*
     * NaN NÃO É "BAIXO": `NaN < 60` é falso, e sem esta checagem uma confiança
     * não numérica passaria direto pelo piso e entraria como contexto válido.
     */
    if (!Number.isFinite(leitura.confidence)) {
      descartes.push(`${nome} (${leitura.source}): confiança não reportada`);
      continue;
    }
    if (nome === NAO_IDENTIFICADO) {
      descartes.push(
        `leitura de ${leitura.source}: timeframe não identificado — não dá para chamar de superior`,
      );
      continue;
    }
    if (leitura.confidence < MIN_CONTEXT_CONFIDENCE) {
      descartes.push(
        `${nome} (${leitura.source}): confiança ${Math.round(leitura.confidence)}% abaixo do piso de ${MIN_CONTEXT_CONFIDENCE}%`,
      );
      continue;
    }
    const minutos = timeframeEmMinutos(leitura.timeframe);
    if (minutos === null) {
      descartes.push(
        `${nome} (${leitura.source}): timeframe não reconhecido — não dá para afirmar que é superior à execução`,
      );
      continue;
    }
    if (minutosExecucao !== null && minutos <= minutosExecucao) {
      descartes.push(
        `${nome} (${leitura.source}): não é SUPERIOR à execução (${execRotulo}) — contexto tem de vir de cima`,
      );
      continue;
    }
    usaveis.push({
      timeframe: nome,
      bias: leitura.bias,
      confidence: leitura.confidence,
      source: leitura.source,
    });
  }

  const partes: string[] = [`Execução ${execRotulo} com viés ${execucao.bias}.`];
  if (minutosExecucao === null && usaveis.length > 0) {
    partes.push(
      "Hierarquia NÃO verificada: o timeframe de execução não foi identificado, então não foi possível conferir que as leituras abaixo são de fato superiores.",
    );
  }

  let agreement: TimeframeAgreement;
  let confidenceAdjustment = 0;

  if (usaveis.length === 0) {
    agreement = "SEM_DADOS";
    partes.push(
      "Nenhum timeframe superior confiável nesta leitura: o contexto NÃO foi avaliado e nada foi suposto sobre o gráfico maior.",
    );
  } else if (execucao.bias === "NEUTRO") {
    agreement = "NEUTRO";
    partes.push(
      `A execução não tem lado definido, então não há do que divergir. Leituras superiores registradas como contexto: ${listar(usaveis)}.`,
    );
  } else {
    const divergentes = usaveis.filter((r) => r.bias !== "NEUTRO" && r.bias !== execucao.bias);
    const concordantes = usaveis.filter((r) => r.bias === execucao.bias);

    if (divergentes.length > 0) {
      agreement = "DIVERGE";
      const bruto = divergentes.reduce(
        (soma, r) => soma + PENALIDADE_BASE + PENALIDADE_BASE * clamp01(r.confidence / 100),
        0,
      );
      confidenceAdjustment = -Math.min(PENALIDADE_MAXIMA, Math.round(bruto));
      partes.push(
        `DIVERGE: ${listar(divergentes)} aponta(m) para o lado oposto ao viés de execução.`,
      );
      if (concordantes.length > 0) {
        partes.push(`Ainda assim ${listar(concordantes)} concorda(m) — a divergência é que manda.`);
      }
      partes.push(
        `Contexto contrário NÃO impede a técnica: a execução segue no timeframe de execução, com a confiança rebaixada em ${Math.abs(confidenceAdjustment)} ponto(s).`,
      );
    } else if (concordantes.length > 0) {
      agreement = "CONCORDA";
      partes.push(
        `CONCORDA: ${listar(concordantes)} aponta(m) para o mesmo lado da execução. Concordância NÃO confirma entrada — o ajuste fica em 0, porque contexto favorável não é gatilho.`,
      );
    } else {
      agreement = "NEUTRO";
      partes.push(
        `Os timeframes superiores confiáveis estão sem lado definido: ${listar(usaveis)}. Nada a favor, nada contra.`,
      );
    }
  }

  if (descartes.length > 0) {
    partes.push(`Leitura(s) descartada(s): ${descartes.join("; ")}.`);
  }

  return {
    execution: { timeframe: execRotulo, bias: execucao.bias },
    higher: usaveis,
    agreement,
    confidenceAdjustment,
    note: partes.join(" "),
  };
}

function listar(leituras: TimeframeContext["higher"]): string {
  return leituras.map((r) => `${r.timeframe} ${r.bias} (${r.source})`).join(", ");
}
