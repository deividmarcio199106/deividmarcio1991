/**
 * O VÍDEO REPRODUZIDO COMO MERCADO — com preço, desfecho e estatística.
 *
 * A REGRA QUE MANDA AQUI: em cada instante T, a T4 vê apenas o que existia até
 * T. Não é promessa — é a forma do dado: os frames vêm de um gerador
 * assíncrono alimentado pelo fluxo do ffmpeg; não há array, não há índice,
 * não existe `frames[i + 1]`. Para ver o frame seguinte é obrigatório terminar
 * o atual, e a decisão do atual já foi registrada quando isso acontece.
 *
 * O NÚCLEO DECISÓRIO É O MESMO DO AO VIVO, na mesma ordem:
 *
 *   pixels → FrameProcessor.processPixels → projectSeries → analyze
 *          → evaluateT4Gates → decide → EntryStateMachine → evaluateOperation
 *          → LiveOutcomeTracker → createBacktestTrade → computeStats
 *
 * O QUE É ESPECÍFICO DESTA FONTE — declarado, medido e isolado no LEITOR, não
 * na decisão:
 *
 * 1. A JANELA É A TELA. O `ChartTracker` do ao vivo costura telas que quase
 *    não mudam; numa gravação acelerada a tela rola a cada frame e os candles
 *    de 1–2 px entram e saem da detecção com o anti-aliasing (medido: 69
 *    descontinuidades em 180 frames, metade dos candles batendo em ≤2 px e 40%
 *    divergindo >16 px). Então cada frame é analisado como a janela que ele é
 *    — exatamente o que o operador vê — e o alinhador estima só quantos
 *    candles entraram.
 * 2. Os últimos candles do frame ainda mudam no frame seguinte: são
 *    descartados antes de qualquer leitura. Decidir com eles seria decidir
 *    sobre candle não fechado — o que a T4 proíbe.
 * 3. O relógio de mercado avança 1 minuto por candle novo ESTIMADO — não pelo
 *    relógio da máquina. Um `Date.now()` aqui carimbaria março com hoje.
 * 4. O acompanhamento de desfecho recebe os candles novos estimados, com
 *    deduplicação por forma. É APROXIMADO: a contagem de barras esperadas pode
 *    errar na mesma proporção da estimativa, e isso está escrito no relatório.
 *
 * CONFIRMAÇÃO SEM PREÇO REAL É BLOQUEADA E CONTADA. Enquanto a escala não está
 * calibrada a estrutura é lida, mas nenhum nível é preço — e uma "entrada" em
 * unidade de pixel seria o defeito "ENTRADA 181.18 num WINFUT a 139.000".
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { FrameProcessor, type ExtractedCandleWithX } from "@/lib/capture/frameProcessor";
import { analyze } from "@/lib/engines/analysisPipeline";
import { decide, EntryStateMachine } from "@/lib/engines/backtestDecisionEngine";
import { createBacktestTrade, type BacktestTrade } from "@/lib/engines/backtestEngine";
import { resolveInstrument } from "@/lib/engines/instruments";
import { LiveOutcomeTracker, type LiveOperationResult } from "@/lib/engines/liveOutcome";
import { computeStats, type PerformanceStats } from "@/lib/engines/performanceEngine";
import { DEFAULT_RISK_PARAMS, STRATEGY_VERSION } from "@/lib/engines/strategy";
import type { AnalysisResult, Candle } from "@/lib/engines/types";
import { tradingDateOf } from "@/lib/research/quantBacktest";
import { evaluateT4Gates } from "@/lib/t4/gates";
import { evaluateOperation, type T4Operation, type T4Stage } from "@/lib/t4/preEntry";
import { buildReadingState } from "@/lib/t4/readingState";
import { ANALYSIS_WINDOW, MIN_CANDLES_FOR_ANALYSIS, regrid } from "@/lib/vision/chartTracker";
import { projectionPlausible, projectSeries } from "@/lib/vision/priceProjection";
import { AlinhadorDeReplay } from "./alinhador";
import { CalibradorDeVideo, type EstadoDaCalibracao } from "./calibration";
import type { VideoInfo } from "./ffmpeg";
import { lerFrames, salvarFramePng } from "./frames";

/** Nome oficial do estado, só para o RELATÓRIO — a técnica não muda. */
export type EstadoOficial =
  | "OBSERVANDO"
  | "OPERACAO_PROXIMA"
  | "ARMADO"
  | "OPERACAO_CONFIRMADA"
  | "EM_ACOMPANHAMENTO"
  | "FINALIZADA"
  | "INVALIDADA"
  | "AGUARDANDO";

export function nomeOficial(stage: T4Stage, acompanhando: boolean): EstadoOficial {
  if (acompanhando) return "EM_ACOMPANHAMENTO";
  switch (stage) {
    case "PREPARANDO_COMPRA":
    case "PREPARANDO_VENDA":
      return "OPERACAO_PROXIMA";
    case "GATILHO_PROXIMO":
      return "ARMADO";
    case "ENTRADA_CONFIRMADA":
      return "OPERACAO_CONFIRMADA";
    case "INVALIDADA":
      return "INVALIDADA";
    case "ENCERRADA":
      return "FINALIZADA";
    case "AGUARDANDO":
      return "AGUARDANDO";
    default:
      return "OBSERVANDO";
  }
}

export interface PontoDaLinhaDoTempo {
  segundoNoVideo: number;
  instante: number;
  estagio: T4Stage;
  oficial: EstadoOficial;
  direcao: string | null;
  maturidade: number;
  bloqueio: string | null;
  candlesNaSerie: number;
  precoReal: boolean;
  precoAtual: number | null;
  origemEscala: EstadoDaCalibracao["origem"];
}

export interface OperacaoDoVideo {
  numero: number;
  segundoNoVideo: number;
  instante: number;
  direcao: "COMPRA" | "VENDA";
  familia: string | null;
  entrada: number;
  stop: number;
  alvo1: number;
  alvo2: number;
  rr: number;
  escala: { origem: string; r2: number; desvioPx: number; precoPorPixel: number | null };
  frameDeProva: string | null;
  resultado: "GANHO" | "PERDA" | "NEUTRO" | "NAO_EXECUTADA" | "EM_ABERTO" | "DESCARTADA" | null;
  r: number | null;
  pontos: number | null;
  saida: number | null;
  motivoSaida: string | null;
  candlesObservados: number | null;
  encerradaEmSeg: number | null;
}

export interface ResultadoDaSessao {
  video: string;
  ativo: string;
  fps: number;
  framesLidos: number;
  framesProcessados: number;
  framesDuplicados: number;
  framesAnalisados: number;
  framesComPreco: number;
  framesSemPreco: number;
  candlesExtraidos: number;
  candlesNovosEstimados: number;
  descontinuidades: number;
  concordanciaMediaDoAlinhamento: number | null;
  analisesRodadas: number;
  calibracao: {
    ocrChamadas: number;
    ocrFalhas: number;
    propagacoes: number;
    propagacaoCorrigida: number;
    taxaFramesCalibrados: number;
    r2Medio: number | null;
    desvioMaxPx: number | null;
    desvioMedioPx: number | null;
    motivos: Record<string, number>;
  };
  porEstagio: Record<string, number>;
  porEstadoOficial: Record<string, number>;
  transicoes: PontoDaLinhaDoTempo[];
  operacoes: OperacaoDoVideo[];
  setupsDetectados: number;
  confirmacoesBloqueadasSemPreco: number;
  descartes: Record<string, number>;
  trades: BacktestTrade[];
  stats: PerformanceStats | null;
  ganhos: number;
  perdas: number;
  neutros: number;
  pontosLiquidos: number;
  erro: string | null;
}

export interface OpcoesDaSessao {
  ativo: string;
  fps?: number;
  inicioSeg?: number;
  fimSeg?: number;
  /** Instante de mercado do segundo zero do vídeo. Sintético e declarado. */
  baseDeMercado: number;
  larguraMaxima?: number;
  /** Pasta para frames de prova, log por frame e resultado. */
  pastaDeSaida?: string;
  /** Candles instáveis na borda direita, descartados antes de ler. */
  candlesInstaveisNaBorda?: number;
  intervaloOcrSeg?: number;
  /** Candles de espera pela execução após a confirmação. */
  maxWaitBars?: number;
  aoProgredir?: (p: { frames: number; segundo: number; operacoes: number; trades: number }) => void;
}

const SEM_RISCO = { accountBalance: 0, maxRiskPercent: 0, maxRiskMoney: 0, contractsLimit: 0 };

function mesmoCandle(a: Candle, b: Candle): boolean {
  return (
    Math.abs(a.o - b.o) <= 1 &&
    Math.abs(a.h - b.h) <= 1 &&
    Math.abs(a.l - b.l) <= 1 &&
    Math.abs(a.c - b.c) <= 1
  );
}

export async function rodarVideoComoMercado(
  info: VideoInfo,
  opcoes: OpcoesDaSessao,
): Promise<ResultadoDaSessao> {
  const fps = opcoes.fps ?? 6;
  const borda = opcoes.candlesInstaveisNaBorda ?? 2;
  const maxWaitBars = opcoes.maxWaitBars ?? 10;
  const pasta = opcoes.pastaDeSaida ?? null;
  if (pasta !== null) mkdirSync(pasta, { recursive: true });
  const nomeDoVideo = info.caminho.split(/[\\/]/).pop() ?? "video";
  const logPorFrame = pasta !== null ? join(pasta, `${nomeDoVideo}.frames.ndjson`) : null;
  if (logPorFrame !== null) writeFileSync(logPorFrame, "");

  const processor = new FrameProcessor();
  const alinhador = new AlinhadorDeReplay();
  const machine = new EntryStateMachine();
  const calibrador = new CalibradorDeVideo(opcoes.ativo, {
    ...(opcoes.intervaloOcrSeg === undefined ? {} : { intervaloOcrSeg: opcoes.intervaloOcrSeg }),
  });
  const instrument = resolveInstrument(opcoes.ativo);
  const sourceCaptureId = `video_${nomeDoVideo}_${opcoes.baseDeMercado}`;

  const r: ResultadoDaSessao = {
    video: info.caminho,
    ativo: opcoes.ativo,
    fps,
    framesLidos: 0,
    framesProcessados: 0,
    framesDuplicados: 0,
    framesAnalisados: 0,
    framesComPreco: 0,
    framesSemPreco: 0,
    candlesExtraidos: 0,
    candlesNovosEstimados: 0,
    descontinuidades: 0,
    concordanciaMediaDoAlinhamento: null,
    analisesRodadas: 0,
    calibracao: {
      ocrChamadas: 0,
      ocrFalhas: 0,
      propagacoes: 0,
      propagacaoCorrigida: 0,
      taxaFramesCalibrados: 0,
      r2Medio: null,
      desvioMaxPx: null,
      desvioMedioPx: null,
      motivos: {},
    },
    porEstagio: {},
    porEstadoOficial: {},
    transicoes: [],
    operacoes: [],
    setupsDetectados: 0,
    confirmacoesBloqueadasSemPreco: 0,
    descartes: {},
    trades: [],
    stats: null,
    ganhos: 0,
    perdas: 0,
    neutros: 0,
    pontosLiquidos: 0,
    erro: null,
  };
  const descartar = (motivo: string): void => {
    r.descartes[motivo] = (r.descartes[motivo] ?? 0) + 1;
  };

  let relogio = opcoes.baseDeMercado;
  let anterior: T4Operation | null = null;
  let estagioAnterior: string | null = null;
  let concSoma = 0;
  let concN = 0;
  let r2Soma = 0;
  let desvioSoma = 0;
  let desvioMax = 0;
  let calibrados = 0;

  let rastreador: LiveOutcomeTracker | null = null;
  let congelada: AnalysisResult | null = null;
  let operacaoAberta: OperacaoDoVideo | null = null;
  let ultimoEmpurrado: Candle | null = null;

  const encerrarAberta = (
    motivo: string,
    resultado: OperacaoDoVideo["resultado"],
    seg: number,
  ): void => {
    descartar(motivo);
    if (operacaoAberta) {
      operacaoAberta.resultado = resultado;
      operacaoAberta.motivoSaida = motivo;
      operacaoAberta.encerradaEmSeg = seg;
    }
    rastreador = null;
    congelada = null;
    operacaoAberta = null;
    ultimoEmpurrado = null;
    machine.reset();
  };

  const finalizar = (res: LiveOperationResult, ultimo: Candle, segundo: number): void => {
    const frozen = congelada;
    const op = operacaoAberta;
    rastreador = null;
    congelada = null;
    operacaoAberta = null;
    ultimoEmpurrado = null;
    machine.reset();
    if (!frozen || !op) return;
    if (!res.filled || res.result === null || res.rMultiple === null) {
      descartar("setups_expirados_sem_execucao");
      op.resultado = "NAO_EXECUTADA";
      op.encerradaEmSeg = segundo;
      op.motivoSaida = res.detail;
      return;
    }
    const trade = createBacktestTrade({
      analysis: frozen,
      asset: opcoes.ativo,
      sourceCaptureId,
      origin: "BACKTEST",
      closedAt: res.exitAt ?? ultimo.t,
      entryHitAt: res.entryHitAt,
      partialHitAt: res.partialHitAt,
      exitAt: res.exitAt,
      exit: res.exit ?? frozen.price,
      result: res.result,
      rMultiple: res.rMultiple,
      mfeMae:
        res.mfePoints !== null && res.maePoints !== null
          ? { mfePoints: res.mfePoints, maePoints: res.maePoints, mfeR: res.mfeR, maeR: res.maeR }
          : null,
      exitReason: res.exitReason,
      ambiguousIntrabar: res.ambiguousIntrabar,
      tradingDate: tradingDateOf(frozen.t),
      productionTechniqueVersion: STRATEGY_VERSION,
    });
    if (trade !== null) r.trades.push(trade);
    op.resultado = res.result;
    op.r = res.rMultiple;
    op.pontos = res.rMultiple * Math.abs(op.entrada - op.stop);
    op.saida = res.exit;
    op.motivoSaida = res.exitReason;
    op.candlesObservados = res.candlesObserved;
    op.encerradaEmSeg = segundo;
    if (res.result === "GANHO") r.ganhos++;
    else if (res.result === "PERDA") r.perdas++;
    else r.neutros++;
    r.pontosLiquidos += op.pontos ?? 0;
  };

  try {
    for await (const f of lerFrames(info, {
      fps,
      ...(opcoes.inicioSeg === undefined ? {} : { inicioSeg: opcoes.inicioSeg }),
      ...(opcoes.fimSeg === undefined ? {} : { fimSeg: opcoes.fimSeg }),
      ...(opcoes.larguraMaxima === undefined ? {} : { larguraMaxima: opcoes.larguraMaxima }),
    })) {
      r.framesLidos++;
      if (opcoes.aoProgredir && r.framesLidos % 200 === 0) {
        opcoes.aoProgredir({
          frames: r.framesLidos,
          segundo: f.segundoNoVideo,
          operacoes: r.operacoes.length,
          trades: r.trades.length,
        });
      }

      const read = processor.processPixels(f.frame, relogio);
      if (read === null) {
        r.framesDuplicados++;
        continue;
      }
      r.framesProcessados++;
      r.candlesExtraidos += read.candles.length;

      // Calibração: propaga quando pode, lê quando precisa.
      const calib = await calibrador.atualizar(f.frame, f.segundoNoVideo);
      if (calib.motivo !== null) {
        r.calibracao.motivos[calib.motivo] = (r.calibracao.motivos[calib.motivo] ?? 0) + 1;
      }

      // A borda direita ainda muda no próximo frame: fora de tudo.
      const estaveis: ExtractedCandleWithX[] =
        borda > 0 ? read.candles.slice(0, -borda) : read.candles;
      if (estaveis.length < MIN_CANDLES_FOR_ANALYSIS) continue;

      const alin = alinhador.alinhar(estaveis);
      if (alin.descontinuidade) {
        r.descontinuidades++;
        // Salto de período: o relógio pula uma sessão, declaradamente.
        relogio += 24 * 60 * 60_000;
        if (rastreador !== null) {
          encerrarAberta("descontinuidade_com_operacao_aberta", "DESCARTADA", f.segundoNoVideo);
        }
      } else {
        concSoma += alin.concordancia;
        concN++;
      }
      const novos = alin.descontinuidade ? 0 : alin.novos;
      relogio += novos * 60_000;
      r.candlesNovosEstimados += novos;

      // A JANELA É A TELA: os candles estáveis deste frame, com t regridado.
      const janela = regrid(estaveis.slice(-ANALYSIS_WINDOW), relogio);
      const projecao = { baseHeight: f.frame.height, calibration: calib.calibracao };
      const projetada = projectSeries(janela, projecao);
      const precoReal = calib.utilizavel && projectionPlausible(projetada, opcoes.ativo);
      const serie = precoReal ? projetada : janela;
      if (precoReal) {
        r.framesComPreco++;
        calibrados++;
        r2Soma += calib.r2;
        desvioSoma += calib.desvioMaxPx;
        desvioMax = Math.max(desvioMax, calib.desvioMaxPx);
      } else {
        r.framesSemPreco++;
      }
      r.framesAnalisados++;
      const precoAtual = precoReal ? (serie[serie.length - 1]?.c ?? null) : null;

      // 1. Operação aberta: só o DESFECHO avança (paridade com o quant).
      if (rastreador !== null) {
        if (!precoReal) {
          encerrarAberta("perdeu_escala_com_operacao_aberta", "DESCARTADA", f.segundoNoVideo);
        } else {
          const recentes = novos > 0 ? serie.slice(-Math.min(novos, serie.length)) : [];
          for (const c of recentes) {
            if (ultimoEmpurrado !== null && mesmoCandle(ultimoEmpurrado, c)) continue;
            ultimoEmpurrado = c;
            const res = rastreador.push(c);
            if (res.done) {
              finalizar(res, c, f.segundoNoVideo);
              break;
            }
          }
        }
        if (rastreador !== null) {
          r.porEstadoOficial["EM_ACOMPANHAMENTO"] =
            (r.porEstadoOficial["EM_ACOMPANHAMENTO"] ?? 0) + 1;
          descartar("reservado_ao_desfecho");
          continue;
        }
      }

      const reading = buildReadingState({
        closedCandles: serie.length,
        quality: Math.round(read.quality * 100),
        priceScaleReady: precoReal,
        calibrationConfidence: precoReal ? calib.confianca : 0,
      });
      const analise = analyze(serie, { reading, riskParams: DEFAULT_RISK_PARAMS });
      if (analise === null) continue;
      r.analisesRodadas++;

      const gates = evaluateT4Gates(analise, true);
      const decidida = decide({
        analysis: analise,
        asset: opcoes.ativo,
        trades: [],
        techniqueSnapshot: STRATEGY_VERSION,
        instrument,
        riskConfig: SEM_RISCO,
        mode: "BACKTEST_DISCOVERY",
      });
      const state = machine.onDecision(decidida);
      const operacao = evaluateOperation({
        dataReady: true,
        dataGates: [],
        t4Gates: gates,
        analysis: analise,
        decision: decidida,
        entryState: machine.current(),
        previous: anterior,
        now: relogio,
      });
      anterior = operacao;

      r.porEstagio[operacao.stage] = (r.porEstagio[operacao.stage] ?? 0) + 1;
      const oficial = nomeOficial(operacao.stage, false);
      r.porEstadoOficial[oficial] = (r.porEstadoOficial[oficial] ?? 0) + 1;

      if (operacao.stage !== estagioAnterior) {
        estagioAnterior = operacao.stage;
        r.transicoes.push({
          segundoNoVideo: f.segundoNoVideo,
          instante: relogio,
          estagio: operacao.stage,
          oficial,
          direcao: analise.direction ?? null,
          maturidade: operacao.maturity,
          bloqueio: operacao.blockReason ?? null,
          candlesNaSerie: serie.length,
          precoReal,
          precoAtual,
          origemEscala: calib.origem,
        });
      }

      if (logPorFrame !== null) {
        appendFileSync(
          logPorFrame,
          JSON.stringify({
            seg: f.segundoNoVideo,
            relogio,
            estagio: operacao.stage,
            oficial,
            mat: operacao.maturity,
            bloqueio: operacao.blockReason ?? null,
            dir: analise.direction,
            precoReal,
            escala: calib.origem,
            r2: precoReal ? Number(calib.r2.toFixed(5)) : null,
            ppx: calib.precoPorPixel,
            precoAtual,
            novos,
            conc: Number(alin.concordancia.toFixed(2)),
            serie: serie.length,
            calibMotivo: calib.motivo,
          }) + "\n",
        );
      }

      // 2. Confirmação: só com preço real. Em pixel, bloqueada e contada.
      const plan = analise.plan;
      if (
        state === "CONFIRMED" &&
        operacao.confirmed &&
        plan !== null &&
        (analise.direction === "COMPRA" || analise.direction === "VENDA")
      ) {
        if (!precoReal) {
          r.confirmacoesBloqueadasSemPreco++;
          descartar("confirmacao_bloqueada_sem_preco");
          machine.reset();
          continue;
        }
        congelada = structuredClone(analise);
        rastreador = new LiveOutcomeTracker(
          analise.direction,
          plan.entry,
          plan.stop,
          plan.target1,
          plan.target2,
          maxWaitBars,
          { threeContractRunner: true },
        );
        ultimoEmpurrado = serie[serie.length - 1] ?? null;
        r.setupsDetectados++;
        const numero = r.operacoes.length + 1;
        let frameDeProva: string | null = null;
        if (pasta !== null) {
          const caminho = join(
            pasta,
            `${nomeDoVideo}.confirmada_${numero}_${f.segundoNoVideo.toFixed(2)}s.png`,
          );
          frameDeProva = salvarFramePng(f.frame, caminho) ? caminho : null;
        }
        operacaoAberta = {
          numero,
          segundoNoVideo: f.segundoNoVideo,
          instante: relogio,
          direcao: analise.direction,
          familia: analise.t4.setup,
          entrada: plan.entry,
          stop: plan.stop,
          alvo1: plan.target1,
          alvo2: plan.target2,
          rr: plan.riskReward,
          escala: {
            origem: calib.origem,
            r2: calib.r2,
            desvioPx: calib.desvioMaxPx,
            precoPorPixel: calib.precoPorPixel,
          },
          frameDeProva,
          resultado: "EM_ABERTO",
          r: null,
          pontos: null,
          saida: null,
          motivoSaida: null,
          candlesObservados: null,
          encerradaEmSeg: null,
        };
        r.operacoes.push(operacaoAberta);
        r.transicoes.push({
          segundoNoVideo: f.segundoNoVideo,
          instante: relogio,
          estagio: operacao.stage,
          oficial: "OPERACAO_CONFIRMADA",
          direcao: analise.direction,
          maturidade: operacao.maturity,
          bloqueio: null,
          candlesNaSerie: serie.length,
          precoReal,
          precoAtual,
          origemEscala: calib.origem,
        });
      }
    }
  } catch (error) {
    r.erro = String(error).slice(0, 500);
  }

  if (rastreador !== null) {
    descartar("operacoes_em_aberto_no_fim");
    if (operacaoAberta) operacaoAberta.resultado = "EM_ABERTO";
  }

  r.concordanciaMediaDoAlinhamento = concN > 0 ? concSoma / concN : null;
  const estadoCal = calibrador.snapshot(1);
  r.calibracao.ocrChamadas = estadoCal.ocrChamadas;
  r.calibracao.ocrFalhas = estadoCal.ocrFalhas;
  r.calibracao.propagacoes = estadoCal.propagacoes;
  r.calibracao.propagacaoCorrigida = estadoCal.propagacaoCorrigida;
  r.calibracao.taxaFramesCalibrados = r.framesAnalisados > 0 ? calibrados / r.framesAnalisados : 0;
  r.calibracao.r2Medio = calibrados > 0 ? r2Soma / calibrados : null;
  r.calibracao.desvioMedioPx = calibrados > 0 ? desvioSoma / calibrados : null;
  r.calibracao.desvioMaxPx = calibrados > 0 ? desvioMax : null;
  r.stats = r.trades.length > 0 ? computeStats(r.trades) : null;
  if (pasta !== null) {
    writeFileSync(join(pasta, `${nomeDoVideo}.resultado.json`), JSON.stringify(r, null, 1));
  }
  return r;
}
