/**
 * H3 — A CONFIRMAÇÃO DEIXA DE DEPENDER DO ALVO DE 3R.
 *
 * O QUE FOI MEDIDO. No trecho 568,4–645,2 s de marco.mp4, o preço cruzou o
 * gatilho de 190.700 e chegou a 190.865 — 165 pontos além. Sete leituras
 * consecutivas ficaram em ARMED com a headline "TOQUE SEM CONFIRMAÇÃO —
 * AGUARDAR", e nenhuma confirmou. O motivo está no reparo do próprio motor:
 *
 *   "Alvo recusado: obstáculo a 0.7R — menos que os 3R de espaço técnico.
 *    Setup segue em acompanhamento, SEM ALVO NÃO CONFIRMA."
 *
 * A CADEIA, rastreada no código:
 *   1. pregao.ts omite `targets` do objeto de análise quando !espacoSuficiente
 *   2. setupTracker.targetOf() devolve null
 *   3. assessTradeRisk() recebe target null → veredito RISK_UNKNOWN
 *   4. RISK_UNKNOWN nunca aprova, e só CONFIRMED **e** RISK_APPROVED liberam
 *
 * O gate de 3R está no passo 1; o efeito aparece no passo 4. Por isso o
 * contrafactual `semTrava` — que mexe no passo 1 e lê o resultado da
 * classificação — respondeu "entrada não executada" quando a pergunta certa
 * era "a entrada nunca foi autorizada".
 *
 * A VARIÁVEL QUE H3 MUDA, E SÓ ELA: qual alvo vai para a análise quando o
 * espaço medido é menor que 3R. Percepção, obstáculo, stop, gestão, gatilho e
 * a própria medição de espaço ficam idênticos ao baseline.
 *
 * POR QUE O OBSTÁCULO, E NÃO O ALVO DE 3R. Empurrar o alvo de 3R adiante
 * quando o espaço medido é 0,7R produziria um R:R que a estrutura não sustenta
 * — o número mais perigoso da tela, porque parece medida. H3 usa o OBSTÁCULO
 * como alvo: é a família "próximo obstáculo" que o protocolo já lista, e o R:R
 * que sai dela é o real (0,7R), não um inventado. O trade nasce com o tamanho
 * que a estrutura permite em vez de não nascer.
 *
 * O QUE H3 NÃO FAZ: não afrouxa o piso de 3R como critério de QUALIDADE. Um
 * trade confirmado com 0,7R continua marcado como sub-3R e o dimensionamento a
 * jusante decide o que fazer com ele. A trava deixa de decidir se o trade
 * EXISTE e passa a decidir QUANTO ele vale — que é o papel que ela consegue
 * cumprir com honestidade.
 */

/** Um nível como a análise do print o carrega. */
export interface NivelVisivel {
  value: number;
  visible: boolean;
}

export interface AlvosDaAnalise {
  /** Os alvos que vão para a máquina de setup. Vazio = confirmação bloqueada. */
  targets: NivelVisivel[];
  /** De onde o alvo veio — entra no ledger e no relatório, nunca some. */
  origem: "TRES_R" | "OBSTACULO_H3" | "NENHUM";
  /** Espaço real medido, em R. Preservado mesmo quando abaixo de 3. */
  espacoR: number | null;
  /** Verdadeiro quando o trade nasce abaixo do piso de 3R (só sob H3). */
  subTresR: boolean;
}

/**
 * DECIDE OS ALVOS QUE A ANÁLISE LEVA.
 *
 * Baseline (h3 ausente): reproduz exatamente o comportamento atual —
 * alvos só existem com espaço provado, e sem eles a confirmação não acontece.
 *
 * H3 ligada: quando o espaço é insuficiente MAS existe obstáculo medido a
 * favor, o obstáculo vira o alvo. Sem obstáculo conhecido não há o que mirar,
 * e aí H3 se comporta como o baseline — porque um alvo sem obstáculo seria
 * autoprofecia, que é o que o reparo original já dizia.
 */
export function alvosParaAnalise(
  target1: number | null,
  target2: number | null,
  obstaculo: number | null,
  espacoSuficiente: boolean,
  espacoR: number | null,
  h3: { alvoNoObstaculo: boolean } | undefined,
): AlvosDaAnalise {
  if (espacoSuficiente && target1 !== null) {
    return {
      targets: [
        { value: target1, visible: true },
        ...(target2 === null ? [] : [{ value: target2, visible: true }]),
      ],
      origem: "TRES_R",
      espacoR,
      subTresR: false,
    };
  }

  if (h3?.alvoNoObstaculo === true && obstaculo !== null) {
    return {
      targets: [{ value: obstaculo, visible: true }],
      origem: "OBSTACULO_H3",
      espacoR,
      subTresR: true,
    };
  }

  return { targets: [], origem: "NENHUM", espacoR, subTresR: false };
}

/**
 * O REPARO QUE EXPLICA A DECISÃO — dito sempre, nunca escondido.
 *
 * Um trade que nasce sob H3 precisa carregar na cara que nasceu abaixo do
 * piso: quem ler o ledger depois tem que conseguir separar os sub-3R sem
 * recalcular nada.
 */
export function reparoDoAlvo(a: AlvosDaAnalise, obstaculo: number | null): string {
  if (a.origem === "TRES_R") {
    return `Alvo aprovado: espaço de ${a.espacoR?.toFixed(1) ?? "?"}R até o obstáculo.`;
  }
  if (a.origem === "OBSTACULO_H3") {
    return `H3: alvo no obstáculo ${obstaculo} — espaço real ${a.espacoR?.toFixed(1) ?? "?"}R, ABAIXO do piso de 3R. Trade marcado SUB_3R; o piso passa a dimensionar, não a vetar.`;
  }
  return "Alvo recusado: sem obstáculo conhecido a favor — alvo 3R/5R seria autoprofecia.";
}
