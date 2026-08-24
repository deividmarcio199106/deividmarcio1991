import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { LossFactor } from "@/lib/t4/dnaStats";

import { formatFactor, formatInt } from "./format";

/**
 * POR QUE PERDEU? (§5) — fatores sobre-representados nas perdedoras.
 *
 * A frase exibida é a `note` do servidor, NA ÍNTEGRA. Ela foi escrita como
 * ASSOCIAÇÃO estatística ("aparece em X% das perdedoras vs Y% das vencedoras…
 * não é afirmação de causa") e reescrevê-la aqui — encurtar, "melhorar",
 * transformar em "perdeu porque…" — seria exatamente a promoção de associação
 * a causa que o §5 proíbe.
 */
export function LossSection({ lossFactors }: { lossFactors: LossFactor[] }) {
  if (lossFactors.length === 0) {
    return (
      <Card className="border-border/70 bg-panel p-4">
        <p className="text-xs text-muted-foreground">
          Sem fatores para comparar — esta leitura exige perdedoras E vencedoras registradas, e um
          fator só entra quando sobre-representa perdas com folga (lift &gt; 1,25).
        </p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {lossFactors.map((factor) => (
        <Card
          key={`${factor.dimension}-${factor.value}`}
          className="flex flex-col gap-1.5 border-border/70 bg-panel p-3"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="font-mono text-[9px]">
              {factor.dimension}={factor.value}
            </Badge>
            <Badge variant="outline" className="border-warn font-mono text-[9px] text-warn">
              LIFT {formatFactor(factor.lift)}
            </Badge>
            <span className="font-mono text-[9px] text-muted-foreground">
              {formatInt(factor.losses)} perdas · {formatInt(factor.wins)} ganhos com este fator
            </span>
          </div>
          {/* Note do servidor, integral — associação dita como associação. */}
          <p className="text-xs leading-snug">{factor.note}</p>
        </Card>
      ))}
    </div>
  );
}
