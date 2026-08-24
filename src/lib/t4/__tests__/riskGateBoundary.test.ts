import { describe, expect, it } from "vitest";

import { MIN_RISK_REWARD } from "@/lib/engines/strategy";
import { MIN_RR, assessTradeRisk, riscoAprovado } from "../riskGate";

/**
 * A BORDA DO PISO, exatamente. 2,99 reprova e 3,00 passa — não existe
 * tolerância escondida, arredondamento simpático nem "quase 3". E o piso é
 * IMPORTADO: se alguém redigitar um segundo mínimo em qualquer módulo, o
 * primeiro teste daqui quebra na comparação com a fonte.
 */
describe("riskGate — borda exata do R:R mínimo", () => {
  it("a fonte única vale 3 e MIN_RR é ela, não uma cópia", () => {
    expect(MIN_RISK_REWARD).toBe(3);
    expect(MIN_RR).toBe(MIN_RISK_REWARD);
  });

  it("R:R 2,99 REPROVA com código RR_LT_3", () => {
    // risco 100 pontos, retorno 299 → 2,99.
    const a = assessTradeRisk({ side: "COMPRA", entry: 100_000, stop: 99_900, target: 100_299 });
    expect(a.rr).toBeCloseTo(2.99, 10);
    expect(a.verdict).toBe("RISK_REJECTED");
    expect(a.blockCode).toBe("RR_LT_3");
    expect(riscoAprovado(a)).toBe(false);
  });

  it("R:R 3,00 exato PASSA quando os níveis são coerentes", () => {
    const a = assessTradeRisk({ side: "COMPRA", entry: 100_000, stop: 99_900, target: 100_300 });
    expect(a.rr).toBeCloseTo(3, 10);
    expect(a.verdict).toBe("RISK_APPROVED");
    expect(a.blockCode).toBeNull();
    expect(riscoAprovado(a)).toBe(true);
  });

  it("venda espelhada: 2,99 reprova, 3,00 passa", () => {
    const reprova = assessTradeRisk({
      side: "VENDA",
      entry: 100_000,
      stop: 100_100,
      target: 99_701,
    });
    const passa = assessTradeRisk({ side: "VENDA", entry: 100_000, stop: 100_100, target: 99_700 });
    expect(reprova.blockCode).toBe("RR_LT_3");
    expect(passa.verdict).toBe("RISK_APPROVED");
  });

  it("nível faltando é PRICE_UNRELIABLE, nunca aprovação tímida", () => {
    const a = assessTradeRisk({ side: "COMPRA", entry: 100_000, stop: null, target: 100_300 });
    expect(a.verdict).toBe("RISK_UNKNOWN");
    expect(a.blockCode).toBe("PRICE_UNRELIABLE");
    expect(riscoAprovado(a)).toBe(false);
  });

  it("risco zero é STOP_TOO_SMALL — R:R incalculável não passa", () => {
    const a = assessTradeRisk({ side: "COMPRA", entry: 100_000, stop: 100_000, target: 100_300 });
    expect(a.verdict).toBe("RISK_REJECTED");
    expect(a.blockCode).toBe("STOP_TOO_SMALL");
  });

  it("níveis incoerentes reprovam mesmo com R:R alto", () => {
    // Stop ACIMA da entrada numa compra: rr numérico até existe, mas o plano não.
    const a = assessTradeRisk({ side: "COMPRA", entry: 100_000, stop: 100_100, target: 100_900 });
    expect(a.verdict).toBe("RISK_REJECTED");
    expect(a.blockCode).not.toBeNull();
  });
});
