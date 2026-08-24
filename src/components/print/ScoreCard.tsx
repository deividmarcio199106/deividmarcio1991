import { Card } from "@/components/ui/card";
import type { ScoreComponent, T4Score } from "@/lib/t4/score";
import { cn } from "@/lib/utils";

/**
 * 📊 SCORE T4 — a nota COM a conta à mostra.
 *
 * O card existe para responder duas perguntas de uma vez: "quanto esta
 * configuração vale?" e "de ONDE veio cada ponto?". Um número sozinho
 * responderia a primeira e faria o operador confiar na segunda sem poder
 * conferi-la — por isso cada componente aparece com a própria barra, a
 * contribuição em pontos e o motivo escrito embaixo.
 *
 * A REGRA QUE O CARD NÃO PODE QUEBRAR: score NÃO é permissão.
 * Enquanto `entradaConfirmada` for falso, o aviso de que a nota não autoriza
 * operação fica no topo, em ÂMBAR — e o total nunca aparece em verde, por mais
 * alto que esteja. Verde na tela significa "liberado", e essa palavra só a
 * trava determinística pode dizer.
 *
 * Só apresentação: zero lógica de regra. Tudo o que se lê aqui foi decidido em
 * `@/lib/t4/score`; recalcular qualquer coisa neste arquivo criaria uma segunda
 * versão da nota que divergiria da primeira no dia seguinte.
 */

/**
 * Tom da barra de um componente.
 *
 * Cheio vira bull porque ali a parcela realmente fechou; penalizado vira bear
 * porque houve evidência CONTRA; zero sem penalização fica em cinza — é a
 * ausência ("não avaliável"), e pintá-la de vermelho diria que a análise
 * reprovou algo que ela nem conseguiu olhar.
 */
function tomDaBarra(componente: ScoreComponent): string {
  if (componente.penalty) return "bg-bear";
  if (componente.earned <= 0) return "bg-muted-foreground/30";
  if (componente.earned >= componente.weight) return "bg-bull";
  return "bg-amber-500";
}

function Componente({ componente }: { componente: ScoreComponent }) {
  const percentual = componente.weight > 0 ? (componente.earned / componente.weight) * 100 : 0;
  const naoAvaliavel = componente.detail.startsWith("NÃO AVALIÁVEL");

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="nexus-eyebrow shrink-0">{componente.label}</span>
        <span
          className={cn(
            "font-mono text-[11px]",
            componente.penalty
              ? "text-bear"
              : naoAvaliavel
                ? "text-muted-foreground"
                : componente.earned >= componente.weight
                  ? "text-bull"
                  : "text-amber-500",
          )}
        >
          {componente.earned} / {componente.weight}
        </span>
      </div>

      <div className="h-1.5 overflow-hidden rounded-full bg-border/50">
        {/* Largura vai por style: a fração é um dado, não uma classe conhecida
            em tempo de build. */}
        <div
          className={cn("h-full rounded-full transition-all", tomDaBarra(componente))}
          style={{ width: `${percentual}%` }}
        />
      </div>

      <p className="text-[10px] leading-snug text-muted-foreground">{componente.detail}</p>
    </div>
  );
}

export function ScoreCard({ score }: { score: T4Score }) {
  /*
   * Verde SÓ com a entrada liberada. Score alto sem liberação é justamente o
   * caso perigoso — vai de âmbar, para ser lido como atenção e não como sinal.
   */
  const tomTotal = score.entradaConfirmada
    ? "text-bull"
    : score.total >= 60
      ? "text-amber-500"
      : "text-muted-foreground";

  return (
    <Card className="flex flex-col gap-3 border-border/70 bg-panel p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="nexus-eyebrow">📊 SCORE T4</p>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          SOMA DAS PARCELAS EXPLICADAS
        </span>
      </div>

      <div className="flex items-baseline gap-2">
        <span className={cn("font-display text-3xl font-bold", tomTotal)}>{score.total}</span>
        <span className="font-mono text-[11px] text-muted-foreground">/ 100</span>
      </div>

      {/* O aviso vem ANTES das barras: quem lê só o topo do card já sai
          sabendo que a nota não é ordem. */}
      {!score.entradaConfirmada && (
        <p className="rounded border border-amber-500/60 bg-amber-500/10 px-2 py-1 font-mono text-[11px] font-semibold leading-snug text-amber-500">
          ESTE SCORE NÃO AUTORIZA OPERAÇÃO — a nota mede a QUALIDADE da configuração; a liberação
          vem da trava de entrada, que segue bloqueada.
        </p>
      )}

      <div className="flex flex-col gap-2">
        {score.components.map((componente) => (
          <Componente key={componente.id} componente={componente} />
        ))}
      </div>

      {score.penalties.length > 0 && (
        <div className="flex flex-col gap-0.5 rounded border border-border/60 bg-background/50 p-2">
          <p className="nexus-eyebrow">PENALIZAÇÕES</p>
          {score.penalties.map((motivo, i) => (
            <p key={i} className="font-mono text-[10px] leading-snug text-bear">
              • {motivo}
            </p>
          ))}
        </div>
      )}

      <p className="text-[10px] leading-snug text-muted-foreground">{score.note}</p>
    </Card>
  );
}
