import { createFileRoute } from "@tanstack/react-router";
import { RotateCcw, Save, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { AIStatusCard } from "@/components/AIStatusCard";
import { playTestSound } from "@/lib/t4/signalSound";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Settings } from "@/lib/storage";
import { DEFAULT_SETTINGS, store } from "@/lib/storage";

export const Route = createFileRoute("/configuracoes")({
  component: ConfiguracoesPage,
  head: () => ({ meta: [{ title: "Configurações — Analisador Visual T4" }] }),
});

function positive(value: number, fallback = 0): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function ConfiguracoesPage() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  useEffect(() => setSettings(store.settings()), []);

  const save = () => {
    const next: Settings = {
      ...settings,
      asset: settings.asset.trim().toUpperCase() || DEFAULT_SETTINGS.asset,
      maxContracts: Math.max(1, Math.min(3, Math.round(settings.maxContracts))),
      maxRiskPerTradePoints: positive(settings.maxRiskPerTradePoints),
      tickSize: positive(settings.tickSize),
      minStopDistancePoints: positive(settings.minStopDistancePoints),
      maxStopDistancePoints: Math.max(
        positive(settings.minStopDistancePoints),
        positive(settings.maxStopDistancePoints),
      ),
      partialTargetMultiple: 3,
      finalTargetMultiple: 5,
    };
    store.saveSettings(next);
    setSettings(next);
    toast.success("Configurações salvas.");
  };

  const reset = () => {
    store.saveSettings(DEFAULT_SETTINGS);
    setSettings(DEFAULT_SETTINGS);
    toast.success("Padrões restaurados.");
  };

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">Configurações</h1>
          <p className="max-w-3xl text-xs text-muted-foreground">
            A técnica em produção é versionada. Aqui ficam apenas limites de risco, instrumento e
            gerenciamento; alterar estes campos não muda as regras técnicas validadas.
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={reset}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Restaurar
          </Button>
          <Button size="sm" onClick={save}>
            <Save className="mr-1.5 h-3.5 w-3.5" /> Salvar
          </Button>
        </div>
      </header>

      <Card className="border-border/70 bg-panel p-3">
        <p className="mb-3 text-[10px] font-medium tracking-widest text-muted-foreground">
          RISCO E CONTRATOS
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TextField
            label="ATIVO PADRÃO"
            value={settings.asset}
            onChange={(asset) => setSettings((s) => ({ ...s, asset }))}
          />
          <NumberField
            label="MÁX. CONTRATOS"
            value={settings.maxContracts}
            min={1}
            max={3}
            step={1}
            onChange={(maxContracts) => setSettings((s) => ({ ...s, maxContracts }))}
          />
          <NumberField
            label="RISCO MÁXIMO (PONTOS)"
            value={settings.maxRiskPerTradePoints}
            min={0}
            onChange={(maxRiskPerTradePoints) =>
              setSettings((s) => ({ ...s, maxRiskPerTradePoints }))
            }
          />
          <NumberField
            label="TICK DO ATIVO"
            value={settings.tickSize}
            min={0}
            onChange={(tickSize) => setSettings((s) => ({ ...s, tickSize }))}
          />
          <NumberField
            label="STOP MÍNIMO"
            value={settings.minStopDistancePoints}
            min={0}
            onChange={(minStopDistancePoints) =>
              setSettings((s) => ({ ...s, minStopDistancePoints }))
            }
          />
          <NumberField
            label="STOP MÁXIMO"
            value={settings.maxStopDistancePoints}
            min={0}
            onChange={(maxStopDistancePoints) =>
              setSettings((s) => ({ ...s, maxStopDistancePoints }))
            }
          />
          <div className="rounded-md border border-border/70 p-2">
            <Label>GESTÃO T4</Label>
            <p className="mt-1 font-mono text-sm">1º contrato 3R · 2º 5R · 3º runner</p>
            <p className="mt-1 text-[10px] text-muted-foreground">
              Gestão fixa e versionada para garantir paridade entre Replay e Ao Vivo.
            </p>
          </div>
          <div className="rounded-md border border-border/70 p-2">
            <Label>PROTEÇÃO T4</Label>
            <p className="mt-1 font-mono text-sm">após 3,5R · lock +0,25R</p>
            <p className="mt-1 text-[10px] text-muted-foreground">
              O stop continua estrutural; nunca é encurtado para forçar 3R.
            </p>
          </div>
        </div>
      </Card>

      <Card className="border-border/70 bg-panel p-3">
        <p className="mb-3 text-[10px] font-medium tracking-widest text-muted-foreground">
          SOM DE CONFIRMAÇÃO T4
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 rounded-md border border-border/70 px-3 py-2 text-sm">
            <input
              type="checkbox"
              checked={settings.sound}
              onChange={(event) => {
                const next = { ...settings, sound: event.target.checked };
                setSettings(next);
                store.saveSettings(next);
              }}
            />
            <span>
              Alerta sonoro ao <strong>CONFIRMAR</strong> entrada (1x por sinal)
            </span>
          </label>
          <Button size="sm" variant="outline" onClick={() => playTestSound("COMPRA")}>
            <Volume2 className="mr-1.5 h-3.5 w-3.5" /> Testar som de compra
          </Button>
          <Button size="sm" variant="outline" onClick={() => playTestSound("VENDA")}>
            <Volume2 className="mr-1.5 h-3.5 w-3.5" /> Testar som de venda
          </Button>
        </div>
        <p className="mt-2 text-[10px] text-muted-foreground">
          O som toca uma única vez por signalId na transição PRÉ-SINAL → CONFIRMADO. Compra e venda
          têm timbres diferentes; nunca repete por frame.
        </p>
      </Card>

      <AIStatusCard />
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <Input value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange(value: number): void;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <Input
        type="number"
        value={Number.isFinite(value) ? value : ""}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}
