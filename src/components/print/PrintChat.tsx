import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { SendHorizonal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { askPrintQuestion } from "@/lib/printAnalysis.functions";
import type { PrintAnalysis } from "@/lib/vision/printAnalysis";

/**
 * PERGUNTAR SOBRE O PRINT — chat da análise atual.
 *
 * Cada pergunta viaja com a imagem E a análise estruturada: o modelo responde
 * sobre O QUE FOI MARCADO, não de memória. E a resposta é só texto — nada do
 * que sai daqui vira traço no overlay nem número em card, então a prosa não
 * tem como contaminar os níveis.
 */

interface Turno {
  pergunta: string;
  resposta: string | null;
  erro: string | null;
}

const SUGESTOES = [
  "Por que você marcou essa entrada?",
  "Onde essa T4 invalida?",
  "Vale esperar pullback?",
  "Por que não é compra ainda?",
];

export function PrintChat({ image, analysis }: { image: string; analysis: PrintAnalysis }) {
  const perguntar = useServerFn(askPrintQuestion);
  const [turnos, setTurnos] = useState<Turno[]>([]);
  const [texto, setTexto] = useState("");
  const [ocupado, setOcupado] = useState(false);

  const enviar = async (pergunta: string) => {
    const limpa = pergunta.trim();
    if (limpa.length < 2 || ocupado) return;
    setTexto("");
    setOcupado(true);
    setTurnos((t) => [...t, { pergunta: limpa, resposta: null, erro: null }]);
    try {
      const r = await perguntar({
        data: {
          imageDataUrl: image,
          analysisJson: JSON.stringify(analysis),
          question: limpa,
        },
      });
      setTurnos((t) =>
        t.map((turno, i) =>
          i === t.length - 1 ? { ...turno, resposta: r.answer, erro: r.error } : turno,
        ),
      );
    } catch (problema) {
      const mensagem = problema instanceof Error ? problema.message : String(problema);
      setTurnos((t) =>
        t.map((turno, i) => (i === t.length - 1 ? { ...turno, erro: mensagem } : turno)),
      );
    } finally {
      setOcupado(false);
    }
  };

  return (
    <Card className="flex flex-col gap-2 border-border/70 bg-panel p-3">
      <p className="nexus-eyebrow">PERGUNTAR SOBRE ESTE PRINT</p>

      {turnos.length === 0 && (
        <div className="flex flex-wrap gap-1">
          {SUGESTOES.map((s) => (
            <Button
              key={s}
              size="sm"
              variant="outline"
              className="h-6 text-[10px]"
              disabled={ocupado}
              onClick={() => void enviar(s)}
            >
              {s}
            </Button>
          ))}
        </div>
      )}

      {turnos.length > 0 && (
        <div className="flex max-h-64 flex-col gap-2 overflow-y-auto">
          {turnos.map((t, i) => (
            <div key={i} className="flex flex-col gap-1">
              <p className="text-[11px] font-medium">Você: {t.pergunta}</p>
              {t.resposta !== null && (
                <p className="whitespace-pre-wrap text-[11px] leading-snug text-muted-foreground">
                  {t.resposta}
                </p>
              )}
              {t.erro !== null && <p className="text-[11px] text-bear">{t.erro}</p>}
              {t.resposta === null && t.erro === null && (
                <p className="text-[11px] text-muted-foreground">analisando…</p>
              )}
            </div>
          ))}
        </div>
      )}

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void enviar(texto);
        }}
      >
        <Input
          value={texto}
          disabled={ocupado}
          placeholder="Pergunte sobre a análise…"
          onChange={(e) => setTexto(e.target.value)}
        />
        <Button type="submit" size="sm" disabled={ocupado || texto.trim().length < 2}>
          <SendHorizonal className="h-3.5 w-3.5" />
        </Button>
      </form>
    </Card>
  );
}
