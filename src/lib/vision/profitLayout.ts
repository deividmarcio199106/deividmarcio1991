/**
 * LAYOUT REAL DO PROFIT PRO — medido numa captura do operador.
 *
 * Referência: WINFUT 1Min, tema escuro, janela 1365×767, Profit PRO 5.0.4.12,
 * "Contador de Candles" ligado, 21 candles visíveis (543 a 563).
 *
 * Estes números descrevem UM layout observado. Não são lei: servem como
 * palpite inicial e como caso de teste. A detecção em produção usa
 * `chartRoi.detectRoi`, que mede estrutura e não posição fixa — senão bastaria
 * o operador mover a janela para tudo quebrar.
 */

import type { Roi } from "./chartRoi";

/** Frações medidas na captura de referência. */
export const REFERENCE_LAYOUT = {
  frame: { width: 1365, height: 767 },
  /** Área onde os candles são desenhados. */
  plot: { x: 0.006, y: 0.134, width: 0.919, height: 0.69 },
  /** Faixa do eixo de preço, à direita. */
  priceAxis: { from: 0.929, to: 0.974 },
  /** Faixa do eixo de tempo, embaixo. */
  timeAxis: { from: 0.828, to: 0.867 },
  /** Barra de ferramentas vertical à direita — nunca contém gráfico. */
  rightToolbar: { from: 0.975, to: 1 },
  /** Cabeçalho: menu, barra de ferramentas, abas e linha OHLC do ativo. */
  header: { from: 0, to: 0.134 },
  /** Abas de layout, workspace e barra do Windows. */
  footer: { from: 0.873, to: 1 },
  candlesVisible: 21,
  /** Largura média do corpo do candle, em fração da largura do gráfico. */
  candleBodyWidth: 0.0146,
  /** Passo entre candles vizinhos, em fração da largura do gráfico. */
  candlePitch: 0.0234,
} as const;

/**
 * ROI de partida para este layout.
 *
 * Usada quando a detecção automática ainda não convergiu — melhor começar de um
 * palpite medido do que do frame inteiro, que incluiria menu e eixo.
 */
export const PROFIT_ROI_GUESS: Roi = {
  x: REFERENCE_LAYOUT.plot.x,
  y: REFERENCE_LAYOUT.plot.y,
  width: REFERENCE_LAYOUT.plot.width,
  height: REFERENCE_LAYOUT.plot.height,
  confidence: 50,
  detail: "palpite do layout padrão do Profit — ainda não confirmado por detecção",
};

/**
 * O CLASSIFICADOR DE COR EXISTENTE JÁ SERVE PARA ESTE TEMA.
 *
 * `pixelSide` em frameProcessor.ts exige `max >= 55` e `max - min >= 38`, e
 * decide por dominância de canal. Conferido contra a captura:
 *
 *   candle de alta   verde saturado   → dominância de G folgada
 *   candle de baixa  vermelho         → dominância de R folgada
 *   fundo            quase preto      → reprovado por `max < 55`
 *   grades e textos  cinza            → reprovados por `max - min < 38`
 *
 * O detalhe que isso resolve de graça: os rótulos do "Contador de Candles"
 * (543, 544, …) ficam colados nos candles e seriam o maior risco de falso
 * positivo. Como são CINZA, a regra de saturação já os descarta — não é preciso
 * tratamento especial, e ligar ou desligar o contador não muda a leitura.
 *
 * O que NÃO funcionaria com este classificador, e precisa ser dito: tema claro,
 * candles vazados (só contorno) ou paleta customizada produzem zero pixel. Se o
 * operador mudar o tema, a leitura morre em silêncio — por isso a contagem de
 * candles detectados é publicada no diagnóstico.
 */
export const THEME_NOTES = {
  supported: "Profit PRO tema escuro, candles preenchidos verde/vermelho",
  unsupported: ["tema claro", "candles vazados (contorno)", "paleta customizada"],
} as const;

/**
 * Escala de preço observada, para conferir a ordem de grandeza do parser.
 *
 * O eixo ia de 172.200 a 172.410 em passos de 0,015 — formato brasileiro, onde
 * o ponto é separador de milhar. `normalizeScaleAnchorsForAsset` já multiplica
 * por mil quando o texto casa `\d{1,3}[.,]\d{3}` e o resultado cai na faixa do
 * WIN (10.000–500.000), então 172.255 vira 172255 pontos. Confere com o
 * cabeçalho da captura: Abr 172.255 Máx 172.270 Mín 172.245 Fch 172.250, uma
 * vela de 25 pontos — plausível para WIN em 1 minuto.
 */
export const REFERENCE_PRICE_SCALE = {
  top: 172410,
  bottom: 172200,
  step: 15,
  labels: 15,
  /** Tick do WIN. Duas velas não podem diferir por menos que isso. */
  tickSize: 5,
} as const;

/**
 * Grade de tempo observada: rótulos a cada 2 minutos (18:04 … 18:24) com o
 * instante corrente destacado (10/08/2026 18:12). O relógio do GRÁFICO é a
 * fonte de horário — nunca `Date.now()`.
 */
export const REFERENCE_TIME_AXIS = {
  labelStepMinutes: 2,
  sample: [
    "18:04",
    "18:06",
    "18:08",
    "18:12",
    "18:14",
    "18:16",
    "18:18",
    "18:20",
    "18:22",
    "18:24",
  ],
  timeframeMinutes: 1,
} as const;

/**
 * Quantos candles é razoável esperar num frame deste layout.
 *
 * Serve de sanidade: detectar 3 colunas significa que a leitura falhou, e
 * detectar 300 significa que algo fora do gráfico está sendo contado como
 * candle. Nos dois casos é melhor recusar a leitura do que alimentar o motor
 * com lixo.
 */
export const CANDLE_COUNT_SANITY = { min: 8, max: 200 } as const;

export function candleCountPlausible(count: number): boolean {
  return count >= CANDLE_COUNT_SANITY.min && count <= CANDLE_COUNT_SANITY.max;
}
