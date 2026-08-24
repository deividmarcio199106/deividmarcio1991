/**
 * SCORE T4 EXPLICÁVEL (§18) — a nota que DIZ de onde saiu cada ponto.
 *
 * POR QUE ESTE MÓDULO EXISTE
 * O painel já mostrava confiança visual, confianças por camada e a lista de
 * critérios — cada coisa num canto. Faltava a pergunta que o operador faz de
 * verdade: "o quanto ESTA configuração atende a técnica, e ONDE ela perde
 * ponto?". Um número solto responderia a primeira metade e esconderia a
 * segunda; por isso o score aqui é uma SOMA DE PARCELAS RASTREÁVEIS — cada
 * componente carrega peso, quanto ganhou e o POR QUÊ, sempre preenchido.
 *
 * AS QUATRO RESTRIÇÕES QUE GOVERNAM O ARQUIVO
 *
 * 1. O SCORE NÃO AUTORIZA OPERAÇÃO — NUNCA.
 *    `entradaConfirmada` é ESPELHO de `deriveEntryDecision`, importado de
 *    `printAnalysis`. A regra da confirmação mora lá e só lá: reimplementá-la
 *    aqui criaria uma segunda opinião que divergiria no primeiro ajuste, e uma
 *    das duas liberaria a entrada que a outra bloqueia. Score 100 com
 *    `entradaConfirmada=false` continua PROIBINDO operar.
 *
 * 2. COMPONENTE SEM LASTRO NÃO GANHA NEM PERDE.
 *    Toda parcela deriva do que a análise REALMENTE traz: os critérios T4 que
 *    o modelo avaliou, as confianças por camada, o DNA do setup e o R:R dos
 *    níveis legíveis. Sem nenhuma dessas fontes o componente fica com
 *    `earned: 0`, `penalty: false` e o detail diz "NÃO AVALIÁVEL NESTA IMAGEM".
 *    Ausência é um valor — a mesma lei do `visible` dos números.
 *
 * 3. PENALIZAR EXIGE EVIDÊNCIA NEGATIVA, não silêncio.
 *    `penalty` só é verdadeiro quando a análise AFIRMA algo contra: critério
 *    marcado `met:false`, item listado em `missingCriteria`, R:R medido abaixo
 *    do mínimo, tendência CONTRA no DNA, confiança medida abaixo do piso,
 *    problemas de imagem declarados, auditor reprovando. Não achar o candle de
 *    confirmação é ausência de prova, não prova de falha — quem trata isso como
 *    bloqueio é a trava, que é outra coisa e continua bloqueando.
 *
 * 4. DETERMINÍSTICO. Mesma análise, mesmo score: nenhum `Date.now()`, nenhum
 *    `Math.random`, nenhuma leitura de estado externo. É isso que permite
 *    reabrir um print do histórico e ver a MESMA nota de quando ele foi lido.
 *
 * O QUE ESTE ARQUIVO NÃO FAZ, DE PROPÓSITO
 * Não cria critério novo. Os componentes são as 10 regras T4 do prompt
 * (`T4_RULES` em services/ai/chartVision.ts) agrupadas nas parcelas que a
 * análise consegue sustentar, mais a qualidade da própria leitura. Inventar um
 * componente sem fonte no contrato seria devolver nota sobre nada.
 */

import type { DnaPullback, DnaTrend } from "@/lib/t4/dna";
import {
  deriveEntryDecision,
  hasClosedConfirmationCandle,
  MIN_ENTRY_CONFIDENCE,
  MIN_RR,
  PRINT_STATUS_LABEL,
  type Criterion,
  type PrintAnalysis,
} from "@/lib/vision/printAnalysis";

export interface ScoreComponent {
  /** Um dos ids do vocabulário fechado abaixo. */
  id: string;
  /** Rótulo curto em PT para a tela. */
  label: string;
  /** Peso do componente no total. A soma dos pesos é sempre 100. */
  weight: number;
  /** Quanto ganhou, 0..weight. */
  earned: number;
  /** POR QUE ganhou/perdeu — sempre presente, nunca vazio. */
  detail: string;
  /** Verdadeiro quando o componente PENALIZOU (evidência negativa explícita). */
  penalty: boolean;
}

export interface T4Score {
  /** 0..100 — soma exata dos `earned`. */
  total: number;
  components: ScoreComponent[];
  /** Motivos das penalizações, em PT. Vazio quando nada penalizou. */
  penalties: string[];
  /** NUNCA autoriza operação. Espelha `deriveEntryDecision(analysis).entradaConfirmada`. */
  entradaConfirmada: boolean;
  note: string;
}

/** Vocabulário fechado dos componentes — nada fora desta lista pontua. */
type ScoreComponentId =
  "contexto" | "estrutura" | "localizacao" | "reteste" | "candle" | "rr" | "leitura";

const COMPONENT_IDS: ScoreComponentId[] = [
  "contexto",
  "estrutura",
  "localizacao",
  "reteste",
  "candle",
  "rr",
  "leitura",
];

/**
 * Pesos das parcelas. Somam 100 por construção (há teste travando isso).
 *
 * CANDLE e RISCO pesam mais que o resto porque são as duas exigências que a
 * trava determinística trata como obrigatórias (`evaluateEntryProof`): um
 * score que desse o mesmo peso a "contexto claro" e a "candle fechado
 * confirmando" diria que a técnica aceita trocar um pelo outro — e ela não
 * aceita. LEITURA fecha a lista porque nenhuma das outras parcelas significa
 * coisa alguma sobre uma imagem que não deu para ler.
 */
const META: Record<ScoreComponentId, { label: string; weight: number }> = {
  contexto: { label: "CONTEXTO", weight: 14 },
  estrutura: { label: "ESTRUTURA", weight: 14 },
  localizacao: { label: "LOCALIZAÇÃO E LIQUIDEZ", weight: 12 },
  reteste: { label: "REAÇÃO, MUDANÇA E RETESTE", weight: 12 },
  candle: { label: "CANDLE DE CONFIRMAÇÃO", weight: 18 },
  rr: { label: "RISCO — STOP E R:R", weight: 18 },
  leitura: { label: "LEITURA DA IMAGEM", weight: 12 },
};

/**
 * Pesos RELATIVOS dentro de um componente.
 *
 * Critério objetivo (o modelo afirmando "atendido/não atendido" sobre uma
 * regra da técnica) pesa o dobro de uma AUTOAVALIAÇÃO de confiança — a mesma
 * decisão já tomada em `chooseBetterReading`: quem se avalia não pode ser o
 * juiz do próprio score.
 */
const PESO_CRITERIO = 2;
const PESO_DNA = 1;
const PESO_CONFIANCA = 1;

/**
 * R:R que a regra 10 da técnica pede. `MIN_RR` (hoje 3, importado — nunca redigitado) é o PISO da casa, abaixo
 * do qual a trava barra; 3,0 é onde a parcela fecha em cheio. Entre os dois a
 * pontuação cresce em linha reta — nunca há um degrau escondido.
 */
const RR_ALVO_T4 = 3;

function clamp01(valor: number): number {
  if (!Number.isFinite(valor)) return 0;
  if (valor < 0) return 0;
  if (valor > 1) return 1;
  return valor;
}

/**
 * Minúsculas sem acento — o texto do modelo chega em PT com acentuação
 * variável ("Localização", "localizacao", "LOCALIZAÇÃO") e a classificação não
 * pode depender de qual forma ele escolheu.
 */
function normalizar(texto: string): string {
  let saida = "";
  // Percorre por CODE POINT em vez de usar classe de caractere com marcas
  // combinantes: uma faixa dessas dentro de `[...]` é ilegível no editor (as
  // marcas grudam no colchete) e o próprio eslint a proíbe.
  for (const caractere of texto.normalize("NFD")) {
    const code = caractere.codePointAt(0) ?? 0;
    // Faixa dos diacríticos combinantes do Unicode (U+0300–U+036F).
    if (code >= 0x0300 && code <= 0x036f) continue;
    saida += caractere;
  }
  return saida.toLowerCase();
}

/**
 * De qual componente é este critério.
 *
 * A ORDEM É A REGRA: do mais específico para o mais genérico. "MUDANÇA DE
 * ESTRUTURA" contém "estrutura" e cairia na parcela errada se ESTRUTURA fosse
 * testada antes de RETESTE; "CANDLE DE CONFIRMAÇÃO" contém "confirmação" e
 * precisa vir antes de tudo. Texto que não casa com nada NÃO pontua — o id do
 * critério é livre no contrato, e adivinhar a que regra ele pertence seria
 * inventar lastro.
 */
const PADROES: Array<{ id: ScoreComponentId; re: RegExp }> = [
  { id: "candle", re: /candle|confirmacao|gatilho|trigger/ },
  { id: "rr", re: /risco|retorno|risk|reward|\brr\b|\br\s*[:/]\s*r\b|stop|invalidacao/ },
  {
    id: "reteste",
    re: /reteste|retest|\bpoi\b|pullback|mudanca|shift|\bbos\b|choch|reacao|reaction|rompimento/,
  },
  { id: "localizacao", re: /localiza|location|liquidez|liquidity|suporte|resistencia|regiao|zona/ },
  { id: "estrutura", re: /estrutura|structure|topo|fundo|swing/ },
  { id: "contexto", re: /contexto|context|regime|tendencia|trend|lateral|range/ },
];

function componenteDe(texto: string): ScoreComponentId | null {
  const alvo = normalizar(texto);
  for (const { id, re } of PADROES) {
    if (re.test(alvo)) return id;
  }
  return null;
}

function vazio<T>(): Record<ScoreComponentId, T[]> {
  return {
    contexto: [],
    estrutura: [],
    localizacao: [],
    reteste: [],
    candle: [],
    rr: [],
    leitura: [],
  };
}

/**
 * Uma parcela de prova dentro de um componente.
 *
 * `penaliza` é o que separa "a análise disse que NÃO atende" de "a análise não
 * falou sobre isso": só o primeiro entra na lista de penalizações da tela.
 */
interface Evidencia {
  peso: number;
  fracao: number;
  detalhe: string;
  penaliza: boolean;
}

function evidenciasDeCriterios(criterios: Criterion[]): Evidencia[] {
  return criterios.map((c) => {
    const nome = c.label || c.id;
    const porque = c.detail ? ` — ${c.detail}` : "";
    return {
      peso: PESO_CRITERIO,
      fracao: c.met ? 1 : 0,
      detalhe: `${c.met ? "atendido" : "NÃO atendido"}: ${nome}${porque}`,
      penaliza: !c.met,
    };
  });
}

/** `missingCriteria` é a própria análise declarando o que falta — é evidência negativa. */
function evidenciasDeAusentes(textos: string[]): Evidencia[] {
  return textos.map((texto) => ({
    peso: PESO_CRITERIO,
    fracao: 0,
    detalhe: `a análise listou como AUSENTE: "${texto}"`,
    penaliza: true,
  }));
}

function evidenciaDeConfianca(valor: number | null | undefined, nome: string): Evidencia | null {
  if (valor === null || valor === undefined || !Number.isFinite(valor)) return null;
  const abaixo = valor < MIN_ENTRY_CONFIDENCE;
  return {
    peso: PESO_CONFIANCA,
    fracao: clamp01(valor / 100),
    detalhe: `confiança de ${nome} ${Math.round(valor)}%${
      abaixo ? ` (abaixo do piso de ${MIN_ENTRY_CONFIDENCE}%)` : ""
    }`,
    penaliza: abaixo,
  };
}

/**
 * Tendência do DNA → fração da parcela de contexto.
 *
 * `null` significa AUSÊNCIA (não medido): a dimensão simplesmente não entra na
 * média, em vez de entrar como zero. CONTRA vale 0 E penaliza porque, pelo
 * próprio vocabulário (`positionFor` em dna.ts), setup contra a tendência
 * instalada opera CONTRA_TENDENCIA — é uma afirmação da análise, não silêncio.
 */
const FRACAO_TREND: Record<DnaTrend, number | null> = {
  FORTE: 1,
  NORMAL: 0.75,
  LATERAL: 0.5,
  TRANSICAO: 0.4,
  CONTRA: 0,
  NAO_IDENTIFICADO: null,
};

/**
 * Forma do pullback → fração da parcela de reteste, com a semântica que já
 * está documentada em `classifyPullback` (dna.ts): AGRESSIVO é o outro lado
 * entrando com força — recuo que não é técnico —, e por isso é o único que
 * penaliza. FALSO_ROMPIMENTO não penaliza: ali ele é o evento MAIS informativo
 * da técnica (captura de liquidez), não um defeito.
 */
const FRACAO_PULLBACK: Record<DnaPullback, number | null> = {
  LIMPO: 1,
  CURTO: 0.85,
  FALSO_ROMPIMENTO: 0.8,
  PROFUNDO: 0.6,
  LATERAL: 0.5,
  AGRESSIVO: 0.3,
  NAO_IDENTIFICADO: null,
};

/**
 * Fecha um componente.
 *
 * Sem NENHUMA evidência a parcela não é zero "por mérito": ela é declarada não
 * avaliável, com o motivo — que é diferente de ter sido avaliada e reprovada,
 * e a tela precisa distinguir as duas coisas.
 */
function montar(
  id: ScoreComponentId,
  evidencias: Evidencia[],
  semBase: string,
  extras: string[] = [],
): ScoreComponent {
  const { label, weight } = META[id];
  const sufixo = extras.length > 0 ? ` · ${extras.join(" · ")}` : "";
  if (evidencias.length === 0) {
    return {
      id,
      label,
      weight,
      earned: 0,
      detail: `NÃO AVALIÁVEL NESTA IMAGEM — ${semBase}${sufixo}`,
      penalty: false,
    };
  }
  const pesoTotal = evidencias.reduce((soma, e) => soma + e.peso, 0);
  const fracao =
    pesoTotal > 0
      ? evidencias.reduce((soma, e) => soma + e.peso * clamp01(e.fracao), 0) / pesoTotal
      : 0;
  return {
    id,
    label,
    weight,
    // Arredondado a inteiro DE PROPÓSITO: `total` é a soma dos `earned`, e
    // parcelas fracionárias fariam a soma exibida na tela não bater com o
    // total exibido ao lado dela.
    earned: Math.round(weight * clamp01(fracao)),
    detail: `${evidencias.map((e) => e.detalhe).join(" · ")}${sufixo}`,
    penalty: evidencias.some((e) => e.penaliza),
  };
}

/**
 * O score de uma análise de print.
 *
 * Puro e determinístico. Não muta a análise recebida (a trava, que muta, roda
 * na validação — aqui só se LÊ a decisão que ela já produziu).
 */
export function scoreT4(analysis: PrintAnalysis): T4Score {
  // Listas ausentes (análise antiga do histórico) são listas vazias: sem
  // evidência, nunca uma exceção que derruba a tela.
  const criteria = analysis.criteria ?? [];
  const missing = analysis.missingCriteria ?? [];
  const imageIssues = analysis.imageIssues ?? [];
  const dna = analysis.dna ?? null;
  const confidences = analysis.confidences ?? null;
  const audit = analysis.audit ?? null;

  // A REGRA DA CONFIRMAÇÃO É IMPORTADA, NUNCA REESCRITA AQUI.
  const decisao = deriveEntryDecision(analysis);

  const porCriterio = vazio<Criterion>();
  let foraDoVocabulario = 0;
  for (const criterio of criteria) {
    const id = componenteDe(`${criterio.id} ${criterio.label}`);
    if (id === null) {
      foraDoVocabulario += 1;
      continue;
    }
    porCriterio[id].push(criterio);
  }

  const porAusente = vazio<string>();
  for (const texto of missing) {
    const id = componenteDe(texto);
    if (id !== null) porAusente[id].push(texto);
  }

  /**
   * `missingCriteria` só entra quando o componente NÃO tem critério próprio:
   * com os dois presentes, a mesma falha seria contada duas vezes e a parcela
   * afundaria por contabilidade, não por evidência.
   */
  const negativasDe = (id: ScoreComponentId): Evidencia[] =>
    porCriterio[id].length > 0
      ? evidenciasDeCriterios(porCriterio[id])
      : evidenciasDeAusentes(porAusente[id]);

  const componentes: ScoreComponent[] = [];

  /* CONTEXTO — regra 1 da técnica. Critérios + tendência do DNA + §12. */
  {
    const evid = negativasDe("contexto");
    if (dna !== null) {
      const fracao = FRACAO_TREND[dna.trend];
      if (fracao !== null) {
        evid.push({
          peso: PESO_DNA,
          fracao,
          detalhe: `DNA: tendência ${dna.trend}${
            dna.trend === "CONTRA" ? " (setup contra a tendência instalada)" : ""
          }`,
          penaliza: dna.trend === "CONTRA",
        });
      }
    }
    const conf = evidenciaDeConfianca(confidences?.contexto, "contexto");
    if (conf !== null) evid.push(conf);
    componentes.push(
      montar(
        "contexto",
        evid,
        "a análise não trouxe critério de contexto, confiança de contexto nem tendência no DNA",
      ),
    );
  }

  /* ESTRUTURA — regra 2. Topos e fundos organizados. */
  {
    const evid = negativasDe("estrutura");
    const conf = evidenciaDeConfianca(confidences?.estrutura, "estrutura");
    if (conf !== null) evid.push(conf);
    componentes.push(
      montar(
        "estrutura",
        evid,
        "a análise não trouxe critério de estrutura nem confiança de estrutura",
      ),
    );
  }

  /* LOCALIZAÇÃO E LIQUIDEZ — regras 3 e 4. */
  {
    const evid = negativasDe("localizacao");
    if (dna !== null && dna.location !== "NAO_IDENTIFICADO") {
      evid.push({
        peso: PESO_DNA,
        fracao: 1,
        detalhe: `DNA: localização ${dna.location}`,
        penaliza: false,
      });
    }
    componentes.push(
      montar(
        "localizacao",
        evid,
        "nenhum critério de localização/liquidez e localização NÃO IDENTIFICADA no DNA",
      ),
    );
  }

  /* REAÇÃO, MUDANÇA DE ESTRUTURA E RETESTE — regras 5, 6 e 7. */
  {
    const evid = negativasDe("reteste");
    if (dna !== null) {
      const fracao = FRACAO_PULLBACK[dna.pullback];
      if (fracao !== null) {
        evid.push({
          peso: PESO_DNA,
          fracao,
          detalhe: `DNA: pullback ${dna.pullback}${
            dna.pullback === "AGRESSIVO" ? " (correção do tamanho do impulso)" : ""
          }`,
          penaliza: dna.pullback === "AGRESSIVO",
        });
      }
    }
    componentes.push(
      montar(
        "reteste",
        evid,
        "nenhum critério de reação/mudança/reteste e pullback NÃO IDENTIFICADO no DNA",
      ),
    );
  }

  /* CANDLE DE CONFIRMAÇÃO — regra 8, avaliada pela MESMA função da trava. */
  {
    const temCandle = hasClosedConfirmationCandle(analysis);
    const evid: Evidencia[] = [];
    if (temCandle) {
      const trigger =
        dna !== null && dna.triggerCandle !== "NAO_IDENTIFICADO"
          ? ` (DNA: ${dna.triggerCandle})`
          : "";
      evid.push({
        peso: PESO_CRITERIO,
        fracao: 1,
        detalhe: `candle de confirmação FECHADO identificado na análise${trigger}`,
        penaliza: false,
      });
    } else {
      // Falso aqui significa "olhei e não achei": só entram as negativas que a
      // análise AFIRMOU. Sem elas, a parcela é não avaliável — e a trava, que é
      // outra regra, continua barrando a entrada do mesmo jeito.
      evid.push(...negativasDe("candle"));
    }
    componentes.push(
      montar(
        "candle",
        evid,
        "nenhuma marcação, critério ou DNA sustenta candle de confirmação fechado — a trava trata isso como bloqueio, o score não pontua nem penaliza",
      ),
    );
  }

  /* RISCO — regras 9 e 10: stop estrutural e espaço até o alvo. */
  {
    const evid = negativasDe("rr");
    const rr = decisao.rr;
    if (rr !== null) {
      const abaixoDoPiso = rr < MIN_RR;
      const fracao = abaixoDoPiso
        ? 0
        : rr >= RR_ALVO_T4
          ? 1
          : 0.5 + (0.5 * (rr - MIN_RR)) / (RR_ALVO_T4 - MIN_RR);
      evid.push({
        peso: PESO_CRITERIO,
        fracao,
        detalhe: `R:R ${rr.toFixed(2)}${
          abaixoDoPiso
            ? ` — abaixo do mínimo ${MIN_RR.toFixed(1).replace(".", ",")} da casa`
            : ` (mínimo ${MIN_RR.toFixed(1).replace(".", ",")}, cheio em ${RR_ALVO_T4},0)`
        }`,
        penaliza: abaixoDoPiso,
      });
    }
    componentes.push(
      montar(
        "rr",
        evid,
        "R:R incalculável: entrada, stop ou alvo não legíveis no print — nenhum número foi estimado para preencher a parcela",
      ),
    );
  }

  /* LEITURA DA IMAGEM — o quanto a imagem sustentou tudo o que está acima. */
  {
    const evid: Evidencia[] = [];
    const visual = evidenciaDeConfianca(analysis.confidence, "leitura visual");
    if (visual !== null) evid.push(visual);
    if (imageIssues.length > 0) {
      evid.push({
        peso: PESO_CRITERIO,
        fracao: 0,
        detalhe: `problemas declarados na imagem: ${imageIssues.join("; ")}`,
        penaliza: true,
      });
    }
    if (audit !== null && !audit.approved) {
      evid.push({
        peso: PESO_CRITERIO,
        fracao: 0,
        detalhe: `auditor REPROVOU: ${audit.issues?.[0] ?? "incoerência não detalhada"}`,
        penaliza: true,
      });
    }
    // Auditor ausente é dito, não convertido em nota: null significa que ele
    // não rodou, e falha de IA nunca derruba nem levanta o score.
    const extras = [audit === null ? "auditor não rodou" : audit.approved ? "auditor aprovou" : ""];
    componentes.push(
      montar(
        "leitura",
        evid,
        "a análise não reportou confiança de leitura",
        extras.filter((e) => e !== ""),
      ),
    );
  }

  // Ordem estável de exibição — a tela lê sempre na mesma sequência, print a
  // print, o que torna duas análises comparáveis a olho.
  const ordenados = COMPONENT_IDS.map((id) => componentes.find((c) => c.id === id)).filter(
    (c): c is ScoreComponent => c !== undefined,
  );

  const total = ordenados.reduce((soma, c) => soma + c.earned, 0);
  const penalties = ordenados.filter((c) => c.penalty).map((c) => `${c.label}: ${c.detail}`);

  const naoAvaliaveis = ordenados.filter((c) => c.detail.startsWith("NÃO AVALIÁVEL")).length;

  const partes = [
    `Score ${total}/100 — soma das contribuições explicadas componente a componente.`,
    `Status da análise: ${PRINT_STATUS_LABEL[analysis.status]}.`,
  ];
  if (naoAvaliaveis > 0) {
    partes.push(
      `${naoAvaliaveis} componente(s) sem base nesta imagem: pontuam 0 sem penalizar — ausência é ausência, não reprovação.`,
    );
  }
  if (foraDoVocabulario > 0) {
    partes.push(
      `${foraDoVocabulario} critério(s) fora do vocabulário T4 não pontuaram — nenhum foi encaixado por aproximação.`,
    );
  }
  partes.push(
    decisao.entradaConfirmada
      ? "A trava determinística liberou a entrada; o score explica a QUALIDADE, nunca a permissão."
      : `O SCORE NÃO AUTORIZA OPERAÇÃO: a trava de entrada segue bloqueada (${decisao.pendencias.length} pendência(s) — a primeira: ${decisao.pendencias[0] ?? "não informada"}).`,
  );

  return {
    total,
    components: ordenados,
    penalties,
    entradaConfirmada: decisao.entradaConfirmada,
    note: partes.join(" "),
  };
}
