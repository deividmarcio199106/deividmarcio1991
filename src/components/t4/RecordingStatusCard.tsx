import { useSyncExternalStore } from "react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  screenRecordingManager,
  type RecordingManagerState,
} from "@/lib/recording/screenRecordingManager";
import { cn } from "@/lib/utils";

const SSR_STATE: RecordingManagerState = {
  sessionId: null,
  status: "IDLE",
  recorderState: null,
  dbSessionCreated: false,
  firstChunkSaved: false,
  chunksSaved: 0,
  bytesSaved: 0,
  lastChunkAt: null,
  segment: 0,
  error: null,
  startedAt: null,
};

function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const STATUS_LABEL: Record<RecordingManagerState["status"], string> = {
  IDLE: "SEM GRAVAÇÃO",
  STARTING: "INICIANDO",
  GRAVANDO: "GRAVANDO",
  RECORDER_ERROR: "RECORDER_ERROR",
  ANALISE_ATIVA_GRAVACAO_FALHOU: "ANÁLISE ATIVA — GRAVAÇÃO FALHOU",
  FINALIZANDO: "FINALIZANDO",
  FINALIZADA: "FINALIZADA",
  FALHOU: "FALHOU",
};

/**
 * Estado REAL da gravação (comando §9): GRAVANDO só aparece quando
 * recorder.state=recording + primeiro chunk persistido + sessão no banco.
 */
export function RecordingStatusCard() {
  const state = useSyncExternalStore(
    (listener) => screenRecordingManager.subscribe(listener),
    () => screenRecordingManager.getState(),
    () => SSR_STATE,
  );
  const recording = state.status === "GRAVANDO";
  const failed =
    state.status === "RECORDER_ERROR" ||
    state.status === "ANALISE_ATIVA_GRAVACAO_FALHOU" ||
    state.status === "FALHOU";
  return (
    <Card className="nexus-card gap-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="nexus-eyebrow">GRAVAÇÃO DA SESSÃO</p>
        <Badge
          variant="outline"
          className={cn(
            "font-mono",
            recording && "border-bull text-bull",
            failed && "border-bear text-bear",
          )}
        >
          {recording && (
            <span className="mr-1 inline-block h-2 w-2 animate-pulse rounded-full bg-bear" />
          )}
          {STATUS_LABEL[state.status]}
        </Badge>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] sm:grid-cols-4">
        <Field label="RECORDER" value={state.recorderState ?? "—"} />
        <Field label="CHUNKS" value={String(state.chunksSaved)} />
        <Field label="BYTES" value={bytesLabel(state.bytesSaved)} />
        <Field
          label="ÚLTIMO CHUNK"
          value={
            state.lastChunkAt
              ? new Date(state.lastChunkAt).toLocaleTimeString("pt-BR", { hour12: false })
              : "—"
          }
        />
        <Field
          label="DURAÇÃO"
          value={state.startedAt ? `${Math.round((Date.now() - state.startedAt) / 1000)}s` : "—"}
        />
        <Field label="SEGMENTO" value={String(state.segment)} />
        <Field label="SESSÃO DB" value={state.dbSessionCreated ? "CRIADA" : "—"} />
        <Field label="SESSION" value={state.sessionId ?? "—"} />
      </div>
      {state.error && <p className="text-[11px] text-bear">{state.error}</p>}
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[9px] tracking-widest text-muted-foreground">{label}</p>
      <p className="truncate" title={value}>
        {value}
      </p>
    </div>
  );
}
