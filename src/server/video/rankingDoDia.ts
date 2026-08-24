import type { ResultadoDoPregao } from "./pregao";

/**
 * O MELHOR CANDIDATO DO DIA — ordenar o que o motor já aprovou, nunca fabricar.
 *
 * POR QUE ISTO EXISTE. O pedido do dono em 23/08/2026 foi "buscar a melhor
 * operação todos os dias". Lido ao pé da letra, isso colide de frente com a
 * primeira regra absoluta do protocolo:
 *
 *   "cobertura de dias e METRICA, nunca obrigacao — proibido fabricar trade
 *    para transformar NO_TRADE em SIM"
 *
 * Este módulo entrega o pedido SEM quebrar a regra, e a diferença é toda ela:
 * ele ORDENA os candidatos que o gate já aprovou. Não afrouxa o piso de 3R,
 * não encurta stop, não promove recusa, não cria candidato. Dia sem aprovado
 * sai como NO_TRADE com o gate responsável contado numericamente — que é o
 * que a segunda regra absoluta exige de todo NO_TRADE.
 *
 * O QUE ESTE MÓDULO NÃO PODE FAZER, POR CONSTRUÇÃO. `CandidatoDoDia` não tem
 * campo de resultado. Não tem `r`, `pontos`, `resultado`, `mfePontos` nem
 * `maePontos`. Isso não é esquecimento: é a trava contra lookahead. Ranquear
 * por resultado seria escolher o vencedor depois da corrida e chamar isso de
 * técnica. Como o tipo de entrada não carrega esses campos, nenhuma versão
 * futura consegue usá-los sem alterar a assinatura — e alterar a assinatura é
 * visível na revisão.
 *
 * ESTE MÓDULO NÃO É EXPERIMENTO. Ele não muda nenhuma variável do contrato de
 * comparação: percepção, obstáculo, stop, gestão e o piso de 3R seguem
 * idênticos ao baseline. É uma LEITURA do resultado do pregão, posterior e
 * somente-leitura. Rodar ou não rodar o ranking não altera um único número do
 * `ResultadoDoPregao`.
 */

/** Como o obstáculo do gate de espaço foi conhecido. MEDIDO > LIDO. */
export type OrigemDoObstaculo = "MEDIDO" | "LIDO" | "NENHUM";

/** Como o stop foi determinado. Ver `stopEstruturalH2` em pregao.ts. */
export type OrigemDoStop = "ESTRUTURAL" | "PISO" | "MODELO" | "SEM_ZONA_PISO";

/**
 * UM CANDIDATO, COM O QUE SE SABIA NO INSTANTE DA DECISÃO — e nada além.
 *
 * Todo campo aqui é observável antes de o trade existir. Se um campo novo for
 * acrescentado no futuro, a pergunta é sempre a mesma: eu saberia disto ANTES
 * de entrar? Se a resposta for não, ele não entra.
 */
export interface CandidatoDoDia {
  setupId: string;
  segundoNoVideo: number;
  dataDoGrafico: string | null;
  horaDoGrafico: string | null;
  direcao: "COMPRA" | "VENDA";
  entrada: number;
  stop: number;
  /** Risco em pontos: |entrada − stop|. Zero ou negativo é inelegível. */
  riscoPontos: number;
  /** Obstáculo que limita o espaço. Null = nenhum obstáculo conhecido. */
  obstaculo: number | null;
  /** Espaço até o obstáculo, em múltiplos de R. Null = não mensurável. */
  espacoR: number | null;
  origemDoObstaculo: OrigemDoObstaculo;
  origemDoStop: OrigemDoStop | null;
  /** Confiança declarada pelo leitor visual, 0–100. */
  confianca: number | null;
  /** O gate de 3R aprovou este candidato. Falso = recusado, jamais promovível. */
  aprovadoNoGate: boolean;
  /** Quando recusado, o motivo exato — alimenta o relatório de NO_TRADE. */
  motivoDaRecusa: string | null;
}

export interface CandidatoRanqueado extends CandidatoDoDia {
  /** 1 = melhor do dia. Só candidatos elegíveis recebem posição. */
  posicao: number;
  /** Por que ficou nesta posição, em texto — auditável a olho. */
  justificativa: string;
}

/** Contagem numérica do que impediu o dia, como a regra absoluta nº 2 exige. */
export interface GateResponsavel {
  motivo: string;
  ocorrencias: number;
}

export interface RankingDoDia {
  /** Data do pregão, quando legível no gráfico. */
  data: string | null;
  /** O melhor candidato aprovado, ou null em dia de NO_TRADE. */
  melhor: CandidatoRanqueado | null;
  /** Todos os aprovados, já ordenados. Vazio em dia de NO_TRADE. */
  aprovados: CandidatoRanqueado[];
  /** Recusados pelo gate — listados para forense, NUNCA promovidos. */
  recusados: CandidatoDoDia[];
  /** Verdadeiro quando nenhum candidato passou no gate. */
  noTrade: boolean;
  /** Os gates que mataram o dia, contados. Vazio quando houve aprovado. */
  gatesResponsaveis: GateResponsavel[];
  /** Total de candidatos observados, aprovados + recusados. */
  totalCandidatos: number;
}

/** Ordem de preferência da evidência do obstáculo: medir vence ler. */
const PESO_OBSTACULO: Record<OrigemDoObstaculo, number> = {
  MEDIDO: 0,
  LIDO: 1,
  NENHUM: 2,
};

/**
 * Ordem de preferência da origem do stop.
 *
 * ESTRUTURAL primeiro porque o stop nasceu da invalidação da zona — é a
 * definição da técnica. PISO em seguida: o risco foi alargado até o mínimo
 * executável, o que é honesto. MODELO depois, porque é escolha livre do leitor
 * visual, o grau de liberdade que a H2 existe para remover. SEM_ZONA_PISO por
 * último: não havia zona legível para ancorar coisa alguma.
 */
const PESO_STOP: Record<OrigemDoStop, number> = {
  ESTRUTURAL: 0,
  PISO: 1,
  MODELO: 2,
  SEM_ZONA_PISO: 3,
};

/**
 * ELEGIBILIDADE — binária, antes de qualquer ordenação.
 *
 * Espelha a trava do leaderboard do protocolo: elegibilidade primeiro, ranking
 * só entre elegíveis. Impede que um candidato com espaço enorme e obstáculo
 * inexistente vença um candidato real por ter um número maior numa coluna.
 */
export function elegivel(c: CandidatoDoDia): boolean {
  if (!c.aprovadoNoGate) return false;
  if (!Number.isFinite(c.riscoPontos) || c.riscoPontos <= 0) return false;
  if (c.obstaculo === null) return false;
  if (c.espacoR === null || !Number.isFinite(c.espacoR)) return false;
  return true;
}

/**
 * A CASCATA DE DESEMPATE — declarada antes de olhar qualquer resultado.
 *
 * Devolve negativo quando `a` vem primeiro. A ordem dos critérios foi fixada
 * em 23/08/2026, ANTES de rodar contra qualquer pregão; mudá-la depois de ver
 * resultado é garimpo e conta como hipótese nova no `hypothesis-count.json`.
 *
 *   1. espacoR desc ....... mais espaço até o obstáculo é a própria tese da T4
 *   2. obstáculo MEDIDO ... pivô da varredura vence nível lido pelo modelo
 *   3. stop ESTRUTURAL .... stop ancorado na zona vence stop de escolha livre
 *   4. riscoPontos asc .... para o mesmo R, arriscar menos pontos é melhor
 *   5. confiança desc ..... último sinal do leitor, o mais fraco dos cinco
 *   6. segundoNoVideo asc . desempate total: o mais cedo vence, sempre
 *
 * O critério 6 garante ordem TOTAL — dois candidatos nunca empatam de verdade,
 * então o ranking é determinístico e reproduzível entre corridas.
 */
export function compararCandidatos(a: CandidatoDoDia, b: CandidatoDoDia): number {
  const espacoA = a.espacoR ?? Number.NEGATIVE_INFINITY;
  const espacoB = b.espacoR ?? Number.NEGATIVE_INFINITY;
  if (espacoA !== espacoB) return espacoB - espacoA;

  const obsA = PESO_OBSTACULO[a.origemDoObstaculo];
  const obsB = PESO_OBSTACULO[b.origemDoObstaculo];
  if (obsA !== obsB) return obsA - obsB;

  const stopA = a.origemDoStop === null ? 99 : PESO_STOP[a.origemDoStop];
  const stopB = b.origemDoStop === null ? 99 : PESO_STOP[b.origemDoStop];
  if (stopA !== stopB) return stopA - stopB;

  if (a.riscoPontos !== b.riscoPontos) return a.riscoPontos - b.riscoPontos;

  const confA = a.confianca ?? -1;
  const confB = b.confianca ?? -1;
  if (confA !== confB) return confB - confA;

  return a.segundoNoVideo - b.segundoNoVideo;
}

/** O texto que explica a posição — para conferir o ranking sem abrir o código. */
function justificar(c: CandidatoDoDia): string {
  const partes: string[] = [];
  partes.push(`espaço ${(c.espacoR ?? 0).toFixed(1)}R`);
  partes.push(`obstáculo ${c.origemDoObstaculo}`);
  if (c.origemDoStop !== null) partes.push(`stop ${c.origemDoStop}`);
  partes.push(`risco ${c.riscoPontos} pts`);
  if (c.confianca !== null) partes.push(`confiança ${c.confianca}`);
  return partes.join(" · ");
}

/**
 * O RANKING DE UM DIA. Função pura: mesma entrada, mesma saída, sempre.
 *
 * Não recebe resultado de operação porque `CandidatoDoDia` não tem esse campo.
 * Não recebe relógio nem aleatoriedade. A entrada não é mutada — a ordenação
 * roda sobre uma cópia.
 */
export function ranquearDia(
  candidatos: ReadonlyArray<CandidatoDoDia>,
  data: string | null = null,
): RankingDoDia {
  const aprovadosCrus = candidatos.filter(elegivel);
  const recusados = candidatos.filter((c) => !elegivel(c));

  const aprovados: CandidatoRanqueado[] = [...aprovadosCrus]
    .sort(compararCandidatos)
    .map((c, i) => ({ ...c, posicao: i + 1, justificativa: justificar(c) }));

  // O NO_TRADE não é um buraco no relatório: é um resultado com causa contada.
  const gatesResponsaveis: GateResponsavel[] = [];
  if (aprovados.length === 0) {
    const contagem = new Map<string, number>();
    for (const c of recusados) {
      const motivo = motivoDe(c);
      contagem.set(motivo, (contagem.get(motivo) ?? 0) + 1);
    }
    for (const [motivo, ocorrencias] of contagem) {
      gatesResponsaveis.push({ motivo, ocorrencias });
    }
    // Ordem estável: mais frequente primeiro, alfabética no empate.
    gatesResponsaveis.sort((x, y) =>
      y.ocorrencias !== x.ocorrencias
        ? y.ocorrencias - x.ocorrencias
        : x.motivo.localeCompare(y.motivo),
    );
  }

  return {
    data,
    melhor: aprovados[0] ?? null,
    aprovados,
    recusados,
    noTrade: aprovados.length === 0,
    gatesResponsaveis,
    totalCandidatos: candidatos.length,
  };
}

/** O motivo padronizado de um candidato não elegível. */
function motivoDe(c: CandidatoDoDia): string {
  if (c.motivoDaRecusa !== null) return c.motivoDaRecusa;
  if (!c.aprovadoNoGate) return "RECUSADO_NO_GATE";
  if (!Number.isFinite(c.riscoPontos) || c.riscoPontos <= 0) return "RISCO_ZERO";
  if (c.obstaculo === null) return "SEM_OBSTACULO_CONHECIDO";
  return "ESPACO_NAO_MENSURAVEL";
}

/**
 * ADAPTADOR — extrai os candidatos de um `ResultadoDoPregao` já calculado.
 *
 * Somente-leitura: não altera o resultado nem dispara nova leitura de modelo.
 * As operações confirmadas entram como APROVADAS (passaram no gate por
 * definição — não existiria operação sem isso). As recusas por espaço entram
 * como recusadas, com o motivo que o motor registrou.
 *
 * A confiança vem da leitura do mesmo instante, quando existe. `OperacaoDoPregao`
 * ainda não carrega `origemDoObstaculo` nem `origemDoStop`; enquanto não
 * carregar, esses campos chegam nulos e a cascata os ordena depois dos
 * conhecidos. Quando o motor passar a carregá-los, o ranking afia sozinho.
 */
export function candidatosDoPregao(r: ResultadoDoPregao): CandidatoDoDia[] {
  const confiancaPorSegundo = new Map<number, number>();
  for (const l of r.leituras) {
    if (!confiancaPorSegundo.has(l.segundoNoVideo)) {
      confiancaPorSegundo.set(l.segundoNoVideo, l.confianca);
    }
  }

  const aprovados: CandidatoDoDia[] = r.operacoes.map((op) => ({
    setupId: op.setupId,
    segundoNoVideo: op.segundoNoVideo,
    dataDoGrafico: op.dataDoGrafico,
    horaDoGrafico: op.horaDoGrafico,
    direcao: op.direcao,
    entrada: op.entrada,
    stop: op.stop,
    riscoPontos: Math.abs(op.entrada - op.stop),
    obstaculo: op.alvo,
    espacoR: op.rr,
    origemDoObstaculo: op.alvo === null ? "NENHUM" : "LIDO",
    origemDoStop: null,
    confianca: confiancaPorSegundo.get(op.segundoNoVideo) ?? null,
    aprovadoNoGate: true,
    motivoDaRecusa: null,
  }));

  const recusados: CandidatoDoDia[] = r.recusasDeEspaco.map((rec, i) => ({
    setupId: `RECUSA-${String(i + 1).padStart(3, "0")}`,
    segundoNoVideo: rec.segundoNoVideo,
    dataDoGrafico: null,
    horaDoGrafico: null,
    direcao: rec.direcao,
    entrada: rec.entrada,
    stop: rec.stop,
    riscoPontos: rec.riscoPontos,
    obstaculo: rec.obstaculo,
    espacoR: rec.distanciaR,
    origemDoObstaculo: rec.origemDoObstaculo,
    origemDoStop: rec.origemDoStop,
    confianca: confiancaPorSegundo.get(rec.segundoNoVideo) ?? null,
    aprovadoNoGate: false,
    motivoDaRecusa: `SEM_ESPACO_3R:${rec.motivoSemEspaco}`,
  }));

  return [...aprovados, ...recusados];
}

/** O ranking direto do resultado de um pregão — o atalho de uso comum. */
export function rankingDoPregao(r: ResultadoDoPregao, data: string | null = null): RankingDoDia {
  return ranquearDia(candidatosDoPregao(r), data);
}
