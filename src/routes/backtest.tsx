import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { Pause, Play, Power, RotateCcw, ShieldAlert } from "lucide-react";

import { AnalysisCockpit } from "@/components/analysis/AnalysisCockpit";
import { latestAiValidation } from "@/lib/aiPrintValidation.functions";
import { useAnalyzer } from "@/components/AnalyzerProvider";
import { AnalystAssistant } from "@/components/learning/AnalystAssistant";
import { CaptureConsole } from "@/components/live/CaptureConsole";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isSecureContextAvailable } from "@/lib/capture/screenCapture";
import { computeT4Progress } from "@/lib/t4/progress";
import { evaluateEvidence } from "@/lib/engines/evidenceValidation";
import {
  computeDailyPerformance,
  computePointStats,
  computeStats,
  groupBy,
} from "@/lib/engines/performanceEngine";
import { filterEvidenceTrades } from "@/lib/engines/evidenceFilter";
import { store, type ReplayRecordingRecord } from "@/lib/storage";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/backtest")({
  component: BacktestPage,
  head: () => ({ meta: [{ title: "Backtest — NEXUS T4" }] }),
});

/**
 * BACKTEST POR OBSERVAÇÃO CONTÍNUA DA MESMA TELA COMPARTILHADA.
 *
 * Mesmo botão, mesma engine de captura e mesmo cockpit da Operação ao Vivo. A
 * diferença é só o gráfico: aqui é o histórico e o usuário o navega no Profit.
 * A IA acompanha continuamente, congela cada decisão em T (sem ver o futuro) e
 * salva pregões, eventos e operações no banco enquanto observa.
 */
function BacktestPage() {
  // Sessão de backtest vive no AnalyzerProvider (layout raiz): navegar entre
  // rotas não interrompe a observação nem zera a sequência costurada.
  const { backtest, backtestAsset: asset, setBacktestAsset: setAsset } = useAnalyzer();
  const [sessions, setSessions] = useState<ReplayRecordingRecord[]>([]);
  const [revision, setRevision] = useState(0);
  const [startErrors, setStartErrors] = useState<string[]>([]);
  const [insecureContext, setInsecureContext] = useState(false);
  /*
   * LINHAS REAIS DA TRILHA OPENAI (BLOCO 6): o painel de validação deixou de
   * receber placeholder. O backtest não gera validação própria (a Luna roda
   * no caminho de captura ao vivo), então aqui a fonte é a ÚLTIMA validação
   * PERSISTIDA — o estado verdadeiro da trilha, inclusive "nenhuma ainda".
   */
  const fetchAiRows = useServerFn(latestAiValidation);
  const [aiRows, setAiRows] = useState<{
    luna: string;
    terra: string;
    t4: string;
    veredito: string;
  } | null>(null);
  useEffect(() => {
    let active = true;
    const carregar = () =>
      void fetchAiRows()
        .then((r) => {
          if (active) setAiRows(r.rows);
        })
        .catch(() => {
          // Servidor fora não inventa linha: o painel mostra o vazio real.
        });
    carregar();
    const timer = setInterval(carregar, 60_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [fetchAiRows]);
  const observing = backtest.phase === "observando";
  const running = observing || backtest.phase === "pausado";

  const progress = computeT4Progress({
    sessionActive: observing || backtest.phase === "pausado",
    diagnostics: backtest.diagnostics,
    analysis: backtest.analysis,
    decisionEvaluated: backtest.decision !== null,
    snapshot: backtest.signalSnapshot,
  });

  useEffect(() => setInsecureContext(!isSecureContextAvailable()), []);

  useEffect(() => {
    let active = true;
    void store.hydrate().then(() => {
      if (!active) return;
      setSessions(store.replaySessions());
      setRevision((value) => value + 1);
    });
    const timer = setInterval(() => {
      setSessions(store.replaySessions());
      setRevision((value) => value + 1);
    }, 3_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const start = async () => {
    setStartErrors([]);
    if (backtest.chart.status === "sem-fonte") {
      const selected = await backtest.selectScreen();
      if (!selected) {
        setStartErrors(["Não foi possível iniciar o compartilhamento da janela do Profit."]);
        return;
      }
      // Um clique só: selecionou a janela, o gráfico aparece e o Backtest já
      // começa a estudar. A calibração de preço segue em paralelo.
      setStartErrors(backtest.start());
      return;
    }
    setStartErrors(backtest.start());
  };

  const base = useMemo(() => {
    const records = store.backtests();
    // §28: LEGACY_IMAGE fica só como histórico — fora da evidência por padrão.
    const trades = filterEvidenceTrades(records);
    const legacyCount = records
      .filter((record) => (record.origin ?? "LEGACY_IMAGE") === "LEGACY_IMAGE")
      .reduce((sum, record) => sum + record.trades.length, 0);
    const stats = computeStats(trades);
    const pointStats = computePointStats(trades);
    const analyzedDates = store
      .tradingSessions()
      .filter((session) => session.source === "VIDEO_REPLAY" && session.tradingDate)
      .map((session) => session.tradingDate!)
      .filter((date, index, list) => list.indexOf(date) === index);
    const daily = computeDailyPerformance(trades, analyzedDates);
    const daysGain = daily.filter((day) => day.status === "GAIN").length;
    const daysLoss = daily.filter((day) => day.status === "LOSS").length;
    const daysNoTrade = daily.filter((day) => day.status === "SEM_OPERACAO").length;
    const evidence = evaluateEvidence(trades);
    const bySetup = groupBy(trades, (trade) => trade.setup);
    const byHour = groupBy(trades, (trade) => `${trade.hour}h`);
    const byOrigin = new Map<string, number>();
    for (const record of records) {
      const origin = record.origin ?? "LEGACY_IMAGE";
      byOrigin.set(origin, (byOrigin.get(origin) ?? 0) + record.trades.length);
    }
    const context = [
      `Base histórica: ${records.length} sessões, ${trades.length} operações (${[...byOrigin.entries()].map(([k, v]) => `${k}: ${v}`).join(", ") || "vazia"}).`,
      trades.length
        ? `Desempenho: acerto ${stats.winRate.toFixed(1)}%, expectância ${stats.expectancy.toFixed(2)}R, PF ${Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : "n/d"}, drawdown ${stats.maxDrawdown.toFixed(1)}R.`
        : "Base vazia — compartilhe o gráfico histórico e navegue nele para construir evidência.",
      `Validação: OOS ${evidence.oosValidated ? "positivo" : "não validado"}, walk-forward ${evidence.walkForward.stable ? "estável" : "não estável"}, confiança da evidência ${evidence.confidence}.`,
      `Por setup: ${bySetup.map((s) => `${s.key} (${s.total} ops, ${s.r.toFixed(2)}R)`).join(" | ") || "—"}.`,
      "Trate qualquer melhoria como hipótese até existir amostra mínima e validação fora da amostra.",
    ].join("\n");
    return {
      records,
      trades,
      stats,
      pointStats,
      daily,
      daysGain,
      daysLoss,
      daysNoTrade,
      evidence,
      bySetup,
      byHour,
      context,
      legacyCount,
    };
    // revision força releitura periódica do cache hidratado do banco persistente
  }, [revision]);

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">Backtest por observação contínua</h1>
          <p className="text-xs text-muted-foreground">
            Compartilhe a janela do gráfico histórico pelo mesmo botão da operação ao vivo. O
            gráfico aparece aqui dentro e a IA acompanha enquanto você arrasta a história —
            decidindo em cada instante sem ver o futuro e salvando tudo no banco durante a
            observação.
          </p>
        </div>
        <Badge variant="outline" className="ml-auto font-mono">
          {backtest.phase.toUpperCase()}
        </Badge>
      </header>

      {insecureContext && (
        <Card className="flex gap-2 border-bear/50 bg-bear/10 p-3 text-xs text-bear">
          <ShieldAlert className="h-4 w-4 shrink-0" />A captura exige HTTPS ou localhost. Hospede
          atrás do nginx com certificado válido.
        </Card>
      )}

      <Card className="grid gap-3 border-border/70 bg-panel p-3 md:grid-cols-[180px_1fr_auto]">
        <div>
          <Label className="text-[10px]">Ativo</Label>
          <Input
            value={asset}
            disabled={running}
            onChange={(event) => setAsset(event.target.value.toUpperCase())}
          />
        </div>
        <div className="flex flex-wrap items-end gap-3 text-[11px]">
          <span>
            Escala:{" "}
            <strong className={backtest.calibration.usable ? "text-bull" : "text-warn"}>
              {backtest.calibration.usable
                ? `PREÇOS DISPONÍVEIS · ${backtest.calibration.confidence}%`
                : "PREÇOS EM CALIBRAÇÃO · ANÁLISE ATIVA"}
            </strong>
          </span>
          <span>
            Pregão: <strong>{backtest.tradingDate ?? "aguardando OCR da data"}</strong>
          </span>
          <span>
            Hora do gráfico: <strong>{backtest.marketTime ?? "—"}</strong>
          </span>
          <span>
            Trecho: <strong>#{backtest.segmentIndex + 1}</strong>
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={backtest.chart.status === "sem-fonte"}
            onClick={backtest.recalibrate}
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            Recalibrar
          </Button>
        </div>
        <div className="flex items-end gap-2">
          {!running ? (
            <Button onClick={() => void start()}>
              <Play className="mr-1.5 h-4 w-4" />
              {backtest.chart.status === "sem-fonte"
                ? "Selecionar gráfico e iniciar Backtest"
                : "Iniciar Backtest"}
            </Button>
          ) : (
            <>
              {observing ? (
                <Button variant="outline" onClick={backtest.pause}>
                  <Pause className="mr-1.5 h-4 w-4" />
                  Pausar
                </Button>
              ) : (
                <Button variant="outline" onClick={backtest.resume}>
                  <Play className="mr-1.5 h-4 w-4" />
                  Retomar
                </Button>
              )}
              <Button variant="destructive" onClick={backtest.finish}>
                <Power className="mr-1.5 h-4 w-4" />
                Encerrar
              </Button>
            </>
          )}
        </div>
      </Card>

      <CaptureConsole
        status={backtest.chart.status}
        fps={backtest.chart.fps}
        resolution={backtest.chart.resolution}
        lastFrameAt={backtest.chart.lastFrameAt}
        error={backtest.chart.error}
        sourceLabel={backtest.chart.sourceLabel}
        onSelectSource={() => void start()}
        onConfirmPreview={() => {
          backtest.chart.confirmPreview();
          setStartErrors(backtest.start());
        }}
        onPause={backtest.pause}
        onResume={backtest.resume}
        onSwitchSource={() => void backtest.switchScreen()}
      />

      {(startErrors.length > 0 || backtest.calibrationError) && (
        <Card className="border-warn/50 bg-warn/10 p-3 text-xs text-warn">
          {startErrors.map((error) => (
            <p key={error}>• {error}</p>
          ))}
          {backtest.calibrationError && !backtest.priceScaleReady && (
            <p>• {backtest.calibrationSummary}</p>
          )}
        </Card>
      )}

      <div className="grid gap-2 text-center sm:grid-cols-4 lg:grid-cols-8">
        <Metric label="Pregões" value={String(backtest.counters.sessionsAnalyzed)} />
        <Metric label="Minutos lidos" value={String(backtest.counters.analyzedMinutes)} />
        <Metric label="Frames" value={String(backtest.counters.framesCaptured)} />
        <Metric label="Frames úteis" value={String(backtest.counters.framesAnalyzed)} />
        <Metric label="Ignorados" value={String(backtest.counters.framesIgnored)} />
        <Metric label="Eventos" value={String(backtest.counters.events)} />
        <Metric label="Setups" value={String(backtest.counters.setups)} />
        <Metric label="Operações" value={String(backtest.counters.trades)} />
      </div>

      <AnalysisCockpit
        asset={asset}
        candles={backtest.candles}
        analysis={backtest.analysis}
        decision={backtest.decision}
        entryState={backtest.entryState}
        operationStatus={
          backtest.operation?.done
            ? `ENCERRADA · ${backtest.operation.status}`
            : (backtest.operation?.status ?? null)
        }
        operationDetail={backtest.operation?.detail ?? null}
        progress={progress}
        snapshot={backtest.signalSnapshot}
        chat={backtest.chat}
        aiProvider={backtest.aiProvider}
        tradingDateLabel={backtest.tradingDate ?? undefined}
        priceScaleReady={backtest.priceScaleReady}
        calibrationSummary={backtest.calibrationSummary}
        aiValidationRows={aiRows}
      />

      <Card className="flex flex-col gap-1 border-border/70 bg-panel p-3">
        <p className="text-[10px] font-medium tracking-widest text-muted-foreground">
          LINHA DO TEMPO DA OBSERVAÇÃO
        </p>
        {backtest.timeline.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Nenhum evento ainda. Ao arrastar o histórico no Profit, cada pregão, trecho, evento
            estrutural e operação aparece aqui no instante em que é detectado.
          </p>
        ) : (
          <div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto font-mono text-[11px]">
            {[...backtest.timeline].reverse().map((entry) => (
              <div key={entry.id} className="flex gap-2 border-b border-border/30 py-0.5">
                <span className="text-muted-foreground">
                  {entry.marketTime ?? new Date(entry.t).toLocaleTimeString("pt-BR")}
                </span>
                <span
                  className={cn(
                    "font-bold",
                    entry.tone === "bull" && "text-bull",
                    entry.tone === "bear" && "text-bear",
                    entry.tone === "warn" && "text-warn",
                    entry.tone === "alert" && "text-primary",
                  )}
                >
                  {entry.label}
                </span>
                {entry.detail && <span className="text-muted-foreground">{entry.detail}</span>}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="flex flex-col gap-2 border-border/70 bg-panel p-3">
        <p className="text-[10px] font-medium tracking-widest text-muted-foreground">
          BASE HISTÓRICA — {base.trades.length} OPERAÇÕES
          {base.legacyCount > 0 && (
            <span className="ml-2 normal-case tracking-normal">
              ({base.legacyCount} de análises antigas por imagem isolada ficam só como histórico —
              fora da evidência)
            </span>
          )}
        </p>
        {base.trades.length > 0 ? (
          <>
            <div className="grid gap-2 text-center sm:grid-cols-6">
              <Metric label="Acerto" value={`${base.stats.winRate.toFixed(1)}%`} />
              <Metric
                label="Profit Factor"
                value={
                  Number.isFinite(base.stats.profitFactor)
                    ? base.stats.profitFactor.toFixed(2)
                    : "n/d"
                }
              />
              <Metric
                label="Expectância"
                value={`${base.stats.expectancy.toFixed(2)}R`}
                tone={base.stats.expectancy >= 0 ? "bull" : "bear"}
              />
              <Metric label="Drawdown" value={`${base.stats.maxDrawdown.toFixed(1)}R`} />
              <Metric label="OOS" value={base.evidence.oosValidated ? "POSITIVO" : "—"} />
              <Metric label="Evidência" value={base.evidence.confidence} />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <BreakdownList title="POR SETUP" items={base.bySetup} />
              <BreakdownList title="POR HORÁRIO" items={base.byHour} />
            </div>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            Nenhuma operação na base ainda. Selecione o gráfico histórico e inicie o Backtest — no
            modo histórico, um setup tecnicamente completo é congelado em T mesmo com a base vazia,
            e os candles seguintes constroem a evidência sem look-ahead.
          </p>
        )}
      </Card>

      <Card className="flex flex-col gap-2 border-border/70 bg-panel p-3">
        <p className="text-[10px] font-medium tracking-widest text-muted-foreground">
          RESULTADO POR PREGÃO — LEITURA DA ESQUERDA PARA A DIREITA
        </p>
        <div className="grid gap-2 text-center sm:grid-cols-4 lg:grid-cols-7">
          <Metric label="Pregões analisados" value={String(base.daily.length)} />
          <Metric label="Dias com gain" value={String(base.daysGain)} tone="bull" />
          <Metric label="Dias com loss" value={String(base.daysLoss)} tone="bear" />
          <Metric label="Dias sem operação" value={String(base.daysNoTrade)} />
          <Metric
            label="Pontos ganhos"
            value={`+${base.pointStats.pointsWon.toFixed(0)}`}
            tone="bull"
          />
          <Metric
            label="Pontos perdidos"
            value={`-${base.pointStats.pointsLost.toFixed(0)}`}
            tone="bear"
          />
          <Metric
            label="Saldo líquido"
            value={`${base.pointStats.netPoints >= 0 ? "+" : ""}${base.pointStats.netPoints.toFixed(0)} pts`}
            tone={base.pointStats.netPoints >= 0 ? "bull" : "bear"}
          />
        </div>
        <div className="grid gap-2 text-center sm:grid-cols-3 lg:grid-cols-6">
          <Metric label="Total operações" value={String(base.stats.total)} />
          <Metric label="Win rate" value={`${base.stats.winRate.toFixed(1)}%`} />
          <Metric
            label="Profit Factor"
            value={
              Number.isFinite(base.stats.profitFactor) ? base.stats.profitFactor.toFixed(2) : "n/d"
            }
          />
          <Metric
            label="Expectância"
            value={`${base.stats.expectancy.toFixed(2)}R`}
            tone={base.stats.expectancy >= 0 ? "bull" : "bear"}
          />
          <Metric
            label="Drawdown"
            value={`${base.pointStats.maxDrawdownPoints.toFixed(0)} pts / ${base.stats.maxDrawdown.toFixed(1)}R`}
          />
          <Metric
            label="MFE / MAE"
            value={`${base.pointStats.averageMfePoints?.toFixed(0) ?? "—"} / ${base.pointStats.averageMaePoints?.toFixed(0) ?? "—"} pts`}
          />
        </div>
        {base.daily.length > 0 ? (
          <div className="max-h-80 overflow-auto">
            <table className="w-full font-mono text-[11px]">
              <thead className="sticky top-0 bg-panel">
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-3">Pregão</th>
                  <th className="py-1 pr-3">Resultado</th>
                  <th className="py-1 pr-3 text-right">Operações</th>
                  <th className="py-1 pr-3 text-right">Gain/Loss ops</th>
                  <th className="py-1 pr-3 text-right">Pontos</th>
                  <th className="py-1 text-right">R</th>
                </tr>
              </thead>
              <tbody>
                {base.daily.map((day) => (
                  <tr key={day.tradingDate} className="border-t border-border/40">
                    <td className="py-1 pr-3">{day.tradingDate}</td>
                    <td
                      className={cn(
                        "py-1 pr-3 font-bold",
                        day.status === "GAIN" && "text-bull",
                        day.status === "LOSS" && "text-bear",
                        day.status === "EMPATE" && "text-warn",
                        day.status === "SEM_OPERACAO" && "text-muted-foreground",
                      )}
                    >
                      {day.status.replace("_", " ")}
                    </td>
                    <td className="py-1 pr-3 text-right">{day.trades}</td>
                    <td className="py-1 pr-3 text-right">
                      {day.gains}/{day.losses}
                    </td>
                    <td
                      className={cn(
                        "py-1 pr-3 text-right font-bold",
                        day.points > 0 && "text-bull",
                        day.points < 0 && "text-bear",
                      )}
                    >
                      {day.points > 0 ? "+" : ""}
                      {day.points.toFixed(0)}
                    </td>
                    <td className="py-1 text-right">
                      {day.r > 0 ? "+" : ""}
                      {day.r.toFixed(2)}R
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            O quadro será preenchido automaticamente conforme os pregões forem observados.
          </p>
        )}
      </Card>

      {sessions.length > 0 && (
        <Card className="flex flex-col gap-1 border-border/70 bg-panel p-3">
          <p className="text-[10px] font-medium tracking-widest text-muted-foreground">
            SESSÕES DE BACKTEST PROCESSADAS
          </p>
          <div className="overflow-x-auto">
            <table className="w-full font-mono text-[11px]">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-2">Sessão</th>
                  <th className="py-1 pr-2">Ativo</th>
                  <th className="py-1 pr-2">Duração</th>
                  <th className="py-1 pr-2">Frames úteis</th>
                  <th className="py-1 pr-2">Candles</th>
                  <th className="py-1 pr-2">Trechos</th>
                  <th className="py-1 text-right">Operações</th>
                </tr>
              </thead>
              <tbody>
                {[...sessions].reverse().map((session) => (
                  <tr key={session.sessionId} className="border-t border-border/40">
                    <td className="py-1 pr-2">
                      {new Date(session.createdAt).toLocaleString("pt-BR")}
                    </td>
                    <td className="py-1 pr-2">{session.symbol}</td>
                    <td className="py-1 pr-2">{Math.round(session.durationMs / 60_000)} min</td>
                    <td className="py-1 pr-2">{session.usefulFrames}</td>
                    <td className="py-1 pr-2">{session.candleCount}</td>
                    <td className="py-1 pr-2">{session.discontinuities.length + 1}</td>
                    <td className="py-1 text-right">{session.tradeCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <AnalystAssistant
        context={base.context}
        scope="backtest"
        metrics={{
          backtests: base.records.length,
          trades: base.trades.length,
          validatedSetups: base.evidence.oosValidated ? 1 : 0,
          totalSetups: 1,
        }}
      />
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "bull" | "bear" }) {
  return (
    <Card className="gap-0.5 border-border/70 bg-background p-2">
      <p className="text-[9px] tracking-widest text-muted-foreground">{label.toUpperCase()}</p>
      <p
        className={cn(
          "font-mono text-sm font-bold",
          tone === "bull" && "text-bull",
          tone === "bear" && "text-bear",
        )}
      >
        {value}
      </p>
    </Card>
  );
}

function BreakdownList({
  title,
  items,
}: {
  title: string;
  items: { key: string; total: number; r: number }[];
}) {
  return (
    <div>
      <p className="text-[9px] tracking-widest text-muted-foreground">{title}</p>
      <div className="mt-1 flex flex-col gap-0.5 font-mono text-[10px]">
        {items.slice(0, 6).map((item) => (
          <div key={item.key} className="flex justify-between">
            <span className="text-muted-foreground">
              {item.key} ({item.total})
            </span>
            <span className={item.r >= 0 ? "text-bull" : "text-bear"}>{item.r.toFixed(2)}R</span>
          </div>
        ))}
        {items.length === 0 && <span className="text-muted-foreground">—</span>}
      </div>
    </div>
  );
}
