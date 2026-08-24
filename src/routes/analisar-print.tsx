import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Download, FlaskConical, History, ImageUp, RefreshCw, Trash2, Upload } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { NextPrintCard } from "@/components/print/NextPrintCard";
import { PrintChat } from "@/components/print/PrintChat";
import { PrintViewer, type ViewMode } from "@/components/print/PrintViewer";
import { ConditionalPlanCard } from "@/components/print/ConditionalPlanCard";
import { ScreenCapturePanel } from "@/components/print/ScreenCapturePanel";
import { SetupCard } from "@/components/print/SetupCard";
import { ScoreCard } from "@/components/print/ScoreCard";
import { scoreT4 } from "@/lib/t4/score";
import { PAUSA_LABEL } from "@/lib/capture/frameFreshness";
import {
  CAPTURE_PERIOD_MS,
  marketMonitor,
  syncLabel,
  type CaptureMeta,
  type SyncState,
} from "@/lib/capture/marketMonitor";
import { analyzePrint, auditPrint } from "@/lib/printAnalysis.functions";
import {
  advanceSetup,
  decidirCongelamento,
  SETUP_TTL_MS,
  type SetupStage,
  type SetupUpdate,
  type TrackedSetup,
  type TriggerVersion,
} from "@/lib/print/setupTracker";
import type { BreakoutState } from "@/lib/print/breakout";
import {
  saveToHistory,
  setHistoryFeedback,
  takeReopenRequest,
  type PrintFeedback,
} from "@/lib/print/printHistory";
import { buildZipStore, renderAnnotatedPrint, triggerDownload } from "@/lib/print/printExport";
import { resultadoGovernaTela } from "@/lib/print/captureSync";
import {
  cabeOutraInferencia,
  decompor,
  formatarTempos,
  StageClock,
} from "@/lib/print/stageTimings";
import { planScale, type ScaleMemory, type ScaleTelemetry } from "@/lib/print/scalePolicy";
import { EMPTY_PRICE_SCALE, revalidate } from "@/lib/vision/priceScaleTracker";
import { calibrationDrift } from "@/lib/vision/priceScale";
import {
  divergenciaDeFechamento,
  lerCandleFechadoPorPixels,
} from "@/lib/print/closedCandleFromPixels";
import { breakoutTolerance } from "@/lib/print/breakout";
import type { CandleOhlc } from "@/lib/print/candleLedger";
import { MarketClock } from "@/lib/vision/marketClock";
import { emptyLedger, ledgerLogLine, observeCandle, timeframeMs } from "@/lib/print/candleLedger";
import type { CandleObservation } from "@/lib/print/breakout";
import {
  autoCropPrint,
  chooseBetterReading,
  readingIsWeak,
  readingScore,
} from "@/lib/print/printCrop";
import {
  buildPriceAnnotations,
  calibratePrintImage,
  mergeCalibratedAnnotations,
  priceToFraction,
} from "@/lib/print/printScale";
import { calibratePriceScale } from "@/lib/calibration.functions";
import { comparePrintAnalyses, type ComparisonResult } from "@/lib/vision/printComparison";
import {
  deriveEntryDecision,
  podeDesenharAnotacao,
  formatRead,
  NAO_IDENTIFICADO,
  PRINT_STATUS_LABEL,
  PRINT_STATUS_MEANING,
  type Annotation,
  type PrintAnalysis,
  type PrintStatus,
} from "@/lib/vision/printAnalysis";
import { STRATEGY_VERSION } from "@/lib/engines/strategy";
import { store } from "@/lib/storage";
import type { SetupDna } from "@/lib/t4/dna";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/analisar-print")({
  component: AnalisarPrintPage,
  head: () => ({ meta: [{ title: "Analisar Print — NEXUS T4" }] }),
});

/** Limite alinhado ao server function: 12 MB cobre um print 4K em PNG. */
const MAX_BYTES = 12_000_000;

/**
 * A ÚNICA PERGUNTA QUE AUTORIZA A TELA A DIZER "COMPRA"/"VENDA" COMO OPERAÇÃO.
 *
 * Com o passo da máquina, ele manda: a máquina é quem sabe do TOQUE e dos
 * níveis herdados do setup. Sem passo (print reaberto do histórico, onde a
 * máquina nunca rodou), cai na decisão determinística do próprio print — e
 * nunca num "provavelmente sim". Toda sinalização de ordem da página passa
 * por aqui: rótulo AÇÃO, seta/triângulo no gráfico e congelamento do print.
 */
function entradaLiberada(analise: PrintAnalysis, setupInfo: SetupUpdate | null): boolean {
  if (setupInfo !== null) return setupInfo.entradaConfirmada;
  return deriveEntryDecision(analise).entradaConfirmada;
}

const ETAPAS = [
  "Carregando imagem",
  "Validando qualidade",
  "Identificando estrutura",
  "Aplicando regras T4",
  "Gerando marcações",
] as const;

const TOM_STATUS: Record<PrintStatus, string> = {
  ENTRADA_CONFIRMADA: "border-bull text-bull",
  PRE_ENTRADA: "border-bull/70 text-bull",
  APROXIMACAO_T4: "border-amber-500 text-amber-500",
  T4_EM_FORMACAO: "border-amber-500/70 text-amber-500",
  T4_INVALIDADA: "border-bear text-bear",
  SEM_T4: "border-border text-muted-foreground",
  INCONCLUSIVO: "border-border text-muted-foreground",
};

/**
 * PERSISTE O DNA DO PRINT no backend — fire-and-forget, DEPOIS do histórico.
 *
 * Sem bloco dna na resposta, nada sobe: ausência é ausência, não um registro
 * meio preenchido. Direção NEUTRO também não persiste — sem lado não há setup
 * para o banco medir (mesma regra de dnaFromAnalysis no motor). A escrita vai
 * pela fila do store, que já engole falha de rede com log: a UI nunca espera
 * nem quebra por causa desta chamada.
 */
function montarDnaDoPrint(analise: PrintAnalysis, historyId: string): SetupDna | null {
  const dna = analise.dna;
  if (!dna) return null;
  if (analise.direction !== "COMPRA" && analise.direction !== "VENDA") return null;

  /*
   * Date.now() é LEGÍTIMO aqui — e SÓ aqui. O print é a decisão do AGORA do
   * operador: ele capturou o gráfico e pediu a leitura neste instante, o mesmo
   * contrato do modo LIVE. Não existe relógio de mercado dentro da imagem que
   * pudesse carimbar outra coisa — usar qualquer outro valor seria inventá-lo.
   */
  const detectedAt = Date.now();

  // Níveis SOMENTE dos ReadNumber legíveis: invisível fica de fora, nunca vira 0.
  const entry = analise.entry.visible ? analise.entry.value : null;
  const stop = analise.stop.visible ? analise.stop.value : null;
  const targets: number[] = [];
  for (const alvo of analise.targets) {
    if (alvo.visible && alvo.value !== null) targets.push(alvo.value);
  }
  const target1 = targets[0] ?? null;
  const stopDistance = entry !== null && stop !== null ? Math.abs(entry - stop) : null;
  // RR só quando entrada, stop E primeiro alvo foram lidos — senão é null, não chute.
  const rrAvailable =
    entry !== null && target1 !== null && stopDistance !== null && stopDistance > 0
      ? Number((Math.abs(target1 - entry) / stopDistance).toFixed(3))
      : null;

  const quando = new Date(detectedAt);
  const registro: SetupDna = {
    // O id amarra o registro à entrada do histórico que o operador pode rever.
    id: `dna_print_${historyId}_${detectedAt}`,
    origin: "PRINT",
    sourceId: historyId,
    asset: analise.symbol ?? "NAO_IDENTIFICADO",
    timeframe: analise.timeframe ?? "NAO_LIDO",
    direction: analise.direction,
    detectedAt,
    tradingDate: `${quando.getFullYear()}-${String(quando.getMonth() + 1).padStart(2, "0")}-${String(quando.getDate()).padStart(2, "0")}`,
    hour: quando.getHours(),
    techniqueVersion: STRATEGY_VERSION,

    grade: dna.grade,
    trend: dna.trend,
    position: dna.position,
    pullback: dna.pullback,
    // O print não mede geometria de janela: profundidade, barras, impulso e
    // razão de volatilidade ficam null — "não medido" em vez de inventado.
    pullbackDepth: null,
    pullbackBars: null,
    impulsePoints: null,
    impulseR: null,
    location: dna.location,
    locationDetail: null,
    triggerCandle: dna.triggerCandle,
    movementOrdinal: dna.movementOrdinal,
    volatility: dna.volatility,
    volatilityRatio: null,

    stopDistancePoints: stopDistance,
    rrAvailable,
    entry,
    stop,
    targets,

    printId: historyId,
    tradeId: null,
  };

  return registro;
}

/** O que o endpoint de memória devolve — a segunda opinião com evidência. */
interface MemoriaPrint {
  similarCases: Array<{
    printId: string;
    verdict: string;
    ambiguous: boolean;
    similarity: number;
    grade: string;
    direction: string;
    tradingDate: string | null;
    differences: string[];
  }>;
  totalSimilar: number;
  resolvedCount: number;
  hits: number;
  misses: number;
  rawHitRate: number | null;
  historicalConfidence: number | null;
  note: string;
  finalConfidence: number | null;
  formula: string | null;
}

/**
 * PERSISTE O CASO E CONSULTA A MEMÓRIA — aguardado de propósito.
 *
 * DNA e print vão por fetch direto (não pela fila do store) porque a
 * consulta de memória logo abaixo PRECISA deles já gravados; a fila é
 * assíncrona e a leitura poderia chegar antes da escrita. Qualquer falha
 * devolve null: a análise nunca quebra por causa da memória — ela só fica
 * sem a segunda opinião nesta rodada.
 */
/**
 * METADADOS DOS DOIS PASSES (§13) — só medida, nunca um segundo aprendizado.
 *
 * O operador pediu "salvar análise final e metadados dos 2 passes, mas não
 * duplicar aprendizado": por isso isto viaja como METADADO junto do ÚNICO
 * registro de print que é gravado (o da leitura vencedora). Um segundo
 * registro contaria o mesmo minuto duas vezes na memória e envenenaria a
 * taxa histórica — o oposto do que a memória serve para fazer.
 */
interface MetadadosDosPasses {
  /** Por que o 2º passe foi disparado. */
  motivos: string[];
  /** Pontuação de evidência de cada leitura. */
  scorePrimeiro: number;
  scoreSegundo: number;
  /** A leitura que ficou. */
  escolhido: "PRIMEIRO" | "SEGUNDO";
  /** Recorte usado no 2º passe, em frações da imagem original. */
  recorte: { x: number; y: number; width: number; height: number; scale: number };
}

async function persistirEConsultarMemoria(
  analise: PrintAnalysis,
  registroDna: SetupDna | null,
  captura: CaptureMeta | null,
  imagem: string,
  sessionId: string | null,
  passes: MetadadosDosPasses | null,
  /**
   * Reparos declarados pela validação desta leitura.
   *
   * Viajam junto do print porque a declaração precisa sobreviver à aba: um
   * reparo que só existe no console some quando o operador fecha o navegador,
   * e aí ninguém consegue mais dizer POR QUE um campo veio vazio.
   */
  reparos: string[],
): Promise<MemoriaPrint | null> {
  try {
    const headers = { "content-type": "application/json" };
    if (registroDna !== null) {
      await fetch("/api/trading/dna", {
        method: "POST",
        headers,
        body: JSON.stringify(registroDna),
      });
    }

    // O print vira caso persistente SEMPRE — mesmo sem DNA (NEUTRO/SEM_T4),
    // porque a etiqueta de preço dele é OBSERVAÇÃO que fecha vereditos
    // anteriores. Imagem vai para o disco do servidor, nunca base64 em banco.
    const precoAtual = analise.currentPrice.visible ? analise.currentPrice.value : null;
    const alvo1 = analise.targets.find((t) => t.visible && t.value !== null) ?? null;
    const stopLegivel = analise.stop.visible && analise.stop.value !== null;
    const temLado = analise.direction === "COMPRA" || analise.direction === "VENDA";
    await fetch("/api/trading/prints", {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: `prt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        sessionId,
        asset: analise.symbol ?? "NAO_IDENTIFICADO",
        timeframe: analise.timeframe ?? "NAO_LIDO",
        capturedAt: Date.now(),
        status: analise.status,
        direction: analise.direction,
        confidence: analise.confidence,
        currentPrice: precoAtual,
        dnaId: registroDna?.id ?? null,
        captureCode: captura?.code ?? "COLADO",
        analysis: analise,
        imageDataUrl: imagem,
        // Null quando o 2º passe não rodou — que é o caso da maioria dos prints.
        passes,
        // `[]` afirma que a validação rodou e não achou nada — não é ausência.
        repairs: reparos,
        // Previsão SÓ com critério completo PRÉ-definido: sem stop e alvo
        // legíveis agora, não existe o que verificar depois.
        prediction:
          temLado && stopLegivel && alvo1 !== null
            ? {
                entry: analise.entry.visible ? analise.entry.value : null,
                stop: analise.stop.value,
                target: alvo1.value,
              }
            : null,
      }),
    });

    if (registroDna === null) return null;
    const resposta = await fetch(
      `/api/trading/memory?dnaId=${encodeURIComponent(registroDna.id)}&asset=${encodeURIComponent(
        registroDna.asset,
      )}&visual=${analise.confidence}`,
    );
    if (!resposta.ok) return null;
    return (await resposta.json()) as MemoriaPrint;
  } catch {
    return null;
  }
}

/**
 * PERSISTE O SETUP NO SERVIDOR — fire-and-forget, a cada passo da máquina.
 *
 * Sem isto o setup vivia só na aba do navegador: reiniciar o backend (ou
 * recarregar a página no meio de uma oportunidade) apagava a linha roxa, o
 * toque já registrado e o marco da confirmação. Gravado, ele volta igual
 * quando a tela reabre — e é também o que permite ao SERVIDOR fechar o
 * resultado sozinho depois, sem ninguém na frente do computador.
 *
 * Falha de rede não derruba a análise: o setup continua correto em memória e
 * a próxima captura tenta de novo (o endpoint é idempotente por setupId).
 */
function persistirSetup(
  setup: TrackedSetup,
  analise: PrintAnalysis,
  historyId: string | null,
): void {
  void fetch("/api/trading/setups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      setupId: setup.setupId,
      asset: analise.symbol ?? "WINFUT",
      timeframe: analise.timeframe,
      direction: setup.direction,
      stage: setup.stage,
      entry: setup.entryLevel,
      stop: setup.stop,
      target: setup.target,
      entryZoneMin: setup.entryZone?.min ?? null,
      entryZoneMax: setup.entryZone?.max ?? null,
      confirmedAt: setup.confirmedAt,
      createdAt: setup.createdAt,
      // Prazo do §20: sem ativação até aqui o servidor expira o setup, mesmo
      // que o navegador tenha sido fechado no meio da oportunidade.
      expiresAt: setup.createdAt + SETUP_TTL_MS,
      dnaId: null,
      printId: historyId,
      /*
       * §32/§34 — O ESTADO DO ROMPIMENTO VAI JUNTO.
       *
       * `breakout` é memória construída ao longo de vários candles. Sem
       * persisti-la, reiniciar o navegador no meio de um rompimento faz o
       * candle seguinte — que era a PROVA — voltar a ser tratado como o
       * primeiro fechamento, e a sustentação nunca completa.
       */
      triggerLevel: setup.trigger,
      triggerVersion: setup.triggerVersion,
      triggerHistory: setup.triggerHistory,
      breakout: setup.breakout,
      operationReleased: setup.operationReleased,
    }),
  }).catch(() => {
    // Silêncio proposital: rede caída não pode virar erro na tela de análise.
  });
}

/** O que o servidor devolve em GET /api/trading/setups?open=1. */
interface SetupSalvo {
  setupId: string;
  direction: "COMPRA" | "VENDA";
  stage: SetupStage;
  entry: number | null;
  stop: number | null;
  target: number | null;
  entryZoneMin: number | null;
  entryZoneMax: number | null;
  confirmedAt: number | null;
  createdAt: number;
  updatedAt: number;
  /* §32/§34 — o que precisa sobreviver ao F5 para a máquina não recomeçar. */
  triggerLevel: number | null;
  triggerVersion: number;
  triggerHistory: TriggerVersion[];
  breakout: BreakoutState | null;
  operationReleased: boolean;
}

/**
 * Traz de volta o setup ABERTO mais recente do servidor.
 *
 * `printsSeen` volta como 0 de propósito: é a contagem DESTA sessão de tela, e
 * inventar um histórico que não foi observado aqui seria afirmar mais do que
 * se sabe. O que importa atravessa: id, estágio, níveis e o marco da
 * confirmação — que é o anti-look-ahead do desfecho.
 */
function setupSalvoParaVivo(salvo: SetupSalvo): TrackedSetup {
  const zona =
    salvo.entryZoneMin !== null && salvo.entryZoneMax !== null
      ? { min: salvo.entryZoneMin, max: salvo.entryZoneMax }
      : null;
  return {
    setupId: salvo.setupId,
    stage: salvo.stage,
    direction: salvo.direction,
    entryLevel: salvo.entry,
    entryZone: zona,
    stop: salvo.stop,
    target: salvo.target,
    createdAt: salvo.createdAt,
    updatedAt: salvo.updatedAt,
    printsSeen: 0,
    touched: salvo.confirmedAt !== null,
    confirmedAt: salvo.confirmedAt,
    reason: "restaurado do servidor após reinício",

    /*
     * O ESTADO DO ROMPIMENTO VOLTA DO SERVIDOR — e precisa voltar.
     *
     * Sem ele, um F5 no meio de um rompimento fazia a máquina esquecer que já
     * havia fechamento além do gatilho: o caso recomeçava do zero e o candle
     * seguinte, que era a PROVA, virava de novo "o primeiro fechamento". A
     * oportunidade se perdia sem sintoma nenhum na tela.
     *
     * Setup gravado ANTES destas colunas volta com `breakout: null` — nenhum
     * rompimento observado, que é a leitura conservadora e correta: o banco
     * não sabe, então não afirma.
     */
    trigger: salvo.triggerLevel,
    triggerVersion: salvo.triggerVersion,
    triggerHistory: salvo.triggerHistory,
    breakout: salvo.breakout,
    /*
     * O RISCO NÃO É REIDRATADO — e isso é deliberado.
     *
     * `risk` é o veredito de `riskGate` sobre os níveis DESTE print. Trazê-lo
     * do banco afirmaria uma avaliação que ninguém fez nesta sessão; o
     * primeiro print real reavalia com os números na tela. Enquanto isso,
     * null significa "ainda não avaliado", que bloqueia — nunca aprova.
     */
    risk: null,
    /*
     * E a LIBERAÇÃO nunca volta do banco como `true`.
     *
     * `operationReleased` é a porta de operar. Restaurá-la de uma linha
     * gravada afirmaria permissão sem que `breakout.ts` e `riskGate.ts`
     * tivessem julgado nada agora. O valor persistido serve para AUDITAR o
     * desfecho no servidor; para a tela, quem decide é o próximo print.
     */
    operationReleased: false,
  };
}

/**
 * O horário do CANDLE deste print (§14).
 *
 * Cai para o instante da captura só quando não existe candle — imagem colada
 * ou reaberta do histórico. Nunca inventa um minuto: o que não veio do ciclo
 * mostra o tempo que realmente tem.
 */
/**
 * Instante em ISO, ou null quando ele nao existe.
 *
 * `new Date(NaN).toISOString()` LANCA `RangeError: Invalid time value`, e um
 * campo de diagnostico que lanca derruba o trabalho que ele deveria apenas
 * descrever — foi o defeito de producao de 20/08/2026. Null aqui significa
 * "nao medido", que e a mesma convencao do resto do registro.
 */
function instante(t: number | null | undefined): string | null {
  return typeof t === "number" && Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function horaDoCandle(item: SessaoPrint): string {
  const quando = item.candleTime ?? item.capturedAt;
  return new Date(quando).toLocaleTimeString("pt-BR", HORA_MINUTO);
}

/**
 * A LINHA ROXA — "ENTRAR SE TOCAR AQUI", posicionada pela régua da escala.
 *
 * Função à parte porque ela roda DEPOIS da tela, junto da calibração: nível
 * sem régua é palpite de pixel, e palpite de pixel foi o defeito que fazia as
 * marcações caírem "perto". Sem calibração não sai linha — o número continua
 * no card SETUP T4, que é o que a decisão realmente usa.
 */
function construirLinhaDoSetup(
  passo: SetupUpdate,
  paraFracao: (preco: number) => number | null,
): Annotation | null {
  const setupVivo = passo.setup;
  if (setupVivo === null || setupVivo.entryLevel === null) return null;

  const sufixoDistancia =
    passo.distancePoints !== null ? ` · ${passo.distancePoints.toLocaleString("pt-BR")} pts` : "";
  const motivoLinha = `Entrada do setup ${setupVivo.setupId} — posicionada pela régua da escala deste print.`;

  if (setupVivo.entryZone !== null) {
    const yMin = paraFracao(setupVivo.entryZone.min);
    const yMax = paraFracao(setupVivo.entryZone.max);
    // Zona fora do enquadramento não vira faixa espremida na borda.
    if (yMin === null || yMax === null) return null;
    return {
      kind: "ENTRY_ZONE",
      x1: 0,
      y1: Math.min(yMin, yMax),
      x2: 1,
      y2: Math.max(yMin, yMax),
      label: `ENTRAR SE TOCAR AQUI · ${setupVivo.entryZone.min.toLocaleString("pt-BR")} – ${setupVivo.entryZone.max.toLocaleString("pt-BR")}${sufixoDistancia}`,
      index: null,
      reason: motivoLinha,
    };
  }

  const y = paraFracao(setupVivo.entryLevel);
  if (y === null) return null;
  return {
    kind: "ENTRY_LINE",
    x1: 0,
    y1: y,
    x2: 1,
    y2: y,
    label: `ENTRAR SE TOCAR AQUI · ${setupVivo.entryLevel.toLocaleString("pt-BR")}${sufixoDistancia}`,
    index: null,
    reason: motivoLinha,
  };
}

/** Sequência do dia embutida no id T4-AAAA-MM-DD-XXX, para não repetir número. */
function sequenciaDoId(setupId: string): number {
  const match = /-(\d{3})$/.exec(setupId);
  return match ? Number(match[1]) : 0;
}

const HORA_MINUTO: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
const HORA_SEGUNDO: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
};

/** Uma análise concluída dentro da sessão atual. */
interface SessaoPrint {
  id: string;
  imagem: string;
  /** Null enquanto a análise não voltou: a imagem entra na tela ANTES dela. */
  analise: PrintAnalysis | null;
  at: number;
  /** id no histórico persistido, para amarrar o feedback. */
  historyId: string | null;
  /** Diferenças contra o print ANTERIOR da sessão. Null no primeiro. */
  comparacao: ComparisonResult | null;
  /** O que a validação descartou da resposta do modelo. */
  reparos: string[];
  /** Segunda opinião da memória de casos. Null quando não consultável. */
  memoria: MemoriaPrint | null;
  /**
   * Passo da máquina de setup persistente NESTE print. Null nos caminhos em
   * que a máquina não rodou (reabertura do histórico): ausência é ausência —
   * o card SETUP T4 simplesmente não aparece para esses.
   */
  setupInfo: SetupUpdate | null;
  /**
   * O que o 2º passe (recorte ampliado) decidiu. Null quando não rodou — a
   * maioria dos prints tem leitura boa de primeira e não paga chamada extra.
   */
  zoom: string | null;

  /* ---- IDENTIDADE E TEMPO DA CAPTURA (§4, §7, §14) ---- */
  /** A chave que amarra imagem, análise e tela. */
  captureId: string;
  capturedAt: number;
  /** Candle a que este print pertence. Null em imagem colada pelo operador. */
  candleTime: number | null;
  captureDelayMs: number | null;
  sync: SyncState | null;
  analiseIniciadaEm: number | null;
  analiseConcluidaEm: number | null;
  /**
   * A análise chegou DEPOIS de uma captura mais nova já estar na tela.
   *
   * Ela continua valendo para histórico e aprendizado — foi uma leitura real
   * de um candle real —, mas NÃO governa mais o estado visual: aplicar um
   * resultado velho sobre um print novo é exatamente o defeito "imagem #74
   * com análise #73".
   */
  desatualizada: boolean;
}

function AnalisarPrintPage() {
  const analisar = useServerFn(analyzePrint);
  const auditar = useServerFn(auditPrint);
  const calibrarEscala = useServerFn(calibratePriceScale);

  /**
   * A SESSÃO É UMA LINHA DO TEMPO, não um slot único.
   *
   * Cada print analisado entra na sequência PRINT #1 → #2 → …, e o operador
   * pode reabrir qualquer um. É o que permite comparar o novo com o anterior
   * em vez de tratar cada envio como uma sessão que nasceu agora.
   */
  const [sessao, setSessao] = useState<SessaoPrint[]>([]);
  const [indice, setIndice] = useState(-1);
  /** Imagem colada aguardando análise. */
  const [pendente, setPendente] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [etapa, setEtapa] = useState(-1);
  /**
   * Análise DE FUNDO em andamento (captura automática do monitor).
   *
   * REGRA DO OPERADOR (18/08): o print visível fica CONGELADO com suas
   * marcações até a nova análise CONFIRMAR — a tela nunca fica vazia,
   * piscando ou trocando no meio. Este estado só liga o aviso "NOVA ANÁLISE
   * EM PROCESSAMENTO…"; a troca da imagem continua acontecendo num único
   * lugar (setSessao/setIndice no sucesso), nunca antes.
   */
  const [analiseFundo, setAnaliseFundo] = useState(false);
  const [modo, setModo] = useState<ViewMode>("ANALISADO");
  const [aba, setAba] = useState<"T4" | "ACAO">("T4");
  const [selecionada, setSelecionada] = useState<Annotation | null>(null);
  const [ocultas, setOcultas] = useState<Set<string>>(new Set());
  const [feedbackUi, setFeedbackUi] = useState<"PEDIR_MOTIVO" | "REGISTRADO" | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * O sincronismo mostrado (§7). Assina o monitor para reagir ao vivo — sem
   * isto o selo ficaria congelado no valor do primeiro render.
   */
  const [sincronismo, setSincronismo] = useState<SyncState>("SINCRONIZADO");
  useEffect(() => {
    const atualizar = () => setSincronismo(syncLabel(marketMonitor.getState()));
    atualizar();
    return marketMonitor.subscribe(atualizar);
  }, []);

  const atual = indice >= 0 ? (sessao[indice] ?? null) : null;
  const imagemVisivel = pendente ?? atual?.imagem ?? null;
  const analiseVisivel = pendente ? null : (atual?.analise ?? null);

  // Reabertura vinda do Histórico de Análises.
  useEffect(() => {
    const entrada = takeReopenRequest();
    if (!entrada) return;
    setSessao([
      {
        id: entrada.id,
        // Reabertura do histórico: não veio de captura, então não tem candle
        // nem sincronismo — a ausência é declarada, não preenchida com zero.
        captureId: `hist_${entrada.id}`,
        capturedAt: entrada.at,
        candleTime: null,
        captureDelayMs: null,
        sync: null,
        analiseIniciadaEm: null,
        analiseConcluidaEm: entrada.at,
        desatualizada: false,
        imagem: entrada.thumb,
        analise: entrada.analysis,
        at: entrada.at,
        historyId: entrada.id,
        comparacao: null,
        reparos: [],
        // Reabertura de caso antigo: a memória daquela análise não foi
        // gravada na época — null honesto, o card simplesmente não aparece.
        memoria: null,
        // A máquina de setup também não rodou para este print antigo.
        setupInfo: null,
        zoom: null,
      },
    ]);
    setIndice(0);
    setErro(
      "Análise reaberta do histórico. A imagem é a miniatura guardada — uma reanálise pode diferir da original.",
    );
  }, []);

  const carregar = useCallback((file: File) => {
    setErro(null);
    if (!/^image\/(png|jpeg|jpg|webp)$/.test(file.type)) {
      setErro(`Formato não suportado (${file.type || "desconhecido"}). Use PNG, JPG ou WebP.`);
      return;
    }
    if (file.size > MAX_BYTES) {
      setErro(
        `Imagem de ${(file.size / 1_000_000).toFixed(1)} MB excede o limite de 12 MB. Recorte a área do gráfico.`,
      );
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setErro("Falha ao ler o arquivo.");
    reader.onload = () => {
      setPendente(String(reader.result));
      setSelecionada(null);
      setFeedbackUi(null);
    };
    reader.readAsDataURL(file);
  }, []);

  /*
   * CTRL+V EM QUALQUER LUGAR DA TELA.
   *
   * O ouvinte fica no documento, não num campo: o operador acabou de copiar do
   * Profit e cola sem clicar em caixa nenhuma. É o passo que faz o fluxo caber
   * em Ctrl+C → Ctrl+V.
   */
  useEffect(() => {
    const aoColar = (event: ClipboardEvent) => {
      const itens = event.clipboardData?.items;
      if (!itens) return;
      for (const item of itens) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            event.preventDefault();
            carregar(file);
            return;
          }
        }
      }
      if (event.clipboardData?.types.includes("text/plain")) {
        setErro("A área de transferência não tem imagem — copie o print do gráfico.");
      }
    };
    document.addEventListener("paste", aoColar);
    return () => document.removeEventListener("paste", aoColar);
  }, [carregar]);

  /*
   * FLUXO ÚNICO DE ANÁLISE — colar e capturar convergem AQUI.
   *
   * A captura inteligente NÃO tem um motor próprio: ela entrega a imagem a
   * esta mesma função, com o motivo do disparo. Dois motores para o mesmo
   * print é a doença que o pipeline visual já curou uma vez — não volta.
   *
   * `sessaoRef` existe porque a captura chama isto de FORA do render: a
   * comparação com o print anterior e o índice novo não podem depender de
   * closure velha (era exatamente o bug da versão anterior, que fazia
   * setPendente + executar na mesma chamada e analisava o estado antigo).
   */
  const sessaoRef = useRef<SessaoPrint[]>([]);
  sessaoRef.current = sessao;

  /*
   * MÁQUINA DE SETUP PERSISTENTE — a mesma oportunidade atravessa os prints.
   *
   * `setupRef` guarda o setup vivo FORA do render pela mesma razão do
   * `sessaoRef` logo acima: a captura de 60s chama a análise de fora do
   * React e não pode avançar a máquina sobre uma closure velha. `setupSeqRef`
   * é a sequência do dia no id T4-AAAA-MM-DD-XXX e SÓ cresce quando NASCE
   * setup novo — queimar número em passo que não criou nada quebraria o
   * rastreio do id. `setupInfo` espelha o ÚLTIMO passo no estado; o card de
   * cada print lê o passo guardado na própria sessão (a linha do tempo mostra
   * o passo DAQUELE print, não o mais recente) — o espelho vale para quem
   * precisar do estado vivo independente do print exibido.
   */
  const setupRef = useRef<TrackedSetup | null>(null);
  const setupSeqRef = useRef(0);

  /*
   * O CICLO DE VIDA DO CANDLE — decisão do operador de 20/08/2026.
   *
   * `relogioMercadoRef` guarda o relógio DO GRÁFICO; `livroRazaoRef` guarda
   * qual candle está em formação e quando o anterior fechou. Ambos em ref, e
   * não em estado, pela mesma razão do `setupRef`: o ciclo de 60s roda fora do
   * render e não pode julgar candle sobre uma closure velha.
   *
   * O relógio local continua existindo — como `capturedAt` e como a medida do
   * DESVIO entre os dois relógios. Ele só deixou de nomear candle.
   */
  const relogioMercadoRef = useRef(new MarketClock());
  const livroRazaoRef = useRef(emptyLedger());

  /*
   * A MEMÓRIA DA RÉGUA — o que permite não recalibrar do zero a cada print.
   *
   * Guarda a reta vigente, a moldura contra a qual ela foi calibrada e o
   * ativo. Em ref, e não em estado, pelo mesmo motivo do resto: a régua roda
   * fora do render, depois da tela, e não pode ler uma closure velha.
   */
  const reguaRef = useRef<ScaleMemory | null>(null);
  const [setupInfo, setSetupInfo] = useState<SetupUpdate | null>(null);

  /*
   * PRINT CONGELADO NA CONFIRMAÇÃO (§7).
   *
   * Quando a entrada é confirmada, o print DAQUELE instante — com a seta no
   * candle que confirmou, a linha da entrada e os preços — para de rolar: as
   * capturas de 60s continuam entrando na linha do tempo, mas a tela segura o
   * print da confirmação. É a diferença entre "vi o momento da entrada" e
   * "vi o gráfico um minuto depois, já sem o gatilho na tela".
   *
   * Solta sozinho quando surge setup NOVO, ou quando o setup atual é
   * invalidado/expira — "até surgir nova análise/setup válido". O operador
   * também solta na mão pelo botão VER ÚLTIMO. O ref existe porque a captura
   * automática decide isto FORA do render.
   */
  const congeladoRef = useRef<number | null>(null);
  const [congelado, setCongelado] = useState<number | null>(null);

  /**
   * A CAPTURA MAIS RECENTE — a régua do latest-wins (§5).
   *
   * Toda análise volta carregando o `captureId` de origem. Se ele não for
   * este, o resultado é histórico: entra na sessão marcado como
   * desatualizado, alimenta memória e aprendizado, e NÃO toca no estado
   * visual. Sem esta régua a análise lenta do candle anterior terminava
   * depois e reescrevia as linhas do print novo.
   */
  const captureAtualRef = useRef<string | null>(null);
  /** Setup restaurado do servidor — só para avisar o operador na tela. */
  const [setupRestaurado, setSetupRestaurado] = useState<string | null>(null);

  /*
   * RESTAURAÇÃO DO SETUP ATIVO (item 11 do aceite do operador).
   *
   * Reiniciar o backend, recarregar a página ou trocar de aba não pode apagar
   * uma oportunidade em curso: o servidor guarda o setup ABERTO e a tela o
   * traz de volta ao montar. A sequência do dia continua do id restaurado —
   * senão o próximo setup nasceria repetindo um número já usado.
   */
  useEffect(() => {
    let cancelado = false;
    void (async () => {
      try {
        const resposta = await fetch("/api/trading/setups?asset=WINFUT&open=1");
        if (!resposta.ok) return;
        const corpo = (await resposta.json()) as { setups?: SetupSalvo[] };
        const abertos = corpo.setups ?? [];
        if (abertos.length === 0 || cancelado) return;
        // O mais recente é o que vale: setups antigos abertos expiram sozinhos.
        const maisRecente = abertos.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
        setupRef.current = setupSalvoParaVivo(maisRecente);
        setupSeqRef.current = Math.max(setupSeqRef.current, sequenciaDoId(maisRecente.setupId));
        setSetupRestaurado(maisRecente.setupId);
      } catch {
        // Servidor fora: a tela começa sem setup, que é o estado honesto.
      }
    })();
    return () => {
      cancelado = true;
    };
  }, []);

  const analisarImagem = useCallback(
    async (imagem: string, captura: CaptureMeta | null = null): Promise<boolean> => {
      const emFundo = captura !== null;
      setErro(null);
      if (!emFundo) {
        // Fluxo MANUAL: o operador está olhando; o passo-a-passo faz sentido.
        setSelecionada(null);
        setFeedbackUi(null);
        setEtapa(0);
      } else {
        // Fluxo DE FUNDO: o print confirmado fica intacto na tela — inclusive
        // a marcação selecionada e o feedback aberto. Só o aviso acende.
        setAnaliseFundo(true);
      }
      const inicio = Date.now();
      /*
       * A ORIGEM É A CAPTURA, não o início da análise.
       *
       * Com a fila ocupada, o print espera antes de ser analisado. Medindo do
       * início da inferência, essa espera some do registro — e ela é a que
       * cresce em cascata quando uma análise ultrapassa o ciclo de 60s.
       * Imagem colada não passou pela fila: a captura é o próprio agora.
       */
      const relogio = new StageClock(captura?.capturedAt ?? inicio);
      relogio.marcarInicioDaAnalise();
      // Null em imagem colada: ela não veio do monitor e não tem candle.
      const captureId = captura?.captureId ?? null;
      if (captureId !== null) {
        setSessao((s) =>
          s.map((p) => (p.captureId === captureId ? { ...p, analiseIniciadaEm: inicio } : p)),
        );
      }
      const etapasTimer = emFundo
        ? null
        : setInterval(() => setEtapa((e) => (e < ETAPAS.length - 1 ? e + 1 : e)), 1_400);
      try {
        /*
         * Retry SÓ na captura automática: o operador manual tem o botão
         * TENTAR NOVAMENTE; o monitor precisa sobreviver a uma falha
         * transitória da IA sem ninguém na frente da tela.
         */
        const tentativas = captura === null ? 1 : 2;
        let r: Awaited<ReturnType<typeof analisar>> | null = null;
        for (let tentativa = 1; tentativa <= tentativas; tentativa += 1) {
          r = await analisar({ data: { imageDataUrl: imagem } });
          if (r.ok && r.analysis) break;
          if (tentativa < tentativas) {
            await new Promise((resolve) => setTimeout(resolve, 2_000));
          }
        }
        if (!r || !r.ok || !r.analysis) {
          setErro(r?.error ?? "A IA não devolveu uma análise válida.");
          return false;
        }
        let analise = r.analysis;
        let imagemAnalisada = imagem;
        let reparos = r.repairs;
        let notaDoZoom: string | null = null;

        /*
         * SEGUNDO PASSE COM RECORTE AMPLIADO (§13).
         *
         * Só quando a PRIMEIRA leitura saiu fraca por limitação da IMAGEM
         * (inconclusiva, escala ilegível, candle pequeno). Um "SEM_T4" limpo
         * não repete: reanalisar leitura boa é gastar GPU para reconfirmar o
         * já sabido. O relógio também manda — perto do fim do ciclo de 60s o
         * segundo passe atrasaria a captura seguinte, e a captura em dia vale
         * mais que uma leitura marginalmente melhor.
         */
        let passes: MetadadosDosPasses | null = null;
        const fraqueza = readingIsWeak(analise);
        /*
         * ORÇAMENTO DO CICLO (§5): não começar uma inferência que não cabe.
         *
         * A estimativa é o custo REAL do 1º passe desta mesma análise — a
         * melhor previsão disponível para o 2º, porque é o mesmo modelo, a
         * mesma máquina e um recorte da mesma imagem. Se não couber, entrega-se
         * a leitura do 1º passe e o próximo candle é capturado no horário:
         * captura em dia vale mais que leitura marginalmente melhor.
         */
        const sobrouTempo = cabeOutraInferencia({
          decorridoMs: Date.now() - inicio,
          cicloMs: CAPTURE_PERIOD_MS,
          duracaoEstimadaMs: r.visionMs ?? 20_000,
        });
        if (fraqueza.weak && sobrouTempo) {
          const recorte = await relogio.medir("crop", () => autoCropPrint(imagem));
          if (recorte !== null) {
            const segunda = await analisar({ data: { imageDataUrl: recorte.dataUrl } });
            relogio.registrar("vision2", segunda.visionMs ?? null);
            relogio.registrar("audit", segunda.auditMs ?? null);
            if (segunda.ok && segunda.analysis) {
              const escolha = chooseBetterReading(analise, segunda.analysis);
              passes = {
                motivos: fraqueza.motivos,
                scorePrimeiro: Math.round(readingScore(analise)),
                scoreSegundo: Math.round(readingScore(segunda.analysis)),
                escolhido: escolha.usarSegunda ? "SEGUNDO" : "PRIMEIRO",
                recorte: { ...recorte.window, scale: recorte.scale },
              };
              if (escolha.usarSegunda) {
                analise = segunda.analysis;
                imagemAnalisada = recorte.dataUrl;
                reparos = segunda.repairs;
              }
              // O passe é DITO nos dois casos: o operador precisa saber que a
              // imagem na tela é um recorte, ou que o recorte foi descartado.
              notaDoZoom = `${escolha.motivo}. Motivo do 2º passe: ${fraqueza.motivos.join("; ")}.`;
            }
          }
        }

        /*
         * LINHAS POSICIONADAS PELA RÉGUA, NÃO POR PALPITE DE PIXEL.
         *
         * A IA devolve os NÚMEROS (entrada/zona/stop/alvo/gatilho do plano —
         * só os legíveis); a escala do PRÓPRIO print é calibrada pelo mesmo
         * OCR-com-régua da operação ao vivo, e cada nível vira linha na
         * altura exata do preço. Palpite de pixel do modelo tem alongamento
         * sistemático — era por isso que as marcações caíam "perto".
         * Se a escala não calibrar, as marcações do modelo permanecem:
         * impreciso e avisado é melhor que nível sumido.
         */
        const temNivelLegivel =
          (analise.entry.visible && analise.entry.value !== null) ||
          (analise.stop.visible && analise.stop.value !== null) ||
          analise.targets.some((t) => t.visible && t.value !== null) ||
          analise.conditionalPlans.some(
            (p) => p.triggerLevel.visible && p.triggerLevel.value !== null,
          );
        /*
         * A régua serve DOIS consumidores: os níveis legíveis DESTE print e
         * a LINHA ROXA do setup persistente — que pode carregar um nível
         * herdado de prints anteriores mesmo quando este print não tem
         * número legível (por isso o `||` abaixo). `paraFracao` fica
         * guardado para o passo do setup reutilizar a MESMA calibração:
         * calibrar de novo seria pagar outra chamada de visão pelo mesmo
         * eixo. Null quando a régua não calibrou — e aí nível NÃO vira linha.
         */
        /*
         * A RÉGUA SAIU DO CAMINHO CRÍTICO — era uma INFERÊNCIA INTEIRA escondida.
         *
         * `calibratePrintImage` faz um OCR do eixo de preço: outra chamada de
         * visão, do mesmo tamanho da análise. Ela ficava entre a leitura pronta
         * e a tela, e era o maior pedaço de tempo que não tinha nome nos
         * registros — o operador esperava a análise que já existia enquanto o
         * modelo lia a escala de novo.
         *
         * Agora o painel aparece com a leitura (status, níveis, cards) e as
         * LINHAS chegam depois, quando a régua volta. A precisão não muda: a
         * linha continua sendo posicionada pela escala lida, nunca por palpite
         * de pixel — ela só não segura mais o resto da tela.
         */
        const precisaDeRegua =
          temNivelLegivel || (setupRef.current !== null && setupRef.current.entryLevel !== null);

        /*
         * COMPARAÇÃO AUTOMÁTICA COM O ANTERIOR — determinística.
         *
         * As duas análises já são dados validados; compará-las é código puro em
         * `printComparison`. Nenhum modelo participa: modelo comparando inventaria
         * mudanças plausíveis do mesmo jeito que inventaria preços.
         */
        // O anterior COM ANÁLISE — um print recém-capturado ainda sem leitura não
        // tem o que comparar, e compará-lo com null inventaria mudanças.
        const anterior = [...sessaoRef.current].reverse().find((p) => p.analise !== null) ?? null;
        const comparacao =
          anterior !== null ? comparePrintAnalyses(anterior.analise!, analise) : null;

        let historyId: string | null = null;
        try {
          historyId = (
            await saveToHistory(
              imagemAnalisada,
              analise,
              captura === null
                ? null
                : { motivo: captura.reason, code: captura.code, latencyMs: Date.now() - inicio },
            )
          ).entry.id;
        } catch {
          // Histórico é conveniência: falhar em salvá-lo não pode derrubar a análise.
        }

        /*
         * MEMÓRIA T4: o DNA amarra no histórico quando ele existe; o print
         * vira caso persistente SEMPRE (a etiqueta de preço dele fecha
         * vereditos anteriores). A consulta devolve a segunda opinião —
         * casos semelhantes, taxa histórica e confiança composta.
         */
        /*
         * FORA DO CAMINHO CRÍTICO (§2, §3).
         *
         * Persistir o print, gravar o DNA e consultar casos semelhantes são
         * três idas ao servidor. Esperá-las para só então mostrar a análise
         * fazia o operador aguardar tarefa que não muda a decisão do candle
         * atual — a memória é SEGUNDA opinião, não pré-requisito. Agora elas
         * correm soltas e, quando voltam, o card de memória aparece no print
         * a que pertence, achado por `captureId`.
         */
        const registroDna = historyId !== null ? montarDnaDoPrint(analise, historyId) : null;
        const idDoPrint = captureId;
        void persistirEConsultarMemoria(
          analise,
          registroDna,
          captura,
          imagemAnalisada,
          historyId,
          passes,
          reparos,
        ).then((memoriaTardia) => {
          if (memoriaTardia === null) return;
          setSessao((s) =>
            s.map((p) =>
              p.captureId === idDoPrint || (idDoPrint === null && p.analise === analise)
                ? { ...p, memoria: memoriaTardia }
                : p,
            ),
          );
        });
        const memoria: MemoriaPrint | null = null;

        /*
         * MÁQUINA DE SETUP PERSISTENTE — o passo desta análise.
         *
         * `Date.now()` aqui é o mesmo relógio legítimo do DNA: o print é a
         * decisão do agora. A sequência do dia SÓ incrementa quando o evento
         * anuncia nascimento ("NOVO SETUP …") — passo que não criou setup
         * não queima número do id T4-AAAA-MM-DD-XXX.
         */
        /*
         * A GUARDA VEM ANTES DA MÁQUINA — e antes era o contrário.
         *
         * O latest-wins existia, mas a máquina de setup já tinha avançado e
         * persistido quando ele era consultado: um resultado ATRASADO movia o
         * estágio, marcava o toque, gravava níveis no banco e disparava o
         * congelamento, enquanto a tela exibia "ANÁLISE TARDIA — NÃO APLICADA
         * AO ESTADO ATUAL". O selo dizia uma coisa e o código fazia outra.
         *
         * A máquina é ESTADO, não registro: avançá-la com a leitura de um
         * candle que já passou reescreve a oportunidade viva com dados velhos.
         * Histórico, DNA e memória continuam recebendo o resultado tardio —
         * eles são registro, e registro aceita o passado.
         */
        const ehAtual = resultadoGovernaTela({ captureId }, captureAtualRef.current);

        /*
         * PASSOS 3–7 DO FLUXO: identificar chartTime, comparar com o último,
         * atualizar ou FECHAR o candle anterior — antes de a máquina julgar.
         *
         * A ordem importa e é o ponto da decisão do operador: a T4 só roda
         * sobre candle CLOSED, então o livro-razão vem antes de `advanceSetup`,
         * nunca depois.
         */
        const agoraLocal = Date.now();
        /*
         * A confiança do relógio é binária de propósito. O modelo não pontua
         * essa leitura; quem pontua é o reparo de contrato, que já descartou
         * qualquer coisa sem forma de HH:MM (ver validatePrintAnalysis). Então
         * ou o horário passou no reparo e vale, ou é null e não vale.
         */
        relogioMercadoRef.current.update(
          {
            date: analise.chartClock.date,
            time: analise.chartClock.time,
            asset: analise.symbol,
            timeframe: analise.timeframe,
            confidence: analise.chartClock.time === null ? 0 : 1,
          },
          agoraLocal,
        );
        const relogioDoGrafico = relogioMercadoRef.current.snapshot();
        const periodoMs = analise.timeframe === null ? null : timeframeMs(analise.timeframe);
        /*
         * A identidade exige as TRÊS pernas: ativo, timeframe e horário do
         * gráfico. Faltando qualquer uma, `identity` é null e o livro-razão
         * para — em vez de completar a chave com o relógio local, que foi
         * medido errado em 18% das transições da sessão de 20/08.
         */
        const identidadeDoCandle =
          /*
           * `Number.isFinite` e nao so `!== null`: um relogio invalido rio acima
           * produzia NaN aqui, e NaN atravessava a condicao inteira sem ser
           * notado ate alguem formatar o instante e lancar. Derrubou producao
           * em 20/08/2026.
           */
          relogioDoGrafico.chartEpochAtRead !== null &&
          Number.isFinite(relogioDoGrafico.chartEpochAtRead) &&
          analise.symbol !== null &&
          analise.timeframe !== null &&
          periodoMs !== null
            ? {
                asset: analise.symbol,
                timeframe: analise.timeframe,
                chartTime: Math.floor(relogioDoGrafico.chartEpochAtRead / periodoMs) * periodoMs,
              }
            : null;

        const lido = (n: { value: number | null; visible: boolean }) =>
          n.visible ? n.value : null;

        /*
         * O CANDLE FECHADO — GEOMETRIA PRIMEIRO, MODELO COMO RESERVA.
         *
         * Medido em produção em 20/08/2026: o modelo devolveu
         * `lastClosedCandle` em ZERO de 25 análises reais, enquanto lia o
         * relógio do gráfico em 18 das mesmas 25. Relógio é etiqueta de texto;
         * OHLC de candle é geometria. Cada um erra onde o outro acerta.
         *
         * A geometria depende da RÉGUA, e a régua vem do cache — que na
         * primeira análise da sessão ainda está vazio. Nesse print não há
         * extração, e também não há candle anterior para fechar: os dois
         * silêncios coincidem, e nenhum deles inventa nada.
         */
        const reguaVigente = reguaRef.current;
        const geometria =
          reguaVigente !== null && reguaVigente.state.calibration.usable
            ? await relogio.medir("candle", () =>
                lerCandleFechadoPorPixels(
                  imagemAnalisada,
                  reguaVigente.state.calibration,
                  captura?.chartBounds ?? null,
                  agoraLocal,
                ),
              )
            : null;

        const doModelo: CandleOhlc | null =
          analise.lastClosedCandle === null
            ? null
            : {
                open: lido(analise.lastClosedCandle.open),
                high: lido(analise.lastClosedCandle.high),
                low: lido(analise.lastClosedCandle.low),
                close: lido(analise.lastClosedCandle.close),
              };

        /*
         * DUAS FONTES PARA O MESMO NÚMERO PEDEM COMPARAÇÃO, e não escolha
         * silenciosa. Enquanto o modelo não responder, `divergencia` é null e
         * isso é honesto: não há o que comparar.
         */
        const divergencia = divergenciaDeFechamento(
          geometria?.ohlc ?? null,
          doModelo,
          breakoutTolerance(lido(analise.currentPrice) ?? 0, analise.symbol),
        );
        if (divergencia !== null && divergencia > 0) {
          console.warn(
            `[T4] fechamento DIVERGE: geometria ${geometria?.ohlc.close} x modelo ${doModelo?.close}` +
              ` — ${divergencia.toFixed(1)} pontos. Vale a GEOMETRIA.`,
          );
        }

        const passoDoCandle = observeCandle(livroRazaoRef.current, {
          identity: identidadeDoCandle,
          capturedAt: agoraLocal,
          price: lido(analise.currentPrice),
          previousOhlc:
            geometria !== null
              ? { ohlc: geometria.ohlc, reader: "GEOMETRIA" }
              : doModelo !== null
                ? { ohlc: doModelo, reader: "MODELO" }
                : null,
        });
        livroRazaoRef.current = passoDoCandle.state;

        /*
         * A observação só é emitida quando o livro-razão a PROVOU. `null` aqui
         * é o que impede a máquina de rompimento de andar — e o motivo viaja
         * junto para a tela dizer o que está esperando.
         */
        const fechado = passoDoCandle.justClosed;
        const observacaoDoCandle: CandleObservation | null =
          passoDoCandle.podeConfirmar && fechado !== null && fechado.ohlc.close !== null
            ? {
                close: fechado.ohlc.close,
                high: fechado.ohlc.high,
                low: fechado.ohlc.low,
                candleTime: fechado.identity.chartTime,
                at: agoraLocal,
                phase: fechado.phase,
                closeSource: fechado.closeSource,
              }
            : null;

        const setupAnterior = setupRef.current;
        const passoSetup = advanceSetup(
          setupAnterior,
          analise,
          Date.now(),
          setupSeqRef.current + 1,
          {
            candle: observacaoDoCandle,
            candleReason: observacaoDoCandle === null ? passoDoCandle.reason : null,
            /*
             * O ATIVO VEM DA LEITURA — o rompimento precisa do tick REAL.
             *
             * Sem ele o rompimento cai numa fração genérica do preço, e a
             * tolerância de 1 tick do §15 vira uma tolerância inventada: no
             * WINFUT o tick é 5 pontos, e uma fração percentual do preço dá
             * ordem de grandeza diferente disso.
             */
            symbol: analise.symbol ?? null,
            /*
             * §7 — O CORTE VEM DA CAPTURA, medido nos pixels dela.
             *
             * Não é remedido aqui: a captura já leu o bitmap uma vez, na faixa
             * geométrica do gráfico, e ler de novo daria a MESMA resposta por
             * um segundo decode. Print manual (sem captura) não traz a medida,
             * e aí a máquina segue sem ela — ausência não vira acusação.
             */
            clipping:
              captura !== null && captura.clipping.clipped
                ? { clipped: true, reason: captura.clipping.reason }
                : null,
          },
        );
        /*
         * A LINHA QUE PROVA O CICLO — pedida pelo operador em 20/08/2026:
         *
         *   "FORMING 10:31 → novo chartTime 10:32 → 10:31 CLOSED →
         *    confirmação T4 calculada → entrada/não entrada com motivo objetivo"
         *
         * Sai no console porque é ferramenta de VALIDAÇÃO da sessão real, não
         * painel: o operador roda 20–30 min com o console aberto e confere a
         * sequência. O texto do ciclo vem de `ledgerLogLine`, junto da máquina
         * que produz os fatos; só o desfecho da T4 é concatenado aqui.
         *
         * `clockOffsetMs` entra na mesma linha porque é o número que responde
         * "os dois relógios estão brigando?" — e ele é DIAGNÓSTICO, nunca
         * insumo de decisão.
         */
        const desvioDeRelogio =
          relogioDoGrafico.chartEpochAtRead === null || relogioDoGrafico.readAtLocal === null
            ? null
            : relogioDoGrafico.readAtLocal - relogioDoGrafico.chartEpochAtRead;
        /*
         * O REGISTRO DA SESSÃO — a lista que o operador pediu para a validação
         * de 20–30 min, um objeto por análise.
         *
         * JSON numa linha só, com prefixo fixo, porque a sessão precisa ser
         * CONTADA depois e não lembrada: o operador copia o console e a
         * pergunta "em quantos prints o modelo devolveu `lastClosedCandle`?"
         * vira um `grep` mais um `filter`, não uma impressão.
         *
         * `null` em qualquer campo significa NÃO MEDIDO neste print — nunca
         * zero, nunca ausência de chave. Contar ausência é metade do objetivo
         * desta sessão.
         *
         * Ele é preenchido em DOIS momentos porque a régua roda depois da tela
         * (de propósito, ver o comentário do refinamento). A emissão fica com
         * quem escreve por último.
         */
        const registroDaSessao: Record<string, unknown> = {
          frameId: captureId ?? "manual",
          /*
           * TODO instante do registro passa por `instante()`: um campo de log
           * nao pode lancar. Foi exatamente assim que a analise inteira caiu.
           */
          capturedAt: captura === null ? null : instante(captura.capturedAt),
          chartTime: identidadeDoCandle === null ? null : instante(identidadeDoCandle.chartTime),
          chartClockSource: relogioDoGrafico.source,
          clockOffsetMs: desvioDeRelogio,
          lastClosedCandle: analise.lastClosedCandle === null ? "AUSENTE" : "RETORNADO",
          // A pergunta que a sessão veio contar: qual das duas vias respondeu.
          leitorDoFechamento: passoDoCandle.justClosed?.closeSource ?? null,
          geometriaCandlesVisiveis: geometria?.candlesVisiveis ?? null,
          geometriaQualidade: geometria?.quality ?? null,
          divergenciaFechamento: divergencia,
          ohlcLido:
            analise.lastClosedCandle === null
              ? null
              : {
                  time: analise.lastClosedCandle.time,
                  open: analise.lastClosedCandle.open.value,
                  high: analise.lastClosedCandle.high.value,
                  low: analise.lastClosedCandle.low.value,
                  close: analise.lastClosedCandle.close.value,
                },
          confiancaLeitura: analise.confidence,
          ledgerEvent: passoDoCandle.event,
          candlesNaoObservados: passoDoCandle.missed,
          podeConfirmar: passoDoCandle.podeConfirmar,
          trigger: passoSetup.setup?.trigger ?? null,
          stage: passoSetup.setup?.stage ?? "NONE",
          entradaConfirmada: passoSetup.entradaConfirmada,
          operacaoLiberada: passoSetup.operacaoLiberada,
          blockers: passoSetup.pendencias,
          // Preenchidos pela régua, que roda depois da tela.
          chartBounds: null as unknown,
          priceScale: null as unknown,
          scaleDrift: null as unknown,
          roiStatus: null as unknown,
          clippingStatus: null as unknown,
        };

        console.info(
          `[T4] ${ledgerLogLine(passoDoCandle, (t) => new Date(t).toLocaleTimeString("pt-BR", HORA_MINUTO))}` +
            ` → ${passoSetup.entradaConfirmada ? "ENTRADA CONFIRMADA" : "SEM ENTRADA"}` +
            ` (${passoSetup.pendencias[0] ?? passoSetup.headline})` +
            ` · relógio: ${relogioDoGrafico.source}${desvioDeRelogio === null ? "" : `, desvio ${Math.round(desvioDeRelogio / 1000)}s`}`,
        );

        /*
         * O sinal primário de nascimento é o evento "NOVO SETUP …" — mas um
         * setup pode nascer JÁ tocando a entrada, e aí o mesmo passo troca o
         * evento por TOQUE_SEM_CONFIRMACAO/CONFIRMADO/BLOQUEADO_NO_GATE. Por
         * isso o id inédito também conta como nascimento: sem ele a sequência
         * não cresceria e o PRÓXIMO nascimento repetiria o número do id.
         */
        const nasceuSetup =
          (passoSetup.event !== null && passoSetup.event.startsWith("NOVO SETUP")) ||
          (passoSetup.setup !== null && passoSetup.setup.setupId !== setupAnterior?.setupId);
        if (ehAtual) {
          if (nasceuSetup) {
            setupSeqRef.current += 1;
          }
          setupRef.current = passoSetup.setup;
          setSetupInfo(passoSetup);

          // O setup vai para o servidor a cada passo: é o que sobrevive ao
          // restart e o que deixa o desfecho (WIN/LOSS/EXPIRADO) fechar sozinho.
          if (passoSetup.setup !== null) {
            persistirSetup(passoSetup.setup, analise, historyId);
          }
        }

        /*
         * LATEST-WINS (§5) — a régua que impede "imagem #74 com análise #73".
         *
         * Enquanto esta análise rodava, o candle pode ter virado e uma captura
         * mais nova já estar na tela. Nesse caso o resultado NÃO é jogado
         * fora: ele foi uma leitura real de um candle real, vai para o
         * histórico, para o DNA e para a memória — mas não governa mais o que
         * o operador vê. Nada de trocar linhas, ação ou congelamento.
         */
        /*
         * §8 — a série observada vem da própria leitura. Trocar de ativo ou
         * timeframe reseta a referência de candle do monitor; sem isso a
         * primeira captura da série nova seria engolida como duplicata só por
         * cair no mesmo minuto de relógio da anterior.
         */
        marketMonitor.setSeries(analise.symbol ?? "WINFUT", analise.timeframe ?? "1Min");

        const concluidaEm = Date.now();

        const dadosDaAnalise = {
          // A imagem guardada é a que gerou as coordenadas das marcações —
          // exibir o print inteiro com marcações do recorte desalinharia tudo.
          imagem: imagemAnalisada,
          analise,
          historyId,
          comparacao,
          reparos,
          memoria,
          setupInfo: ehAtual ? passoSetup : null,
          zoom: notaDoZoom,
          analiseConcluidaEm: concluidaEm,
          desatualizada: !ehAtual,
        };

        let indiceDoPrint = -1;
        setSessao((s) => {
          const posicao = captureId === null ? -1 : s.findIndex((p) => p.captureId === captureId);
          if (posicao >= 0) {
            indiceDoPrint = posicao;
            const proxima = [...s];
            proxima[posicao] = { ...proxima[posicao]!, ...dadosDaAnalise };
            return proxima;
          }
          // Imagem colada/arquivo: não passou pelo monitor, então a entrada
          // nasce aqui mesmo, já com a análise.
          indiceDoPrint = s.length;
          const manual: SessaoPrint = {
            id: `sess_${concluidaEm}`,
            captureId: captureId ?? `manual_${concluidaEm}`,
            capturedAt: inicio,
            candleTime: null,
            captureDelayMs: null,
            sync: null,
            analiseIniciadaEm: inicio,
            at: concluidaEm,
            ...dadosDaAnalise,
          };
          return [...s, manual];
        });

        if (!ehAtual) {
          // Resultado antigo: fica registrado e visível na linha do tempo,
          // mas a máquina de setup e o congelamento não são tocados.
          return true;
        }

        /*
         * §7 — congela na confirmação, solta quando a oportunidade vira outra.
         * Sem entrada confirmada NADA congela: viés em evolução tem de mostrar
         * sempre o print mais fresco.
         */
        const congelarEm = decidirCongelamento({
          congeladoEm: congeladoRef.current,
          novoIndice: indiceDoPrint,
          passo: passoSetup,
          nasceuSetup,
        });
        congeladoRef.current = congelarEm;
        setCongelado(congelarEm);
        if (indiceDoPrint >= 0) setIndice(congelarEm ?? indiceDoPrint);

        /*
         * O ATRASO PASSA A TER ENDEREÇO (§1).
         *
         * Uma linha por análise, com o captureId e o custo de cada estágio.
         * Sem isto, uma leitura de dois minutos era indistinguível de outra:
         * não dava para saber se o tempo foi da visão, do 2º passe, do
         * auditor ou da régua — e a única reação possível era aumentar
         * timeout, que é esconder o problema.
         */
        relogio.registrar("vision1", r.visionMs ?? null);
        relogio.contarRetry(r.retryCount ?? 0);
        relogio.registrar("audit", r.auditMs ?? null);
        relogio.marcarUiSolicitada();
        // A UI PINTOU: medido por frame, não por setState — entre pedir e
        // pintar existe o render, e é ele que o operador enxerga.
        requestAnimationFrame(() => relogio.marcarUiPintada());

        /*
         * REFINAMENTO PELA RÉGUA — depois da tela, nunca antes dela.
         *
         * Aqui rodam a calibração da escala (uma inferência) e o
         * reposicionamento das linhas, incluindo a LINHA ROXA da entrada. O
         * painel já está preenchido; o que chega agora é PRECISÃO GEOMÉTRICA,
         * e ela nunca foi o que segura a decisão — o número da entrada já está
         * no card SETUP T4 desde o primeiro instante.
         */
        if (precisaDeRegua) {
          void (async () => {
            const t0 = Date.now();
            /*
             * A RÉGUA PASSA A TER MEMÓRIA (decisão do operador, 20/08).
             *
             * Antes, `calibratePrintImage` rodava em TODO print: uma inferência
             * de visão sobre o eixo, uma reta nova do zero, e nenhuma
             * verificação de que ela concordava com a anterior. O resultado
             * medido na sessão real foi a linha de entrada caindo de 121 a 774
             * pontos fora do lugar — com o MESMO nível 170.925 desenhado em
             * três alturas diferentes nos prints 070, 071 e 082, todos com o
             * mesmo intervalo visível.
             *
             * Agora a geometria decide primeiro, de graça: a moldura do gráfico
             * já vem medida na captura. Igual à da régua vigente e dentro do
             * prazo ⇒ reusa. Mudou, sumiu, trocou de ativo ou venceu ⇒ relê.
             */
            const molduraDaCaptura = captura?.chartBounds ?? null;
            const plano = planScale(
              reguaRef.current,
              { chartBounds: molduraDaCaptura, asset: analise.symbol },
              t0,
            );

            let memoria = reguaRef.current;
            let drift: number | null = null;

            if (plano.recalibrate) {
              const escala = await relogio.medir("scale", () =>
                calibratePrintImage(
                  // A régua tem de ser a da imagem ANALISADA: se o 2º passe
                  // venceu, as coordenadas são as do recorte.
                  imagemAnalisada,
                  analise.symbol ?? "WINFUT",
                  calibrarEscala,
                ),
              );
              if (!escala.ok || escala.calibration === null) {
                /*
                 * REPARO DECLARADO, e não um `return` mudo.
                 *
                 * A régua falhou: as marcações que ficarem na tela são palpite
                 * de pixel do modelo, não posição por escala lida. Sem esta
                 * linha o operador vê linha nenhuma e não sabe se é porque não
                 * havia nível ou porque a régua não calibrou.
                 */
                reguaRef.current = null;
                console.warn(
                  `[T4] régua NÃO calibrou (${plano.decision}): ${escala.reason} — ` +
                    "níveis sem posição confiável neste print",
                );
                return;
              }
              /*
               * `revalidate` confronta a reta VIGENTE com os rótulos recém
               * lidos e devolve o desvio. É a "inconsistência entre preço
               * previsto e posição Y" que o operador pediu — e ela só pode ser
               * medida quando há leitura nova, que é por isso que a
               * revalidação de rotina existe.
               */
              const anterior = memoria?.state ?? EMPTY_PRICE_SCALE;
              const ancoras = escala.calibration.anchors;
              const revalidado = revalidate(anterior, ancoras, t0);
              drift =
                anterior.calibration.usable && ancoras.length > 0
                  ? calibrationDrift(anterior.calibration, ancoras).maxDriftPx
                  : null;
              memoria = {
                state: revalidado,
                bounds: molduraDaCaptura,
                asset: analise.symbol,
                frameHeight: escala.frameHeight,
              };
              reguaRef.current = memoria;
            }

            if (memoria === null || !memoria.state.calibration.usable) return;
            const calibracao = memoria.state.calibration;
            const alturaFrame = memoria.frameHeight;

            /*
             * A TELEMETRIA QUE A SESSÃO REAL VAI CONTAR (lista do operador).
             *
             * Vai para o console junto do resto do ciclo, para a sessão de
             * 20–30 min poder ser medida depois em vez de lembrada.
             */
            const telemetria: ScaleTelemetry = {
              priceScale: memoria.state.pricePerPixel,
              priceScaleConfidence: memoria.state.priceConfidence,
              scaleDrift: drift,
              lastCalibrationAt: memoria.state.lastScaleUpdate,
              needsRefresh: plano.recalibrate,
              decision: plano.decision,
              reason: plano.reason,
              chartBounds:
                molduraDaCaptura === null || !molduraDaCaptura.usable
                  ? null
                  : {
                      x: molduraDaCaptura.x,
                      y: molduraDaCaptura.y,
                      width: molduraDaCaptura.width,
                      height: molduraDaCaptura.height,
                    },
              roiStatus: molduraDaCaptura?.reason ?? "moldura não medida nesta captura",
              clippingStatus:
                captura === null
                  ? "sem captura"
                  : captura.clipping.avaliavel
                    ? captura.clipping.clipped
                      ? captura.clipping.reason
                      : "enquadramento íntegro"
                    : "corte não avaliável",
            };
            registroDaSessao.chartBounds = telemetria.chartBounds;
            registroDaSessao.priceScale = telemetria.priceScale;
            registroDaSessao.priceScaleConfidence = telemetria.priceScaleConfidence;
            registroDaSessao.scaleDrift = telemetria.scaleDrift;
            registroDaSessao.scaleDecision = telemetria.decision;
            registroDaSessao.roiStatus = telemetria.roiStatus;
            registroDaSessao.clippingStatus = telemetria.clippingStatus;
            console.info(`[T4-SESSAO] ${JSON.stringify(registroDaSessao)}`);
            console.info(
              `[T4] régua ${telemetria.decision} — ${telemetria.reason}` +
                ` · confiança ${telemetria.priceScaleConfidence}%` +
                ` · drift ${telemetria.scaleDrift === null ? "—" : `${telemetria.scaleDrift.toFixed(1)}px`}` +
                ` · roi ${telemetria.roiStatus}` +
                ` · corte ${telemetria.clippingStatus}`,
            );
            const paraFracao = (preco: number) => priceToFraction(calibracao, alturaFrame, preco);

            const calibradas = buildPriceAnnotations(analise, paraFracao);
            let anotacoes = mergeCalibratedAnnotations(analise.annotations, calibradas);
            const linhaSetup = construirLinhaDoSetup(passoSetup, paraFracao);
            if (linhaSetup !== null) {
              anotacoes = [
                ...anotacoes.filter((a) => a.kind !== "ENTRY_LINE" && a.kind !== "ENTRY_ZONE"),
                linhaSetup,
              ];
            }
            const refinada: PrintAnalysis = { ...analise, annotations: anotacoes };
            setSessao((s) =>
              s.map((item) =>
                item.captureId === idDoPrint ? { ...item, analise: refinada } : item,
              ),
            );
            console.info(`[t4] ${captureId ?? "manual"} régua concluída em ${Date.now() - t0}ms`);
          })();
        } else {
          /*
           * SEM RÉGUA NESTE PRINT, o registro sai mesmo assim.
           *
           * Um print que some da contagem por não ter nível legível
           * enviesaria a estatística da sessão justamente para o lado
           * otimista: some quem tinha menos evidência.
           */
          console.info(`[T4-SESSAO] ${JSON.stringify(registroDaSessao)}`);
        }
        const tempos = relogio.snapshot();
        const conta = decompor(tempos);
        console.info(
          formatarTempos(captureId ?? "manual", tempos) +
            ` auditor=${r.auditMode ?? "—"}` +
            ` fraca=${fraqueza.weak}` +
            ` passe2=${passes === null ? "nao" : passes.escolhido}` +
            ` capturadoEm=${new Date(inicio).toISOString()}`,
        );
        if (conta.residuoSuspeito) {
          // Resíduo grande = etapa no caminho crítico que ninguém cronometra.
          console.warn(
            `[t4] ${captureId ?? "manual"} RESIDUO SEM ESTAGIO: ${conta.residuoMs}ms ` +
              `(ui=${conta.totalUntilUiMs}ms, estagios=${conta.somaDosEstagiosMs}ms) — investigar.`,
          );
        }
        // Só limpa o pendente se foi ELE o analisado: a captura automática não
        // pode descartar um print que o operador colou e ainda não rodou.
        setPendente((p) => (p === imagem ? null : p));
        // A seleção e o feedback pertenciam ao print ANTERIOR — atravessar a
        // troca faria a marcação de um print aparecer sobre o outro.
        setSelecionada(null);
        setFeedbackUi(null);
        setModo("ANALISADO");

        /*
         * AUDITOR ADIADO (§4) — soberano, mas depois da tela.
         *
         * Quando a análise só descreve viés, o auditor não segurou a leitura;
         * ele roda agora, em segundo plano. Se ele VETAR a direção, o card é
         * corrigido — inclusive rebaixando a direção para NEUTRO, porque o
         * servidor reaplica a trava com o carimbo na mão. O que ele nunca faz
         * é LIBERAR entrada: para isso ele já teria sido bloqueante.
         */
        if (r.auditMode === "ADIADO") {
          void auditar({ data: { imageDataUrl: imagemAnalisada, analysis: analise } })
            .then((veredito) => {
              if (!veredito.ok || veredito.analysis === undefined) return;
              const auditada = veredito.analysis;
              setSessao((s) =>
                s.map((p) =>
                  p.captureId === idDoPrint
                    ? { ...p, analise: auditada, reparos: [...p.reparos, ...veredito.repairs] }
                    : p,
                ),
              );
              console.info(
                `[t4] ${captureId ?? "manual"} auditor adiado concluído em ${veredito.auditMs}ms`,
              );
            })
            .catch(() => {
              // Auditor caído não derruba análise válida — ela fica sem carimbo.
            });
        }
        return true;
      } catch (problema) {
        setErro(problema instanceof Error ? problema.message : String(problema));
        return false;
      } finally {
        if (etapasTimer !== null) clearInterval(etapasTimer);
        if (emFundo) setAnaliseFundo(false);
        else setEtapa(-1);
      }
    },
    // `calibrarEscala` entra na lista: ele É usado aqui dentro, e omiti-lo
    // deixaria o monitor de 60s chamando uma versão velha da server function.
    [analisar, calibrarEscala],
  );

  const [baixando, setBaixando] = useState(false);

  /** Nome do arquivo: número na sessão + hora + setupId quando houver. */
  const nomeDoPrint = useCallback((item: SessaoPrint, indice1: number): string => {
    const hora = new Date(item.at)
      .toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
      .replace(":", "-");
    const setup = item.setupInfo?.setup?.setupId ? "_" + item.setupInfo.setup.setupId : "";
    return "print_" + String(indice1).padStart(3, "0") + "_" + hora + setup + ".png";
  }, []);

  /** Lado da seta no PNG exportado — null enquanto a entrada não foi liberada. */
  const ladoDaSeta = useCallback((item: SessaoPrint): "COMPRA" | "VENDA" | null => {
    // Print ainda sem análise não desenha seta nenhuma.
    if (item.analise === null || item.analise.direction === "NEUTRO") return null;
    return entradaLiberada(item.analise, item.setupInfo) ? item.analise.direction : null;
  }, []);

  const baixarAtual = useCallback(async () => {
    const item = sessaoRef.current[indice] ?? null;
    if (item === null) return;
    setBaixando(true);
    try {
      const blob = await renderAnnotatedPrint(
        item.imagem,
        item.analise?.annotations ?? [],
        ladoDaSeta(item),
      );
      triggerDownload(blob, nomeDoPrint(item, indice + 1));
    } catch (problema) {
      setErro(problema instanceof Error ? problema.message : String(problema));
    } finally {
      setBaixando(false);
    }
  }, [indice, ladoDaSeta, nomeDoPrint]);

  /** Sessão inteira num .zip (store — PNG já é comprimido). */
  const baixarSessao = useCallback(async () => {
    if (sessaoRef.current.length === 0) return;
    setBaixando(true);
    try {
      const entradas = [];
      for (let i = 0; i < sessaoRef.current.length; i += 1) {
        const item = sessaoRef.current[i]!;
        const blob = await renderAnnotatedPrint(
          item.imagem,
          item.analise?.annotations ?? [],
          ladoDaSeta(item),
        );
        entradas.push({
          name: nomeDoPrint(item, i + 1),
          data: new Uint8Array(await blob.arrayBuffer()),
        });
      }
      const zip = buildZipStore(entradas, Date.now());
      triggerDownload(new Blob([zip], { type: "application/zip" }), "sessao_t4.zip");
    } catch (problema) {
      setErro(problema instanceof Error ? problema.message : String(problema));
    } finally {
      setBaixando(false);
    }
  }, [ladoDaSeta, nomeDoPrint]);

  const executar = useCallback(async () => {
    const imagem = pendente ?? atual?.imagem;
    if (!imagem) return;
    await analisarImagem(imagem, null);
  }, [analisarImagem, atual, pendente]);

  /*
   * O monitor de 60s vive FORA do React (singleton) e sobrevive a esta
   * página; o que ele precisa daqui é o fluxo de análise. O registro é
   * re-feito a cada render relevante para nunca apontar para closure velha.
   */
  useEffect(() => {
    marketMonitor.setAnalyzer(analisarImagem);
    // DESREGISTRO NO UNMOUNT (B8): a closure desta tela não pode sobreviver
    // a ela — o monitor declara "análise indisponível" até a tela voltar.
    return () => marketMonitor.setAnalyzer(null);
  }, [analisarImagem]);

  /**
   * A IMAGEM ENTRA NA TELA NO INSTANTE DA CAPTURA (§4).
   *
   * Este gancho dispara ANTES da fila de análise. É o que separa "o print
   * apareceu" de "a IA terminou": com a GPU lenta, a análise do candle
   * anterior ainda está rodando quando o candle novo chega, e antes disto a
   * tela ficava presa no print velho até a fila girar. Agora a imagem é
   * sempre a mais nova; a análise alcança depois e só é aplicada se ainda
   * pertencer a ela.
   */
  useEffect(() => {
    marketMonitor.setOnCapture((imagem, meta) => {
      captureAtualRef.current = meta.captureId;
      const entrada: SessaoPrint = {
        id: meta.captureId,
        captureId: meta.captureId,
        imagem,
        analise: null,
        at: meta.capturedAt,
        capturedAt: meta.capturedAt,
        candleTime: meta.candleTime,
        captureDelayMs: meta.captureDelayMs,
        sync: meta.sync,
        analiseIniciadaEm: null,
        analiseConcluidaEm: null,
        desatualizada: false,
        historyId: null,
        comparacao: null,
        reparos: [],
        memoria: null,
        setupInfo: null,
        zoom: null,
      };
      setSessao((s) => {
        const proxima = [...s, entrada];
        // Congelado mostra a EVIDÊNCIA da entrada; a captura continua e a
        // linha do tempo cresce por baixo (§12). Sem congelamento, a tela
        // acompanha sempre o print mais novo.
        if (congeladoRef.current === null) setIndice(proxima.length - 1);
        return proxima;
      });
      setPendente(null);
      setSelecionada(null);
    });
    // DESREGISTRO NO UNMOUNT (B8) — mesmo contrato do analisador acima.
    return () => marketMonitor.setOnCapture(null);
  }, []);

  const limparTudo = () => {
    setSessao([]);
    setIndice(-1);
    setPendente(null);
    setErro(null);
    setSelecionada(null);
    setFeedbackUi(null);
    congeladoRef.current = null;
    setCongelado(null);
  };

  /** Solta o congelamento e volta para o print mais recente da sessão. */
  const verUltimo = () => {
    congeladoRef.current = null;
    setCongelado(null);
    setIndice(sessaoRef.current.length - 1);
    setPendente(null);
    setSelecionada(null);
  };

  const registrarFeedback = (verdict: PrintFeedback["verdict"], reasons: string[]) => {
    if (atual?.historyId) {
      setHistoryFeedback(atual.historyId, { verdict, reasons, at: Date.now() });
    }
    setFeedbackUi("REGISTRADO");
  };

  const alternarCamada = (kind: string) => {
    setOcultas((atualSet) => {
      const proxima = new Set(atualSet);
      if (proxima.has(kind)) proxima.delete(kind);
      else proxima.add(kind);
      return proxima;
    });
  };

  /**
   * O LADO LIBERADO, calculado UMA vez: ele governa a seta no gráfico, o PNG
   * exportado e a lista de CAMADAS. Duplicar a expressão faria as três
   * discordarem no primeiro ajuste.
   */
  const ladoVisivel = useMemo<"COMPRA" | "VENDA" | null>(() => {
    if (analiseVisivel === null) return null;
    if (analiseVisivel.direction !== "COMPRA" && analiseVisivel.direction !== "VENDA") return null;
    return entradaLiberada(analiseVisivel, atual?.setupInfo ?? null)
      ? analiseVisivel.direction
      : null;
  }, [analiseVisivel, atual]);

  /*
   * A lista de CAMADAS obedece à MESMA lei do desenho. Sem isto sobrava um
   * botão "CONFIRMATION_CANDLE" aceso na barra — afirmando que a confirmação
   * existe, ao lado de um card dizendo AGUARDANDO — e morto: clicar não muda
   * nada, porque o overlay já tinha descartado a marcação antes do filtro.
   */
  const tipos = useMemo(
    () => [
      ...new Set(
        (analiseVisivel?.annotations ?? [])
          .filter((a) => podeDesenharAnotacao(a, ladoVisivel))
          .map((a) => a.kind),
      ),
    ],
    [analiseVisivel, ladoVisivel],
  );

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">Analisar Print</h1>
          <p className="text-xs text-muted-foreground">
            Selecione a janela do Profit uma vez — a cada 60 segundos um print real é capturado e
            analisado, automaticamente. A leitura é da imagem; nada além dela é lido da sua máquina.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button asChild size="sm" variant="outline" className="font-mono text-xs">
            <Link to="/historico-prints">
              <History className="mr-1 h-3.5 w-3.5" />
              HISTÓRICO
            </Link>
          </Button>
          <Badge variant="outline" className="font-mono">
            NEXUS T4
          </Badge>
        </div>
      </header>

      {erro !== null && (
        <Card className="flex flex-wrap items-center gap-3 border-bear/60 bg-bear/10 p-3">
          <p className="text-xs text-bear">{erro}</p>
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => void executar()}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            TENTAR NOVAMENTE
          </Button>
        </Card>
      )}

      {/* LINHA DO TEMPO DA SESSÃO: PRINT #1 → #2 → …, qualquer um reabrível. */}
      {sessao.length > 0 && (
        <Card className="flex flex-wrap items-center gap-1.5 border-border/70 bg-panel p-2">
          <span className="nexus-eyebrow mr-1">SESSÃO</span>
          {sessao.map((p, i) => (
            <Button
              key={p.id}
              size="sm"
              variant={i === indice && pendente === null ? "default" : "outline"}
              className="h-6 font-mono text-[10px]"
              onClick={() => {
                setIndice(i);
                setPendente(null);
                setSelecionada(null);
              }}
            >
              {/* O horário é o do CANDLE, não o da análise: #075 10:45 tem de
                  bater com o candle 10:45 que o operador vê no Profit. */}
              #{String(i + 1).padStart(3, "0")} {horaDoCandle(p)} →{" "}
              {p.analise === null
                ? "ANALISANDO…"
                : p.desatualizada
                  ? `${PRINT_STATUS_LABEL[p.analise.status]} (tardia)`
                  : PRINT_STATUS_LABEL[p.analise.status]}
            </Button>
          ))}
          {pendente !== null && (
            <span className="font-mono text-[10px] text-amber-500">
              + novo print aguardando análise
            </span>
          )}
        </Card>
      )}

      {/* Setup que sobreviveu ao reinício: o operador precisa saber que a
          oportunidade na tela vem de antes desta sessão de navegador. */}
      {setupRestaurado !== null && (
        <Card className="border-border/70 bg-panel p-2">
          <p className="font-mono text-[11px] text-muted-foreground">
            SETUP ATIVO RESTAURADO DO SERVIDOR — {setupRestaurado}. A contagem de prints desta tela
            recomeça do zero; o estágio, os níveis e a confirmação vieram do banco.
          </p>
        </Card>
      )}

      {/* CAPTURA CONTÍNUA — um print real a cada 60s, decisão do operador.
          O ciclo vive no marketMonitor (singleton); aqui só o rosto. */}
      <ScreenCapturePanel />

      {imagemVisivel === null ? (
        <Card
          className="flex min-h-[320px] flex-col items-center justify-center gap-3 border-2 border-dashed border-border/70 bg-panel p-6 text-center"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const file = e.dataTransfer.files[0];
            if (file) carregar(file);
          }}
        >
          <ImageUp className="h-10 w-10 text-muted-foreground" />
          <p className="font-display text-lg">Selecione a janela do Profit acima</p>
          <p className="max-w-md text-xs text-muted-foreground">
            O contador começa em 60s e cada ciclo captura e analisa um print real do gráfico —
            indefinidamente. Também aceita imagem arrastada, arquivo ou colada — PNG, JPG ou WebP,
            até 12 MB.
          </p>
          <Button variant="outline" onClick={() => inputRef.current?.click()}>
            <Upload className="mr-1.5 h-4 w-4" />
            ESCOLHER ARQUIVO
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) carregar(file);
            }}
          />
        </Card>
      ) : (
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
          <Card className="flex flex-col gap-2 border-border/70 bg-panel p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="nexus-eyebrow">
                {pendente ? "PRINT CARREGADO ✓" : `PRINT #${String(indice + 1).padStart(3, "0")}`}
              </span>
              {/*
               * §14 — o print se identifica: de qual CANDLE ele é, a que hora
               * foi capturado e se saiu sincronizado com a virada. Sem isso o
               * operador não tinha como saber se estava olhando o agora ou um
               * minuto atrás.
               */}
              {atual !== null && pendente === null && atual.candleTime !== null && (
                <>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    CANDLE {new Date(atual.candleTime).toLocaleTimeString("pt-BR", HORA_MINUTO)} ·
                    CAPTURA {new Date(atual.capturedAt).toLocaleTimeString("pt-BR", HORA_SEGUNDO)}
                    {atual.captureDelayMs !== null
                      ? ` (+${(atual.captureDelayMs / 1000).toFixed(1)}s)`
                      : ""}
                  </span>
                  <Badge
                    variant="outline"
                    className={cn(
                      "font-mono text-[10px]",
                      sincronismo === "SINCRONIZADO" && "border-bull text-bull",
                      sincronismo === "ATRASADO" && "border-amber-500 text-amber-500",
                      sincronismo === "PROCESSANDO" && "border-border text-muted-foreground",
                      // §5 — imagem repetida é bear, não neutro: o operador
                      // precisa ver que parou de chegar gráfico novo.
                      sincronismo === "AGUARDANDO_FRAME" && "border-bear text-bear",
                    )}
                  >
                    {sincronismo === "AGUARDANDO_FRAME" ? PAUSA_LABEL : sincronismo}
                  </Badge>
                </>
              )}
              {/* Resultado que chegou depois de um print mais novo: fica
                  registrado, mas não governa a tela (§5). */}
              {atual?.desatualizada === true && (
                <Badge
                  variant="outline"
                  className="border-border font-mono text-[10px] text-muted-foreground"
                >
                  ANÁLISE TARDIA — NÃO APLICADA AO ESTADO ATUAL
                </Badge>
              )}
              {/* A nova análise roda em FUNDO: este print não sai daqui até
                  ela confirmar — regra do operador contra tela piscando. */}
              {analiseFundo && pendente === null && (
                <Badge
                  variant="outline"
                  className="border-amber-500 font-mono text-[10px] text-amber-500"
                >
                  NOVA ANÁLISE EM PROCESSAMENTO…
                </Badge>
              )}
              {/* §7 — o print da confirmação fica na tela até a oportunidade
                  acabar; as capturas seguintes continuam na linha do tempo. */}
              {congelado !== null && (
                <>
                  <Badge variant="outline" className="border-bull font-mono text-[10px] text-bull">
                    PRINT CONGELADO — ENTRADA CONFIRMADA
                  </Badge>
                  {congelado !== sessao.length - 1 && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 font-mono text-[10px]"
                      onClick={verUltimo}
                    >
                      VER ÚLTIMO (#{String(sessao.length).padStart(3, "0")})
                    </Button>
                  )}
                </>
              )}
              {analiseVisivel && (
                <div className="flex gap-1">
                  {(["ORIGINAL", "ANALISADO", "SLIDER"] as ViewMode[]).map((m) => (
                    <Button
                      key={m}
                      size="sm"
                      variant={modo === m ? "default" : "outline"}
                      className="font-mono text-[10px]"
                      onClick={() => setModo(m)}
                    >
                      {m}
                    </Button>
                  ))}
                </div>
              )}
              <div className="ml-auto flex items-center gap-1">
                {/* Download do print MODIFICADO: a leitura inteira queimada
                    num PNG — para arquivar/compartilhar fora do sistema. */}
                {atual !== null && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="font-mono text-[10px]"
                    disabled={baixando}
                    onClick={() => void baixarAtual()}
                  >
                    <Download className="mr-1.5 h-3.5 w-3.5" />
                    BAIXAR
                  </Button>
                )}
                {sessao.length > 1 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="font-mono text-[10px]"
                    disabled={baixando}
                    onClick={() => void baixarSessao()}
                  >
                    <Download className="mr-1.5 h-3.5 w-3.5" />
                    {baixando ? "GERANDO…" : `TODOS (.zip · ${sessao.length})`}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={limparTudo}>
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  NOVA SESSÃO
                </Button>
              </div>
            </div>

            <PrintViewer
              image={imagemVisivel}
              captureId={pendente !== null ? "colado" : (atual?.captureId ?? null)}
              analysis={analiseVisivel}
              mode={pendente ? "ORIGINAL" : modo}
              hidden={ocultas}
              onSelect={setSelecionada}
              selected={selecionada}
              // Seta/triângulo de ENTRADA só com entrada CONFIRMADA. Antes
              // disso o gráfico mostra a linha roxa (onde entraria) sem
              // nenhum sinal de ordem — viés não desenha seta.
              entrySide={ladoVisivel}
            />

            {analiseVisivel && tipos.length > 0 && (
              <div className="flex flex-wrap items-center gap-1">
                <span className="nexus-eyebrow mr-1">CAMADAS</span>
                {tipos.map((k) => (
                  <Button
                    key={k}
                    size="sm"
                    variant={ocultas.has(k) ? "outline" : "default"}
                    className="h-6 font-mono text-[10px]"
                    onClick={() => alternarCamada(k)}
                  >
                    {k}
                  </Button>
                ))}
              </div>
            )}

            {selecionada && (
              <p className="rounded border border-border/60 bg-background/60 p-2 font-mono text-[11px] text-muted-foreground">
                <strong>{selecionada.label}</strong>
                {selecionada.reason ? ` — ${selecionada.reason}` : ""}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => void executar()} disabled={etapa >= 0}>
                <FlaskConical className="mr-1.5 h-4 w-4" />
                {etapa >= 0 ? "ANALISANDO…" : analiseVisivel ? "REANALISAR" : "ANALISAR T4"}
              </Button>
              {etapa >= 0 && (
                <span className="font-mono text-[11px] text-muted-foreground">
                  {ETAPAS[etapa]}…
                </span>
              )}
            </div>
          </Card>

          <div className="flex flex-col gap-3">
            {analiseVisivel === null ? (
              <Card className="border-border/70 bg-panel p-3">
                <p className="nexus-eyebrow">DIAGNÓSTICO</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  Clique em ANALISAR T4. Nenhum valor é preenchido antes de a IA ler a imagem.
                </p>
              </Card>
            ) : (
              <>
                {/* O QUE MUDOU — só a partir do segundo print da sessão. */}
                {atual?.comparacao && <ComparacaoCard comparacao={atual.comparacao} />}

                <div className="flex gap-1">
                  {(["T4", "ACAO"] as const).map((t) => (
                    <Button
                      key={t}
                      size="sm"
                      variant={aba === t ? "default" : "outline"}
                      className="font-mono text-[10px]"
                      onClick={() => setAba(t)}
                    >
                      {t === "ACAO" ? "AÇÃO" : "T4"}
                    </Button>
                  ))}
                </div>

                {aba === "T4" ? (
                  // O passo do setup vem do ITEM da sessão: navegar a linha do
                  // tempo mostra o passo DAQUELE print, nunca o mais recente.
                  <PainelT4
                    analise={analiseVisivel}
                    memoria={atual?.memoria ?? null}
                    setupInfo={atual?.setupInfo ?? null}
                  />
                ) : (
                  <PainelAcao analise={analiseVisivel} />
                )}

                {/* 📸 nas DUAS abas: o próximo passo vale igual nos dois olhares. */}
                <NextPrintCard next={analiseVisivel.nextScreenshot} />

                {feedbackUi !== "REGISTRADO" ? (
                  <FeedbackCard
                    pedindoMotivo={feedbackUi === "PEDIR_MOTIVO"}
                    onCorreta={() => registrarFeedback("CORRETA", [])}
                    onIncorreta={() => setFeedbackUi("PEDIR_MOTIVO")}
                    onMotivos={(motivos) => registrarFeedback("INCORRETA", motivos)}
                  />
                ) : (
                  <Card className="border-border/70 bg-panel p-3">
                    <p className="text-[11px] text-muted-foreground">
                      Feedback registrado — obrigado. Ele fica junto da análise no histórico.
                    </p>
                  </Card>
                )}

                {/* §13 — o 2º passe é dito: a imagem na tela pode ser um
                    recorte ampliado, e o operador precisa saber disso. */}
                {atual?.zoom != null && (
                  <Card className="border-border/70 bg-panel p-3">
                    <p className="nexus-eyebrow">AUTO-CROP / 2º PASSE</p>
                    <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
                      {atual.zoom}
                    </p>
                  </Card>
                )}

                {atual !== null && atual.reparos.length > 0 && (
                  <Card className="flex flex-col gap-1 border-border/70 bg-panel p-3">
                    {/* O que foi descartado aparece: silêncio esconderia alucinação. */}
                    <p className="nexus-eyebrow">AJUSTES DA VALIDAÇÃO</p>
                    {atual.reparos.map((rep, i) => (
                      <p key={i} className="text-[10px] text-muted-foreground">
                        • {rep}
                      </p>
                    ))}
                  </Card>
                )}

                <PrintChat image={imagemVisivel} analysis={analiseVisivel} />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Linha({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="nexus-eyebrow shrink-0">{label}</span>
      <span className="truncate font-mono text-xs" title={value}>
        {value}
      </span>
    </div>
  );
}

function ComparacaoCard({ comparacao }: { comparacao: ComparisonResult }) {
  return (
    <Card
      className={cn(
        "flex flex-col gap-1 p-3",
        comparacao.unchanged ? "border-border/70 bg-panel" : "border-amber-500/60 bg-amber-500/5",
      )}
    >
      <p className="nexus-eyebrow">O QUE MUDOU DESDE O PRINT ANTERIOR</p>
      {comparacao.changes.map((c, i) => (
        <p
          key={i}
          className={cn(
            "text-[11px] leading-snug",
            c.kind === "INVALIDACAO" && "text-bear",
            c.kind === "AVANCO" && "text-bull",
            (c.kind === "NAO_CONFIRMAVEL" || c.kind === "SEM_MUDANCA") && "text-muted-foreground",
            c.kind !== "INVALIDACAO" &&
              c.kind !== "AVANCO" &&
              c.kind !== "NAO_CONFIRMAVEL" &&
              c.kind !== "SEM_MUDANCA" &&
              "text-amber-500",
          )}
        >
          • {c.text}
        </p>
      ))}
    </Card>
  );
}

/**
 * GERENCIAMENTO DENTRO DO FLUXO — os números que LIMITAM a operação, visíveis
 * onde a decisão acontece. A edição completa (e o que é administrativo)
 * continua na rota /gerenciamento, viva por URL; aqui entra só o que o
 * operador precisa conferir antes de agir sobre uma análise.
 */
function ResumoGerenciamento() {
  const s = store.settings();
  return (
    <Card className="flex flex-col gap-1 border-border/70 bg-panel p-3">
      <p className="nexus-eyebrow">GERENCIAMENTO</p>
      <Linha label="CONTRATOS MÁX" value={String(s.maxContracts)} />
      <Linha
        label="RISCO MÁX / OPERAÇÃO"
        value={`R$ ${s.maxRiskMoney.toLocaleString("pt-BR")} · ${s.maxRiskPercent}%`}
      />
      <Linha label="SALDO DE REFERÊNCIA" value={`R$ ${s.accountBalance.toLocaleString("pt-BR")}`} />
    </Card>
  );
}

/** Aba T4: técnica, níveis e confluências — o olhar da configuração. */
function PainelT4({
  analise,
  memoria,
  setupInfo,
}: {
  analise: PrintAnalysis;
  memoria: MemoriaPrint | null;
  /** Passo da máquina de setup persistente deste print. Null = não rodou. */
  setupInfo: SetupUpdate | null;
}) {
  const atendidos = analise.criteria.filter((c) => c.met);
  const ausentes = analise.criteria.filter((c) => !c.met);
  const confirmada = entradaLiberada(analise, setupInfo);
  /*
   * MESMA FONTE do SetupCard: ninguém lê  para EXIBIR.
   * O campo já vem vetado pela trava, mas uma análise reaberta do histórico
   * pode carregar direção antiga com auditor reprovado — e aí o campo cru e a
   * decisão discordariam, recriando a contradição pelo outro lado.
   */
  const biasAtual = deriveEntryDecision(analise).bias;
  return (
    <>
      <Card className="flex flex-col gap-2 border-border/70 bg-panel p-3">
        <div className="flex flex-wrap items-center gap-2">
          {/*
           * O BADGE SEGUE A TRAVA, NÃO O CAMPO GRAVADO.
           *
           * Análise salva ANTES desta regra volta do histórico com
           * ENTRADA_CONFIRMADA no JSON e sem as provas — e o verde de operação
           * naquele badge é o mesmo pixel de uma confirmação real, agora sem
           * SetupCard nem pendências ao lado para desmentir. Quando o campo
           * gravado diz confirmada e a trava não sustenta, o badge diz isso.
           */}
          <Badge
            variant="outline"
            className={cn(
              "font-mono",
              analise.status === "ENTRADA_CONFIRMADA" && !confirmada
                ? "border-amber-500 text-amber-500"
                : TOM_STATUS[analise.status],
            )}
          >
            {analise.status === "ENTRADA_CONFIRMADA" && !confirmada
              ? "CONFIRMAÇÃO NÃO PROVADA"
              : PRINT_STATUS_LABEL[analise.status]}
          </Badge>
          {/*
           * VIÉS × AÇÃO — o defeito que este rótulo encerra: "T4 EM FORMAÇÃO"
           * ao lado de um "COMPRA" verde era lido como ordem, com ENTRADA,
           * STOP e ALVO todos NÃO IDENTIFICADOS. Sem confirmação o texto diz
           * VIÉS e sai em tom neutro; a cor de operação é privilégio da
           * entrada confirmada.
           */}
          <span
            className={cn(
              "font-mono text-xs",
              confirmada && biasAtual === "COMPRA" && "text-bull",
              confirmada && biasAtual === "VENDA" && "text-bear",
              !confirmada && "text-muted-foreground",
            )}
          >
            {biasAtual === "NEUTRO"
              ? "VIÉS: NEUTRO"
              : confirmada
                ? `AÇÃO: ${biasAtual}`
                : `VIÉS: ${biasAtual}`}
          </span>
          {!confirmada && biasAtual !== "NEUTRO" && (
            <span className="font-mono text-[10px] text-amber-500">AGUARDANDO CONFIRMAÇÃO</span>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">{PRINT_STATUS_MEANING[analise.status]}</p>
        <div className="mt-1 flex flex-col gap-1">
          <Linha label="ATIVO" value={analise.symbol ?? NAO_IDENTIFICADO} />
          <Linha label="TIMEFRAME" value={analise.timeframe ?? NAO_IDENTIFICADO} />
          <Linha label="CONFIANÇA DA LEITURA" value={`${analise.confidence}%`} />
        </div>
        <p className="text-[10px] leading-snug text-muted-foreground">
          Confiança mede a qualidade da leitura visual desta imagem — não é probabilidade de ganho.
        </p>
      </Card>

      {/* SETUP PERSISTENTE — ACIMA da OPERAÇÃO: a instrução da máquina (o que
          fazer AGORA) vem antes dos níveis crus deste print. */}
      <SetupCard info={setupInfo} analise={analise} />

      {/* SCORE T4 — explicável por componente. Ele NÃO autoriza operação:
          o próprio card diz isso quando a entrada não está liberada. */}
      <ScoreCard score={scoreT4(analise)} />

      <Card className="flex flex-col gap-1 border-border/70 bg-panel p-3">
        <p className="nexus-eyebrow">OPERAÇÃO</p>
        <Linha label="ENTRADA" value={formatRead(analise.entry)} />
        {analise.entryZone && (
          <Linha
            label="ZONA"
            value={`${formatRead(analise.entryZone.min)} – ${formatRead(analise.entryZone.max)}`}
          />
        )}
        <Linha label="STOP" value={formatRead(analise.stop)} />
        {analise.targets.map((t, i) => (
          <Linha key={i} label={`ALVO ${i + 1}`} value={formatRead(t)} />
        ))}
        <Linha label="INVALIDAÇÃO" value={analise.invalidation || "—"} />
      </Card>

      {/* O plano "SE isto, ENTÃO aquilo" vem ANTES das confluências: é a
          resposta acionável — o que observar quando não há entrada agora. */}
      <ConditionalPlanCard plans={analise.conditionalPlans} />

      <ResumoGerenciamento />

      <Card className="flex flex-col gap-1 border-border/70 bg-panel p-3">
        <p className="nexus-eyebrow">CONFLUÊNCIAS</p>
        {atendidos.map((c) => (
          <p key={c.id} className="font-mono text-[11px] text-bull" title={c.detail}>
            ✓ {c.label}
          </p>
        ))}
        {ausentes.map((c) => (
          <p key={c.id} className="font-mono text-[11px] text-muted-foreground" title={c.detail}>
            · {c.label}
          </p>
        ))}
        {analise.criteria.length === 0 && (
          <p className="text-[11px] text-muted-foreground">
            Nenhum critério avaliado nesta imagem.
          </p>
        )}
      </Card>

      {analise.imageIssues.length > 0 && (
        <Card className="flex flex-col gap-1 border-amber-500/60 bg-amber-500/10 p-3">
          <p className="nexus-eyebrow text-amber-500">LIMITAÇÕES DA IMAGEM</p>
          {analise.imageIssues.map((p, i) => (
            <p key={i} className="text-[11px] text-amber-500">
              • {p}
            </p>
          ))}
        </Card>
      )}

      {analise.explanation && (
        <Card className="border-border/70 bg-panel p-3">
          <p className="nexus-eyebrow">EXPLICAÇÃO</p>
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
            {analise.explanation}
          </p>
        </Card>
      )}
    </>
  );
}

/** Aba AÇÃO: estrutura e movimento — o olhar do price action, sem a técnica. */
/**
 * MEMÓRIA T4 — a evidência histórica deste tipo de setup, sem retoque.
 *
 * A taxa exibida como "confiança histórica" é o limite INFERIOR de Wilson:
 * 3/3 não vira 100%. Abaixo da amostra mínima a nota nega a conclusão — o
 * número aparece, a autorização não.
 */
function MemoriaCard({ memoria }: { memoria: MemoriaPrint | null }) {
  if (memoria === null) return null;
  const insuficiente = memoria.note.includes("NÃO autorizada");
  return (
    <Card className="flex flex-col gap-1.5 border-border/70 bg-panel p-3">
      <div className="flex items-center gap-2">
        <p className="nexus-eyebrow">MEMÓRIA T4</p>
        {insuficiente && (
          <Badge
            variant="outline"
            className="border-border font-mono text-[9px] text-muted-foreground"
          >
            AMOSTRA INSUFICIENTE
          </Badge>
        )}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[11px]">
        <span className="text-muted-foreground">Casos semelhantes</span>
        <span>{memoria.totalSimilar}</span>
        <span className="text-muted-foreground">Com resultado</span>
        <span>
          {memoria.resolvedCount} ({memoria.hits}A / {memoria.misses}E)
        </span>
        {memoria.rawHitRate !== null && (
          <>
            <span className="text-muted-foreground">Taxa bruta</span>
            <span>{memoria.rawHitRate.toLocaleString("pt-BR")}%</span>
          </>
        )}
        {memoria.historicalConfidence !== null && (
          <>
            <span className="text-muted-foreground">Confiança histórica</span>
            <span>{memoria.historicalConfidence.toLocaleString("pt-BR")}% (Wilson)</span>
          </>
        )}
        {memoria.finalConfidence !== null && (
          <>
            <span className="text-muted-foreground">Confiança final</span>
            <span className="font-bold">{memoria.finalConfidence}%</span>
          </>
        )}
      </div>
      {memoria.formula !== null && (
        <p className="font-mono text-[10px] text-muted-foreground">{memoria.formula}</p>
      )}
      <p className="text-[10px] leading-snug text-muted-foreground">{memoria.note}</p>
      {memoria.similarCases.slice(0, 3).map((c) => (
        <p
          key={c.printId}
          className="font-mono text-[10px] leading-snug"
          title={c.differences.join(" · ")}
        >
          <span
            className={
              c.verdict === "ACERTOU"
                ? "text-bull"
                : c.verdict === "ERROU"
                  ? "text-bear"
                  : "text-muted-foreground"
            }
          >
            {c.verdict}
          </span>{" "}
          {Math.round(c.similarity * 100)}% · {c.grade} {c.direction}
          {c.tradingDate ? " · " + c.tradingDate : ""}
          {c.ambiguous ? " · ambíguo" : ""}
          {c.differences.length > 0 ? " · difere: " + c.differences[0] : ""}
        </p>
      ))}
    </Card>
  );
}

function PainelAcao({ analise }: { analise: PrintAnalysis }) {
  const estrutura = analise.annotations.filter((a) =>
    ["SUPPORT", "RESISTANCE", "BREAKOUT", "PULLBACK", "INVALIDATION"].includes(a.kind),
  );
  return (
    <>
      <Card className="flex flex-col gap-1 border-border/70 bg-panel p-3">
        <p className="nexus-eyebrow">ESTRUTURA IDENTIFICADA</p>
        {estrutura.length === 0 && (
          <p className="text-[11px] text-muted-foreground">
            Nenhum elemento estrutural marcado neste print.
          </p>
        )}
        {estrutura.map((a, i) => (
          <p key={i} className="font-mono text-[11px]" title={a.reason}>
            <span className="text-muted-foreground">{a.kind}</span> · {a.label}
          </p>
        ))}
      </Card>

      {analise.scenarios.length > 0 && (
        <Card className="flex flex-col gap-1 border-border/70 bg-panel p-3">
          <p className="nexus-eyebrow">O QUE PRECISA ACONTECER AGORA</p>
          {analise.scenarios.map((s, i) => (
            <p key={i} className="text-[11px] text-muted-foreground">
              • {s}
            </p>
          ))}
          <p className="text-[10px] text-muted-foreground">
            Cenários condicionais. Nada garante que o preço vá seguir.
          </p>
        </Card>
      )}

      {analise.pastOccurrences > 0 && (
        <Card className="border-border/70 bg-panel p-3">
          <p className="nexus-eyebrow">OCORRÊNCIAS ANTERIORES</p>
          <p className="mt-1 text-[11px]" style={{ color: "#a855f7" }}>
            {analise.pastOccurrences} possível(is) T4 anterior(es) identificada(s) neste print.
          </p>
          <p className="text-[10px] text-muted-foreground">
            Identificação visual dentro da imagem — não é backtest estatístico.
          </p>
        </Card>
      )}
    </>
  );
}

const MOTIVOS_INCORRETA = [
  "entrada errada",
  "stop errado",
  "técnica não era T4",
  "região errada",
  "leitura do preço errada",
  "outro",
] as const;

function FeedbackCard({
  pedindoMotivo,
  onCorreta,
  onIncorreta,
  onMotivos,
}: {
  pedindoMotivo: boolean;
  onCorreta: () => void;
  onIncorreta: () => void;
  onMotivos: (motivos: string[]) => void;
}) {
  const [marcados, setMarcados] = useState<Set<string>>(new Set());
  return (
    <Card className="flex flex-col gap-2 border-border/70 bg-panel p-3">
      <p className="nexus-eyebrow">ESTA ANÁLISE FOI ÚTIL?</p>
      {!pedindoMotivo ? (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={onCorreta}>
            👍 Análise correta
          </Button>
          <Button size="sm" variant="outline" onClick={onIncorreta}>
            👎 Análise incorreta
          </Button>
        </div>
      ) : (
        <>
          <p className="text-[11px] text-muted-foreground">O que estava errado?</p>
          <div className="flex flex-wrap gap-1">
            {MOTIVOS_INCORRETA.map((m) => (
              <Button
                key={m}
                size="sm"
                variant={marcados.has(m) ? "default" : "outline"}
                className="h-6 text-[10px]"
                onClick={() =>
                  setMarcados((s) => {
                    const proximo = new Set(s);
                    if (proximo.has(m)) proximo.delete(m);
                    else proximo.add(m);
                    return proximo;
                  })
                }
              >
                {m}
              </Button>
            ))}
          </div>
          <Button size="sm" disabled={marcados.size === 0} onClick={() => onMotivos([...marcados])}>
            REGISTRAR
          </Button>
        </>
      )}
    </Card>
  );
}
