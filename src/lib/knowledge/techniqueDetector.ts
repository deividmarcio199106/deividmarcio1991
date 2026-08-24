import { activeManagement } from "@/lib/t4/management";
import type { AnalysisResult } from "@/lib/engines/types";
import { techniqueById, type Technique } from "./techniqueLibrary";

/**
 * DETECTOR DE TÉCNICAS (comando de expansão, Parte 2).
 *
 * Matching DETERMINÍSTICO das técnicas DETECTÁVEIS contra os sinais reais que
 * o pipeline já produz: captura de liquidez, SMS/mudança estrutural, POI,
 * regime, esquema/fase Wyckoff e sequência causal. Nada é inferido além do
 * que os motores mediram; técnica CATALOGADA nunca aparece aqui.
 *
 * A detecção NÃO é autorização de entrada — ela apenas ROTULA a configuração
 * para que a estatística individual de cada técnica seja construída no
 * backtest (validação separada por técnica, com gate de amostra mínima).
 */

export interface TechniqueMatch {
  techniqueId: string;
  technique: Technique;
  detectedAt: number;
  evidence: string[];
  detectorVersion: string;
  /** Compatibilidade temporária com consumidores antigos; use `evidence`. */
  evidences: string[];
}

export function detectTechniques(analysis: AnalysisResult): TechniqueMatch[] {
  const matches: TechniqueMatch[] = [];
  const capture = analysis.internalConfirmation.capture;
  const sms = analysis.internalConfirmation.sms;
  const poi = analysis.mainPoi;
  const regime = analysis.regime.regime;
  const schema = analysis.wyckoff.schema;

  const add = (techniqueId: string, evidences: string[]) => {
    const technique = techniqueById(techniqueId);
    // Guarda de honestidade: só técnicas DETECTÁVEIS podem ser detectadas.
    if (!technique || technique.status !== "DETECTABLE") return;
    matches.push({
      techniqueId,
      technique,
      detectedAt: analysis.t,
      evidence: evidences,
      detectorVersion: technique.detectorVersion,
      evidences,
    });
  };

  // Spring (Acumulação, captura de liquidez VENDEDORA abaixo do suporte).
  if (
    capture.valid &&
    capture.detail.side === "vendedora" &&
    schema === "Acumulação" &&
    analysis.direction === "COMPRA"
  ) {
    add("spring-acumulacao", [
      "Captura de liquidez vendedora validada (falso rompimento abaixo do suporte com rejeição).",
      `Esquema Wyckoff: Acumulação${analysis.wyckoff.phase ? ` — fase ${analysis.wyckoff.phase}` : ""}.`,
      "Direção compradora após a captura.",
    ]);
  }

  // UTAD (Distribuição, captura COMPRADORA acima da resistência).
  if (
    capture.valid &&
    capture.detail.side === "compradora" &&
    schema === "Distribuição" &&
    analysis.direction === "VENDA"
  ) {
    add("utad-distribuicao", [
      "Captura de liquidez compradora validada (falso rompimento acima da resistência).",
      `Esquema Wyckoff: Distribuição${analysis.wyckoff.phase ? ` — fase ${analysis.wyckoff.phase}` : ""}.`,
      "Direção vendedora após a captura.",
    ]);
  }

  // Sweep → reversão (SMC): captura validada + CHoCH/SMS confirmado + reação.
  if (
    capture.valid &&
    sms.confirmed &&
    sms.reactionConfirmed &&
    analysis.direction !== "NEUTRO" &&
    sms.direction === analysis.direction
  ) {
    add("sweep-reversao-smc", [
      "Sweep de liquidez validado (rompeu o nível, falhou e voltou para dentro).",
      `Mudança estrutural confirmada na direção ${analysis.direction} (nível ${sms.brokenLevel ?? "—"}).`,
      "Reação/deslocamento confirmados após o sweep.",
    ]);
  }

  // Order block em reteste: neste motor, "origem_deslocamento" é o equivalente
  // exato do order block do ICT (último candle contrário antes do deslocamento).
  if (
    poi &&
    poi.kind === "origem_deslocamento" &&
    poi.condition === "testado" &&
    sms.confirmed &&
    analysis.direction !== "NEUTRO"
  ) {
    add("order-block-retest", [
      "POI principal é um order block em reteste (condição: testado).",
      "Estrutura confirmada na direção da entrada.",
    ]);
  }

  // BOS a favor do regime de tendência.
  if (
    sms.confirmed &&
    analysis.direction !== "NEUTRO" &&
    ((regime === "TREND_UP" && analysis.direction === "COMPRA") ||
      (regime === "TREND_DOWN" && analysis.direction === "VENDA"))
  ) {
    add("bos-continuacao", [
      `Quebra estrutural confirmada a favor do regime ${regime}.`,
      sms.closeConfirmed
        ? "Fechamento além do nível confirmado."
        : "Deslocamento estrutural presente.",
    ]);
  }

  // SOS + LPS: sequência causal completa com reteste de POI e reação.
  if (
    analysis.sequence.complete &&
    sms.confirmed &&
    poi !== null &&
    poi.condition === "testado" &&
    analysis.direction !== "NEUTRO"
  ) {
    add("sos-lps-continuacao", [
      `Sequência causal completa (${analysis.sequence.stages.filter((s) => s.met).length}/${analysis.sequence.stages.length} etapas).`,
      "Reteste raso do POI com reação (LPS) após mudança estrutural (SOS).",
    ]);
  }

  // Falha de rompimento (Brooks): captura validada SEM ser rompimento aceito,
  // em regime de range — o rompimento falhou e prendeu os atrasados.
  if (
    capture.valid &&
    !capture.isAcceptedBreakoutOnly &&
    regime === "RANGE" &&
    analysis.direction !== "NEUTRO" &&
    capture.detail.rejection > 0
  ) {
    add("falso-rompimento-brooks", [
      "Rompimento do extremo do range falhou (fechou de volta dentro, com rejeição).",
      "Regime de range — contexto onde a maioria dos rompimentos falha (Brooks).",
    ]);
  }

  /*
   * A gestão anexada é a que REALMENTE conduz a operação.
   *
   * Antes daqui saía "parcial-60-40" em toda entrada com plano — uma gestão de
   * duas pernas que o sistema não executa desde que a produção passou a três
   * contratos. A marca ia para o histórico e para o contexto da IA como se
   * fosse a regra oficial, e o operador tinha duas respostas para "como a T4
   * gerencia?". Agora vem de `activeManagement()`, então trocar a produção
   * troca a marca junto — sem ninguém precisar lembrar deste arquivo.
   */
  if (analysis.plan && analysis.direction !== "NEUTRO") {
    const gestao = activeManagement();
    add("gestao-t4-3-contratos", [
      `Plano completo conduzido pela gestão em produção: ${gestao.label}.`,
      gestao.description,
    ]);
  }

  return matches;
}

/** Snapshot versionado das técnicas detectadas no instante da decisão. */
export function detectTechniqueSnapshot(analysis: AnalysisResult): {
  techniqueIds: string[];
  techniqueDetectorVersions: Record<string, string>;
} {
  const matches = detectTechniques(analysis);
  return {
    techniqueIds: matches.map((match) => match.techniqueId),
    techniqueDetectorVersions: Object.fromEntries(
      matches.map((match) => [match.techniqueId, match.detectorVersion]),
    ),
  };
}

/** Ids das técnicas detectadas — compatibilidade simples para filtros/UI. */
export function detectTechniqueIds(analysis: AnalysisResult): string[] {
  return detectTechniques(analysis).map((match) => match.techniqueId);
}
