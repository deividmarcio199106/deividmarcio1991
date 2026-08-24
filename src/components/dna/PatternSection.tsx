import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { MIN_SEGMENT_SAMPLE, type PatternFinding } from "@/lib/t4/dnaStats";
import { cn } from "@/lib/utils";

import { formatFactor, formatInt, formatPct, formatR } from "./format";

/**
 * PADRÕES ENCONTRADOS (§9) — combinações que ALCANÇARAM amostra suficiente.
 *
 * O aviso fixo no topo não é decoração: a descoberta combinatória é a parte
 * do sistema mais propensa a virar "regra automática" na cabeça de quem lê.
 * Cada card termina na suggestion do servidor — sugestão para o Laboratório,
 * validação fora da amostra, nunca bloqueio automático (§13).
 */
export function PatternSection({ patterns }: { patterns: PatternFinding[] }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-warn">
        Sugestão para o Laboratório — nada é bloqueado automaticamente
      </p>

      {patterns.length === 0 ? (
        <Card className="border-border/70 bg-panel p-4">
          <p className="text-xs text-muted-foreground">
            Nenhuma combinação alcançou o corte de {formatInt(MIN_SEGMENT_SAMPLE)} operações com
            resultado — sem amostra não há padrão a exibir.
          </p>
        </Card>
      ) : (
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {patterns.map((finding) => {
            const positive = (finding.metrics.expectancyR ?? 0) > 0;
            return (
              <Card
                key={finding.pattern}
                className="flex flex-col gap-2 border-border/70 bg-panel p-3"
              >
                <p className="break-words font-mono text-xs font-semibold">{finding.pattern}</p>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="outline" className="font-mono text-[9px]">
                    N={formatInt(finding.metrics.sample)}
                  </Badge>
                  <Badge variant="outline" className="font-mono text-[9px]">
                    WIN {formatPct(finding.metrics.winRate)}
                  </Badge>
                  {/* Padrões só entram aqui COM amostra — a cor é legítima. */}
                  <Badge
                    variant="outline"
                    className={cn(
                      "font-mono text-[9px]",
                      positive ? "border-bull text-bull" : "border-bear text-bear",
                    )}
                  >
                    EXP {formatR(finding.metrics.expectancyR)}
                  </Badge>
                  <Badge variant="outline" className="font-mono text-[9px]">
                    PF {formatFactor(finding.metrics.profitFactor)}
                  </Badge>
                </div>
                {/* Suggestion do servidor, na íntegra — é ela que aponta o Laboratório. */}
                <p className="text-[10px] leading-snug text-muted-foreground">
                  {finding.suggestion}
                </p>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
