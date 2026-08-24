/**
 * RESULTADO AUTOMÁTICO DO SETUP — o ciclo fecha sem a mão do operador.
 *
 * O defeito que isto encerra: a máquina de setup (`setupTracker.ts`) vive no
 * NAVEGADOR. Reiniciar o backend perdia o setup ativo, e um setup CONFIRMADO
 * jamais fechava sozinho — ficava "confirmado" para sempre, sem WIN, sem LOSS,
 * sem nada que a memória pudesse aprender. Setup sem desfecho não ensina
 * (mesma lei do `predictionOutcome.ts`, que este módulo espelha de propósito:
 * um vocabulário só para a casa inteira).
 *
 * Ciclo exigido pelo operador:
 *   FORMACAO → CONFIRMADO → WIN | LOSS | EXPIRADO | INVALIDADO
 *
 * A AMOSTRAGEM É DE 60s — E ISSO IMPORTA. As observações são etiquetas de
 * preço lidas a cada print; NÃO são candles e não trazem máxima/mínima. Entre
 * duas amostras existe um trecho de mercado que ninguém observou. Quando as
 * duas pontas (alvo e stop) foram atravessadas no MESMO passo, a ORDEM é
 * desconhecida e o veredito é LOSS, com `ambiguous: true` e o motivo dito.
 * Inventar a sequência intrabar que faltou seria fabricar dado — e otimismo
 * fabricado é exatamente o que envenena uma estatística de estratégia.
 *
 * O QUE ESTE MÓDULO NÃO FAZ: INVALIDADO por ESTRUTURA. Um setup se invalida
 * quando o print seguinte nega a estrutura (direção virou, T4 morreu) — isso é
 * leitura de gráfico, mora na máquina de setup, e chega aqui já decidido. Deste
 * lado, INVALIDADO só aparece quando o próprio setup não tem critério
 * mensurável (sem stop/alvo numéricos): fechar como EXPIRADO afirmaria que o
 * mercado não alcançou nada, quando na verdade nunca houve o que alcançar.
 */

export type SetupOutcome = "ABERTO" | "WIN" | "LOSS" | "EXPIRADO" | "INVALIDADO";

/** Etiqueta de preço lida a cada print — a única observação que existe. */
export interface SetupObservation {
  at: number;
  price: number;
}

export interface OpenSetup {
  direction: "COMPRA" | "VENDA";
  /** Preço de entrada, quando legível. Ausência é null — nunca 0 disfarçado. */
  entry: number | null;
  stop: number;
  target: number;
  /** Instante da CONFIRMAÇÃO: nada anterior a ele conta. */
  confirmedAt: number;
  /** Prazo declarado do setup; inválido ou ausente cai no TTL. */
  expiresAt: number;
}

export interface SetupVerdict {
  outcome: SetupOutcome;
  /** Instante do desfecho; null enquanto ABERTO. */
  at: number | null;
  /** Por que fechou (ou por que segue aberto) — sempre presente, nunca vazio. */
  reason: string;
  /** Alvo e stop atravessados no mesmo passo: contado como stop. */
  ambiguous: boolean;
}

/**
 * Sem alcançar alvo nem stop por este tempo, o setup expira.
 * 45 min alinhado ao `PREDICTION_TTL_MS` das previsões de print: dois relógios
 * diferentes para a mesma janela de 60s produziriam duas estatísticas que se
 * contradizem sem que ninguém saiba por quê.
 */
export const SETUP_OUTCOME_TTL_MS = 45 * 60_000;

/** O preço está no nível ou além dele, no sentido informado. */
function atOrBeyond(price: number, level: number, upward: boolean): boolean {
  return upward ? price >= level : price <= level;
}

/**
 * O nível foi atravessado NESTE passo?
 *
 * Duas evidências, ambas observadas — nenhuma inventada:
 *  1. a amostra atual está no nível ou além dele;
 *  2. o nível ficou ENTRE a amostra anterior e a atual. O preço é contínuo:
 *     para ir de um lado ao outro ele passou por cima do nível, mesmo que a
 *     leitura de 60s já o mostre de volta. Ignorar isso perderia toques reais
 *     entre amostras — e "não vi" não é "não aconteceu".
 */
function crossedInStep(
  previous: number | null,
  price: number,
  level: number,
  upward: boolean,
): boolean {
  if (atOrBeyond(price, level, upward)) return true;
  if (previous === null) return false;
  return (previous - level) * (price - level) <= 0;
}

function format(value: number): string {
  return value.toLocaleString("pt-BR");
}

/**
 * Avalia UM setup confirmado contra as observações de preço posteriores.
 *
 * Anti-look-ahead literal (igual ao `predictionOutcome`): observação anterior
 * à confirmação NÃO conta. O preço que passou pelo alvo antes de o operador
 * estar posicionado não é resultado dele — é passado.
 *
 * `ttlMs` só entra quando o setup não trouxe prazo utilizável; o `expiresAt`
 * declarado sempre manda, porque é o prazo que o operador viu na tela.
 */
export function evaluateSetup(
  setup: OpenSetup,
  observations: SetupObservation[],
  now: number,
  ttlMs: number = SETUP_OUTCOME_TTL_MS,
): SetupVerdict {
  if (!Number.isFinite(setup.stop) || !Number.isFinite(setup.target)) {
    // Sem stop e alvo NUMÉRICOS não existe critério definido ANTES — e
    // critério definido depois do resultado é viés retrospectivo. Fica fechado
    // como INVALIDADO (não ensina) em vez de pendurado como ABERTO para sempre.
    return {
      outcome: "INVALIDADO",
      at: setup.confirmedAt,
      reason: "setup sem stop/alvo numéricos — sem critério pré-definido, não mede nem ensina",
      ambiguous: false,
    };
  }

  const deadline =
    Number.isFinite(setup.expiresAt) && setup.expiresAt > setup.confirmedAt
      ? setup.expiresAt
      : setup.confirmedAt + ttlMs;

  const up = setup.direction === "COMPRA";

  /*
   * A entrada é a ÂNCORA do primeiro passo: o preço saiu dela rumo à primeira
   * amostra. Só vale como âncora se estiver ESTRITAMENTE dentro do corredor
   * stop–alvo; entrada fora do corredor significa níveis incoerentes (leitura
   * ruim do print), e ancorar num número incoerente inventaria travessia.
   */
  const dentroDoCorredor =
    setup.entry !== null &&
    Number.isFinite(setup.entry) &&
    (up
      ? setup.entry > setup.stop && setup.entry < setup.target
      : setup.entry < setup.stop && setup.entry > setup.target);
  let anterior: number | null = dentroDoCorredor ? setup.entry : null;

  // A janela é fechada no prazo: observação POSTERIOR ao vencimento não pode
  // resolver um setup que já tinha expirado quando ela chegou.
  const janela = observations
    .filter((o) => o.at > setup.confirmedAt && o.at <= deadline && Number.isFinite(o.price))
    .sort((a, b) => a.at - b.at);

  for (const obs of janela) {
    const bateuAlvo = crossedInStep(anterior, obs.price, setup.target, up);
    const bateuStop = crossedInStep(anterior, obs.price, setup.stop, !up);

    if (bateuAlvo && bateuStop) {
      return {
        outcome: "LOSS",
        at: obs.at,
        reason:
          "alvo E stop atravessados entre duas observações de 60s — ordem desconhecida, " +
          "contado como stop (conservador)",
        ambiguous: true,
      };
    }
    if (bateuStop) {
      return {
        outcome: "LOSS",
        at: obs.at,
        reason: `stop ${format(setup.stop)} atingido`,
        ambiguous: false,
      };
    }
    if (bateuAlvo) {
      return {
        outcome: "WIN",
        at: obs.at,
        reason: `alvo ${format(setup.target)} atingido sem stop antes`,
        ambiguous: false,
      };
    }
    anterior = obs.price;
  }

  if (now > deadline) {
    return {
      outcome: "EXPIRADO",
      // O desfecho é do VENCIMENTO, não do instante em que a varredura reparou:
      // carimbar `now` dataria o setup pela hora do servidor.
      at: deadline,
      reason: `expirou após ${Math.round((deadline - setup.confirmedAt) / 60_000)} min sem alcançar alvo nem stop`,
      ambiguous: false,
    };
  }

  return {
    outcome: "ABERTO",
    at: null,
    reason:
      janela.length === 0
        ? "aguardando a primeira observação de preço posterior à confirmação"
        : `acompanhando — ${janela.length} observação(ões), nada alcançado`,
    ambiguous: false,
  };
}
