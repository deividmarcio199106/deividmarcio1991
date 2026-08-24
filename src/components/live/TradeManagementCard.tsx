import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { DecisionObject } from "@/lib/engines/backtestDecisionEngine";
import { PRICE_GUARD_LABEL } from "@/lib/t4/priceGuard";
import { cn } from "@/lib/utils";

/**
 * TradeManagementCard (comando master §52–§54, §64, §98).
 *
 * A CONFIRMAÇÃO vem do BacktestDecisionEngine (evidência histórica validada),
 * nunca de uma nota agregada. Valores ausentes mostram AGUARDANDO DADOS — jamais
 * um número inventado (§53). O painel de evidências é secundário (§64).
 */

function price(value: number | null, priceScaleReady = true): string {
  // Sem escala validada os níveis não são preço: são coordenadas de pixel. Dizer
  // AGUARDANDO DADOS aqui esconderia que o dado existe e o que falta é a régua.
  if (!priceScaleReady) return PRICE_GUARD_LABEL;
  return value !== null && Number.isFinite(value) ? value.toFixed(2) : "AGUARDANDO DADOS";
}

const DECISION_LABEL: Record<DecisionObject["decision"], string> = {
  ENTER_LONG: "ENTRADA CONFIRMADA — COMPRA",
  ENTER_SHORT: "ENTRADA CONFIRMADA — VENDA",
  WAIT: "AGUARDAR",
  REJECT: "ENTRADA REJEITADA",
};

export function TradeManagementCard({
  decision,
  entryState,
  operationStatus,
  operationDetail,
  candles = 0,
  priceScaleReady = true,
  t4Confirmed,
}: {
  decision: DecisionObject | null;
  entryState?: string;
  operationStatus?: string | null;
  operationDetail?: string | null;
  /** Quantos candles a T4 já recebeu. Distingue falta de DADO de falta de SETUP. */
  candles?: number;
  priceScaleReady?: boolean;
  /** O estágio da T4 confirmou? Sem isto, vale só a decisão. */
  t4Confirmed?: boolean;
}) {
  if (!decision) {
    /*
     * FALTA DE DADO E FALTA DE SETUP SÃO COISAS DIFERENTES.
     *
     * Com centenas de candles na tela, "AGUARDANDO DADOS" manda o operador
     * procurar um problema de captura que não existe. O que falta é
     * oportunidade — e isso não é defeito, é o pregão.
     */
    return (
      <Card className="border-border/70 bg-panel p-3">
        <p className="text-[10px] font-medium tracking-widest text-muted-foreground">
          GERENCIAMENTO
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {candles > 0
            ? `AGUARDANDO SETUP — ${candles} candles lidos, nenhuma oportunidade configurada.`
            : "AGUARDANDO DADOS — nenhuma análise ainda."}
        </p>
      </Card>
    );
  }

  /*
   * A CONFIRMAÇÃO É A DA T4, NÃO A DO MOTOR DE DECISÃO SOZINHO.
   *
   * `decide()` pode devolver ENTER_SHORT com a evidência histórica satisfeita
   * enquanto os gates técnicos ainda seguram o gatilho. Este card lia só a
   * decisão e escrevia "ENTRADA CONFIRMADA — VENDA" enquanto o card da T4, na
   * mesma tela, mostrava PREPARANDO. Dois estados simultâneos para a mesma
   * operação — e o mais perigoso deles em destaque.
   *
   * Agora as duas coisas precisam concordar. Quando o chamador não informa o
   * estágio (aba Gerenciamento, que lê a última decisão persistida), vale a
   * decisão sozinha, e o card diz de onde ela veio.
   */
  const confirmedByDecision =
    decision.decision === "ENTER_LONG" || decision.decision === "ENTER_SHORT";
  const confirmed =
    t4Confirmed === undefined ? confirmedByDecision : confirmedByDecision && t4Confirmed;
  // Com ZERO casos não há o que validar nem o que reprovar: "AMOSTRA
  // INSUFICIENTE" ainda sugere que existe amostra. A ausência vem primeiro.
  const condition =
    decision.similarCases === 0
      ? "SEM BASE HISTÓRICA"
      : confirmed
        ? "VALIDADA"
        : decision.evidenceConfidence === "INSUFFICIENT"
          ? `AMOSTRA INSUFICIENTE (${decision.similarCases})`
          : "NÃO VALIDADA";
  const tone = confirmed
    ? decision.decision === "ENTER_LONG"
      ? "text-bull"
      : "text-bear"
    : decision.decision === "REJECT"
      ? "text-bear"
      : "text-muted-foreground";

  const stateGlow = confirmed
    ? "nexus-glow-bull"
    : decision.decision === "REJECT"
      ? "nexus-glow-bear"
      : "";

  return (
    <Card className={"nexus-card flex flex-col gap-2 p-3 transition-shadow " + stateGlow}>
      <div className="flex items-center justify-between">
        <p className="nexus-eyebrow">GERENCIAMENTO — {decision.instrument}</p>
        <div className="flex items-center gap-1">
          {operationStatus && (
            <Badge variant="outline" className="border-primary/60 text-primary">
              {operationStatus}
            </Badge>
          )}
          {entryState && (
            <Badge variant="outline" className="border-border text-muted-foreground">
              {entryState}
            </Badge>
          )}
        </div>
      </div>

      <p className={cn("font-display text-xl font-bold tracking-wide", tone)}>
        {confirmedByDecision && !confirmed
          ? "AGUARDAR — evidência satisfeita, gatilho técnico pendente"
          : DECISION_LABEL[decision.decision]}
      </p>
      {operationDetail && <p className="text-[10px] text-muted-foreground">{operationDetail}</p>}
      {confirmed && (
        <p className="text-[10px] text-muted-foreground">
          Confirmada PELOS CRITÉRIOS DO SISTEMA (evidência histórica validada) — resultado nunca é
          garantido.
        </p>
      )}

      <div className="nexus-value grid grid-cols-2 gap-x-4 gap-y-1.5 text-[15px]">
        <Row label="ENTRADA" value={price(decision.entryPrice, priceScaleReady)} strong />
        <Row label="STOP" value={price(decision.stopPrice, priceScaleReady)} strong />
        <Row label="1º CONTRATO · 3R" value={price(decision.partialPrice, priceScaleReady)} />
        <Row label="2º CONTRATO · 5R" value={price(decision.targetPrice, priceScaleReady)} />
        <Row label="3º CONTRATO" value="RUNNER ESTRUTURAL" />
        <Row
          label="RISCO"
          value={
            decision.riskPoints !== null
              ? `${decision.riskPoints.toFixed(0)} pts`
              : "AGUARDANDO DADOS"
          }
        />
        <Row
          label="RETORNO"
          value={
            decision.rewardPoints !== null
              ? `${decision.rewardPoints.toFixed(0)} pts`
              : "AGUARDANDO DADOS"
          }
        />
        <Row
          label="RR"
          value={
            decision.riskRewardRatio !== null ? `1:${decision.riskRewardRatio.toFixed(1)}` : "—"
          }
        />
        <Row
          label="CONTRATOS"
          value={
            decision.recommendedContracts !== null
              ? String(decision.recommendedContracts)
              : "AGUARDANDO DADOS"
          }
          strong
        />
      </div>
      {decision.strategyId && (
        <p className="font-mono text-[10px] text-muted-foreground">
          Técnica: {decision.strategyId} · {decision.strategyVersion} · regime{" "}
          {decision.marketRegime}
        </p>
      )}

      {/* §74: motivos explícitos da decisão/rejeição. */}
      <div className="flex flex-col gap-0.5 text-[11px]">
        {(confirmed ? decision.decisionReasons : decision.rejectionReasons)
          .slice(0, 6)
          .map((reason, i) => (
            <p key={i} className={confirmed ? "text-muted-foreground" : "text-warn"}>
              • {reason}
            </p>
          ))}
      </div>

      {/* Painel de evidências — SECUNDÁRIO: CONFIGURAÇÃO IDENTIFICADA vs base histórica. */}
      <p className="border-t border-border/40 pt-2 text-[9px] tracking-widest text-muted-foreground">
        CONFIGURAÇÃO IDENTIFICADA — CONDIÇÃO ATUAL: {condition}
      </p>
      {/*
        AMOSTRA ZERO NÃO É ESTATÍSTICA.
        Com 0 casos, a grade mostrava CASOS 0 e sete traços — e traço significava
        as duas coisas ao mesmo tempo: "não medido" e "reprovado". Um painel de
        oito células preenchidas parece medição; oito células vazias parecem
        medição ruim. Nenhuma das duas descreve "não existe base".
      */}
      {decision.similarCases === 0 ? (
        <p className="rounded border border-warn/50 bg-warn/10 p-2 text-center font-mono text-[10px] text-warn">
          SEM BASE HISTÓRICA — 0 casos semelhantes nesta configuração. Nenhuma estatística pode ser
          calculada, e nenhuma foi.
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-1 text-center font-mono text-[10px] text-muted-foreground sm:grid-cols-8">
          <Cell label="CASOS" value={String(decision.similarCases)} />
          <Cell
            label="WIN RATE"
            value={decision.winRate !== null ? `${decision.winRate.toFixed(0)}%` : "—"}
          />
          <Cell
            label="PF"
            value={decision.profitFactor !== null ? decision.profitFactor.toFixed(2) : "—"}
          />
          <Cell
            label="EXPECT."
            value={decision.expectancyR !== null ? `${decision.expectancyR.toFixed(2)}R` : "—"}
          />
          <Cell label="OOS" value={decision.outOfSampleValidated ? "OK" : "—"} />
          <Cell label="WALK-FWD" value={decision.walkForwardStable ? "OK" : "—"} />
          <Cell
            label="MFE MÉD."
            value={decision.averageMfeR !== null ? `${decision.averageMfeR.toFixed(2)}R` : "—"}
          />
          <Cell
            label="MAE MÉD."
            value={decision.averageMaeR !== null ? `${decision.averageMaeR.toFixed(2)}R` : "—"}
          />
        </div>
      )}
      {decision.similarCases > 0 && (
        <p className="font-mono text-[9px] text-muted-foreground">
          Drawdown histórico:{" "}
          {decision.maxDrawdown !== null ? `${decision.maxDrawdown.toFixed(2)}R` : "—"} · Deriva:{" "}
          {decision.marketDrift} · Saúde da técnica: {decision.strategyHealth}
        </p>
      )}
    </Card>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span className={cn(strong && "font-bold")}>{value}</span>
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[8px] tracking-widest">{label}</p>
      <p className="font-bold text-foreground">{value}</p>
    </div>
  );
}
