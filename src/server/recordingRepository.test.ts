import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resetTradingRepositoryForTests } from "./tradingRepository";
import {
  createRecordingSession,
  finalizeRecordingSession,
  getRecordingStatus,
  saveRecordingChunk,
  saveRecordingEvent,
  updateRecordingSession,
} from "./recordingRepository";
import { clearResolvedErrors, listErrors, recordError, setErrorResolved } from "./errorRepository";

let workingDir: string | null = null;

function freshDatabase(): string {
  resetTradingRepositoryForTests();
  const dir = mkdtempSync(join(tmpdir(), "analisador-rec-"));
  workingDir = dir;
  process.env.DATA_DIR = dir;
  delete process.env.DATABASE_PATH;
  return dir;
}

afterEach(() => {
  resetTradingRepositoryForTests();
  if (workingDir) rmSync(workingDir, { recursive: true, force: true });
  workingDir = null;
  delete process.env.DATA_DIR;
  delete process.env.DATABASE_PATH;
});

describe.sequential("gravação — manifesto progressivo (comando §9)", () => {
  it("chunks vão para disco, status agrega bytes reais e o STOP valida bytes>0", () => {
    freshDatabase();
    createRecordingSession({ sessionId: "rec_1", asset: "WINFUT", startedAt: 1_700_000_000_000 });

    const chunk = saveRecordingChunk(
      {
        sessionId: "rec_1",
        index: 0,
        segment: 0,
        startedAt: 1,
        endedAt: 2,
        mimeType: "video/webm",
      },
      new Uint8Array([1, 2, 3, 4]),
    );
    expect(chunk.status).toBe("SAVED");
    saveRecordingChunk(
      {
        sessionId: "rec_1",
        index: 1,
        segment: 0,
        startedAt: 2,
        endedAt: 4,
        mimeType: "video/webm",
      },
      new Uint8Array([5, 6]),
    );
    saveRecordingEvent({
      id: "ev1",
      sessionId: "rec_1",
      realTimestamp: 3,
      chartTimestamp: 1_700_000_060_000,
      type: "SIGNAL_CONFIRMED",
      payload: { signalId: "sig_x" },
    });

    const status = getRecordingStatus("rec_1")!;
    expect(status.chunksSaved).toBe(2);
    expect(status.bytesSaved).toBe(6);
    expect(status.eventsSaved).toBe(1);
    expect(status.status).toBe("RECORDING");

    const final = finalizeRecordingSession({ sessionId: "rec_1", endedAt: 1_700_000_100_000 })!;
    expect(final.status).toBe("COMPLETED");
  });

  it("chunk vazio é descartado e sessão sem bytes finaliza FAILED_EMPTY", () => {
    freshDatabase();
    createRecordingSession({ sessionId: "rec_2", startedAt: 1 });
    const empty = saveRecordingChunk(
      { sessionId: "rec_2", index: 0, segment: 0, startedAt: 1, endedAt: 2, mimeType: null },
      new Uint8Array([]),
    );
    expect(empty.status).toBe("EMPTY_DISCARDED");
    const final = finalizeRecordingSession({ sessionId: "rec_2", endedAt: 3 })!;
    expect(final.status).toBe("FAILED_EMPTY");
    expect(final.error).toBeTruthy();
  });

  it("RECORDER_ERROR e novo segmento preservam chunks anteriores", () => {
    freshDatabase();
    createRecordingSession({ sessionId: "rec_3", startedAt: 1 });
    saveRecordingChunk(
      { sessionId: "rec_3", index: 0, segment: 0, startedAt: 1, endedAt: 2, mimeType: null },
      new Uint8Array([9]),
    );
    updateRecordingSession({ sessionId: "rec_3", status: "RECORDER_ERROR", error: "queda" });
    saveRecordingChunk(
      { sessionId: "rec_3", index: 1, segment: 1, startedAt: 3, endedAt: 4, mimeType: null },
      new Uint8Array([9, 9]),
    );
    const status = getRecordingStatus("rec_3")!;
    expect(status.chunksSaved).toBe(2);
    expect(status.bytesSaved).toBe(3);
  });
});

describe.sequential("central de erros — agrupamento e sanitização (comando §3)", () => {
  it("agrupa repetidos, sanitiza segredos e resolve/reabre", () => {
    freshDatabase();
    const first = recordError({
      severity: "ERROR",
      source: "OLLAMA",
      message: "Falha com api_key=abc123secreta no túnel",
    });
    expect(first.message).not.toContain("abc123secreta");
    const repeated = recordError({
      severity: "ERROR",
      source: "OLLAMA",
      message: "Falha com api_key=abc123secreta no túnel",
    });
    expect(repeated.id).toBe(first.id);
    expect(repeated.occurrences).toBe(2);

    const resolved = setErrorResolved(first.id, true)!;
    expect(resolved.resolved).toBe(true);
    // Depois de resolvido, o mesmo erro abre um NOVO registro (reincidência).
    const again = recordError({
      severity: "ERROR",
      source: "OLLAMA",
      message: "Falha com api_key=abc123secreta no túnel",
    });
    expect(again.id).not.toBe(first.id);
    expect(clearResolvedErrors()).toBe(1);
    expect(listErrors({ resolved: true })).toHaveLength(0);
  });
});
