import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ExitSchemeResult } from "@/lib/t4/dnaStats";
import { cn } from "@/lib/utils";

import { formatFactor, formatInt, formatPct, formatR } from "./format";

/**
 * OTIMIZAÇÃO DE SAÍDA (§10) — alvos fixos vs gerenciamento real, sobre o
 * MFE/MAE das MESMAS operações.
 *
 * Duas honestidades obrigatórias nesta tabela:
 * 1. A coluna AMBÍGUOS existe porque alvo E stop alcançados sem ordem gravada
 *    são contados como stop (conservador) — esconder a contagem transformaria
 *    suposição em estatística.
 * 2. O rodapé diz o que NÃO está aqui: trailing estrutural e break-even exigem
 *    trajetória candle a candle, que os trades ainda não gravam. Fingir número
 *    para esses esquemas seria pior que a lacuna.
 */
export function ExitSection({ exitSchemes }: { exitSchemes: ExitSchemeResult[] }) {
  return (
    <Card className="gap-2 border-border/70 bg-panel p-3">
      {exitSchemes.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Sem operações com MFE/MAE registrados — a comparação de saídas precisa deles.
        </p>
      ) : (
        <Table className="text-xs">
          <TableHeader>
            <TableRow className="border-border/50">
              <TableHead className="text-[10px]">ESQUEMA</TableHead>
              <TableHead className="text-right text-[10px]">AMOSTRA</TableHead>
              <TableHead className="text-right text-[10px]">WIN RATE</TableHead>
              <TableHead className="text-right text-[10px]">EXPECT.</TableHead>
              <TableHead className="text-right text-[10px]">PF</TableHead>
              <TableHead className="text-right text-[10px]">AMBÍGUOS</TableHead>
              <TableHead className="text-[10px]">NOTA</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {exitSchemes.map((scheme) => {
              // targetR null = GERENCIAMENTO ATUAL: a linha de base destacada.
              const isBaseline = scheme.targetR === null;
              return (
                <TableRow
                  key={scheme.scheme}
                  className={cn(
                    "border-border/40 font-mono",
                    isBaseline && "border-primary/40 bg-primary/10",
                  )}
                >
                  <TableCell className={cn("font-semibold", isBaseline && "text-primary")}>
                    {scheme.scheme}
                  </TableCell>
                  <TableCell className="text-right">{formatInt(scheme.sample)}</TableCell>
                  <TableCell className="text-right">{formatPct(scheme.winRate)}</TableCell>
                  <TableCell className="text-right font-bold">
                    {formatR(scheme.expectancyR)}
                  </TableCell>
                  <TableCell className="text-right">{formatFactor(scheme.profitFactor)}</TableCell>
                  <TableCell className={cn("text-right", scheme.ambiguous > 0 && "text-warn")}>
                    {formatInt(scheme.ambiguous)}
                  </TableCell>
                  {/* Note do servidor na íntegra — é ela que explica os ambíguos. */}
                  <TableCell className="min-w-56 text-[9px] leading-snug text-muted-foreground">
                    {scheme.note}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      <p className="text-[10px] text-muted-foreground">
        Trailing estrutural e break-even exigem trajetória candle a candle — ainda não gravada.
      </p>
    </Card>
  );
}
