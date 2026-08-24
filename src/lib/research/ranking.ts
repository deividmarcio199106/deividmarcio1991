/**
 * RANKING DE VERSÕES DA TÉCNICA — nunca só lucro (roteiro §30).
 *
 * A regra do operador é literal: "ranking ponderando PF/DD/expectância/
 * estabilidade/amostra — nunca só lucro". Uma versão com PF alto em cima de
 * drawdown gigante, ou com 8 trades espetaculares, NÃO pode vencer uma
 * alternativa equilibrada — o score existe para codificar isso, e a
 * elegibilidade existe para que amostra pequena nem entre na disputa.
 *
 * PURO: recebe métricas prontas, devolve lista ordenada. Quem mede é o
 * backtest; quem promove é o operador — este módulo apenas ORDENA e diz
 * o porquê de cada rebaixamento na `note`.
 */

export interface VersionMetrics {
  version: string;
  trades: number;
  winRate: number;
  expectancyR: number;
  profitFactor: number;
  /** Magnitude do drawdown máximo em R (valor positivo). */
  maxDrawdownR: number;
  /** Expectância medida FORA da amostra; null = OOS nunca rodou. */
  oosExpectancyR: number | null;
  /** null = walk-forward nunca rodou (diferente de "rodou e falhou"). */
  walkForwardStable: boolean | null;
}

export type RankedVersion = VersionMetrics & {
  score: number;
  eligible: boolean;
  note: string;
};

/** Abaixo disto nenhuma conclusão é autorizada — mesmo corte do dnaStats. */
export const DEFAULT_MIN_TRADES = 30;

/**
 * PF sem nenhuma perda chega como Infinity (pendência conhecida do painel);
 * e PF estratosférico em amostra curta é artefato, não mérito. Teto e piso
 * mantêm o termo logarítmico finito e honesto.
 */
const PF_CAP = 10;
const PF_FLOOR = 0.05;

// ---------------------------------------------------------------------------
// FÓRMULA DO SCORE (documentada aqui porque é a decisão central do módulo):
//
//   score = 2.0·ln(PF*)                PF em LOG: dobrar o PF vale o mesmo
//                                      em qualquer patamar, e PF < 1 puxa o
//                                      score para baixo (ln negativo).
//                                      PF* = clamp(PF, 0.05, 10).
//         + 1.5·expectancyR            Expectância média por trade, em R.
//         + 1.0·oosExpectancyR         Fora-da-amostra vale TANTO quanto a
//                                      expectância interna; OOS ausente não
//                                      soma zero em silêncio: penalidade
//                                      fixa −0.75 com motivo na note.
//         − 0.08·|maxDrawdownR|        Cada R de drawdown cobra pedágio
//                                      LINEAR — é isto que impede PF bonito
//                                      montado em cima de DD gigante.
//         ± 0.5 walk-forward           +0.5 estável comprovado; −0.5 rodou
//                                      e FALHOU; 0 se nunca rodou (com nota
//                                      — ausência de prova não é prova).
//         + 0.3·log10(1+trades)        Amostra em LOG: 300 trades não valem
//                                      10× mais que 30 — valem uma unidade
//                                      de confiança a mais.
//
// Os pesos são FIXOS e visíveis de propósito: calibrá-los pelos próprios
// resultados seria overfitting do ranking sobre si mesmo (mesma lei do
// caseMemory). Mudança de peso é decisão de código revisada, não ajuste.
// ---------------------------------------------------------------------------
const PF_LOG_WEIGHT = 2.0;
const EXPECTANCY_WEIGHT = 1.5;
const OOS_WEIGHT = 1.0;
const OOS_MISSING_PENALTY = 0.75;
const DRAWDOWN_WEIGHT = 0.08;
const STABILITY_TERM = 0.5;
const SAMPLE_WEIGHT = 0.3;

/**
 * Ordena versões por robustez composta. Regras duras:
 *
 * - `trades < minTrades` ⇒ `eligible: false` com a frase canônica da casa
 *   ("amostra insuficiente — conclusão NÃO autorizada") e a versão NUNCA
 *   fica acima de uma elegível, por maior que seja o score bruto;
 * - métrica não numérica (NaN) ⇒ inelegível com motivo — lixo não rankeia;
 * - ordenação: elegíveis primeiro, depois score desc, depois amostra desc,
 *   depois versão (desempate determinístico — mesmo input, mesma ordem).
 */
export function rankVersions(
  list: VersionMetrics[],
  minTrades: number = DEFAULT_MIN_TRADES,
): RankedVersion[] {
  const ranked = list.map((m): RankedVersion => {
    const notes: string[] = [];

    const coreFinite =
      Number.isFinite(m.trades) &&
      Number.isFinite(m.expectancyR) &&
      Number.isFinite(m.maxDrawdownR);
    if (!coreFinite) {
      // Métrica podre não vira score "aproximado": a versão sai da disputa
      // com o motivo dito, e o score sentinela a manda para o fim da fila.
      return {
        ...m,
        score: Number.NEGATIVE_INFINITY,
        eligible: false,
        note: "métrica não numérica — versão fora do ranking",
      };
    }

    let pf = m.profitFactor;
    if (!Number.isFinite(pf)) {
      // PF = Infinity significa "nenhuma perda na amostra" — quase sempre
      // amostra curta demais para ter perdido. Entra pelo teto, nunca cru.
      pf = PF_CAP;
      notes.push("PF sem perdas na amostra — teto aplicado");
    }
    const pfClamped = Math.min(PF_CAP, Math.max(PF_FLOOR, pf));

    let score = PF_LOG_WEIGHT * Math.log(pfClamped);
    score += EXPECTANCY_WEIGHT * m.expectancyR;

    if (m.oosExpectancyR === null) {
      score -= OOS_MISSING_PENALTY;
      notes.push("sem OOS — score rebaixado; valide fora da amostra antes de confiar");
    } else if (Number.isFinite(m.oosExpectancyR)) {
      score += OOS_WEIGHT * m.oosExpectancyR;
    } else {
      score -= OOS_MISSING_PENALTY;
      notes.push("OOS não numérico — tratado como ausente");
    }

    score -= DRAWDOWN_WEIGHT * Math.abs(m.maxDrawdownR);

    if (m.walkForwardStable === true) {
      score += STABILITY_TERM;
    } else if (m.walkForwardStable === false) {
      score -= STABILITY_TERM;
      notes.push("walk-forward INSTÁVEL — penalizado");
    } else {
      notes.push("walk-forward não avaliado");
    }

    score += SAMPLE_WEIGHT * Math.log10(1 + Math.max(0, m.trades));

    const eligible = m.trades >= minTrades;
    if (!eligible) {
      // Frase canônica da casa (mesma do dnaStats): abaixo do corte a
      // métrica é exibível, mas conclusão — e promoção — não existem.
      notes.unshift(
        `amostra insuficiente — conclusão NÃO autorizada (${m.trades} < ${minTrades} trades)`,
      );
    }

    return {
      ...m,
      score,
      eligible,
      note: notes.length > 0 ? notes.join("; ") : "métricas completas",
    };
  });

  return ranked.sort((a, b) => {
    // Elegibilidade vem ANTES do score: amostra pequena nunca vence disputa.
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    if (b.trades !== a.trades) return b.trades - a.trades;
    return a.version.localeCompare(b.version);
  });
}
