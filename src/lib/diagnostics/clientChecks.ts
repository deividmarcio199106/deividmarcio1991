/**
 * Auditoria executada NO NAVEGADOR.
 *
 * A captura de tela é local ao operador: o servidor não vê o `MediaStream`, não
 * sabe se os pixels estão mudando e não pode contar candle nenhum. Por isso a
 * prova do caminho de dado tem que nascer AQUI — fazer o servidor afirmar que a
 * leitura está boa seria inventar saúde.
 *
 * O QUE MUDOU: esta auditoria media a bridge RTD — HTTP em 127.0.0.1, handshake
 * de WebSocket, ticks aceitos. Nada disso existe mais no runtime. Um relatório
 * que continuasse aprovando ou reprovando a bridge estaria descrevendo um
 * caminho que não roda, e um SCORE construído sobre isso não vale nada.
 *
 * Cada função abaixo mede alguma coisa de verdade: contexto seguro, suporte a
 * `getDisplayMedia`, pixels chegando, candles entrando na série, escala com
 * motivo, endpoint respondendo. Nada é aprovado por presunção.
 */

import { check, summarize, type CheckResult, type DiagnosticsReport } from "./types";
import type { VisionDiagnostics } from "@/lib/vision/visionDiagnostics";
import { MIN_CANDLES_FOR_ANALYSIS } from "@/lib/vision/chartTracker";

async function checkFrontend(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const https = typeof window !== "undefined" && window.location.protocol === "https:";
  results.push(
    check({
      id: "FRONTEND_CONTEXT",
      domain: "FRONTEND",
      label: "Contexto da página",
      status: "PASS",
      observed: `${window.location.origin} · ${https ? "HTTPS" : "HTTP"}`,
      impact: "Nenhum.",
      fix: "Nada a fazer.",
      proven: true,
    }),
  );

  /*
   * `getDisplayMedia` só existe em contexto seguro. Sem ele NADA funciona — e o
   * navegador falha com uma mensagem genérica que manda o operador procurar o
   * problema no Profit, que está intacto.
   */
  const secure = typeof window !== "undefined" && window.isSecureContext;
  const supported =
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function";
  results.push(
    check({
      id: "CAPTURE_API",
      domain: "FRONTEND",
      label: "API de captura de tela",
      status: secure && supported ? "PASS" : "FAIL",
      observed: `contexto ${secure ? "seguro" : "INSEGURO"} · getDisplayMedia ${supported ? "disponível" : "ausente"}`,
      cause: secure
        ? supported
          ? null
          : "Navegador sem suporte a captura de tela."
        : "Página fora de HTTPS/localhost: o navegador bloqueia a captura.",
      impact: "Sem captura não há pixel, não há candle e a T4 não lê nada.",
      fix: secure
        ? "Use um navegador baseado em Chromium atualizado."
        : "Abra o analisador por HTTPS ou por http://localhost.",
      proven: true,
    }),
  );

  return results;
}

/**
 * Estado REAL do pipeline visual, lido da fonte única.
 *
 * Nenhum destes checks recalcula nada: todos leem `visionDiagnostics`, que é o
 * mesmo objeto que a Operação ao Vivo mostra. Recalcular aqui produziria um
 * segundo veredito sobre o mesmo instante — e foi exatamente essa duplicidade
 * que fez o painel mentir antes.
 */
function checkVisionPipeline(d: VisionDiagnostics): CheckResult[] {
  const results: CheckResult[] = [];

  results.push(
    check({
      id: "CAPTURE_ACTIVE",
      domain: "FEED",
      label: "Captura entregando imagem",
      status: !d.captureActive ? "SKIPPED" : "PASS",
      observed: d.captureActive
        ? `${d.captureLabel} · ${Math.round(d.fps)} fps · ${d.framesReceived} frames`
        : "Leitura não iniciada.",
      cause: null,
      impact: "Sem imagem utilizável a T4 não avalia nada.",
      fix: "Clique em INICIAR LEITURA DO PROFIT e escolha a janela do gráfico.",
      proven: d.captureActive,
    }),
  );

  results.push(
    check({
      id: "PIXELS_CHANGING",
      domain: "FEED",
      label: "Gráfico se movendo",
      status: !d.captureActive ? "SKIPPED" : d.pixelsChanging ? "PASS" : "WARNING",
      observed: `${d.chartLabel} · parado há ${Math.round(d.staticForMs / 1000)}s`,
      // IMAGEM PARADA NÃO É CAPTURA MORTA. Confundir as duas foi o bug que
      // derrubou a T4 no Golden: o mercado pode simplesmente não estar andando.
      cause: d.pixelsChanging
        ? null
        : "A imagem não varia: mercado parado, janela minimizada ou coberta.",
      impact: "Nenhuma confirmação nova é emitida sobre uma imagem congelada.",
      fix: "Deixe a janela do Profit visível e não minimizada.",
      proven: d.captureActive,
    }),
  );

  results.push(
    check({
      id: "CANDLE_PARSE",
      domain: "CANDLES",
      label: "Candles reconstruídos da tela",
      status: !d.captureActive
        ? "SKIPPED"
        : d.candlesParsed > 0
          ? "PASS"
          : d.candlesVisible > 0
            ? "FAIL"
            : "WARNING",
      observed: `${d.candlesVisible} visíveis · ${d.candlesParsed} aproveitados · ${d.closedCandlesAccepted} na série`,
      // A diferença entre VISÍVEIS e APROVEITADOS é o que denuncia o detector:
      // candle na tela e nada entrando na série é defeito de leitura, não de
      // mercado.
      cause: d.rejectReason,
      impact: "Sem candle na série a técnica não tem o que ler.",
      fix: d.rejectReason ?? "Confira zoom, tema e se o gráfico está inteiro na janela.",
      proven: d.captureActive,
    }),
  );

  results.push(
    check({
      id: "HISTORY_READY",
      domain: "HISTORY",
      label: "Histórico suficiente",
      status: !d.captureActive
        ? "SKIPPED"
        : d.bootstrapProgress >= MIN_CANDLES_FOR_ANALYSIS
          ? "PASS"
          : "WARNING",
      observed: `${d.bootstrapProgress}/${MIN_CANDLES_FOR_ANALYSIS} candles fechados`,
      cause: null,
      impact: "Abaixo do mínimo a T4 fica em COLETANDO HISTÓRICO — por desenho.",
      fix: "Aguarde a série completar, ou amplie o histórico visível no Profit.",
      proven: d.closedCandlesAccepted > 0,
    }),
  );

  results.push(
    check({
      id: "MARKET_DATE",
      domain: "TIMESTAMP",
      label: "Data do pregão",
      status: d.dateTrusted ? "PASS" : d.sourceMode === "LIVE" ? "WARNING" : "FAIL",
      observed: `${d.marketDate ?? "não lida"} · modo ${d.sourceMode} · fonte ${d.timeSource}`,
      // Em REPLAY, data não lida é FALHA: deixar o relógio do sistema carimbar
      // um pregão de março com a data de hoje produz um Golden que parece
      // provar e não prova nada.
      cause: d.dateTrusted
        ? null
        : d.sourceMode === "REPLAY"
          ? "Replay sem leitura do eixo de tempo: nenhuma data pode ser afirmada."
          : "Eixo de tempo ainda não lido; ao vivo o pregão corrente é referência válida.",
      impact: "Data errada contamina candles, marcos do setup, registros e o Golden.",
      fix: "Deixe o eixo de tempo do Profit visível na janela compartilhada.",
      proven: true,
    }),
  );

  results.push(
    check({
      id: "PRICE_SCALE",
      domain: "PRICE",
      label: "Escala de preço",
      status: d.priceScaleReady ? "PASS" : d.scaleReject === null ? "SKIPPED" : "WARNING",
      observed: d.priceScaleReady
        ? `${d.anchors} âncoras · R² ${d.scaleR2?.toFixed(4) ?? "—"} · cache ${d.cache}`
        : `${d.scaleReject ?? "aguardando primeira leitura"} · ${d.scaleAttempts} tentativa(s)`,
      // NUNCA "CALIBRANDO" sem motivo: cada código aponta para um conserto
      // diferente, e sem ele o operador procura no lugar errado.
      cause: d.scaleRejectDetail,
      impact:
        "A leitura estrutural NÃO depende disto. Sem escala, os níveis saem em unidade de pixel e nenhum preço exato é publicado.",
      fix:
        d.scaleReject === "GPU_OFFLINE"
          ? "Verifique o túnel para o Ollama e o modelo de visão configurado."
          : d.scaleReject === "TIMEOUT"
            ? "O modelo respondeu fora do prazo: confira a carga da GPU."
            : "Deixe a escala de preços do Profit visível na borda direita da janela.",
      proven: d.scaleAttempts > 0,
    }),
  );

  results.push(
    check({
      id: "T4_ENGINE",
      domain: "T4",
      label: "Motor T4",
      // MOTOR e SETUP são perguntas diferentes: maturidade 0% com o motor
      // ANALISANDO é um pregão sem oportunidade, não um software parado.
      status:
        d.t4Engine === "ANALISANDO"
          ? "PASS"
          : d.t4Engine === "PAUSADO_DADO"
            ? "FAIL"
            : d.t4Engine === "COLETANDO_HISTORICO"
              ? "WARNING"
              : "SKIPPED",
      observed: `${d.t4Engine} · estado ${d.t4Flow} · maturidade ${d.t4Percent}% · ${d.bias}`,
      cause: d.blockReason,
      impact:
        d.t4Engine === "PAUSADO_DADO"
          ? "A leitura caiu: nenhuma confirmação nova será emitida."
          : "Nenhum: maturidade baixa é leitura de mercado, não defeito.",
      fix: d.blockReason ?? "Nada a fazer.",
      proven: d.captureActive,
    }),
  );

  return results;
}

async function checkServerApi(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const endpoints = [
    { path: "/api/health", domain: "API" as const, id: "API_HEALTH" },
    { path: "/api/t4/health", domain: "T4" as const, id: "API_T4_HEALTH" },
  ];

  for (const endpoint of endpoints) {
    const startedAt = Date.now();
    try {
      const response = await fetch(endpoint.path, {
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      });
      const body = (await response.json()) as { status?: string };
      results.push(
        check({
          id: endpoint.id,
          domain: endpoint.domain,
          label: `Endpoint ${endpoint.path}`,
          status: response.ok ? "PASS" : "FAIL",
          observed: `HTTP ${response.status} · status "${body.status ?? "?"}" em ${Date.now() - startedAt}ms`,
          cause: response.ok ? null : "O backend respondeu com falha.",
          impact: response.ok ? "Nenhum." : "Backend degradado; verifique os logs do processo.",
          fix: response.ok ? "Nada a fazer." : "Leia a resposta completa em /api/diagnostics.",
          proven: true,
          durationMs: Date.now() - startedAt,
        }),
      );
    } catch (error) {
      results.push(
        check({
          id: endpoint.id,
          domain: endpoint.domain,
          label: `Endpoint ${endpoint.path}`,
          status: "FAIL",
          observed: error instanceof Error ? error.message : String(error),
          cause: "Backend inacessível a partir do navegador.",
          impact: "Persistência e diagnóstico do servidor indisponíveis.",
          fix: "Confirme que o servidor está no ar e que o proxy encaminha /api.",
          proven: true,
          durationMs: Date.now() - startedAt,
        }),
      );
    }
  }

  // O relatório do servidor entra inteiro: os checks dele já vêm no formato.
  try {
    const response = await fetch("/api/diagnostics", {
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
    const report = (await response.json()) as DiagnosticsReport;
    if (Array.isArray(report.checks)) results.push(...report.checks);
  } catch (error) {
    results.push(
      check({
        id: "API_DIAGNOSTICS",
        domain: "API",
        label: "Diagnóstico do servidor",
        status: "FAIL",
        observed: error instanceof Error ? error.message : String(error),
        cause: "Falha ao consultar /api/diagnostics.",
        impact: "Backend, banco, ambiente e IA ficam sem verificação.",
        fix: "Verifique o processo do servidor e os logs.",
        proven: true,
      }),
    );
  }

  return results;
}

export interface ClientDiagnosticsInput {
  /** A MESMA fonte que a Operação ao Vivo lê. */
  diagnostics: VisionDiagnostics;
}

export async function runClientDiagnostics(
  input: ClientDiagnosticsInput,
): Promise<DiagnosticsReport> {
  const startedAt = Date.now();
  const checks: CheckResult[] = [];

  checks.push(...(await checkFrontend()));
  checks.push(...checkVisionPipeline(input.diagnostics));
  checks.push(...(await checkServerApi()));

  return summarize(checks, Date.now() - startedAt);
}
