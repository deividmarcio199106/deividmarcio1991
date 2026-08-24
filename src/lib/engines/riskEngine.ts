import { activeManagement, blendedR } from "@/lib/t4/management";
import { distanceToNearestLiquidity } from "./liquidityEngine";
import type { Features } from "./marketFeatures";
import { DEFAULT_RISK_PARAMS, roundToTick, type RiskParams } from "./strategy";
import type {
  DataQuality,
  Direction,
  PriceActionRead,
  LiquidityMap,
  POI,
  RiskRead,
  SMSRead,
  TradePlan,
  WyckoffRead,
} from "./types";

/**
 * RiskEngine — risco de reversão, qualidade de stop, espaço até alvo e plano.
 * Uma entrada nunca é aprovada só porque existe tendência.
 *
 * Stop e alvo agora usam POI/liquidez como referência quando disponíveis
 * (mais informativo que só ATR); sem POI/liquidez relevante, cai exatamente
 * no comportamento anterior (só ATR) — nenhuma funcionalidade existente foi
 * removida.
 */
export function assessRisk(
  f: Features,
  pa: PriceActionRead,
  wy: WyckoffRead,
  direction: Direction,
  liquidity: LiquidityMap,
  mainPoi: POI | null,
  dataQuality: DataQuality,
): RiskRead {
  const dir = direction === "VENDA" ? -1 : 1;

  const factors = [
    { label: "Exaustão", value: pa.exhaustion },
    { label: "Divergência", value: Math.abs(f.divergence) * 100 },
    {
      label: "Absorção contrária",
      value:
        f.positionInRange > 0.7 && dir > 0
          ? pa.stall
          : f.positionInRange < 0.3 && dir < 0
            ? pa.stall
            : pa.stall * 0.3,
    },
    {
      label: "Falha de continuidade",
      value: Math.max(0, (1 - Math.abs(f.momentum)) * 60 - (1 - f.locationInTrend) * 20),
    },
    { label: "Rejeição (pavio contra)", value: (dir > 0 ? f.upperWick : f.lowerWick) * 100 },
    { label: "Perda de momentum", value: Math.max(0, -f.acceleration * dir) * 80 },
    { label: "Preço esticado", value: f.locationInTrend * 70 },
    {
      label: "Contexto Wyckoff contrário",
      value:
        (wy.schema === "Distribuição" && dir > 0) || (wy.schema === "Acumulação" && dir < 0)
          ? wy.confidence * 80
          : 0,
    },
  ];

  const reversalRisk = Math.max(
    0,
    Math.min(100, factors.reduce((a, x) => a + x.value, 0) / factors.length),
  );

  // Stop técnico: usa o extremo de invalidação do POI principal quando alinhado
  // e ainda válido; caso contrário, mesma heurística de swing ± ATR de sempre.
  const poiAligned =
    mainPoi && mainPoi.direction === direction && mainPoi.condition !== "invalidado";
  const swingRef = dir > 0 ? f.swingLow - f.atr * 0.2 : f.swingHigh + f.atr * 0.2;
  const ref = poiAligned ? mainPoi!.invalidation : swingRef;
  const rawDistance = Math.abs(f.price - ref);
  /*
   * O STOP É INVALIDAÇÃO ESTRUTURAL — o ATR pode impor PISO, nunca TETO.
   *
   * Aqui existia `Math.min(..., f.atr * (poiAligned ? 2.4 : 1.8))`. Esse teto
   * ENCURTAVA o stop até caber num R:R apresentável: uma invalidação a 4 ATR
   * virava 2,4 ATR, o risco por operação saía menor do que a estrutura exige e
   * o R:R exibido na tela ficava plausível — mas descrevia um stop que não
   * protege a operação. Quando o preço voltasse ao ponto que de fato invalida a
   * leitura, a posição já teria sido estopada antes, com a técnica intacta.
   *
   * O piso (`f.atr * 0.8`) fica: stop colado demais não é stop, é ruído. O que
   * some é o teto. Se a invalidação estrutural for grande demais para o risco
   * configurado, o caminho certo é NO_TRADE — e é `buildPlan` que o executa,
   * comparando com `minStopDistance`/`maxStopDistance`.
   */
  const stopDistance = Math.max(rawDistance, f.atr * 0.8);
  const stopInAtr = stopDistance / f.atr;
  const stopQuality = Math.max(0, Math.min(100, 100 - Math.abs(stopInAtr - 1.4) * 38));

  // Espaço até o alvo: liquidez oposta relevante como obstáculo/alvo; sem
  // liquidez utilizável, cai na heurística estrutural anterior.
  // Em compra o alvo está na liquidez compradora acima; em venda, na
  // liquidez vendedora abaixo. A versão anterior usava os lados invertidos.
  const oppositeLiquidity = dir > 0 ? liquidity.nearestBuy : liquidity.nearestSell;
  const liquidityObstacle =
    oppositeLiquidity && Math.sign(oppositeLiquidity.price - f.price) === Math.sign(dir)
      ? oppositeLiquidity.price
      : null;
  const structuralObstacle =
    dir > 0
      ? Math.max(f.rangeHigh, f.price + f.atr * 2)
      : Math.min(f.rangeLow, f.price - f.atr * 2);
  const obstacle = liquidityObstacle ?? structuralObstacle;

  // ESPAÇO REAL ATÉ O ALVO — sem piso artificial.
  //
  // v4.0.0: removido o `Math.max(..., f.atr * 3)` que existia aqui. Aquele piso
  // fazia um alvo colado no preço parecer ter 3 ATR de espaço, inflando
  // `targetRoom` e `riskReward` justamente nos casos em que a liquidez oposta
  // está próxima demais e a operação deveria ser BLOQUEADA. Agora o espaço é o
  // que o gráfico mostra; quando ele não comporta o risco, os gates de R:R
  // reprovam o plano e o motivo aparece nos blockers.
  const room = Math.abs(obstacle - f.price);
  const targetRoom = Math.max(0, Math.min(100, (room / f.atr) * 22));

  const riskReward = stopDistance > 0 ? room / stopDistance : 0;

  const qualityFactors = buildQualityFactors(f, wy, liquidity, mainPoi, dataQuality, stopInAtr);

  return {
    reversalRisk,
    stopQuality,
    targetRoom,
    riskReward,
    factors,
    qualityFactors,
  };
}

/**
 * Penalidades de QUALIDADE DE ENTRADA — distintas do risco de reversão.
 * "Sinal contra fase Wyckoff" já é coberto por `factors` (Contexto Wyckoff
 * contrário); "risco/retorno ruim" já é coberto pelo MIN_RISK_REWARD em
 * analysisPipeline. O motor puro não usa latência de interface como evidência de
 * mercado.
 */
function buildQualityFactors(
  f: Features,
  wy: WyckoffRead,
  liquidity: LiquidityMap,
  mainPoi: POI | null,
  dataQuality: DataQuality,
  stopInAtr: number,
): RiskRead["qualityFactors"] {
  const out: RiskRead["qualityFactors"] = [];

  out.push({
    label: "Entrada atrasada",
    value: Math.round(Math.max(0, f.locationInTrend - 0.6) * 250),
    note: "Preço já esticado das médias — miolo do movimento pode já ter passado",
  });

  if (mainPoi) {
    const mid = (mainPoi.upper + mainPoi.lower) / 2;
    const distAtr = Math.abs(f.price - mid) / Math.max(f.atr, 1e-9);
    out.push({
      label: "Distância do POI",
      value: Math.round(Math.min(100, Math.max(0, (distAtr - 1) * 40))),
    });
  } else {
    out.push({ label: "Distância do POI", value: 0, note: "Sem POI de referência no momento" });
  }

  out.push({
    label: "Stop excessivo",
    value: Math.round(Math.max(0, stopInAtr - 1.8) * 60),
  });

  const liqDistAtr = distanceToNearestLiquidity(liquidity, f.price, f.atr);
  out.push({
    label: "Baixa liquidez",
    value:
      liquidity.levels.length === 0
        ? 70
        : Math.round(Math.min(60, Math.max(0, (liqDistAtr - 3) * 15))),
  });

  out.push({
    label: "Conflito entre tempos gráficos",
    value: 0,
    note: "Indisponível — este sistema captura apenas um timeframe",
  });

  out.push({
    label: "Dados incompletos",
    value: Math.round(100 - dataQuality.quality),
    note: dataQuality.issues.join("; ") || undefined,
  });

  out.push({
    label: "Range sem direção",
    value: Math.abs(f.trend) < 0.28 && wy.schema === "Indefinido" ? 55 : 0,
  });

  out.push({
    label: "Rompimento sem fechamento",
    value: (f.brokeHigh || f.brokeLow) && f.bodyRatio < 0.35 ? 45 : 0,
  });

  out.push({
    label: "POI já mitigado",
    value: mainPoi?.condition === "mitigado" ? 35 : mainPoi?.condition === "invalidado" ? 60 : 0,
  });

  return out;
}

/**
 * TESTE OU ENTRADA DIRETA + "pegar o miolo do movimento".
 * Não busca fundo/topo exato nem persegue candle atrasado. Prioriza reteste
 * do POI principal quando o SMS já está confirmado; evita perseguir preço
 * muito esticado.
 */
export function buildPlan(
  f: Features,
  pa: PriceActionRead,
  risk: RiskRead,
  direction: Direction,
  mainPoi: POI | null,
  sms: SMSRead,
  targetLiquidityPrice: number | null,
  params: RiskParams = DEFAULT_RISK_PARAMS,
  /**
   * CANAL DE MOTIVO do NO_TRADE. `buildPlan` devolvendo `null` diz ao operador
   * que não há plano, mas não diz POR QUÊ — e um NO_TRADE sem motivo é
   * indistinguível de um bug no motor. Quem quiser o motivo passa um array e o
   * encontra preenchido; quem não passa continua funcionando como antes (o
   * parâmetro é opcional e nenhum chamador existente precisou mudar).
   */
  blockers?: string[],
): TradePlan | null {
  if (direction === "NEUTRO") return null;
  const dir = direction === "COMPRA" ? 1 : -1;

  const breakoutStrength = pa.conviction * 0.4 + pa.thrust * 0.3 + f.displacement * 30;
  const retestChance = 100 - Math.min(100, breakoutStrength) + pa.stall * 0.25;
  let directEntry = breakoutStrength > 62 && retestChance < 55;

  // Evita perseguir o preço depois de deslocamento muito estendido.
  if (f.locationInTrend > 0.8) directEntry = false;

  // stopMethod "somente_atr" (spec §7) ignora o POI como referência do stop
  // mesmo quando haveria um alinhado — só afeta a REFERÊNCIA do stop, nunca a
  // lógica de entrada por reteste (que continua usando o POI normalmente).
  const poiAligned =
    params.stopMethod === "combinado" &&
    mainPoi &&
    mainPoi.direction === direction &&
    mainPoi.condition !== "invalidado";
  const smsConfirmedHere = sms.confirmed && sms.direction === direction;

  let entry: number;
  let entryPoiId: string | null = null;
  if (
    smsConfirmedHere &&
    mainPoi &&
    mainPoi.direction === direction &&
    mainPoi.condition !== "invalidado"
  ) {
    // Reteste do POI após SMS confirmado — prioridade explícita da metodologia.
    const edge = dir > 0 ? mainPoi.upper : mainPoi.lower;
    const alreadyInside = dir > 0 ? f.price <= mainPoi.upper : f.price >= mainPoi.lower;
    entry = alreadyInside ? f.price : edge;
    entryPoiId = mainPoi.id;
    directEntry = false;
  } else {
    const level = f.retestingLevel ?? (dir > 0 ? f.swingHigh : f.swingLow);
    entry = directEntry ? f.price : level + dir * f.atr * 0.12;
  }

  const swingRef = dir > 0 ? f.swingLow - f.atr * 0.2 : f.swingHigh + f.atr * 0.2;
  const ref = poiAligned ? mainPoi!.invalidation : swingRef;
  /*
   * MESMA REGRA DO `assessRisk`: o ATR é PISO do stop, jamais TETO.
   *
   * O `Math.min(..., f.atr * (poiAligned ? 2.4 : 1.8))` que existia aqui
   * encurtava a distância até o plano "caber" no R:R — inventando um R:R que a
   * estrutura não sustenta. Como `target1`/`target2` são projetados A PARTIR de
   * `stopDistance`, o teto contaminava também os alvos: tudo saía coerente na
   * tela e errado no gráfico.
   */
  const stopDistance = Math.max(Math.abs(entry - ref), f.atr * 0.8);

  // Distância mínima/máxima do stop (spec §7) — fora dos limites configurados,
  // nenhum plano é liberado (nunca "força" um stop fora do que foi configurado).
  // É ESTA linha que vira o NO_TRADE quando a invalidação estrutural estoura o
  // risco configurado — o papel que o teto de ATR usurpava encurtando o stop.
  if (stopDistance < params.minStopDistance || stopDistance > params.maxStopDistance) {
    const maximo = Number.isFinite(params.maxStopDistance)
      ? params.maxStopDistance.toString()
      : "sem máximo";
    blockers?.push(
      `T4: stop estrutural de ${stopDistance.toFixed(2)} fora dos limites configurados ` +
        `(mínimo ${params.minStopDistance}, máximo ${maximo}) — plano bloqueado.`,
    );
    return null;
  }

  const stop = entry - dir * stopDistance;
  const target1 = entry + dir * stopDistance * params.partialTargetMultiple;
  const target2 = entry + dir * stopDistance * params.finalTargetMultiple;

  /*
   * OBSTÁCULO ANTES DO ALVO FINAL = NO_TRADE, NÃO ALVO ENCOLHIDO.
   *
   * Aqui a liquidez oposta PUXAVA `target2` para perto (`Math.min`/`Math.max`
   * contra `targetLiquidityPrice`). O efeito era adulterar o alvo sem adulterar
   * o nome dele: um espaço real de 3,4R saía da função rotulado como o alvo
   * final da técnica, e todo o benchmark que autoriza operar (PF, drawdown em R)
   * passava a ser medido sobre um alvo que a T4 não pede.
   *
   * A leitura correta é a inversa: se existe liquidez oposta ANTES da projeção
   * de `finalTargetMultiple`, o caminho até o alvo não está livre — a operação
   * não tem espaço técnico e não deve existir. O alvo continua sendo o da
   * técnica; o que muda é que a operação é recusada quando o gráfico não o
   * comporta.
   *
   * ORDEM: esta checagem usa `entry` e `stopDistance` PRÉ-arredondamento, que é
   * onde o bloco sempre esteve. Fazê-la depois do tick mudaria o veredito por
   * até meio tick — um plano passaria ou reprovaria por arredondamento, não por
   * estrutura.
   */
  if (targetLiquidityPrice !== null) {
    const room = dir > 0 ? targetLiquidityPrice - entry : entry - targetLiquidityPrice;
    const required5R = stopDistance * params.finalTargetMultiple;
    if (room > 0 && room < required5R) {
      blockers?.push(
        `T4: obstáculo estrutural a ${(room / stopDistance).toFixed(2)}R antes do alvo de ` +
          `${params.finalTargetMultiple}R — plano bloqueado.`,
      );
      return null;
    }
  }

  // Arredondamento para o tick mínimo do ativo (spec §7) — sempre por último,
  // depois de toda a matemática do plano já ter sido feita com preços exatos.
  const tick = params.tickSize;
  const roundedEntry = roundToTick(entry, tick);
  const roundedStop = roundToTick(stop, tick);
  const roundedTarget1 = roundToTick(target1, tick);
  const roundedTarget2 = roundToTick(target2, tick);

  // Distância real do stop DEPOIS do arredondamento: é ela que o operador vive.
  const roundedStopDistance = Math.abs(roundedEntry - roundedStop);
  if (roundedStopDistance <= 0) {
    blockers?.push(
      `T4: entrada e stop caem no MESMO tick de ${tick} após o arredondamento — ` +
        "risco por operação seria zero e o plano foi bloqueado.",
    );
    return null;
  }

  /*
   * Os três R:R, calculados separadamente. O do PLANO pondera as pernas pela
   * fração realizada em cada uma.
   *
   * A ponderação vinha da fração 60/40 — um plano de DUAS pernas — enquanto a
   * operação é conduzida com TRÊS contratos. O R:R do plano descrevia, portanto,
   * uma gestão que não é a executada, e é ele que o gate RISK_REWARD compara com
   * o mínimo. Agora a ponderação vem do perfil ATIVO, e passa a descrever o que
   * de fato acontece com a posição.
   *
   * O limiar `MIN_RISK_REWARD_PLAN` não mudou.
   */
  const rrPartial = Math.abs(roundedTarget1 - roundedEntry) / roundedStopDistance;
  const rrFinal = Math.abs(roundedTarget2 - roundedEntry) / roundedStopDistance;
  const rrPlan = blendedR(activeManagement(), [rrPartial, rrFinal]) ?? rrPartial;

  return {
    direction,
    entry: roundedEntry,
    stop: roundedStop,
    target1: roundedTarget1,
    target2: roundedTarget2,
    riskReward: rrPartial,
    riskRewardFinal: rrFinal,
    riskRewardPlan: rrPlan,
    stopDistance: roundedStopDistance,
    mode: directEntry ? "ENTRADA DIRETA PROVÁVEL" : "AGUARDANDO RETESTE",
    entryPoiId,
    targetLiquidityPrice,
  };
}
