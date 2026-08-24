import { describe, expect, it } from "vitest";

import {
  LunaPrintReadSchema,
  TerraChallengeSchema,
  parseAi,
  type LunaPrintRead,
  type TerraChallenge,
} from "../aiSchemas";
import { aiStatusRows, finalConfirmation, lunaSanity } from "../aiValidation";

/** Leitura Luna sã e aprovadora — a base que cada teste distorce num ponto. */
function lunaOk(extra: Partial<LunaPrintRead> = {}): LunaPrintRead {
  return {
    captureId: "cap_1",
    candleTime: 1_700_000_000_000,
    direction: "COMPRA",
    regime: "TENDENCIA_ALTA",
    t4Present: true,
    entryVisible: true,
    entry: 100_000,
    stopVisible: true,
    stop: 99_900,
    targetVisible: true,
    target3R: 100_300,
    target5R: 100_500,
    confirmationCandleClosed: true,
    pullbackCandles: 3,
    pivotPreserved: true,
    structureAligned: true,
    obstacleBefore5R: false,
    confidences: { visual: 90, structure: 85, t4: 80, entry: 75 },
    contradictions: [],
    evidence: ["pullback de 3 candles", "E2 fechada acima da máxima anterior"],
    verdict: "PASS",
    ...extra,
  };
}

const terraAprova: TerraChallenge = {
  approved: true,
  contradictions: [],
  criticalIssue: null,
  evidence: ["nenhuma inconsistência encontrada"],
  verdict: "APPROVE",
};

const DET = { entry: 100_000, stop: 99_900 };

describe("lunaSanity — a guarda anti-invenção", () => {
  it("número presente com visible=false é INVENÇÃO e descarta a leitura", () => {
    const s = lunaSanity({ luna: lunaOk({ entryVisible: false }), deterministic: DET });
    expect(s.hallucinated).toBe(true);
    expect(s.usable).toBe(false);
    expect(s.problems[0]).toContain("inventado");
  });

  it("divergência grande contra o motor derruba a leitura", () => {
    const s = lunaSanity({ luna: lunaOk({ entry: 101_000 }), deterministic: DET });
    expect(s.usable).toBe(false);
    expect(s.problems[0]).toContain("diverge");
  });

  it("leitura coerente é utilizável", () => {
    const s = lunaSanity({ luna: lunaOk(), deterministic: DET });
    expect(s.usable).toBe(true);
    expect(s.hallucinated).toBe(false);
  });

  it("null onde não é visível é a resposta HONESTA — não é invenção", () => {
    const s = lunaSanity({
      luna: lunaOk({
        entryVisible: false,
        entry: null,
        targetVisible: false,
        target3R: null,
        target5R: null,
      }),
      deterministic: DET,
    });
    expect(s.hallucinated).toBe(false);
  });
});

describe("finalConfirmation — a IA nunca libera sozinha", () => {
  const base = {
    t4DeterministicPass: true,
    e2Closed: true,
    rrOk: true,
    levelsValid: true,
    luna: {
      status: "OK" as const,
      value: { read: lunaOk(), sanity: lunaSanity({ luna: lunaOk(), deterministic: DET }) },
    },
    terra: { status: "OK" as const, value: terraAprova },
  };

  it("com TUDO verde, confirma", () => {
    expect(finalConfirmation(base).confirmado).toBe(true);
  });

  it("Luna PASS + Terra APPROVE NÃO liberam quando a T4 determinística bloqueou", () => {
    const r = finalConfirmation({ ...base, t4DeterministicPass: false });
    expect(r.confirmado).toBe(false);
    expect(r.motivo).toContain("determinística");
  });

  it("E2 aberta nega mesmo com todas as aprovações", () => {
    const r = finalConfirmation({ ...base, e2Closed: false });
    expect(r.confirmado).toBe(false);
    expect(r.blockCode).toBe("E2_OPEN_OR_UNKNOWN");
  });

  it("RR abaixo do piso nega com RR_LT_3", () => {
    const r = finalConfirmation({ ...base, rrOk: false });
    expect(r.blockCode).toBe("RR_LT_3");
  });

  it("Terra REJECT bloqueia", () => {
    const r = finalConfirmation({
      ...base,
      terra: {
        status: "OK",
        value: {
          ...terraAprova,
          approved: false,
          verdict: "REJECT",
          criticalIssue: "stop do lado errado",
        },
      },
    });
    expect(r.confirmado).toBe(false);
    expect(r.motivo).toContain("stop do lado errado");
  });

  it("Terra INCONCLUSIVE também bloqueia — dúvida não confirma", () => {
    const r = finalConfirmation({
      ...base,
      terra: { status: "OK", value: { ...terraAprova, verdict: "INCONCLUSIVE" } },
    });
    expect(r.confirmado).toBe(false);
  });

  it("OpenAI fora do ar: monitoramento segue, confirmação que depende da IA NÃO sai", () => {
    const r = finalConfirmation({
      ...base,
      luna: { status: "INDISPONIVEL", reason: "HTTP 500" },
      terra: { status: "NAO_CHAMADO" },
    });
    expect(r.confirmado).toBe(false);
    expect(r.motivo).toContain("indisponível");
  });

  it("Luna inventando preço é rejeitada — a leitura insana não sustenta confirmação", () => {
    const insana = lunaOk({ entryVisible: false });
    const r = finalConfirmation({
      ...base,
      luna: {
        status: "OK",
        value: { read: insana, sanity: lunaSanity({ luna: insana, deterministic: DET }) },
      },
    });
    expect(r.confirmado).toBe(false);
    expect(r.motivo).toContain("descartada");
  });

  it("Luna vendo candle aberto nega com E2_OPEN_OR_UNKNOWN", () => {
    const aberta = lunaOk({ confirmationCandleClosed: false });
    const r = finalConfirmation({
      ...base,
      luna: {
        status: "OK",
        value: { read: aberta, sanity: lunaSanity({ luna: aberta, deterministic: DET }) },
      },
    });
    expect(r.blockCode).toBe("E2_OPEN_OR_UNKNOWN");
  });

  it("NÃO EXISTE caminho em que a IA aprove e o resultado seja confirmado sem T4 PASS", () => {
    // Varre todas as combinações de vereditos da IA com t4 bloqueada.
    for (const lv of ["PASS", "REJECT", "INCONCLUSIVE"] as const) {
      for (const tv of ["APPROVE", "REJECT", "INCONCLUSIVE"] as const) {
        const read = lunaOk({ verdict: lv });
        const r = finalConfirmation({
          ...base,
          t4DeterministicPass: false,
          luna: {
            status: "OK",
            value: { read, sanity: lunaSanity({ luna: read, deterministic: DET }) },
          },
          terra: {
            status: "OK",
            value: { ...terraAprova, verdict: tv, approved: tv === "APPROVE" },
          },
        });
        expect(r.confirmado).toBe(false);
      }
    }
  });
});

describe("schemas — JSON inválido bloqueia", () => {
  it("payload fora do schema não passa nem parcialmente", () => {
    const r = parseAi(LunaPrintReadSchema, { captureId: "x", verdict: "TALVEZ" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
  });

  it("Terra com campo faltando é bloqueada", () => {
    const r = parseAi(TerraChallengeSchema, { approved: true });
    expect(r.ok).toBe(false);
  });
});

describe("aiStatusRows — as quatro linhas da UI", () => {
  it("mostra NÃO CHAMADO, o PASS/BLOCKED da T4 e o motivo do veredito", () => {
    const final = finalConfirmation({
      t4DeterministicPass: false,
      e2Closed: true,
      rrOk: true,
      levelsValid: true,
      luna: { status: "NAO_CHAMADO" },
      terra: { status: "NAO_CHAMADO" },
    });
    const rows = aiStatusRows({
      luna: { status: "NAO_CHAMADO" },
      terra: { status: "NAO_CHAMADO" },
      t4DeterministicPass: false,
      final,
    });
    expect(rows.luna).toBe("OPENAI LUNA: NÃO CHAMADO");
    expect(rows.terra).toBe("OPENAI TERRA: NÃO CHAMADO");
    expect(rows.t4).toContain("BLOCKED");
    expect(rows.veredito).toContain("AGUARDAR");
    expect(rows.veredito).toContain("—");
  });
});
