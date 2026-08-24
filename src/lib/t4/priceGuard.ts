/**
 * NENHUM PREÇO ABSOLUTO SEM ESCALA VALIDADA.
 *
 * O DEFEITO, OBSERVADO AO VIVO: a tela dizia "Preços exatos indisponíveis —
 * escala ainda em calibração" e, ao lado, publicava "Entrada 640.21 · stop
 * 496.00 · parcial 1072.86 · alvo 1361.29". Aqueles números são reais, mas não
 * são PREÇOS: são coordenadas de pixel do gráfico. Um operador que digitasse
 * 640.21 numa boleta de WINFUT estaria mandando ordem em cima de uma linha da
 * tela.
 *
 * Por que eles existem: quando a escala não está calibrada, os candles saem em
 * unidade RELATIVA de pixel. Toda a leitura estrutural continua correta nessa
 * unidade — tendência, rompimento, R:R e proporções são invariantes a escala —
 * e é por isso que a T4 pode (e deve) analisar sem esperar o OCR. O que NÃO
 * sobrevive à mudança de unidade é o número absoluto.
 *
 * A FRONTEIRA É AQUI, E É SÓ AQUI.
 * Este módulo não toca em gate, não toca em estágio, não toca em direção e não
 * altera nenhuma decisão da técnica. Ele apaga os CAMPOS DE PREÇO no ponto em
 * que eles deixariam o motor e virariam número na tela, no log ou no chat. O
 * setup continua armando, a maturidade continua subindo e a pré-entrada
 * continua nascendo antes do gatilho — apenas sem número inventado junto.
 *
 * O que sobrevive sem escala, de propósito:
 *   - direção, estágio, maturidade, gates, motivo de bloqueio;
 *   - R:R e proporções (são razões: não dependem da unidade);
 *   - a frase PREÇOS EM CALIBRAÇÃO, que é a informação honesta do momento.
 */

import type { DecisionObject } from "@/lib/engines/backtestDecisionEngine";
import type { T4Operation } from "./preEntry";

export const PRICE_GUARD_LABEL = "PREÇOS EM CALIBRAÇÃO" as const;

/**
 * Erro de PROGRAMAÇÃO, não de operação.
 *
 * Se algum caminho novo tentar publicar preço sem escala, isto estoura em
 * desenvolvimento e nos testes em vez de virar um número plausível na tela do
 * operador. Em produção o valor é apenas descartado — derrubar a leitura por
 * causa de um campo de exibição seria pior que a doença.
 */
export class AbsolutePriceWithoutScaleError extends Error {
  constructor(context: string) {
    super(
      `Preço absoluto publicado sem escala validada (${context}). ` +
        "Enquanto priceScaleReady=false, os valores são coordenadas de pixel — não preços.",
    );
    this.name = "AbsolutePriceWithoutScaleError";
  }
}

/**
 * Porta única por onde um número vira preço exibível.
 *
 * Devolve `null` — nunca o valor cru — quando a escala não está pronta.
 */
export function absolutePrice(
  value: number | null | undefined,
  priceScaleReady: boolean,
  context: string,
): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  if (priceScaleReady) return value;
  if (import.meta.env?.DEV) throw new AbsolutePriceWithoutScaleError(context);
  return null;
}

/**
 * Apaga os níveis da operação quando a escala não está validada.
 *
 * ESTÁGIO, DIREÇÃO E MATURIDADE PASSAM INTACTOS. É essa separação que permite
 * "PRE_ENTRY_ARMED · VENDA · 90% · PREÇOS EM CALIBRAÇÃO": o operador sabe que o
 * setup está pronto e sabe que ainda não pode ler número — que é exatamente o
 * estado real do sistema naquele instante.
 */
export function guardOperation(operation: T4Operation, priceScaleReady: boolean): T4Operation {
  if (priceScaleReady) return operation;
  return {
    ...operation,
    entry: null,
    entryZone: null,
    stop: null,
    partial: null,
    target: null,
    // Pontos de risco/retorno são DIFERENÇAS de preço: em pixel, não são pontos.
    riskPoints: null,
    rewardPoints: null,
    // A razão sobrevive: R:R é adimensional e não muda com a unidade.
    riskReward: operation.riskReward,
    // Contratos vêm de risco em DINHEIRO, que vem de pontos. Sem pontos reais,
    // qualquer número aqui seria um tamanho de posição inventado.
    contracts: null,
    // A frase de invalidação cita o stop: sem stop real, ela citaria pixel.
    invalidation:
      operation.direction === null
        ? operation.invalidation
        : `${PRICE_GUARD_LABEL} — invalidação estrutural definida, nível exato indisponível`,
    /*
     * AQUI ESTAVA O BURACO.
     *
     * `reasons` e `missing` são o detalhe dos gates, copiados verbatim em
     * `preEntry`. O gate STOP_VALID grava "stop ${plan.stop} · distância ..." —
     * com o preço absoluto, sem sequer arredondar. O card renderiza a lista
     * inteira, sem consultar a escala. Resultado: a coordenada de pixel que
     * estes campos existem para apagar reaparecia dois blocos abaixo do aviso
     * de que o preço não estava calibrado.
     *
     * Apagar a lista seria perder a explicação do bloqueio, que é útil e
     * legítima — o que não pode aparecer é o NÚMERO.
     */
    reasons: guardLines(operation.reasons, priceScaleReady),
    missing: guardLines(operation.missing, priceScaleReady),
    blockReason:
      operation.blockReason === null
        ? null
        : guardNarration(operation.blockReason, priceScaleReady),
  };
}

/**
 * Mesma regra para a decisão publicada.
 *
 * A decisão CRUA continua existindo dentro do motor: os gates comparam
 * proporções e precisam dela. O que sai daqui é a versão que a UI, o chat e o
 * registro podem ver.
 */
export function guardDecision(
  decision: DecisionObject | null,
  priceScaleReady: boolean,
): DecisionObject | null {
  if (decision === null || priceScaleReady) return decision;
  return {
    ...decision,
    entryPrice: null,
    stopPrice: null,
    partialPrice: null,
    targetPrice: null,
    riskPoints: null,
    rewardPoints: null,
    recommendedContracts: null,
  };
}

/**
 * Varredura de TEXTO — a rede que pega o canal que ninguém previu.
 *
 * A primeira versão da guarda cobria campos numéricos e deixou passar o que
 * importava: o preço formatado DENTRO de uma frase. Auditando a produção, ele
 * saía por pelo menos quatro canais que nenhuma guarda de campo alcançava:
 *
 *   gate STOP_VALID       "stop 496.0032958984375 · distância 144.21"
 *   motor adversarial     "liquidez=295.00 entre entrada 303.00 e parcial 141.74"
 *   label do SMS          nível rompido em pixel
 *   região do POI         faixa de preços em pixel
 *
 * Todos viravam string no motor e eram renderizados como texto explicativo — na
 * mesma tela que anunciava "escala em calibração", dois blocos abaixo.
 *
 * A lista de termos é deliberadamente ampla e o casamento é por PALAVRA seguida
 * de número. Falso positivo aqui custa uma frase menos precisa; falso negativo
 * custa um preço inventado na tela de quem vai operar.
 */
/**
 * Número precedido de um termo que o identifica como nível de preço.
 *
 * Inclui as chaves em estilo de máquina que os motores usam na evidência —
 * `stopDistance=382.13` saiu na tela ao vivo por não estar nesta lista. NÃO
 * inclui `poiStrength` nem `ratio`: são pontuação e proporção, não preço, e
 * apagá-los esconderia informação legítima.
 */
const PRICE_AFTER_TERM =
  /\b(entrada|entry|entryPrice|stop|stopPrice|stopDistance|stopdistance|parcial|partial|alvo|target|targetPrice|preço|preco|price|liquidez|liquidity|nível|nivel|level|rompimento|topo|fundo|máxima|maxima|mínima|minima|distância|distancia)\b(\s*[:=]?\s*(?:de\s+|em\s+)?)(-?\d[\d.,]*)/gi;

/**
 * Número precedido de PREPOSIÇÃO DE POSIÇÃO.
 *
 * Este segundo passo veio de um caso que o primeiro deixou passar:
 * "aguardando fechamento acima de 640.21". O número não segue nenhum termo de
 * preço — segue um "acima de". Descrever POSIÇÃO em relação a um nível é a
 * outra forma de publicar esse nível, e é tão perigosa quanto nomeá-lo.
 */
const PRICE_AFTER_POSITION =
  /\b(acima|abaixo|até|ate|sobre|cruzar|romper|perder|superar|tocar)\b(\s+(?:de\s+|d[oa]s?\s+|em\s+)?)(-?\d[\d.,]*)/gi;

export function guardNarration(text: string, priceScaleReady: boolean): string {
  if (priceScaleReady) return text;
  return text
    .replace(
      PRICE_AFTER_TERM,
      (_m, term: string, sep: string) => `${term}${sep}${PRICE_GUARD_LABEL}`,
    )
    .replace(
      PRICE_AFTER_POSITION,
      (_m, term: string, sep: string) => `${term}${sep}${PRICE_GUARD_LABEL}`,
    );
}

/** Aplica a varredura a uma lista, preservando ordem e tamanho. */
export function guardLines(lines: string[], priceScaleReady: boolean): string[] {
  if (priceScaleReady) return lines;
  return lines.map((line) => guardNarration(line, priceScaleReady));
}

/**
 * Região do gráfico citada por uma evidência.
 *
 * O caso que escapou de tudo: `chartRegion` do POI é um INTERVALO PURO —
 * "194.00–197.00" —, sem nenhum termo antes que o identifique como preço. As
 * varreduras por termo e por preposição não têm como pegá-lo, e ele aparecia na
 * tabela de evidências com a escala em calibração.
 *
 * A regra é estreita de propósito: só um intervalo numérico sozinho, do começo
 * ao fim do texto. "faixa e estrutura visíveis" e "liquidez abaixo" — as outras
 * regiões, que são descritivas — passam intactas.
 */
const BARE_RANGE = /^\s*-?\d[\d.,]*\s*[–—-]\s*-?\d[\d.,]*\s*$/;

export function guardRegion(region: string, priceScaleReady: boolean): string {
  if (priceScaleReady) return region;
  if (BARE_RANGE.test(region)) return PRICE_GUARD_LABEL;
  return guardNarration(region, priceScaleReady);
}
