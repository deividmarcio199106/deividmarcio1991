import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Bot, FlaskConical } from "lucide-react";

import { AnalysisCockpit } from "@/components/analysis/AnalysisCockpit";
import { useAnalyzer } from "@/components/AnalyzerProvider";
import { PipelineDiagnosticsCard } from "@/components/t4/PipelineDiagnosticsCard";
import { RecordingStatusCard } from "@/components/t4/RecordingStatusCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isSecureContextAvailable } from "@/lib/capture/screenCapture";
import { ProfitVisionPanel } from "@/components/t4/ProfitVisionPanel";
import { OperationCard } from "@/components/t4/OperationCard";
import { FrozenEvidenceCard } from "@/components/t4/FrozenEvidenceCard";
import { SOURCE_MODES, SOURCE_MODE_LABEL } from "@/lib/vision/sourceMode";
import { visionT4Progress } from "@/lib/t4/engineState";
import { T4_PRODUCTION_VERSION } from "@/lib/t4/version";
import { MIN_CANDLES_FOR_ANALYSIS } from "@/lib/vision/chartTracker";
import { describeReject } from "@/lib/vision/scaleReject";
import { SIMULATION_WARNING } from "@/lib/t4/simulation";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/operacao-ao-vivo")({
  component: LivePage,
  head: () => ({ meta: [{ title: "Operação ao Vivo — NEXUS T4" }] }),
});

function LivePage() {
  // Sessão e diagnóstico vivem no AnalyzerProvider (layout raiz): sair desta
  // rota NÃO interrompe captura, candles, contexto, T4 nem gravação.
  const { vision, diagnostics, liveAsset, setLiveAsset, sourceMode, setSourceMode } = useAnalyzer();
  const [insecureContext, setInsecureContext] = useState(false);

  useEffect(() => setInsecureContext(!isSecureContextAvailable()), []);

  // A escada NÃO tem degrau de escala: a leitura estrutural anda sem preço
  // exato, e travar a barra em 30% por causa da calibração descreveria mal o
  // que a T4 já sabe.
  const progress = visionT4Progress({
    captureActive: diagnostics.captureActive,
    chartVisible: diagnostics.candlesVisible > 0,
    candlesParsed: diagnostics.candlesParsed > 0,
    // `bootstrapRequired` é quanto FALTA, não quanto é preciso: comparar o
    // progresso com ele declarava histórico suficiente na metade do caminho.
    historyReady: diagnostics.bootstrapProgress >= MIN_CANDLES_FOR_ANALYSIS,
    structureRead: vision.analysis !== null,
    liquidityMapped: diagnostics.liquidity > 0,
    confirmed: vision.operation.confirmed,
  });

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">Operação ao Vivo</h1>
          <p className="text-xs text-muted-foreground">
            Captura direta do Profit · candles reconstruídos da tela · técnica T4.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button asChild size="sm" variant="outline" className="font-mono text-xs">
            <Link to="/diagnostico">DIAGNÓSTICO</Link>
          </Button>
          <Button asChild size="sm" variant="outline" className="font-mono text-xs">
            <Link to="/claude">
              <Bot className="mr-1 h-3.5 w-3.5" />
              CLAUDE
            </Link>
          </Button>
          <Badge variant="outline" className="font-mono">
            {T4_PRODUCTION_VERSION}
          </Badge>
        </div>
      </header>

      {insecureContext && (
        <p className="rounded border border-amber-500/50 bg-amber-500/10 p-2 text-xs text-amber-500">
          Esta página não está em contexto seguro (HTTPS ou localhost). O navegador não vai permitir
          a captura de tela.
        </p>
      )}

      {/*
        STATUS + BOTÃO ÚNICO no topo: é a primeira pergunta do operador ao abrir
        a tela, e nenhum número abaixo significa nada enquanto um dos pontos
        estiver vermelho.
      */}
      <ProfitVisionPanel
        vision={vision}
        gpuStatus={diagnostics.gpuStatus}
        t4State={diagnostics.t4Flow}
      />

      {/*
        VIÉS antes de sinal. O operador precisa saber para que lado a leitura
        aponta bem antes de existir entrada — e precisa que isso NÃO se pareça
        com uma ordem. Por isso "VIÉS OBSERVADO", e nunca "COMPRA".
      */}
      <Card className="flex flex-wrap items-center gap-x-4 gap-y-1 border-border/70 bg-panel p-3">
        <span className="nexus-eyebrow">MOTOR T4</span>
        <span className="font-mono text-xs text-bull">{diagnostics.t4Engine}</span>
        <span className="nexus-eyebrow">MATURIDADE DO SETUP</span>
        <span className="font-mono text-xs">{diagnostics.t4Percent}%</span>
        <span
          className={cn(
            "font-mono text-xs",
            diagnostics.direction === "COMPRA" && "text-bull",
            diagnostics.direction === "VENDA" && "text-bear",
            diagnostics.direction === null && "text-muted-foreground",
          )}
        >
          {diagnostics.bias}
        </span>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          maturidade não é probabilidade de acerto
        </span>
      </Card>

      <OperationCard
        operation={vision.operation}
        priceScaleReady={diagnostics.priceScaleReady}
        calibrating={!diagnostics.priceScaleReady}
      />

      {/*
        O QUE O OPERADOR ABRE QUANDO O ALERTA TOCA. Os números aqui vêm do
        registro CONGELADO no instante da decisão — não da decisão nova que o
        painel acima republica a cada frame.
      */}
      <FrozenEvidenceCard evidencias={vision.evidencias} />

      {/*
        TESTE DA ENTRADA — um setup A/A+ real pode não vir por horas, e sem isto
        a primeira vez que o painel de entrada é exercitado seria no instante do
        primeiro sinal de verdade. A simulação usa o plano que a técnica calculou
        para o gráfico de agora e atravessa os MESMOS componentes.
      */}
      <Card className="flex flex-col gap-2 border-dashed border-amber-500/60 bg-panel p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="nexus-eyebrow text-amber-500">TESTE — ENTRADA SIMULADA</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => vision.simulate()}
            disabled={vision.analysis === null}
          >
            <FlaskConical className="mr-1.5 h-3.5 w-3.5" />
            SIMULAR PELA LEITURA
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="font-mono text-xs"
            onClick={() => vision.simulate("COMPRA")}
            disabled={vision.analysis === null}
          >
            COMPRA
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="font-mono text-xs"
            onClick={() => vision.simulate("VENDA")}
            disabled={vision.analysis === null}
          >
            VENDA
          </Button>
          {vision.simulation && (
            <Button size="sm" variant="ghost" onClick={vision.clearSimulation}>
              LIMPAR
            </Button>
          )}
          <span className="ml-auto text-[11px] text-muted-foreground">
            Não gera ordem, não grava evidência, não altera o estado da T4.
          </span>
        </div>

        {vision.simulationError !== null && (
          <p className="rounded border border-amber-500/50 bg-amber-500/10 p-2 text-xs text-amber-500">
            {vision.simulationError}
          </p>
        )}

        {vision.simulation && (
          <>
            <p className="rounded border border-amber-500 bg-amber-500/15 p-2 text-xs font-semibold text-amber-500">
              {SIMULATION_WARNING}
            </p>
            <p className="text-[11px] text-muted-foreground">
              Direção {vision.simulation.directionFromReading ? "veio da leitura" : "foi arbitrada"}{" "}
              · {vision.simulation.readingSummary}
            </p>
            <OperationCard
              operation={vision.simulation}
              priceScaleReady={diagnostics.priceScaleReady}
              calibrating={!diagnostics.priceScaleReady}
            />
          </>
        )}
      </Card>

      <Card className="grid gap-3 border-border/70 bg-panel p-3 md:grid-cols-[180px_220px_1fr]">
        <div>
          <Label htmlFor="asset">Ativo</Label>
          <Input
            id="asset"
            value={liveAsset}
            disabled={vision.requested}
            onChange={(event) => setLiveAsset(event.target.value.toUpperCase())}
          />
        </div>
        <div>
          <Label htmlFor="mode">Fonte</Label>
          <div id="mode" className="flex gap-1">
            {SOURCE_MODES.map((mode) => (
              <Button
                key={mode}
                size="sm"
                variant={sourceMode === mode ? "default" : "outline"}
                className="font-mono text-xs"
                onClick={() => setSourceMode(mode)}
              >
                {SOURCE_MODE_LABEL[mode]}
              </Button>
            ))}
          </div>
        </div>
        {/*
          A distinção não é cosmética: em REPLAY a data e a hora TÊM de vir do
          gráfico. Deixar o relógio do sistema carimbar um pregão de março com a
          data de hoje produz um Golden que parece provar e não prova nada.
        */}
        <p className="flex items-center rounded-md border border-border/70 px-3 text-xs text-muted-foreground">
          {sourceMode === "LIVE"
            ? "Ao vivo: o pregão é agora, e a data do sistema é referência legítima."
            : "Replay: data e hora vêm do gráfico do Profit. Sem leitura do eixo, o carimbo fica NÃO CONFIÁVEL."}
        </p>
      </Card>

      <AnalysisCockpit
        asset={liveAsset}
        candles={vision.tracker.candles}
        analysis={vision.analysis}
        decision={vision.decision}
        entryState={vision.entryState}
        operationStatus={null}
        operationDetail={null}
        progress={{
          // FUNCIONAL e binario: 0 ou 100. Um numero intermediario aqui era lido
          // como "falta algo para o sistema funcionar", quando o que falta e
          // oportunidade de mercado — que tem seu proprio numero na maturidade.
          percent: progress.percent as 0 | 10 | 20 | 30 | 40 | 50 | 60 | 70 | 80 | 90 | 100,
          status:
            progress.percent >= 100
              ? "CONFIRMADO"
              : progress.percent === 0
                ? "AGUARDAR"
                : "ANALISANDO",
          stages: {
            ESTRUTURA: progress.stepsDone >= 5,
            LIQUIDEZ: progress.stepsDone >= 6,
            CONTRAPONTO: progress.functional,
            CONFLUENCIAS: progress.functional,
            ENTRADA: vision.operation.confirmed,
          },
          blockers: diagnostics.blockReason ? [diagnostics.blockReason] : [],
          currentStepLabel: progress.next ?? progress.label,
        }}
        snapshot={null}
        // MESMA fonte do diagnóstico. Sem isto o cockpit caía em `new Date()` e
        // dizia 11/08 enquanto o painel abaixo dizia NÃO CONFIÁVEL.
        tradingDateLabel={diagnostics.marketDate ?? undefined}
        priceScaleReady={diagnostics.priceScaleReady}
        dataReady={vision.reading}
        /*
         * PROMOÇÃO ASSISTIDA = determinística ∧ validação IA (BLOCO 6).
         * A regra do operador: CONFIRMADO exige T4 PASS ∧ Luna ≠ REJECT ∧
         * Terra APPROVE (finalConfirmation no servidor). IA indisponível ⇒
         * a técnica segue monitorando e capturando, mas o selo de operação
         * NÃO acende — o painel de validação abaixo diz o porquê.
         */
        t4Confirmed={vision.operation.confirmed && vision.aiValidation?.confirmado === true}
        aiValidationRows={vision.aiValidation?.rows ?? null}
        calibrationSummary={
          diagnostics.priceScaleReady
            ? `escala calibrada · ${diagnostics.anchors} âncoras · R² ${diagnostics.scaleR2?.toFixed(4) ?? "—"}`
            : // Antes da primeira tentativa nao existe motivo, e a frase
              // terminava num traco solto. Sem motivo, nao ha o que anexar.
              `escala em calibração — estrutura já legível${
                vision.scale.reject === null ? "" : ` · ${describeReject(vision.scale.reject)}`
              }`
        }
        chat={vision.chat}
        aiProvider={vision.aiProvider}
      />

      <div className="grid gap-3 lg:grid-cols-2">
        <PipelineDiagnosticsCard diagnostics={diagnostics} />
        <RecordingStatusCard />
      </div>
    </div>
  );
}
