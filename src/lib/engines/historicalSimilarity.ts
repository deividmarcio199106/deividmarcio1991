import type { BacktestTrade } from "./backtestEngine";
import { DEFAULT_RISK_PARAMS, MIN_RISK_REWARD } from "./strategy";
import type { AnalysisResult } from "./types";

/**
 * HistoricalSimilarityEngine (comando master §30–§31).
 *
 * Compara a configuração ATUAL do mercado com operações históricas por um
 * vetor de features — nunca apenas pelo nome da técnica. Similaridade serve
 * para ENCONTRAR casos relevantes; ela NÃO é probabilidade de ganhar (§31):
 * quem decide é a estatística calculada sobre os casos encontrados.
 */

export interface SimilarityQuery {
  asset: string;
  direction: "COMPRA" | "VENDA";
  setup: string;
  wyckoffSchema: string;
  wyckoffPhase: string;
  regime: string;
  poiKind: string;
  hour: number;
  riskReward: number;
}

export interface SimilarCase {
  trade: BacktestTrade;
  similarity: number; // 0..1
  matchedFeatures: string[];
}

/** Coeficientes versionados de similaridade — cada feature tem justificativa técnica no comentário. */
export const SIMILARITY_WEIGHTS = {
  direction: 0.2, // operar o mesmo lado é pré-condição de comparabilidade
  setup: 0.18, // mesma técnica/setup declarado
  wyckoffSchema: 0.14, // acumulação vs distribuição muda tudo
  wyckoffPhase: 0.1, // fase dentro do esquema
  regime: 0.14, // regime objetivo do mercado
  poiKind: 0.08, // tipo de zona de entrada
  session: 0.08, // manhã/almoço/tarde têm comportamentos distintos
  riskProfile: 0.08, // RR planejado em faixa comparável
} as const;

export const MIN_SIMILARITY = 0.62;

function sessionOf(hour: number): "manha" | "almoco" | "tarde" | "desconhecida" {
  if (!Number.isFinite(hour) || hour < 0) return "desconhecida";
  if (hour < 12) return "manha";
  if (hour < 14) return "almoco";
  return "tarde";
}

/**
 * Buckets de R:R ANCORADOS NA TÉCNICA, não em números soltos. O corte de baixo
 * é o piso da casa (MIN_RISK_REWARD = 3): abaixo dele a operação nem existe, e
 * separar 1,2 de 1,4 era granularidade sobre trades que a trava já barra. O de
 * cima é o alvo final do plano (5R). Calculado dos dois lados da comparação em
 * tempo de consulta — nada persistido depende dos nomes.
 */
function rrBucket(riskReward: number): string {
  if (!Number.isFinite(riskReward) || riskReward <= 0) return "desconhecido";
  if (riskReward < MIN_RISK_REWARD) return "rr_abaixo_do_minimo";
  if (riskReward < DEFAULT_RISK_PARAMS.finalTargetMultiple) return "rr_entre_minimo_e_final";
  return "rr_no_alvo_final_ou_alem";
}

/** Constrói a consulta a partir da análise ao vivo — só com dados reais dela. */
export function queryFromAnalysis(analysis: AnalysisResult, asset: string): SimilarityQuery | null {
  if (analysis.direction === "NEUTRO" || !analysis.plan) return null;
  return {
    asset,
    direction: analysis.direction,
    setup:
      analysis.t4.setup !== "NONE"
        ? analysis.t4.setup
        : (analysis.wyckoff.phase ?? analysis.wyckoff.schema),
    wyckoffSchema: analysis.wyckoff.schema,
    wyckoffPhase: analysis.wyckoff.phase ?? "sem_fase",
    regime: analysis.regime.regime,
    poiKind: analysis.mainPoi?.kind ?? "sem_poi",
    hour: new Date(analysis.t).getHours(),
    riskReward: analysis.plan.riskRewardPlan,
  };
}

export function similarityBetween(query: SimilarityQuery, trade: BacktestTrade): SimilarCase {
  const matched: string[] = [];
  let similarityValue = 0;
  // Direção diferente nunca é caso comparável — corta na raiz.
  if (trade.direction !== query.direction) {
    return { trade, similarity: 0, matchedFeatures: [] };
  }
  similarityValue += SIMILARITY_WEIGHTS.direction;
  matched.push(`direção=${query.direction}`);

  const [tradeSchema, tradePhase] = trade.setupId.split("|");
  if (trade.setup === query.setup) {
    similarityValue += SIMILARITY_WEIGHTS.setup;
    matched.push(`setup=${query.setup}`);
  }
  if (tradeSchema === query.wyckoffSchema) {
    similarityValue += SIMILARITY_WEIGHTS.wyckoffSchema;
    matched.push(`esquema=${query.wyckoffSchema}`);
  }
  if ((tradePhase ?? trade.wyckoffPhase) === query.wyckoffPhase) {
    similarityValue += SIMILARITY_WEIGHTS.wyckoffPhase;
    matched.push(`fase=${query.wyckoffPhase}`);
  }
  // Trades antigos podem não ter regime — ausência não conta a favor nem contra
  // com compatibilidade cheia: conta parcialmente quando desconhecido.
  if (trade.regime && trade.regime === query.regime) {
    similarityValue += SIMILARITY_WEIGHTS.regime;
    matched.push(`regime=${query.regime}`);
  } else if (!trade.regime) {
    similarityValue += SIMILARITY_WEIGHTS.regime / 2;
  }
  if (trade.poiKind === query.poiKind) {
    similarityValue += SIMILARITY_WEIGHTS.poiKind;
    matched.push(`poi=${query.poiKind}`);
  }
  if (sessionOf(trade.hour) === sessionOf(query.hour)) {
    similarityValue += SIMILARITY_WEIGHTS.session;
    matched.push(`sessão=${sessionOf(query.hour)}`);
  }
  if (rrBucket(trade.riskReward) === rrBucket(query.riskReward)) {
    similarityValue += SIMILARITY_WEIGHTS.riskProfile;
    matched.push(rrBucket(query.riskReward));
  }
  return { trade, similarity: Number(similarityValue.toFixed(4)), matchedFeatures: matched };
}

/** Casos históricos relevantes, ordenados por similaridade (mesma strategyVersion do chamador filtrar antes se desejar). */
export function findSimilarCases(
  query: SimilarityQuery,
  trades: BacktestTrade[],
  minSimilarity = MIN_SIMILARITY,
): SimilarCase[] {
  return trades
    .filter((trade) => trade.asset === query.asset)
    .map((trade) => similarityBetween(query, trade))
    .filter((item) => item.similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity);
}
