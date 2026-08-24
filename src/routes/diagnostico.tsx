import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useState, useSyncExternalStore } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Bot, Download, Play, Search, Terminal } from "lucide-react";

import { useAnalyzer } from "@/components/AnalyzerProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { checkAiProviders, proposeAiFix, reviewAiFix } from "@/lib/aiFix.functions";
import { runClientDiagnostics } from "@/lib/diagnostics/clientChecks";
import type { CheckResult, CheckStatus, DiagnosticsReport } from "@/lib/diagnostics/types";
import { isCritical } from "@/lib/diagnostics/types";
import { formatLead } from "@/lib/t4/leadTime";
import { replayTechnique, type VisionReplayOutcome } from "@/lib/vision/techniqueReplay";
import { screenRecordingManager } from "@/lib/recording/screenRecordingManager";
import { cn } from "@/lib/utils";

/** hh:mm:ss de um instante, ou "—". Usado só para exibir. */
function clock(at: number | null): string {
  if (at === null) return "—";
  return new Date(at).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export const Route = createFileRoute("/diagnostico")({
  component: DiagnosticoPage,
  head: () => ({ meta: [{ title: "Diagnóstico do Sistema — NEXUS T4" }] }),
});

type ProviderId = "claude" | "openai" | "gemini" | "ollama";

interface ProviderRow {
  id: ProviderId;
  label: string;
  configured: boolean;
  state: string;
  model: string;
  latencyMs: number | null;
  proven: boolean;
  message: string;
}

const STATUS_STYLE: Record<CheckStatus, string> = {
  PASS: "text-bull",
  WARNING: "text-amber-400",
  FAIL: "text-bear",
  SKIPPED: "text-muted-foreground",
};

function scoreTone(score: number): string {
  if (score >= 90) return "text-bull";
  if (score >= 60) return "text-amber-400";
  return "text-bear";
}

function reportToText(report: DiagnosticsReport): string {
  const lines = [
    `SCORE ${report.score}/100 · veredito ${report.verdict}`,
    `PASS ${report.totals.PASS} · WARNING ${report.totals.WARNING} · FAIL ${report.totals.FAIL} · SKIPPED ${report.totals.SKIPPED}`,
    report.criticalFailures.length
      ? `FALHAS CRÍTICAS: ${report.criticalFailures.join(", ")}`
      : "FALHAS CRÍTICAS: nenhuma",
    "",
  ];
  for (const item of report.checks) {
    lines.push(
      `[${item.status}] ${item.id} (${item.domain}) — ${item.label}`,
      `  observado: ${item.observed}`,
      item.cause ? `  causa: ${item.cause}` : "",
      item.file ? `  arquivo: ${item.file}${item.line ? `:${item.line}` : ""}` : "",
      `  impacto: ${item.impact}`,
      `  correção: ${item.fix}`,
      item.proven ? "" : "  ATENÇÃO: não verificado de fato",
      "",
    );
  }
  return lines.filter((line) => line !== "").join("\n");
}

function CheckRow({ item }: { item: CheckResult }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-border/50 py-1.5 last:border-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-baseline gap-2 text-left font-mono text-[11px]"
      >
        <span className={cn("w-16 shrink-0", STATUS_STYLE[item.status])}>{item.status}</span>
        <span className="w-20 shrink-0 text-muted-foreground">{item.domain}</span>
        <span className="shrink-0">{item.id}</span>
        {isCritical(item) && (
          <span className="shrink-0 rounded bg-bear/15 px-1 text-[10px] text-bear">CRÍTICO</span>
        )}
        {!item.proven && item.status !== "SKIPPED" && (
          <span className="shrink-0 rounded bg-amber-400/15 px-1 text-[10px] text-amber-400">
            NÃO PROVADO
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-right text-muted-foreground">
          {item.observed}
        </span>
      </button>
      {open && (
        <div className="mt-1 grid gap-0.5 pl-16 font-mono text-[11px] text-muted-foreground">
          <span>observado: {item.observed}</span>
          {item.cause && <span>causa raiz: {item.cause}</span>}
          {item.file && (
            <span>
              arquivo: {item.file}
              {item.line ? `:${item.line}` : ""}
            </span>
          )}
          <span>impacto: {item.impact}</span>
          <span className="text-foreground">correção: {item.fix}</span>
        </div>
      )}
    </div>
  );
}

function DiagnosticoPage() {
  // MESMA fonte da Operação ao Vivo. Dois painéis não podem discordar sobre o
  // mesmo instante — e discordavam, enquanto este media o caminho RTD.
  const { vision, diagnostics } = useAnalyzer();
  const recorder = useSyncExternalStore(
    (listener) => screenRecordingManager.subscribe(listener),
    () => screenRecordingManager.getState().status,
    () => "IDLE" as const,
  );
  const runProposal = useServerFn(proposeAiFix);
  const runReview = useServerFn(reviewAiFix);
  const runProviderCheck = useServerFn(checkAiProviders);

  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [running, setRunning] = useState(false);
  const [engineerMode, setEngineerMode] = useState(false);
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [provider, setProvider] = useState<ProviderId>("claude");
  const [reviewer, setReviewer] = useState<ProviderId>("openai");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiOutput, setAiOutput] = useState<string>("");
  const [aiFiles, setAiFiles] = useState<string>("");
  const [replay, setReplay] = useState<VisionReplayOutcome | null>(null);

  /**
   * TESTAR A TÉCNICA — reexecuta a técnica sobre a série que está na tela agora
   * e compara veredito a veredito com o que o motor produziu.
   *
   * Isto responde a pergunta que aparece toda vez que um sinal sai estranho:
   * foi a TÉCNICA ou foi a LEITURA? Se o replay reproduz exatamente, a técnica é
   * auditável e o problema está na imagem; se diverge com a mesma versão do
   * código, existe estado escondido no caminho.
   */
  const testTechnique = useCallback(() => {
    setReplay(replayTechnique(vision.captureReplay("teste manual em /diagnostico")));
  }, [vision]);

  const downloadReplay = useCallback(() => {
    const bundle = vision.captureReplay("exportação manual");
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `t4-replay-${bundle.symbol}-${bundle.capturedAtSystem}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }, [vision]);

  const runDiagnostics = useCallback(async () => {
    setRunning(true);
    setReport(null);
    try {
      const [result, providerRows] = await Promise.all([
        runClientDiagnostics({ diagnostics }),
        runProviderCheck().catch(() => [] as ProviderRow[]),
      ]);
      setReport(result);
      setProviders(providerRows as ProviderRow[]);
    } finally {
      setRunning(false);
    }
  }, [diagnostics, runProviderCheck]);

  const askAi = useCallback(
    async (multi: boolean) => {
      if (!report) return;
      setAiBusy(true);
      setAiOutput("");
      try {
        const files = aiFiles
          .split(/[\n,]/)
          .map((file) => file.trim())
          .filter(Boolean);
        const proposal = await runProposal({
          data: {
            provider,
            report: reportToText(report),
            files,
            // A narração do pipeline visual É o log agora: uma linha por
            // mudança de estado, com o bloqueio junto.
            logs: vision.chat
              .slice(-40)
              .map((entry) => `${clock(entry.t)} [${entry.tone}] ${entry.text}`)
              .join("\n"),
          },
        });
        let output = `PROPOSTA — ${proposal.provider}${proposal.usedFallback ? " (FALLBACK)" : ""}\nArquivos lidos: ${proposal.filesRead}\n${
          proposal.refused.length
            ? `Recusados pela allowlist: ${proposal.refused.join("; ")}\n`
            : ""
        }\n${proposal.text}`;

        if (multi) {
          const review = await runReview({
            data: {
              reviewer,
              report: reportToText(report),
              proposal: proposal.text,
            },
          });
          output += `\n\n────────────\nREVISÃO — ${review.provider}${review.usedFallback ? " (FALLBACK)" : ""}\n\n${review.text}`;
        }
        output +=
          "\n\n────────────\nNENHUM ARQUIVO FOI ALTERADO. Esta é uma proposta: aplique o patch manualmente e rode typecheck, lint, testes e build antes de considerar corrigido.";
        setAiOutput(output);
      } catch (error) {
        setAiOutput(
          `Falha na consulta à IA: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        setAiBusy(false);
      }
    },
    [aiFiles, provider, report, reviewer, vision.chat, runProposal, runReview],
  );

  const byDomain = new Map<string, CheckResult[]>();
  for (const item of report?.checks ?? []) {
    const list = byDomain.get(item.domain) ?? [];
    list.push(item);
    byDomain.set(item.domain, list);
  }

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">Diagnóstico do Sistema</h1>
          <p className="text-xs text-muted-foreground">
            Auditoria real de dado, backend, T4 e IA. Nada aparece verde sem prova.
          </p>
        </div>
      </header>

      <Card className="flex flex-wrap items-center gap-2 border-border/70 bg-panel p-3">
        <Button onClick={() => void runDiagnostics()} disabled={running}>
          <Search className="mr-1.5 h-4 w-4" />
          {running ? "Auditando…" : "🔍 DIAGNÓSTICO COMPLETO"}
        </Button>
        <Button variant="outline" disabled={!report || aiBusy} onClick={() => void askAi(false)}>
          <Bot className="mr-1.5 h-4 w-4" />
          {aiBusy ? "Consultando…" : "🤖 CORRIGIR COM IA"}
        </Button>
        <Button
          variant={engineerMode ? "default" : "outline"}
          onClick={() => setEngineerMode(!engineerMode)}
        >
          <Terminal className="mr-1.5 h-4 w-4" />
          MODO ENGENHEIRO
        </Button>
        {/*
          Sem candles não há o que reproduzir, e um botão que "roda" sobre série
          vazia devolveria um verde que não prova nada.
        */}
        <Button
          variant="outline"
          onClick={testTechnique}
          disabled={diagnostics.closedCandlesAccepted === 0}
        >
          <Play className="mr-1.5 h-4 w-4" />
          TESTAR A TÉCNICA
        </Button>
        <Button
          variant="outline"
          onClick={downloadReplay}
          disabled={diagnostics.closedCandlesAccepted === 0}
        >
          <Download className="mr-1.5 h-4 w-4" />
          Exportar replay
        </Button>
      </Card>

      {replay && (
        <Card className="grid gap-1 border-border/70 bg-panel p-3">
          <p className="nexus-eyebrow">TESTE DA TÉCNICA — reprodução determinística</p>
          <p className={cn("font-mono text-[11px]", replay.ok ? "text-bull" : "text-bear")}>
            {replay.message}
          </p>
          <p className="font-mono text-[11px] text-muted-foreground">
            {replay.candlesReplayed} candles · {replay.gatesReplayed} gates reavaliados · técnica{" "}
            {replay.sameStrategyVersion ? "idêntica" : "diferente"}
          </p>
          {replay.divergences.map((d) => (
            <p key={d.campo} className="font-mono text-[11px] text-bear">
              {d.campo}: gravado {d.gravado}, replay {d.replay}
            </p>
          ))}
        </Card>
      )}

      {report && (
        <Card className="grid gap-3 border-border/70 bg-panel p-3">
          <div className="flex flex-wrap items-baseline gap-3">
            <span className={cn("font-display text-4xl font-bold", scoreTone(report.score))}>
              {report.score}
            </span>
            <span className="text-sm text-muted-foreground">/100</span>
            <Badge
              variant={report.verdict === "PASS" ? "default" : "outline"}
              className={cn(
                "font-mono",
                report.verdict === "FAIL" && "border-bear text-bear",
                report.verdict === "WARNING" && "border-amber-400 text-amber-400",
              )}
            >
              {report.verdict}
            </Badge>
            <span className="font-mono text-[11px] text-muted-foreground">
              {report.totals.PASS} PASS · {report.totals.WARNING} WARNING · {report.totals.FAIL}{" "}
              FAIL · {report.totals.SKIPPED} SKIPPED · {report.durationMs}ms
            </span>
          </div>

          {report.criticalFailures.length > 0 && (
            <p className="rounded border border-bear/50 bg-bear/10 p-2 font-mono text-[11px] text-bear">
              FALHAS CRÍTICAS ({report.criticalFailures.length}):{" "}
              {report.criticalFailures.join(", ")} — o score não pode chegar a 100 enquanto isso não
              for resolvido.
            </p>
          )}
          {report.unproven.length > 0 && (
            <p className="rounded border border-amber-400/50 bg-amber-400/10 p-2 font-mono text-[11px] text-amber-400">
              NÃO PROVADOS ({report.unproven.length}): {report.unproven.join(", ")} — estes checks
              não conseguiram verificar nada de fato e por isso não contam como aprovados.
            </p>
          )}

          <div className="grid gap-2">
            {[...byDomain.entries()].map(([domain, items]) => (
              <div key={domain}>
                <p className="nexus-eyebrow">{domain}</p>
                {items.map((item) => (
                  <CheckRow key={item.id} item={item} />
                ))}
              </div>
            ))}
          </div>
        </Card>
      )}

      {providers.length > 0 && (
        <Card className="grid gap-2 border-border/70 bg-panel p-3">
          <p className="nexus-eyebrow">PROVEDORES DE IA</p>
          <div className="grid gap-1 font-mono text-[11px]">
            {providers.map((row) => (
              <div key={row.id} className="flex items-baseline gap-2">
                <span
                  className={cn(
                    "w-24 shrink-0",
                    row.state === "READY"
                      ? "text-bull"
                      : row.configured
                        ? "text-bear"
                        : "text-muted-foreground",
                  )}
                >
                  {row.state}
                </span>
                <span className="w-40 shrink-0">{row.label}</span>
                <span className="w-32 shrink-0 text-muted-foreground">{row.model}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.message}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {report && (
        <Card className="grid gap-2 border-border/70 bg-panel p-3">
          <p className="nexus-eyebrow">CORREÇÃO ASSISTIDA</p>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Propõe:</span>
            {(["claude", "openai", "gemini", "ollama"] as ProviderId[]).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setProvider(id)}
                className={cn(
                  "rounded border px-2 py-0.5 font-mono",
                  provider === id ? "border-primary bg-primary/15" : "border-border/70",
                )}
              >
                {id}
              </button>
            ))}
            <span className="ml-2 text-muted-foreground">Revisa:</span>
            {(["claude", "openai", "gemini", "ollama"] as ProviderId[]).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setReviewer(id)}
                className={cn(
                  "rounded border px-2 py-0.5 font-mono",
                  reviewer === id ? "border-primary bg-primary/15" : "border-border/70",
                )}
              >
                {id}
              </button>
            ))}
            <Button size="sm" variant="outline" disabled={aiBusy} onClick={() => void askAi(true)}>
              REVISÃO MULTI-IA
            </Button>
          </div>
          <Textarea
            value={aiFiles}
            onChange={(event) => setAiFiles(event.target.value)}
            placeholder="Arquivos para a IA ler (um por linha) — ex.: src/lib/rtd/gates.ts"
            className="h-20 font-mono text-[11px]"
          />
          <p className="text-[11px] text-muted-foreground">
            Só caminhos dentro de <code>src/</code>, <code>bridge/</code>, <code>migrations/</code>{" "}
            e <code>docs/</code> são lidos. <code>.env</code>, chaves, banco e segredos são
            recusados pela allowlist do servidor. Nenhum arquivo é alterado por esta tela.
          </p>
          {aiOutput && (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded border border-border/70 bg-background/60 p-2 font-mono text-[11px]">
              {aiOutput}
            </pre>
          )}
        </Card>
      )}

      {engineerMode && (
        <Card className="grid gap-2 border-border/70 bg-panel p-3">
          <p className="nexus-eyebrow">MODO ENGENHEIRO — pipeline visual</p>
          {/*
            Estes números vêm do MESMO `visionDiagnostics` que a Operação ao Vivo
            mostra. Antes esta seção media a bridge RTD: um caminho que não roda
            mais, descrito com números que ninguém podia conferir na tela.
          */}
          <div className="grid grid-cols-2 gap-2 font-mono text-[11px] sm:grid-cols-4">
            <span>pipeline {diagnostics.pipeline}</span>
            <span>fonte {diagnostics.sourceOfTruth}</span>
            <span>modo {diagnostics.sourceMode}</span>
            <span>captura {diagnostics.captureLabel}</span>
            <span>gráfico {diagnostics.chartLabel}</span>
            <span>fps {Math.round(diagnostics.fps)}</span>
            <span>frames {diagnostics.framesReceived}</span>
            <span>parado {Math.round(diagnostics.staticForMs / 1000)}s</span>
            <span>visíveis {diagnostics.candlesVisible}</span>
            <span>parseados {diagnostics.candlesParsed}</span>
            <span>série {diagnostics.closedCandlesAccepted}</span>
            <span>à T4 {diagnostics.candlesSentToT4}</span>
            <span>pregão {diagnostics.marketDate ?? "não lido"}</span>
            <span>hora {diagnostics.timeTrusted ? "confiável" : "não lida"}</span>
            <span>
              escala {diagnostics.priceScaleReady ? "PRONTA" : (diagnostics.scaleReject ?? "—")}
            </span>
            <span>âncoras {diagnostics.anchors}</span>
            <span>R² {diagnostics.scaleR2?.toFixed(4) ?? "—"}</span>
            <span>cache {diagnostics.cache}</span>
            <span>hash {diagnostics.geometryHash ?? "—"}</span>
            <span>tentativas {diagnostics.scaleAttempts}</span>
            <span>OCR {diagnostics.ocrState}</span>
            <span>latência {diagnostics.ocrLatencyMs ?? "—"}ms</span>
            <span>GPU {diagnostics.gpuStatus}</span>
            <span>modelo {diagnostics.ocrModel ?? "—"}</span>
            <span>regime {diagnostics.regime}</span>
            <span>pivôs {diagnostics.pivots}</span>
            <span>estrutura {diagnostics.structure}</span>
            <span>liquidez {diagnostics.liquidity}</span>
            <span>motor {diagnostics.t4Engine}</span>
            <span>estado {diagnostics.t4Flow}</span>
            <span>maturidade {diagnostics.t4Percent}%</span>
            <span>gravação {recorder}</span>
          </div>

          {/*
            ANTECEDÊNCIA — a métrica que decide se o trabalho valeu. Cada marca
            foi gravada QUANDO o estado aconteceu; nenhuma é reconstruída depois.
          */}
          <p className="nexus-eyebrow mt-2">ANTECEDÊNCIA DO SETUP</p>
          <div className="grid grid-cols-2 gap-2 font-mono text-[11px] sm:grid-cols-3">
            <span>candidato {clock(diagnostics.candidateTime)}</span>
            <span>pré-entrada {clock(diagnostics.preEntryTime)}</span>
            <span>confirmação {clock(diagnostics.confirmationTime)}</span>
            <span>lead candidato {formatLead(diagnostics.candidateLeadTimeMs)}</span>
            <span>lead pré-entrada {formatLead(diagnostics.preEntryLeadTimeMs)}</span>
            <span>bloqueio {diagnostics.blockReason ?? "—"}</span>
          </div>

          <p className="nexus-eyebrow mt-2">NARRAÇÃO</p>
          <div className="grid max-h-48 gap-0.5 overflow-y-auto font-mono text-[11px]">
            {vision.chat.map((entry, index) => (
              <div key={`${entry.t}-${index}`} className="flex gap-2">
                <span className="shrink-0 text-muted-foreground">{clock(entry.t)}</span>
                <span
                  className={cn(
                    "w-12 shrink-0",
                    entry.tone === "warn" || entry.tone === "alert"
                      ? "text-amber-400"
                      : entry.tone === "bear"
                        ? "text-bear"
                        : entry.tone === "bull"
                          ? "text-bull"
                          : "text-muted-foreground",
                  )}
                >
                  {entry.tone}
                </span>
                <span className="min-w-0 flex-1">{entry.text}</span>
              </div>
            ))}
            {vision.chat.length === 0 && (
              <span className="text-muted-foreground">
                Nenhum evento — a leitura do Profit ainda não começou.
              </span>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
