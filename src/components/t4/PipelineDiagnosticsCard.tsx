import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { MIN_CANDLES_FOR_ANALYSIS } from "@/lib/vision/chartTracker";
import type { VisionDiagnostics } from "@/lib/vision/visionDiagnostics";
import { cn } from "@/lib/utils";

/**
 * Painel do pipeline — agora com UMA fonte só.
 *
 * Este card lia `live.diagnostics`, do motor legado que monta candles a partir
 * de amostras ao longo de minutos reais. Só que quem está rodando é o pipeline
 * visual, que reconstrói a série da geometria da tela. Os dois discordam por
 * construção, e a discordância aparecia como mentira: "esperar 14 minutos" com
 * 14 candles na tela, CANDLES_PARSED=0 com candles visíveis, e a data de hoje
 * num replay de março.
 *
 * Agora só existe `VisionDiagnostics`. Se um número aparece aqui, veio do que a
 * captura direta realmente observou.
 */

type Row = { label: string; value: string; tone: "ok" | "warn" | "bad" | "idle"; hint?: string };

function ms(value: number | null): string {
  if (value === null) return "—";
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
}

export function PipelineDiagnosticsCard({ diagnostics }: { diagnostics: VisionDiagnostics }) {
  const d = diagnostics;

  const rows: Row[] = [
    {
      label: "CAPTURA",
      value: d.captureLabel,
      tone: d.captureActive ? "ok" : "bad",
      hint: `${d.framesReceived} frames`,
    },
    {
      // Gráfico parado é informação sobre o mercado, não falha do sistema.
      label: "GRÁFICO",
      value: d.chartLabel,
      tone: d.pixelsChanging ? "ok" : d.captureActive ? "warn" : "idle",
      hint: d.staticForMs > 0 ? `parado há ${Math.round(d.staticForMs / 1000)}s` : undefined,
    },
    {
      label: "CANDLES VISÍVEIS",
      value: String(d.candlesVisible),
      tone: d.candlesVisible > 0 ? "ok" : "bad",
    },
    {
      // A diferença entre visíveis e parseados é o que denuncia o detector.
      label: "CANDLES PARSEADOS",
      value: String(d.candlesParsed),
      tone: d.candlesParsed > 0 ? "ok" : d.candlesVisible > 0 ? "bad" : "idle",
      hint: d.rejectReason ?? undefined,
    },
    {
      label: "ACEITOS NA SÉRIE",
      value: String(d.closedCandlesAccepted),
      tone: d.closedCandlesAccepted > 0 ? "ok" : "idle",
    },
    {
      // A série pulou de 212 para 258 em segundos num gráfico de 1 minuto: era
      // a mesma história entrando de novo. Este contador é a prova de que não
      // está mais entrando.
      label: "DUPLICADOS RECUSADOS",
      value: String(d.duplicatesRejected),
      tone: d.duplicatesRejected > 0 ? "warn" : "ok",
      hint: `${d.identicalFrames} frames idênticos ignorados · ${d.newClosedCandles} novo(s) no último frame`,
    },
    {
      label: "ENVIADOS À T4",
      value: String(d.candlesSentToT4),
      tone: d.candlesSentToT4 > 0 ? "ok" : "idle",
    },
    {
      label: "BOOTSTRAP",
      value: `${d.bootstrapProgress}/${MIN_CANDLES_FOR_ANALYSIS}`,
      tone: d.bootstrapProgress >= MIN_CANDLES_FOR_ANALYSIS ? "ok" : "warn",
    },
    {
      // PREGÃO vem do gráfico. Sem leitura confiável, diz isso — nunca a data
      // de hoje, que num replay de março apontaria agosto.
      label: "PREGÃO",
      value: d.marketDate ?? "NÃO CONFIÁVEL",
      tone: d.dateTrusted ? "ok" : "warn",
    },
    {
      label: "HORÁRIO",
      value: d.timeTrusted ? "CONFIÁVEL" : "NÃO CONFIÁVEL",
      tone: d.timeTrusted ? "ok" : "warn",
      hint: d.timeSource,
    },
    {
      label: "ESCALA DE PREÇO",
      value: d.priceScaleReady ? "PRONTA" : "EM CALIBRAÇÃO",
      tone: d.priceScaleReady ? "ok" : "warn",
      hint: `${d.anchors} âncoras · ${d.priceScaleConfidence}%`,
    },
    {
      // NUNCA "CALIBRANDO" sem motivo: se a escala não saiu, o código diz por
      // quê, e cada código aponta para um conserto diferente.
      label: "MOTIVO DA ESCALA",
      value: d.priceScaleReady ? "—" : (d.scaleReject ?? "AGUARDANDO 1ª LEITURA"),
      tone: d.priceScaleReady ? "idle" : d.scaleReject === null ? "idle" : "bad",
      hint: d.scaleRejectDetail ?? undefined,
    },
    {
      // Tres causas distintas com tres consertos distintos: modelo mudo,
      // confianca abaixo do corte, ou regua percentual ignorada.
      label: "RÓTULOS DA ESCALA",
      value: d.scaleLabels === null ? "—" : d.scaleLabels.split(" · ")[0]!,
      tone: d.scaleLabels === null ? "idle" : "warn",
      hint: d.scaleLabels ?? undefined,
    },
    {
      label: "R² DA ESCALA",
      value: d.scaleR2 === null ? "—" : d.scaleR2.toFixed(4),
      tone: d.scaleR2 === null ? "idle" : "ok",
      hint: d.scaleResidual === null ? undefined : `desvio máx. ${d.scaleResidual.toFixed(1)}px`,
    },
    {
      // CACHE HIT é a prova de que a GPU não foi chamada à toa: mesma geometria,
      // mesma reta, zero chamada.
      label: "CACHE DA ESCALA",
      value: d.cache,
      tone: d.cache === "HIT" ? "ok" : "idle",
      hint: `${d.scaleAttempts} tentativa(s) · hash ${d.geometryHash ?? "—"}`,
    },
    {
      label: "OCR",
      value: d.ocrState,
      tone: d.ocrState === "ONLINE" ? "ok" : d.ocrState === "OFFLINE" ? "bad" : "warn",
      hint: `${ms(d.ocrLatencyMs)} · ${d.ocrModel ?? "sem modelo"}`,
    },
    {
      // Os quatro estados abaixo sao INDEPENDENTES: GPU respondendo com escala
      // em erro e o caso normal quando o eixo esta cortado, e o contrario
      // mandava consertar a coisa errada.
      label: "GPU",
      value: d.gpuStatus,
      tone: d.gpuStatus === "ONLINE" ? "ok" : d.gpuStatus === "OFFLINE" ? "bad" : "idle",
      hint: "health HTTP do serviço de visão — não depende da escala",
    },
    {
      label: "CAPTURA (STATUS)",
      value: d.captureStatus,
      tone: d.captureStatus === "ONLINE" ? "ok" : "bad",
    },
    {
      label: "ESCALA (STATUS)",
      // Antes da leitura comecar nao existe calibracao em andamento.
      value: d.captureActive ? d.scaleStatus : "—",
      tone: !d.captureActive
        ? "idle"
        : d.scaleStatus === "CALIBRADA"
          ? "ok"
          : d.scaleStatus === "ERRO"
            ? "bad"
            : "warn",
      hint: d.scaleRejectDetail ?? undefined,
    },
    {
      label: "T4 (STATUS)",
      value: d.engineStatus,
      tone: d.engineStatus === "ANALISANDO" ? "ok" : "idle",
    },
    {
      label: "REGIME",
      value: d.regime,
      tone: "idle",
      hint: `${d.pivots} pivôs · ${d.visualUpdates} atualizações`,
    },
    {
      label: "ESTRUTURA",
      value: d.structure,
      tone: "idle",
      hint: `${d.liquidity} níveis de liquidez`,
    },
    {
      label: "MODO",
      value: d.sourceMode,
      tone: "idle",
      hint: d.sourceMode === "REPLAY" ? "data e hora vêm do gráfico" : "pregão corrente",
    },
    {
      // MOTOR e SETUP são perguntas diferentes: 0% de maturidade com o motor
      // ANALISANDO é um pregão sem oportunidade, não um software parado.
      label: "MOTOR T4",
      value: d.t4Engine,
      tone: d.t4Engine === "ANALISANDO" ? "ok" : d.t4Engine === "PAUSADO_DADO" ? "bad" : "warn",
    },
    {
      label: "ESTADO DO SETUP",
      value: d.t4Flow,
      tone: d.t4Flow === "OBSERVANDO" ? "idle" : "ok",
      hint: `maturidade ${d.t4Percent}% · ${d.bias}`,
    },
    {
      label: "ANTECEDÊNCIA",
      value: ms(d.preEntryLeadTimeMs),
      tone: (d.preEntryLeadTimeMs ?? 0) > 0 ? "ok" : "idle",
      hint: "pré-entrada antes do gatilho",
    },
  ];

  const TONE: Record<Row["tone"], string> = {
    ok: "text-bull",
    warn: "text-amber-500",
    bad: "text-bear",
    idle: "text-muted-foreground",
  };

  return (
    <Card className="nexus-card gap-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="nexus-eyebrow">PIPELINE ATIVO</p>
        <Badge variant="outline" className="border-bull font-mono text-xs text-bull">
          {d.pipeline}
        </Badge>
        <span className="nexus-eyebrow ml-auto" title="De onde vêm todos os números deste painel">
          FONTE: {d.sourceOfTruth}
        </span>
      </div>

      {/* Uma frase, o problema mais importante agora, com a ação certa. */}
      {d.headline !== null && (
        <p className="rounded border border-amber-500/50 bg-amber-500/10 p-2 text-xs text-amber-500">
          {d.headline}
        </p>
      )}

      <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline gap-2 min-w-0">
            <span className="nexus-eyebrow shrink-0">{row.label}</span>
            <span
              className={cn("ml-auto shrink-0 font-mono text-xs", TONE[row.tone])}
              title={row.hint}
            >
              {row.value}
            </span>
          </div>
        ))}
      </div>

      {/*
        CADA RÓTULO, COM O MOTIVO DE TER SAÍDO.
        Antes, toda falha de escala terminava num código único e o operador não
        tinha como saber se o modelo leu errado, leu fora da régua ou leu números
        que nem são do eixo. Aqui está o dado bruto: Y, preço, e o descarte.
      */}
      {d.scaleReadings.length > 0 && (
        <div className="mt-1 border-t border-border/40 pt-2">
          <p className="nexus-eyebrow mb-1">RÓTULOS LIDOS NO EIXO</p>
          <div className="grid gap-0.5 font-mono text-[10px]">
            <div className="flex gap-2 text-muted-foreground">
              <span className="w-12 shrink-0">Y%</span>
              <span className="w-16 shrink-0">Y (px)</span>
              <span className="w-24 shrink-0">PREÇO</span>
              <span className="w-14 shrink-0">RESÍD.</span>
              <span className="min-w-0 flex-1">SITUAÇÃO</span>
            </div>
            {d.scaleReadings.map((label, index) => (
              <div key={`${label.raw}-${index}`} className="flex gap-2">
                <span className="w-12 shrink-0 text-muted-foreground">
                  {Number.isFinite(label.yPercent) ? label.yPercent.toFixed(1) : "—"}
                </span>
                <span className="w-16 shrink-0 text-muted-foreground">
                  {Number.isFinite(label.y) ? Math.round(label.y) : "—"}
                </span>
                <span className={cn("w-24 shrink-0", label.kept ? "text-bull" : "text-bear")}>
                  {label.raw}
                </span>
                <span className="w-14 shrink-0 text-muted-foreground">
                  {label.residualPx === null ? "—" : `${label.residualPx.toFixed(1)}px`}
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    label.kept ? "text-bull" : "text-muted-foreground",
                  )}
                >
                  {label.kept ? "ACEITO" : (label.drop ?? "—")}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-1 font-mono text-[10px] text-muted-foreground">
            direção esperada: preço cresce de baixo para cima (Y maior = preço menor)
          </p>
        </div>
      )}

      {d.blockReason !== null && (
        <p className="font-mono text-[11px] text-muted-foreground" title={d.blockReason}>
          BLOQUEIO: {d.blockReason}
        </p>
      )}
    </Card>
  );
}
