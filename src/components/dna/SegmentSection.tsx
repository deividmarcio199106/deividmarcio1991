import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DNA_DIMENSIONS, type SegmentMetrics } from "@/lib/t4/dnaStats";
import { cn } from "@/lib/utils";

import { formatFactor, formatInt, formatPct, formatR } from "./format";

/**
 * PERFORMANCE SEGMENTADA (§3) — uma tabela por dimensão do DNA.
 *
 * A REGRA INVIOLÁVEL DA SEÇÃO: segmento com `sufficient: false` nunca recebe
 * cor de conclusão. Verde/vermelho na expectância é afirmação ("aqui há/não há
 * vantagem") e afirmação exige amostra; abaixo do corte a linha fica neutra,
 * com o badge cinza e a note do servidor visível — o operador precisa VER que
 * são 4 casos, não 400.
 */
export function SegmentSection({ segments }: { segments: Record<string, SegmentMetrics[]> }) {
  // A ordem das dimensões é a do §3 (DNA_DIMENSIONS), não a ordem de chegada
  // do JSON — o painel conta sempre a mesma história na mesma sequência.
  const ordered = DNA_DIMENSIONS.filter((d) => (segments[d.key]?.length ?? 0) > 0);

  if (ordered.length === 0) {
    return (
      <Card className="border-border/70 bg-panel p-4">
        <p className="text-xs text-muted-foreground">
          Nenhum segmento calculado ainda — as tabelas aparecem quando houver detecções com
          resultado.
        </p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {ordered.map((dimension) => (
        <Card key={dimension.key} className="gap-2 border-border/70 bg-panel p-3">
          <p className="nexus-eyebrow">{dimension.label.toUpperCase()}</p>
          <Table className="text-xs">
            <TableHeader>
              <TableRow className="border-border/50">
                <TableHead className="text-[10px]">VALOR</TableHead>
                <TableHead className="text-right text-[10px]">DETECT.</TableHead>
                <TableHead className="text-right text-[10px]">AMOSTRA</TableHead>
                <TableHead className="text-right text-[10px]">W/L/N</TableHead>
                <TableHead className="text-right text-[10px]">WIN RATE</TableHead>
                <TableHead className="text-right text-[10px]">EXPECT.</TableHead>
                <TableHead className="text-right text-[10px]">PAYOFF</TableHead>
                <TableHead className="text-right text-[10px]">PF</TableHead>
                <TableHead className="text-right text-[10px]">DD MÁX</TableHead>
                <TableHead className="text-right text-[10px]">MFE MED</TableHead>
                <TableHead className="text-right text-[10px]">MAE MED</TableHead>
                <TableHead className="text-right text-[10px]">NET</TableHead>
                <TableHead
                  className="text-right text-[10px]"
                  title="Líquido após custos (nº de operações com custo conhecido)"
                >
                  NET−CUSTOS
                </TableHead>
                <TableHead className="text-[10px]">AMOSTRA / NOTA</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {segments[dimension.key]!.map((segment) => (
                <SegmentRow key={`${segment.dimension}-${segment.value}`} segment={segment} />
              ))}
            </TableBody>
          </Table>
        </Card>
      ))}
    </div>
  );
}

function SegmentRow({ segment }: { segment: SegmentMetrics }) {
  // Cor de conclusão SÓ com amostra suficiente — regra do módulo inteiro.
  const expectancyTone = !segment.sufficient
    ? undefined
    : (segment.expectancyR ?? 0) > 0
      ? "text-bull"
      : (segment.expectancyR ?? 0) < 0
        ? "text-bear"
        : undefined;

  return (
    <TableRow
      className={cn("border-border/40 font-mono", !segment.sufficient && "text-muted-foreground")}
    >
      <TableCell className="font-semibold">{segment.value}</TableCell>
      <TableCell className="text-right">{formatInt(segment.detected)}</TableCell>
      <TableCell className="text-right">{formatInt(segment.sample)}</TableCell>
      <TableCell className="text-right">
        {formatInt(segment.wins)}/{formatInt(segment.losses)}/{formatInt(segment.neutrals)}
      </TableCell>
      <TableCell className="text-right">{formatPct(segment.winRate)}</TableCell>
      <TableCell className={cn("text-right font-bold", expectancyTone)}>
        {formatR(segment.expectancyR)}
      </TableCell>
      <TableCell className="text-right">{formatFactor(segment.payoff)}</TableCell>
      <TableCell className="text-right">{formatFactor(segment.profitFactor)}</TableCell>
      <TableCell className="text-right">
        {segment.maxDrawdownR === null ? "—" : formatR(-Math.abs(segment.maxDrawdownR))}
      </TableCell>
      <TableCell className="text-right">{formatR(segment.mfeMedianR)}</TableCell>
      <TableCell className="text-right">{formatR(segment.maeMedianR)}</TableCell>
      <TableCell className="text-right">{formatR(segment.netR)}</TableCell>
      <TableCell className="text-right">
        {formatR(segment.netAfterCostsR)}
        <span className="ml-1 text-[9px] text-muted-foreground">
          ({formatInt(segment.costsCovered)} c/ custo)
        </span>
      </TableCell>
      <TableCell className="min-w-48">
        {!segment.sufficient && (
          <Badge
            variant="outline"
            className="mb-0.5 border-muted-foreground/50 font-mono text-[9px] text-muted-foreground"
          >
            AMOSTRA INSUFICIENTE
          </Badge>
        )}
        {/* A note vem pronta do servidor e é exibida integralmente. */}
        <p className="text-[9px] leading-snug text-muted-foreground">{segment.note}</p>
      </TableCell>
    </TableRow>
  );
}
