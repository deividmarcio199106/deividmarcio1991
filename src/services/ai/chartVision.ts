/**
 * LEITURA DE UM PRINT DE GRÁFICO POR MODELO MULTIMODAL.
 *
 * SOMENTE SERVIDOR. A imagem sobe do navegador, é validada aqui e vai ao modelo
 * com o schema FORÇADO — o provedor devolve JSON estruturado, não prosa.
 *
 * A DIFERENÇA PARA O OCR DA ESCALA, QUE JÁ EXISTE NESTE PROJETO
 * Lá o modelo lê NÚMEROS de uma régua e a geometria confere o resultado: uma
 * reta com R² alto prova que os rótulos são consistentes entre si. Aqui não há
 * régua nem conferência geométrica possível — o modelo está descrevendo
 * ESTRUTURA. Não existe teste posterior que diga "esta leitura de topo/fundo
 * está certa".
 *
 * Por isso a defesa muda de natureza: em vez de conferir o resultado, o sistema
 * restringe o que pode ser AFIRMADO. Todo número carrega `visible`, todo
 * traço vem de coordenada normalizada validada, e nenhuma regra da técnica é
 * inventada pelo modelo — as regras vão no prompt, vindas do sistema.
 */

import { aiConfig } from "./config";
import { aiBreaker, describeAIError } from "./gateway";
import { sanitizeSecrets } from "@/lib/errors/sanitize";
import { extractJsonObject } from "@/lib/jsonExtract";
import {
  DNA_GRADES,
  DNA_LOCATIONS,
  DNA_POSITIONS,
  DNA_PULLBACKS,
  DNA_TRENDS,
  DNA_TRIGGERS,
  DNA_VOLATILITIES,
} from "@/lib/t4/dna";
import {
  applyConfirmationGate,
  NAO_LEGIVEL,
  validatePrintAnalysis,
  type PrintAnalysis,
  type ReadNumber,
  type ValidationResult,
} from "@/lib/vision/printAnalysis";

/**
 * TEMPO QUE O MODELO FICA RESIDENTE NA VRAM ENTRE AS CHAMADAS.
 *
 * O padrão do Ollama é 5 minutos. Com o ciclo de 60s isso basta enquanto a
 * sessão está correndo — mas qualquer pausa maior (almoço, leilão, o operador
 * fechando a aba) descarrega 24 GB, e a análise seguinte paga a recarga
 * inteira antes de começar a pensar. Era isso que aparecia como "a IA travou".
 *
 * 30 minutos cobre as pausas normais de um pregão sem manter a GPU ocupada
 * para sempre. Configurável porque a máquina do operador pode mudar.
 */
const KEEP_ALIVE = process.env["OLLAMA_KEEP_ALIVE"]?.trim() || "30m";

/**
 * Como o auditor foi tratado nesta análise. O chamador precisa saber: em
 * ADIADO é ele quem dispara a segunda passada em segundo plano.
 */
export type AuditMode = "BLOQUEANTE" | "ADIADO" | "DISPENSADO";

/**
 * A REGRA DO §4, em um lugar só e testável.
 *
 * Bloqueia SÓ o que pode liberar entrada. Nada aqui afrouxa a confirmação: um
 * status que pode virar COMPRA/VENDA continua exigindo o carimbo antes de
 * qualquer coisa chegar à tela.
 */
export function auditModeFor(analysis: PrintAnalysis): AuditMode {
  if (analysis.status === "ENTRADA_CONFIRMADA" || analysis.status === "PRE_ENTRADA") {
    return "BLOQUEANTE";
  }
  // Sem lado não há direção para contradizer nem entrada para liberar.
  if (analysis.direction === "NEUTRO") return "DISPENSADO";
  return "ADIADO";
}

export interface ChartVisionResult {
  ok: boolean;
  analysis: PrintAnalysis | null;
  model: string;
  /** Erro para o operador. Null quando deu certo. */
  error: string | null;
  /** Ajustes feitos pela validação — mostrados, nunca escondidos. */
  repairs: string[];
  latencyMs: number;
  /** ADIADO ⇒ o chamador roda `auditChartAnalysis` em segundo plano. */
  auditMode?: AuditMode;
  /** Custo real do auditor. Null quando ele não rodou nesta chamada. */
  auditMs?: number | null;
  /** Custo real da(s) chamada(s) de visão, sem o auditor somado. */
  visionMs?: number | null;
  /** Re-prompts gastos porque a resposta veio fora do contrato. */
  retryCount?: number;
}

/**
 * NÚMERO LIDO — `{ value, visible }`, a forma que esta casa usa para "li" e
 * "não li" serem respostas distintas, e nenhuma delas ser zero.
 *
 * Existe como constante só para os campos NOVOS abaixo; os antigos seguem
 * escritos à mão para o diff não tocar contrato que já está em produção.
 */
const RN = {
  type: "object",
  properties: { value: { type: ["number", "null"] }, visible: { type: "boolean" } },
  required: ["value", "visible"],
} as const;

/**
 * O schema que o provedor é obrigado a preencher.
 *
 * Deixar o modelo escolher o formato foi tentador e é errado: texto livre
 * precisaria ser interpretado, e interpretar prosa de modelo é onde a
 * alucinação entra. Com `format` o provedor devolve exatamente estes campos.
 */
const RESPONSE_FORMAT = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: [
        "SEM_T4",
        "T4_EM_FORMACAO",
        "APROXIMACAO_T4",
        "PRE_ENTRADA",
        "ENTRADA_CONFIRMADA",
        "T4_INVALIDADA",
        "INCONCLUSIVO",
      ],
    },
    direction: { type: "string", enum: ["COMPRA", "VENDA", "NEUTRO"] },
    confidence: { type: "number" },
    symbol: { type: ["string", "null"] },
    timeframe: { type: ["string", "null"] },
    /*
     * O RELÓGIO DO GRÁFICO — a identidade do candle sai daqui, não do servidor.
     *
     * Medido na sessão real de 20/08/2026: o relógio do navegador estava ~2 min
     * à frente do relógio dentro da imagem, e contra o relógio da imagem 15 de
     * 82 transições de captura estavam erradas — 7 caíram no mesmo minuto de
     * mercado, 8 candles ficaram sem captura nenhuma. Em tempo de navegador a
     * sessão parecia perfeita, um print por minuto, sem buraco.
     */
    chartClock: {
      type: "object",
      properties: {
        date: { type: ["string", "null"] },
        time: { type: ["string", "null"] },
      },
      required: ["date", "time"],
    },
    /*
     * O CANDLE JÁ FECHADO — sem ele a T4 não confirma nada.
     *
     * O cabeçalho do Profit mostra SEMPRE o candle em formação: em 55 dos 56
     * prints legíveis da sessão de 20/08, `Fch` era idêntico à etiqueta de
     * preço do eixo. Um fechamento estimado pelo último preço erra por ticks, e
     * a tolerância de rompimento é de UM tick. Este campo é a única fonte de
     * fechamento PROVADO, e ele vem do DESENHO do candle anterior.
     */
    lastClosedCandle: {
      type: ["object", "null"],
      properties: {
        time: { type: ["string", "null"] },
        open: RN,
        high: RN,
        low: RN,
        close: RN,
      },
      required: ["time", "open", "high", "low", "close"],
    },
    entry: {
      type: "object",
      properties: { value: { type: ["number", "null"] }, visible: { type: "boolean" } },
      required: ["value", "visible"],
    },
    stop: {
      type: "object",
      properties: { value: { type: ["number", "null"] }, visible: { type: "boolean" } },
      required: ["value", "visible"],
    },
    targets: {
      type: "array",
      items: {
        type: "object",
        properties: { value: { type: ["number", "null"] }, visible: { type: "boolean" } },
        required: ["value", "visible"],
      },
    },
    invalidation: { type: "string" },
    criteria: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          met: { type: "boolean" },
          detail: { type: "string" },
        },
        required: ["id", "label", "met"],
      },
    },
    annotations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: [
              "ENTRY_LINE",
              "ENTRY_ZONE",
              "STOP",
              "TARGET",
              "INVALIDATION",
              "SUPPORT",
              "RESISTANCE",
              "BREAKOUT",
              "PULLBACK",
              "T4_PAST",
              "SCENARIO_ARROW",
              "CONFIRMATION_CANDLE",
              "NOTE",
            ],
          },
          x1: { type: "number" },
          y1: { type: "number" },
          x2: { type: ["number", "null"] },
          y2: { type: ["number", "null"] },
          label: { type: "string" },
          index: { type: ["number", "null"] },
          reason: { type: "string" },
        },
        required: ["kind", "x1", "y1", "label"],
      },
    },
    // Enums importados de @/lib/t4/dna — o vocabulário é ÚNICO na cadeia
    // inteira (motor, print, banco); copiar a lista aqui a deixaria divergir.
    dna: {
      type: ["object", "null"],
      properties: {
        grade: { type: "string", enum: DNA_GRADES },
        trend: { type: "string", enum: DNA_TRENDS },
        position: { type: "string", enum: DNA_POSITIONS },
        pullback: { type: "string", enum: DNA_PULLBACKS },
        triggerCandle: { type: "string", enum: DNA_TRIGGERS },
        volatility: { type: ["string", "null"], enum: [...DNA_VOLATILITIES, null] },
        location: { type: "string", enum: DNA_LOCATIONS },
        movementOrdinal: { type: ["number", "null"], enum: [1, 2, 3, 4, null] },
      },
      required: ["grade", "trend", "position", "pullback", "triggerCandle", "location"],
    },
    scenarios: { type: "array", items: { type: "string" } },
    pastOccurrences: { type: "number" },
    explanation: { type: "string" },
    missingCriteria: { type: "array", items: { type: "string" } },
    imageIssues: { type: "array", items: { type: "string" } },
    nextScreenshot: {
      type: "object",
      properties: {
        requiredNow: { type: "boolean" },
        status: {
          type: "string",
          enum: ["NAO_PRECISA", "AGUARDAR_FECHAMENTO", "ENVIAR_NO_GATILHO", "ENVIAR_AGORA"],
        },
        instruction: { type: "string" },
        preferredTiming: { type: "string", enum: ["AFTER_CANDLE_CLOSE", "IMMEDIATE", "ANY"] },
        triggers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: [
                  "SUPPORT_BREAK",
                  "RESISTANCE_BREAK",
                  "SUPPORT_RETEST",
                  "RESISTANCE_RETEST",
                  "CANDLE_CONFIRMATION",
                  "T4_APPROACH",
                  "T4_PRE_ENTRY",
                  "T4_CONFIRMATION",
                  "STRUCTURE_INVALIDATION",
                  "PULLBACK",
                  "FALSE_BREAKOUT",
                  "TARGET_APPROACH",
                  "STOP_APPROACH",
                  "NEW_STRUCTURE",
                  "WAIT_CANDLE_CLOSE",
                ],
              },
              label: { type: "string" },
              level: {
                type: ["object", "null"],
                properties: { value: { type: ["number", "null"] }, visible: { type: "boolean" } },
              },
              priority: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
              x: { type: ["number", "null"] },
              y: { type: ["number", "null"] },
            },
            required: ["type", "label", "priority"],
          },
        },
      },
      required: ["requiredNow", "status", "instruction", "triggers"],
    },
    priceLevels: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: [
              "SUPORTE",
              "RESISTENCIA",
              "ZONA_VENDA",
              "ZONA_COMPRA",
              "ZONA_ATENCAO",
              "TOPO",
              "FUNDO",
              "PERDA_ESTRUTURAL",
            ],
          },
          label: { type: "string" },
          priceMin: {
            type: "object",
            properties: { value: { type: ["number", "null"] }, visible: { type: "boolean" } },
            required: ["value", "visible"],
          },
          priceMax: {
            type: ["object", "null"],
            properties: { value: { type: ["number", "null"] }, visible: { type: "boolean" } },
            required: ["value", "visible"],
          },
        },
        required: ["kind", "label", "priceMin", "priceMax"],
      },
    },
    // §12 — confianças POR CAMADA: sem elas o gate determinístico de entrada
    // não tem o que medir, e confirmação sem confiança medida não se libera.
    confidences: {
      type: "object",
      properties: {
        contexto: { type: "number" },
        estrutura: { type: "number" },
        t4: { type: "number" },
        entrada: { type: "number" },
      },
      required: ["contexto", "estrutura", "t4", "entrada"],
    },
    conditionalPlans: {
      type: "array",
      items: {
        type: "object",
        properties: {
          trigger: { type: "string" },
          triggerLevel: {
            type: "object",
            properties: { value: { type: ["number", "null"] }, visible: { type: "boolean" } },
            required: ["value", "visible"],
          },
          side: { type: "string", enum: ["COMPRA", "VENDA"] },
          entry: {
            type: "object",
            properties: { value: { type: ["number", "null"] }, visible: { type: "boolean" } },
            required: ["value", "visible"],
          },
          stop: {
            type: "object",
            properties: { value: { type: ["number", "null"] }, visible: { type: "boolean" } },
            required: ["value", "visible"],
          },
          targets: {
            type: "array",
            items: {
              type: "object",
              properties: { value: { type: ["number", "null"] }, visible: { type: "boolean" } },
              required: ["value", "visible"],
            },
          },
          invalidation: { type: "string" },
          rationale: { type: "string" },
        },
        required: ["trigger", "triggerLevel", "side", "entry", "stop", "targets"],
      },
    },
  },
  required: [
    "status",
    "direction",
    "confidence",
    // Ambos aceitam null, e é por isso que podem ser exigidos: "não consegui
    // ler o ativo" é uma resposta, e o modelo tem de dá-la explicitamente.
    "symbol",
    "timeframe",
    // Mesma regra, e por um motivo mais caro: sem relógio do gráfico a
    // identidade do candle cai em Date.now(), que foi medido errado em 18% das
    // transições. "Não li o relógio" precisa ser dito, não omitido.
    "chartClock",
    // Aceita null inteiro ("não consegui ler o candle fechado") — e null aqui
    // BLOQUEIA confirmação de entrada, então o silêncio custa caro e é melhor
    // que um fechamento inventado.
    "lastClosedCandle",
    "entry",
    "stop",
    "annotations",
    "explanation",
    "nextScreenshot",
    // dna é obrigatório mas aceita null: "não classifiquei" é uma AFIRMAÇÃO,
    // não um campo esquecido — a mesma regra dos ReadNumber.
    "dna",
    // Lista vazia é resposta legítima ("nenhum gatilho legível"); ausente não.
    "conditionalPlans",
    "priceLevels",
    // §12: sem as quatro confianças o gate de entrada não tem o que medir.
    "confidences",
  ],
} as const;

/**
 * As regras da técnica vão do SISTEMA para o modelo, nunca o contrário.
 *
 * O modelo não pode "descobrir" uma regra nova e aplicá-la: ele avalia os
 * critérios que este texto define, e reporta quais estão presentes. Uma técnica
 * que muda porque o modelo teve uma ideia deixaria de ser a técnica.
 */
const T4_RULES = `
TÉCNICA T4 — critérios que você deve avaliar, e SOMENTE estes:
1. CONTEXTO: o regime é definido (tendência ou range claro), não indefinido.
2. ESTRUTURA: topos e fundos organizados; existe estrutura legível.
3. LOCALIZAÇÃO: o preço está numa região de referência (POI/suporte/resistência),
   não esticado no meio do movimento.
4. LIQUIDEZ: existe região de liquidez identificável (topo/fundo anterior).
5. REAÇÃO: houve reação visível na região.
6. MUDANÇA DE ESTRUTURA: rompimento de micro estrutura na direção do setup.
7. POI + RETESTE: retorno à região após o rompimento.
8. CANDLE DE CONFIRMAÇÃO: candle fechado confirmando a direção.
9. STOP VÁLIDO: existe nível estrutural de invalidação.
10. RISCO/RETORNO: espaço até o alvo de pelo menos 3x o risco.
`.trim();

const PROMPT = `
Você analisa UM print de gráfico de candles e devolve JSON estruturado.

REGRA ABSOLUTA — NÃO INVENTE NADA.
Se um número não estiver CLARAMENTE legível na imagem, marque "visible": false e
"value": null. Nunca estime, nunca arredonde, nunca complete por aproximação.
Isso vale para preço, entrada, stop, alvo, ativo, timeframe e horário.
Se o ativo ou o timeframe não estiverem escritos na imagem, devolva null.
É MELHOR devolver "não legível" do que um número plausível e errado: quem lê
esta análise pode enviar ordem com base nela.

LEITURA DA ESCALA E DO CABEÇALHO — três erros já vistos em produção:
- A escala do WINFUT usa ponto de MILHAR: "169.875" na escala significa 169875
  pontos. Copie o número COMPLETO como está na escala, nunca um prefixo
  truncado como "169".
- IGNORE o contador regressivo do candle no canto inferior direito (ex.: "35s").
  Ele NÃO é timeframe. Timeframe só do cabeçalho do gráfico (ex.: "WINFUT 1Min");
  se o cabeçalho não estiver legível, devolva null.
- NUNCA informe entrada sem conseguir ler também o stop. Sem stop legível,
  devolva entry com "visible": false.

COORDENADAS.
Toda marcação usa coordenadas NORMALIZADAS de 0 a 1 sobre a imagem enviada:
x=0 é a borda esquerda, x=1 a direita, y=0 o topo, y=1 a base.
As marcações precisam cair exatamente sobre o elemento do gráfico que descrevem.
Linha horizontal de preço: use x1=0, x2=1 e o mesmo y.
Zona: use x1,y1,x2,y2 formando o retângulo.
Seta de cenário: x1,y1 é a origem e x2,y2 a ponta.

${T4_RULES}

DNA DO SETUP (bloco "dna") — classifique SOMENTE o que a imagem sustenta.
As regras estão AQUI: você não cria regra nova nem categoria fora das listas.
- grade: nota da configuração SEGUNDO OS CRITÉRIOS T4 ACIMA. A_PLUS/A =
  critérios obrigatórios claros e visíveis; B = maioria presente; C = leitura
  parcial; DESCARTADA = sem configuração válida. Se o status for SEM_T4,
  T4_INVALIDADA ou INCONCLUSIVO, a grade é obrigatoriamente DESCARTADA.
- trend: FORTE, NORMAL, LATERAL ou TRANSICAO conforme o contexto visível;
  CONTRA quando o setup aponta contra a tendência instalada no gráfico.
- position: A_FAVOR ou CONTRA_TENDENCIA. trend CONTRA implica CONTRA_TENDENCIA.
- pullback: forma da correção visível (CURTO, PROFUNDO, LIMPO, LATERAL,
  AGRESSIVO, FALSO_ROMPIMENTO). Sem correção legível: NAO_IDENTIFICADO.
- triggerCandle: forma do candle de gatilho (FECHAMENTO, ROMPIMENTO, REJEICAO,
  ENGOLFO, FORCA, RETESTE). Sem candle de gatilho claro: NAO_IDENTIFICADO.
- volatility: BAIXA, NORMAL, ALTA ou EXTREMA comparando a amplitude dos candles
  recentes com a dos anteriores NO PRÓPRIO PRINT. Sem base visual: null.
- location: região onde o setup ocorre (SUPORTE, RESISTENCIA, VWAP, MEDIA,
  MAXIMA, MINIMA, ROMPIMENTO, CONSOLIDACAO). VWAP e MEDIA SOMENTE se a linha
  estiver desenhada e identificável no gráfico. Sem região clara: NAO_IDENTIFICADO.
- movementOrdinal: 1, 2 ou 3 quando dá para CONTAR qual T4 do movimento atual
  este setup é; 4 quando é posterior à terceira. Impossível contar: null.
Sem certeza visual numa dimensão, use NAO_IDENTIFICADO ou null NAQUELA dimensão.
Sem setup algum para classificar, devolva "dna": null — nunca um bloco chutado.

STATUS — escolha um:
SEM_T4              nenhuma configuração suficiente
T4_EM_FORMACAO      há elementos, sem confirmação
APROXIMACAO_T4      preço se aproximando de região relevante
PRE_ENTRADA         quase todos os critérios presentes
ENTRADA_CONFIRMADA  critérios obrigatórios atendidos
T4_INVALIDADA       a estrutura perdeu validade
INCONCLUSIVO        imagem insuficiente ou ilegível

Nunca force um sinal. SEM_T4 e INCONCLUSIVO são respostas legítimas e comuns.

VIÉS NÃO É ENTRADA — A REGRA MAIS IMPORTANTE DESTA RESPOSTA.
"direction" é o VIÉS da estrutura (para onde ela pende), NUNCA uma ordem de
operação. Estrutura favorável à compra SEM gatilho executável = direction
COMPRA com status T4_EM_FORMACAO — jamais ENTRADA_CONFIRMADA.
ENTRADA_CONFIRMADA exige TODOS, simultaneamente, VISÍVEIS neste print:
- nível de entrada LEGÍVEL na escala (entry com número);
- stop LEGÍVEL e alvo LEGÍVEL;
- candle FECHADO confirmando além do nível na direção do setup. Rompimento
  apenas por PAVIO NÃO confirma. Candle que rompe e FECHA de volta
  dentro/abaixo da região NÃO confirma — mantenha T4_EM_FORMACAO, ou
  T4_INVALIDADA se a falha de rompimento quebrou a estrutura;
- rompimento válido da estrutura T4 (mudança de estrutura + reteste);
- nenhuma invalidação presente.
Se QUALQUER um faltar, o status certo é T4_EM_FORMACAO ou PRE_ENTRADA.
O sistema verifica esta lista em código depois da sua resposta e REBAIXA
confirmações sem prova — responder "confirmada" sem os itens acima só
gera retrabalho.

CONFIANÇAS POR CAMADA (confidences) — quatro números 0-100, separados:
- contexto: clareza do regime (tendência/range) no print;
- estrutura: legibilidade de topos/fundos e da estrutura;
- t4: aderência da configuração aos critérios T4 acima;
- entrada: evidência de gatilho EXECUTÁVEL AGORA — candle fechado confirmando.
  Sem candle de confirmação fechado, "entrada" DEVE ficar abaixo de 60.
Contexto alto NÃO compra entrada fraca: os números são independentes.

CONFIANÇA (0-100) mede a QUALIDADE DA LEITURA VISUAL — nitidez, escala visível,
quantidade de candles, critérios identificáveis. NÃO é probabilidade de lucro.

QUALIDADE DA IMAGEM: se estiver borrada, cortada, com candles pequenos demais ou
escala ilegível, use INCONCLUSIVO e liste o motivo em imageIssues.

OCORRÊNCIAS PASSADAS: se houver configurações anteriores da mesma técnica
visíveis no MESMO print, marque cada uma com kind "T4_PAST" e index sequencial.

PRÓXIMO PRINT (nextScreenshot) — diga QUANDO o operador deve enviar nova captura:
- NAO_PRECISA: a estrutura não mudou e nada específico está sendo aguardado.
- AGUARDAR_FECHAMENTO: há movimento importante, mas o candle precisa fechar.
- ENVIAR_NO_GATILHO: existe região específica sendo monitorada (liste os gatilhos).
- ENVIAR_AGORA: o próprio print já mostra alteração que exige nova avaliação.
NÃO peça print sem mudança relevante: pedir captura a cada candle é ruído.
Se o timeframe estiver identificado, prefira preferredTiming AFTER_CANDLE_CLOSE
e diga na instrução (ex.: "após o fechamento do candle de 5 min que romper a região").
Cada gatilho usa um dos tipos permitidos, com label curto e prioridade.
Inclua x,y (0-1) apontando a região a observar QUANDO ela existir no gráfico.
level só com número CLARAMENTE legível — senão value null e visible false.
Liste SOMENTE gatilhos que a análise atual realmente detectou; nada genérico.

PREÇO ATUAL (currentPrice): a etiqueta destacada do último preço no eixo
(a caixinha preta/branca à direita). Quase sempre legível — copie o número
exato; ilegível ⇒ visible false. NUNCA estime.

RELÓGIO DO GRÁFICO (chartClock) — LEIA DENTRO DA IMAGEM, NÃO SUPONHA.
Procure a data e a hora escritas na própria janela do Profit: normalmente na
barra de abas, no canto superior direito, no formato "20/08/2026 10:31".
- date: "AAAA-MM-DD"; time: "HH:MM". Ilegível ⇒ null (cada um por si).
- É o relógio DA IMAGEM. Não use o horário em que você está respondendo, não
  converta fuso, não complete com o "agora". Se a barra estiver cortada fora
  do enquadramento, devolva null — o sistema sabe lidar com isso, e não sabe
  lidar com um horário inventado.

CANDLE JÁ FECHADO (lastClosedCandle) — O ÚLTIMO QUE TERMINOU, NÃO O ATUAL.
Este é o campo mais importante desta leitura e o mais fácil de errar.

O cabeçalho do gráfico ("Abr … Máx … Mín … Fch …") mostra o candle EM
FORMAÇÃO — o que ainda está andando na borda direita, ou o que estiver sob o
cursor do mouse. NÃO É ELE que se pede aqui.

O que se pede é o candle IMEDIATAMENTE À ESQUERDA do último: aquele que já
terminou e não muda mais. Leia-o pelo DESENHO:
- open  = onde o corpo começa (topo do corpo se vermelho, base se verde);
- close = onde o corpo termina (base do corpo se vermelho, topo se verde);
- high  = ponta do pavio superior;  low = ponta do pavio inferior.
Converta cada altura em PREÇO pela escala do eixo da direita, do mesmo jeito
que faz com os níveis. Cada campo é {value, visible}: o que você não conseguir
determinar vai com visible false — nunca com o número do candle atual.

time: o horário DESSE candle ("HH:MM"), lido no eixo de tempo quando visível.
Se você não identificar com segurança qual candle é o último fechado, devolva
lastClosedCandle: null inteiro. Null aqui apenas impede a confirmação de
entrada; um fechamento errado gera uma ordem errada.

NÍVEIS DE PREÇO (priceLevels) — A LEITURA COMPLETA DO GRÁFICO, EM PREÇOS.
Liste TODO nível relevante que você consegue LER na escala, como PREÇO —
nunca como posição na imagem:
- ZONA_VENDA / ZONA_COMPRA: zonas de oferta/demanda institucionais, com
  priceMin e priceMax (faixa), label curto ("Topo institucional / liquidez");
- SUPORTE / RESISTENCIA: níveis horizontais respeitados, com faixa quando a
  região tem espessura visível;
- ZONA_ATENCAO: região de reteste/decisão que merece observação;
- TOPO / FUNDO: extremos estruturais nomeados, priceMax null (nível único);
- PERDA_ESTRUTURAL: o preço cujo rompimento invalida a estrutura atual.
Preço que você não consegue ler na escala ⇒ visible false — o nível é
descartado com o motivo dito, e isso é o comportamento certo. O sistema
posiciona cada nível pela ESCALA LIDA do print; sua responsabilidade é o
NÚMERO e o NOME, nunca o pixel.

MARCAÇÕES (annotations) — ANÁLISE SEM MARCAÇÃO É ANÁLISE INCOMPLETA.
Tudo que você identificou no TEXTO precisa existir como marcação no GRÁFICO:
- suporte e resistência relevantes: kind SUPPORT/RESISTANCE, linha de x1=0 a
  x2=1 na altura do nível, label com o preço quando legível;
- região de interesse/reteste: ENTRY_ZONE (retângulo), nunca só uma nota;
- rompimento identificado: BREAKOUT posicionado no candle do rompimento;
- rejeição/pavio relevante: NOTE no ponto exato, dizendo o que rejeitou;
- T4 anteriores visíveis: T4_PAST numeradas (index 1, 2, …);
- cenário condicional: SCENARIO_ARROW da região atual para a região-alvo;
- CANDLE DE CONFIRMAÇÃO: use kind CONFIRMATION_CANDLE com x1,y1 EXATAMENTE
  sobre o corpo do candle FECHADO que confirmou o rompimento, e SOMENTE quando
  o status for ENTRADA_CONFIRMADA. Sem esse candle fechado no print, NÃO emita
  esta marcação — o sistema a remove junto com a confirmação, e uma seta de
  entrada sobre setup não confirmado é o pior erro possível nesta tela.
As linhas de ENTRADA/STOP/ALVO/ZONA são REPOSICIONADAS pelo sistema usando a
escala lida do print — sua responsabilidade nelas é o NÚMERO correto no campo
correspondente (entry/stop/targets), não o pixel.

CENÁRIOS: escreva condicionais ("se romper X e confirmar, cenário comprador"),
nunca afirmações de que o preço vai seguir.

PLANO CONDICIONAL (conditionalPlans) — A PARTE MAIS ÚTIL DA SUA RESPOSTA.
O operador precisa saber O QUE OBSERVAR e O QUE FAZER SE ACONTECER. Mesmo sem
entrada agora — inclusive em SEM_T4, T4_EM_FORMACAO e APROXIMACAO_T4 — devolva
até DOIS planos no formato SE → ENTÃO, um para cada lado quando fizer sentido.

Cada plano precisa de:
- trigger: o evento, em uma frase direta ("fechamento de candle acima do topo").
- triggerLevel: o PREÇO desse gatilho, lido na escala do gráfico.
- side: COMPRA se o gatilho aponta para cima, VENDA se aponta para baixo.
- entry: onde entrar quando acionar (pode ser o próprio nível do gatilho).
- stop: onde a leitura está errada. Na COMPRA fica ABAIXO da entrada; na VENDA,
  ACIMA. Um stop do lado errado invalida o plano inteiro.
- targets: alvos na direção do lado (acima na compra, abaixo na venda).
- invalidation: o que mata o plano ANTES de acionar.
- rationale: por que este gatilho — a estrutura que o sustenta.

REGRA QUE NÃO SE QUEBRA: use os preços da ESCALA VISÍVEL do gráfico. Se você
não consegue ler o nível do gatilho ou o stop na escala, devolva
conditionalPlans: [] — lista vazia é resposta correta e honesta. NUNCA estime
um nível para preencher o plano: um plano com número inventado é pior que
nenhum plano, porque parece instrução operacional e leva a ordem errada.
`.trim();

function imageBase64(dataUrl: string): string | null {
  const match = /^data:image\/(?:png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  return match?.[1] ?? null;
}

function fail(model: string, error: string, latencyMs = 0): ChartVisionResult {
  return { ok: false, analysis: null, model, error, repairs: [], latencyMs };
}

/**
 * Analisa o print.
 *
 * Uma tentativa de reparo é permitida quando o JSON volta fora do contrato: o
 * modelo recebe o erro e reescreve. Duas seriam insistência — se ele não
 * respeita o schema com o erro na mão, o problema não é a formulação.
 */
export async function analyzeChartPrint(
  dataUrl: string,
  question?: string,
): Promise<ChartVisionResult> {
  const config = aiConfig();
  const model = config.visionModel;
  const startedAt = Date.now();

  if (!config.baseUrl || config.provider !== "ollama") {
    return fail(model, "ANÁLISE IA INDISPONÍVEL — provedor de visão não configurado.");
  }
  if (!model) {
    return fail("", "ANÁLISE IA INDISPONÍVEL — defina OLLAMA_VISION_MODEL no servidor.");
  }
  const image = imageBase64(dataUrl);
  if (!image) {
    return fail(model, "Imagem inválida: envie PNG, JPG ou WebP.");
  }

  const pedir = async (extra: string): Promise<{ raw: string }> => {
    const response = await aiBreaker.run(() =>
      fetch(`${config.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(config.timeoutMs),
        body: JSON.stringify({
          model,
          stream: false,
          think: false,
          keep_alive: KEEP_ALIVE,
          format: RESPONSE_FORMAT,
          options: { temperature: 0 },
          messages: [
            {
              role: "user",
              content: `${PROMPT}${question ? `\n\nPERGUNTA DO OPERADOR: ${question}` : ""}${extra}`,
              images: [image],
            },
          ],
        }),
      }).then(async (r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r;
      }),
    );
    const payload = (await response.json()) as { message?: { content?: string } };
    return { raw: payload.message?.content?.trim() ?? "" };
  };

  try {
    // Tempo SÓ das chamadas de visão — o auditor é medido à parte, senão o
    // diagnóstico não sabe dizer qual dos dois consumiu o minuto.
    const visaoComecou = Date.now();
    let { raw } = await pedir("");
    let extraido = extractJsonObject(raw);
    let resultado: ValidationResult = extraido
      ? validatePrintAnalysis(extraido)
      : { ok: false, analysis: null, problem: "resposta sem JSON", repairs: [] };

    // UMA tentativa de reparo, com o erro na mão do modelo. Ela CUSTA uma
    // inferência inteira — por isso é contada e reportada, não escondida.
    let retryCount = 0;
    if (!resultado.ok) {
      retryCount += 1;
      ({ raw } = await pedir(
        `\n\nSua resposta anterior foi recusada: ${resultado.problem}. Responda de novo, respeitando exatamente o schema.`,
      ));
      extraido = extractJsonObject(raw);
      resultado = extraido
        ? validatePrintAnalysis(extraido)
        : { ok: false, analysis: null, problem: "resposta sem JSON", repairs: [] };
    }

    if (!resultado.ok || !resultado.analysis) {
      // Erro controlado: NUNCA uma operação inventada para preencher a tela.
      return fail(
        model,
        `A IA não devolveu uma análise válida. ${resultado.problem ?? ""}`.trim(),
        Date.now() - startedAt,
      );
    }

    /*
     * AUDITOR IA (§11) — SOBERANO, mas nem sempre no caminho crítico.
     *
     * Ele é uma inferência inteira. Esperá-lo SEMPRE dobrava o tempo até a
     * tela, inclusive quando não havia nada que ele pudesse liberar ou barrar
     * de imediato. A divisão:
     *
     *  BLOQUEANTE quando a análise pode LIBERAR ENTRADA (ENTRADA_CONFIRMADA ou
     *  PRE_ENTRADA). Aqui o carimbo é pré-requisito: sem ele o gate não pode
     *  decidir, e a trava `entradaConfirmada` continua exigindo exatamente o
     *  mesmo de antes — nada foi enfraquecido.
     *
     *  ADIADO quando a análise só descreve viés (formação, aproximação) e o
     *  modelo apontou um lado. O auditor ainda roda — é ele que pega a
     *  contradição "COMPRA com estrutura de baixa" — mas em segundo plano,
     *  atualizando o card depois em vez de segurar a tela.
     *
     *  DISPENSADO quando não há lado nenhum (direção NEUTRO): não existe
     *  direção para contradizer nem entrada para liberar, e gastar uma
     *  inferência ali é queimar GPU para confirmar o nada.
     */
    const visionMs = Date.now() - visaoComecou;
    const modo = auditModeFor(resultado.analysis);
    let auditMs: number | null = null;
    if (modo === "BLOQUEANTE") {
      const t0 = Date.now();
      resultado.analysis.audit = await auditChartAnalysis(dataUrl, resultado.analysis);
      auditMs = Date.now() - t0;
    }

    /*
     * A TRAVA DA CONFIRMAÇÃO RODA DE NOVO — o auditor é uma prova NOVA.
     *
     * A validação já aplicou o gate, mas naquele momento `audit` era null (o
     * auditor ainda não tinha rodado). Uma reprovação que chega agora precisa
     * rebaixar o status também: sem esta segunda passada, uma análise
     * reprovada continuaria ENTRADA_CONFIRMADA no objeto que vai para o
     * banco, para a máquina de setup e para a tela.
     */
    const reparosPosAuditoria = applyConfirmationGate(resultado.analysis);

    return {
      ok: true,
      analysis: resultado.analysis,
      model,
      error: null,
      repairs: [...resultado.repairs, ...reparosPosAuditoria],
      // Medido DEPOIS do auditor: latencyMs é o tempo total até a resposta
      // completa, com a segunda passada somada — esconder essa espera faria o
      // painel de diagnóstico subestimar o custo real da análise.
      latencyMs: Date.now() - startedAt,
      auditMode: modo,
      auditMs,
      visionMs: visionMs,
      retryCount,
    };
  } catch (error) {
    return fail(
      model,
      sanitizeSecrets(describeAIError(error, model, config.timeoutMs)),
      Date.now() - startedAt,
    );
  }
}

/** O bloco que a auditoria devolve — o MESMO tipo nullable do contrato
 * (printAnalysis.ts), nunca uma cópia local que pudesse divergir em silêncio. */
type PrintAudit = NonNullable<PrintAnalysis["audit"]>;

/**
 * FORMATO FORÇADO DO AUDITOR — dois campos, de propósito.
 *
 * O auditor não reescreve a análise nem devolve níveis: qualquer campo a mais
 * seria uma segunda análise competindo com a primeira, e a tela não saberia
 * qual desenhar. Ele responde UMA pergunta — "esta análise sobrevive à
 * imagem?" — e lista os defeitos quando não sobrevive.
 */
const AUDIT_RESPONSE_FORMAT = {
  type: "object",
  properties: {
    approved: { type: "boolean" },
    issues: { type: "array", items: { type: "string" } },
    // Sinal ESTRUTURADO do defeito nº 2: a consequência dele é bloquear a
    // direção na origem, e isso não pode depender de interpretar prosa.
    directionContradicted: { type: "boolean" },
  },
  required: ["approved", "issues", "directionContradicted"],
} as const;

/**
 * O prompt do REVISOR ADVERSARIAL.
 *
 * A missão é o oposto da primeira passada: não descrever o gráfico, e sim
 * procurar o defeito na descrição que já existe. Revisor instruído a "avaliar"
 * tende a concordar; instruído a REPROVAR, ele só aprova quando não acha
 * defeito — e é exatamente essa assimetria que o §11 exige.
 */
const AUDIT_PROMPT = `
Você é um REVISOR ADVERSARIAL. Outra IA analisou o print de gráfico em anexo e
o resumo do que ela AFIRMOU está abaixo. Sua tarefa é tentar REPROVAR essa
análise, comparando cada afirmação com o que está REALMENTE visível na imagem.

REPROVE ("approved": false) se encontrar QUALQUER um destes defeitos:
1. A conclusão afirmada não aparece na imagem.
2. A direção contradiz a estrutura visível (ex.: COMPRA com topos e fundos
   descendentes).
3. As marcações (overlay) não condizem com o texto da análise.
4. Entrada, stop ou alvo incoerentes com o lado (ex.: stop acima da entrada
   numa compra; alvo abaixo da entrada numa compra).
5. Um número afirmado como lido não está claramente legível na imagem.
6. Contradição interna entre os campos do resumo.
7. O movimento já está excessivamente esticado, sem reteste, e a análise ainda
   sugere entrada.
8. A análise afirma ENTRADA_CONFIRMADA sem que a imagem mostre um CANDLE
   FECHADO confirmando o rompimento na direção do setup — pavio atravessando o
   nível, ou candle que rompeu e fechou de volta dentro da região, NÃO
   confirmam entrada.
9. A análise afirma ENTRADA_CONFIRMADA mas entrada, stop ou alvo aparecem como
   não legíveis: confirmação sobre número que ninguém leu é falso positivo.

APROVAR NÃO É ELOGIAR. "approved": true significa somente que você procurou
defeitos e não encontrou nenhum. Não escreva elogio, ressalva vaga nem
sugestão de melhoria em "issues" — só defeito concreto.

Cada issue é UMA frase específica apontando o defeito (ex.: "stop acima da
entrada numa compra"). No máximo 8 issues. Reprovação exige pelo menos uma
issue; aprovação exige "issues" vazio.

CAMPO "directionContradicted" — responda com cuidado, a consequência é dura.
Marque true SOMENTE quando a ESTRUTURA VISÍVEL no gráfico aponta para o lado
CONTRÁRIO ao afirmado pela análise (ex.: análise diz COMPRA e o gráfico mostra
topos e fundos DESCENDENTES; análise diz VENDA num gráfico de altas sucessivas).
Marque false quando o defeito for de outra natureza — nível ilegível, stop no
lado errado, marcação incoerente, movimento esticado. Esses reprovam a análise
sem negar o lado.
Quando true, o sistema BLOQUEIA aquela direção inteira e volta o viés para
NEUTRO. Ele NÃO inverte para o lado oposto: se você acha que o lado certo é o
contrário, diga isso numa issue — inverter sozinho seria criar um sinal que
ninguém leu no gráfico.
Aprovação (approved true) exige directionContradicted false.

RESUMO DA ANÁLISE SOB REVISÃO:
`.trim();

/** Nível como o operador o verá: o número lido, ou a ausência DITA. */
function nivelLegivel(n: ReadNumber): string {
  return n.visible && n.value !== null ? String(n.value) : NAO_LEGIVEL;
}

/**
 * O resumo que o auditor recebe — o QUE FOI AFIRMADO, não o JSON inteiro.
 *
 * Mandar a análise completa afogaria o revisor em campos que ele não tem como
 * conferir contra a imagem (coordenadas, gatilhos, planos) e o empurraria a
 * reler prosa em vez de olhar o gráfico. Entram só as afirmações verificáveis:
 * conclusão, lado, níveis, preço atual, marcações (até 8) e a explicação.
 */
function resumoParaAuditoria(analysis: PrintAnalysis): string {
  const alvos =
    analysis.targets.length > 0 ? analysis.targets.map(nivelLegivel).join(", ") : "nenhum";
  const marcacoes =
    analysis.annotations.length > 0
      ? analysis.annotations
          .slice(0, 8)
          .map((a) => `${a.kind} "${a.label}"`)
          .join("; ")
      : "nenhuma";
  return [
    `- status: ${analysis.status}`,
    `- direção: ${analysis.direction}`,
    `- entrada: ${nivelLegivel(analysis.entry)}`,
    `- stop: ${nivelLegivel(analysis.stop)}`,
    `- alvos: ${alvos}`,
    `- preço atual: ${nivelLegivel(analysis.currentPrice)}`,
    `- marcações: ${marcacoes}`,
    `- explicação: ${analysis.explanation || "(sem explicação)"}`,
  ].join("\n");
}

/**
 * AUDITOR IA (§11) — segunda passada do MESMO provedor tentando REPROVAR.
 *
 * Devolve null em QUALQUER falha: provedor fora, timeout, breaker aberto,
 * JSON inválido, reprovação sem motivo. Null significa "não auditado" — o
 * auditor ausente NUNCA derruba uma análise válida, e quem decide o que fazer
 * com a ausência do carimbo é o chamador, não este módulo.
 */
export async function auditChartAnalysis(
  imageDataUrl: string,
  analysis: PrintAnalysis,
): Promise<PrintAudit | null> {
  const config = aiConfig();
  const model = config.visionModel;
  if (!config.baseUrl || config.provider !== "ollama" || !model) return null;
  const image = imageBase64(imageDataUrl);
  if (!image) return null;

  try {
    const response = await aiBreaker.run(() =>
      fetch(`${config.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(config.timeoutMs),
        body: JSON.stringify({
          model,
          stream: false,
          think: false,
          keep_alive: KEEP_ALIVE,
          format: AUDIT_RESPONSE_FORMAT,
          options: { temperature: 0 },
          messages: [
            {
              role: "user",
              content: `${AUDIT_PROMPT}\n${resumoParaAuditoria(analysis)}`,
              images: [image],
            },
          ],
        }),
      }).then(async (r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r;
      }),
    );
    const payload = (await response.json()) as { message?: { content?: string } };
    const extraido = extractJsonObject(payload.message?.content?.trim() ?? "");
    if (extraido === null || typeof extraido !== "object") return null;

    const bruto = extraido as {
      approved?: unknown;
      issues?: unknown;
      directionContradicted?: unknown;
    };
    if (typeof bruto.approved !== "boolean") return null;
    // Máx. 8 issues, cada uma dentro dos 200 chars do contrato — o corte é
    // feito AQUI porque este bloco entra em PrintAnalysis sem passar pelo zod.
    const issues = Array.isArray(bruto.issues)
      ? bruto.issues
          .filter((issue): issue is string => typeof issue === "string" && issue.trim().length > 0)
          .map((issue) => issue.trim().slice(0, 200))
          .slice(0, 8)
      : [];
    // Estado de falha sem motivo não existe nesta casa: reprovar sem apontar
    // defeito é ruído, e ruído vira null — nunca um carimbo de reprovação vazio
    // que rebaixaria a análise sem dizer por quê.
    if (!bruto.approved && issues.length === 0) return null;

    /*
     * APROVADO NÃO PODE CONTRADIZER A DIREÇÃO — se o revisor marcou os dois,
     * ele se contradisse, e a contradição resolve para o lado SEGURO: vale a
     * negação da direção. Aprovar aqui deixaria passar exatamente o defeito
     * que este campo existe para pegar.
     */
    const directionContradicted = bruto.directionContradicted === true;
    const approved = bruto.approved && !directionContradicted;

    // Reprovar sem motivo dito não existe nesta casa. Quando o revisor marca a
    // contradição e esquece a issue, o próprio campo vira o motivo — não é
    // motivo inventado, é o que ele afirmou em forma de frase.
    if (!approved && issues.length === 0) {
      issues.push("estrutura visível contradiz a direção afirmada pela análise");
    }

    return { approved, issues, checkedAt: Date.now(), directionContradicted };
  } catch {
    // Falha de IA não derruba nada: a análise segue sem o carimbo do auditor.
    return null;
  }
}

export interface PrintChatResult {
  ok: boolean;
  answer: string | null;
  model: string;
  error: string | null;
  latencyMs: number;
}

/**
 * PERGUNTAR SOBRE O PRINT — chat contextual da análise.
 *
 * O modelo recebe a MESMA imagem e a análise validada como contexto, e responde
 * em texto. Texto aqui é seguro porque a resposta é EXPLICAÇÃO, nunca desenho:
 * nada do que sair deste canal vira traço no overlay nem nível em card — esses
 * continuam vindo só da análise estruturada. As duas superfícies não se
 * misturam, e é isso que permite uma ser prosa e a outra não.
 */
export async function askAboutChartPrint(
  dataUrl: string,
  analysisJson: string,
  question: string,
): Promise<PrintChatResult> {
  const config = aiConfig();
  const model = config.visionModel;
  const startedAt = Date.now();

  if (!config.baseUrl || config.provider !== "ollama" || !model) {
    return {
      ok: false,
      answer: null,
      model,
      error: "ANÁLISE IA INDISPONÍVEL — provedor de visão não configurado.",
      latencyMs: 0,
    };
  }
  const image = imageBase64(dataUrl);
  if (!image) {
    return { ok: false, answer: null, model, error: "Imagem inválida.", latencyMs: 0 };
  }

  try {
    const response = await aiBreaker.run(() =>
      fetch(`${config.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(config.timeoutMs),
        body: JSON.stringify({
          model,
          stream: false,
          think: false,
          keep_alive: KEEP_ALIVE,
          options: { temperature: 0 },
          messages: [
            {
              role: "user",
              content: [
                "Você responde perguntas sobre UMA análise de print de gráfico já concluída.",
                "A análise estruturada (única fonte dos níveis e marcações) é esta:",
                analysisJson,
                "",
                "REGRAS: responda em português, direto, em até 120 palavras.",
                "Não invente números: se um preço não estiver na análise nem legível na",
                "imagem, diga 'não legível no print'. Não crie novos níveis nem novas",
                "marcações — explique as que existem. Cenários são condicionais, nunca",
                "promessa de movimento.",
                "",
                `PERGUNTA: ${question}`,
              ].join("\n"),
              images: [image],
            },
          ],
        }),
      }).then(async (r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r;
      }),
    );
    const payload = (await response.json()) as { message?: { content?: string } };
    const answer = payload.message?.content?.trim() ?? "";
    const latencyMs = Date.now() - startedAt;
    if (!answer) {
      return { ok: false, answer: null, model, error: "O modelo não respondeu.", latencyMs };
    }
    return { ok: true, answer, model, error: null, latencyMs };
  } catch (error) {
    return {
      ok: false,
      answer: null,
      model,
      error: sanitizeSecrets(describeAIError(error, model, config.timeoutMs)),
      latencyMs: Date.now() - startedAt,
    };
  }
}
