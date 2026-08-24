import { Card } from "@/components/ui/card";

/**
 * AS QUATRO LINHAS DA VALIDAÇÃO — sempre visíveis, nunca só "aguardando".
 *
 * LUNA (leitura do print), TERRA (desafio adversarial), T4 DETERMINÍSTICA
 * (a única que manda) e o VEREDITO com motivo. "NÃO CHAMADO" é informação:
 * diz que a etapa não rodou, que é diferente de ter rodado e falhado.
 *
 * Componente PURO de propósito: recebe as strings prontas de
 * `aiStatusRows()` — a mesma função no live, no replay e no teste. A UI não
 * reinterpreta veredito; ela o EXIBE.
 */
export interface AiValidationPanelProps {
  rows: { luna: string; terra: string; t4: string; veredito: string } | null;
}

const PADRAO = {
  luna: "OPENAI LUNA: NÃO CHAMADO",
  terra: "OPENAI TERRA: NÃO CHAMADO",
  t4: "T4 DETERMINÍSTICA: —",
  veredito: "VEREDITO: AGUARDAR — validação ainda não executada",
};

function tom(linha: string): string {
  if (linha.includes(": OK") || linha.includes("PASS") || linha.includes("CONFIRMADO"))
    return "text-bull";
  if (linha.includes("REJECT") || linha.includes("BLOCKED")) return "text-bear";
  return "text-muted-foreground";
}

export function AiValidationPanel({ rows }: AiValidationPanelProps) {
  const r = rows ?? PADRAO;
  return (
    <Card className="space-y-1 p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Validação independente (OpenAI)
      </p>
      {[r.luna, r.terra, r.t4, r.veredito].map((linha) => (
        <p key={linha} className={`font-mono text-xs ${tom(linha)}`}>
          {linha}
        </p>
      ))}
    </Card>
  );
}
