import { Card } from "@/components/ui/card";
import {
  NEXT_STATUS_LABEL,
  TRIGGER_EMOJI,
  formatRead,
  type NextScreenshot,
} from "@/lib/vision/printAnalysis";
import { cn } from "@/lib/utils";

/**
 * 📸 QUANDO ENVIAR O PRÓXIMO PRINT.
 *
 * O card transforma o diagnóstico em instrução operacional: não "COMPRA/VENDA",
 * mas "volte quando ISSO acontecer". Só aparecem gatilhos que a análise
 * realmente detectou — lista vazia é lista vazia, nunca texto genérico de
 * enchimento, porque um gatilho inventado mandaria o operador vigiar uma região
 * que a análise não viu.
 */

const TOM: Record<NextScreenshot["status"], string> = {
  NAO_PRECISA: "border-border text-muted-foreground",
  AGUARDAR_FECHAMENTO: "border-amber-500 text-amber-500",
  ENVIAR_NO_GATILHO: "border-amber-500 text-amber-500",
  ENVIAR_AGORA: "border-bear text-bear",
};

export function NextPrintCard({ next }: { next: NextScreenshot | null }) {
  if (next === null) {
    /*
     * O modelo não avaliou o próximo passo. Dizer "não precisa" seria inventar
     * uma orientação; o honesto é declarar a ausência.
     */
    return (
      <Card className="border-border/70 bg-panel p-3">
        <p className="nexus-eyebrow">📸 PRÓXIMO PRINT</p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          A análise não avaliou quando enviar a próxima captura.
        </p>
      </Card>
    );
  }

  // Prioridade decide a ordem; HIGH primeiro. O card lista todos os detectados.
  const ordem = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
  const gatilhos = [...next.triggers].sort((a, b) => ordem[a.priority] - ordem[b.priority]);

  return (
    <Card className="flex flex-col gap-2 border-border/70 bg-panel p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="nexus-eyebrow">📸 QUANDO ENVIAR O PRÓXIMO PRINT</p>
        <span
          className={cn(
            "ml-auto rounded border px-2 py-0.5 font-mono text-[10px]",
            TOM[next.status],
          )}
        >
          {NEXT_STATUS_LABEL[next.status]}
        </span>
      </div>

      {next.instruction && (
        <p className="text-[11px] leading-snug text-muted-foreground">{next.instruction}</p>
      )}

      {gatilhos.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-[10px] font-medium tracking-widest text-muted-foreground">
            ENVIAR NOVO PRINT SE:
          </p>
          {gatilhos.map((t, i) => (
            <p key={`${t.type}-${i}`} className="font-mono text-[11px]">
              {TRIGGER_EMOJI[t.type]} {t.label}
              {t.level && t.level.visible && (
                <span className="text-muted-foreground"> · nível {formatRead(t.level)}</span>
              )}
            </p>
          ))}
        </div>
      )}

      {next.preferredTiming === "AFTER_CANDLE_CLOSE" && (
        <p className="text-[10px] text-muted-foreground">
          Preferência: capture após o <strong>fechamento do candle</strong> — um candle aberto ainda
          pode mudar tudo.
        </p>
      )}
    </Card>
  );
}
