import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { SetupDna } from "@/lib/t4/dna";
import {
  getDatabase,
  insertSetupDna,
  learnFromClosedSetups,
  listMemoryCases,
  listOpenSetups,
  listSetups,
  resetTradingRepositoryForTests,
  savePrintRecord,
  setupStats,
  sweepSetupOutcomes,
  upsertSetup,
  type SetupRecordInput,
} from "../tradingRepository";

/**
 * O CICLO DO SETUP CONTRA UM BANCO DE VERDADE. Nada de mock de SQLite: o que
 * precisa ser provado é que o desfecho fica gravado, que setup fechado NÃO
 * reabre e que a memória recebe cada resultado UMA vez.
 */

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const ASSET = "WINFUT";

let workingDir: string | null = null;

function freshDatabase(): void {
  resetTradingRepositoryForTests();
  const dir = mkdtempSync(join(tmpdir(), "analisador-setups-"));
  workingDir = dir;
  process.env.DATA_DIR = dir;
  delete process.env.DATABASE_PATH;
  // A retenção dispara em savePrintRecord; desligada aqui para que a faxina de
  // disco não interfira no que estes testes medem.
  process.env.PRINT_IMAGE_RETENTION_DAYS = "0";
}

afterEach(() => {
  resetTradingRepositoryForTests();
  if (workingDir) rmSync(workingDir, { recursive: true, force: true });
  workingDir = null;
  delete process.env.DATA_DIR;
  delete process.env.DATABASE_PATH;
  delete process.env.PRINT_IMAGE_RETENTION_DAYS;
});

function setup(over: Partial<SetupRecordInput> = {}): SetupRecordInput {
  return {
    setupId: "T4-2026-08-19-001",
    asset: ASSET,
    timeframe: "1m",
    direction: "COMPRA",
    stage: "CONFIRMADO",
    entry: 138_000,
    stop: 137_800,
    target: 138_600,
    entryZoneMin: null,
    entryZoneMax: null,
    confirmedAt: T0,
    createdAt: T0 - 5 * MIN,
    expiresAt: T0 + 45 * MIN,
    dnaId: null,
    printId: null,
    // Setup gravado sem rompimento observado — o estado conservador, que é o
    // que um cliente antigo (ou um setup ainda em formação) manda.
    triggerLevel: 138_000,
    triggerVersion: 1,
    triggerHistory: [],
    breakout: null,
    operationReleased: false,
    ...over,
  };
}

/** Observação de preço pelo caminho REAL: a etiqueta lida em cada print. */
function observe(id: string, at: number, price: number | null, dnaId: string | null = null): void {
  savePrintRecord({
    id,
    sessionId: null,
    asset: ASSET,
    timeframe: "1m",
    capturedAt: at,
    status: "SETUP",
    direction: "COMPRA",
    confidence: 70,
    currentPrice: price,
    dnaId,
    captureCode: "CICLO_60S",
    analysis: { note: id },
    imageDataUrl: null,
    prediction: null,
  });
}

function dna(id: string): SetupDna {
  return {
    id,
    origin: "PRINT",
    sourceId: "sessao_teste",
    printId: null,
    tradeId: null,
    asset: ASSET,
    timeframe: "1m",
    direction: "COMPRA",
    detectedAt: T0,
    tradingDate: null,
    hour: null,
    techniqueVersion: "T4.0.0",
    grade: "A_PLUS",
    trend: "FORTE",
    position: "A_FAVOR",
    pullback: "LIMPO",
    pullbackDepth: null,
    pullbackBars: null,
    impulsePoints: null,
    impulseR: null,
    location: "SUPORTE",
    locationDetail: null,
    triggerCandle: "ENGOLFO",
    movementOrdinal: 1,
    volatility: null,
    volatilityRatio: null,
    stopDistancePoints: 200,
    rrAvailable: 3,
    entry: 138_000,
    stop: 137_800,
    targets: [138_600],
  };
}

describe.sequential("ciclo de vida do setup persistente", () => {
  it("sobrevive ao restart do backend: listOpenSetups devolve o setup ativo", () => {
    freshDatabase();
    upsertSetup(setup(), T0);

    // O "restart": o singleton do SQLite cai e o banco é reaberto do disco.
    resetTradingRepositoryForTests();

    const abertos = listOpenSetups(ASSET);
    expect(abertos).toHaveLength(1);
    expect(abertos[0]?.setupId).toBe("T4-2026-08-19-001");
    expect(abertos[0]?.outcome).toBe("ABERTO");
    /*
     * O ESTÁGIO VOLTA NO VOCABULÁRIO NOVO — e o setup volta INTEIRO.
     *
     * A linha foi gravada com "CONFIRMADO", o nome em português da máquina
     * antiga, e a migração incremental de 20/08 a converteu no lugar. É esta a
     * regressão: converter sem perder nada. O id, o desfecho, a entrada e o
     * instante da confirmação são conferidos logo abaixo justamente porque um
     * UPDATE de estágio que apagasse qualquer um deles passaria despercebido
     * numa asserção só sobre `stage`.
     */
    expect(abertos[0]?.stage).toBe("CONFIRMED");
    expect(abertos[0]?.entry).toBe(138_000);
    expect(abertos[0]?.confirmedAt).toBe(T0);
  });

  it("migração de estágio é idempotente e não toca vocabulário novo", () => {
    /*
     * Rodar a migração de novo não pode achar mais nada para converter, e um
     * setup já gravado no vocabulário canônico tem de sair inalterado. Sem
     * isto, uma segunda passada poderia reescrever estado válido.
     */
    freshDatabase();
    upsertSetup({ ...setup(), stage: "ARMED" }, T0);
    resetTradingRepositoryForTests();
    expect(listOpenSetups(ASSET)[0]?.stage).toBe("ARMED");
    resetTradingRepositoryForTests();
    expect(listOpenSetups(ASSET)[0]?.stage).toBe("ARMED");
  });

  it("upsert é idempotente por setup_id — dois envios, uma linha", () => {
    freshDatabase();
    upsertSetup(setup(), T0);
    upsertSetup(setup({ stage: "CONFIRMADO", target: 138_900 }), T0 + MIN);

    const linhas = listSetups(ASSET);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.target).toBe(138_900);
    expect(linhas[0]?.updatedAt).toBe(T0 + MIN);
    // createdAt é do NASCIMENTO do setup e não se reescreve a cada print.
    expect(linhas[0]?.createdAt).toBe(T0 - 5 * MIN);
  });

  it("fecha WIN sozinho contra as observações dos prints", () => {
    freshDatabase();
    upsertSetup(setup(), T0);
    observe("p1", T0 + MIN, 138_100);
    observe("p2", T0 + 2 * MIN, 138_650);

    expect(sweepSetupOutcomes(ASSET, T0 + 3 * MIN)).toBe(1);

    const linha = listSetups(ASSET)[0]!;
    expect(linha.outcome).toBe("WIN");
    expect(linha.outcomeAt).toBe(T0 + 2 * MIN);
    expect(linha.ambiguous).toBe(false);
    expect(linha.outcomeReason).toContain("alvo");
  });

  it("fecha LOSS e o setup fechado NUNCA reabre, nem por upsert nem por nova varredura", () => {
    freshDatabase();
    upsertSetup(setup(), T0);
    observe("p1", T0 + MIN, 137_750);
    expect(sweepSetupOutcomes(ASSET, T0 + 2 * MIN)).toBe(1);
    expect(listSetups(ASSET)[0]?.outcome).toBe("LOSS");

    // O cliente ainda acha que o setup está vivo e reenvia o estado antigo.
    const reenvio = upsertSetup(setup({ stage: "CONFIRMADO" }), T0 + 3 * MIN);
    expect(reenvio.frozen).toBe(true);
    expect(reenvio.outcome).toBe("LOSS");
    expect(listOpenSetups(ASSET)).toHaveLength(0);

    // Depois chega o preço do alvo: não pode virar WIN em cima de um LOSS.
    observe("p2", T0 + 4 * MIN, 138_700);
    expect(sweepSetupOutcomes(ASSET, T0 + 5 * MIN)).toBe(0);
    const linha = listSetups(ASSET)[0]!;
    expect(linha.outcome).toBe("LOSS");
    expect(linha.outcomeAt).toBe(T0 + MIN);
  });

  it("varredura repetida não conta o mesmo desfecho duas vezes", () => {
    freshDatabase();
    upsertSetup(setup(), T0);
    observe("p1", T0 + MIN, 138_650);

    expect(sweepSetupOutcomes(ASSET, T0 + 2 * MIN)).toBe(1);
    expect(sweepSetupOutcomes(ASSET, T0 + 2 * MIN)).toBe(0);
    expect(sweepSetupOutcomes(ASSET, T0 + 9 * MIN)).toBe(0);
  });

  it("setup confirmado sem alvo/stop fecha INVALIDADO, e o não confirmado expira", () => {
    freshDatabase();
    upsertSetup(setup({ setupId: "sem_criterio", stop: null, target: null }), T0);
    upsertSetup(
      setup({
        setupId: "nunca_confirmou",
        stage: "FORMACAO",
        confirmedAt: null,
        expiresAt: T0 + 40 * MIN,
      }),
      T0,
    );

    expect(sweepSetupOutcomes(ASSET, T0 + 50 * MIN)).toBe(2);

    const porId = new Map(listSetups(ASSET).map((row) => [row.setupId, row]));
    expect(porId.get("sem_criterio")?.outcome).toBe("INVALIDADO");
    expect(porId.get("sem_criterio")?.outcomeReason).toContain("sem critério pré-definido");
    expect(porId.get("nunca_confirmou")?.outcome).toBe("EXPIRADO");
    expect(porId.get("nunca_confirmou")?.outcomeReason).toContain("sem confirmação");
  });

  it("observação anterior à confirmação não fecha o setup", () => {
    freshDatabase();
    upsertSetup(setup(), T0);
    // O alvo foi visitado ANTES da confirmação — passado, não resultado.
    observe("p_antigo", T0 - 2 * MIN, 138_900);

    expect(sweepSetupOutcomes(ASSET, T0 + 5 * MIN)).toBe(0);
    expect(listOpenSetups(ASSET)[0]?.outcome).toBe("ABERTO");
  });

  it("a memória recebe o resultado UMA vez — learned é trava, não enfeite", () => {
    freshDatabase();
    insertSetupDna(dna("dna_1"));
    upsertSetup(setup({ dnaId: "dna_1", printId: "p_origem" }), T0);
    observe("p_origem", T0 - MIN, 138_000, "dna_1");
    observe("p1", T0 + MIN, 138_650);
    sweepSetupOutcomes(ASSET, T0 + 2 * MIN);

    // Fechado mas ainda NÃO aprendido: a memória não o enxerga.
    expect(listMemoryCases(ASSET)).toHaveLength(0);

    const primeira = learnFromClosedSetups(ASSET, T0 + 3 * MIN);
    expect(primeira).toEqual({ applied: 1, withoutDna: 0 });

    const casos = listMemoryCases(ASSET);
    expect(casos).toHaveLength(1);
    expect(casos[0]?.verdict).toBe("ACERTOU");
    expect(casos[0]?.dna.id).toBe("dna_1");

    // Segunda passada: nada novo entra e a memória continua com UM caso.
    const segunda = learnFromClosedSetups(ASSET, T0 + 4 * MIN);
    expect(segunda).toEqual({ applied: 0, withoutDna: 0 });
    expect(listMemoryCases(ASSET)).toHaveLength(1);
    expect(listSetups(ASSET)[0]?.learned).toBe(true);
  });

  it("fechado sem DNA é declarado à parte, nunca contado como aprendizado", () => {
    freshDatabase();
    upsertSetup(setup({ dnaId: null }), T0);
    observe("p1", T0 + MIN, 137_700);
    sweepSetupOutcomes(ASSET, T0 + 2 * MIN);

    expect(learnFromClosedSetups(ASSET, T0 + 3 * MIN)).toEqual({ applied: 0, withoutDna: 1 });
    expect(listMemoryCases(ASSET)).toHaveLength(0);
  });

  it("o mesmo print não vira caso duas vezes (previsão + setup)", () => {
    freshDatabase();
    insertSetupDna(dna("dna_1"));
    // O print nasce COM previsão — este é o caminho antigo da memória.
    savePrintRecord({
      id: "p_origem",
      sessionId: null,
      asset: ASSET,
      timeframe: "1m",
      capturedAt: T0,
      status: "ENTRADA_CONFIRMADA",
      direction: "COMPRA",
      confidence: 80,
      currentPrice: 138_000,
      dnaId: "dna_1",
      captureCode: "CICLO_60S",
      analysis: {},
      imageDataUrl: null,
      prediction: { entry: 138_000, stop: 137_800, target: 138_600 },
    });
    getDatabase()
      .prepare("UPDATE print_predictions SET verdict='ACERTOU', resolved_at=? WHERE print_id=?")
      .run(T0 + 2 * MIN, "p_origem");

    upsertSetup(setup({ dnaId: "dna_1", printId: "p_origem" }), T0);
    observe("p1", T0 + MIN, 138_650);
    sweepSetupOutcomes(ASSET, T0 + 2 * MIN);
    learnFromClosedSetups(ASSET, T0 + 3 * MIN);

    // UMA decisão real = UM caso. Dois contariam a mesma evidência em dobro.
    const casos = listMemoryCases(ASSET);
    expect(casos).toHaveLength(1);
    expect(casos[0]?.printId).toBe("p_origem");
  });

  it("placar nega conclusão abaixo da amostra mínima e nunca inventa taxa", () => {
    freshDatabase();
    const vazio = setupStats(ASSET);
    expect(vazio.total).toBe(0);
    // Ausência é null declarado — 0% afirmaria derrota em cima de nada.
    expect(vazio.winRate).toBeNull();
    expect(vazio.note).toContain("sem taxa a declarar");

    upsertSetup(setup({ setupId: "s1" }), T0);
    observe("p1", T0 + MIN, 138_650);
    sweepSetupOutcomes(ASSET, T0 + 2 * MIN);

    const stats = setupStats(ASSET);
    expect(stats.wins).toBe(1);
    expect(stats.decided).toBe(1);
    expect(stats.winRate).toBe(100);
    expect(stats.sufficient).toBe(false);
    expect(stats.note).toContain("conclusão NÃO autorizada");
    expect(stats.note).toContain("1/30");
  });
});

/**
 * §32/§34 — O ESTADO DO ROMPIMENTO ATRAVESSA O REINÍCIO.
 *
 * Sem isto, um F5 no meio de um rompimento faz a máquina esquecer que já houve
 * fechamento além do gatilho: o candle seguinte, que era a PROVA, volta a ser
 * tratado como o primeiro fechamento e a sustentação nunca completa. É o tipo
 * de defeito que só aparece no pior momento — quando o operador recarrega a
 * página exatamente durante a oportunidade.
 */
describe.sequential("§34 — memória do rompimento sobrevive ao restart", () => {
  /** Um rompimento fechado e ainda não sustentado, como o print 3 do Caso A. */
  const romperam = (over: Partial<SetupRecordInput> = {}): SetupRecordInput =>
    setup({
      stage: "BREAKOUT_CLOSED",
      confirmedAt: null,
      triggerLevel: 170_925,
      triggerVersion: 2,
      triggerHistory: [
        { version: 1, level: 170_800, at: T0 - 5 * MIN, reason: "primeira leitura" },
        { version: 2, level: 170_925, at: T0 - 2 * MIN, reason: "gatilho relido" },
      ],
      breakout: {
        side: "COMPRA",
        trigger: 170_925,
        tolerance: 5,
        triggerTouched: true,
        breakoutClosed: true,
        breakoutSustained: false,
        retestConfirmed: false,
        setupConfirmed: false,
        phase: "BREAKOUT_CLOSED",
        breakoutCandleTime: T0 - MIN,
        lastCandleTime: T0 - MIN,
        retestTouched: false,
        failureReason: null,
        history: [],
      } as SetupRecordInput["breakout"],
      operationReleased: false,
      ...over,
    });

  it("gatilho, versão, histórico e rompimento voltam íntegros do banco", () => {
    freshDatabase();
    upsertSetup(romperam(), T0);

    // O "restart": o singleton do SQLite cai e o banco é reaberto do disco.
    resetTradingRepositoryForTests();

    const salvo = listOpenSetups(ASSET)[0]!;
    expect(salvo.stage).toBe("BREAKOUT_CLOSED");
    expect(salvo.triggerLevel).toBe(170_925);
    expect(salvo.triggerVersion).toBe(2);
    expect(salvo.triggerHistory).toHaveLength(2);
    expect(salvo.triggerHistory[1]!.reason).toContain("relido");
    expect(salvo.breakout).not.toBeNull();
    expect(salvo.breakout!.breakoutClosed).toBe(true);
    // Booleanos atravessam como booleanos, não como a string "false".
    expect(salvo.breakout!.breakoutSustained).toBe(false);
    expect(salvo.breakout!.trigger).toBe(170_925);
    expect(salvo.operationReleased).toBe(false);
  });

  it("a sustentação conquistada é gravada e volta verdadeira", () => {
    freshDatabase();
    upsertSetup(romperam(), T0);
    upsertSetup(
      romperam({
        stage: "CONFIRMED",
        confirmedAt: T0 + MIN,
        operationReleased: true,
        breakout: {
          ...romperam().breakout!,
          breakoutSustained: true,
          setupConfirmed: true,
          phase: "CONFIRMED",
        },
      }),
      T0 + MIN,
    );
    const salvo = listOpenSetups(ASSET)[0]!;
    expect(salvo.breakout!.breakoutSustained).toBe(true);
    expect(salvo.breakout!.phase).toBe("CONFIRMED");
    expect(salvo.operationReleased).toBe(true);
  });

  it("§9 — a versão do gatilho só anda para frente", () => {
    freshDatabase();
    upsertSetup(romperam({ triggerVersion: 5 }), T0);
    // Aba atrasada reenvia uma versão antiga: não pode rebaixar.
    upsertSetup(romperam({ triggerVersion: 2 }), T0 + MIN);
    expect(listOpenSetups(ASSET)[0]!.triggerVersion).toBe(5);
  });

  it("BREAKOUT_FAILED é persistível e fecha sem virar trade", () => {
    freshDatabase();
    upsertSetup(
      romperam({
        stage: "BREAKOUT_FAILED",
        confirmedAt: null,
        breakout: { ...romperam().breakout!, phase: "BREAKOUT_FAILED", failureReason: "devolveu" },
      }),
      T0,
    );
    const salvo = listSetups(ASSET)[0]!;
    expect(salvo.stage).toBe("BREAKOUT_FAILED");
    expect(salvo.breakout!.phase).toBe("BREAKOUT_FAILED");
    // Sem `confirmed_at` nunca vira WIN/LOSS: não conta trade nem acerto (§17).
    expect(salvo.confirmedAt).toBeNull();
  });

  it("setup gravado ANTES destas colunas volta conservador, nunca sustentado", () => {
    freshDatabase();
    // Linha legada: só as colunas antigas. Os defaults têm de significar
    // "nada observado" — jamais "já sustentado".
    getDatabase()
      .prepare(
        `INSERT INTO setups(setup_id, asset, timeframe, direction, stage, entry, stop,
           target, created_at, updated_at)
         VALUES ('T4-LEGADO-9', ?, '1m', 'COMPRA', 'WAITING_BREAKOUT', 138000, 137800,
           138600, ?, ?)`,
      )
      .run(ASSET, T0, T0);
    const legado = listSetups(ASSET).find((s) => s.setupId === "T4-LEGADO-9")!;
    expect(legado.breakout).toBeNull();
    expect(legado.triggerLevel).toBeNull();
    expect(legado.triggerVersion).toBe(1);
    expect(legado.triggerHistory).toEqual([]);
    expect(legado.operationReleased).toBe(false);
  });

  it("JSON corrompido não derruba a leitura — volta ao conservador", () => {
    freshDatabase();
    upsertSetup(romperam(), T0);
    getDatabase()
      .prepare("UPDATE setups SET breakout_json='{isto nao e json', trigger_history_json='['")
      .run();
    // Uma linha estragada não pode apagar a tela inteira do operador.
    const salvo = listSetups(ASSET)[0]!;
    expect(salvo.breakout).toBeNull();
    expect(salvo.triggerHistory).toEqual([]);
  });
});
