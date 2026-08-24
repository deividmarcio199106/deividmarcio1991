import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { AnalystAssistant } from "@/components/learning/AnalystAssistant";
import { Card } from "@/components/ui/card";
import { evaluateEvidence } from "@/lib/engines/evidenceValidation";
import { computeStats, groupBy } from "@/lib/engines/performanceEngine";
import { setupErrorMatrix } from "@/lib/engines/postTradeReview";
import { filterEvidenceTrades } from "@/lib/engines/evidenceFilter";
import { store, type ReplayRecordingRecord } from "@/lib/storage";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/aprendizado")({
  component: LabPage,
  head: () => ({
    meta: [
      { title: "Laboratório de Técnicas — NEXUS T4" },
      {
        name: "description",
        content:
          "Estatística real dos backtests: setups encontrados, validação fora da amostra e candidatos — com evidência estatística e sem confiança inventada.",
      },
    ],
  }),
});

/**
 * LABORATÓRIO DE TÉCNICAS (comando §13–§14).
 *
 * O laboratório não usa nota agregada como autoridade: a técnica em produção só muda quando uma candidata prova
 * melhoria com amostra mínima, out-of-sample e walk-forward. A IA recebe a
 * ESTATÍSTICA dos backtests — nunca um pedido para inventar autoridade operacional.
 */
function LabPage() {
  const [sessions, setSessions] = useState<ReplayRecordingRecord[]>([]);
  const [revision, setRevision] = useState(0);

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
    }, 5_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const lab = useMemo(() => {
    const records = store.backtests();
    // §28: LEGACY_IMAGE fica só como histórico — fora da evidência por padrão.
    const trades = filterEvidenceTrades(records);
    const legacyCount = records
      .filter((record) => (record.origin ?? "LEGACY_IMAGE") === "LEGACY_IMAGE")
      .reduce((sum, record) => sum + record.trades.length, 0);
    const stats = computeStats(trades);
    const evidence = evaluateEvidence(trades);
    const setups = groupBy(trades, (trade) => trade.setup);
    const errors = setupErrorMatrix(trades);
    // Setup "validado" = amostra mínima + expectância positiva no agregado.
    const validated = setups.filter((setup) => setup.total >= 30 && setup.r > 0);
    const candidates = setups.filter((setup) => setup.total < 30);
    const lastUpdate = records.reduce((max, record) => Math.max(max, record.createdAt), 0);
    const productionTechnique = store.productionTechnique();
    const versionedCandidates = store.techniqueCandidates();
    const dailyLearningReports = store.dailyLearningReports();
    const context = [
      `Sessões de observação: ${sessions.length}. Operações na base: ${trades.length}.`,
      trades.length
        ? `Desempenho agregado: acerto ${stats.winRate.toFixed(1)}%, expectância ${stats.expectancy.toFixed(2)}R, PF ${Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : "n/d"}, drawdown ${stats.maxDrawdown.toFixed(1)}R.`
        : "Base vazia.",
      `Validação: OOS ${evidence.oosValidated ? "positivo" : "não validado"}, walk-forward ${evidence.walkForward.stable ? "estável" : "instável"}, confiança ${evidence.confidence}.`,
      `Setups validados (amostra ≥ 30 e expectância > 0): ${validated.map((s) => s.key).join(", ") || "nenhum"}.`,
      `Setups candidatos (amostra insuficiente): ${candidates.map((s) => `${s.key} (${s.total}/30)`).join(", ") || "nenhum"}.`,
      dailyLearningReports[0]
        ? `Último aprendizado diário (${dailyLearningReports[0].tradingDate}): ${dailyLearningReports[0].lessons.join(" | ")}`
        : "Ainda sem relatório de aprendizado diário T4.",
      "Regra do laboratório: hipótese → backtest → validação → out-of-sample → walk-forward → comparação com a versão atual → aprovação. Nunca alterar a técnica em produção sem essa trilha.",
    ].join("\n");
    return {
      records,
      trades,
      stats,
      evidence,
      setups,
      errors,
      validated,
      candidates,
      lastUpdate,
      context,
      legacyCount,
      productionTechnique,
      versionedCandidates,
      dailyLearningReports,
    };
  }, [sessions, revision]);

  return (
    <div className="flex flex-col gap-3">
      <header>
        <h1 className="font-display text-2xl font-bold">Laboratório de Técnicas</h1>
        <p className="text-xs text-muted-foreground">
          A técnica em produção só muda quando uma candidata prova melhoria: amostra mínima,
          out-of-sample e walk-forward. Amostra pequena aparece como AMOSTRA INSUFICIENTE — nunca
          como confiança inventada.
        </p>
      </header>

      <Card className="grid gap-2 border-border/70 bg-panel p-3 text-center sm:grid-cols-7">
        <Metric label="Sessões" value={String(sessions.length)} />
        <Metric label="Operações" value={String(lab.trades.length)} />
        <Metric label="Legado (fora)" value={String(lab.legacyCount)} />
        <Metric label="Setups" value={String(lab.setups.length)} />
        <Metric
          label="Validados"
          value={String(lab.validated.length)}
          tone={lab.validated.length ? "bull" : undefined}
        />
        <Metric label="Candidatos" value={String(lab.candidates.length)} />
        <Metric
          label="Atualização"
          value={lab.lastUpdate ? new Date(lab.lastUpdate).toLocaleDateString("pt-BR") : "—"}
        />
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="flex flex-col gap-2 border-border/70 bg-panel p-3">
          <p className="text-[10px] font-medium tracking-widest text-muted-foreground">
            TÉCNICA EM PRODUÇÃO
          </p>
          <div className="grid grid-cols-2 gap-2 font-mono text-xs">
            <Metric label="Versão" value={lab.productionTechnique?.version ?? "—"} />
            <Metric label="Status" value={lab.productionTechnique?.status ?? "—"} />
            <Metric label="OOS" value={lab.evidence.oosValidated ? "APROVADO" : "NÃO APROVADO"} />
            <Metric
              label="Walk-forward"
              value={lab.evidence.walkForward.stable ? "APROVADO" : "NÃO APROVADO"}
            />
          </div>
          <p className="text-[10px] text-muted-foreground">
            A versão é congelada no início de cada sessão ao vivo. Candidatas não alteram uma sessão
            em andamento.
          </p>
        </Card>

        <Card className="flex flex-col gap-2 border-border/70 bg-panel p-3">
          <p className="text-[10px] font-medium tracking-widest text-muted-foreground">
            CANDIDATAS VERSIONADAS
          </p>
          {lab.versionedCandidates.length > 0 ? (
            <div className="flex max-h-40 flex-col gap-1 overflow-auto font-mono text-[11px]">
              {lab.versionedCandidates.map((candidate) => (
                <div key={candidate.id} className="rounded border border-border/50 p-2">
                  <div className="flex justify-between gap-2">
                    <strong>{candidate.version}</strong>
                    <span>{candidate.status}</span>
                  </div>
                  <p className="mt-1 text-muted-foreground">{candidate.hypothesis}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Nenhuma candidata versionada registrada. Hipóteses observadas abaixo continuam apenas
              como pesquisa até passarem pela trilha formal de validação.
            </p>
          )}
        </Card>
      </div>

      <Card className="flex flex-col gap-2 border-border/70 bg-panel p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] font-medium tracking-widest text-muted-foreground">
            APRENDIZADO DIÁRIO T4
          </p>
          <span className="font-mono text-[10px] text-muted-foreground">
            produção imutável durante a sessão
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Ao encerrar cada pregão, a T4 revisa gains/losses, MFE/MAE e setups. Lições viram
          candidatas de laboratório; nenhuma regra muda a produção sem OOS, walk-forward e promoção.
        </p>
        {lab.dailyLearningReports.length > 0 ? (
          <div className="max-h-56 overflow-auto">
            <table className="w-full font-mono text-[11px]">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-2">Pregão</th>
                  <th className="py-1 pr-2">Trades</th>
                  <th className="py-1 pr-2">G/L</th>
                  <th className="py-1 pr-2">R</th>
                  <th className="py-1 pr-2">PF rolling</th>
                  <th className="py-1 text-right">Estado</th>
                </tr>
              </thead>
              <tbody>
                {lab.dailyLearningReports.slice(0, 30).map((report) => (
                  <tr key={report.id} className="border-t border-border/40">
                    <td className="py-1 pr-2">{report.tradingDate}</td>
                    <td className="py-1 pr-2">{report.daily.trades}</td>
                    <td className="py-1 pr-2">
                      {report.daily.wins}/{report.daily.losses}
                    </td>
                    <td
                      className={cn("py-1 pr-2", report.daily.r >= 0 ? "text-bull" : "text-bear")}
                    >
                      {report.daily.r.toFixed(2)}R
                    </td>
                    <td className="py-1 pr-2">{report.rolling.profitFactor?.toFixed(2) ?? "—"}</td>
                    <td className="py-1 text-right">{report.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Ainda não há fechamento diário T4. Encerre um pregão no Backtest ou no Ao Vivo.
          </p>
        )}
      </Card>

      <Card className="flex flex-col gap-2 border-border/70 bg-panel p-3">
        <p className="text-[10px] font-medium tracking-widest text-muted-foreground">
          CONFIGURAÇÕES OBSERVADAS
        </p>
        {lab.setups.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full font-mono text-[11px]">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-2">Setup</th>
                  <th className="py-1 pr-2">Amostra</th>
                  <th className="py-1 pr-2">Resultado</th>
                  <th className="py-1 text-right">Status</th>
                </tr>
              </thead>
              <tbody>
                {lab.setups.map((setup) => {
                  const validated = setup.total >= 30 && setup.r > 0;
                  const insufficient = setup.total < 30;
                  return (
                    <tr key={setup.key} className="border-t border-border/40">
                      <td className="py-1 pr-2">{setup.key}</td>
                      <td className="py-1 pr-2">{setup.total}</td>
                      <td className={cn("py-1 pr-2", setup.r >= 0 ? "text-bull" : "text-bear")}>
                        {setup.r.toFixed(2)}R
                      </td>
                      <td
                        className={cn(
                          "py-1 text-right",
                          validated
                            ? "text-bull"
                            : insufficient
                              ? "text-muted-foreground"
                              : "text-warn",
                        )}
                      >
                        {validated
                          ? "VALIDADO"
                          : insufficient
                            ? `AMOSTRA INSUFICIENTE (${setup.total}/30)`
                            : "NÃO VALIDADO"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Nenhum setup registrado — grave períodos no Backtest para o laboratório ter material.
          </p>
        )}
      </Card>

      {lab.errors.length > 0 && (
        <Card className="flex flex-col gap-1 border-border/70 bg-panel p-3">
          <p className="text-[10px] font-medium tracking-widest text-muted-foreground">
            MATRIZ DE ERROS POR SETUP (autoavaliação pós-operação)
          </p>
          <div className="overflow-x-auto">
            <table className="w-full font-mono text-[11px]">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-2">Setup</th>
                  <th className="py-1 pr-2">Ops</th>
                  <th className="py-1 pr-2">Falso positivo</th>
                  <th className="py-1 pr-2">Stop ruim</th>
                  <th className="py-1 text-right">Alvo ruim</th>
                </tr>
              </thead>
              <tbody>
                {lab.errors.slice(0, 8).map((row) => (
                  <tr key={row.setupId} className="border-t border-border/40">
                    <td className="py-1 pr-2">{row.setupId}</td>
                    <td className="py-1 pr-2">{row.total}</td>
                    <td className="py-1 pr-2">{row.falsePositives}</td>
                    <td className="py-1 pr-2">{row.badStop}</td>
                    <td className="py-1 text-right">{row.badTarget}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <AnalystAssistant
        context={lab.context}
        scope="aprendizado"
        metrics={{
          backtests: lab.records.length,
          trades: lab.trades.length,
          validatedSetups: lab.validated.length,
          totalSetups: Math.max(1, lab.setups.length),
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
