import { PRODUCTION_MANAGEMENT } from "@/lib/t4/management";
/**
 * BIBLIOTECA DE CONHECIMENTO DE TRADING (comando de expansão, Parte 2).
 *
 * Cada técnica catalogada tem: origem rastreável (escola/autor, pesquisado em
 * fontes públicas), contexto exigido, gatilho objetivo, invalidação e alvo.
 *
 * HONESTIDADE DE DETECÇÃO: `status` declara o que o motor ATUAL consegue
 * medir. "DETECTABLE" = as condições são verificáveis com os sinais reais do
 * pipeline (captura de liquidez, SMS, POI, regime, fases Wyckoff, sequência
 * causal). "CATALOGED" = a técnica está formalizada, mas exige dados que a
 * captura visual não fornece (tape/book/delta/volume real, histórico do dia
 * anterior, contagem de pernas) — `requiredData` diz exatamente o que falta.
 * Uma técnica catalogada NUNCA é "detectada" nem pontua.
 */

export type TechniqueCategory = "wyckoff" | "smc_ict" | "price_action" | "order_flow" | "gestao";

export type TechniqueStatus = "DETECTABLE" | "CATALOGED" | "DISABLED";

export interface Technique {
  id: string;
  name: string;
  category: TechniqueCategory;
  /** Escola/autor de origem — rastreabilidade do conhecimento. */
  origin: string;
  /** Contexto de mercado exigido (regime/fase/estrutura). */
  context: string;
  /** Gatilho em regras objetivas e mensuráveis. */
  trigger: string;
  invalidation: string;
  target: string;
  status: TechniqueStatus;
  /** Versão do detector objetivo desta técnica. */
  detectorVersion: string;
  /** Descrição curta para catálogo/UI; não é sinal nem recomendação. */
  description: string;
  /** Fontes/origens usadas para documentar a técnica. */
  sources: string[];
  /** Dados objetivos necessários para o detector. Vazio quando já disponíveis. */
  requiredData: string[];
}

type TechniqueSeed = Omit<
  Technique,
  "detectorVersion" | "description" | "sources" | "requiredData"
> & {
  requiredData?: string | string[];
};

const TECHNIQUE_SEEDS: TechniqueSeed[] = [
  // ---------------- WYCKOFF ----------------
  {
    id: "spring-acumulacao",
    name: "Spring (Fase C de Acumulação)",
    category: "wyckoff",
    origin: "Richard D. Wyckoff (método de 1931); esquemática de acumulação",
    context: "Range de acumulação após queda; fases A–B já formadas (SC, AR, ST).",
    trigger:
      "Falso rompimento ABAIXO do suporte do range que reverte e fecha de volta dentro (captura de liquidez vendedora) + reação compradora no fechamento seguinte.",
    invalidation: "Fechamento consistente abaixo do nível do spring (o teste de oferta falhou).",
    target: "Topo do range (AR) como parcial; projeção da causa (largura do range) como alvo.",
    status: "DETECTABLE",
  },
  {
    id: "utad-distribuicao",
    name: "UTAD (Fase C de Distribuição)",
    category: "wyckoff",
    origin: "Richard D. Wyckoff; espelho do spring na distribuição",
    context: "Range de distribuição após alta; BC/AR/ST formados.",
    trigger:
      "Falso rompimento ACIMA da resistência do range que reverte para dentro (captura de liquidez compradora) + reação vendedora confirmada.",
    invalidation: "Fechamento consistente acima do nível do UTAD.",
    target: "Fundo do range como parcial; projeção da causa como alvo final.",
    status: "DETECTABLE",
  },
  {
    id: "sos-lps-continuacao",
    name: "SOS + LPS (Fase D — continuação)",
    category: "wyckoff",
    origin: "Richard D. Wyckoff; Sign of Strength e Last Point of Support",
    context: "Após spring/teste validado, dentro do range virando tendência.",
    trigger:
      "Mudança estrutural confirmada na direção (SOS) seguida de reteste raso em POI com reação (LPS) — entrada no reteste, não na perseguição.",
    invalidation: "Perda do POI do reteste (invalidação estrutural).",
    target: "Liquidez oposta seguinte; parcial no topo/fundo do range.",
    status: "DETECTABLE",
  },
  // ---------------- SMC / ICT ----------------
  {
    id: "sweep-reversao-smc",
    name: "Liquidity Sweep → Reversão",
    category: "smc_ict",
    origin: "Smart Money Concepts / ICT (Michael Huddleston); sistematiza princípios de Wyckoff",
    context:
      "Nível óbvio com liquidez (topo/fundo anterior, iguais) em qualquer regime não-tendência-forte contrária.",
    trigger:
      "Preço atravessa o nível, FALHA em sustentar e fecha de volta dentro do range (sweep) + deslocamento na direção oposta + mudança de caráter (CHoCH) confirmada.",
    invalidation: "Fechamento além do extremo do sweep (era rompimento real, não sweep).",
    target: "Liquidez do lado oposto do range.",
    status: "DETECTABLE",
  },
  {
    id: "order-block-retest",
    name: "Order Block — reteste",
    category: "smc_ict",
    origin: "ICT/SMC: último candle contrário antes do deslocamento institucional",
    context: "Deslocamento forte deixou um order block; estrutura na direção do deslocamento.",
    trigger: "Retorno do preço à zona do order block com reação na direção original.",
    invalidation: "Fechamento além do extremo oposto do order block.",
    target: "Liquidez à frente; parcial na última máxima/mínima do deslocamento.",
    status: "DETECTABLE",
  },
  {
    id: "bos-continuacao",
    name: "BOS a favor do regime",
    category: "smc_ict",
    origin: "SMC: Break of Structure como continuação da tendência dominante",
    context: "Regime de tendência definido (TREND_UP/TREND_DOWN).",
    trigger:
      "Quebra estrutural confirmada NA MESMA direção do regime + reteste do nível quebrado com reação.",
    invalidation: "CHoCH contrário confirmado.",
    target: "Próximo pool de liquidez na direção da tendência.",
    status: "DETECTABLE",
  },
  {
    id: "fvg-mitigacao",
    name: "Fair Value Gap — mitigação",
    category: "smc_ict",
    origin: "ICT: padrão de 3 candles onde máxima do 1º e mínima do 3º não se sobrepõem",
    context: "Após deslocamento com desequilíbrio; preço tende a retornar ao gap.",
    trigger: "Retorno ao FVG com reação na direção do deslocamento original.",
    invalidation: "Preenchimento total do gap com fechamento além dele.",
    target: "Extremo do deslocamento que criou o gap.",
    status: "CATALOGED",
    requiredData:
      "Cálculo de gaps de 3 candles ainda não implementado no motor de features (implementável com candles atuais — candidato a evolução).",
  },
  // ---------------- PRICE ACTION (AL BROOKS) ----------------
  {
    id: "falso-rompimento-brooks",
    name: "Falha de rompimento (failed breakout)",
    category: "price_action",
    origin: "Al Brooks: a maioria dos rompimentos de range falha; a falha prende os atrasados",
    context: "Range definido; rompimento sem follow-through.",
    trigger:
      "Barra rompe o extremo do range mas fecha de volta dentro, sem continuação — entrada contrária no fechamento da barra de falha.",
    invalidation: "Retomada do rompimento com fechamento além do extremo da falha.",
    target: "Lado oposto do range; mínimo de duas pernas após a falha.",
    status: "DETECTABLE",
  },
  {
    id: "segunda-entrada-brooks",
    name: "Segunda entrada (High 2 / Low 2)",
    category: "price_action",
    origin: "Al Brooks: segunda tentativa após pullback de duas pernas na direção da tendência",
    context: "Tendência clara; pullback de duas pernas até EMA/suporte.",
    trigger:
      "Segundo sinal de retomada (H2 na alta, L2 na baixa) com barra de sinal forte na zona de valor.",
    invalidation: "Perda do fundo/topo do pullback.",
    target: "Extremo anterior; measured move da perna anterior.",
    status: "CATALOGED",
    requiredData:
      "Contagem de pernas do pullback (H1/H2/L1/L2) não implementada no motor de features.",
  },
  // ---------------- ORDER FLOW ----------------
  {
    id: "absorcao-orderflow",
    name: "Absorção em nível-chave",
    category: "order_flow",
    origin: "Order flow/footprint: ordens limitadas grandes seguram agressão sem o preço andar",
    context: "Nível estrutural relevante (suporte/resistência/POC).",
    trigger:
      "Volume agressivo alto executando num nível com deslocamento mínimo de preço — defesa passiva institucional; entrada na direção da defesa após confirmação.",
    invalidation: "As ordens absorvedoras somem e o nível cede com agressão.",
    target: "Retorno ao valor; liquidez oposta próxima.",
    status: "CATALOGED",
    requiredData:
      "Tape/book/delta por nível não existem na captura visual do gráfico — exigiria feed de dados de fluxo.",
  },
  {
    id: "exaustao-delta",
    name: "Exaustão / divergência de delta",
    category: "order_flow",
    origin:
      "Order flow: novo extremo de preço com delta/CVD enfraquecendo — agressor sem convicção",
    context: "Movimento direcional maduro chegando em zona de interesse.",
    trigger:
      "Preço faz nova máxima/mínima enquanto o delta faz extremo menor (divergência) ou o ritmo de agressão desacelera.",
    invalidation: "Delta volta a expandir na direção do movimento.",
    target: "Reversão ao valor; primeiro suporte/resistência estrutural.",
    status: "CATALOGED",
    requiredData: "Delta/CVD reais exigem dados de agressor (tape), indisponíveis por pixels.",
  },
  // ---------------- TÉCNICA PRÓPRIA CATALOGADA ----------------
  {
    id: "sheik-shape-fibo",
    name: "Sheik/Shape — candle diário + Fibonacci 0/50/100",
    category: "price_action",
    origin: "Sheik/Shape Trader (catalogada pelo usuário como técnica secundária)",
    context:
      "Início do pregão; níveis do candle do dia anterior projetados (0/50/100 e expansões).",
    trigger:
      "Rompimento avaliado dos níveis projetados após o fechamento dos 5 primeiros minutos, com parcial/alvo/stop pré-definidos.",
    invalidation: "Retorno e fechamento contrário ao nível rompido.",
    target: "Próximo nível da grade de expansão.",
    status: "CATALOGED",
    requiredData:
      "Requer OHLC do dia anterior completo (a captura atual só vê a janela visível do gráfico).",
  },
  // ---------------- GESTÃO ----------------
  /**
   * A GESTÃO EM PRODUÇÃO — a única que conduz operação.
   *
   * Ela precisa existir aqui porque a Biblioteca alimenta o detector e o
   * contexto da IA: enquanto a única gestão catalogada era a de duas pernas, o
   * sistema respondia "como a T4 gerencia?" com uma regra que ele próprio não
   * executa. Os números vêm de PRODUCTION_MANAGEMENT (@/lib/t4/management) —
   * repeti-los à mão aqui os deixaria divergir na primeira mudança.
   */
  {
    id: "gestao-t4-3-contratos",
    name: `Gestão T4 — ${PRODUCTION_MANAGEMENT.label}`,
    category: "gestao",
    origin: "Gestão em PRODUÇÃO da T4, decidida pelo operador (WIN 1 min, 3 contratos)",
    context: "Toda entrada confirmada da T4.",
    trigger: `${PRODUCTION_MANAGEMENT.description} Protege após ${PRODUCTION_MANAGEMENT.protectAfterR}R.`,
    invalidation: "Stop estrutural — nunca stop por valor arbitrário.",
    target: "1º contrato em 3R, 2º em 5R, 3º (runner) sai pela estrutura.",
    status: "DETECTABLE",
  },
  {
    id: "parcial-60-40",
    name: "Parcial estrutural 60/40 (EXPERIMENTAL — não é a T4)",
    category: "gestao",
    origin: "Plano legado de duas pernas. Mantido para comparação histórica; NÃO conduz operação.",
    context:
      "Nenhum — a produção usa 3 contratos. Esta entrada existe para leitura de resultados antigos.",
    trigger: "60% na parcial (primeira liquidez), 40% no alvo final.",
    invalidation: "—",
    target: "R composto: 0,6·RR1 + 0,4·RR2.",
    /*
     * DISABLED, não CATALOGED: a ela não falta DADO — ela está fora de
     * produção por decisão do operador. Enquanto era detectável, TODA entrada
     * saía marcada com uma gestão que o sistema não executa, e essa marca ia
     * para o histórico e para o contexto da IA como se fosse a regra oficial.
     */
    status: "DISABLED",
  },
];

/**
 * Catálogo normalizado. Toda técnica exposta possui os campos estruturais
 * obrigatórios; CATALOGED/DISABLED nunca são promovidas a match pelo detector.
 */
export const TECHNIQUE_LIBRARY: Technique[] = TECHNIQUE_SEEDS.map((seed) => ({
  ...seed,
  detectorVersion: seed.status === "DETECTABLE" ? "1.0.0" : "0.0.0",
  description: `${seed.name} — ${seed.context}`,
  sources: [seed.origin],
  requiredData:
    seed.requiredData === undefined
      ? []
      : Array.isArray(seed.requiredData)
        ? seed.requiredData
        : [seed.requiredData],
}));

export function techniqueById(id: string): Technique | null {
  return TECHNIQUE_LIBRARY.find((technique) => technique.id === id) ?? null;
}

export function detectableTechniques(): Technique[] {
  return TECHNIQUE_LIBRARY.filter((technique) => technique.status === "DETECTABLE");
}
