import { AIChatPanel } from "@/components/live/AIChatPanel";
import { AiValidationPanel } from "@/components/analysis/AiValidationPanel";
import { EvidenceTable } from "@/components/live/EvidenceTable";
import { ManagementPanel } from "@/components/live/ManagementPanel";
import { TradeManagementCard } from "@/components/live/TradeManagementCard";
import { T4ProgressCard } from "@/components/t4/T4ProgressCard";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { DecisionObject } from "@/lib/engines/backtestDecisionEngine";
import type { AnalysisResult, Candle, ChatEntry } from "@/lib/engines/types";
import { guardNarration } from "@/lib/t4/priceGuard";
import type { T4Progress } from "@/lib/t4/progress";
import type { TradeSignalSnapshot } from "@/lib/t4/signalSnapshot";

/**
 * COCKPIT ÚNICO DE ANÁLISE — replay e ao vivo usam a MESMA leitura.
 *
 * O preview/gráfico grande foi removido da UI (comando §6): o processamento
 * (captura→OCR→chartClock→candles→T4→gravação) continua rodando no serviço
 * global; a UI mostra o painel T4 — LEITURA TÉCNICA 0–100%, cujo percentual
 * vem exclusivamente do estado REAL do pipeline. Nada aqui inventa dados — o
 * que não existe aparece como AGUARDANDO.
 */
export interface AnalysisCockpitProps {
  asset: string;
  candles: Candle[];
  analysis: AnalysisResult | null;
  decision: DecisionObject | null;
  entryState?: string;
  operationStatus?: string | null;
  operationDetail?: string | null;
  /** Progresso 0–100 da leitura técnica, derivado do estado real. */
  progress: T4Progress;
  /** Snapshot congelado do sinal confirmado — única fonte dos níveis em 100%. */
  snapshot: TradeSignalSnapshot | null;
  chat: ChatEntry[];
  aiProvider: { configured: boolean; model: string; provider: string };
  /** Rótulo do pregão em revisão; ao vivo é a data de hoje. */
  tradingDateLabel?: string;
  /**
   * Conversão pixel→preço confiável. FALSE não significa "sem análise": a
   * leitura estrutural roda igual e só os números de preço ficam indisponíveis.
   */
  priceScaleReady?: boolean;
  /** O estágio da T4 confirmou a entrada? Mantém os dois cards em acordo. */
  t4Confirmed?: boolean;
  dataReady?: boolean;
  /** Linha única e consolidada do estado da calibração. */
  calibrationSummary?: string;
  /**
   * As quatro linhas da validação OpenAI (aiStatusRows). null = ainda não
   * rodou nesta captura — o painel mostra NÃO CHAMADO, nunca some.
   */
  aiValidationRows?: { luna: string; terra: string; t4: string; veredito: string } | null;
}

export function AnalysisCockpit({
  asset,
  candles,
  analysis,
  decision,
  entryState,
  operationStatus,
  operationDetail,
  progress,
  snapshot,
  chat,
  aiProvider,
  tradingDateLabel,
  priceScaleReady = true,
  t4Confirmed,
  // Em RTD, "analysis" preenchido nao basta: um resultado antigo sobrevive a
  // queda do feed. Sem dado valido a etiqueta nao pode dizer ANALISE ATIVA.
  dataReady = true,
  calibrationSummary,
  aiValidationRows = null,
}: AnalysisCockpitProps) {
  return (
    // COCKPIT NEXUS: contexto | leitura T4 dominante | decisão. Empilha no mobile.
    <div className="grid gap-3 xl:grid-cols-[250px_minmax(0,1fr)_350px]">
      {/* Coluna esquerda — CONTEXTO DO MERCADO */}
      <div className="flex flex-col gap-3 xl:order-1">
        <Card className="nexus-card nexus-enter gap-2 p-3">
          <p className="nexus-eyebrow">Contexto do mercado</p>
          {/* DOIS ESTADOS INDEPENDENTES: análise ≠ calibração de preço. */}
          <div className="flex flex-wrap gap-1.5">
            <Badge
              variant="outline"
              className={
                analysis && dataReady
                  ? "border-bull text-bull"
                  : "border-border text-muted-foreground"
              }
            >
              {analysis && dataReady
                ? "ANÁLISE ATIVA"
                : dataReady
                  ? "AGUARDANDO GRÁFICO"
                  : "SEM DADO VÁLIDO"}
            </Badge>
            <Badge
              variant="outline"
              className={priceScaleReady ? "border-bull text-bull" : "border-warn text-warn"}
            >
              {/* Sem dado válido não há calibração em curso — dizer CALIBRANDO
                  ali afirma um trabalho que ninguém está fazendo. */}
              {priceScaleReady
                ? "PREÇOS DISPONÍVEIS"
                : dataReady
                  ? "PREÇOS INDISPONÍVEIS (CALIBRANDO)"
                  : "PREÇOS INDISPONÍVEIS (AGUARDANDO DADO)"}
            </Badge>
          </div>
          {!priceScaleReady && calibrationSummary && (
            <p className="text-[10px] leading-snug text-warn">{calibrationSummary}</p>
          )}
          <div className="flex flex-col gap-1.5 text-xs">
            <ContextRow label="ATIVO" value={asset} accent />
            <ContextRow label="REGIME" value={analysis?.regime.regime ?? "—"} />
            <ContextRow label="LEITURA" value={analysis?.reading.label ?? "AGUARDANDO"} />
            <ContextRow
              label="ESCALA"
              value={priceScaleReady ? "CALIBRADA" : dataReady ? "CALIBRANDO" : "AGUARDANDO"}
            />
            <ContextRow label="CANDLES FECHADOS" value={String(candles.length)} />
            <ContextRow label="DERIVA" value={decision?.marketDrift ?? "—"} />
            <ContextRow label="SAÚDE DA TÉCNICA" value={decision?.strategyHealth ?? "—"} />
            {/*
              PREGÃO vem do gráfico. O padrão anterior era `new Date()` — a data
              de HOJE —, e por isso este card dizia "11/08/2026" enquanto o
              diagnóstico, na mesma tela, dizia NÃO CONFIÁVEL. Num replay de
              março os dois estariam errados, e um deles parecia certo.
            */}
            <ContextRow label="PREGÃO" value={tradingDateLabel ?? "NÃO CONFIÁVEL"} />
          </div>
        </Card>
        {/* Validação independente: Luna/Terra/T4/veredito — sempre visível. */}
        <AiValidationPanel rows={aiValidationRows} />
        {analysis && (
          <Card className="nexus-card gap-2 p-3">
            <p className="nexus-eyebrow">Sequência causal — {analysis.sequence.label}</p>
            <div className="flex flex-col gap-1 font-mono text-[11px]">
              {analysis.sequence.stages.map((stage) => (
                <span
                  key={stage.stage}
                  title={stage.note}
                  className={stage.met ? "text-bull" : "text-muted-foreground"}
                >
                  {stage.met ? "✓" : "·"} {stage.stage}
                </span>
              ))}
            </div>
          </Card>
        )}
      </div>

      {/* Coluna central — T4 LEITURA TÉCNICA (substitui o gráfico grande) */}
      <div className="flex min-w-0 flex-col gap-3 xl:order-2">
        <T4ProgressCard asset={asset} progress={progress} snapshot={snapshot} />
        <EvidenceTable evidences={analysis?.evidences ?? []} priceScaleReady={priceScaleReady} />
        <ManagementPanel analysis={analysis} asset={asset} />
      </div>

      {/* Coluna direita — DECISÃO + ADVERSARIAL + IA */}
      <div className="flex flex-col gap-3 xl:order-3">
        <div className="nexus-enter">
          <TradeManagementCard
            decision={decision}
            entryState={entryState}
            operationStatus={operationStatus ?? null}
            operationDetail={operationDetail ?? null}
            // Com candles na tela, a ausência de plano é falta de SETUP, não de
            // dado — e sem escala, o que falta é a régua, não o dado.
            candles={candles.length}
            priceScaleReady={priceScaleReady}
            // O card do gerenciamento e o card da T4 têm de concordar sobre a
            // mesma operação: dois estados simultâneos foi o defeito relatado.
            t4Confirmed={t4Confirmed}
          />
        </div>
        {analysis && analysis.contradictions.length > 0 && (
          <Card className="nexus-card gap-2 p-3">
            <p className="nexus-eyebrow">
              Motor adversarial — por que não operar ({analysis.regime.regime})
            </p>
            <ul className="flex flex-col gap-1 text-xs">
              {analysis.contradictions.map((item) => (
                <li key={item.id} className="flex items-start gap-2">
                  <Badge
                    variant="outline"
                    className={
                      item.severity === "bloqueia"
                        ? "border-bear text-bear"
                        : item.severity === "alerta"
                          ? "border-warn text-warn"
                          : "border-border text-muted-foreground"
                    }
                  >
                    {item.severity}
                  </Badge>
                  <span>
                    {item.description}{" "}
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {/*
                        A evidência do motor adversarial cita níveis: "liquidez=295.00
                        entre entrada 303.00 e parcial 141.74". Sem escala validada
                        esses números são coordenadas de pixel, e apareciam na mesma
                        tela que anunciava a calibração em andamento.
                      */}
                      [{guardNarration(item.evidence, priceScaleReady)}]
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
        <Card className="nexus-card h-64 overflow-hidden p-0">
          <AIChatPanel entries={chat} provider={aiProvider} />
        </Card>
      </div>
    </div>
  );
}

function ContextRow({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="nexus-eyebrow">{label}</span>
      <span
        className={
          "nexus-value text-right " + (accent ? "font-bold text-primary" : "text-foreground")
        }
      >
        {value}
      </span>
    </div>
  );
}
