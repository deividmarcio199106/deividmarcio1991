import { Card } from "@/components/ui/card";
import { formatRead, NAO_LEGIVEL, type ConditionalPlan } from "@/lib/vision/printAnalysis";
import { cn } from "@/lib/utils";

/**
 * 🎯 PLANO CONDICIONAL — "SE ISTO, ENTÃO AQUILO".
 *
 * É o card mais importante da tela porque cobre o caso mais comum: não existe
 * entrada confirmada AGORA. Sem ele o operador via "NÃO LEGÍVEL NO PRINT" nos
 * níveis e nenhuma instrução — diagnóstico sem próximo passo.
 *
 * O QUE ESTE CARD NÃO PODE VIRAR: uma ordem. Todo plano aqui é anterior ao
 * gatilho; o preço ainda não fez nada. Por isso o aviso do rodapé é fixo e
 * incondicional — ele não some quando a lista está cheia, que é justamente
 * quando a leitura apressada confundiria plano com sinal.
 *
 * A lista já chega filtrada por `validatePrintAnalysis`: plano sem nível de
 * gatilho legível, sem stop legível ou com stop do lado errado é descartado lá.
 * Aqui não se re-julga nem se completa nada — só se exibe, e a ausência de
 * planos é dita em voz alta em vez de a seção sumir da tela.
 */

/**
 * Cópia local do `Linha` da rota: o original vive em `routes/analisar-print.tsx`
 * e não é exportado. Duplicar 8 linhas custa menos que transformar um arquivo de
 * rota em módulo de UI compartilhada.
 */
function Linha({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="nexus-eyebrow shrink-0">{label}</span>
      <span className="truncate font-mono text-xs" title={value}>
        {value}
      </span>
    </div>
  );
}

function Plano({ plano }: { plano: ConditionalPlan }) {
  const compra = plano.side === "COMPRA";
  /*
   * Alvo é opcional e some quando o validador o considera incoerente com o lado.
   * Lista vazia diz NÃO LEGÍVEL — nunca fica um campo em branco que o operador
   * leria como "sem alvo definido por escolha da análise".
   */
  const alvos =
    plano.targets.length > 0 ? plano.targets.map((t) => formatRead(t)).join(" · ") : NAO_LEGIVEL;

  return (
    <div
      className={cn(
        "flex flex-col gap-1 border-l-2 py-1 pl-2",
        compra ? "border-bull" : "border-bear",
      )}
    >
      {/*
       * A frase de gatilho é o que se lê de relance — nível junto, porque "se
       * romper o topo" sem o número não é observável no gráfico.
       */}
      <p className={cn("text-sm font-semibold leading-snug", compra ? "text-bull" : "text-bear")}>
        SE {plano.trigger} ({formatRead(plano.triggerLevel)}) → {plano.side}
      </p>

      <div className="flex flex-col gap-1">
        <Linha label="ENTRADA" value={formatRead(plano.entry)} />
        {plano.entryZone && (
          <Linha
            label="ZONA"
            value={`${formatRead(plano.entryZone.min)} – ${formatRead(plano.entryZone.max)}`}
          />
        )}
        <Linha label="STOP" value={formatRead(plano.stop)} />
        <Linha label="ALVOS" value={alvos} />
        <Linha label="INVALIDAÇÃO" value={plano.invalidation || "NÃO INFORMADA PELA ANÁLISE"} />
      </div>

      {plano.rationale && (
        <p className="text-[10px] leading-snug text-muted-foreground">{plano.rationale}</p>
      )}
    </div>
  );
}

export function ConditionalPlanCard({ plans }: { plans: ConditionalPlan[] }) {
  return (
    <Card className="flex flex-col gap-3 border-border/70 bg-panel p-3">
      <p className="nexus-eyebrow">PLANO — SE ISTO, ENTÃO AQUILO</p>

      {plans.length === 0 ? (
        /*
         * ESTADO VAZIO HONESTO. Esconder a seção faria o operador supor que a
         * análise não chegou a pensar em plano; o texto diz o motivo real —
         * a escala do print não sustenta os níveis que um plano exige.
         */
        <p className="text-[11px] leading-snug text-muted-foreground">
          Nenhum plano condicional: a escala do print não sustenta níveis legíveis para gatilho e
          stop.
        </p>
      ) : (
        plans.map((plano, i) => <Plano key={`${plano.side}-${plano.trigger}-${i}`} plano={plano} />)
      )}

      {/* Fixo por contrato de produto: vale com lista cheia e com lista vazia. */}
      <p className="text-[10px] leading-snug text-amber-500">
        Plano condicional — o gatilho ainda NÃO aconteceu. Não é sinal de entrada nem ordem: é o que
        observar.
      </p>
    </Card>
  );
}
