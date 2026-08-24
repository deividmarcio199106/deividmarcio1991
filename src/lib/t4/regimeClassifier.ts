/**
 * PLAYBOOK DE REGIME — o que a técnica tem PERMISSÃO de tentar, antes do setup.
 *
 * O QUE JÁ EXISTIA E O QUE ESTE ARQUIVO ACRESCENTA. `engines/regimeEngine.ts`
 * já classifica o mercado (TREND_UP, RANGE, COMPRESSION…) a partir das features
 * numéricas. Ele responde "o que o mercado É". Não responde a pergunta que
 * antecede a operação: "o que eu posso tentar aqui, e com quais alvos".
 *
 * Sem essa segunda resposta, a mesma T4.1 de pullback era oferecida no meio de
 * uma lateralidade de 40 candles — onde ela não tem para onde ir — e o runner
 * ficava aberto num range, devolvendo na volta o que a perna 1 pagou. O gráfico
 * dizia RANGE e o motor seguia oferecendo o playbook de tendência.
 *
 * TRÊS REGIMES, TRÊS PERMISSÕES DIFERENTES:
 *
 *   A · TENDÊNCIA      T4.1 (pullback limpo) na 1ª e 2ª perna. 3R, 5R, runner.
 *   B · LATERALIDADE   Só T4.3 (extremo com sweep). Alvos curtos 1,5R e 2,5R.
 *                      Runner PROIBIDO e entrada no MEIO do range VETADA.
 *   C · GAP/VOLAT.     Gap > 800 pts: nada arma nos primeiros 20 candles.
 *
 * ANTI-LOOK-AHEAD. Recebe apenas candles FECHADOS até T. O cooldown do regime C
 * é contado em candles de 1 min já fechados desde a abertura — não em relógio de
 * parede, que no replay não existe.
 *
 * ESTE MÓDULO NÃO APROVA NADA. Ele restringe. Um regime devolver
 * `T4.1_PULLBACK_LIMPO` em `allowedPlays` não é permissão de operar: é ausência
 * de veto. Todos os gates de `gates.ts` continuam soberanos depois dele.
 */

import type { Candle } from "@/lib/engines/types";

export type PlaybookRegime =
  | "REGIME_A_TENDENCIA"
  | "REGIME_B_LATERALIDADE"
  | "REGIME_C_GAP_VOLATILIDADE"
  | "REGIME_INDEFINIDO";

/** Os setups que o playbook sabe autorizar. Nome estável — vai para o `rules_json`. */
export type PlayId = "T4.1_PULLBACK_LIMPO" | "T4.3_EXTREMO_COM_SWEEP";

/** Candles fechados que a lateralidade precisa para ser afirmada. */
export const LATERALIDADE_MIN_CANDLES = 40;

/** Gap de abertura, em pontos, a partir do qual o dia entra em regime C. */
export const GAP_LIMITE_PONTOS = 800;

/** Candles de 1 min de trava após um gap acima do limite. */
export const GAP_COOLDOWN_CANDLES = 20;

/**
 * Fração do range que conta como EXTREMO, de cada lado.
 *
 * 0,25 significa: só os 25% de baixo (compra) e os 25% de cima (venda) são zona
 * de entrada no regime B. Os 50% do meio são o "meio do gráfico" que a técnica
 * manda vetar — é lá que o range não paga nem 1,5R antes de bater no outro lado.
 */
export const EXTREMO_BANDA = 0.25;

/** Amplitude máxima do range em ATR para o mercado ainda ser "contido". */
const LATERALIDADE_MAX_AMPLITUDE_ATR = 8;

/** Deslocamento líquido máximo, como fração da amplitude, para não haver progresso. */
const LATERALIDADE_MAX_PROGRESSO = 0.35;

/** Perna máxima do movimento em que a T4.1 é autorizada no regime A. */
export const MAX_PERNA_AUTORIZADA = 2;

export interface RegimeInput {
  /** Candles de 1 min FECHADOS até T. O último é o que acabou de fechar. */
  window: Candle[];
  /**
   * Gap de abertura em pontos (|abertura do dia − fechamento anterior|).
   * `null` quando o dia anterior não é conhecido — e aí o regime C não pode ser
   * afirmado nem descartado por gap.
   */
  gapPoints: number | null;
  /**
   * Candles de 1 min já FECHADOS desde a abertura do pregão. `null` quando a
   * abertura não é conhecida: sem essa contagem o cooldown não é verificável.
   */
  candlesSinceOpen: number | null;
}

export interface RegimePlaybook {
  regime: PlaybookRegime;
  /** Setups sem veto neste regime. Vazio = nenhum gatilho pode armar. */
  allowedPlays: PlayId[];
  /** Alvos em R, na ordem das pernas. `null` na última = runner estrutural. */
  targetsR: Array<number | null>;
  runnerAllowed: boolean;
  /** Perna máxima do movimento autorizada. `null` = sem limite de perna. */
  maxPerna: number | null;
  /** Candles de 1 min que ainda faltam para o cooldown acabar. 0 = liberado. */
  cooldownCandlesRemaining: number;
  /**
   * Onde o preço pode entrar dentro do range, quando há veto de posição.
   * `null` = sem veto (regimes A e C).
   */
  zonaDeEntrada: { banda: number; posicaoAtual: number | null } | null;
  /** Evidências numéricas que produziram a classificação. Nunca vazio. */
  evidences: string[];
  detail: string;
}

/** ATR simples da janela — mesma conta do `marketFeatures`, sem depender dele. */
function atrDaJanela(window: Candle[]): number {
  if (window.length < 2) return 0;
  let soma = 0;
  for (let i = 1; i < window.length; i++) {
    const c = window[i]!;
    const anterior = window[i - 1]!;
    soma += Math.max(c.h - c.l, Math.abs(c.h - anterior.c), Math.abs(c.l - anterior.c));
  }
  return soma / (window.length - 1);
}

/** Topos/fundos por blocos: 3 blocos consecutivos, extremos em sequência. */
function direcaoPorBlocos(window: Candle[]): "ALTA" | "BAIXA" | null {
  const tamanho = Math.floor(window.length / 3);
  if (tamanho < 3) return null;
  const blocos = [
    window.slice(0, tamanho),
    window.slice(tamanho, tamanho * 2),
    window.slice(tamanho * 2),
  ];
  const topos = blocos.map((b) => Math.max(...b.map((c) => c.h)));
  const fundos = blocos.map((b) => Math.min(...b.map((c) => c.l)));

  const toposSobem = topos[0]! < topos[1]! && topos[1]! < topos[2]!;
  const fundosSobem = fundos[0]! < fundos[1]! && fundos[1]! < fundos[2]!;
  if (toposSobem && fundosSobem) return "ALTA";

  const toposCaem = topos[0]! > topos[1]! && topos[1]! > topos[2]!;
  const fundosCaem = fundos[0]! > fundos[1]! && fundos[1]! > fundos[2]!;
  if (toposCaem && fundosCaem) return "BAIXA";

  return null;
}

/** Onde o último fechamento está dentro do range: 0 = fundo, 1 = topo. */
export function posicaoNoRange(window: Candle[]): number | null {
  if (window.length === 0) return null;
  const alto = Math.max(...window.map((c) => c.h));
  const baixo = Math.min(...window.map((c) => c.l));
  const amplitude = alto - baixo;
  if (amplitude <= 0) return null;
  return (window[window.length - 1]!.c - baixo) / amplitude;
}

/**
 * O preço está num EXTREMO do range, do lado que a operação pediria?
 *
 * Compra só nos 25% de baixo, venda só nos 25% de cima. É este teste que
 * materializa o "veta trades no meio do gráfico" — sem ele, "autorizar T4.3"
 * viraria autorizar qualquer entrada dentro da lateralidade.
 */
export function noExtremoDoRange(
  posicao: number | null,
  side: "COMPRA" | "VENDA",
  banda: number = EXTREMO_BANDA,
): boolean {
  if (posicao === null) return false;
  return side === "COMPRA" ? posicao <= banda : posicao >= 1 - banda;
}

const SEM_DADO: RegimePlaybook = {
  regime: "REGIME_INDEFINIDO",
  allowedPlays: [],
  targetsR: [],
  runnerAllowed: false,
  maxPerna: null,
  cooldownCandlesRemaining: 0,
  zonaDeEntrada: null,
  evidences: ["janela insuficiente"],
  detail: "Candles fechados insuficientes para classificar regime — nenhum setup autorizado.",
};

/**
 * Classifica o regime e devolve o que ele autoriza.
 *
 * PRECEDÊNCIA, e por quê:
 *   1. GAP acima do limite COM cooldown correndo vence tudo. Não é uma leitura
 *      de estrutura — é uma trava de tempo, e enquanto ela corre nem tendência
 *      nem lateralidade autorizam gatilho.
 *   2. Passado o cooldown, o gap vira só evidência: o dia volta a ser
 *      classificado pela estrutura, porque foi isso que o preço construiu.
 *   3. LATERALIDADE antes de TENDÊNCIA. Um range de 40 candles com topos e
 *      fundos irregulares pode enganar um teste de tendência frouxo; o teste de
 *      contenção é o mais restritivo dos dois e roda primeiro.
 */
export function classifyRegime(input: RegimeInput): RegimePlaybook {
  const { window, gapPoints, candlesSinceOpen } = input;
  if (window.length < 12) return SEM_DADO;

  const evidences: string[] = [];

  // 1. GAP + COOLDOWN — trava de tempo, vence estrutura.
  if (gapPoints !== null && Math.abs(gapPoints) > GAP_LIMITE_PONTOS) {
    evidences.push(`gap=${Math.round(Math.abs(gapPoints))}pts>${GAP_LIMITE_PONTOS}`);
    // Sem contagem de candles desde a abertura o cooldown não é verificável.
    // Tratar como cumprido seria assumir o que não se sabe: assume-se cheio.
    const decorridos = candlesSinceOpen ?? 0;
    const faltam = Math.max(0, GAP_COOLDOWN_CANDLES - decorridos);
    if (faltam > 0) {
      evidences.push(
        candlesSinceOpen === null
          ? "candles desde a abertura desconhecidos — cooldown assumido cheio"
          : `${decorridos}/${GAP_COOLDOWN_CANDLES} candles desde a abertura`,
      );
      return {
        regime: "REGIME_C_GAP_VOLATILIDADE",
        allowedPlays: [],
        targetsR: [],
        runnerAllowed: false,
        maxPerna: null,
        cooldownCandlesRemaining: faltam,
        zonaDeEntrada: null,
        evidences,
        detail:
          `Gap de ${Math.round(Math.abs(gapPoints))} pontos: nenhum gatilho autorizado por ` +
          `mais ${faltam} candle(s) de 1 min.`,
      };
    }
    evidences.push(`cooldown de ${GAP_COOLDOWN_CANDLES} candles cumprido`);
  }

  const janela = window.slice(-LATERALIDADE_MIN_CANDLES);
  const alto = Math.max(...janela.map((c) => c.h));
  const baixo = Math.min(...janela.map((c) => c.l));
  const amplitude = alto - baixo;
  const atr = atrDaJanela(janela);
  const amplitudeEmAtr = atr > 0 ? amplitude / atr : Infinity;
  const deslocamento = Math.abs(janela[janela.length - 1]!.c - janela[0]!.c);
  const progresso = amplitude > 0 ? deslocamento / amplitude : 1;
  const posicao = posicaoNoRange(janela);

  // 2. LATERALIDADE — contida, sem progresso e com pelo menos 40 candles.
  const contida = amplitudeEmAtr <= LATERALIDADE_MAX_AMPLITUDE_ATR;
  const semProgresso = progresso <= LATERALIDADE_MAX_PROGRESSO;
  if (window.length >= LATERALIDADE_MIN_CANDLES && contida && semProgresso) {
    evidences.push(
      `${janela.length} candles contidos em ${Math.round(amplitude)}pts`,
      `amplitude=${amplitudeEmAtr.toFixed(1)}ATR<=${LATERALIDADE_MAX_AMPLITUDE_ATR}`,
      `progresso=${(progresso * 100).toFixed(0)}%<=${LATERALIDADE_MAX_PROGRESSO * 100}%`,
    );
    return {
      regime: "REGIME_B_LATERALIDADE",
      allowedPlays: ["T4.3_EXTREMO_COM_SWEEP"],
      // Alvos CURTOS e FIXOS: dentro do range não há espaço estrutural para 5R.
      targetsR: [1.5, 2.5],
      // Runner num range devolve na volta o que a perna 1 pagou.
      runnerAllowed: false,
      maxPerna: null,
      cooldownCandlesRemaining: 0,
      zonaDeEntrada: { banda: EXTREMO_BANDA, posicaoAtual: posicao },
      evidences,
      detail:
        `Lateralidade de ${janela.length} candles: só T4.3 nos extremos ` +
        `(${EXTREMO_BANDA * 100}% de cada lado), alvos 1,5R e 2,5R, runner proibido.`,
    };
  }

  // 3. TENDÊNCIA — topos e fundos na mesma direção, por blocos.
  const direcao = direcaoPorBlocos(janela);
  if (direcao !== null) {
    evidences.push(
      direcao === "ALTA" ? "topos e fundos ascendentes" : "topos e fundos descendentes",
      `progresso=${(progresso * 100).toFixed(0)}%`,
      `amplitude=${amplitudeEmAtr.toFixed(1)}ATR`,
    );
    return {
      regime: "REGIME_A_TENDENCIA",
      allowedPlays: ["T4.1_PULLBACK_LIMPO"],
      targetsR: [3, 5, null],
      runnerAllowed: true,
      maxPerna: MAX_PERNA_AUTORIZADA,
      cooldownCandlesRemaining: 0,
      zonaDeEntrada: null,
      evidences,
      detail:
        `Tendência de ${direcao.toLowerCase()}: T4.1 autorizada até a ${MAX_PERNA_AUTORIZADA}ª ` +
        `perna, alvos 3R, 5R e runner.`,
    };
  }

  evidences.push(
    `amplitude=${amplitudeEmAtr.toFixed(1)}ATR`,
    `progresso=${(progresso * 100).toFixed(0)}%`,
    "sem sequência de topos e fundos",
  );
  return {
    regime: "REGIME_INDEFINIDO",
    allowedPlays: [],
    targetsR: [],
    runnerAllowed: false,
    maxPerna: null,
    cooldownCandlesRemaining: 0,
    zonaDeEntrada: null,
    evidences,
    detail:
      "Nem tendência nem lateralidade afirmável — nenhum playbook autorizado. " +
      "Ausência de regime não é permissão para operar o regime anterior.",
  };
}

/**
 * O setup pretendido está autorizado pelo regime?
 *
 * Devolve o motivo do veto quando não está. Quem chama não precisa reimplementar
 * a leitura do playbook — e é justamente por reimplementarem que duas telas
 * divergem sobre a mesma operação.
 */
export function playAutorizado(
  playbook: RegimePlaybook,
  play: PlayId,
  contexto?: { side?: "COMPRA" | "VENDA"; perna?: number },
): { autorizado: boolean; motivo: string } {
  if (playbook.cooldownCandlesRemaining > 0) {
    return {
      autorizado: false,
      motivo: `Cooldown de gap: faltam ${playbook.cooldownCandlesRemaining} candle(s).`,
    };
  }
  if (!playbook.allowedPlays.includes(play)) {
    return {
      autorizado: false,
      motivo: `${play} não é autorizado em ${playbook.regime}.`,
    };
  }
  if (
    playbook.maxPerna !== null &&
    contexto?.perna !== undefined &&
    contexto.perna > playbook.maxPerna
  ) {
    return {
      autorizado: false,
      motivo: `${contexto.perna}ª perna do movimento: acima da ${playbook.maxPerna}ª autorizada.`,
    };
  }
  if (playbook.zonaDeEntrada !== null) {
    if (contexto?.side === undefined) {
      return {
        autorizado: false,
        motivo: "Regime exige extremo do range e o lado não foi informado.",
      };
    }
    if (
      !noExtremoDoRange(
        playbook.zonaDeEntrada.posicaoAtual,
        contexto.side,
        playbook.zonaDeEntrada.banda,
      )
    ) {
      const pos = playbook.zonaDeEntrada.posicaoAtual;
      return {
        autorizado: false,
        motivo:
          `Meio do range (posição ${pos === null ? "desconhecida" : (pos * 100).toFixed(0) + "%"}) — ` +
          `entrada só nos ${playbook.zonaDeEntrada.banda * 100}% do extremo.`,
      };
    }
  }
  return { autorizado: true, motivo: "" };
}
