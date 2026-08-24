import { carregarProvider, PROVIDER_DESCONHECIDO } from "@/lib/ai/providerCache";
import { aiReachable } from "@/lib/ai/aiReachable";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";

import { screenCaptureManager } from "@/lib/capture/screenCaptureManager";
import { screenRecordingManager } from "@/lib/recording/screenRecordingManager";
import { capturePriceScaleImage, type FrameRead } from "@/lib/capture/frameProcessor";
import { calibratePriceScale } from "@/lib/calibration.functions";
import {
  checkTimeout,
  EMPTY_LIVENESS,
  isMoving,
  isUsable,
  observeFrame,
  readStreamHealth,
  streamLabel,
  visualLabel,
  type LivenessState,
} from "@/lib/vision/streamLiveness";
import {
  ChartTracker,
  EMPTY_TRACKER,
  MIN_CANDLES_FOR_ANALYSIS,
  type TrackerState,
} from "@/lib/vision/chartTracker";
import { analyze } from "@/lib/engines/analysisPipeline";
import { getAssistantProviders } from "@/lib/analyst.functions";
import type { ChatEntry } from "@/lib/engines/types";
import { decide, EntryStateMachine } from "@/lib/engines/backtestDecisionEngine";
import type { DecisionObject } from "@/lib/engines/backtestDecisionEngine";
import { filterEvidenceTrades } from "@/lib/engines/evidenceFilter";
import { resolveInstrument } from "@/lib/engines/instruments";
import { riskParamsForAsset, STRATEGY_VERSION } from "@/lib/engines/strategy";
import { validateCaptureWithOpenAI } from "@/lib/aiPrintValidation.functions";
import { MIN_RR } from "@/lib/t4/riskGate";
import { store } from "@/lib/storage";
import type { AnalysisResult, ReadingState } from "@/lib/engines/types";
import {
  EMPTY_STATE,
  updateVisualState,
  type VisualMarketState,
} from "@/lib/vision/visualMarketState";
import { evaluateT4Gates, type GateResult } from "@/lib/t4/gates";
import {
  evaluateOperation,
  justArmed,
  justConfirmed,
  IDLE_OPERATION,
  type T4Operation,
} from "@/lib/t4/preEntry";
import { buildReadingState } from "@/lib/t4/readingState";
import { markStage, newTimeline, type SetupTimeline } from "@/lib/t4/leadTime";
import { evaluateDataGates, type DataGateResult } from "@/lib/t4/dataGates";
import { guardDecision, guardNarration, guardOperation } from "@/lib/t4/priceGuard";
import { simulateEntry, type SimulatedOperation } from "@/lib/t4/simulation";
import { playApproachOnce, playConfirmationOnce } from "@/lib/t4/signalSound";
import {
  CofreDeEvidencias,
  type MomentoCongelado,
  type PrintCongelado,
} from "@/lib/t4/entryFreeze";
import { captureFrameFromManager } from "@/lib/capture/marketMonitor";
import {
  PriceScaleSession,
  type ScaleSessionState,
  EMPTY_SCALE_SESSION,
} from "@/lib/vision/priceScaleSession";
import { scaleReject } from "@/lib/vision/scaleReject";
import { FULL_FRAME } from "@/lib/vision/chartRoi";
import { marketStamp, type SourceMode } from "@/lib/vision/sourceMode";
import { projectSeries, projectionPlausible } from "@/lib/vision/priceProjection";
import { captureVisionReplay, type VisionReplayBundle } from "@/lib/vision/techniqueReplay";
import { ROI_CANDIDATES } from "@/lib/vision/calibrationScheduler";

/**
 * LEITURA DO PROFIT — um clique, e a T4 passa a acompanhar o gráfico.
 *
 * O fluxo inteiro do operador cabe em três passos: abrir o Profit, clicar em
 * INICIAR LEITURA, escolher a janela. Depois disso nada mais é pedido — nem
 * calibração, nem confirmação de timeframe, nem um segundo botão de conectar.
 *
 * UMA AUTORIZAÇÃO POR SESSÃO
 * `getDisplayMedia` é chamado UMA vez. O `MediaStream` resultante vive no
 * `screenCaptureManager`, que é singleton fora da árvore React: trocar de rota,
 * recarregar um componente ou re-renderizar não pede a janela de novo. Só
 * TROCAR FONTE chama a seleção outra vez, e só quando o operador pede.
 *
 * PIXELS, NÃO OBJETOS
 * A leitura não é considerada ativa porque existe um `MediaStream`. Ela é ativa
 * quando os pixels mudam — ver `streamLiveness`. Com a janela minimizada o
 * objeto continua vivo e a imagem congela, e é nesse buraco que um painel
 * ingênuo mostra tudo verde com o gráfico parado.
 *
 * O PIPELINE INTEIRO MORA AQUI
 * Antes, este hook parava em `analyze()` e a decisão vinha do caminho RTD — o
 * que significava que, sem RTD, a pré-entrada nascia sem entrada, sem stop e
 * sem alvo. Agora a cadeia é completa e ÚNICA:
 *
 *   pixels → tracker → analyze → decide → máquina de entrada → operação
 *
 * A escala de preço corre EM PARALELO e nunca entra nesse caminho: ela decide se
 * um NÚMERO pode ser publicado, não se a leitura acontece.
 */

/** Frequência do relógio que detecta stream parado sem depender de frame novo. */
const WATCHDOG_MS = 1_000;
/** Cadência da fila lateral de calibração. Só OLHA; chamar é outra decisão. */
const SCALE_TICK_MS = 2_000;

/**
 * `ReadingState` da leitura visual contínua.
 *
 * `priceScaleReady` acompanha a escala REAL: enquanto ela não calibra, os preços
 * são unidades relativas de pixel e a técnica precisa saber disso para publicar
 * "SETUP ARMADO, PREÇO EM CALIBRAÇÃO" em vez de um número inventado.
 *
 * `timeframeConfirmed` é verdadeiro porque a série é montada em grade de 1
 * minuto pelo próprio tracker — não depende de um humano marcar caixinha.
 *
 * O ponto que importa: nada disso BLOQUEIA a leitura estrutural. Tendência,
 * rompimento e liquidez saem iguais com ou sem escala; só o número exato espera.
 */
function visualReadingState(
  closedCandles: number,
  quality: number,
  priceScaleReady: boolean,
  confidence: number,
): ReadingState {
  // Delegado: o MESMO construtor que o backtest e o replay usam. Antes cada
  // caminho tinha o seu, com mínimos diferentes para o mesmo conceito — e
  // `reading.sufficient` é portão dentro de `analyze()`.
  return buildReadingState({
    closedCandles,
    quality,
    priceScaleReady,
    calibrationConfidence: confidence,
  });
}

export interface ProfitVisionState {
  /** O operador pediu leitura (independente de estar chegando imagem). */
  requested: boolean;
  /** Aguardando a escolha da janela pelo operador. */
  selecting: boolean;
  liveness: LivenessState;
  visual: VisualMarketState;
  /** Frames processados nesta sessão. */
  frames: number;
  error: string | null;
}

export function useProfitVision(asset = "WINFUT", sourceMode: SourceMode = "LIVE") {
  const calibrateScale = useServerFn(calibratePriceScale);
  const loadProviders = useServerFn(getAssistantProviders);
  const validateCapture = useServerFn(validateCaptureWithOpenAI);

  const [requested, setRequested] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveness, setLiveness] = useState<LivenessState>(EMPTY_LIVENESS);
  const [visual, setVisual] = useState<VisualMarketState>(EMPTY_STATE);
  const [frames, setFrames] = useState(0);
  const [tracker, setTracker] = useState<TrackerState>(EMPTY_TRACKER);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [decision, setDecision] = useState<DecisionObject | null>(null);
  const [entryState, setEntryState] = useState<string>("IDLE");
  const [operation, setOperation] = useState<T4Operation>(IDLE_OPERATION);
  const [t4Gates, setT4Gates] = useState<GateResult[]>([]);
  const [timeline, setTimeline] = useState<SetupTimeline | null>(null);
  const [scale, setScale] = useState<ScaleSessionState>(EMPTY_SCALE_SESSION);
  const [chat, setChat] = useState<ChatEntry[]>([]);
  /** Entrada de TESTE. Vive fora do estado real da T4, de propósito. */
  const [simulation, setSimulation] = useState<SimulatedOperation | null>(null);
  const [simulationError, setSimulationError] = useState<string | null>(null);
  const [aiProvider, setAIProvider] = useState({ configured: false, model: "", provider: "" });
  /**
   * Alcancabilidade do servico de visao, medida por HTTP.
   *
   * `null` = nunca perguntamos. Antes este estado era DERIVADO do erro de
   * escala: um eixo ilegivel marcava a GPU como OFFLINE, e o operador ia
   * reiniciar um tunel que estava funcionando.
   */
  const [gpuReachable, setGpuReachable] = useState<boolean | null>(null);

  // Os estados vivem em refs porque o callback de frame é registrado uma vez e
  // rodaria com a cópia antiga se dependesse do estado do React.
  const livenessRef = useRef(EMPTY_LIVENESS);
  const visualRef = useRef(EMPTY_STATE);
  const framesRef = useRef(0);
  const trackerRef = useRef(new ChartTracker());
  const analysisRef = useRef<AnalysisResult | null>(null);
  const decisionRef = useRef<DecisionObject | null>(null);
  const gatesRef = useRef<GateResult[]>([]);
  const operationRef = useRef<T4Operation>(IDLE_OPERATION);
  const timelineRef = useRef<SetupTimeline | null>(null);
  const readingRef = useRef<ReadingState | null>(null);
  /**
   * O cofre dos prints congelados: aproximação e entrada confirmada.
   *
   * Vive em `ref` porque a evidência não pode depender de re-render — o
   * instante da decisão acontece dentro do laço de frames, não no ciclo do
   * React. O estado espelhado abaixo existe só para a tela reagir.
   */
  const cofreRef = useRef(new CofreDeEvidencias());
  const [evidencias, setEvidencias] = useState<PrintCongelado[]>([]);
  /**
   * VALIDAÇÃO OPENAI (Luna/Terra) do último print congelado — BLOCO 6.
   *
   * `confirmado` vem de `finalConfirmation` no SERVIDOR (aiValidation.ts) e é
   * a ÚNICA porta para a promoção assistida: Terra APPROVE ∧ Luna ≠ REJECT ∧
   * pernas determinísticas. IA indisponível/timeout ⇒ `confirmado:false` com
   * motivo nas linhas — nunca bloqueia a captura, nunca promove sozinha.
   * `null` = nenhum print validado ainda nesta sessão.
   */
  const [aiValidation, setAiValidation] = useState<{
    rows: { luna: string; terra: string; t4: string; veredito: string };
    confirmado: boolean;
    setupId: string;
    momento: string;
    candleTime: number;
  } | null>(null);
  /** Gates de DADO do frame atual. Idade, nao aparencia. */
  const dataGatesRef = useRef<DataGateResult | null>(null);
  const [dataGates, setDataGates] = useState<DataGateResult | null>(null);
  const evaluatedAtRef = useRef<number>(0);
  const entryMachineRef = useRef(new EntryStateMachine());
  const requestedRef = useRef(false);
  requestedRef.current = requested;
  /** Trava do clique duplo: o diálogo do navegador demora, o dedo não. */
  const selectingRef = useRef(false);
  const assetRef = useRef(asset);
  assetRef.current = asset;
  const modeRef = useRef<SourceMode>(sourceMode);
  modeRef.current = sourceMode;

  /**
   * NARRAÇÃO — uma linha por MUDANÇA de estado, nunca por frame.
   *
   * Narrar a cada leitura encheria o painel de repetição e esconderia justamente
   * o instante em que algo mudou, que é a única coisa que o operador precisa
   * ler no meio do pregão.
   */
  const narrate = useCallback((text: string, tone: ChatEntry["tone"] = "info") => {
    setChat((previous) => {
      if (previous[previous.length - 1]?.text === text) return previous;
      return [...previous, { t: Date.now(), text, tone }].slice(-120);
    });
  }, []);
  const lastNarratedRef = useRef<string | null>(null);

  const sessionIdRef = useRef<string>("sem-sessao");
  const scaleRef = useRef(new PriceScaleSession("sem-sessao", asset));
  const scaleBusyRef = useRef(false);
  /** Altura do frame que originou a série. A conversão pixel→preço depende dela. */
  const baseFrameHeightRef = useRef(0);
  const roiIndexRef = useRef(0);

  /**
   * TIRA O PRINT E CONGELA — chamada só nos dois instantes que importam.
   *
   * A fotografia sai do MESMO frame que a técnica acabou de ler
   * (`captureFrameFromManager` lê o `<video>` do gerenciador de captura), então
   * a imagem guardada é literalmente o que o motor viu quando decidiu — não uma
   * recaptura feita meio segundo depois, com o gráfico já em outro lugar.
   *
   * Falha de captura NÃO cancela o registro: o congelamento dos números vale
   * por si, e um print sem imagem é melhor que nenhum print. A ausência fica
   * declarada em `imagem: null`, nunca disfarçada.
   */
  const congelarInstante = useCallback(
    (
      momento: MomentoCongelado,
      operacao: T4Operation,
      analise: AnalysisResult | null,
      chartTimestamp: number,
      extra: { precoConfiavel: boolean; motivo: string },
    ) => {
      const setupId = operacao.setupId ?? `sem-setup_${chartTimestamp}`;
      if (cofreRef.current.jaCongelado(setupId, momento)) return;

      const captura = captureFrameFromManager();
      const registro: PrintCongelado = {
        setupId,
        momento,
        chartTimestamp,
        capturadoEm: Date.now(),
        asset: assetRef.current,
        direcao: operacao.direction ?? "NEUTRO",
        familia: analise?.t4.setup ?? null,
        estagio: operacao.stage,
        maturidade: operacao.maturity,
        niveis: {
          entrada: operacao.entry,
          stop: operacao.stop,
          alvo1: operacao.partial,
          alvo2: operacao.target,
          rr: operacao.riskReward,
        },
        precoAtual: analise?.price ?? null,
        precoConfiavel: extra.precoConfiavel,
        motivo: extra.motivo,
        confluencias:
          analise?.evidences.filter((e) => e.state === "confirmada").map((e) => e.label) ?? [],
        candle: trackerRef.current.window().slice(-1)[0] ?? null,
        imagem: captura.ok ? captura.dataUrl : null,
        frameHash: captura.ok ? captura.frameHash : null,
        versaoDaTecnica: STRATEGY_VERSION,
      };
      if (cofreRef.current.congelar(registro)) {
        setEvidencias(
          cofreRef.current
            .todos()
            .flatMap((r) => [r.aproximacao, r.confirmacao])
            .filter((p): p is PrintCongelado => p !== null),
        );
        /*
         * LUNA/TERRA NO INSTANTE CONGELADO (BLOCO 6) — fire-and-forget: a
         * captura e a máquina determinística NUNCA esperam a IA. Sem imagem
         * não há o que validar (a ausência já está declarada no registro).
         * O snapshot determinístico é o estado da OPERAÇÃO neste instante;
         * `e2Closed` só é afirmado quando a máquina CONFIRMOU — a série do
         * tracker é de candles fechados por construção, e a confirmação
         * exige a sequência fechada (§14–§16).
         */
        if (registro.imagem !== null && registro.frameHash !== null) {
          const rr = operacao.riskReward;
          void validateCapture({
            data: {
              imageDataUrl: registro.imagem,
              imageHash: registro.frameHash,
              captureId: sessionIdRef.current,
              candleTime: chartTimestamp,
              deterministic: {
                pass: operacao.confirmed,
                e2Closed: operacao.confirmed,
                rr,
                rrOk: rr !== null && rr >= MIN_RR,
                entry: operacao.entry,
                stop: operacao.stop,
                levelsValid:
                  operacao.entry !== null && operacao.stop !== null && operacao.target !== null,
                stage: operacao.stage,
                blockCode: null,
                blockReason: operacao.blockReason ?? null,
              },
            },
          })
            .then((resultado) => {
              setAiValidation({
                rows: resultado.ui,
                confirmado: resultado.final.confirmado,
                setupId,
                momento,
                candleTime: chartTimestamp,
              });
            })
            .catch(() => {
              // IA fora do ar não é erro de captura: as linhas declaram.
              setAiValidation({
                rows: {
                  luna: "Luna: INDISPONÍVEL (falha de rede/servidor)",
                  terra: "Terra: não chamado",
                  t4: operacao.confirmed ? "T4: PASS (determinística)" : "T4: aguardando",
                  veredito: "SEM VALIDAÇÃO IA — operação assistida NÃO promovida",
                },
                confirmado: false,
                setupId,
                momento,
                candleTime: chartTimestamp,
              });
            });
        }
      }
    },
    [validateCapture],
  );

  /**
   * O trecho caro do frame, isolado e chamado só quando a série MUDA.
   *
   * Reanalisar o já sabido a cada 500ms queimaria GPU sem produzir informação —
   * e, pior, produziria uma `decision` nova a cada frame, o que faria a máquina
   * de entrada oscilar sobre o mesmo candle.
   */
  const runEngine = useCallback(
    (quality: number, now: number) => {
      const geometrica = trackerRef.current.window();
      const scaleState = scaleRef.current.snapshot();

      /*
       * PIXEL VIRA PREÇO AQUI, E SÓ AQUI.
       *
       * A extração e a costura vivem em unidade GEOMÉTRICA porque é ela que é
       * estável frame a frame — trocar a régua no meio faria a série inteira
       * parecer outro gráfico para o costurador. A conversão acontece na SAÍDA.
       *
       * O defeito que isto encerra: a escala calibrava, o painel dizia PRONTA, a
       * guarda de preço DESLIGAVA — e os candles continuavam em pixel, porque a
       * calibração nunca chegava ao extrator. O resultado era "ENTRADA 181.18"
       * para um WINFUT que negocia perto de 139.000.
       */
      const projecao = {
        baseHeight: baseFrameHeightRef.current,
        calibration: scaleState.scale.calibration,
      };
      const projetada = projectSeries(geometrica, projecao);
      // Última rede: régua que produz preço fora da faixa do contrato está errada,
      // e publicar seria repetir o defeito com outro número.
      const precoReal =
        scaleState.scale.priceScaleReady && projectionPlausible(projetada, assetRef.current);
      const janela = precoReal ? projetada : geometrica;

      const reading = visualReadingState(
        janela.length,
        quality,
        precoReal,
        scaleState.scale.priceConfidence,
      );

      // Os níveis do plano nascem NO TICK DO CONTRATO. Sem isto, `analyze()` cai
      // em `DEFAULT_RISK_PARAMS` (tickSize 0) e publica entrada/stop/alvo em
      // preços que o WIN não negocia — plausíveis na tela, impossíveis no book.
      const result = analyze(janela, {
        reading,
        riskParams: riskParamsForAsset(assetRef.current),
      });
      if (!result) return;
      analysisRef.current = result;
      // Guardados para o TESTE DA TÉCNICA: sem a leitura e o `now` exatos, o
      // replay reexecutaria com entrada diferente e a divergência seria do teste.
      readingRef.current = reading;
      evaluatedAtRef.current = now;

      // A DECISÃO NASCE AQUI, no mesmo pipeline que leu os pixels. Antes ela vinha
      // do caminho RTD: sem RTD, a pré-entrada armava sem entrada, sem stop e sem
      // alvo — informação pela metade na hora em que ela mais vale.
      const settings = store.settings();
      const instrument = resolveInstrument(assetRef.current, {});
      const next = decide({
        analysis: result,
        asset: assetRef.current,
        trades: filterEvidenceTrades(store.backtests()),
        techniqueSnapshot: store.productionTechnique()?.version ?? STRATEGY_VERSION,
        instrument,
        riskConfig: {
          accountBalance: settings.accountBalance,
          maxRiskPercent: settings.maxRiskPercent,
          maxRiskMoney: settings.maxRiskMoney,
          contractsLimit: settings.maxContracts,
        },
      });
      // A DECISÃO CRUA continua alimentando gates e máquina de entrada: eles
      // comparam proporções, que são invariantes à unidade. O que é publicado
      // passa pela guarda — ver `priceGuard`.
      entryMachineRef.current.onDecision(next);
      // A guarda segue o que de fato foi CONVERTIDO, não o que foi calibrado. Uma
      // escala pronta cujos candles seguem em pixel é o caso mais perigoso: o
      // número passa a ser publicado como preço sem nunca ter virado preço.
      const scaleReady = precoReal;
      decisionRef.current = guardDecision(next, scaleReady);

      /*
       * OS GATES DE DADO VOLTAM A EXISTIR.
       *
       * Aqui passavam `dataReady: true` e `dataGates: []` LITERAIS. O ramo de
       * `evaluateOperation` que impede afirmar qualquer coisa sobre dado morto
       * estava escrito, testado e inalcançável — e junto com ele o bloqueio por
       * dado velho.
       *
       * A idade medida é a do último candle FECHADO, não a do frame: a captura
       * pode estar perfeita enquanto a série está congelada há dez minutos.
       */
      const ultimoFechado = janela[janela.length - 1]?.t ?? null;
      const dados = evaluateDataGates({
        requested: requestedRef.current,
        usable: isUsable(livenessRef.current),
        now,
        lastFrameAt: livenessRef.current.lastFrameAt,
        lastClosedCandleAt: ultimoFechado,
        closedCandles: janela.length,
        minimumCandles: MIN_CANDLES_FOR_ANALYSIS,
      });
      dataGatesRef.current = dados;

      const gates = evaluateT4Gates(result, dados.dataReady);
      gatesRef.current = gates;

      const previous = operationRef.current;
      const rawOperation = evaluateOperation({
        dataReady: dados.dataReady,
        dataGates: dados.gates,
        t4Gates: gates,
        analysis: result,
        decision: next,
        entryState: entryMachineRef.current.current(),
        previous,
        now,
      });
      // Estágio, direção e maturidade passam intactos; só os NÍVEIS são apagados
      // enquanto a escala não valida. Sem isso, "Entrada 640.21" era pixel virando
      // preço na tela do operador.
      const operationNow = guardOperation(rawOperation, scaleReady);
      operationRef.current = operationNow;

      // ANTECEDÊNCIA: a marca é gravada QUANDO o estado acontece. Reconstruí-la
      // depois deixaria a T4 "descobrir" que o candidato existia mais cedo, usando
      // informação que ainda não existia — lookahead disfarçado de métrica.
      //
      // O instante é o do MERCADO. Em REPLAY sem leitura do eixo não há instante
      // confiável, e então nada é marcado: um marco com a data de hoje num pregão
      // de março não é medição, é ruído com aparência de prova.
      const lastCandle = janela[janela.length - 1] ?? null;
      const stamp = marketStamp(modeRef.current, lastCandle?.t ?? null, now);
      if (stamp.at !== null) {
        const id = operationNow.setupId ?? "sem-setup";
        // NEUTRO não é direção de setup: é a ausência dela. Registrar como null
        // impede que um viés indefinido apareça na linha do tempo como lado.
        const side =
          operationNow.direction === "COMPRA" || operationNow.direction === "VENDA"
            ? operationNow.direction
            : null;
        const current =
          timelineRef.current?.setupId === id ? timelineRef.current : newTimeline(id, side);
        timelineRef.current = markStage(current, {
          stage: operationNow.stage,
          marketTime: stamp.at,
          zone: operationNow.entryZone,
          stop: operationNow.stop,
          pendingTrigger: operationNow.blockReason,
          blockReason: operationNow.blockReason,
        });
      }

      // Uma linha por MUDANÇA de estágio. O bloqueio vai junto: saber que a T4
      // está OBSERVANDO sem saber o que falta não ajuda ninguém a decidir nada.
      const line = `${operationNow.stage}${operationNow.direction ? ` · ${operationNow.direction}` : ""}${
        operationNow.blockReason ? ` — ${operationNow.blockReason}` : ""
      }`;
      if (lastNarratedRef.current !== operationNow.stage) {
        lastNarratedRef.current = operationNow.stage;
        narrate(
          // Rede final: os números falsos apareceram no CHAT, dentro de uma frase,
          // escapando de qualquer guarda de campo.
          guardNarration(line, scaleReady),
          operationNow.confirmed
            ? "alert"
            : operationNow.direction === "COMPRA"
              ? "bull"
              : operationNow.direction === "VENDA"
                ? "bear"
                : "info",
        );
      }

      /*
       * OS DOIS INSTANTES QUE VIRAM FOTOGRAFIA — e só eles.
       *
       * O operador não fica olhando a tela: o sistema monitora e chama. Chamar
       * exige duas coisas distintas, com sons distintos:
       *
       *   APROXIMAÇÃO ("olhe agora")  → bipe grave duplo + print congelado;
       *   ENTRADA CONFIRMADA ("fechou") → sequência de entrada + print congelado.
       *
       * O QUE ISTO CONSERTA. Antes só existia UM alerta, e ele tocava no
       * ARMAMENTO — `justArmed` é falso em ENTRADA_CONFIRMADA por construção
       * (preEntry.ts), então a chave de dedupe já tinha sido consumida quando a
       * entrada de fato confirmava: o operador era treinado a ouvir "entrou"
       * quando o sistema dizia "pode acontecer", e não ouvia nada quando
       * acontecia. Agora são dois gatilhos de BORDA, um por instante.
       *
       * O print é tirado AQUI, no instante da decisão, e congelado imutável —
       * não reconstruído depois. Fora destes dois instantes nada é guardado.
       */
      const somLigado = store.settings().sound;
      const idDoSetup = operationNow.setupId ?? "sem-setup";
      const ladoDoSetup =
        operationNow.direction === "COMPRA" || operationNow.direction === "VENDA"
          ? operationNow.direction
          : null;

      if (justArmed(previous, operationNow) && ladoDoSetup !== null) {
        playApproachOnce(idDoSetup, somLigado);
        congelarInstante("APROXIMACAO", operationNow, analysisRef.current, stamp.at ?? now, {
          precoConfiavel: scaleReady,
          motivo: operationNow.blockReason ?? "aproximação da região operacional",
        });
      }

      if (justConfirmed(previous, operationNow) && ladoDoSetup !== null) {
        playConfirmationOnce(idDoSetup, ladoDoSetup, somLigado);
        congelarInstante("ENTRADA_CONFIRMADA", operationNow, analysisRef.current, stamp.at ?? now, {
          precoConfiavel: scaleReady,
          motivo: "gatilho cumprido com candle fechado — entrada confirmada",
        });
      }
    },
    [narrate, congelarInstante],
  );

  /**
   * Chega até 30 vezes por segundo: nada de caro aqui. O trabalho pesado só
   * acontece quando a leitura estrutural muda de verdade.
   */
  const handleFrame = useCallback(
    (frame: FrameRead) => {
      if (!requestedRef.current) return;

      const now = Date.now();
      const track = screenCaptureManager.stream()?.getVideoTracks()[0] ?? null;
      const nextLiveness = observeFrame(livenessRef.current, frame, now, readStreamHealth(track));
      livenessRef.current = nextLiveness;
      framesRef.current += 1;

      // Imagem congelada ou parada não alimenta o estado: repetir a última
      // leitura como se fosse nova inventaria continuidade que não existe.
      if (isUsable(nextLiveness)) {
        // A régua geométrica é `altura − y`. Guardamos a altura do PRIMEIRO
        // frame porque é nela que a série costurada vive: frames posteriores com
        // outra altura são trazidos ao espaço da mestre pelo costurador.
        if (baseFrameHeightRef.current === 0) baseFrameHeightRef.current = frame.height;

        // A GEOMETRIA da janela é o gatilho da escala — nunca o relógio, nunca o
        // movimento dos candles. Hash igual significa reta válida e ZERO GPU.
        scaleRef.current.observe(
          {
            frameWidth: frame.width,
            frameHeight: frame.height,
            roi: FULL_FRAME,
            priceAxisFrom: ROI_CANDIDATES[roiIndexRef.current % ROI_CANDIDATES.length]!,
            symbol: assetRef.current,
          },
          now,
        );

        /*
         * A geometria do frame vira série costurada. Só quando a série MUDA vale
         * rodar o motor — reanalisar o já sabido queimaria GPU a cada 500ms.
         *
         * O `isMoving` que existia aqui era um segundo portão, e ele quebrava o
         * caso mais comum de todos: abrir a leitura com o mercado parado. Sem
         * pixel mudando, o tracker nunca recebia frame, o bootstrap ficava em
         * 0/24 e a T4 esperava para sempre um movimento que ela mesma exigia
         * para começar a olhar. GRÁFICO PARADO É ESTADO VÁLIDO — e o gráfico
         * parado tem candles na tela, que é o que a leitura precisa.
         *
         * O portão continua existindo, mas onde ele pertence: dentro do tracker,
         * que reconhece frame idêntico por assinatura e devolve `false` sem
         * custo. Um portão só, no lugar certo.
         */
        const changed = trackerRef.current.push(frame.candles, now);
        if (changed && trackerRef.current.ready()) {
          runEngine(Math.round(frame.quality * 100), now);
        }

        visualRef.current = updateVisualState(visualRef.current, {
          marketTime: null,
          videoTime: null,
          at: now,
          // ATENÇÃO À UNIDADE: `frame.quality` vem de `inspectPixelFrame` na
          // escala 0–1, e `visualConfidence` é comparada com o limiar 30 (0–100).
          // Sem o ×100 todo frame cairia no ramo "imagem ilegível" e o estado
          // NUNCA seria atualizado — a leitura pareceria viva e não avançaria.
          visualConfidence: Math.round(frame.quality * 100),
          priceConfidence: frame.priceY === null ? 0 : 40,
          timeConfidence: 0,
          problem: null,
        });
      }
    },
    [runEngine],
  );

  useEffect(() => {
    return screenCaptureManager.subscribeFrames(handleFrame);
  }, [handleFrame]);

  // Publicação em intervalo fixo: um setState por frame renderizaria a árvore
  // 30 vezes por segundo sem nenhum ganho para quem está olhando.
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      const track = screenCaptureManager.stream()?.getVideoTracks()[0] ?? null;
      const checked = checkTimeout(livenessRef.current, now, readStreamHealth(track));
      livenessRef.current = checked;
      setLiveness(checked);
      setVisual(visualRef.current);
      setFrames(framesRef.current);
      setTracker(trackerRef.current.snapshot());
      setAnalysis(analysisRef.current);
      setDecision(decisionRef.current);
      setEntryState(entryMachineRef.current.current());
      setOperation(operationRef.current);
      setT4Gates(gatesRef.current);
      setDataGates(dataGatesRef.current);
      setTimeline(timelineRef.current);
      setScale(scaleRef.current.snapshot());
    }, WATCHDOG_MS);
    return () => clearInterval(timer);
  }, []);

  /**
   * FILA LATERAL DA ESCALA — roda sozinha e nunca atrasa a T4.
   *
   * Só sai chamada quando a geometria pede: hash novo, escala não calibrada e
   * backoff cumprido. Com a janela estável e a reta pronta, esta função não faz
   * absolutamente nada — que é o comportamento correto, e o que economiza os
   * 6 a 12 segundos de GPU por leitura.
   */
  const attemptCalibration = useCallback(async () => {
    if (scaleBusyRef.current) return;
    const video = screenCaptureManager.videoRef.current;
    if (!video?.videoWidth || !video.videoHeight) return;

    const now = Date.now();
    if (!scaleRef.current.shouldRequest(now)) return;

    scaleBusyRef.current = true;
    const { revision, sentAt } = scaleRef.current.begin(now);
    try {
      const fraction = ROI_CANDIDATES[roiIndexRef.current % ROI_CANDIDATES.length]!;
      const snapshot = capturePriceScaleImage(video, fraction);
      const response = await calibrateScale({
        data: {
          imageDataUrl: snapshot.imageDataUrl,
          frameHeight: snapshot.frameHeight,
          // Desempata o formato BR pela faixa do contrato.
          asset: assetRef.current,
        },
      });
      const applied = scaleRef.current.apply(
        {
          anchors: response.anchors,
          model: response.model,
          error: response.error,
          reject: response.reject,
          audit: response.audit,
          revision,
          sentAt,
        },
        Date.now(),
      );
      setScale(applied);
      if (applied.scale.priceScaleReady) {
        narrate(
          `Escala calibrada por ${applied.model ?? "OCR"}: ${applied.scale.anchorCount} âncoras, R² ${applied.scale.calibration.r2.toFixed(4)}. Preços exatos liberados.`,
          "info",
        );
      } else if (applied.reject !== null) {
        // O MOTIVO vai para o registro, não só "calibração falhou": é a
        // diferença entre consertar o túnel e ajustar a região da escala.
        narrate(
          `Escala não calibrou (${applied.reject.code}): ${applied.reject.detail}. A leitura estrutural continua.`,
          "warn",
        );
      }
      // Mesma região falhando por leitura de rótulo: procurar a escala em outra
      // faixa lateral. Falha de GPU ou resposta velha não muda a ROI — mudar a
      // região por causa do túnel caído seria procurar no lugar errado.
      const code = applied.reject?.code;
      if (
        code === "NO_LABELS" ||
        code === "OCR_EMPTY" ||
        code === "INSUFFICIENT_ANCHORS" ||
        code === "ROI_INVALID"
      ) {
        if (applied.consecutiveFailures % 3 === 0) roiIndexRef.current += 1;
      }
    } catch (problem) {
      const message = problem instanceof Error ? problem.message : String(problem);
      setScale(scaleRef.current.failLocally(scaleReject("GPU_OFFLINE", message), Date.now()));
    } finally {
      scaleBusyRef.current = false;
    }
  }, [calibrateScale, narrate]);

  useEffect(() => {
    if (!requested) return;
    const timer = setInterval(() => void attemptCalibration(), SCALE_TICK_MS);
    return () => clearInterval(timer);
  }, [attemptCalibration, requested]);

  useEffect(() => {
    let vivo = true;
    const checar = async () => {
      // Poller COMPARTILHADO: dois consumidores, uma requisição.
      const ok = await aiReachable();
      if (vivo) setGpuReachable(ok);
    };
    void checar();
    const timer = setInterval(() => void checar(), 30_000);
    return () => {
      vivo = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let active = true;
    // Compartilhado com o backtest contínuo: os dois hooks montam juntos e
    // faziam a MESMA chamada duas vezes por carga.
    void carregarProvider(() => loadProviders({}))
      .then((provider) => {
        if (active) setAIProvider(provider);
      })
      .catch(() => {
        if (active) setAIProvider(PROVIDER_DESCONHECIDO);
      });
    return () => {
      active = false;
    };
  }, [loadProviders]);

  /** Estado limpo — usado ao iniciar e ao trocar de janela. */
  const resetPipeline = useCallback((sessionId: string) => {
    sessionIdRef.current = sessionId;
    livenessRef.current = EMPTY_LIVENESS;
    visualRef.current = EMPTY_STATE;
    framesRef.current = 0;
    trackerRef.current.reset();
    analysisRef.current = null;
    decisionRef.current = null;
    gatesRef.current = [];
    operationRef.current = IDLE_OPERATION;
    timelineRef.current = null;
    entryMachineRef.current.reset();
    roiIndexRef.current = 0;
    // Outra janela, outra altura: a régua geométrica anterior não vale mais.
    baseFrameHeightRef.current = 0;
    // Outra janela é outro gráfico: emendar a escala anterior produziria preços
    // plausíveis e errados, que é o pior resultado possível.
    scaleRef.current.reset(sessionId, assetRef.current);
    lastNarratedRef.current = null;
    setScale(EMPTY_SCALE_SESSION);
    setOperation(IDLE_OPERATION);
    setTimeline(null);
    setChat([]);
  }, []);

  /**
   * UM CLIQUE, TUDO LIGADO.
   *
   * Pede a janela, confirma, zera o pipeline, liga tracker, motor, escala e
   * gravação — na mesma `sessionId`. Não existe segundo botão, confirmação de
   * timeframe nem calibração manual: tudo o que dava para deduzir da tela é
   * deduzido da tela.
   *
   * IDEMPOTENTE: clicar de novo com a leitura já rodando não abre segunda
   * sessão, não duplica listener, não reinicia timer e não zera a série. O
   * clique duplo era caminho garantido para duas séries concorrentes do mesmo
   * gráfico — e nenhuma das duas confiável.
   */
  const start = useCallback(async () => {
    if (requestedRef.current || selectingRef.current) return;
    setError(null);
    setSelecting(true);
    selectingRef.current = true;
    try {
      await screenCaptureManager.selectSource();
      // Sem espera por confirmação humana: o operador já escolheu a janela no
      // diálogo do navegador, e pedir um segundo "confirmar" seria burocracia.
      screenCaptureManager.confirmPreview();
      const sessionId = `vis_${Date.now()}`;
      resetPipeline(sessionId);
      setRequested(true);
      // A gravação sobe junto e NUNCA bloqueia: recorder que falha vira aviso,
      // não interrupção da leitura.
      const stream = screenCaptureManager.stream();
      if (stream) {
        void screenRecordingManager
          .start({ stream, sessionId, asset: assetRef.current })
          .catch((problem: unknown) => {
            narrate(
              `Gravação não iniciou: ${problem instanceof Error ? problem.message : String(problem)}. A leitura continua.`,
              "warn",
            );
          });
      }
    } catch (problem) {
      // Cancelar o diálogo é uma escolha, não uma falha: não vira erro vermelho.
      const message = problem instanceof Error ? problem.message : String(problem);
      const cancelled = /permission|denied|abort|cancel/i.test(message);
      setError(cancelled ? null : message);
      setRequested(false);
    } finally {
      setSelecting(false);
      selectingRef.current = false;
    }
  }, [narrate, resetPipeline]);

  /**
   * PARAR LEITURA — solta tudo o que foi ligado, na ordem inversa.
   *
   * `requested=false` já desliga por si o laço de calibração (o efeito depende
   * dele) e faz o callback de frame sair na primeira linha. O que resta é
   * derrubar as tracks e fechar a gravação: um MediaStream vivo mantém o ícone
   * de compartilhamento aceso e o processamento rodando por trás.
   */
  const stop = useCallback(() => {
    setRequested(false);
    requestedRef.current = false;
    screenRecordingManager.stop();
    screenCaptureManager.stop("leitura encerrada pelo operador");
    livenessRef.current = EMPTY_LIVENESS;
    setLiveness(EMPTY_LIVENESS);
  }, []);

  /** Só quando o operador pede — trocar de janela não acontece sozinho. */
  const switchSource = useCallback(async () => {
    if (selectingRef.current) return;
    setError(null);
    setSelecting(true);
    selectingRef.current = true;
    try {
      screenRecordingManager.stop();
      await screenCaptureManager.switchSource();
      screenCaptureManager.confirmPreview();
      // A série anterior era de outra janela: emendar seria misturar gráficos.
      const sessionId = `vis_${Date.now()}`;
      resetPipeline(sessionId);
      setRequested(true);
      const stream = screenCaptureManager.stream();
      if (stream) {
        void screenRecordingManager
          .start({ stream, sessionId, asset: assetRef.current })
          .catch(() => undefined);
      }
    } catch (problem) {
      const message = problem instanceof Error ? problem.message : String(problem);
      if (!/permission|denied|abort|cancel/i.test(message)) setError(message);
    } finally {
      setSelecting(false);
      selectingRef.current = false;
    }
  }, [resetPipeline]);

  /**
   * SIMULAR ENTRADA — prova que a técnica decide e que a tela reage.
   *
   * Um setup A/A+ real pode não vir por horas. Sem este botão, a primeira vez
   * que o painel de entrada é exercitado é no instante do primeiro sinal de
   * verdade — que é o pior momento possível para descobrir que ele está errado.
   *
   * A simulação NÃO toca no estado real: não mexe na máquina de entrada, na
   * linha do tempo, nos gates nem na série. A T4 continua no estágio em que
   * está, e o diagnóstico continua descrevendo o mercado. O que a simulação faz
   * é atravessar os MESMOS componentes — inclusive a guarda de preço, que é
   * justamente o que precisa ser testado antes de valer dinheiro.
   */
  const simulate = useCallback(
    (direction?: "COMPRA" | "VENDA") => {
      const now = Date.now();
      const result = simulateEntry({ analysis: analysisRef.current, direction, now });
      if (!result.ok) {
        setSimulation(null);
        setSimulationError(result.reason);
        narrate(`Simulação recusada: ${result.reason}`, "warn");
        return;
      }
      setSimulationError(null);
      // A MESMA guarda da operação real: com escala não calibrada, a simulação
      // mostra PREÇOS EM CALIBRAÇÃO em vez de coordenadas de pixel. Se isto
      // falhasse aqui, falharia na entrada real.
      const ready = scaleRef.current.snapshot().scale.priceScaleReady;
      const guarded = guardOperation(result.operation, ready) as typeof result.operation;
      setSimulation({ ...guarded, simulated: true });
      // O alerta faz parte do que está sendo testado: o operador precisa saber se
      // vai ser avisado quando a entrada real acontecer.
      playConfirmationOnce(
        guarded.setupId ?? "simulacao",
        guarded.direction === "VENDA" ? "VENDA" : "COMPRA",
        store.settings().sound,
      );
      narrate(
        `SIMULAÇÃO de ${guarded.direction} sobre a leitura atual — ${result.operation.readingSummary}. Não é sinal.`,
        "alert",
      );
    },
    [narrate],
  );

  const clearSimulation = useCallback(() => {
    setSimulation(null);
    setSimulationError(null);
  }, []);

  /**
   * TESTE DA TÉCNICA — congela a entrada bruta e o veredito deste instante.
   *
   * O bundle é auto-suficiente: quem o receber consegue reexecutar a técnica
   * sem a sessão, sem o Profit aberto e sem GPU. É o que permite responder "foi
   * a técnica ou foi a leitura?" depois que o pregão acabou.
   */
  const captureReplay = useCallback((trigger: string): VisionReplayBundle => {
    const janela = trackerRef.current.window();
    const now = Date.now();
    const marketAt = janela[janela.length - 1]?.t ?? null;
    return captureVisionReplay({
      sessionId: sessionIdRef.current,
      symbol: assetRef.current,
      sourceMode: modeRef.current,
      trigger,
      candles: janela,
      reading:
        readingRef.current ??
        visualReadingState(janela.length, 0, scaleRef.current.snapshot().scale.priceScaleReady, 0),
      priceScaleReady: scaleRef.current.snapshot().scale.priceScaleReady,
      evaluatedAt: evaluatedAtRef.current || now,
      entryState: entryMachineRef.current.current(),
      analysis: analysisRef.current,
      decision: decisionRef.current,
      t4Gates: gatesRef.current,
      operation: operationRef.current,
      timeline: timelineRef.current,
      // Em REPLAY sem eixo lido, o instante de mercado é null — nunca o
      // relógio local disfarçado de data de pregão.
      capturedAtMarket: marketStamp(modeRef.current, marketAt, now).at,
      capturedAtSystem: now,
    });
  }, []);

  /**
   * A leitura está entregando imagem utilizável AGORA?
   * É isto que libera a T4 — e o que a bloqueia quando o gráfico congela.
   */
  const reading = requested && isUsable(liveness);

  const labels = useMemo(
    () => ({ stream: streamLabel(liveness), visual: visualLabel(liveness) }),
    [liveness],
  );

  return {
    requested,
    selecting,
    reading,
    sourceMode,
    sessionId: sessionIdRef.current,
    liveness,
    streamLabel: labels.stream,
    visualLabel: labels.visual,
    visual,
    tracker,
    analysis,
    decision,
    entryState,
    operation,
    /** Prints congelados: aproximação e entrada confirmada, imutáveis. */
    evidencias,
    /** Luna/Terra do último print congelado — a porta da promoção assistida. */
    aiValidation,
    t4Gates,
    dataGates,
    timeline,
    scale,
    chat,
    aiProvider,
    gpuReachable,
    simulation,
    simulationError,
    simulate,
    clearSimulation,
    frames,
    error,
    start,
    stop,
    switchSource,
    captureReplay,
  };
}

export type ProfitVision = ReturnType<typeof useProfitVision>;
