import { resolveInstrument } from "@/lib/engines/instruments";
import type { PriceLevel, PriceLevelKind } from "@/lib/vision/printAnalysis";

/**
 * IDENTIDADE PERSISTENTE DOS NÍVEIS — e a marca POST_HOC (§7, §8).
 *
 * DOIS DEFEITOS, UM REGISTRO.
 *
 * 1. NÍVEL CRIADO DEPOIS DO FATO (§7). Na sessão de 19/08 alguns níveis
 *    nasceram quando o preço JÁ ESTAVA neles. Um nível assim descreve o
 *    passado com perfeição — e é exatamente por isso que ele não pode contar
 *    como previsão, como acerto, como entrada retroativa nem como melhora de
 *    backtest. A regra é aritmética, não julgamento:
 *
 *        detectedAt >= firstTouchAt  ⇒  POST_HOC
 *
 *    Ele continua no registro, visível como ANÁLISE HISTÓRICA. Apagá-lo seria
 *    perder informação real; contá-lo seria fabricar acerto.
 *
 * 2. O MESMO NÍVEL COM TRÊS NOMES (§8). "Suporte estrutural", "zona de reação"
 *    e "POI" apareciam alternadamente para o MESMO preço, e cada renomeação
 *    nascia como nível novo — inflando a contagem e apagando o histórico de
 *    quantas vezes aquele preço já tinha sido testado. Aqui cada nível ganha um
 *    `levelId` estável, casado por PREÇO, e a troca de nome é um evento no
 *    histórico dele. Mudança de FUNÇÃO (resistência rompida que vira suporte no
 *    reteste) é transição EXPLÍCITA, com motivo — nunca um nível novo aparecendo
 *    do nada no mesmo lugar.
 */

export type LevelStatus =
  | "ACTIVE"
  | "TOUCHED"
  | "BROKEN"
  | "SUPPORT_RETEST"
  | "RESISTANCE_RETEST"
  | "INVALIDATED"
  | "EXPIRED";

export type LevelEventKind =
  "DETECTED" | "RENAMED" | "TOUCHED" | "TRANSITION" | "PRICE_ADJUSTED" | "POST_HOC";

export interface LevelEvent {
  kind: LevelEventKind;
  at: number;
  reason: string;
}

export interface TrackedLevel {
  levelId: string;
  /** Preço central. Numa faixa, o meio da zona. */
  price: number;
  zone: { min: number; max: number } | null;
  type: PriceLevelKind;
  label: string;
  createdAt: number;
  /** Quando o SISTEMA passou a conhecer este nível. */
  detectedAt: number;
  /** Primeira vez que o preço encostou. Null enquanto não encostou. */
  firstTouchAt: number | null;
  /** O nível existia no registro ANTES do primeiro toque? */
  predictedBeforeTouch: boolean;
  /** detectedAt >= firstTouchAt. Nível descrito depois do fato. */
  postHoc: boolean;
  status: LevelStatus;
  history: LevelEvent[];
}

export interface LevelRegistry {
  levels: TrackedLevel[];
  /** Sequência do dia no id — nunca reaproveitada. */
  sequence: number;
}

const MAX_HISTORY = 20;
/** Níveis a menos de 0,04% um do outro são O MESMO nível relido. */
const MATCH_FRACTION = 0.0004;

export function emptyLevelRegistry(): LevelRegistry {
  return { levels: [], sequence: 0 };
}

/** Tolerância de casamento/toque: dois ticks, ou a fração quando não há tick. */
export function levelTolerance(price: number, symbol: string | null): number {
  const instrumento = symbol === null ? null : resolveInstrument(symbol);
  const porTick = instrumento === null ? 0 : instrumento.tickSize * 2;
  return Math.max(porTick, Math.abs(price) * MATCH_FRACTION);
}

function centro(level: PriceLevel): number | null {
  const min = level.priceMin.visible ? level.priceMin.value : null;
  if (min === null) return null;
  const max = level.priceMax !== null && level.priceMax.visible ? level.priceMax.value : null;
  return max === null ? min : (min + max) / 2;
}

function zonaDe(level: PriceLevel): { min: number; max: number } | null {
  const min = level.priceMin.visible ? level.priceMin.value : null;
  const max = level.priceMax !== null && level.priceMax.visible ? level.priceMax.value : null;
  if (min === null || max === null) return null;
  return { min: Math.min(min, max), max: Math.max(min, max) };
}

/** O preço está encostando neste nível? Zona inclui a faixa inteira. */
export function tocandoNivel(level: TrackedLevel, price: number, tolerancia: number): boolean {
  if (level.zone !== null) {
    return price >= level.zone.min - tolerancia && price <= level.zone.max + tolerancia;
  }
  return Math.abs(price - level.price) <= tolerancia;
}

function push(level: TrackedLevel, event: LevelEvent): LevelEvent[] {
  return [...level.history, event].slice(-MAX_HISTORY);
}

export interface ObserveLevelsInput {
  /** Níveis lidos NESTE print. */
  levels: PriceLevel[];
  /** Preço atual legível. Null quando a etiqueta não foi lida. */
  price: number | null;
  now: number;
  symbol: string | null;
}

export interface ObserveLevelsResult {
  registry: LevelRegistry;
  /** Níveis criados agora — a lista curta que o card pode destacar. */
  criados: TrackedLevel[];
  /** Níveis marcados POST_HOC nesta passada. */
  postHoc: TrackedLevel[];
}

/**
 * Um passo do registro: os níveis do print atual atualizam (ou criam) as
 * identidades vivas, e o preço atual marca os toques.
 *
 * PURA. A ordem interna importa: o TOQUE dos níveis já conhecidos é marcado
 * ANTES de criar os novos. Sem isso, um nível criado neste mesmo print com o
 * preço em cima dele "roubaria" o primeiro toque de um nível antigo legítimo,
 * e o antigo perderia a prova de que foi previsto antes.
 */
export function observeLevels(
  registry: LevelRegistry,
  input: ObserveLevelsInput,
): ObserveLevelsResult {
  const { price, now, symbol } = input;
  let levels = registry.levels;
  let sequence = registry.sequence;
  const criados: TrackedLevel[] = [];
  const postHoc: TrackedLevel[] = [];

  /* ---------- 1. Toque nos níveis JÁ conhecidos ---------- */
  if (price !== null) {
    levels = levels.map((level) => {
      if (level.firstTouchAt !== null) return level;
      if (!tocandoNivel(level, price, levelTolerance(level.price, symbol))) return level;
      return {
        ...level,
        firstTouchAt: now,
        status: level.status === "ACTIVE" ? "TOUCHED" : level.status,
        history: push(level, {
          kind: "TOUCHED",
          at: now,
          reason: `preço ${price} encostou no nível ${level.price}`,
        }),
      };
    });
  }

  /* ---------- 2. Níveis do print: casar por preço, nunca por nome ---------- */
  for (const lido of input.levels) {
    const preco = centro(lido);
    if (preco === null) continue; // nível ilegível não vira identidade
    const zona = zonaDe(lido);
    const tolerancia = levelTolerance(preco, symbol);
    const existenteIndex = levels.findIndex((l) => Math.abs(l.price - preco) <= tolerancia);

    if (existenteIndex >= 0) {
      const atual = levels[existenteIndex]!;
      const eventos: LevelEvent[] = [];
      /*
       * RENOMEAR NÃO CRIA NÍVEL. O modelo chama o mesmo preço de "suporte
       * estrutural" num print e de "POI" no seguinte — a identidade é o PREÇO,
       * e a troca de vocabulário fica registrada como evento em vez de virar
       * uma segunda linha no gráfico.
       */
      if (atual.type !== lido.kind || atual.label !== lido.label) {
        eventos.push({
          kind: "RENAMED",
          at: now,
          reason: `releitura chamou de ${lido.kind}/"${lido.label}" o que estava como ${atual.type}/"${atual.label}"`,
        });
      }
      // Ajuste fino de preço dentro da tolerância: registrado, nunca silencioso.
      if (Math.abs(atual.price - preco) > Number.EPSILON) {
        eventos.push({
          kind: "PRICE_ADJUSTED",
          at: now,
          reason: `releitura ajustou ${atual.price} para ${preco} (dentro da tolerância de ${tolerancia.toFixed(2)})`,
        });
      }
      levels = [...levels];
      levels[existenteIndex] = {
        ...atual,
        type: lido.kind,
        label: lido.label,
        zone: zona ?? atual.zone,
        history: eventos.reduce((h, e) => [...h, e].slice(-MAX_HISTORY), atual.history),
      };
      continue;
    }

    /* ---------- 3. Nível novo: nasce, e pode nascer POST_HOC ---------- */
    sequence += 1;
    const jaEstaNoNivel =
      price !== null &&
      (zona !== null
        ? price >= zona.min - tolerancia && price <= zona.max + tolerancia
        : Math.abs(price - preco) <= tolerancia);
    const novo: TrackedLevel = {
      levelId: `LVL-${now}-${String(sequence).padStart(3, "0")}`,
      price: preco,
      zone: zona,
      type: lido.kind,
      label: lido.label,
      createdAt: now,
      detectedAt: now,
      // Preço já em cima do nível no instante da detecção: o primeiro toque é
      // AGORA, simultâneo à descoberta — e simultâneo já satisfaz `>=`.
      firstTouchAt: jaEstaNoNivel ? now : null,
      predictedBeforeTouch: !jaEstaNoNivel,
      postHoc: jaEstaNoNivel,
      status: jaEstaNoNivel ? "TOUCHED" : "ACTIVE",
      history: [
        {
          kind: "DETECTED",
          at: now,
          reason: `nível ${lido.kind} "${lido.label}" detectado em ${preco}`,
        },
        ...(jaEstaNoNivel
          ? [
              {
                kind: "POST_HOC" as const,
                at: now,
                reason: `preço ${price} já estava no nível quando ele foi detectado — análise histórica, não previsão`,
              },
            ]
          : []),
      ],
    };
    levels = [...levels, novo];
    criados.push(novo);
    if (novo.postHoc) postHoc.push(novo);
  }

  return { registry: { levels, sequence }, criados, postHoc };
}

/**
 * MUDANÇA DE FUNÇÃO É EVENTO, NUNCA NÍVEL NOVO (§8).
 *
 * `RESISTANCE → BROKEN → SUPPORT_RETEST` é a história de UM preço, e é assim que
 * ela tem de ficar gravada. Recriar o nível a cada etapa apagaria o fato de que
 * a região já foi testada — que é justamente o que dá peso ao reteste.
 */
export function transitionLevel(
  registry: LevelRegistry,
  levelId: string,
  to: LevelStatus,
  motivo: string,
  now: number,
): LevelRegistry {
  const index = registry.levels.findIndex((l) => l.levelId === levelId);
  if (index < 0) return registry;
  const atual = registry.levels[index]!;
  if (atual.status === to) return registry;
  const levels = [...registry.levels];
  levels[index] = {
    ...atual,
    status: to,
    history: push(atual, {
      kind: "TRANSITION",
      at: now,
      reason: `${atual.status} → ${to}: ${motivo}`,
    }),
  };
  return { ...registry, levels };
}

/**
 * O nível conta como PREVISÃO?
 *
 * Só quando existia no registro ANTES do primeiro toque. É a única leitura que
 * autoriza contá-lo em acerto, em entrada e em backtest — as três portas que o
 * §7 fecha para o POST_HOC.
 */
export function contaComoPrevisao(level: TrackedLevel): boolean {
  return !level.postHoc && level.predictedBeforeTouch;
}

/** POST_HOC nunca gera entrada — nem agora, nem retroativamente. */
export function elegivelParaEntrada(level: TrackedLevel): boolean {
  return contaComoPrevisao(level) && level.status !== "INVALIDATED" && level.status !== "EXPIRED";
}

/** POST_HOC nunca entra no backtest: ele melhoraria a estatística com o gabarito. */
export function elegivelParaBacktest(level: TrackedLevel): boolean {
  return contaComoPrevisao(level);
}

/** Só os níveis que podem ser contados como previsão/acerto. */
export function niveisPrevistos(registry: LevelRegistry): TrackedLevel[] {
  return registry.levels.filter(contaComoPrevisao);
}

/** Os POST_HOC, para a tela poder mostrá-los como HISTÓRICO e rotulá-los. */
export function niveisPostHoc(registry: LevelRegistry): TrackedLevel[] {
  return registry.levels.filter((l) => l.postHoc);
}

/** Rótulo do nível na tela — POST_HOC é DITO, nunca escondido. */
export function rotuloDoNivel(level: TrackedLevel): string {
  return level.postHoc ? `${level.label} (POST_HOC — análise histórica)` : level.label;
}
