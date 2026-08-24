/**
 * A VARREDURA DE PREÇO — o pregão inteiro lido só com pixels, sem modelo.
 *
 * POR QUE ESTE MÓDULO EXISTE. Cada print entregue ao leitor visual custa ~10 s
 * de análise estrutural e mais ~14 s de leitura dedicada de níveis (medido
 * nesta sessão, 16 prints: mediana 10,5 s sem a leitura dedicada, 24,7 s com
 * ela). Varrer um pregão inteiro nesse preço é mais de uma hora por dia de
 * mercado — e o pior: gasta o caro em TODO print, inclusive nos que não têm
 * nada acontecendo.
 *
 * O QUE SAI DE GRAÇA. A régua já é calibrada por geometria + OCR
 * (`CalibradorDeVideo`) e se PROPAGA entre frames casando as linhas da grade;
 * a caixa preta do eixo dá o preço atual por pixel (`detectarCaixaDePreco` +
 * `priceAt`). Nenhum modelo participa disso. Então o preço do pregão inteiro
 * pode ser lido primeiro, barato, e as chamadas caras ficam para os instantes
 * que a estrutura apontar.
 *
 * A DENSIDADE NÃO É ESCOLHA DE GOSTO: a propagação da grade casa cada linha
 * com a mais próxima dentro de 0,45 × passo (`calibration.ts`). Se dois frames
 * amostrados estiverem longe demais, a grade anda mais de meio passo entre eles
 * e a propagação casa a linha ERRADA — preço plausível e falso, que é o pior
 * defeito possível aqui. Por isso a varredura é densa (ela pode: é barata) e a
 * amostragem esparsa fica para quem consome o resultado dela.
 */

import { CalibradorDeVideo, detectarCaixaDePreco } from "./calibration";
import { lerFrames } from "./frames";
import { priceAt } from "@/lib/vision/priceScale";
import type { VideoInfo } from "./ffmpeg";

export interface PontoDeVarredura {
  indice: number;
  segundoNoVideo: number;
  /** Preço lido da régua. Null quando a régua ou a caixa não saíram. */
  preco: number | null;
  /** OCR, PROPAGADA ou o motivo de não haver escala — auditoria da origem. */
  origemDaEscala: string;
  /** y da caixa do eixo, em pixels. Null quando a caixa não foi achada. */
  yDaCaixa: number | null;
  /**
   * QUAL RÉGUA MEDIU ESTE PONTO — muda a cada OCR que reancora o eixo.
   *
   * Dois preços medidos por réguas diferentes não são comparáveis com a mesma
   * confiança de dois medidos pela mesma. Medido no vídeo de março: no frame
   * em que a origem vira OCR, o preço deu um degrau de 414 pontos contra o que
   * os 12 frames propagados anteriores projetavam — e aquele frame saiu da
   * varredura como pivô E como candidato de região. Sem este campo não há como
   * exigir que um pivô tenha sido medido inteiro pela mesma régua.
   */
  epocaDaRegua: number;
}

export interface ResultadoDaVarredura {
  pontos: PontoDeVarredura[];
  framesLidos: number;
  comPreco: number;
  /** Quantas vezes a régua precisou de OCR — o único custo de modelo aqui. */
  ocrs: number;
  /** Trocas de régua: quantas épocas a varredura atravessou. */
  epocas: number;
  /** OCRs recusadas por quebrarem a continuidade do preço. */
  ocrRecusadasPorSalto: number;
  /** OCRs que a propagação teve de corrigir — instabilidade do leitor. */
  propagacaoCorrigida: number;
  /** Chamadas e falhas de OCR, como o calibrador contou. */
  ocrChamadas: number;
  ocrFalhas: number;
  duracaoMs: number;
  erro: string | null;
}

export interface OpcoesDaVarredura {
  ativo: string;
  inicioSeg: number;
  fimSeg: number;
  /** Passo em segundos de vídeo. Denso de propósito — ver o cabeçalho. */
  intervaloSeg: number;
  /** Segundos de vídeo entre OCRs de revalidação da régua. */
  intervaloOcrSeg?: number;
}

export async function varrerPrecos(
  info: VideoInfo,
  opcoes: OpcoesDaVarredura,
): Promise<ResultadoDaVarredura> {
  const t0 = Date.now();
  const calibrador = new CalibradorDeVideo(opcoes.ativo, {
    intervaloOcrSeg: opcoes.intervaloOcrSeg ?? 30,
  });
  const pontos: PontoDeVarredura[] = [];
  let framesLidos = 0;
  let comPreco = 0;
  let ocrs = 0;
  let epoca = 0;
  let ultimaOcrConhecida: number | null = null;
  let erro: string | null = null;
  let ultimoEstado: Awaited<ReturnType<CalibradorDeVideo["atualizar"]>> | null = null;
  const fps = opcoes.intervaloSeg > 0 ? 1 / opcoes.intervaloSeg : 1;

  try {
    for await (const f of lerFrames(info, {
      fps,
      inicioSeg: opcoes.inicioSeg,
      fimSeg: opcoes.fimSeg,
    })) {
      framesLidos++;
      const estado = await calibrador.atualizar(f.frame, f.segundoNoVideo);
      ultimoEstado = estado;
      if (estado.origem === "OCR") ocrs++;
      /*
       * A ÉPOCA VIRA QUANDO UMA OCR NOVA É ACEITA — e só então. Propagação não
       * troca a régua, apenas a carrega para as linhas deste frame; uma OCR
       * recusada pela trava de continuidade também não, e é por isso que o
       * marcador é `ultimaOcrEmSeg`, que só avança em OCR aceita.
       */
      if (estado.ultimaOcrEmSeg !== null && estado.ultimaOcrEmSeg !== ultimaOcrConhecida) {
        if (ultimaOcrConhecida !== null) epoca++;
        ultimaOcrConhecida = estado.ultimaOcrEmSeg;
      }
      let preco: number | null = null;
      let yDaCaixa: number | null = null;
      if (estado.utilizavel) {
        yDaCaixa = detectarCaixaDePreco(f.frame);
        if (yDaCaixa !== null) {
          const lido = priceAt(estado.calibracao, yDaCaixa);
          if (lido !== null && Number.isFinite(lido)) {
            preco = Math.round(lido);
            comPreco++;
          }
        }
      }
      pontos.push({
        indice: f.indice,
        segundoNoVideo: f.segundoNoVideo,
        preco,
        origemDaEscala: estado.utilizavel ? estado.origem : (estado.motivo ?? "SEM_ESCALA"),
        yDaCaixa,
        epocaDaRegua: epoca,
      });
    }
  } catch (e) {
    erro = e instanceof Error ? e.message : String(e);
  }

  return {
    pontos,
    framesLidos,
    comPreco,
    ocrs,
    epocas: epoca + 1,
    ocrRecusadasPorSalto: ultimoEstado?.ocrRecusadasPorSalto ?? 0,
    propagacaoCorrigida: ultimoEstado?.propagacaoCorrigida ?? 0,
    ocrChamadas: ultimoEstado?.ocrChamadas ?? 0,
    ocrFalhas: ultimoEstado?.ocrFalhas ?? 0,
    duracaoMs: Date.now() - t0,
    erro,
  };
}

/* ------------------------------------------------------------------------- */

export interface Pivo {
  indice: number;
  segundoNoVideo: number;
  preco: number;
  tipo: "TOPO" | "FUNDO";
}

export interface RegiaoCandidata {
  /** Onde o preço VOLTOU à região — o instante que merece o modelo. */
  indice: number;
  segundoNoVideo: number;
  preco: number;
  /** COMPRA num fundo defendido, VENDA num topo defendido. */
  direcaoEsperada: "COMPRA" | "VENDA";
  /** O nível do pivô sendo retestado. */
  nivel: number;
  /** Quantas vezes o preço já tinha voltado a esta região antes deste retorno. */
  visitasAnteriores: number;
  /** Quanto o preço se afastou da região antes de voltar, em pontos. */
  afastamentoMaximo: number;
}

export interface OpcoesDeEstrutura {
  /**
   * Pontos de cada lado que o pivô precisa dominar. Com a varredura densa cada
   * ponto vale poucos minutos de mercado; 8 de cada lado é um swing curto, que
   * é o que a T4 opera no gráfico de 1 minuto.
   */
  janelaDoPivo?: number;
  /**
   * Amplitude mínima do pivô, em pontos. NÃO é gosto: o erro medido da régua
   * calibrada é ~101 pontos (medição de 21/08/2026). Um "pivô" menor que isso
   * pode ser inteiramente ruído de medição — o piso é 3× o erro.
   */
  amplitudeMinima?: number;
  /** Quão perto do nível conta como DENTRO da região, em pontos. */
  toleranciaDaRegiao?: number;
  /**
   * O preço precisa ter SAÍDO da região antes de "voltar" a ela. Sem isso, um
   * preço parado em cima do nível geraria um candidato por ponto amostrado.
   */
  afastamentoMinimo?: number;
  /**
   * Quantos frames a janela do pivô pode ocupar, no máximo, por ponto pedido.
   *
   * A janela é contada sobre os pontos COM PREÇO, e 36,7% dos frames da
   * varredura não têm preço — em blocos, não espalhados (medido: 158 frames
   * sem preço em 24 buracos, o maior com 37 frames seguidos). Sem este teto,
   * "8 pontos de cada lado" pode significar 2,6 s de vídeo atravessando um
   * buraco inteiro e uma recalibração no meio — e o pivô passa a ser um
   * artefato do buraco, não um extremo do mercado. Medido: 6 dos 16 pivôs da
   * primeira varredura tinham janela muito maior que a nominal.
   */
  folgaDeBuraco?: number;
}

/** Pivôs da série: extremos locais que dominam a janela e têm amplitude real. */
export function acharPivos(pontos: PontoDeVarredura[], opcoes: OpcoesDeEstrutura = {}): Pivo[] {
  const janela = opcoes.janelaDoPivo ?? 8;
  const amplitude = opcoes.amplitudeMinima ?? 300;
  const validos = pontos.filter((p): p is PontoDeVarredura & { preco: number } => p.preco !== null);
  const folga = opcoes.folgaDeBuraco ?? 2;
  const pivos: Pivo[] = [];
  for (let i = janela; i < validos.length - janela; i++) {
    const centro = validos[i]!;
    const esquerda = validos[i - janela]!;
    const direita = validos[i + janela]!;
    /*
     * A JANELA PRECISA SER CONTÍGUA E DA MESMA RÉGUA.
     *
     * Contígua: sem isso ela atravessa os buracos de leitura e o "extremo
     * local" é o extremo de dois trechos distantes colados. Mesma régua: um
     * extremo confirmado com uma régua de um lado e outra do outro pode ser só
     * o degrau da reancoragem. As épocas crescem, então bater as pontas basta.
     */
    if (
      centro.indice - esquerda.indice > janela * folga ||
      direita.indice - centro.indice > janela * folga ||
      esquerda.epocaDaRegua !== centro.epocaDaRegua ||
      direita.epocaDaRegua !== centro.epocaDaRegua
    ) {
      continue;
    }
    let maiorEsq = Number.NEGATIVE_INFINITY;
    let menorEsq = Number.POSITIVE_INFINITY;
    let maiorDir = Number.NEGATIVE_INFINITY;
    let menorDir = Number.POSITIVE_INFINITY;
    for (let k = 1; k <= janela; k++) {
      const e = validos[i - k]!.preco;
      const d = validos[i + k]!.preco;
      if (e > maiorEsq) maiorEsq = e;
      if (e < menorEsq) menorEsq = e;
      if (d > maiorDir) maiorDir = d;
      if (d < menorDir) menorDir = d;
    }
    const eTopo =
      centro.preco >= maiorEsq &&
      centro.preco >= maiorDir &&
      centro.preco - Math.max(menorEsq, menorDir) >= amplitude;
    const eFundo =
      centro.preco <= menorEsq &&
      centro.preco <= menorDir &&
      Math.min(maiorEsq, maiorDir) - centro.preco >= amplitude;
    if (eTopo || eFundo) {
      pivos.push({
        indice: centro.indice,
        segundoNoVideo: centro.segundoNoVideo,
        preco: centro.preco,
        tipo: eTopo ? "TOPO" : "FUNDO",
      });
    }
  }
  return pivos;
}

/**
 * OS INSTANTES QUE MERECEM O MODELO — o preço voltando a uma região defendida.
 *
 * É a definição operacional que o dono da técnica deu: "chegou na região ou é
 * compra ou é venda". A região não é inventada aqui: ela é um pivô que a
 * própria série de preços já mostrou, e o candidato é o RETORNO a ele depois de
 * o preço ter se afastado. Nenhuma estrutura é lida por modelo nesta etapa — o
 * modelo entra depois, só nestes instantes, para dizer se a região é de compra
 * ou de venda, onde fica o stop e onde está o próximo obstáculo.
 *
 * CAUSALIDADE: só o futuro do pivô é examinado. Um pivô confirmado no índice i
 * só existe depois da janela à direita, e o retorno é procurado a partir dali —
 * nunca antes. Nada aqui olha adiante do instante que está sendo julgado.
 */
export function acharRegioes(
  pontos: PontoDeVarredura[],
  opcoes: OpcoesDeEstrutura = {},
): RegiaoCandidata[] {
  const janela = opcoes.janelaDoPivo ?? 8;
  const tolerancia = opcoes.toleranciaDaRegiao ?? 120;
  const afastamentoMinimo = opcoes.afastamentoMinimo ?? 250;
  const pivos = acharPivos(pontos, opcoes);
  const validos = pontos.filter((p): p is PontoDeVarredura & { preco: number } => p.preco !== null);
  const candidatos: RegiaoCandidata[] = [];

  for (const pivo of pivos) {
    /*
     * DUAS COISAS DIFERENTES, E CONFUNDI-LAS CUSTA CANDIDATOS.
     *
     * (1) QUANDO O PIVÔ PASSA A SER CONHECIDO. Ele é detectado dominando
     *     `janela` pontos de cada lado — no mundo real ninguém sabe que aquele
     *     fundo era fundo antes de `janela` pontos depois dele. Então nenhum
     *     candidato pode ser EMITIDO antes disso.
     *
     * (2) O QUE O PREÇO FEZ NESSE MEIO-TEMPO. Isso é passado observável: o
     *     operador viu o preço sair da região, mesmo sem saber ainda que ali
     *     era um pivô. Ignorar esse trecho fazia o primeiro retorno — em geral
     *     o mais limpo — nascer com o estado "nunca saiu" e ser descartado.
     *
     * Por isso o laço COMEÇA no ponto seguinte ao pivô, acumulando afastamento,
     * e só passa a EMITIR a partir do fim da janela.
     */
    const inicio = validos.findIndex((p) => p.indice > pivo.indice);
    if (inicio < 0) continue;
    const emitirAPartirDe = inicio + janela;
    let dentro = true; // no instante do pivô o preço está, por definição, nele
    let afastamento = 0;
    let visitas = 0;
    for (let i = inicio; i < validos.length; i++) {
      const p = validos[i]!;
      const distancia = Math.abs(p.preco - pivo.preco);
      if (distancia > tolerancia) {
        dentro = false;
        if (distancia > afastamento) afastamento = distancia;
        continue;
      }
      if (!dentro && afastamento >= afastamentoMinimo) {
        visitas++;
        if (i >= emitirAPartirDe) {
          candidatos.push({
            indice: p.indice,
            segundoNoVideo: p.segundoNoVideo,
            preco: p.preco,
            direcaoEsperada: pivo.tipo === "FUNDO" ? "COMPRA" : "VENDA",
            nivel: pivo.preco,
            visitasAnteriores: visitas - 1,
            afastamentoMaximo: afastamento,
          });
        }
      }
      dentro = true;
      afastamento = 0;
    }
  }

  candidatos.sort((a, b) => a.indice - b.indice || a.nivel - b.nivel);
  return candidatos;
}

/**
 * OS NÍVEIS ESTRUTURAIS QUE JÁ ERAM CONHECIDOS NESTE INSTANTE.
 *
 * POR QUE O OBSTÁCULO SAI DAQUI E NÃO DO MODELO. Perguntar ao leitor visual
 * onde está "o próximo obstáculo estrutural" foi medido e não se sustenta: em
 * três leituras cruas do mesmo vídeo ele devolveu `null` uma vez, e nas outras
 * duas devolveu um número ACIMA da entrada numa operação de VENDA — obstáculo
 * do lado contrário ao trade. Na rodada completa veio nulo em todos os
 * instantes analisados. E o obstáculo é justamente o que autoriza a operação:
 * com alvo derivado em 3R, é a distância até ele que separa espaço técnico de
 * carimbo.
 *
 * Mas ele não precisa ser lido: a varredura JÁ mediu os pivôs da série, com a
 * mesma régua, de graça e sem ambiguidade. O próximo obstáculo a favor é o
 * pivô mais próximo do outro lado da entrada — e é isso que esta função
 * entrega, respeitando a mesma regra causal do resto do módulo: só entram os
 * pivôs que JÁ eram conhecíveis no instante pedido.
 */
export function niveisConhecidosEm(
  pivos: Pivo[],
  indice: number,
  opcoes: OpcoesDeEstrutura = {},
): number[] {
  const janela = opcoes.janelaDoPivo ?? 8;
  const conhecidos = pivos
    .filter((p) => p.indice + janela <= indice)
    .map((p) => p.preco)
    .sort((a, b) => a - b);
  return [...new Set(conhecidos)];
}

/**
 * Candidatos que caem no mesmo instante viram um só.
 *
 * Dois pivôs próximos — o fundo do range e o fundo do pullback, por exemplo —
 * geram dois retornos no mesmo ponto da série. Rodar o modelo duas vezes no
 * mesmo frame é gastar o caro duas vezes pela mesma informação.
 */
export function agruparPorInstante(candidatos: RegiaoCandidata[]): RegiaoCandidata[] {
  const porIndice = new Map<number, RegiaoCandidata>();
  for (const c of candidatos) {
    const atual = porIndice.get(c.indice);
    // Fica o que tem mais história: mais visitas, e depois maior afastamento.
    if (
      atual === undefined ||
      c.visitasAnteriores > atual.visitasAnteriores ||
      (c.visitasAnteriores === atual.visitasAnteriores &&
        c.afastamentoMaximo > atual.afastamentoMaximo)
    ) {
      porIndice.set(c.indice, c);
    }
  }
  return [...porIndice.values()].sort((a, b) => a.indice - b.indice);
}
