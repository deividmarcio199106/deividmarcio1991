import { describe, expect, it } from "vitest";

import { ReconnectBackoff, RECONNECT_STEPS_MS } from "./reconnect";

describe("backoff de reconexão da IA (§3)", () => {
  it("segue exatamente 1s→2s→5s→10s→30s e trava em 30s", () => {
    const backoff = new ReconnectBackoff();
    const delays = [0, 1, 2, 3, 4, 5, 6].map(() => backoff.record(false).nextDelayMs);
    expect(delays).toEqual([1_000, 2_000, 5_000, 10_000, 30_000, 30_000, 30_000]);
  });

  it("sinaliza RECONECTADA exatamente uma vez ao voltar e reseta a escada", () => {
    const backoff = new ReconnectBackoff();
    backoff.record(false);
    backoff.record(false);
    const back = backoff.record(true);
    expect(back.reconnected).toBe(true);
    expect(backoff.record(true).reconnected).toBe(false);
    expect(backoff.record(false).nextDelayMs).toBe(RECONNECT_STEPS_MS[0]);
  });
});
