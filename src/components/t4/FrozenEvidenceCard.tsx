/**
 * OS PRINTS CONGELADOS — o que o operador abre quando o alerta toca.
 *
 * A tela ao vivo é para quem está olhando. Este card é para quem NÃO está: ele
 * guarda as duas fotografias que o sistema tirou sozinho — a aproximação
 * ("olhe agora") e a entrada confirmada ("a técnica fechou") — com os números
 * que valiam NAQUELE instante.
 *
 * POR QUE OS NÚMEROS AQUI NÃO SÃO OS DA TELA. O painel ao vivo republica a
 * decisão a cada frame; estes vêm do registro congelado. Se a decisão mudou
 * depois do sinal, é este cartão que diz o que a técnica afirmou quando
 * chamou — e é por ele que a ordem deve ser conferida, não pelo painel.
 */

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { PrintCongelado } from "@/lib/t4/entryFreeze";

function horaDoGrafico(at: number): string {
  return new Date(at).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function nivel(valor: number | null): string {
  return valor === null ? "—" : valor.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
}

export function FrozenEvidenceCard({ evidencias }: { evidencias: PrintCongelado[] }) {
  const [aberta, setAberta] = useState<string | null>(null);

  if (evidencias.length === 0) {
    return (
      <Card className="space-y-1 p-4">
        <div className="font-mono text-xs tracking-wide text-muted-foreground">
          PRINTS CONGELADOS
        </div>
        <p className="text-sm text-muted-foreground">
          Nenhum ainda. O sistema monitora em silêncio e congela um print quando a operação se
          aproxima e outro quando a entrada confirma — não é preciso ficar olhando.
        </p>
      </Card>
    );
  }

  // Mais recente primeiro: é o que interessa quando o alerta acabou de tocar.
  const lista = [...evidencias].sort((a, b) => b.chartTimestamp - a.chartTimestamp);

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs tracking-wide text-muted-foreground">
          PRINTS CONGELADOS
        </span>
        <Badge variant="outline" className="font-mono text-[10px]">
          {lista.length}
        </Badge>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          registro imutável — não acompanha a decisão nova
        </span>
      </div>

      <div className="space-y-2">
        {lista.map((p) => {
          const id = `${p.setupId}:${p.momento}`;
          const confirmada = p.momento === "ENTRADA_CONFIRMADA";
          return (
            <div
              key={id}
              className={`rounded-md border p-3 ${
                confirmada ? "border-emerald-600/60 bg-emerald-950/20" : "border-amber-600/50"
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant={confirmada ? "default" : "outline"}
                  className="font-mono text-[10px]"
                >
                  {confirmada ? "🟢 ENTRADA CONFIRMADA" : "🟡 OPERAÇÃO PRÓXIMA"}
                </Badge>
                <span className="font-mono text-xs">{p.direcao}</span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {horaDoGrafico(p.chartTimestamp)}
                </span>
                {p.familia !== null && (
                  <span className="font-mono text-[10px] text-muted-foreground">{p.familia}</span>
                )}
                {!p.precoConfiavel && (
                  <Badge variant="destructive" className="font-mono text-[10px]">
                    PREÇO NÃO CALIBRADO
                  </Badge>
                )}
              </div>

              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] sm:grid-cols-5">
                <div>
                  <div className="text-muted-foreground">ENTRADA</div>
                  <div>{nivel(p.niveis.entrada)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">STOP</div>
                  <div>{nivel(p.niveis.stop)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">ALVO 1</div>
                  <div>{nivel(p.niveis.alvo1)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">ALVO 2</div>
                  <div>{nivel(p.niveis.alvo2)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">R:R</div>
                  <div>{p.niveis.rr === null ? "—" : p.niveis.rr.toFixed(2)}</div>
                </div>
              </div>

              <p className="mt-2 text-[11px] text-muted-foreground">{p.motivo}</p>
              {p.confluencias.length > 0 && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Confluências: {p.confluencias.join(" · ")}
                </p>
              )}

              {p.imagem !== null ? (
                <div className="mt-2">
                  <button
                    type="button"
                    className="font-mono text-[10px] underline underline-offset-2"
                    onClick={() => setAberta(aberta === id ? null : id)}
                  >
                    {aberta === id ? "ocultar print" : "ver print congelado"}
                  </button>
                  {aberta === id && (
                    <img
                      src={p.imagem}
                      alt={`Gráfico no instante ${p.momento}`}
                      className="mt-2 w-full rounded border"
                    />
                  )}
                </div>
              ) : (
                <p className="mt-2 font-mono text-[10px] text-amber-500">
                  imagem indisponível nesta captura — números congelados mesmo assim
                </p>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
