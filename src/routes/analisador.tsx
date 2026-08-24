import { createFileRoute, Link } from "@tanstack/react-router";
import { Database, Radio, Video } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { STRATEGY_VERSION } from "@/lib/engines/strategy";

export const Route = createFileRoute("/analisador")({ component: AnalisadorPage });

function AnalisadorPage() {
  return (
    <div className="flex flex-col gap-3">
      <header>
        <h1 className="font-display text-2xl font-bold">Analisador T4</h1>
        <p className="text-xs text-muted-foreground">
          Observação contínua do gráfico em movimento, memória temporal e decisão por evidência
          histórica validada.
        </p>
      </header>
      <div className="grid gap-3 md:grid-cols-2">
        <Card className="p-4">
          <Radio className="mb-2 h-6 w-6 text-primary" />
          <h2 className="font-display text-lg font-bold">Análise ao vivo</h2>
          <p className="my-2 text-sm text-muted-foreground">
            Selecione a janela do Profit, calibre as regiões e acompanhe candles fechados com
            decisão baseada na base histórica.
          </p>
          <Button asChild>
            <Link to="/operacao-ao-vivo">Abrir operação ao vivo</Link>
          </Button>
        </Card>
        <Card className="p-4">
          <Video className="mb-2 h-6 w-6 text-primary" />
          <h2 className="font-display text-lg font-bold">Backtest por observação contínua</h2>
          <p className="my-2 text-sm text-muted-foreground">
            Deixe o histórico andar no Profit; o motor observa cada instante sem ver candles futuros
            e registra o resultado posteriormente.
          </p>
          <Button asChild variant="secondary">
            <Link to="/backtest">Abrir Backtest contínuo</Link>
          </Button>
        </Card>
      </div>
      <Card className="p-4">
        <div className="flex items-center gap-2">
          <Database className="h-5 w-5 text-primary" />
          <p className="text-[10px] tracking-widest text-muted-foreground">
            ARQUITETURA ATUAL — {STRATEGY_VERSION}
          </p>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          Captura contínua → frame diff/ROI → OCR → memória temporal → eventos estruturados →
          Wyckoff/HSS/Liquidez/POI/SMS → histórico → validação estatística → decisão → gerenciamento
          → resultado real → banco persistente.
        </p>
      </Card>
    </div>
  );
}
