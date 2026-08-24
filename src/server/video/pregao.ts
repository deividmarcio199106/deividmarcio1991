/**
 * O PREGÃO LIDO DO VÍDEO — devagar, print a print, como o operador olha.
 *
 * POR QUE ESTE CAMINHO SUBSTITUI A RECONSTRUÇÃO POR PIXEL. A tentativa
 * anterior montava OHLC candle a candle a partir dos pixels e costurava as
 * telas. Medido no material real: os candles de 1 minuto do Profit ocupam 1–2
 * pixels, o extrator (que exige 4 pixels coloridos por coluna) descarta ~30%
 * deles, e QUAIS descarta muda a cada frame com o anti-aliasing da rolagem —
 * 69 descontinuidades em 180 frames, metade dos candles batendo em ≤2 px e 40%
 * divergindo >16 px. Não é tolerância mal calibrada: é reconstrução impossível
 * naquela resolução.
 *
 * O QUE FUNCIONA É O QUE O SISTEMA JÁ FAZIA COM PRINT: entregar a imagem a
 * quem sabe LER GRÁFICO. O leitor visual devolve estrutura, zona, gatilho,
 * candle fechado, preço e confluências — a leitura de contexto (topo/fundo,
 * acumulação/distribuição, teste de região) que o pixel isolado não dá. Daí em
 * diante quem manda é a MESMA máquina de setup do caminho de print
 * (`advanceSetup`), com os mesmos estágios e a mesma trava de confirmação.
 *
 * "IGUAL AO VIVO" — O QUE A FRASE COBRE E O QUE NÃO COBRE (auditoria sênior):
 * COMPARTILHADO de verdade: a máquina de setup (`advanceSetup`), o gate de
 * risco dentro dela (`assessTradeRisk`, piso `riskGate.MIN_RR`), a gestão
 * (`LiveOutcomeTracker`) e os múltiplos de alvo (`DEFAULT_RISK_PARAMS`, via
 * ALVO_PARCIAL_R/ALVO_FINAL_R — nada redigitado). ESPECÍFICO do replay, e
 * declarado: a leitura vem do modelo visual (não de `analyze()` sobre série de
 * candles — a série não é reconstruível nesta resolução, ver acima), os alvos
 * são DERIVADOS da técnica quando o leitor não os entrega, e o espaço é medido
 * contra pivôs da varredura. Estatística daqui compara-se com o ao vivo nesses
 * termos — não como paridade candle a candle.
 *
 * A DISCIPLINA CAUSAL CONTINUA ESTRUTURAL: os prints saem do gerador de frames
 * em ordem, um por vez, e a decisão de cada instante é registrada ANTES de o
 * próximo existir. Ver o desfecho depois é legítimo — e é a única forma de
 * medir acerto —, mas ele entra só como CLASSIFICAÇÃO do que já foi decidido,
 * nunca como insumo da decisão.
 *
 * CADÊNCIA. Um print a cada N segundos de vídeo. Como a gravação é acelerada,
 * o intervalo é escolhido em CANDLES: o operador que confere o gráfico a cada
 * poucos minutos é exatamente este laço.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { LiveOutcomeTracker } from "@/lib/engines/liveOutcome";
import { DEFAULT_RISK_PARAMS } from "@/lib/engines/strategy";
import { autorizarDataset, type PapelDoDataset } from "@/lib/t4/datasetEnforcement";
import { t42DatasetSeen, verifyT42Freeze } from "@/server/tradingRepository";
import { advanceSetup, type SetupUpdate, type TrackedSetup } from "@/lib/print/setupTracker";
import type { ScaleAnchor } from "@/lib/vision/priceScale";
import { validatePrintAnalysis, type PrintAnalysis } from "@/lib/vision/printAnalysis";
import { analyzeChartPrint } from "@/services/ai/chartVision";
import type { PixelFrame } from "@/lib/capture/frameProcessor";
import type { VideoInfo } from "./ffmpeg";
import { extractJsonObject } from "@/lib/jsonExtract";
import { priceAt } from "@/lib/vision/priceScale";
import { aiConfig } from "@/services/ai/config";
import { CalibradorDeVideo, detectarCaixaDePreco, type EstadoDaCalibracao } from "./calibration";
import { alvosParaAnalise, reparoDoAlvo } from "./confirmacaoH3";
import type { Pivo } from "./varredura";
import { LedgerDeLeituras, sha256 } from "./leituraLedger";
import { lerFrames, recorteParaPngDataUrl, salvarFramePng } from "./frames";

/**
 * OS MÚLTIPLOS DE ALVO DA TÉCNICA — FONTE ÚNICA (auditoria sênior, BLOCO 3).
 *
 * O replay tinha os números 3 e 5 REDIGITADOS em quatro lugares (alvos
 * derivados, gate de espaço, gestão, contrafactual). Redigitado é um segundo
 * motor esperando divergir: o dia em que a técnica mudar o múltiplo em
 * `strategy.ts`, o replay continuaria medindo com o antigo e a estatística do
 * vídeo deixaria de valer para a produção. Agora os quatro pontos leem DAQUI —
 * e daqui, de `DEFAULT_RISK_PARAMS`, que é onde o ao vivo e o quant já leem.
 * Há teste de fonte lendo este arquivo e recusando o literal de volta.
 */
const ALVO_PARCIAL_R = DEFAULT_RISK_PARAMS.partialTargetMultiple;
const ALVO_FINAL_R = DEFAULT_RISK_PARAMS.finalTargetMultiple;

/**
 * A ESCALA LIDA DO EIXO — o que ancora os números do print.
 *
 * MEDIDO NESTA SESSÃO, e é a razão desta função existir: entregando o gráfico
 * inteiro ao leitor visual, ele descreve a estrutura muito bem ("fechamento
 * acima dos 19700 confirmando rompimento") mas devolve `currentPrice`, `entry`
 * e `stop` NULOS — e sem número não há confirmação, não há ordem e não há
 * desfecho para classificar. O mesmo modelo, recebendo só a RÉGUA do eixo, lê
 * os rótulos com precisão (provado em 9 s, valores conferidos contra a tela).
 *
 * Então cada print é lido em DUAS etapas, cada uma pedindo ao modelo o que ele
 * faz bem: a régua entrega a faixa de preços; o gráfico entrega a estrutura,
 * já sabendo em que ordem de grandeza os níveis vivem.
 */
interface EscalaDoPrint {
  ancoras: ScaleAnchor[];
  min: number;
  max: number;
  /** Estado completo da calibração — R², desvio, origem. */
  calibracao: EstadoDaCalibracao;
  /** Frase injetada no pedido de análise. Vazia quando a régua não saiu. */
  contexto: string;
  latenciaMs: number;
}

async function lerEscalaDoPrint(
  frame: PixelFrame,
  ativo: string,
  calibrador: CalibradorDeVideo,
  segundoNoVideo: number,
): Promise<EscalaDoPrint | null> {
  const t0 = Date.now();
  /*
   * A RÉGUA VEM DO CALIBRADOR — rótulo a rótulo, posição por geometria.
   *
   * Ler a régua inteira de uma vez devolvia valores certos e posições
   * enviesadas, e casá-las era ambíguo por periodicidade: aprovava com
   * R² = 1,0 projetando 7.700 pontos errado. O calibrador lê UM rótulo por
   * vez na linha que a geometria mediu, e o erro medido caiu para ~101 pontos.
   */
  const estado = await calibrador.atualizar(frame, segundoNoVideo);
  if (!estado.utilizavel) return null;
  const ancoras = estado.calibracao.anchors;
  const precos = ancoras.map((a) => a.price).filter((p) => Number.isFinite(p));
  if (precos.length < 2) return null;
  const min = Math.min(...precos);
  const max = Math.max(...precos);

  return {
    ancoras,
    min,
    max,
    calibracao: estado,
    /*
     * A INSTRUÇÃO É ESPECÍFICA PORQUE OS DOIS ERROS FORAM MEDIDOS.
     *
     * (1) ORDEM DE GRANDEZA. O modelo lia "196.30" do eixo e reportava 19630 —
     *     dez vezes menor que o preço real do WINFUT. O eixo do Profit usa o
     *     ponto como separador de MILHAR, e é isso que precisa ser dito, com
     *     exemplo, senão ele trata como decimal.
     *
     * (2) `visible`. Ele devolvia os níveis com `visible: false`, e a regra da
     *     casa — correta — descarta todo número não declarado como lido. Mas
     *     `visible` aqui significa "consigo localizar este nível no eixo",
     *     não "existe uma etiqueta desenhada com este número". Um nível
     *     derivado da estrutura E ancorado numa escala que NÓS lemos
     *     separadamente é legível; um número que ele não consegue situar no
     *     eixo não é. A faixa devolvida por esta função é a rede: qualquer
     *     valor fora dela é recusado do nosso lado.
     */
    contexto:
      `ESCALA DE PREÇOS DESTE GRÁFICO, já lida do eixo por outro leitor: de ` +
      `${Math.round(min)} (base) até ${Math.round(max)} (topo), em PONTOS do ${ativo}. ` +
      `\n\nREGRAS OBRIGATÓRIAS PARA TODO PREÇO QUE VOCÊ REPORTAR ` +
      `(currentPrice, entry, stop, targets, níveis e gatilhos):\n` +
      `1. Use NÚMERO INTEIRO em pontos, dentro da faixa acima. O eixo do Profit ` +
      `escreve o ponto como separador de MILHAR: o rótulo "${(Math.round(max) / 1000).toFixed(3)}" ` +
      `significa ${Math.round(max)} pontos, NÃO ${(Math.round(max) / 1000).toFixed(2)}. ` +
      `Reportar ${Math.round(max / 10)} onde o certo é ${Math.round(max)} é erro grave.\n` +
      `2. Marque "visible": true quando você conseguir LOCALIZAR o nível na escala ` +
      `acima — inclusive níveis que você derivou da estrutura (suporte, resistência, ` +
      `gatilho, alvo). "visible": false é só para o que você não consegue situar no eixo.\n` +
      `3. currentPrice é o valor da etiqueta destacada no eixo, na altura da última ` +
      `barra. Leia-o e informe dentro da faixa.\n` +
      `4. Leia a DATA e a HORA no eixo horizontal do próprio gráfico (embaixo), ` +
      `não em barras de título ou relógio do sistema operacional.`,
    latenciaMs: Date.now() - t0,
  };
}

/**
 * LEITURA DEDICADA DE NÍVEIS — pergunta só os números, e valida cada um.
 *
 * O leitor de estrutura preenche os campos numéricos com nulo mesmo citando os
 * níveis no texto — comportamento medido e estável do modelo. Esta chamada
 * separa a tarefa: uma pergunta curta, resposta em JSON puro, e CADA número é
 * validado contra a faixa da régua (com os candidatos ×10/×1000 para a notação
 * de milhar) antes de ser aceito. Número fora da faixa é descartado, nunca
 * ajustado no escuro.
 */
async function lerNiveisDedicado(
  dataUrl: string,
  ativo: string,
  min: number,
  max: number,
  /**
   * Níveis estruturais JÁ MEDIDOS pela varredura de preço, conhecíveis neste
   * instante. Quando existem, é deles que sai o obstáculo — não do modelo.
   */
  niveisMedidos: number[],
  ledger?: LedgerDeLeituras,
  experimento?: OpcoesDoPregao["experimento"],
): Promise<{
  /** COMPRA ou VENDA, decidida pela região e conferida contra o stop. */
  direcao: "COMPRA" | "VENDA" | null;
  entry: number | null;
  stop: number | null;
  target1: number | null;
  target2: number | null;
  /** A REGIÃO operacional — extremos da zona onde a entrada é válida. */
  zonaMin: number | null;
  zonaMax: number | null;
  /** Próximo obstáculo estrutural a favor. Null quando não legível. */
  obstaculo: number | null;
  /** Espaço até o obstáculo, em R. Null sem obstáculo legível OU do lado errado. */
  espacoReal: number | null;
  /** Há 3R medidos até o obstáculo? Espaço não medido conta como NÃO. */
  espacoSuficiente: boolean;
  /** Por que o espaço não foi medido — separa ignorância de obstáculo torto. */
  motivoSemEspaco: "LIDO" | "NAO_LIDO" | "LADO_ERRADO" | "RISCO_ZERO";
  /** De onde veio o obstáculo: pivô medido, leitura do modelo, ou nenhum. */
  origemDoObstaculo: "MEDIDO" | "LIDO" | "NENHUM";
  /** O stop que o MODELO tinha dado — sempre preservado para a forense. */
  stopDoModelo: number | null;
  /** Como o stop final foi determinado. MODELO = baseline intacto. */
  origemDoStop: "MODELO" | "ESTRUTURAL" | "PISO" | "SEM_ZONA_PISO";
} | null> {
  const config = aiConfig();
  if (!config.baseUrl || !config.visionModel) return null;
  const base64 = dataUrl.split(",")[1];
  if (base64 === undefined) return null;

  /*
   * A DIVISÃO PERCEPÇÃO/REGRA, EXPLÍCITA. O que congela no ledger é o JSON
   * CRU que o modelo respondeu — a percepção. Tudo o que vem depois (validar
   * contra a faixa, ordenar a zona, conferir direção contra stop, escolher o
   * obstáculo entre os pivôs, derivar 3R/5R) é REGRA, determinística, e roda
   * de novo em toda corrida — é exatamente o que os experimentos podem mudar
   * sobre a MESMA percepção.
   */
  const valida = (bruto: unknown): number | null => {
    const n = typeof bruto === "number" ? bruto : Number(bruto);
    if (!Number.isFinite(n) || n <= 0) return null;
    const candidato = [n, n * 10, n * 1000].find((c) => c >= min && c <= max);
    return candidato === undefined ? null : Math.round(candidato);
  };

  const pedido =
    `Este é um gráfico de candles do ${ativo}. A escala de preços visível vai de ` +
    `${min} (base) a ${max} (topo), em pontos.\n\n` +
    `Leia a ESTRUTURA como um operador leria: topos e fundos, suporte e ` +
    `resistência, acumulação ou distribuição, onde o preço foi defendido e onde ` +
    `foi rejeitado.\n\n` +
    `Defina a REGIÃO OPERACIONAL mais próxima do preço atual — a faixa onde vale ` +
    `entrar, não uma linha única — e diga se essa região é de COMPRA (suporte/ ` +
    `demanda, entra comprado) ou de VENDA (resistência/oferta, entra vendido). ` +
    `Escolha pela estrutura, não por viés: se a região próxima é de resistência, ` +
    `a resposta é VENDA.\n\n` +
    `O STOP fica FORA da região, do lado da invalidação: abaixo de zonaMin numa ` +
    `COMPRA, acima de zonaMax numa VENDA.\n\n` +
    `Diga também onde está o PRÓXIMO OBSTÁCULO ESTRUTURAL na direção do ` +
    `trade — a primeira resistência acima numa COMPRA, o primeiro suporte ` +
    `abaixo numa VENDA. É o que limita o quanto o preço pode andar a favor.\n\n` +
    `Responda APENAS um JSON com inteiros dentro da faixa (ou null): ` +
    `{"direcao": "COMPRA" ou "VENDA", "zonaMin": limite inferior da região, ` +
    `"zonaMax": limite superior, "entry": referência dentro da região, ` +
    `"stop": invalidação fora da região, "obstaculo": próximo obstáculo ` +
    `estrutural a favor}.`;

  try {
    const imageHash = sha256(dataUrl);
    const promptHash = sha256(`lerNiveisDedicado@1|${config.visionModel}|${pedido}`);
    const congelada = ledger?.consultar(imageHash, promptHash);
    let o: Record<string, unknown>;
    if (congelada !== undefined && congelada !== null) {
      o = congelada.valor as Record<string, unknown>;
    } else {
      const t0 = Date.now();
      const resposta = await fetch(`${config.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.visionModel,
          stream: false,
          think: false,
          format: "json",
          messages: [{ role: "user", content: pedido, images: [base64] }],
        }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!resposta.ok) return null;
      const json = (await resposta.json()) as { message?: { content?: string } };
      const bruto = json.message?.content ?? "";
      const objeto = extractJsonObject(bruto);
      // Resposta sem JSON é falha transitória, não percepção: não grava.
      if (objeto === null || typeof objeto !== "object") return null;
      o = objeto as Record<string, unknown>;
      ledger?.registrar({
        tipo: "niveis",
        imageHash,
        promptHash,
        provider: "ollama",
        model: config.visionModel,
        parametros: { think: false, format: "json", timeoutMs: 90_000 },
        respostaBrutaHash: sha256(bruto),
        valor: o,
        tentativa: 1,
        latenciaMs: Date.now() - t0,
      });
    }
    const entry = valida(o["entry"]);
    const stop = valida(o["stop"]);
    if (entry === null || stop === null) return null;

    /*
     * A REGIÃO SÓ VALE SE FOR UMA REGIÃO DE VERDADE.
     *
     * Dois limites lidos, ordenados, e com o `entry` dentro deles — senão o
     * que veio não é uma faixa operacional, é ruído com dois números. Nesse
     * caso a zona sai nula e a máquina volta a usar a linha, que é o
     * comportamento antigo: degradar para o conhecido, nunca inventar faixa.
     */
    const z1 = valida(o["zonaMin"]);
    const z2 = valida(o["zonaMax"]);
    let zonaMin: number | null = null;
    let zonaMax: number | null = null;
    if (z1 !== null && z2 !== null) {
      const baixo = Math.min(z1, z2);
      const alto = Math.max(z1, z2);
      if (alto > baixo && entry >= baixo && entry <= alto) {
        zonaMin = baixo;
        zonaMax = alto;
      }
    }

    /*
     * A DIREÇÃO SAI DA REGIÃO, e é conferida contra o stop.
     *
     * Numa COMPRA o stop fica ABAIXO da entrada; numa VENDA, acima. Se o que
     * o leitor respondeu não bate com onde ele mesmo pôs o stop, a leitura é
     * incoerente e a direção sai nula — a máquina fica com a direção da
     * análise estrutural, e nenhuma entrada é montada sobre contradição.
     */
    const bruta = String(o["direcao"] ?? "").toUpperCase();
    const declarada = bruta === "COMPRA" || bruta === "VENDA" ? bruta : null;
    const coerente =
      declarada === null
        ? null
        : (declarada === "COMPRA" && stop < entry) || (declarada === "VENDA" && stop > entry)
          ? declarada
          : null;

    /*
     * OS ALVOS VÊM DA TÉCNICA; O ESPAÇO, DA ESTRUTURA.
     *
     * O DEFEITO QUE ISTO CORRIGE, medido: em 21 prints, 9 tinham entrada e
     * stop e só 3 tinham alvo. Sem alvo, `assessTradeRisk` devolve
     * RISK_UNKNOWN — que nunca aprova — e NENHUMA entrada acontecia. Pedir o
     * alvo ao leitor era pedir a coisa errada: alvo não é leitura de gráfico,
     * é CONTRATO da técnica. O `T4_FINAL.md` define: contrato 1 em 3R,
     * contrato 2 em 5R. Então derivamos daí, como o motor ao vivo já faz.
     *
     * MAS DERIVAR O ALVO NÃO PODE VIRAR CARIMBO. Se o alvo é sempre 3R, o
     * R:R é sempre 3 e o gate de risco aprova tudo — vira tautologia, que foi
     * exatamente um dos defeitos que a auditoria encontrou no motor. Por isso
     * o que julga aqui não é o R:R fabricado, e sim o ESPAÇO REAL: o próximo
     * obstáculo estrutural a favor precisa estar ALÉM do alvo de 3R. Resistência
     * a 2R de distância significa que não há espaço técnico — a operação é
     * recusada, e é essa recusa que torna a entrada responsável.
     *
     * E SEM OBSTÁCULO LEGÍVEL NÃO SE OPERA. A versão anterior deste comentário
     * dizia o contrário — "os alvos derivados valem assim mesmo" — e era a
     * própria brecha: com o alvo derivado e o espaço não medido, o gate
     * aprovava por ignorância. O leitor não ter medido o espaço não é prova de
     * que o espaço existe. `motivoSemEspaco` registra QUAL foi o caso, porque
     * "não li o obstáculo" e "li o obstáculo do lado errado" pedem correções
     * diferentes e estavam sendo contados como a mesma coisa.
     */
    const compra = coerente === "COMPRA" || (coerente === null && stop < entry);

    /*
     * H2 — O STOP ESTRUTURAL, quando o experimento está ligado.
     *
     * A direção acima foi julgada com o stop DO MODELO — percepção intacta.
     * Aqui, e só aqui, o experimento substitui a POSIÇÃO do stop:
     *
     *   risco = max(distância até a borda da zona + buffer, piso)
     *
     * O exemplo que define a regra (dado pelo dono da técnica): entrada
     * 100.000, obstáculo a 620, stop do modelo 260 ⇒ 2,38R, reprova. Borda
     * estrutural a 120 + buffer, piso 200 ⇒ o stop REAL é 200 — e 620/200 =
     * 3,1R aprova. Aprova porque o risco VERDADEIRO caiu para 200, não porque
     * o denominador foi maquiado para 120: o piso vale no stop EXECUTÁVEL.
     * Sem zona legível não há estrutura para ancorar: o stop do modelo fica,
     * só o piso se aplica (alargar é sempre permitido; apertar, nunca).
     */
    const stopDoModelo = stop;
    const stopDaRegra = stopEstruturalH2(
      compra,
      entry,
      stop,
      zonaMin,
      zonaMax,
      experimento?.stopEstrutural,
    );
    const stopFinal = stopDaRegra.stop;
    const origemDoStop = stopDaRegra.origem;

    const risco = Math.abs(entry - stopFinal);
    const alvo3R = compra ? entry + risco * ALVO_PARCIAL_R : entry - risco * ALVO_PARCIAL_R;
    const alvo5R = compra ? entry + risco * ALVO_FINAL_R : entry - risco * ALVO_FINAL_R;

    /*
     * O OBSTÁCULO MEDIDO GANHA DO OBSTÁCULO LIDO, sempre que existir.
     *
     * PERGUNTAR ISSO AO MODELO FOI MEDIDO E NÃO SE SUSTENTA. Em três leituras
     * cruas do mesmo vídeo ele devolveu `null` uma vez e, nas outras duas,
     * um número ACIMA da entrada numa operação de VENDA — obstáculo do lado
     * contrário ao trade. Na rodada completa veio nulo em TODOS os instantes
     * analisados. E é justamente o obstáculo que autoriza a operação: com o
     * alvo derivado em 3R, é a distância até ele que separa espaço técnico de
     * carimbo. Um gate que depende de um número que não vem não é um gate.
     *
     * Ele também não precisa ser lido. A varredura de preço já mediu os pivôs
     * da série — mesma régua, sem intermediário, de graça. O próximo obstáculo
     * a favor é o pivô mais próximo do lado de lá da entrada: o primeiro lugar
     * onde o mercado já mostrou que reage. O que o modelo respondeu fica como
     * último recurso, para o começo do pregão, quando ainda não há pivô
     * conhecido — e mesmo aí passa pelo teste de lado, mais abaixo.
     */
    const doLadoCerto = niveisMedidos.filter((n) => (compra ? n > entry : n < entry));
    const obstaculoMedido =
      doLadoCerto.length === 0
        ? null
        : compra
          ? Math.min(...doLadoCerto)
          : Math.max(...doLadoCerto);
    const obstaculo = obstaculoMedido ?? valida(o["obstaculo"]);
    const origemDoObstaculo: "MEDIDO" | "LIDO" | "NENHUM" =
      obstaculoMedido !== null ? "MEDIDO" : obstaculo !== null ? "LIDO" : "NENHUM";
    let espacoReal: number | null = null;
    /*
     * ESPAÇO NÃO MEDIDO NÃO É ESPAÇO SUFICIENTE.
     *
     * Este campo já nasceu `true` por omissão, e isso desmontava o gate: como
     * os alvos passaram a ser DERIVADOS (3R/5R da técnica), o R:R vira 3 por
     * construção e aprovaria toda leitura. O único fato que separa operação de
     * carimbo é a distância REAL até o próximo obstáculo — e quando ela não foi
     * medida, o que se tem é ignorância, não permissão.
     */
    let espacoSuficiente = false;
    let motivoSemEspaco: "LIDO" | "NAO_LIDO" | "LADO_ERRADO" | "RISCO_ZERO" = "NAO_LIDO";
    if (risco <= 0) {
      motivoSemEspaco = "RISCO_ZERO";
    } else if (obstaculo !== null) {
      const distancia = compra ? obstaculo - entry : entry - obstaculo;
      // Obstáculo do lado errado não é obstáculo a favor: leitura descartada.
      if (distancia > 0) {
        espacoReal = distancia / risco;
        // O obstáculo a favor precisa estar ALÉM do alvo parcial da técnica.
        espacoSuficiente = espacoReal >= ALVO_PARCIAL_R;
        motivoSemEspaco = "LIDO";
      } else {
        motivoSemEspaco = "LADO_ERRADO";
      }
    }

    return {
      direcao: coerente,
      entry,
      stop: stopFinal,
      target1: Math.round(alvo3R),
      target2: Math.round(alvo5R),
      zonaMin,
      zonaMax,
      obstaculo,
      espacoReal,
      espacoSuficiente,
      motivoSemEspaco,
      origemDoObstaculo,
      stopDoModelo,
      origemDoStop,
    };
  } catch {
    return null;
  }
}

/** Um instante lido do vídeo — o que a técnica viu e decidiu. */
export interface LeituraDoPregao {
  indice: number;
  segundoNoVideo: number;
  /** Data/hora lidas do PRÓPRIO gráfico, quando o leitor conseguiu. */
  dataDoGrafico: string | null;
  horaDoGrafico: string | null;
  status: string;
  direcao: string;
  confianca: number;
  precoAtual: number | null;
  estagio: string | null;
  headline: string;
  preAlerta: boolean;
  entradaConfirmada: boolean;
  entrada: number | null;
  stop: number | null;
  alvo: number | null;
  distanciaPontos: number | null;
  evento: string | null;
  /** Hash da imagem entregue ao modelo neste frame. Null em TRACK. */
  frameHash: string | null;
  /** Reparos que a validação aplicou — mostrados, nunca escondidos. */
  reparos: string[];
  erro: string | null;
  latenciaMs: number;
}

export interface OperacaoDoPregao {
  numero: number;
  setupId: string;
  /** Instante do vídeo e do gráfico no momento da confirmação. */
  segundoNoVideo: number;
  dataDoGrafico: string | null;
  horaDoGrafico: string | null;
  direcao: "COMPRA" | "VENDA";
  entrada: number;
  stop: number;
  alvo: number | null;
  rr: number | null;
  /** Caminho do PNG congelado no instante da confirmação. */
  frameDeProva: string | null;
  /** Preenchido pela CLASSIFICAÇÃO posterior — nunca pela decisão. */
  resultado: "GANHO" | "PERDA" | "NEUTRO" | "NAO_EXECUTADA" | "EM_ABERTO" | "SEM_DESFECHO" | null;
  saida: number | null;
  pontos: number | null;
  r: number | null;
  printsAteDesfecho: number | null;
  motivoDesfecho: string | null;
  /** Stop APOS o gerenciamento (protecao/lock/trailing). Null se nao moveu. */
  stopGerenciado: number | null;
  /**
   * MFE/MAE — a excursão máxima A FAVOR e CONTRA, em pontos, da confirmação
   * até o desfecho. É o que separa "entrada certa com gestão errada" (MFE alto
   * num loss) de "entrada errada" (MAE imediato) — a classificação do item 7
   * do estudo depende disto. Medidos sobre a série da varredura, então valem
   * com a aproximação declarada dela: um preço por frame, pavios entre frames
   * invisíveis.
   */
  mfePontos: number | null;
  maePontos: number | null;
  /** O 3o contrato seguia aberto em trailing quando a operacao encerrou. */
  runnerAtivo: boolean | null;
  /**
   * COMO o fechamento do candle de confirmação foi provado (BLOCO 2):
   * "PROVADA" = técnica completa; "DISPENSADA" = entrada no toque com
   * `exigirCandleFechado:false` (modo de pesquisa — homologação EXCLUI estas
   * linhas por padrão); null = registro sem rastro (não vira "PROVADA").
   */
  provaFechamento: "PROVADA" | "DISPENSADA" | null;
}

/**
 * O FUNIL CONTADO GATE A GATE.
 *
 * Existe para responder à única pergunta que importa quando o dia fecha
 * zerado: o defeito está na DETECÇÃO (candidatos de menos) ou na CONFIRMAÇÃO
 * (candidatos morrendo num gate específico)? Cada número aqui é um degrau do
 * funil; `recusas` guarda, por setup, a pendência exata que o impediu.
 */
export interface FunilDoPregao {
  framesTotais: number;
  framesComPreco: number;
  /** Frames em que o preço estava a menos de `proximidadePontos` de um nível. */
  candidatosFrames: number;
  /** Episódios de aproximação — sequências de candidatos, não frames soltos. */
  episodios: number;
  chamadasDeModelo: number;
  /** Frames em que a máquina andou com preço da régua + estrutura reaproveitada. */
  trackFrames: number;
  /** Leituras de modelo que falharam mas NÃO mataram o acompanhamento (§12). */
  leiturasFalharamMantidas: number;
  setupsNascidos: number;
  /** Setups que expiraram, com idade em minutos de MERCADO e observações. */
  expirados: Array<{ setupId: string; idadeMinutos: number; observacoes: number }>;
  /** Pendência → quantos setups morreram com ela em aberto (cada um conta 1×). */
  recusas: Record<string, number>;
}

/**
 * A FORENSE DE CADA RECUSA POR ESPAÇO — o dado que julga a trava.
 *
 * A trava de 3R está zerando os dias, e a única forma honesta de julgá-la é
 * registrar, PARA CADA recusa, o que ela recusou e o que teria acontecido.
 * Três respostas possíveis, e cada campo daqui alimenta uma:
 *   (A) o obstáculo já estava morto quando contou — `excessoAlemDoObstaculo`
 *       mostra o quanto o preço já tinha aceitado além dele;
 *   (B) o stop estava largo demais — `riscoPontos` contra a distância;
 *   (C) o espaço realmente não existia — o contrafactual perde.
 *
 * O CONTRAFACTUAL É SIMULAÇÃO E ESTÁ ROTULADO COMO TAL: mesma máquina de
 * gestão do backtest (LiveOutcomeTracker), sobre a série de preços da
 * varredura, com os alvos 3R/5R que a operação teria. Nunca entra em
 * estatística oficial — existe para contar quantas recusas protegeram e
 * quantas bloquearam trade bom.
 */
export interface RecusaDeEspaco {
  indice: number;
  segundoNoVideo: number;
  direcao: "COMPRA" | "VENDA";
  entrada: number;
  stop: number;
  riscoPontos: number;
  obstaculo: number | null;
  distanciaPontos: number | null;
  distanciaR: number | null;
  /** MEDIDO (pivô da varredura), LIDO (modelo) ou NENHUM. */
  origemDoObstaculo: "MEDIDO" | "LIDO" | "NENHUM";
  motivoSemEspaco: "LIDO" | "NAO_LIDO" | "LADO_ERRADO" | "RISCO_ZERO";
  /** A zona operacional lida — é dela que o stop estrutural da H2 nasce. */
  zonaMin: number | null;
  zonaMax: number | null;
  /** O stop cru do modelo e como o stop final foi determinado. */
  stopDoModelo: number | null;
  origemDoStop: "MODELO" | "ESTRUTURAL" | "PISO" | "SEM_ZONA_PISO";
  /** TOPO/FUNDO quando o obstáculo é um pivô medido. */
  tipoDoPivo: "TOPO" | "FUNDO" | null;
  /** Idade do pivô no instante da decisão, em minutos de MERCADO. */
  idadeDoPivoMinutos: number | null;
  /**
   * O quanto o preço JÁ tinha andado além do obstáculo (na direção do trade)
   * entre a formação do pivô e o instante da decisão, em pontos. Zero = nível
   * intacto. É a medição crua que a H1 vai limiarizar — aqui não há regra.
   */
  excessoAlemDoObstaculo: number | null;
  /** O que teria acontecido sem a trava — SIMULADO, nunca estatística oficial. */
  semTrava: {
    resultado: string | null;
    r: number | null;
    pontos: number | null;
    mfePontos: number | null;
    maePontos: number | null;
    motivo: string | null;
  } | null;
}

export interface ResultadoDoPregao {
  video: string;
  ativo: string;
  inicioSeg: number;
  fimSeg: number;
  intervaloSeg: number;
  printsLidos: number;
  printsValidos: number;
  printsComErro: number;
  /** Prints em que a régua do eixo foi lida — âncora dos números. */
  printsComEscala: number;
  printsSemEscala: number;
  /** Entradas recusadas por falta de 3R de espaço até o obstáculo. */
  recusadasPorEspaco: number;
  /** Frames percorridos pela régua sem custar nenhuma chamada de modelo. */
  framesSoDeRegua: number;
  /** T4.2 (quando experimento.execucaoT42): fills e expirações sem toque. */
  t42Fills: number;
  t42ExpiredNoFill: number;
  /** B9: veredito do gate de dataset na primeira data legível do pregão. */
  dataset: { dataIso: string; papel: PapelDoDataset; enforcado: boolean } | null;
  /** Instantes efetivamente entregues ao modelo. */
  instantesAnalisados: number;
  /** Leituras dedicadas que devolveram entrada+stop utilizáveis. */
  comNiveis: number;
  /** O funil, contado gate a gate — onde os candidatos morrem. */
  funil: FunilDoPregao;
  /** Forense de cada alvo recusado por espaço — ver `RecusaDeEspaco`. */
  recusasDeEspaco: RecusaDeEspaco[];
  /** Percepção congelada: quantas leituras vieram do ledger vs. do modelo. */
  ledgerResumo: { total: number; hits: number; misses: number } | null;
  /** Dessas, quantas também trouxeram o obstáculo — o gate de espaço só é real aqui. */
  comObstaculo: number;
  /** Faixa de preço lida do eixo no último print válido. */
  faixaDoEixoLida: { min: number; max: number } | null;
  /** Distribuição de status devolvida pelo leitor visual. */
  porStatus: Record<string, number>;
  porEstagio: Record<string, number>;
  aproximacoes: number;
  confirmacoes: number;
  leituras: LeituraDoPregao[];
  operacoes: OperacaoDoPregao[];
  ganhos: number;
  perdas: number;
  semDesfecho: number;
  pontosLiquidos: number;
  somaR: number;
  erro: string | null;
  duracaoMs: number;
}

export interface OpcoesDoPregao {
  ativo: string;
  inicioSeg: number;
  fimSeg: number;
  /** Segundos de vídeo entre um print e o próximo. */
  intervaloSeg: number;
  pastaDeSaida?: string;
  /** Segundos de vídeo entre revalidações da régua por OCR. */
  intervaloOcrSeg?: number;
  /**
   * Exigir candle FECHADO para confirmar. Padrão true (regra da casa).
   * `false` = ENTRADA NO TOQUE, por decisão explícita do operador.
   */
  exigirCandleFechado?: boolean;
  /** Recorte do gráfico enviado ao leitor. Padrão: frame inteiro. */
  recorte?: { left: number; top: number; width: number; height: number };
  /**
   * OS ÚNICOS INSTANTES EM QUE O MODELO É CHAMADO — em segundos de vídeo.
   *
   * POR QUE ISTO EXISTE. Cada print custa ~10 s de análise estrutural e mais
   * ~14 s de leitura dedicada de níveis (medido: 16 prints, 21/08/2026). Rodar
   * isso em todo print de um pregão é mais de uma hora por dia de mercado — e
   * gasta o caro nos 90% de prints em que não há nada acontecendo.
   *
   * A varredura de preço (`varredura.ts`) percorre o mesmo trecho SÓ com pixels
   * e aponta onde o preço voltou a uma região já defendida. São esses instantes
   * que entram aqui. Os demais frames continuam sendo lidos — a régua PRECISA
   * deles para se propagar sem OCR, e o preço deles alimenta a classificação —
   * mas não custam nenhuma chamada de modelo.
   *
   * Vazio ou ausente = todo print vai ao modelo, como antes.
   */
  somenteNestesSegundos?: number[];
  /**
   * NÍVEIS ESTRUTURAIS MEDIDOS, por instante de vídeo (em décimos de segundo).
   *
   * Vêm dos pivôs da varredura de preço, já filtrados pela regra causal: só os
   * que eram conhecíveis naquele instante. É deles que sai o obstáculo do gate
   * de espaço — ver a nota dentro de `lerNiveisDedicado` sobre por que
   * perguntar isso ao leitor visual não funciona.
   */
  niveisEstruturais?: Record<number, number[]>;
  /**
   * PERCEPÇÃO CONGELADA (ver leituraLedger.ts). `base` é o arquivo do
   * baseline; `novas` é o overlay do experimento — leituras que o baseline
   * nunca fez vão para lá, e o base fica só-leitura. Sem esta opção, cada
   * corrida pergunta ao modelo de novo, como sempre.
   */
  ledger?: { base: string; novas?: string };
  /**
   * EXPERIMENTO — nunca padrão, nunca silencioso. Cada campo aqui é a ÚNICA
   * variável que o experimento correspondente tem o direito de mudar; o
   * contrato de comparação invalida qualquer corrida que mude mais que isso.
   *
   * `stopEstrutural` (H2): o stop deixa de ser escolha livre do leitor visual
   * e passa a ser a INVALIDAÇÃO ESTRUTURAL da zona + buffer técnico, com piso
   * de risco executável. A estrutura determina o stop; o piso só ALARGA,
   * nunca aperta — apertar o stop para inflar R:R é o que esta regra proíbe.
   * Percepção, obstáculo, gestão e o piso de 3R ficam idênticos ao baseline.
   */
  experimento?: {
    stopEstrutural?: {
      /** Folga além da borda da zona, em pontos — o erro real da régua. */
      bufferPontos: number;
      /** Risco mínimo EXECUTÁVEL, em pontos. Aplicado ao stop, não à conta. */
      pisoPontos: number;
    };
    /**
     * H1 — OBSTÁCULO VIVO. A única variável: quais níveis podem LIMITAR o
     * espaço. Um pivô morre (DEAD) quando o preço ACEITOU além dele — andou
     * na direção do rompimento pelo menos `aceitacaoPontos` depois de o pivô
     * ser conhecível. Toque ou furo menor que isso NÃO mata: falso rompimento
     * continua obstáculo. Só DEAD sai da lista; o scanner de candidatos, a
     * percepção, o stop, a gestão e o piso de 3R ficam idênticos ao baseline.
     */
    obstaculoVivo?: {
      /** Pontos de aceitação além do nível para declará-lo DEAD. */
      aceitacaoPontos: number;
    };
    /**
     * H3 — A CONFIRMAÇÃO DEIXA DE DEPENDER DO ALVO DE 3R. A única variável:
     * qual alvo vai para a análise quando o espaço medido fica abaixo do piso.
     * Com `alvoNoObstaculo`, o obstáculo medido vira o alvo e o trade nasce
     * marcado SUB_3R — o piso passa a dimensionar em vez de vetar. Percepção,
     * obstáculo, stop, gestão, gatilho e a medição de espaço ficam idênticos.
     * Ver `confirmacaoH3.ts` para a medição que originou a hipótese.
     */
    confirmacaoSemAlvo?: {
      /** Usar o obstáculo como alvo quando o espaço for menor que 3R. */
      alvoNoObstaculo: boolean;
    };
    /**
     * ENFORCEMENT DE DATASET (B9). O gate roda por padrão na primeira data
     * legível do gráfico: papel do mês, dia útil B3, contaminação
     * (datasetSeen do freeze) e — para o OOS — congelamento verificado.
     * `usoComoReferencia` declara a abertura de mês contaminado (março)
     * como referência; `enforce:false` existe SÓ para material sintético
     * de teste e fica registrado no resultado.
     */
    dataset?: {
      enforce?: boolean;
      usoComoReferencia?: boolean;
    };
    /**
     * EXECUÇÃO T4.2-HYBRID_ENTRY (candidata congelada) — liga o MESMO motor
     * (t4/t42FillEngine, via setupTracker) neste replay de vídeo. Os candles
     * fechados pós-E2 vêm das leituras MODELO com OHLC completo e legível;
     * quando a resolução da gravação não permite ler OHLC (o caso comum em
     * marco.mp4), a execução expira com E2_OPEN_OR_UNKNOWN — limitação do
     * DADO, declarada no resultado, nunca contornada com candle inventado.
     */
    execucaoT42?: boolean;
  };
  /**
   * O FUNIL: scanner permissivo na frente, rigor só na confirmação.
   *
   * A TRIAGEM ANTERIOR ERA O CONTRÁRIO, E FOI MEDIDA: exigia "saiu da região e
   * voltou" ANTES de chamar qualquer análise, e entregou 13 instantes num
   * pregão inteiro — a T4 nunca teve chance de acompanhar uma oportunidade até
   * a confirmação. O papel da triagem barata não é confirmar antecipadamente:
   * é apontar POSSÍVEL oportunidade. Quem confirma é o último gate.
   *
   * Com `funil` ativo, cada frame vira um de três modos:
   *   PULAR  — longe de qualquer nível conhecido e sem setup vivo: só a régua.
   *   TRACK  — setup vivo: a máquina anda TODO frame com o preço da régua e a
   *            estrutura da última leitura (declarada como reaproveitada).
   *   MODELO — início de aproximação, revalidação periódica, campo faltando ou
   *            preço entrando na zona: leitura completa.
   *
   * A confirmação no toque SÓ acontece em frame MODELO — dados frescos do
   * mesmo instante. TRACK nunca confirma: acompanhar não é decidir.
   */
  funil?: {
    /** Pivôs medidos pela varredura — os níveis que definem "perto". */
    pivos: Pivo[];
    /** Janela usada na detecção dos pivôs — define quando cada um é conhecível. */
    janelaDoPivo?: number;
    /** Distância (pontos) de um nível conhecido que acende um candidato. */
    proximidadePontos?: number;
    /** Frames entre releituras completas de um acompanhamento. */
    reanalisarAposFrames?: number;
  };
  aoProgredir?: (p: { print: number; segundo: number; confirmacoes: number }) => void;
}

/**
 * O DESFECHO COM STOP GERENCIADO — não é "bateu stop ou bateu alvo".
 *
 * O QUE ESTA FUNÇÃO DEIXOU DE FAZER. Ela comparava o preço com dois números
 * fixos e encerrava no primeiro toque. Isso mede uma operação que ninguém
 * opera: na T4 o stop ANDA — protege depois de 3,5R, trava +0,25R de lucro, e
 * o runner passa a trailing a partir de 5R, com o primeiro contrato saindo na
 * parcial. Medir com stop fixo subestima o ganho do runner e superestima a
 * perda de quem já tinha protegido.
 *
 * Agora quem gerencia é `LiveOutcomeTracker` — o MESMO motor do backtest e do
 * ao vivo. Uma segunda implementação de gestão divergiria da primeira no
 * primeiro ajuste, e a estatística do vídeo deixaria de valer para a produção.
 *
 * A APROXIMAÇÃO, DECLARADA: cada print observado vira um candle degenerado
 * (abertura = máxima = mínima = fechamento = o preço lido). É honesto porque é
 * o que de fato observamos — um preço por instante —, mas significa que
 * movimentos ENTRE prints não são vistos: um pavio que tocou o stop e voltou
 * antes do print seguinte passa despercebido. O resultado é otimista nesse
 * ponto específico, e o relatório diz isso.
 */
function classificar(
  op: OperacaoDoPregao,
  precosPosteriores: Array<{ preco: number; indice: number }>,
): void {
  const risco = Math.abs(op.entrada - op.stop);
  if (precosPosteriores.length === 0) {
    op.resultado = "SEM_DESFECHO";
    op.motivoDesfecho = "nenhum print posterior com preço legível";
    return;
  }

  // Parcial e alvo: quando só um alvo foi lido, a parcial é ele mesmo — o
  // gerenciamento continua valendo, com um degrau a menos.
  const parcial =
    op.alvo ??
    op.entrada + (op.direcao === "COMPRA" ? risco * ALVO_PARCIAL_R : -risco * ALVO_PARCIAL_R);
  const alvoFinal =
    op.direcao === "COMPRA" ? op.entrada + risco * ALVO_FINAL_R : op.entrada - risco * ALVO_FINAL_R;

  const gestor = new LiveOutcomeTracker(
    op.direcao,
    op.entrada,
    op.stop,
    parcial,
    alvoFinal,
    // Espera pela execução em PRINTS observados, não em candles de 1 minuto.
    Math.max(4, Math.min(40, precosPosteriores.length)),
    { threeContractRunner: true },
  );

  let ultimo = gestor.current();
  for (const p of precosPosteriores) {
    ultimo = gestor.push({ t: p.indice, o: p.preco, h: p.preco, l: p.preco, c: p.preco, v: 0 });
    if (ultimo.done) {
      op.printsAteDesfecho = p.indice;
      break;
    }
  }

  op.stopGerenciado = ultimo.protectedStop;
  op.runnerAtivo = ultimo.runnerActive;
  op.saida = ultimo.exit;
  op.motivoDesfecho = ultimo.exitReason ?? ultimo.detail;

  // MFE/MAE sobre o trecho vivido: da confirmação até o desfecho (ou o fim
  // do trecho lido, quando a operação ficou aberta).
  const fim = op.printsAteDesfecho ?? Number.POSITIVE_INFINITY;
  let mfe = 0;
  let mae = 0;
  for (const p of precosPosteriores) {
    if (p.indice > fim) break;
    const excursao = op.direcao === "COMPRA" ? p.preco - op.entrada : op.entrada - p.preco;
    if (excursao > mfe) mfe = excursao;
    if (-excursao > mae) mae = -excursao;
  }
  op.mfePontos = Math.round(mfe);
  op.maePontos = Math.round(mae);

  if (!ultimo.filled) {
    op.resultado = "NAO_EXECUTADA";
    op.motivoDesfecho = ultimo.detail;
    return;
  }
  if (!ultimo.done) {
    op.resultado = "SEM_DESFECHO";
    op.motivoDesfecho = "o trecho lido terminou com a operação aberta";
    return;
  }
  op.r = ultimo.rMultiple;
  op.pontos = ultimo.rMultiple === null ? null : ultimo.rMultiple * risco;
  op.resultado =
    ultimo.result === "GANHO" ? "GANHO" : ultimo.result === "PERDA" ? "PERDA" : "NEUTRO";
}

/**
 * A REGRA DO STOP DA H2 — pura, exportada, testável com o exemplo canônico.
 *
 * risco executável = max(distância até a borda da zona + buffer, piso).
 *
 * O exemplo que DEFINE a regra (dado pelo dono da técnica em 22/08/2026):
 * entrada 100.000, obstáculo a 620 pts, stop do modelo 260 ⇒ 2,38R, reprova.
 * Borda estrutural a 120 + buffer, piso 200 ⇒ stop REAL de 200 pts, e
 * 620/200 = 3,1R aprova — porque o risco verdadeiro caiu para 200, não porque
 * o denominador foi maquiado para 120. O piso vale no stop EXECUTÁVEL.
 *
 * Sem zona legível não há estrutura para ancorar: o stop do modelo fica e só
 * o piso se aplica. Alargar é sempre permitido; apertar sem estrutura, nunca.
 */
export function stopEstruturalH2(
  compra: boolean,
  entry: number,
  stopDoModelo: number,
  zonaMin: number | null,
  zonaMax: number | null,
  h2: { bufferPontos: number; pisoPontos: number } | undefined,
): { stop: number; origem: "MODELO" | "ESTRUTURAL" | "PISO" | "SEM_ZONA_PISO" } {
  if (h2 === undefined) return { stop: stopDoModelo, origem: "MODELO" };
  if (zonaMin !== null && zonaMax !== null) {
    const distanciaBorda = compra ? entry - zonaMin : zonaMax - entry;
    const riscoEstrutural = Math.max(0, distanciaBorda) + h2.bufferPontos;
    const riscoReal = Math.max(riscoEstrutural, h2.pisoPontos);
    return {
      stop: compra ? entry - riscoReal : entry + riscoReal,
      origem: riscoEstrutural >= h2.pisoPontos ? "ESTRUTURAL" : "PISO",
    };
  }
  const riscoReal = Math.max(Math.abs(entry - stopDoModelo), h2.pisoPontos);
  return {
    stop: compra ? entry - riscoReal : entry + riscoReal,
    origem: "SEM_ZONA_PISO",
  };
}

/**
 * A VIDA DE UM NÍVEL (H1) — quanto o preço já ACEITOU além dele.
 *
 * TOPO rompe para CIMA; FUNDO rompe para BAIXO. O excesso é o máximo que o
 * preço andou na direção do rompimento DEPOIS de o pivô ser conhecível
 * (indice + janela — antes disso ninguém sabia que ali havia um nível).
 * Toque e furo pequeno devolvem excesso pequeno: falso rompimento não mata.
 * A H1 declara DEAD quando o excesso cruza a aceitação; morto não volta —
 * regra monotônica declarada, sem estado escondido.
 */
export function excessoAlemDoNivel(
  pivo: Pivo,
  precos: ReadonlyArray<{ preco: number; indice: number }>,
  janelaDoPivo: number,
): number {
  const desde = pivo.indice + janelaDoPivo;
  let excesso = 0;
  for (const p of precos) {
    if (p.indice < desde) continue;
    const alem = pivo.tipo === "TOPO" ? p.preco - pivo.preco : pivo.preco - p.preco;
    if (alem > excesso) excesso = alem;
  }
  return excesso;
}

/** Décimos de segundo — ver a nota em `instantesAlvo`. */
function chaveDoInstante(segundo: number): number {
  return Math.round(segundo * 10);
}

/** Estágios em que não há mais o que acompanhar — o resto é setup VIVO. */
const ESTAGIOS_TERMINAIS = new Set<string>([
  "CLOSED",
  "INVALIDATED",
  "EXPIRED",
  "BREAKOUT_FAILED",
  "RISK_REJECTED",
]);

/**
 * Lê um trecho do vídeo como pregão, print a print.
 *
 * Cada print atravessa: leitor visual → validação → máquina de setup. O
 * congelamento acontece na confirmação; a classificação, no fim, sobre os
 * preços dos prints seguintes.
 */
export async function lerPregaoDoVideo(
  info: VideoInfo,
  opcoes: OpcoesDoPregao,
): Promise<ResultadoDoPregao> {
  const t0 = Date.now();
  const pasta = opcoes.pastaDeSaida ?? null;
  if (pasta !== null) mkdirSync(pasta, { recursive: true });
  const nome = info.caminho.split(/[\\/]/).pop() ?? "video";
  const log = pasta !== null ? join(pasta, `${nome}.pregao.ndjson`) : null;
  if (log !== null) writeFileSync(log, "");

  const ledger = opcoes.ledger === undefined ? undefined : new LedgerDeLeituras(opcoes.ledger);
  const calibrador = new CalibradorDeVideo(opcoes.ativo, {
    intervaloOcrSeg: opcoes.intervaloOcrSeg ?? 30,
    ledger,
  });

  const r: ResultadoDoPregao = {
    video: info.caminho,
    ativo: opcoes.ativo,
    inicioSeg: opcoes.inicioSeg,
    fimSeg: opcoes.fimSeg,
    intervaloSeg: opcoes.intervaloSeg,
    printsLidos: 0,
    printsValidos: 0,
    printsComErro: 0,
    printsComEscala: 0,
    printsSemEscala: 0,
    recusadasPorEspaco: 0,
    framesSoDeRegua: 0,
    t42Fills: 0,
    t42ExpiredNoFill: 0,
    dataset: null,
    instantesAnalisados: 0,
    comNiveis: 0,
    funil: {
      framesTotais: 0,
      framesComPreco: 0,
      candidatosFrames: 0,
      episodios: 0,
      chamadasDeModelo: 0,
      trackFrames: 0,
      leiturasFalharamMantidas: 0,
      setupsNascidos: 0,
      expirados: [],
      recusas: {},
    },
    recusasDeEspaco: [],
    ledgerResumo: null,
    comObstaculo: 0,
    faixaDoEixoLida: null,
    porStatus: {},
    porEstagio: {},
    aproximacoes: 0,
    confirmacoes: 0,
    leituras: [],
    operacoes: [],
    ganhos: 0,
    perdas: 0,
    semDesfecho: 0,
    pontosLiquidos: 0,
    somaR: 0,
    erro: null,
    duracaoMs: 0,
  };

  /*
   * A CHAVE DO INSTANTE É EM DÉCIMOS DE SEGUNDO.
   *
   * O gerador devolve `inicio + indice / fps`, que em ponto flutuante quase
   * nunca é exatamente o número que a varredura anotou. Comparar float com
   * float aqui faria a triagem descartar silenciosamente todos os instantes —
   * o pior defeito possível: uma rodada inteira sem entradas e sem motivo.
   */
  const instantesAlvo =
    opcoes.somenteNestesSegundos === undefined || opcoes.somenteNestesSegundos.length === 0
      ? null
      : new Set(opcoes.somenteNestesSegundos.map(chaveDoInstante));

  let setup: TrackedSetup | null = null;
  let sequencia = 0;
  /** T4.2: candles fechados PROVADOS acumulados desde o E2 (leituras MODELO). */
  const candlesT42: Array<{ o: number; h: number; l: number; c: number }> = [];
  let ultimoCandleT42Label: string | null = null;
  /** B9: o gate de dataset roda UMA vez, na primeira data legível do gráfico. */
  let datasetVerificado = false;
  let aproximacaoAnterior = false;
  let confirmadoAnterior = false;
  /** Preços legíveis por índice de print — base da classificação posterior. */
  const precos: Array<{ preco: number; indice: number }> = [];

  /* ------------------------- estado do funil ------------------------- */
  const funil = opcoes.funil ?? null;
  const janelaDoFunil = funil?.janelaDoPivo ?? 8;
  const proximidadeDoFunil = funil?.proximidadePontos ?? 250;
  const reanalisarApos = funil?.reanalisarAposFrames ?? 12;
  /** Frames sem candidato antes de um episódio de aproximação se encerrar. */
  const folgaDoEpisodio = 5;
  const pivosOrdenados = funil === null ? [] : [...funil.pivos].sort((a, b) => a.indice - b.indice);
  let ponteiroDePivos = 0;
  /** Pivôs já CONHECÍVEIS — com TIPO, porque a vida do nível depende dele. */
  const pivosConhecidos: Pivo[] = [];
  /** Níveis já CONHECÍVEIS — pivô só existe depois da janela à direita. */
  const niveisConhecidos = new Set<number>();
  /** A última leitura completa — o que o TRACK reaproveita, declarando. */
  let ultimaAnalise: PrintAnalysis | null = null;
  let ultimaLeituraSeg: number | null = null;
  let framesDesdeModelo = 1_000_000;
  let emEpisodio = false;
  let framesForaDoEpisodio = 0;
  /** Pendências vistas por setup TOCADO — viram `recusas` no fim (1× cada). */
  const pendenciasPorSetup = new Map<string, Set<string>>();

  try {
    // fps derivado do intervalo: 1 frame a cada `intervaloSeg` segundos.
    const fps = 1 / Math.max(0.05, opcoes.intervaloSeg);
    for await (const f of lerFrames(info, {
      fps,
      inicioSeg: opcoes.inicioSeg,
      fimSeg: opcoes.fimSeg,
    })) {
      const inicioDoPrint = Date.now();

      /*
       * A RÉGUA ANDA EM TODO FRAME, mesmo nos que não vão ao modelo.
       *
       * Não é desperdício: a propagação da grade casa as linhas de um frame com
       * as do ANTERIOR (calibration.ts). Pular frames afasta os vizinhos, a
       * grade anda mais de meio passo entre eles e a propagação casa a linha
       * errada — ou, com o portão de qualidade fazendo seu trabalho, obriga uma
       * OCR nova a cada leitura. Medido nesta sessão, com a propagação já
       * corrigida: 63% dos frames com preço e 12 OCRs em 43 s de vídeo, contra
       * 4,6% e 21 OCRs quando a régua não se propagava.
       */
      const escala = await lerEscalaDoPrint(f.frame, opcoes.ativo, calibrador, f.segundoNoVideo);
      const yDaCaixa = escala === null ? null : detectarCaixaDePreco(f.frame);
      const precoDaRegua =
        escala === null || yDaCaixa === null
          ? null
          : priceAt(escala.calibracao.calibracao, yDaCaixa);
      if (
        precoDaRegua !== null &&
        Number.isFinite(precoDaRegua) &&
        precoDaRegua >= escala!.min - 2250 &&
        precoDaRegua <= escala!.max + 2250
      ) {
        // A série densa de preços é o que classifica o desfecho depois.
        precos.push({ preco: Math.round(precoDaRegua), indice: f.indice });
      }

      /* ---------------- O FUNIL DECIDE O QUE ESTE FRAME MERECE ---------------- */
      const precoValido =
        precoDaRegua !== null &&
        Number.isFinite(precoDaRegua) &&
        escala !== null &&
        precoDaRegua >= escala.min - 2250 &&
        precoDaRegua <= escala.max + 2250;
      const precoInteiro = precoValido ? Math.round(precoDaRegua!) : null;

      let modoDoFrame: "PULAR" | "TRACK" | "MODELO" =
        instantesAlvo !== null && !instantesAlvo.has(chaveDoInstante(f.segundoNoVideo))
          ? "PULAR"
          : "MODELO";
      let niveisDoInstante: number[] = [];
      let setupVivoNoFrame = false;

      if (funil !== null) {
        r.funil.framesTotais++;
        if (precoValido) r.funil.framesComPreco++;
        framesDesdeModelo++;

        // Pivôs que JÁ cumpriram a janela viram níveis conhecidos — nunca antes.
        while (
          ponteiroDePivos < pivosOrdenados.length &&
          pivosOrdenados[ponteiroDePivos]!.indice + janelaDoFunil <= f.indice
        ) {
          pivosConhecidos.push(pivosOrdenados[ponteiroDePivos]!);
          niveisConhecidos.add(pivosOrdenados[ponteiroDePivos]!.preco);
          ponteiroDePivos++;
        }
        niveisDoInstante = [...niveisConhecidos].sort((a, b) => a - b);

        /*
         * CANDIDATO É EVIDÊNCIA, NÃO VEREDITO: preço perto de um nível que o
         * mercado já defendeu. Sem exigir ter saído e voltado, sem exigir
         * confirmação — isso é papel dos gates finais, não do scanner.
         */
        const distanciaAoNivel =
          precoInteiro === null || niveisDoInstante.length === 0
            ? null
            : Math.min(...niveisDoInstante.map((n) => Math.abs(n - precoInteiro)));
        const candidato = distanciaAoNivel !== null && distanciaAoNivel <= proximidadeDoFunil;
        if (candidato) r.funil.candidatosFrames++;

        let episodioAbriuAgora = false;
        if (candidato) {
          if (!emEpisodio) {
            emEpisodio = true;
            episodioAbriuAgora = true;
            r.funil.episodios++;
          }
          framesForaDoEpisodio = 0;
        } else if (emEpisodio) {
          framesForaDoEpisodio++;
          if (framesForaDoEpisodio > folgaDoEpisodio) emEpisodio = false;
        }

        setupVivoNoFrame = setup !== null && !ESTAGIOS_TERMINAIS.has(setup.stage);
        if (setupVivoNoFrame) {
          /*
           * SETUP VIVO = ACOMPANHAMENTO INTENSIVO. A máquina anda TODO frame;
           * o modelo volta quando: nunca leu, venceu o prazo de revalidação,
           * falta entrada/stop (campo nulo não mata, convoca releitura), ou o
           * preço ENTROU na zona — porque confirmar exige dado fresco.
           */
          const z = setup!.entryZone;
          const nivelE = setup!.entryLevel;
          const stopS = setup!.stop;
          const dentroDaZona =
            precoInteiro !== null &&
            (z !== null
              ? precoInteiro >= z.min && precoInteiro <= z.max
              : nivelE !== null && stopS !== null
                ? Math.abs(precoInteiro - nivelE) <= Math.abs(nivelE - stopS) * 0.5
                : false);
          const precisaModelo =
            ultimaAnalise === null ||
            framesDesdeModelo >= reanalisarApos ||
            (dentroDaZona && framesDesdeModelo >= 2) ||
            // Campo nulo re-le com parcimonia (30 frames ~36 min de mercado): leitura
            // que falhou ha 3 frames quase sempre falha de novo — era a maior
            // fonte de chamadas repetidas do funil.
            ((setup!.entryLevel === null || setup!.stop === null) && framesDesdeModelo >= 30);
          modoDoFrame = precisaModelo ? "MODELO" : "TRACK";
        } else if (candidato) {
          // Sem setup vivo: o começo do episódio chama o modelo; depois,
          // releitura periódica enquanto o preço seguir perto do nível.
          modoDoFrame =
            episodioAbriuAgora || framesDesdeModelo >= reanalisarApos ? "MODELO" : "PULAR";
        } else {
          modoDoFrame = "PULAR";
        }
      }

      if (modoDoFrame === "PULAR") {
        r.framesSoDeRegua++;
        continue;
      }

      let analise: PrintAnalysis | null = null;
      let reparos: string[] = [];
      let frameHashDoModelo: string | null = null;

      if (modoDoFrame === "MODELO") {
        r.instantesAnalisados++;
        r.printsLidos++;
        r.funil.chamadasDeModelo++;
        if (escala === null) r.printsSemEscala++;
        else r.printsComEscala++;

        const dataUrl =
          opcoes.recorte !== undefined
            ? recorteParaPngDataUrl(f.frame, opcoes.recorte)
            : recorteParaPngDataUrl(f.frame, {
                left: 0,
                top: 0,
                width: f.frame.width,
                height: f.frame.height,
              });
        if (dataUrl === null) {
          r.printsComErro++;
          continue;
        }

        // ETAPA 2 — A ESTRUTURA, já ancorada na escala lida na entrada do laço.
        // PERCEPÇÃO CONGELADA: mesma imagem + mesmo contexto ⇒ resposta gravada.
        const imageHash = sha256(dataUrl);
        frameHashDoModelo = imageHash;
        const promptEstrutura = sha256(`analyzeChartPrint@1|${escala?.contexto ?? ""}`);
        const congeladaEstrutura = ledger?.consultar(imageHash, promptEstrutura);
        let erroDaLeitura: string | null = null;
        if (congeladaEstrutura !== undefined && congeladaEstrutura !== null) {
          const guardado = congeladaEstrutura.valor as {
            analise: PrintAnalysis | null;
            reparos: string[];
            erro: string | null;
          };
          analise = guardado.analise;
          erroDaLeitura = guardado.erro;
          reparos = [
            ...guardado.reparos,
            "PERCEPÇÃO CONGELADA: leitura de estrutura reutilizada do ledger.",
          ];
        } else {
          const t0Estrutura = Date.now();
          const visao = await analyzeChartPrint(dataUrl, escala?.contexto);
          analise = visao.analysis;
          erroDaLeitura = visao.error;
          reparos = [...visao.repairs];
          if (analise === null && visao.ok) {
            const v = validatePrintAnalysis(visao);
            analise = v.analysis;
            reparos.push(...v.repairs);
          }
          // Falha transitória (erro sem análise) não é percepção: não grava.
          if (analise !== null || visao.ok) {
            ledger?.registrar({
              tipo: "estrutura",
              imageHash,
              promptHash: promptEstrutura,
              provider: "ollama",
              model: visao.model,
              parametros: { retryCount: visao.retryCount ?? 0 },
              respostaBrutaHash: null,
              valor: { analise, reparos: [...reparos], erro: erroDaLeitura },
              tentativa: (visao.retryCount ?? 0) + 1,
              latenciaMs: Date.now() - t0Estrutura,
            });
          }
        }

        /*
         * UMA LEITURA FALHA NÃO MATA O ACOMPANHAMENTO. Com setup vivo e uma
         * leitura anterior na mão, a falha degrada o frame para TRACK: estrutura
         * da última leitura, preço da régua, e nenhuma confirmação — decidir
         * sobre dado velho é o que TRACK não faz. Sem setup vivo, a falha segue
         * sendo o erro registrado que sempre foi.
         */
        if (analise === null && funil !== null && setupVivoNoFrame && ultimaAnalise !== null) {
          r.funil.leiturasFalharamMantidas++;
          const estruturaAntiga: PrintAnalysis = ultimaAnalise;
          analise =
            precoInteiro === null
              ? estruturaAntiga
              : { ...estruturaAntiga, currentPrice: { value: precoInteiro, visible: true } };
          reparos.push(
            `Leitura do modelo falhou; estrutura da leitura de ${ultimaLeituraSeg?.toFixed(1) ?? "?"}s mantida em acompanhamento, preço da régua.`,
          );
          modoDoFrame = "TRACK";
        }

        if (analise === null) {
          r.printsComErro++;
          const leitura: LeituraDoPregao = {
            indice: f.indice,
            segundoNoVideo: f.segundoNoVideo,
            dataDoGrafico: null,
            horaDoGrafico: null,
            status: "ERRO",
            direcao: "NEUTRO",
            confianca: 0,
            precoAtual: null,
            estagio: setup?.stage ?? null,
            headline: erroDaLeitura ?? "leitura não concluída",
            preAlerta: false,
            entradaConfirmada: false,
            entrada: null,
            stop: null,
            alvo: null,
            distanciaPontos: null,
            evento: null,
            frameHash: frameHashDoModelo,
            reparos,
            erro: erroDaLeitura,
            latenciaMs: Date.now() - inicioDoPrint,
          };
          r.leituras.push(leitura);
          if (log !== null) appendFileSync(log, JSON.stringify(leitura) + "\n");
          continue;
        }

        r.printsValidos++;
        if (escala !== null) r.faixaDoEixoLida = { min: escala.min, max: escala.max };
        r.porStatus[analise.status] = (r.porStatus[analise.status] ?? 0) + 1;

        /*
         * OS NÚMEROS VÊM DA RÉGUA, NÃO DA BOA VONTADE DO MODELO.
         *
         * Medido exaustivamente: o leitor visual descreve a estrutura com
         * qualidade, cita os níveis NO TEXTO ("fechamento acima de 19630") — e
         * devolve os CAMPOS numéricos nulos, mesmo com a escala inteira no
         * contexto. Sem número não há confirmação. Então cada fonte entrega o
         * que sabe:
         *
         *   preço atual → GEOMETRIA: o centro da caixa preta do eixo, convertido
         *                 pela régua calibrada (R² ≥ 0,9995, erro medido ~100
         *                 pontos). Nenhum modelo envolvido.
         *   níveis      → leitura DEDICADA e curta, que pergunta só os números,
         *                 validados contra a faixa da régua antes de entrar.
         *
         * Tudo que é injetado vira REPARO DECLARADO na leitura — o relatório
         * mostra a origem de cada número, nunca o disfarça como leitura do print.
         */
        if (
          escala !== null &&
          precoDaRegua !== null &&
          Number.isFinite(precoDaRegua) &&
          precoDaRegua >= escala.min - 2250 &&
          precoDaRegua <= escala.max + 2250 &&
          (analise.currentPrice.value === null || !analise.currentPrice.visible)
        ) {
          analise = {
            ...analise,
            currentPrice: { value: Math.round(precoDaRegua), visible: true },
          };
          reparos.push(
            `Preço atual ${Math.round(precoDaRegua)} lido da RÉGUA calibrada (caixa do eixo em y=${Math.round(yDaCaixa!)}), não do modelo.`,
          );
        }
        /*
         * A LEITURA DEDICADA ENTRA TAMBÉM QUANDO SÓ O ALVO FALTA.
         *
         * MEDIDO NESTA RODADA: no print de 2s o modelo devolveu entrada 198050 e
         * stop 197625 — e alvo nulo. Como o gatilho antigo era "entrada nula", a
         * leitura dedicada nem era chamada, e a trava reduzia o setup a T4 EM
         * FORMAÇÃO com o motivo "alvo NÃO IDENTIFICADO". Ou seja: os prints com
         * MAIS informação eram os que menos chegavam à decisão.
         *
         * Sem entrada e sem alvo o print não opera do mesmo jeito; então é a
         * ausência de QUALQUER um dos dois que convoca a leitura dedicada.
         */
        const temAlvoLegivel = analise.targets.some((t) => t.visible && t.value !== null);
        if (
          modoDoFrame === "MODELO" &&
          escala !== null &&
          (analise.entry.value === null || !temAlvoLegivel)
        ) {
          /*
           * H1 EM AÇÃO — e só aqui. O scanner de candidatos continua usando TODOS
           * os níveis (a sensibilidade do funil não muda); o que muda é a lista
           * que pode LIMITAR espaço: com o experimento ligado, pivô DEAD — preço
           * aceitou além dele — sai da lista de obstáculos. O reparo declara
           * quais morreram e por quanto.
           */
          let niveisParaObstaculo =
            funil !== null
              ? niveisDoInstante
              : (opcoes.niveisEstruturais?.[chaveDoInstante(f.segundoNoVideo)] ?? []);
          const h1 = opcoes.experimento?.obstaculoVivo;
          if (h1 !== undefined && funil !== null) {
            const mortos: string[] = [];
            const vivos = pivosConhecidos.filter((pivo) => {
              const excesso = excessoAlemDoNivel(pivo, precos, janelaDoFunil);
              if (excesso >= h1.aceitacaoPontos) {
                mortos.push(`${pivo.tipo} ${pivo.preco} (+${Math.round(excesso)})`);
                return false;
              }
              return true;
            });
            niveisParaObstaculo = [...new Set(vivos.map((p) => p.preco))].sort((a, b) => a - b);
            if (mortos.length > 0) {
              reparos.push(
                `H1: ${mortos.length} nível(is) DEAD ignorado(s) como obstáculo — ${mortos.join(", ")} — aceitação ≥ ${h1.aceitacaoPontos} pts.`,
              );
            }
          }
          const niveis = await lerNiveisDedicado(
            dataUrl,
            opcoes.ativo,
            escala.min,
            escala.max,
            niveisParaObstaculo,
            ledger,
            opcoes.experimento,
          );
          /*
           * ESPAÇO TÉCNICO INSUFICIENTE NÃO VIRA OPERAÇÃO — e é contado.
           *
           * Com os alvos derivados da técnica (3R/5R), o R:R passa a ser 3 por
           * construção e o gate de risco aprovaria tudo. O que separa operação de
           * carimbo é o ESPAÇO REAL: se o próximo obstáculo estrutural a favor
           * está a menos de 3R, não há para onde o preço ir, e a entrada é
           * recusada aqui — antes de virar setup. É esta recusa que faz a
           * frequência alta continuar responsável.
           */
          if (niveis !== null) {
            r.comNiveis++;
            if (niveis.obstaculo !== null) r.comObstaculo++;
          }
          /*
           * ESPAÇO INSUFICIENTE RECUSA O ALVO, NÃO O CANDIDATO.
           *
           * A versão anterior descartava a leitura INTEIRA — entrada, stop e
           * zona — quando o espaço não fechava. Isso confundia dois papéis:
           * reconhecer a oportunidade (entrada+stop+estrutura) e autorizar a
           * operação (espaço medido, R:R, confirmação). O setup tem o direito de
           * EXISTIR e ser acompanhado; sem alvo ele apenas não confirma — o gate
           * de risco devolve RISK_UNKNOWN, que nunca aprova. Se o espaço abrir
           * numa releitura (obstáculo rompido, novo pivô), o alvo entra e a
           * confirmação volta a ser possível. Hard gate no fim, funil aberto na
           * frente.
           */
          if (niveis !== null && !niveis.espacoSuficiente) {
            r.recusadasPorEspaco++;
            if (niveis.entry !== null && niveis.stop !== null) {
              const compraDaRecusa =
                niveis.direcao === "COMPRA" ||
                (niveis.direcao === null && niveis.stop < niveis.entry);
              // O pivô que forneceu o obstáculo — só entre os já conhecíveis.
              const pivoDoObstaculo =
                funil !== null && niveis.obstaculo !== null && niveis.origemDoObstaculo === "MEDIDO"
                  ? (pivosOrdenados
                      .filter(
                        (p) => p.indice + janelaDoFunil <= f.indice && p.preco === niveis.obstaculo,
                      )
                      .sort((a, b) => b.indice - a.indice)[0] ?? null)
                  : null;
              // Quanto o preço JÁ aceitou além do obstáculo desde a formação.
              let excesso: number | null = null;
              if (niveis.obstaculo !== null) {
                const desde = pivoDoObstaculo === null ? 0 : pivoDoObstaculo.indice + janelaDoFunil;
                let maior = 0;
                for (const p of precos) {
                  if (p.indice < desde) continue;
                  const alem = compraDaRecusa
                    ? p.preco - niveis.obstaculo
                    : niveis.obstaculo - p.preco;
                  if (alem > maior) maior = alem;
                }
                excesso = Math.round(maior);
              }
              r.recusasDeEspaco.push({
                indice: f.indice,
                segundoNoVideo: f.segundoNoVideo,
                direcao: compraDaRecusa ? "COMPRA" : "VENDA",
                entrada: niveis.entry,
                stop: niveis.stop,
                riscoPontos: Math.abs(niveis.entry - niveis.stop),
                obstaculo: niveis.obstaculo,
                distanciaPontos:
                  niveis.obstaculo === null ? null : Math.abs(niveis.obstaculo - niveis.entry),
                distanciaR: niveis.espacoReal,
                origemDoObstaculo: niveis.origemDoObstaculo,
                motivoSemEspaco: niveis.motivoSemEspaco,
                zonaMin: niveis.zonaMin,
                zonaMax: niveis.zonaMax,
                stopDoModelo: niveis.stopDoModelo,
                origemDoStop: niveis.origemDoStop,
                tipoDoPivo: pivoDoObstaculo?.tipo ?? null,
                idadeDoPivoMinutos:
                  pivoDoObstaculo === null
                    ? null
                    : Math.round((f.segundoNoVideo - pivoDoObstaculo.segundoNoVideo) * 12),
                excessoAlemDoObstaculo: excesso,
                semTrava: null,
              });
            }
            reparos.push(
              niveis.espacoReal !== null
                ? `Alvo recusado: obstáculo a ${niveis.espacoReal.toFixed(1)}R (${niveis.obstaculo}) — menos que os 3R de espaço técnico. Setup segue em acompanhamento, sem alvo não confirma.`
                : niveis.motivoSemEspaco === "LADO_ERRADO"
                  ? `Alvo recusado: obstáculo ${niveis.obstaculo} do lado CONTRÁRIO ao trade (E=${niveis.entry} S=${niveis.stop}) — leitura incoerente.`
                  : niveis.motivoSemEspaco === "RISCO_ZERO"
                    ? `Alvo recusado: entrada e stop no mesmo preço (${niveis.entry}) — risco zero.`
                    : "Alvo recusado: nenhum obstáculo conhecido a favor ainda — sem espaço medido, alvo 3R/5R seria autoprofecia. Setup segue em acompanhamento.",
            );
          }
          if (niveis !== null) {
            const alvosDaAnalise = alvosParaAnalise(
              niveis.target1,
              niveis.target2,
              niveis.obstaculo,
              niveis.espacoSuficiente,
              niveis.espacoReal,
              opcoes.experimento?.confirmacaoSemAlvo,
            );
            if (alvosDaAnalise.subTresR) {
              reparos.push(reparoDoAlvo(alvosDaAnalise, niveis.obstaculo));
            }
            analise = {
              ...analise,
              // A direção vem da REGIÃO: região de suporte compra, de resistência
              // vende. Só sobrescreve quando a leitura foi coerente com o stop.
              ...(niveis.direcao === null ? {} : { direction: niveis.direcao }),
              ...(niveis.entry === null ? {} : { entry: { value: niveis.entry, visible: true } }),
              ...(niveis.stop === null ? {} : { stop: { value: niveis.stop, visible: true } }),
              /*
               * A REGIÃO ENTRA COMO ZONA, e é ela que a máquina passa a usar.
               *
               * Com `entryZone` preenchida, o toque deixa de ser "preço a menos
               * de 0,03% da linha" (≈59 pontos no WINFUT) e passa a ser "preço
               * DENTRO da faixa operacional" — que é como o operador enxerga:
               * chegou na região de compra, vale. Sem zona legível, a máquina
               * volta sozinha para a linha: degradar para o conhecido.
               */
              ...(niveis.zonaMin === null || niveis.zonaMax === null
                ? {}
                : {
                    entryZone: {
                      min: { value: niveis.zonaMin, visible: true },
                      max: { value: niveis.zonaMax, visible: true },
                    },
                  }),
              /*
               * O ALVO SÓ EXISTE COM ESPAÇO PROVADO — é o hard gate da casa.
               *
               * E é aqui que ele decide se o trade EXISTE, não só quanto vale:
               * sem `targets`, `targetOf` devolve null, `assessTradeRisk` sai
               * RISK_UNKNOWN, e RISK_UNKNOWN nunca aprova. Medido no trecho
               * 568,4–645,2 s: o preço cruzou o gatilho e ficou 165 pontos além
               * dele em sete leituras seguidas, todas em ARMED, nenhuma
               * confirmada. H3 (desligada por padrão) muda só esta linha.
               */
              ...(alvosDaAnalise.targets.length === 0 ? {} : { targets: alvosDaAnalise.targets }),
            };
            reparos.push(
              niveis.zonaMin !== null && niveis.zonaMax !== null
                ? `Região ${niveis.zonaMin}–${niveis.zonaMax} · E=${niveis.entry} S=${niveis.stop}${niveis.origemDoStop === "MODELO" ? "" : ` (stop ${niveis.origemDoStop}, modelo dava ${niveis.stopDoModelo})`} · alvos 3R/5R da técnica (${niveis.target1}/${niveis.target2}) · obstáculo ${niveis.obstaculo ?? "?"} (${niveis.origemDoObstaculo}) a ${niveis.espacoReal === null ? "distância não medida" : niveis.espacoReal.toFixed(1) + "R"}.`
                : `Níveis lidos por leitura dedicada ancorada na régua (E=${niveis.entry} S=${niveis.stop} A1=${niveis.target1} A2=${niveis.target2}) — sem região legível, entrada por linha.`,
            );
          }
        }

        if (modoDoFrame === "MODELO") {
          ultimaAnalise = analise;
          ultimaLeituraSeg = f.segundoNoVideo;
          framesDesdeModelo = 0;
        }
      } else {
        /*
         * TRACK — a máquina anda com o que é sabido: o preço deste frame vem
         * da régua (medido agora); a estrutura vem da última leitura completa,
         * e o reparo DECLARA isso. Nada aqui é apresentado como lido do print.
         */
        if (ultimaAnalise === null || precoInteiro === null) {
          r.framesSoDeRegua++;
          continue;
        }
        const estruturaViva: PrintAnalysis = ultimaAnalise;
        analise = { ...estruturaViva, currentPrice: { value: precoInteiro, visible: true } };
        reparos = [
          `TRACK: estrutura reaproveitada da leitura de ${ultimaLeituraSeg?.toFixed(1) ?? "?"}s; preço ${precoInteiro} da régua calibrada.`,
        ];
        r.funil.trackFrames++;
      }

      if (analise === null) continue;

      /*
       * O INSTANTE É SINTÉTICO E DECLARADO: o replay avança ~12 candles por
       * segundo de vídeo (medido no contador de candles do Profit), então cada
       * segundo de vídeo vale ~12 minutos de mercado. A máquina de setup usa
       * `now` para cooldown e expiração — um relógio que andasse 1s por print
       * congelaria esses prazos.
       */
      sequencia += 1;
      const agora = Date.UTC(2026, 2, 2, 12, 0, 0) + Math.round(f.segundoNoVideo * 12 * 60_000);
      /*
       * B9 — O GATE DE DATASET na primeira data legível. Bloqueio aqui
       * ABORTA o pregão via exceção (cai no catch e vira r.erro explícito):
       * processar OOS sem freeze verificado não é degradação, é violação.
       */
      if (!datasetVerificado && (analise.chartClock?.date ?? null) !== null) {
        datasetVerificado = true;
        const enforce = opcoes.experimento?.dataset?.enforce !== false;
        const gate = autorizarDataset({
          data: analise.chartClock?.date ?? null,
          congelamento: verifyT42Freeze(),
          datasetSeen: t42DatasetSeen(),
          usoComoReferencia: opcoes.experimento?.dataset?.usoComoReferencia === true,
        });
        if (!gate.allowed) {
          if (enforce) {
            throw new Error(`DATASET BLOQUEADO ${gate.code}: ${gate.reason}`);
          }
          // enforce desligado (material sintético): o veredito fica
          // registrado como não-enforçado — nunca escondido.
          r.dataset = {
            dataIso: "SEM_AUTORIZACAO",
            papel: "REFERENCIA_CONTAMINADA",
            enforcado: false,
          };
        } else {
          r.dataset = { dataIso: gate.value.dataIso, papel: gate.value.papel, enforcado: enforce };
        }
      }
      /*
       * T4.2 — candles fechados PROVADOS a partir das leituras MODELO. O OHLC
       * só entra completo (os 4 campos legíveis) e com rótulo de tempo NOVO;
       * repetição do mesmo candle não conta duas vezes.
       */
      const candleLido = analise.lastClosedCandle;
      const ohlcCompleto =
        candleLido !== null &&
        candleLido.open.value !== null &&
        candleLido.high.value !== null &&
        candleLido.low.value !== null &&
        candleLido.close.value !== null
          ? {
              o: candleLido.open.value,
              h: candleLido.high.value,
              l: candleLido.low.value,
              c: candleLido.close.value,
            }
          : null;
      if (
        opcoes.experimento?.execucaoT42 === true &&
        setup !== null &&
        setup.t42 != null &&
        setup.t42.fillPrice === null &&
        ohlcCompleto !== null &&
        candleLido !== null &&
        candleLido.time !== null &&
        candleLido.time !== ultimoCandleT42Label
      ) {
        candlesT42.push(ohlcCompleto);
        ultimoCandleT42Label = candleLido.time;
      }
      const atualizacao: SetupUpdate = advanceSetup(setup, analise, agora, sequencia, {
        t42:
          opcoes.experimento?.execucaoT42 === true
            ? {
                e2: ohlcCompleto,
                candlesFechadosAposE2: candlesT42,
                obstaculo: null,
              }
            : undefined,
        /*
         * CONFIRMAR NO TOQUE EXIGE LEITURA FRESCA. TRACK reaproveita a
         * estrutura de uma leitura antiga; confirmar sobre ela seria decidir
         * com dado velho. Por isso TRACK trava a confirmação no toque — e o
         * frame em que o preço entra na zona força uma leitura NOVA no mesmo
         * instante, que aí sim pode confirmar.
         */
        exigirCandleFechado: modoDoFrame === "MODELO" ? (opcoes.exigirCandleFechado ?? true) : true,
      });
      setup = atualizacao.setup;

      if (setup !== null) r.porEstagio[setup.stage] = (r.porEstagio[setup.stage] ?? 0) + 1;
      // Ciclo de vida do acumulador T4.2: zera quando o setup morre ou troca.
      if (setup === null || setup.t42 == null || setup.t42.fillPrice !== null) {
        candlesT42.length = 0;
        ultimoCandleT42Label = null;
      }
      if (atualizacao.event === "T42_FILLED") r.t42Fills++;
      if (setup !== null && setup.stage === "EXPIRED" && setup.reason.includes("EXPIRED_NO_FILL"))
        r.t42ExpiredNoFill++;
      // O preço deste frame já entrou na série densa na entrada do laço.

      /* ------------------- o funil conta onde cada um morre ------------------- */
      if (atualizacao.event !== null && atualizacao.event.startsWith("NOVO SETUP")) {
        r.funil.setupsNascidos++;
      }
      if (setup !== null && setup.touched && !atualizacao.entradaConfirmada) {
        // Setup que TOCOU e não confirmou: as pendências deste frame são o
        // gate que o segurou. Cada setup conta cada pendência uma vez.
        const vistas = pendenciasPorSetup.get(setup.setupId) ?? new Set<string>();
        for (const p of atualizacao.pendencias) vistas.add(p);
        pendenciasPorSetup.set(setup.setupId, vistas);
      }
      if (atualizacao.event === "EXPIRED" && setup !== null) {
        r.funil.expirados.push({
          setupId: setup.setupId,
          idadeMinutos: Math.round((agora - setup.createdAt) / 60_000),
          observacoes: setup.printsSeen,
        });
      }

      // O registro no diário: todo frame MODELO, e os frames TRACK em que algo
      // aconteceu — evento, confirmação ou borda de pré-alerta.
      const registrar =
        modoDoFrame === "MODELO" ||
        atualizacao.event !== null ||
        atualizacao.entradaConfirmada !== confirmadoAnterior ||
        atualizacao.preAlert !== aproximacaoAnterior;

      // APROXIMAÇÃO: borda, não estado — um alerta por oportunidade.
      if (atualizacao.preAlert && !aproximacaoAnterior) r.aproximacoes++;
      aproximacaoAnterior = atualizacao.preAlert;

      // CONFIRMAÇÃO: congela o print e abre a operação.
      if (atualizacao.entradaConfirmada && !confirmadoAnterior && setup !== null) {
        r.confirmacoes++;
        const numero = r.operacoes.length + 1;
        let prova: string | null = null;
        if (pasta !== null) {
          const caminho = join(
            pasta,
            `${nome}.confirmada_${numero}_${f.segundoNoVideo.toFixed(1)}s.png`,
          );
          prova = salvarFramePng(f.frame, caminho) ? caminho : null;
        }
        const entrada = setup.entryLevel;
        const stop = setup.stop;
        if (entrada !== null && stop !== null) {
          const alvo = setup.target;
          const risco = Math.abs(entrada - stop);
          r.operacoes.push({
            numero,
            setupId: setup.setupId,
            segundoNoVideo: f.segundoNoVideo,
            dataDoGrafico: analise.chartClock?.date ?? null,
            horaDoGrafico: analise.chartClock?.time ?? null,
            direcao: setup.direction,
            entrada,
            stop,
            alvo,
            rr: alvo !== null && risco > 0 ? Math.abs(alvo - entrada) / risco : null,
            frameDeProva: prova,
            resultado: "EM_ABERTO",
            saida: null,
            pontos: null,
            r: null,
            printsAteDesfecho: null,
            motivoDesfecho: null,
            stopGerenciado: null,
            runnerAtivo: null,
            mfePontos: null,
            maePontos: null,
            // O rastro vem do setup NO INSTANTE da confirmação; ausência fica
            // null — nunca é promovida a "PROVADA" por omissão.
            provaFechamento: setup.provaFechamento ?? null,
          });
        }
      }
      confirmadoAnterior = atualizacao.entradaConfirmada;

      const leitura: LeituraDoPregao = {
        indice: f.indice,
        segundoNoVideo: f.segundoNoVideo,
        dataDoGrafico: analise.chartClock?.date ?? null,
        horaDoGrafico: analise.chartClock?.time ?? null,
        status: analise.status,
        direcao: analise.direction,
        confianca: analise.confidence,
        precoAtual: analise.currentPrice.value,
        estagio: setup?.stage ?? null,
        headline: atualizacao.headline,
        preAlerta: atualizacao.preAlert,
        entradaConfirmada: atualizacao.entradaConfirmada,
        entrada: setup?.entryLevel ?? null,
        stop: setup?.stop ?? null,
        alvo: setup?.target ?? null,
        distanciaPontos: atualizacao.distancePoints,
        evento: atualizacao.event,
        frameHash: frameHashDoModelo,
        reparos,
        erro: null,
        latenciaMs: Date.now() - inicioDoPrint,
      };
      if (registrar) {
        r.leituras.push(leitura);
        if (log !== null) appendFileSync(log, JSON.stringify(leitura) + "\n");
      }

      if (opcoes.aoProgredir && r.printsLidos % 5 === 0) {
        opcoes.aoProgredir({
          print: r.printsLidos,
          segundo: f.segundoNoVideo,
          confirmacoes: r.confirmacoes,
        });
      }
    }
  } catch (error) {
    r.erro = String(error).slice(0, 500);
  }

  /*
   * O CONTRAFACTUAL DE CADA RECUSA — simulado DEPOIS, com a série completa.
   *
   * Roda a MESMA gestão do backtest sobre a operação que a trava impediu.
   * Legítimo porque nada daqui voltou para a decisão: o pregão já acabou.
   */
  for (const recusa of r.recusasDeEspaco) {
    const risco = recusa.riscoPontos;
    if (risco <= 0) continue;
    const sobe = recusa.direcao === "COMPRA";
    const opSimulada: OperacaoDoPregao = {
      numero: 0,
      setupId: "SIMULACAO_SEM_TRAVA",
      segundoNoVideo: recusa.segundoNoVideo,
      dataDoGrafico: null,
      horaDoGrafico: null,
      direcao: recusa.direcao,
      entrada: recusa.entrada,
      stop: recusa.stop,
      alvo: sobe
        ? recusa.entrada + risco * ALVO_PARCIAL_R
        : recusa.entrada - risco * ALVO_PARCIAL_R,
      // R:R do alvo derivado: o múltiplo da técnica por construção.
      rr: ALVO_PARCIAL_R,
      frameDeProva: null,
      resultado: "EM_ABERTO",
      saida: null,
      pontos: null,
      r: null,
      printsAteDesfecho: null,
      motivoDesfecho: null,
      stopGerenciado: null,
      runnerAtivo: null,
      mfePontos: null,
      maePontos: null,
      // Contrafactual: operação que a trava IMPEDIU — não existe confirmação,
      // logo não existe prova de fechamento a registrar.
      provaFechamento: null,
    };
    classificar(
      opSimulada,
      precos.filter((p) => p.indice > recusa.indice),
    );
    recusa.semTrava = {
      resultado: opSimulada.resultado,
      r: opSimulada.r,
      pontos: opSimulada.pontos,
      mfePontos: opSimulada.mfePontos,
      maePontos: opSimulada.maePontos,
      motivo: opSimulada.motivoDesfecho,
    };
  }

  // As pendências acumuladas viram o mapa de recusas: 1 por setup por motivo.
  for (const vistas of pendenciasPorSetup.values()) {
    for (const motivo of vistas) {
      r.funil.recusas[motivo] = (r.funil.recusas[motivo] ?? 0) + 1;
    }
  }

  /*
   * CLASSIFICAÇÃO — só agora, e só sobre o que veio DEPOIS de cada decisão.
   *
   * É este passo que "vê o futuro", e ele é legítimo porque a decisão já está
   * congelada: nenhum número daqui volta para a operação, ele apenas diz o que
   * aconteceu com ela.
   */
  for (const op of r.operacoes) {
    const indiceDaConfirmacao = Math.round(
      (op.segundoNoVideo - opcoes.inicioSeg) / Math.max(0.05, opcoes.intervaloSeg),
    );
    classificar(
      op,
      precos.filter((p) => p.indice > indiceDaConfirmacao),
    );
    if (op.resultado === "GANHO") r.ganhos++;
    else if (op.resultado === "PERDA") r.perdas++;
    else r.semDesfecho++;
    /*
     * DESFECHO DESCONHECIDO NÃO SOMA ZERO — não soma NADA. O `?? 0` antigo
     * fazia EM_ABERTO/SEM_DESFECHO entrarem como resultado neutro, e a soma
     * fingia cobrir operações que ninguém mediu. As não-medidas já estão
     * declaradas em `semDesfecho`; as somas cobrem SÓ o que tem número.
     */
    if (typeof op.pontos === "number") r.pontosLiquidos += op.pontos;
    if (typeof op.r === "number") r.somaR += op.r;
  }

  r.ledgerResumo = ledger?.resumo() ?? null;
  r.duracaoMs = Date.now() - t0;
  if (pasta !== null) {
    writeFileSync(join(pasta, `${nome}.pregao.resultado.json`), JSON.stringify(r, null, 1));
  }
  return r;
}
