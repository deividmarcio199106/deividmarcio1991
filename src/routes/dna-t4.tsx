import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import { DetectionCards } from "@/components/dna/DetectionCards";
import { ExitSection } from "@/components/dna/ExitSection";
import { formatInt } from "@/components/dna/format";
import { LossSection } from "@/components/dna/LossSection";
import { PatternSection } from "@/components/dna/PatternSection";
import { SegmentSection } from "@/components/dna/SegmentSection";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { SetupDna } from "@/lib/t4/dna";
import type {
  DnaOutcome,
  ExitSchemeResult,
  LossFactor,
  PatternFinding,
  SegmentMetrics,
} from "@/lib/t4/dnaStats";

export const Route = createFileRoute("/dna-t4")({
  component: DnaT4Page,
  head: () => ({ meta: [{ title: "DNA T4 — NEXUS T4" }] }),
});

/** O que o servidor calcula sobre TODOS os registros — o navegador recebe
 * leitura pronta, nunca milhares de linhas para agregar aqui. */
interface DnaPanelPayload {
  detected: number;
  withResult: number;
  segments: Record<string, SegmentMetrics[]>;
  patterns: PatternFinding[];
  lossFactors: LossFactor[];
  exitSchemes: ExitSchemeResult[];
}

interface DnaListPayload {
  detections: SetupDna[];
  outcomes: DnaOutcome[];
}

/**
 * Estado de carga como união discriminada: falha SEM motivo não existe aqui.
 * "erro" carrega a frase que o operador lê antes de clicar em tentar de novo.
 */
type LoadState =
  | { status: "carregando" }
  | { status: "erro"; motivo: string }
  | { status: "pronto"; panel: DnaPanelPayload; detections: SetupDna[]; outcomes: DnaOutcome[] };

/**
 * PAINEL DNA T4 — leitura, nunca decisão.
 *
 * Tudo nesta página é estatística descritiva do que o motor JÁ detectou e do
 * que as operações JÁ renderam. Nada aqui bloqueia setup, altera regra ou
 * escolhe filtro — quem muda técnica é o Laboratório, com validação fora da
 * amostra. As guardas de apresentação (amostra insuficiente sem cor de
 * conclusão, associação dita como associação) vivem nos componentes de seção.
 */
function DnaT4Page() {
  const [state, setState] = useState<LoadState>({ status: "carregando" });

  const load = useCallback(async () => {
    setState({ status: "carregando" });
    try {
      const [panelResponse, dnaResponse] = await Promise.all([
        fetch("/api/trading/dna-panel"),
        fetch("/api/trading/dna"),
      ]);
      // O motivo nomeia O ENDPOINT que falhou — "erro ao carregar" genérico
      // obrigaria o operador a abrir o console para saber onde olhar.
      if (!panelResponse.ok) {
        throw new Error(`/api/trading/dna-panel respondeu HTTP ${panelResponse.status}`);
      }
      if (!dnaResponse.ok) {
        throw new Error(`/api/trading/dna respondeu HTTP ${dnaResponse.status}`);
      }
      const panel = (await panelResponse.json()) as DnaPanelPayload;
      const list = (await dnaResponse.json()) as DnaListPayload;
      setState({
        status: "pronto",
        panel,
        detections: list.detections ?? [],
        outcomes: list.outcomes ?? [],
      });
    } catch (error) {
      setState({
        status: "erro",
        motivo: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">DNA T4</h1>
          <p className="text-xs text-muted-foreground">
            Classificação no instante da decisão, desfecho por fora — leitura estatística, nunca
            bloqueio automático.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={() => void load()}
          disabled={state.status === "carregando"}
        >
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Atualizar
        </Button>
      </header>

      {state.status === "carregando" && (
        <Card className="border-border/70 bg-panel p-6 text-center">
          <p className="text-xs text-muted-foreground">Carregando painel DNA…</p>
        </Card>
      )}

      {state.status === "erro" && (
        <Card className="flex flex-col items-start gap-2 border-bear/50 bg-panel p-4">
          <p className="text-xs font-semibold text-bear">Falha ao carregar o painel</p>
          <p className="font-mono text-[11px] text-muted-foreground">{state.motivo}</p>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Tentar de novo
          </Button>
        </Card>
      )}

      {state.status === "pronto" && (
        <PanelBody panel={state.panel} detections={state.detections} outcomes={state.outcomes} />
      )}
    </div>
  );
}

function PanelBody({
  panel,
  detections,
  outcomes,
}: {
  panel: DnaPanelPayload;
  detections: SetupDna[];
  outcomes: DnaOutcome[];
}) {
  // Estado vazio HONESTO: sem nenhuma detecção não há o que segmentar, e a
  // página diz o que fazer para o dado existir — não mostra tabelas em branco.
  if (panel.detected === 0 && detections.length === 0) {
    return (
      <Card className="border-border/70 bg-panel p-8 text-center">
        <p className="text-sm text-muted-foreground">
          0 detecções registradas — rode um replay ou envie um print.
        </p>
      </Card>
    );
  }

  return (
    <>
      <div className="grid gap-2 text-center sm:grid-cols-2">
        <SummaryMetric label="DETECÇÕES" value={panel.detected} />
        <SummaryMetric label="COM RESULTADO" value={panel.withResult} />
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="nexus-eyebrow">DETECÇÕES RECENTES</h2>
        <DetectionCards detections={detections} outcomes={outcomes} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="nexus-eyebrow">PERFORMANCE SEGMENTADA</h2>
        <SegmentSection segments={panel.segments} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="nexus-eyebrow">PADRÕES ENCONTRADOS</h2>
        <PatternSection patterns={panel.patterns} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="nexus-eyebrow">POR QUE PERDEU?</h2>
        <LossSection lossFactors={panel.lossFactors} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="nexus-eyebrow">OTIMIZAÇÃO DE SAÍDA</h2>
        <ExitSection exitSchemes={panel.exitSchemes} />
      </section>
    </>
  );
}

function SummaryMetric({ label, value }: { label: string; value: number }) {
  return (
    <Card className="gap-0.5 border-border/70 bg-background p-2">
      <p className="text-[9px] tracking-widest text-muted-foreground">{label}</p>
      <p className="font-mono text-sm font-bold">{formatInt(value)}</p>
    </Card>
  );
}
