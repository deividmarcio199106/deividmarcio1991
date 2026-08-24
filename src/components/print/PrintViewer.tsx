import { useState } from "react";
import { ZoomIn, ZoomOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ChartOverlay, OverlayLabels, type EntrySide } from "@/components/print/ChartOverlay";
import {
  TRIGGER_EMOJI,
  type Annotation,
  type NextScreenshot,
  type PrintAnalysis,
} from "@/lib/vision/printAnalysis";

/**
 * VISUALIZADOR DO PRINT — original, analisado, slider e zoom, num lugar só.
 *
 * A imagem e o overlay vivem DENTRO do mesmo contêiner escalado. É isso que
 * torna o zoom "sincronizado" de graça: não existem duas superfícies para
 * alinhar, existe uma — o SVG normalizado acompanha a imagem em qualquer
 * escala porque é filho da mesma caixa.
 *
 * O SLIDER compara com/sem marcações por recorte (clip-path) do overlay, não
 * por segunda imagem: original e analisado são O MESMO bitmap, e mantê-lo único
 * garante que a comparação nunca desalinhe por um pixel.
 */

export type ViewMode = "ORIGINAL" | "ANALISADO" | "SLIDER";

const ZOOMS = [1, 1.5, 2, 3] as const;

/** Quantos gatilhos aparecem no gráfico. Mais que isso polui e esconde o resto. */
const MAX_TRIGGERS_ON_CHART = 3;

export function PrintViewer({
  image,
  captureId,
  analysis,
  mode,
  hidden,
  onSelect,
  selected,
  entrySide,
}: {
  image: string;
  /** Identidade da captura — invalida o nó da imagem a cada print novo. */
  captureId?: string | null;
  analysis: PrintAnalysis | null;
  mode: ViewMode;
  hidden?: Set<string>;
  onSelect?: (a: Annotation) => void;
  selected?: Annotation | null;
  /** Lado da entrada sinalizada — repassado ao overlay para cor e triângulo. */
  entrySide?: EntrySide | null;
}) {
  const [zoom, setZoom] = useState(0);
  const escala = ZOOMS[zoom] ?? 1;
  const [corte, setCorte] = useState(50);

  const comMarcas = analysis !== null && mode !== "ORIGINAL";
  const overlay = comMarcas ? (
    <>
      <ChartOverlay
        annotations={analysis.annotations}
        hidden={hidden}
        onSelect={onSelect}
        selected={selected}
        entrySide={entrySide}
      />
      <OverlayLabels
        annotations={analysis.annotations}
        hidden={hidden}
        onSelect={onSelect}
        entrySide={entrySide}
      />
      <TriggerMarkers next={analysis.nextScreenshot} />
    </>
  ) : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2"
          disabled={zoom === 0}
          onClick={() => setZoom((z) => Math.max(0, z - 1))}
        >
          <ZoomOut className="h-3.5 w-3.5" />
        </Button>
        <span className="w-12 text-center font-mono text-[10px] text-muted-foreground">
          {Math.round(escala * 100)}%
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2"
          disabled={zoom === ZOOMS.length - 1}
          onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))}
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </Button>
        {mode === "SLIDER" && (
          <input
            type="range"
            min={0}
            max={100}
            value={corte}
            onChange={(e) => setCorte(Number(e.target.value))}
            className="ml-2 h-1 flex-1 accent-amber-500"
            aria-label="Divisor original/analisado"
          />
        )}
      </div>

      {/* overflow-auto: com zoom, o operador rola em vez de estourar o layout. */}
      <div className="max-h-[70vh] w-full overflow-auto rounded border border-border/50">
        <div className="relative" style={{ width: `${escala * 100}%` }}>
          {/*
            A CHAVE É O captureId — e existe por causa de cache (§6).
            Sem ela o React reaproveita o MESMO nó <img> entre capturas: com
            data URLs grandes o navegador pode continuar pintando o bitmap
            anterior por um instante, e o operador vê o print velho sobre a
            análise nova. Trocando a chave, o elemento é recriado e não há
            imagem antiga para reaproveitar.
          */}
          <img
            key={captureId ?? image.length}
            src={image}
            alt="Print do gráfico enviado"
            className="block w-full select-none"
          />
          {mode === "SLIDER" && overlay !== null ? (
            <>
              {/* Só o overlay é recortado: a imagem embaixo é uma e contínua. */}
              <div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${corte}%)` }}>
                {overlay}
              </div>
              <div
                className="pointer-events-none absolute inset-y-0 w-px bg-amber-500"
                style={{ left: `${corte}%` }}
              />
              <span
                className="pointer-events-none absolute top-1 rounded bg-black/60 px-1 font-mono text-[9px] text-amber-500"
                style={{ left: `calc(${corte}% + 4px)` }}
              >
                ANALISADO →
              </span>
            </>
          ) : (
            overlay
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 📸 no gráfico: ONDE observar para o próximo print.
 *
 * Vem de `nextScreenshot.triggers`, não das `annotations` — o modelo descreve a
 * condição futura uma vez e a UI decide como mostrá-la, em vez de exigir que o
 * modelo duplique a informação em dois formatos que poderiam divergir.
 */
function TriggerMarkers({ next }: { next: NextScreenshot | null }) {
  if (!next) return null;
  const ordem = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
  const noGrafico = next.triggers
    .filter((t) => t.x !== null && t.y !== null)
    .sort((a, b) => ordem[a.priority] - ordem[b.priority])
    .slice(0, MAX_TRIGGERS_ON_CHART);
  if (noGrafico.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0">
      {noGrafico.map((t, i) => (
        <div
          key={`${t.type}-${i}`}
          className="absolute -translate-x-1/2 -translate-y-full"
          style={{ left: `${(t.x ?? 0) * 100}%`, top: `${(t.y ?? 0) * 100}%` }}
        >
          <span className="whitespace-nowrap rounded border border-amber-500 bg-black/70 px-1.5 py-0.5 text-[9px] font-medium text-amber-500">
            📸 {TRIGGER_EMOJI[t.type]} {t.label}
          </span>
          <div className="mx-auto h-2 w-px bg-amber-500" />
        </div>
      ))}
    </div>
  );
}
