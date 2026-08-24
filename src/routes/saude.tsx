import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { HealthPanel } from "@/components/health/HealthPanel";
import { marketMonitor } from "@/lib/capture/marketMonitor";
import {
  aggregateHealth,
  medirFila,
  medirIdadeUltimaCaptura,
  naoMedido,
  type SubsystemHealth,
  type SystemHealth,
} from "@/lib/health/systemHealth";

export const Route = createFileRoute("/saude")({
  component: SaudePage,
  head: () => ({ meta: [{ title: "Saúde — NEXUS T4" }] }),
});

/**
 * SAÚDE DO SISTEMA — o que está medido, o que não está, e o que isso impede.
 *
 * A página junta DUAS fontes que ninguém sozinho consegue ver inteiras:
 * o SERVIDOR (IA, banco, armazenamento, memória, setups em aberto) via
 * /api/health/system, e o NAVEGADOR (captura de 60s, fila, última captura),
 * que só existe aqui porque o monitor é um singleton do cliente.
 *
 * O servidor devolve esses subsistemas do cliente como "não medido"; esta
 * página os SUBSTITUI pelas leituras reais do monitor e reagrega. Sem essa
 * junção o painel diria "degradado" para sempre num sistema saudável — e um
 * painel que mente para baixo é abandonado tão rápido quanto um que mente
 * para cima.
 */

const INTERVALO_MS = 15_000;
/**
 * Prazo do health. Curto de propósito: um diagnóstico que demora mais que isto
 * já é, ele próprio, o sintoma — e vira ERRO declarado em vez de espera.
 */
const TIMEOUT_HEALTH_MS = 10_000;

function SaudePage() {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const consultar = useCallback(async () => {
    const agora = Date.now();
    let doServidor: SubsystemHealth[] = [];
    try {
      /*
       * TIMEOUT EXPLÍCITO — spinner eterno é o pior estado possível num
       * painel de saúde: ele parece "ainda medindo" quando na verdade o
       * backend não responde, e o operador espera em vez de agir. Estourado o
       * prazo, o próprio painel vira ERRO com o motivo.
       */
      const resposta = await fetch("/api/health/system", {
        signal: AbortSignal.timeout(TIMEOUT_HEALTH_MS),
        // Diagnóstico nunca pode vir de cache: um estado velho lido como atual
        // é exatamente o tipo de mentira que este painel existe para não contar.
        cache: "no-store",
      });
      if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
      const corpo = (await resposta.json()) as SystemHealth;
      doServidor = corpo.subsystems;
      setErro(null);
    } catch (problema) {
      const motivo =
        problema instanceof Error && problema.name === "TimeoutError"
          ? `não respondeu em ${TIMEOUT_HEALTH_MS / 1000}s`
          : problema instanceof Error
            ? problema.message
            : String(problema);
      setErro(motivo);
      // Servidor fora NÃO vira painel vazio: vira ERRO declarado no lugar dele.
      doServidor = [
        {
          id: "banco",
          label: "SERVIDOR",
          state: "ERROR",
          detail: "não respondeu ao health consolidado dentro do prazo",
          value: null,
          unit: null,
        },
      ];
    }

    /*
     * Leituras do CLIENTE substituem as que o servidor marcou como não
     * medidas. O ciclo só está de fato saudável com a stream viva: monitor
     * "rodando" com track morta é a falha silenciosa que o heartbeat existe
     * para pegar, e ela não pode aparecer verde aqui.
     */
    const estado = marketMonitor.getState();
    const rodando =
      estado.stage === "MONITORANDO" ||
      estado.stage === "CAPTURANDO" ||
      estado.stage === "ANALISANDO";
    const doCliente: SubsystemHealth[] = [
      rodando && estado.streamOk
        ? {
            id: "captura",
            label: "CAPTURA 60s",
            state: estado.lastError === null ? "OK" : "DEGRADED",
            detail:
              estado.lastError === null
                ? `monitor ${estado.stage.toLowerCase()}, stream viva`
                : `última captura falhou: ${estado.lastError}`,
            value: estado.captures,
            unit: null,
          }
        : rodando
          ? {
              id: "captura",
              label: "CAPTURA 60s",
              state: "ERROR",
              detail: "monitor ativo mas a stream parou de entregar frames",
              value: estado.captures,
              unit: null,
            }
          : naoMedido("captura", "CAPTURA 60s", `monitor ${estado.stage.toLowerCase()}`),
      medirIdadeUltimaCaptura(estado.lastCaptureAt, agora),
      // Uma análise em curso é 1 na fila; o monitor guarda no máximo um slot.
      medirFila(estado.analysisBusy ? 1 : 0),
      {
        id: "ultimo_processamento",
        label: "ÚLTIMO PROCESSAMENTO",
        state: estado.lastLatencyMs === null ? "DEGRADED" : "OK",
        detail:
          estado.lastLatencyMs === null
            ? "não medido — nenhuma análise concluída nesta sessão"
            : `${estado.lastReason ?? "análise"} concluída`,
        value: estado.lastLatencyMs,
        unit: estado.lastLatencyMs === null ? null : "ms",
      },
    ];

    const idsCliente = new Set(doCliente.map((s) => s.id));
    setHealth(
      aggregateHealth([...doServidor.filter((s) => !idsCliente.has(s.id)), ...doCliente], agora),
    );
  }, []);

  useEffect(() => {
    void consultar();
    const relogio = setInterval(() => void consultar(), INTERVALO_MS);
    return () => clearInterval(relogio);
  }, [consultar]);

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">Saúde</h1>
          <p className="text-xs text-muted-foreground">
            Servidor e navegador medidos juntos. Subsistema sem leitura aparece como DEGRADADO — não
            medido nunca conta como saudável.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto font-mono text-xs"
          onClick={() => void consultar()}
        >
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          ATUALIZAR
        </Button>
      </header>

      {erro !== null && (
        <Card className="border-bear/60 bg-bear/10 p-3">
          <p className="font-mono text-[11px] text-bear">
            /api/health/system falhou: {erro}. O painel abaixo já reflete isso.
          </p>
        </Card>
      )}

      {health === null ? (
        <Card className="border-border/70 bg-panel p-3">
          <p className="text-xs text-muted-foreground">Consultando…</p>
        </Card>
      ) : (
        <HealthPanel health={health} />
      )}
    </div>
  );
}
