import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { FlaskConical, Upload, Zap } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  analisarCsvCompleto,
  type ImportResult,
  type OneClickDeps,
  type RunMetrics,
} from "@/lib/research/csvOneClick";
import type { SweepReport } from "@/lib/research/paramSweep";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/pesquisa")({
  component: PesquisaPage,
  head: () => ({ meta: [{ title: "Pesquisa T4 — NEXUS T4" }] }),
});

/**
 * T4 AUTO RESEARCH — histórico entra, evidência sai.
 *
 * O fluxo do operador: exportar CSV do Profit/Nelogica → importar aqui →
 * INICIAR PESQUISA. O servidor roda o MESMO pipeline T4 do ao vivo, candle a
 * candle, sem futuro: backtest completo, OOS declarado (últimos 15% do
 * período), walk-forward por janelas e Monte Carlo com seed fixa.
 *
 * O que esta tela NUNCA faz: prometer resultado futuro. Backtest é evidência
 * histórica — o ranking pondera PF, drawdown, expectância, estabilidade e
 * amostra, e diz "inelegível" quando a amostra não sustenta conclusão.
 */

type Estado =
  | { fase: "vazio" }
  | { fase: "importando" }
  | { fase: "importado"; importado: ImportResult; datasetId: string }
  // No caminho de um clique só, a importação ainda está encapsulada no
  // encadeamento quando a pesquisa começa — daí `importado` poder ser null.
  | { fase: "pesquisando"; importado: ImportResult | null; datasetId: string }
  | { fase: "pronto"; importado: ImportResult; datasetId: string; metrics: RunMetrics }
  | { fase: "erro"; motivo: string };

/** O ativo pesquisado mora em UM lugar só — dois literais divergem com o tempo. */
const ATIVO = "WINFUT";

/**
 * IO real do navegador. Fica aqui, e não em @/lib/research/csvOneClick, porque
 * `fetch` não é testável sem DOM — lá vive a regra, aqui a tubulação.
 */
const postJson: OneClickDeps["postJson"] = async (url, body) => {
  const resposta = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const corpo: unknown = await resposta.json();
  return { ok: resposta.ok, status: resposta.status, body: corpo };
};

const fmt = (v: number, casas = 2) =>
  Number.isFinite(v) ? v.toLocaleString("pt-BR", { maximumFractionDigits: casas }) : "∞";

function PesquisaPage() {
  const [estado, setEstado] = useState<Estado>({ fase: "vazio" });
  const arquivoRef = useRef<HTMLInputElement | null>(null);
  const arquivoRapidoRef = useRef<HTMLInputElement | null>(null);
  const ocupado = estado.fase === "importando" || estado.fase === "pesquisando";

  const analisarTudo = async (file: File) => {
    setEstado({ fase: "importando" });
    let csv: string;
    try {
      csv = await file.text();
    } catch (erro) {
      setEstado({
        fase: "erro",
        motivo: `falha ao ler o arquivo: ${erro instanceof Error ? erro.message : String(erro)}`,
      });
      return;
    }
    const datasetId = `csv_${file.name.replace(/\W/g, "_")}_${Date.now()}`;
    const resultado = await analisarCsvCompleto(
      { datasetId, csv, asset: ATIVO },
      { postJson },
      (p) =>
        setEstado(
          p.fase === "IMPORTANDO"
            ? { fase: "importando" }
            : { fase: "pesquisando", importado: null, datasetId },
        ),
    );
    if (!resultado.ok) {
      // A etapa vai junto: "falhou" sem dizer onde não ajuda o operador.
      const etapa = resultado.etapa === "IMPORT" ? "importação" : "pesquisa";
      setEstado({ fase: "erro", motivo: `falha na ${etapa}: ${resultado.motivo}` });
      return;
    }
    setEstado({
      fase: "pronto",
      importado: resultado.importado,
      datasetId,
      metrics: resultado.metrics,
    });
  };

  const importar = async (file: File) => {
    setEstado({ fase: "importando" });
    try {
      const csv = await file.text();
      const datasetId = `csv_${file.name.replace(/\W/g, "_")}_${Date.now()}`;
      const resposta = await fetch("/api/trading/research/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ datasetId, csv }),
      });
      const corpo = (await resposta.json()) as ImportResult & { error?: string };
      if (!resposta.ok) throw new Error(corpo.error ?? `HTTP ${resposta.status}`);
      setEstado({ fase: "importado", importado: corpo, datasetId });
    } catch (erro) {
      setEstado({ fase: "erro", motivo: erro instanceof Error ? erro.message : String(erro) });
    }
  };

  /*
   * SWEEP DE CANDIDATAS (§25, §28-30).
   *
   * Roda em cima do MESMO dataset já importado e devolve a tabela ranqueada
   * com o BASELINE dentro. Fica num estado próprio — e não substituindo o
   * resultado da pesquisa simples — porque as duas leituras respondem
   * perguntas diferentes: "a T4 funcionou aqui?" e "alguma variação funciona
   * melhor?". Misturá-las faria o operador ler ranking como promoção.
   */
  const [sweep, setSweep] = useState<SweepReport | null>(null);
  const [sweepando, setSweepando] = useState(false);
  const [sweepErro, setSweepErro] = useState<string | null>(null);

  const testarCandidatas = async () => {
    if (estado.fase !== "importado" && estado.fase !== "pronto") return;
    const { datasetId } = estado;
    setSweepando(true);
    setSweepErro(null);
    try {
      const resposta = await fetch("/api/trading/research/sweep", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ datasetId, asset: ATIVO }),
      });
      const corpo = (await resposta.json()) as { report?: SweepReport; error?: string };
      if (!resposta.ok || !corpo.report) throw new Error(corpo.error ?? `HTTP ${resposta.status}`);
      setSweep(corpo.report);
    } catch (erro) {
      setSweepErro(erro instanceof Error ? erro.message : String(erro));
    } finally {
      setSweepando(false);
    }
  };

  const pesquisar = async () => {
    if (estado.fase !== "importado" && estado.fase !== "pronto") return;
    const { importado, datasetId } = estado;
    setEstado({ fase: "pesquisando", importado, datasetId });
    try {
      const resposta = await fetch("/api/trading/research/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ datasetId, asset: ATIVO }),
      });
      const corpo = (await resposta.json()) as { metrics: RunMetrics; error?: string };
      if (!resposta.ok) throw new Error(corpo.error ?? `HTTP ${resposta.status}`);
      setEstado({ fase: "pronto", importado, datasetId, metrics: corpo.metrics });
    } catch (erro) {
      setEstado({ fase: "erro", motivo: erro instanceof Error ? erro.message : String(erro) });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <header>
        <h1 className="font-display text-2xl font-bold">Pesquisa T4</h1>
        <p className="text-xs text-muted-foreground">
          CSV do Profit/Nelogica → mesmo pipeline T4 do ao vivo, candle a candle, sem futuro → OOS,
          walk-forward e Monte Carlo. Evidência histórica, nunca promessa.
        </p>
      </header>

      <Card className="flex flex-wrap items-center gap-2 border-border/70 bg-panel p-3">
        <input
          ref={arquivoRef}
          type="file"
          accept=".csv,.txt"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importar(file);
            e.target.value = "";
          }}
        />
        <input
          ref={arquivoRapidoRef}
          type="file"
          accept=".csv,.txt"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void analisarTudo(file);
            e.target.value = "";
          }}
        />
        <Button
          size="sm"
          className="font-mono text-xs"
          disabled={ocupado}
          onClick={() => arquivoRapidoRef.current?.click()}
        >
          <Zap className="mr-1.5 h-3.5 w-3.5" />
          ANALISAR CSV
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="font-mono text-xs"
          disabled={ocupado}
          onClick={() => arquivoRef.current?.click()}
        >
          <Upload className="mr-1.5 h-3.5 w-3.5" />
          IMPORTAR CSV
        </Button>
        <Button
          size="sm"
          className="font-mono text-xs"
          disabled={estado.fase !== "importado" && estado.fase !== "pronto"}
          onClick={() => void pesquisar()}
        >
          <FlaskConical className="mr-1.5 h-3.5 w-3.5" />
          INICIAR PESQUISA
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="font-mono text-xs"
          disabled={sweepando || (estado.fase !== "importado" && estado.fase !== "pronto")}
          onClick={() => void testarCandidatas()}
        >
          <FlaskConical className="mr-1.5 h-3.5 w-3.5" />
          {sweepando ? "TESTANDO CANDIDATAS…" : "TESTAR CANDIDATAS"}
        </Button>
        {estado.fase === "importando" && (
          <span className="font-mono text-[11px] text-muted-foreground">importando…</span>
        )}
        {estado.fase === "pesquisando" && (
          <span className="font-mono text-[11px] text-muted-foreground">
            rodando o pipeline T4 candle a candle — pode levar minutos…
          </span>
        )}
      </Card>

      {estado.fase === "erro" && (
        <Card className="border-bear/50 bg-panel p-3">
          <p className="font-mono text-[11px] text-bear">{estado.motivo}</p>
        </Card>
      )}

      {(estado.fase === "importado" || estado.fase === "pesquisando" || estado.fase === "pronto") &&
        estado.importado !== null && (
          <Card className="flex flex-col gap-1 border-border/70 bg-panel p-3">
            <p className="nexus-eyebrow">DATASET</p>
            <p className="font-mono text-[11px]">
              {estado.importado.received.toLocaleString("pt-BR")} candles lidos ·{" "}
              {estado.importado.saved.toLocaleString("pt-BR")} gravados · formato{" "}
              {estado.importado.format}
              {estado.importado.problemCount > 0 &&
                ` · ${estado.importado.problemCount} linha(s) descartada(s) com motivo`}
            </p>
            {estado.importado.problems.slice(0, 3).map((p, i) => (
              <p key={i} className="font-mono text-[10px] text-muted-foreground">
                {p}
              </p>
            ))}
          </Card>
        )}

      {estado.fase === "pronto" && <Resultados m={estado.metrics} />}

      {sweepErro !== null && (
        <Card className="border-bear/50 bg-panel p-3">
          <p className="font-mono text-[11px] text-bear">Sweep de candidatas: {sweepErro}</p>
        </Card>
      )}

      {sweep !== null && <TabelaCandidatas report={sweep} />}
    </div>
  );
}

/**
 * TABELA DE CANDIDATAS — ranking de OBSERVAÇÃO, nunca de promoção.
 *
 * Três coisas a tela é obrigada a deixar explícitas, porque são as que
 * separam pesquisa honesta de curve fitting apresentável:
 * 1. o BASELINE está na tabela e é imutável — sem ele o "melhor" não tem
 *    contra o que ser melhor;
 * 2. a ordenação usa a janela de SELEÇÃO (treino+validação); o OOS aparece ao
 *    lado como VETO, jamais como critério de escolha;
 * 3. `conclusaoAutorizada` é a única coisa que autoriza LER o resultado — e
 *    quando ela é falsa, o motivo vem escrito na própria linha.
 */
function TabelaCandidatas({ report }: { report: SweepReport }) {
  const { contexto, rows } = report;
  return (
    <Card className="flex flex-col gap-2 border-border/70 bg-panel p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="nexus-eyebrow">CANDIDATAS T4</p>
        <Badge variant="outline" className="border-border font-mono text-[10px]">
          {contexto.hipotesesTestadas} HIPÓTESE(S) · PF OOS EXIGIDO {fmt(contexto.pfOosExigido)}
        </Badge>
        <Badge variant="outline" className="border-border font-mono text-[10px]">
          NENHUMA VAI A PRODUÇÃO AUTOMATICAMENTE
        </Badge>
      </div>
      <p className="text-[10px] leading-snug text-muted-foreground">
        Ordenado pela janela de SELEÇÃO (treino+validação) sobre {contexto.pregoes} pregão(ões). A
        janela fora da amostra é VETO, nunca critério de escolha — e a régua do PF sobe a cada
        hipótese testada, porque testar muitas variações é como o histórico engana.
        {contexto.splitProblem !== null ? ` Divisão temporal: ${contexto.splitProblem}` : ""}
      </p>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse font-mono text-[10px]">
          <thead>
            <tr className="text-muted-foreground">
              <th className="p-1 text-left">VARIANTE</th>
              <th className="p-1 text-left">MUDOU</th>
              <th className="p-1 text-right">TRADES</th>
              <th className="p-1 text-right">PF</th>
              <th className="p-1 text-right">EXPECT.</th>
              <th className="p-1 text-right">DD</th>
              <th className="p-1 text-right">WIN%</th>
              <th className="p-1 text-right">OOS PF</th>
              <th className="p-1 text-right">WF</th>
              <th className="p-1 text-left">STATUS</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className={cn(
                  "border-t border-border/40",
                  r.isBaseline && "bg-background/40 font-bold",
                )}
              >
                <td className="p-1">{r.id}</td>
                <td className="max-w-[200px] truncate p-1 text-muted-foreground" title={r.resumo}>
                  {r.isBaseline ? "— referência —" : r.resumo}
                </td>
                <td className="p-1 text-right">{r.selecao.trades}</td>
                <td className="p-1 text-right">{fmt(r.selecao.profitFactor)}</td>
                <td className="p-1 text-right">{fmt(r.selecao.expectancyR, 3)}</td>
                <td className="p-1 text-right">{fmt(r.selecao.maxDrawdownR)}</td>
                <td className="p-1 text-right">{fmt(r.selecao.winRate, 1)}</td>
                <td className="p-1 text-right">{fmt(r.oos.profitFactor)}</td>
                <td className="p-1 text-right">
                  {r.walkForward.avaliado
                    ? `${r.walkForward.positiveFolds}/${r.walkForward.totalFolds}`
                    : "—"}
                </td>
                <td
                  className={cn(
                    "p-1",
                    r.conclusaoAutorizada ? "text-bull" : "text-muted-foreground",
                  )}
                  title={r.motivos.join(" · ")}
                >
                  {r.isBaseline
                    ? "BASELINE"
                    : r.conclusaoAutorizada
                      ? "CANDIDATA"
                      : "NÃO AUTORIZADA"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Os motivos por extenso: linha bloqueada sem motivo seria bloqueio mudo. */}
      {rows
        .filter((r) => !r.isBaseline && r.motivos.length > 0)
        .slice(0, 5)
        .map((r) => (
          <p key={r.id} className="text-[10px] leading-snug text-muted-foreground">
            <span className="font-mono">{r.id}</span>: {r.motivos.join("; ")}
          </p>
        ))}
    </Card>
  );
}

function Resultados({ m }: { m: RunMetrics }) {
  return (
    <>
      <Card className="flex flex-col gap-1.5 border-border/70 bg-panel p-3">
        <div className="flex items-center gap-2">
          <p className="nexus-eyebrow">RESULTADO GERAL</p>
          {m.ranking && (
            <Badge
              variant="outline"
              className={
                m.ranking.eligible
                  ? "border-bull font-mono text-[10px] text-bull"
                  : "border-border font-mono text-[10px] text-muted-foreground"
              }
            >
              {m.ranking.eligible ? `SCORE ${fmt(m.ranking.score)}` : "INELEGÍVEL"}
            </Badge>
          )}
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono text-[11px] sm:grid-cols-4">
          <span className="text-muted-foreground">Trades</span>
          <span>{m.stats.total}</span>
          <span className="text-muted-foreground">Win rate</span>
          <span>{fmt(m.stats.winRate, 1)}%</span>
          <span className="text-muted-foreground">Expectância</span>
          <span>{fmt(m.stats.expectancy, 3)}R</span>
          <span className="text-muted-foreground">Profit factor</span>
          <span>{fmt(m.stats.profitFactor)}</span>
          <span className="text-muted-foreground">Drawdown máx</span>
          <span>{fmt(m.stats.maxDrawdown)}R</span>
          <span className="text-muted-foreground">Resultado líquido</span>
          <span>{fmt(m.stats.cumulativeR)}R</span>
          <span className="text-muted-foreground">Setups detectados</span>
          <span>{m.setupsDetected}</span>
          <span className="text-muted-foreground">Candles</span>
          <span>{m.candles.toLocaleString("pt-BR")}</span>
        </div>
        {m.ranking && (
          <p className="text-[10px] leading-snug text-muted-foreground">{m.ranking.note}</p>
        )}
      </Card>

      <Card className="flex flex-col gap-1 border-border/70 bg-panel p-3">
        <p className="nexus-eyebrow">FORA DA AMOSTRA (últimos 15% do período — nunca otimizados)</p>
        <p className="font-mono text-[11px]">
          {m.oos.trades} trade(s) · expectância {fmt(m.oos.expectancyR, 3)}R
        </p>
      </Card>

      <Card className="flex flex-col gap-1 border-border/70 bg-panel p-3">
        <div className="flex items-center gap-2">
          <p className="nexus-eyebrow">WALK-FORWARD</p>
          <Badge
            variant="outline"
            className={
              m.walkForward.stable
                ? "border-bull font-mono text-[10px] text-bull"
                : "border-amber-500 font-mono text-[10px] text-amber-500"
            }
          >
            {m.walkForward.positiveFolds}/{m.walkForward.totalFolds} FOLDS POSITIVOS ·{" "}
            {m.walkForward.stable ? "ESTÁVEL" : "NÃO ESTÁVEL"}
          </Badge>
        </div>
        <div className="flex flex-wrap gap-2 font-mono text-[11px]">
          {m.walkForward.folds.map((f, i) => (
            <span
              key={i}
              className={
                f.netR > 0 ? "text-bull" : f.netR < 0 ? "text-bear" : "text-muted-foreground"
              }
            >
              #{i + 1}: {fmt(f.netR)}R ({f.trades}t)
            </span>
          ))}
        </div>
      </Card>

      <Card className="flex flex-col gap-1 border-border/70 bg-panel p-3">
        <p className="nexus-eyebrow">
          MONTE CARLO ({m.monteCarlo.runs.toLocaleString("pt-BR")} simulações, seed fixa)
        </p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono text-[11px] sm:grid-cols-4">
          <span className="text-muted-foreground">DD provável (P50)</span>
          <span>{fmt(m.monteCarlo.maxDrawdownP50)}R</span>
          <span className="text-muted-foreground">DD severo (P95)</span>
          <span>{fmt(m.monteCarlo.maxDrawdownP95)}R</span>
          <span className="text-muted-foreground">Sequência de loss (P95)</span>
          <span>{m.monteCarlo.worstLossStreakP95}</span>
          <span className="text-muted-foreground">Risco de ruína (-20R)</span>
          <span>{fmt(m.monteCarlo.ruinProbability * 100, 1)}%</span>
        </div>
      </Card>

      <Card className="flex flex-col gap-1 border-border/70 bg-panel p-3">
        <p className="nexus-eyebrow">COBERTURA (nada é descartado em silêncio)</p>
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[10px] text-muted-foreground">
          {Object.entries(m.discards).map(([motivo, contagem]) => (
            <span key={motivo}>
              {motivo}: {contagem}
            </span>
          ))}
        </div>
      </Card>
    </>
  );
}
