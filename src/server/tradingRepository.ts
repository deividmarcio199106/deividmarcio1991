import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { MIN_EVIDENCE_SAMPLE } from "@/lib/engines/evidenceValidation";
import type { BacktestTrade } from "@/lib/engines/backtestEngine";
import type { Candle } from "@/lib/engines/types";
import {
  setAssetValidationStore,
  type AssetAuthorization,
  type AssetValidation,
  type AssetValidationStore,
} from "@/lib/t4/assets";
import { T41_CANDIDATE_ID, t41Candidate } from "@/lib/t4/techniqueT41";
import {
  conferirCongelamentoT42,
  T42_CANDIDATE_ID,
  t42Candidate,
  type VereditoDoCongelamento,
} from "@/lib/t4/techniqueT42";
import type { SetupDna } from "@/lib/t4/dna";
import type { DnaOutcome } from "@/lib/t4/dnaStats";
import { evaluatePrediction } from "@/lib/print/predictionOutcome";
import { evaluateSetup, type SetupOutcome } from "@/lib/print/setupOutcome";
import type { BreakoutState } from "@/lib/print/breakout";
import type { TriggerVersion } from "@/lib/print/setupTracker";
import { lossFactorTable } from "@/lib/t4/dnaStats";
import type { MemoryCase } from "@/lib/print/caseMemory";
import { STRATEGY_VERSION, T4_PROFILE } from "@/lib/engines/strategy";
import { learnFromDay, type DailyLearningReport } from "@/lib/engines/dailyLearning";
import type {
  BacktestRecord,
  LiveSessionRecord,
  MarketEventRecord,
  ReplayRecordingRecord,
  SegmentRecord,
  TechniqueCandidateRecord,
  TechniqueRecord,
  TradingSessionRecord,
} from "@/lib/storage";

/**
 * Subiu para 6 com a migration 008 (asset_authorizations): a autorização de
 * produção por ativo deixou de viver só em memória. Para 7 com a 009
 * (ai_validations): a trilha das validações OpenAI por captura, idempotente e
 * nunca sobrescrita. Para 8 com a 010 (trades_dedup): o MESMO evento de
 * mercado não pode virar duas linhas de `trades` — UNIQUE(trading_date,
 * opened_at, direction, setup), com dedup prévio dos duplicados históricos.
 * `schema_migrations` guarda o carimbo para que um banco antigo se
 * identifique como antigo.
 */
const SCHEMA_VERSION = 8;

function dataDir(): string {
  return resolve(process.env["DATA_DIR"]?.trim() || "./data");
}

function dbPath(): string {
  return process.env["DATABASE_PATH"]?.trim() || join(dataDir(), "analisador.sqlite");
}

let singleton: DatabaseSync | null = null;

function db(): DatabaseSync {
  if (singleton) return singleton;
  mkdirSync(dataDir(), { recursive: true });
  singleton = new DatabaseSync(dbPath());
  singleton.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  migrate(singleton);
  /*
   * A LIGAÇÃO DA AUTORIZAÇÃO POR ATIVO MORA AQUI porque este é o instante em que
   * o repositório existe — e é o único caminho que o cliente jamais percorre,
   * que é a condição para `assets.ts` continuar sem saber o que é SQLite. Deixar
   * a chamada para um bootstrap externo criaria a pior falha possível: uma
   * função de ligação exportada que ninguém chama, com a tabela criada e a
   * autorização ainda evaporando no reinício.
   *
   * `singleton` já está atribuído acima, então a leitura inicial do store
   * reentra em db() e recebe a conexão pronta em vez de abrir uma segunda.
   */
  bindAssetValidationStore();
  seedT41RegimeAdaptive();
  return singleton;
}

/**
 * Registra a candidata T4.1-REGIME_ADAPTIVE no laboratório, uma única vez.
 *
 * Só INSERE. Se a linha já existe, não toca: `rules_json` de uma candidata em
 * validação é o congelamento contra o qual os números foram medidos, e
 * reescrevê-lo a cada boot apagaria justamente a imutabilidade que dá sentido ao
 * resultado. Mudar a regra exige uma candidata nova, com id novo.
 */
function seedT41RegimeAdaptive(): void {
  const existe = singleton!
    .prepare("SELECT 1 FROM technique_candidates WHERE id=?")
    .get(T41_CANDIDATE_ID);
  if (!existe) upsertTechniqueCandidate(t41Candidate(Date.now()));
  // T4.2-HYBRID_ENTRY: mesmo contrato de imutabilidade — só INSERE, nunca
  // reescreve. O rules_json dela carrega datasetSeen=["MARCO"] e o hash que
  // denuncia qualquer mudanca de parametro pos-congelamento.
  const existeT42 = singleton!
    .prepare("SELECT 1 FROM technique_candidates WHERE id=?")
    .get(T42_CANDIDATE_ID);
  if (!existeT42) upsertTechniqueCandidate(t42Candidate(Date.now()));
}

function migrate(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS live_sessions (
      id TEXT PRIMARY KEY,
      asset TEXT NOT NULL,
      strategy_version TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trading_sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      symbol TEXT NOT NULL,
      trading_date TEXT,
      timeframe TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      technique_version TEXT,
      segment_count INTEGER NOT NULL DEFAULT 0,
      event_count INTEGER NOT NULL DEFAULT 0,
      trade_count INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS segments (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      reason TEXT,
      trading_date TEXT,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES trading_sessions(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS market_events (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      segment_id TEXT,
      timestamp INTEGER NOT NULL,
      market_time TEXT,
      type TEXT NOT NULL,
      direction TEXT,
      price REAL,
      source TEXT,
      model_version TEXT,
      technique_version TEXT,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES trading_sessions(id) ON DELETE SET NULL,
      FOREIGN KEY(segment_id) REFERENCES segments(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS backtest_runs (
      id TEXT PRIMARY KEY,
      strategy_version TEXT NOT NULL,
      asset TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      source_capture_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      backtest_id TEXT,
      session_id TEXT,
      segment_id TEXT,
      origin TEXT NOT NULL,
      symbol TEXT NOT NULL,
      trading_date TEXT,
      timeframe TEXT NOT NULL,
      direction TEXT NOT NULL,
      setup TEXT NOT NULL,
      strategy_version TEXT NOT NULL,
      opened_at INTEGER NOT NULL,
      closed_at INTEGER NOT NULL,
      result_r REAL NOT NULL,
      entry REAL,
      stop REAL,
      partial REAL,
      target REAL,
      entry_hit_at INTEGER,
      partial_hit_at INTEGER,
      exit_at INTEGER,
      exit_reason TEXT,
      mfe REAL,
      mae REAL,
      ambiguous_intrabar INTEGER NOT NULL DEFAULT 0,
      quality TEXT,
      trend_strength TEXT,
      position_vs_trend TEXT,
      pullback_type TEXT,
      impulse_strength REAL,
      location TEXT,
      trigger_candle TEXT,
      t4_number_in_move INTEGER,
      volatility_level TEXT,
      stop_distance_points REAL,
      result_brl REAL,
      costs_brl REAL,
      slippage_points REAL,
      print_url TEXT,
      analysis_text TEXT,
      classified_at INTEGER,
      dna_id TEXT,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(backtest_id) REFERENCES backtest_runs(id) ON DELETE CASCADE,
      FOREIGN KEY(session_id) REFERENCES trading_sessions(id) ON DELETE SET NULL,
      FOREIGN KEY(segment_id) REFERENCES segments(id) ON DELETE SET NULL
    );

    -- ATENÇÃO: os índices das colunas de DNA NÃO podem viver aqui. Este bloco
    -- roda ANTES de migrateTradeAuditColumns(), que é quem adiciona essas
    -- colunas a bancos já existentes — e CREATE INDEX IF NOT EXISTS sobre
    -- coluna inexistente LANÇA ("no such column: quality"), derrubando migrate()
    -- e, com ele, todos os endpoints /api/trading/*. Banco novo mascarava o
    -- defeito porque o CREATE TABLE acima já traz as colunas. Eles são criados
    -- em migrateTradeAuditColumns, depois das colunas.
    CREATE INDEX IF NOT EXISTS idx_trades_strategy_setup ON trades(strategy_version, setup);
    CREATE INDEX IF NOT EXISTS idx_trades_date ON trades(trading_date, opened_at);
    CREATE INDEX IF NOT EXISTS idx_events_session_time ON market_events(session_id, timestamp);

    CREATE TABLE IF NOT EXISTS replay_sessions (
      session_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      strategy_version TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS techniques (
      version TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK(status IN ('PRODUCTION','ARCHIVED')),
      rules_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      promoted_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS technique_candidates (
      id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      base_version TEXT NOT NULL,
      hypothesis TEXT NOT NULL,
      status TEXT NOT NULL,
      rules_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS validation_results (
      id TEXT PRIMARY KEY,
      candidate_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(candidate_id) REFERENCES technique_candidates(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS daily_learning_reports (
      id TEXT PRIMARY KEY,
      trading_date TEXT NOT NULL,
      base_version TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_daily_learning_date ON daily_learning_reports(trading_date, created_at);

    -- DNA DE DETECÇÕES: toda T4 detectada, COM ou SEM operação. Setups
    -- descartados e prints também viram dado mensurável — a estatística de
    -- "quantas A+ apareceram" não pode contar só as que executaram.
    CREATE TABLE IF NOT EXISTS setup_dna (
      id TEXT PRIMARY KEY,
      origin TEXT NOT NULL,
      source_id TEXT NOT NULL,
      print_id TEXT,
      trade_id TEXT,
      asset TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      direction TEXT NOT NULL,
      detected_at INTEGER NOT NULL,
      trading_date TEXT,
      hour INTEGER,
      technique_version TEXT NOT NULL,
      grade TEXT NOT NULL,
      trend TEXT NOT NULL,
      position TEXT NOT NULL,
      pullback TEXT NOT NULL,
      pullback_depth REAL,
      pullback_bars INTEGER,
      impulse_points REAL,
      impulse_r REAL,
      location TEXT NOT NULL,
      location_detail TEXT,
      trigger_candle TEXT NOT NULL,
      movement_ordinal INTEGER,
      volatility TEXT,
      volatility_ratio REAL,
      stop_distance_points REAL,
      rr_available REAL,
      entry REAL,
      stop REAL,
      targets_json TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_setup_dna_date ON setup_dna(trading_date, detected_at);
    CREATE INDEX IF NOT EXISTS idx_setup_dna_grade ON setup_dna(grade, direction);
    CREATE INDEX IF NOT EXISTS idx_setup_dna_trade ON setup_dna(trade_id);

    -- REGISTRO DE EXPERIMENTOS: quantas variações foram testadas sobre cada
    -- versão-base. É o denominador da proteção contra overfitting — testar
    -- vinte filtros e mostrar só o melhor deixa rastro aqui.
    CREATE TABLE IF NOT EXISTS lab_experiments (
      id TEXT PRIMARY KEY,
      base_version TEXT NOT NULL,
      candidate_id TEXT,
      hypothesis TEXT NOT NULL,
      variation_json TEXT NOT NULL,
      dataset_id TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(candidate_id) REFERENCES technique_candidates(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lab_experiments_base ON lab_experiments(base_version, created_at);

    -- DATASETS NOMEADOS: treino, validação e fora-da-amostra são recortes
    -- DECLARADOS de datas, não uma convenção implícita que cada análise
    -- refaz do seu jeito. A coluna frozen impede o recorte de mudar depois de usado.
    CREATE TABLE IF NOT EXISTS datasets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('TREINO','VALIDACAO','OOS')),
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      trade_count INTEGER NOT NULL DEFAULT 0,
      frozen INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    -- MEMÓRIA T4 (19/08): todo print analisado vira caso persistente. A
    -- imagem vai para DATA_DIR/prints/{id}.jpg (nunca base64 em banco/código);
    -- aqui ficam a análise validada e a referência.
    CREATE TABLE IF NOT EXISTS prints (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      asset TEXT NOT NULL,
      timeframe TEXT,
      captured_at INTEGER NOT NULL,
      image_path TEXT,
      status TEXT NOT NULL,
      direction TEXT NOT NULL,
      confidence INTEGER NOT NULL,
      current_price REAL,
      dna_id TEXT,
      capture_code TEXT,
      analysis_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_prints_asset_time ON prints(asset, captured_at);

    -- Previsões com critério PRÉ-definido (stop e alvo legíveis no instante).
    -- O veredito fecha sozinho pelas observações de preço dos prints
    -- seguintes — previsão sem resultado não ensina nada.
    CREATE TABLE IF NOT EXISTS print_predictions (
      print_id TEXT PRIMARY KEY,
      asset TEXT NOT NULL,
      direction TEXT NOT NULL,
      predicted_at INTEGER NOT NULL,
      entry REAL,
      stop REAL,
      target REAL,
      price_at_prediction REAL,
      verdict TEXT NOT NULL DEFAULT 'PENDENTE',
      ambiguous INTEGER NOT NULL DEFAULT 0,
      detail TEXT,
      resolved_at INTEGER,
      dna_id TEXT,
      FOREIGN KEY(print_id) REFERENCES prints(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_predictions_pending ON print_predictions(asset, verdict);

    -- SETUPS PERSISTENTES (§21): a máquina de setup vive no NAVEGADOR
    -- (setupTracker.ts). Sem esta cópia servidora, reiniciar o backend perdia o
    -- setup ativo e um setup CONFIRMADO nunca fechava sozinho. O desfecho é
    -- fechado por sweepSetupOutcomes() contra as MESMAS etiquetas de preço que
    -- os vereditos de previsão usam (prints.current_price, amostras de 60s).
    -- Os ÍNDICES desta tabela ficam em migrateSetupsSchema(), depois da checagem
    -- de colunas — nunca aqui (ver a nota dos índices de trades acima).
    CREATE TABLE IF NOT EXISTS setups (
      setup_id TEXT PRIMARY KEY,
      asset TEXT NOT NULL,
      timeframe TEXT,
      direction TEXT NOT NULL,
      stage TEXT NOT NULL,
      entry REAL,
      stop REAL,
      target REAL,
      entry_zone_min REAL,
      entry_zone_max REAL,
      confirmed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER,
      outcome TEXT NOT NULL DEFAULT 'ABERTO'
        CHECK(outcome IN ('ABERTO','WIN','LOSS','EXPIRADO','INVALIDADO')),
      outcome_at INTEGER,
      outcome_reason TEXT,
      ambiguous INTEGER NOT NULL DEFAULT 0,
      dna_id TEXT,
      print_id TEXT,
      learned INTEGER NOT NULL DEFAULT 0,
      -- §32/§34: o que a máquina precisa reencontrar depois de um F5.
      -- Defaults CONSERVADORES: nenhum rompimento observado, nada sustentado.
      trigger_level REAL,
      trigger_version INTEGER NOT NULL DEFAULT 1,
      trigger_history_json TEXT,
      breakout_json TEXT,
      operation_released INTEGER NOT NULL DEFAULT 0
    );

    -- T4 AUTO RESEARCH: candles importados de CSV (Profit/Nelogica) e as
    -- execuções de pesquisa com métricas/OOS/walk-forward/Monte Carlo.
    CREATE TABLE IF NOT EXISTS imported_candles (
      dataset_id TEXT NOT NULL,
      t INTEGER NOT NULL,
      o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL,
      v REAL NOT NULL DEFAULT 0,
      PRIMARY KEY(dataset_id, t)
    );
    CREATE TABLE IF NOT EXISTS research_runs (
      id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      asset TEXT NOT NULL,
      technique_version TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      metrics_json TEXT NOT NULL,
      status TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recording_sessions (
      session_id TEXT PRIMARY KEY,
      live_session_id TEXT,
      asset TEXT,
      mime_type TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      status TEXT NOT NULL,
      segment INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      recorder_state TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recording_chunks (
      session_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      segment INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL,
      mime_type TEXT,
      size INTEGER NOT NULL,
      status TEXT NOT NULL,
      file_path TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(session_id, idx),
      FOREIGN KEY(session_id) REFERENCES recording_sessions(session_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS recording_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      real_timestamp INTEGER NOT NULL,
      chart_timestamp INTEGER,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES recording_sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_recording_events_session ON recording_events(session_id, real_timestamp);

    CREATE TABLE IF NOT EXISTS error_events (
      id TEXT PRIMARY KEY,
      group_key TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      severity TEXT NOT NULL,
      source TEXT NOT NULL,
      route TEXT,
      message TEXT NOT NULL,
      stack TEXT,
      context_json TEXT,
      session_id TEXT,
      signal_id TEXT,
      resolved INTEGER NOT NULL DEFAULT 0,
      occurrences INTEGER NOT NULL DEFAULT 1,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_error_events_group ON error_events(group_key);
    CREATE INDEX IF NOT EXISTS idx_error_events_seen ON error_events(last_seen);

    CREATE TABLE IF NOT EXISTS admin_changes (
      change_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      files_json TEXT NOT NULL,
      tests_json TEXT,
      updated_at INTEGER NOT NULL
    );

    /*
     * AUTORIZAÇÃO DE PRODUÇÃO POR ATIVO (migration 008).
     *
     * A liberação de um ativo morava num Map em src/lib/t4/assets.ts: reiniciar
     * o servidor devolvia o WIN ao estado semeado e a autorização conquistada
     * sumia sem deixar registro de que existiu.
     *
     * APPEND-ONLY de propósito: concessão e revogação são LINHAS, e o evento
     * anterior é encerrado com revoked_at em vez de apagado. Revogar por DELETE
     * destruiria a prova de que a permissão existiu e de quando caiu.
     * Vigente = revoked_at IS NULL.
     *
     * O CHECK é a última linha de defesa contra a permissão eterna: liberar
     * produção sem versão da técnica ou sem referência de evidência é recusado
     * pelo próprio banco, não só pelo código que costuma chamar.
     */
    CREATE TABLE IF NOT EXISTS asset_authorizations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK(status IN ('VALIDATED_FOR_PRODUCTION','IN_VALIDATION','LAB_ONLY')),
      technique_version TEXT,
      evidence_ref TEXT,
      granted_at INTEGER NOT NULL,
      granted_by TEXT NOT NULL,
      revoked_at INTEGER,
      CHECK(
        status <> 'VALIDATED_FOR_PRODUCTION'
        OR (technique_version IS NOT NULL AND evidence_ref IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS idx_asset_auth_symbol ON asset_authorizations(symbol, granted_at);
    CREATE INDEX IF NOT EXISTS idx_asset_auth_active ON asset_authorizations(revoked_at, symbol);

    /*
     * VALIDACOES OPENAI POR CAPTURA (migration 009).
     *
     * Cada print validado pela IA vira UMA linha, e a linha nunca e reescrita:
     * a chave (image_hash, candle_time) faz o reprocessamento do mesmo print
     * ser idempotente — INSERT OR IGNORE, historico intacto. Reprocessar um
     * replay nao pode reescrever o que a IA disse na primeira vez, porque e
     * exatamente essa trilha que a auditoria do Sol le depois.
     *
     * luna_json/terra_json NULL significam "nao houve resposta valida" —
     * distinto de string vazia, e distinto de nao-chamado (status diz qual).
     */
    CREATE TABLE IF NOT EXISTS ai_validations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      image_hash TEXT NOT NULL,
      capture_id TEXT NOT NULL,
      candle_time INTEGER NOT NULL,
      t4_decision_json TEXT NOT NULL,
      luna_json TEXT,
      terra_json TEXT,
      latency_ms INTEGER NOT NULL,
      tokens INTEGER NOT NULL,
      cost_usd REAL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(image_hash, candle_time)
    );
    CREATE INDEX IF NOT EXISTS idx_ai_validations_candle ON ai_validations(candle_time);
  `);
  migrateTradeAuditColumns(database);
  migrateSetupsSchema(database);
  migrateTradesDedup(database);
  database
    .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
    .run(SCHEMA_VERSION, Date.now());
  const now = Date.now();
  const current = database
    .prepare(
      "SELECT version FROM techniques WHERE status='PRODUCTION' ORDER BY promoted_at DESC, created_at DESC LIMIT 1",
    )
    .get() as { version: string } | undefined;
  if (current?.version !== STRATEGY_VERSION) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare("UPDATE techniques SET status='ARCHIVED' WHERE status='PRODUCTION'").run();
      database
        .prepare(
          `
        INSERT INTO techniques(version, status, rules_json, created_at, promoted_at)
        VALUES (?, 'PRODUCTION', ?, ?, ?)
        ON CONFLICT(version) DO UPDATE SET status='PRODUCTION', rules_json=excluded.rules_json, promoted_at=excluded.promoted_at
      `,
        )
        .run(STRATEGY_VERSION, JSON.stringify(T4_PROFILE), now, now);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } else {
    /*
     * INSERT-IF-ABSENT, NUNCA REESCRITA (auditoria sênior, B7). O UPDATE que
     * vivia aqui regravava o rules_json de PRODUÇÃO a cada boot com o
     * T4_PROFILE do código — o registro congelado que dá sentido a "técnica
     * versionada" era sobrescrito em silêncio. Mudar regra exige VERSÃO nova
     * (o ramo acima arquiva e insere); divergência sem versão nova fica
     * DECLARADA no log e o registro gravado permanece intocado.
     */
    const gravada = database
      .prepare("SELECT rules_json FROM techniques WHERE version=?")
      .get(STRATEGY_VERSION) as { rules_json: string } | undefined;
    if (gravada && gravada.rules_json !== JSON.stringify(T4_PROFILE)) {
      console.warn(
        `[migrate] rules_json de ${STRATEGY_VERSION} DIVERGE do T4_PROFILE do código e NÃO será reescrito — mudar regra exige promover uma versão nova.`,
      );
    }
  }
}

function migrateTradeAuditColumns(database: DatabaseSync): void {
  const existing = new Set(
    (database.prepare("PRAGMA table_info(trades)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  const additions: Array<[string, string]> = [
    ["entry", "REAL"],
    ["stop", "REAL"],
    ["partial", "REAL"],
    ["target", "REAL"],
    ["entry_hit_at", "INTEGER"],
    ["partial_hit_at", "INTEGER"],
    ["exit_at", "INTEGER"],
    ["exit_reason", "TEXT"],
    ["mfe", "REAL"],
    ["mae", "REAL"],
    ["ambiguous_intrabar", "INTEGER NOT NULL DEFAULT 0"],
    // DNA T4 Completo - campos consultáveis para análise estatística
    ["quality", "TEXT"],
    ["trend_strength", "TEXT"],
    ["position_vs_trend", "TEXT"],
    ["pullback_type", "TEXT"],
    ["impulse_strength", "REAL"],
    ["location", "TEXT"],
    ["trigger_candle", "TEXT"],
    ["t4_number_in_move", "INTEGER"],
    ["volatility_level", "TEXT"],
    ["stop_distance_points", "REAL"],
    ["result_brl", "REAL"],
    ["costs_brl", "REAL"],
    ["slippage_points", "REAL"],
    ["print_url", "TEXT"],
    ["analysis_text", "TEXT"],
    ["classified_at", "INTEGER"],
    ["dna_id", "TEXT"],
  ];
  for (const [name, type] of additions) {
    if (!existing.has(name)) database.exec(`ALTER TABLE trades ADD COLUMN ${name} ${type}`);
  }

  // Índices para segmentação (criados apenas se não existirem)
  const indices: Array<[string, string]> = [
    ["idx_trades_quality", "trades(quality)"],
    ["idx_trades_trend", "trades(trend_strength, position_vs_trend)"],
    ["idx_trades_pullback", "trades(pullback_type)"],
    ["idx_trades_location", "trades(location)"],
    ["idx_trades_volatility", "trades(volatility_level)"],
  ];
  for (const [name, target] of indices) {
    database.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${target}`);
  }
}

/**
 * MIGRATION 010 — O MESMO EVENTO NÃO VIRA DUAS LINHAS (auditoria sênior, B4).
 *
 * O DEFEITO MEDIDO: cada replay do mesmo material criava ids de sessão novos
 * (relógio da máquina), e os MESMOS trades entravam de novo sob outro
 * backtest_id — N crescia a cada reexecução, e a estatística "melhorava" sem
 * nenhum trade novo existir. A identidade REAL de um trade é o evento de
 * mercado: (trading_date, opened_at, direction, setup).
 *
 * A ordem importa e é irreversível de propósito:
 *   1. DEDUP primeiro — mantém a linha MAIS ANTIGA (MIN(rowid), o registro
 *      original; os removidos são as cópias de replay). Sem isso o CREATE
 *      UNIQUE INDEX lançaria num banco já contaminado.
 *   2. Índice único depois — daqui em diante o banco RECUSA a segunda linha
 *      do mesmo evento; o `upsertBacktest` trata o conflito explicitamente.
 *
 * `trading_date IS NOT NULL` nos dois passos, alinhado à semântica do índice:
 * SQLite trata NULL como distinto em UNIQUE, então linha sem data não é
 * dedupável pelo índice — dedupá-la aqui criaria uma regra que o banco não
 * sustenta depois. Linha sem data é dado degradado e fica declarada como está.
 */
function migrateTradesDedup(database: DatabaseSync): void {
  database.exec(`
    DELETE FROM trades WHERE trading_date IS NOT NULL AND rowid NOT IN (
      SELECT MIN(rowid) FROM trades WHERE trading_date IS NOT NULL
      GROUP BY trading_date, opened_at, direction, setup
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_evento_unico
      ON trades(trading_date, opened_at, direction, setup);
  `);
}

/**
 * Colunas e índices dos SETUPS — e o metadado dos passes no print.
 *
 * Roda DEPOIS do bloco de schema, e nesta ordem por um motivo caro: um banco
 * ANTIGO tem a tabela `prints` sem `passes_json`, e um `CREATE INDEX` (ou
 * qualquer referência) a coluna inexistente LANÇA e derruba `migrate()` inteiro
 * — com ele, todos os endpoints /api/trading/*. Banco novo mascara o defeito
 * porque o CREATE TABLE já nasce completo. Coluna primeiro, índice depois,
 * sempre.
 */
function migrateSetupsSchema(database: DatabaseSync): void {
  const columnsOf = (table: string): Set<string> =>
    new Set(
      (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );

  // METADADO DOS 2 PASSES DO AUTO-CROP (§13): motivo do 2º passe, escolha e
  // score de cada leitura. Só metadado — não duplica aprendizado nem cria um
  // segundo registro de print.
  if (!columnsOf("prints").has("passes_json")) {
    database.exec("ALTER TABLE prints ADD COLUMN passes_json TEXT");
  }

  /*
   * REPAROS DECLARADOS — a declaração precisa SOBREVIVER à aba.
   *
   * A casa exige que todo reparo da validação seja dito, nunca silencioso.
   * Ele era dito — no navegador, e morria com a sessão. Em 20/08/2026 isso
   * custou uma investigação: com `lastClosedCandle` ausente em 25 de 25
   * análises reais, não deu para separar "o modelo devolveu null" de "o
   * reparo anulou porque o modelo mandou o candle ATUAL disfarçado". As duas
   * hipóteses pedem correções opostas, e o dado que as separava tinha sido
   * descartado.
   *
   * Um reparo que ninguém consegue ler depois é um reparo silencioso com
   * etapas extras.
   */
  if (!columnsOf("prints").has("repairs_json")) {
    database.exec("ALTER TABLE prints ADD COLUMN repairs_json TEXT");
  }

  /*
   * A tabela `setups` nasce completa no bloco de schema, mas a checagem fica
   * aqui de propósito: quando uma coluna nova for exigida amanhã, ela entra
   * NESTA lista e o banco de produção sobrevive ao upgrade. Colunas com NOT
   * NULL só entram com DEFAULT — ALTER TABLE em tabela com linhas não aceita
   * NOT NULL sem valor.
   */
  const setupColumns = columnsOf("setups");
  const additions: Array<[string, string]> = [
    ["timeframe", "TEXT"],
    ["entry_zone_min", "REAL"],
    ["entry_zone_max", "REAL"],
    ["expires_at", "INTEGER"],
    ["outcome", "TEXT NOT NULL DEFAULT 'ABERTO'"],
    ["outcome_at", "INTEGER"],
    ["outcome_reason", "TEXT"],
    ["ambiguous", "INTEGER NOT NULL DEFAULT 0"],
    ["dna_id", "TEXT"],
    ["print_id", "TEXT"],
    ["learned", "INTEGER NOT NULL DEFAULT 0"],
    /*
     * §32/§34 — MEMÓRIA DO GATILHO E DO ROMPIMENTO.
     *
     * Todas com DEFAULT porque a tabela do operador já tem linhas: um setup
     * gravado antes deste upgrade volta como "nenhum rompimento observado",
     * que é a leitura conservadora. Um default otimista aqui faria nascer
     * permissão de operar de um ALTER TABLE.
     *
     * O rompimento vai como JSON, e não em dez colunas: ele é um objeto do
     * domínio (BreakoutState) que muda junto com a regra, e espalhá-lo em
     * colunas obrigaria uma migração a cada ajuste da máquina.
     */
    ["trigger_level", "REAL"],
    ["trigger_version", "INTEGER NOT NULL DEFAULT 1"],
    ["trigger_history_json", "TEXT"],
    ["breakout_json", "TEXT"],
    ["operation_released", "INTEGER NOT NULL DEFAULT 0"],
  ];
  for (const [name, type] of additions) {
    if (!setupColumns.has(name)) database.exec(`ALTER TABLE setups ADD COLUMN ${name} ${type}`);
  }

  /*
   * VOCABULÁRIO DE ESTÁGIO — CONVERTIDO NO LUGAR, SEM APAGAR LINHA.
   *
   * O banco do operador tem setups gravados com os nomes em português da
   * máquina antiga (OBSERVANDO, PREPARADO, CONFIRMADO…). A leitura já os
   * traduzia em memória (`normalizeStage`), e por isso nada quebrava — mas
   * qualquer consulta feita direto no banco, por ativo ou por estágio, via
   * dois vocabulários para o mesmo estado. É o defeito do §8 aplicado ao
   * próprio armazenamento.
   *
   * UPDATE e não recriação da tabela: os setups do operador continuam onde
   * estão, com id, histórico e desfecho intactos. Idempotente por construção —
   * rodar de novo não acha mais nada para converter.
   *
   * O MAPA É O MESMO de `normalizeStage`, transcrito aqui porque o repositório
   * é `node:sqlite` puro e não importa domínio. Se um dia divergirem, quem
   * manda é o de lá: este só alcança linha antiga, uma vez.
   */
  const estagiosAntigos: Array<[string, string]> = [
    ["SEM_SETUP", "NONE"],
    ["OBSERVANDO", "DETECTED"],
    ["APROXIMACAO", "WAITING_BREAKOUT"],
    ["FORMACAO", "FORMING"],
    ["PREPARADO", "WAITING_BREAKOUT"],
    ["CONFIRMADO", "CONFIRMED"],
    ["ENCERRADO", "CLOSED"],
    ["INVALIDADO", "INVALIDATED"],
    ["EXPIRADO", "EXPIRED"],
  ];
  const converter = database.prepare("UPDATE setups SET stage = ? WHERE stage = ?");
  for (const [antigo, novo] of estagiosAntigos) converter.run(novo, antigo);

  const indices: Array<[string, string]> = [
    ["idx_setups_asset_outcome", "setups(asset, outcome)"],
    ["idx_setups_learn", "setups(outcome, learned)"],
  ];
  for (const [name, target] of indices) {
    database.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${target}`);
  }
}

function parse<T>(raw: unknown): T {
  return JSON.parse(String(raw)) as T;
}

function payloadRows<T>(sql: string): T[] {
  return db()
    .prepare(sql)
    .all()
    .map((row) => parse<T>((row as { payload_json: string }).payload_json));
}

export interface PersistentSnapshot {
  liveSessions: LiveSessionRecord[];
  tradingSessions: TradingSessionRecord[];
  backtests: BacktestRecord[];
  replaySessions: ReplayRecordingRecord[];
  lastDecision: unknown | null;
  productionTechnique: TechniqueRecord | null;
  techniqueCandidates: TechniqueCandidateRecord[];
  dailyLearningReports: DailyLearningReport[];
}

export function getSnapshot(): PersistentSnapshot {
  const database = db();
  const decision = database
    .prepare("SELECT payload_json FROM app_state WHERE key='last_decision'")
    .get() as { payload_json: string } | undefined;
  return {
    liveSessions: payloadRows<LiveSessionRecord>(
      "SELECT payload_json FROM live_sessions ORDER BY started_at ASC LIMIT 500",
    ),
    tradingSessions: payloadRows<TradingSessionRecord>(
      "SELECT payload_json FROM trading_sessions ORDER BY started_at ASC LIMIT 2000",
    ),
    backtests: payloadRows<BacktestRecord>(
      "SELECT payload_json FROM backtest_runs ORDER BY created_at ASC LIMIT 1000",
    ),
    replaySessions: payloadRows<ReplayRecordingRecord>(
      "SELECT payload_json FROM replay_sessions ORDER BY created_at ASC LIMIT 1000",
    ),
    lastDecision: decision ? parse(decision.payload_json) : null,
    productionTechnique: getProductionTechnique(),
    techniqueCandidates: listTechniqueCandidates(),
    dailyLearningReports: listDailyLearningReports(),
  };
}

export function upsertLiveSession(record: LiveSessionRecord): void {
  db()
    .prepare(
      `
    INSERT INTO live_sessions(id, asset, strategy_version, started_at, ended_at, status, payload_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      asset=excluded.asset, strategy_version=excluded.strategy_version, started_at=excluded.started_at,
      ended_at=excluded.ended_at, status=excluded.status, payload_json=excluded.payload_json,
      updated_at=excluded.updated_at
  `,
    )
    .run(
      record.id,
      record.asset,
      record.strategyVersion,
      record.startedAt,
      record.endedAt,
      record.status,
      JSON.stringify(record),
      Date.now(),
    );
}

export function upsertTradingSession(record: TradingSessionRecord): void {
  db()
    .prepare(
      `
    INSERT INTO trading_sessions(
      id, source, symbol, trading_date, timeframe, started_at, ended_at, technique_version,
      segment_count, event_count, trade_count, payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      source=excluded.source, symbol=excluded.symbol, trading_date=excluded.trading_date,
      timeframe=excluded.timeframe, started_at=excluded.started_at, ended_at=excluded.ended_at,
      technique_version=excluded.technique_version, segment_count=excluded.segment_count,
      event_count=excluded.event_count, trade_count=excluded.trade_count,
      payload_json=excluded.payload_json, updated_at=excluded.updated_at
  `,
    )
    .run(
      record.id,
      record.source,
      record.symbol,
      record.tradingDate,
      record.timeframe,
      record.startedAt,
      record.endedAt,
      record.techniqueVersion ?? null,
      record.segmentCount,
      record.eventCount,
      record.tradeCount,
      JSON.stringify(record),
      record.createdAt,
      Date.now(),
    );
}

export function upsertSegment(record: SegmentRecord): void {
  db()
    .prepare(
      `
    INSERT INTO segments(id, session_id, started_at, ended_at, reason, trading_date, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      session_id=excluded.session_id, started_at=excluded.started_at, ended_at=excluded.ended_at,
      reason=excluded.reason, trading_date=excluded.trading_date, payload_json=excluded.payload_json
  `,
    )
    .run(
      record.id,
      record.sessionId,
      record.startedAt,
      record.endedAt,
      record.reason,
      record.tradingDate,
      JSON.stringify(record),
      record.createdAt,
    );
}

export function upsertReplaySession(record: ReplayRecordingRecord): void {
  db()
    .prepare(
      `
    INSERT INTO replay_sessions(session_id, created_at, symbol, timeframe, strategy_version, payload_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET payload_json=excluded.payload_json, updated_at=excluded.updated_at
  `,
    )
    .run(
      record.sessionId,
      record.createdAt,
      record.symbol,
      record.timeframe,
      record.strategyVersion,
      JSON.stringify(record),
      Date.now(),
    );
}

export function upsertBacktest(record: BacktestRecord): void {
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `
      INSERT INTO backtest_runs(id, strategy_version, asset, timeframe, source_capture_id, origin, created_at, payload_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        strategy_version=excluded.strategy_version, asset=excluded.asset, timeframe=excluded.timeframe,
        source_capture_id=excluded.source_capture_id, origin=excluded.origin,
        payload_json=excluded.payload_json, updated_at=excluded.updated_at
    `,
      )
      .run(
        record.id,
        record.strategyVersion,
        record.asset,
        record.timeframe,
        record.sourceCaptureId,
        record.origin,
        record.createdAt,
        JSON.stringify(record),
        Date.now(),
      );
    database.prepare("DELETE FROM trades WHERE backtest_id=?").run(record.id);
    /*
     * CONFLITO EXPLÍCITO, NUNCA ROLLBACK MUDO (auditoria sênior, B4).
     *
     * Antes, o INSERT sem ON CONFLICT tinha dois finais ruins: o mesmo trade
     * reimportado por uma corrida nova (id determinístico `trade_{t}_{fim}`)
     * estourava a PK e o ROLLBACK descartava o upsert INTEIRO; e um trade
     * antigo com id de relógio duplicava o mesmo evento sob outro id.
     *
     * Agora cada conflito tem um destino declarado:
     *   - MESMO id (o mesmo trade, reimportado): a corrida nova RECLAMA a
     *     linha — atualiza vínculos e classificação; N não cresce.
     *   - MESMO EVENTO com id diferente (linha legada de id de relógio): a
     *     linha ORIGINAL fica, a cópia é recusada em silêncio declarado
     *     (DO NOTHING) — o índice `idx_trades_evento_unico` é quem garante.
     */
    const insert = database.prepare(`
      INSERT INTO trades(
        id, backtest_id, session_id, segment_id, origin, symbol, trading_date, timeframe,
        direction, setup, strategy_version, opened_at, closed_at, result_r,
        entry, stop, partial, target, entry_hit_at, partial_hit_at, exit_at, exit_reason, mfe, mae,
        ambiguous_intrabar, payload_json, created_at,
        quality, trend_strength, position_vs_trend, pullback_type, impulse_strength,
        location, trigger_candle, t4_number_in_move, volatility_level, stop_distance_points,
        result_brl, costs_brl, slippage_points, print_url, analysis_text, classified_at, dna_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        backtest_id=excluded.backtest_id, session_id=excluded.session_id,
        segment_id=excluded.segment_id, origin=excluded.origin,
        trading_date=excluded.trading_date, closed_at=excluded.closed_at,
        result_r=excluded.result_r, entry=excluded.entry, stop=excluded.stop,
        partial=excluded.partial, target=excluded.target,
        entry_hit_at=excluded.entry_hit_at, partial_hit_at=excluded.partial_hit_at,
        exit_at=excluded.exit_at, exit_reason=excluded.exit_reason,
        mfe=excluded.mfe, mae=excluded.mae,
        ambiguous_intrabar=excluded.ambiguous_intrabar,
        payload_json=excluded.payload_json,
        quality=excluded.quality, trend_strength=excluded.trend_strength,
        position_vs_trend=excluded.position_vs_trend, pullback_type=excluded.pullback_type,
        impulse_strength=excluded.impulse_strength, location=excluded.location,
        trigger_candle=excluded.trigger_candle, t4_number_in_move=excluded.t4_number_in_move,
        volatility_level=excluded.volatility_level,
        stop_distance_points=excluded.stop_distance_points,
        result_brl=excluded.result_brl, costs_brl=excluded.costs_brl,
        slippage_points=excluded.slippage_points, print_url=excluded.print_url,
        analysis_text=excluded.analysis_text, classified_at=excluded.classified_at,
        dna_id=excluded.dna_id
      ON CONFLICT(trading_date, opened_at, direction, setup) DO NOTHING
    `);
    for (const trade of record.trades) {
      insert.run(
        trade.id,
        record.id,
        trade.tradingSessionId ?? null,
        trade.segmentId ?? null,
        trade.origin,
        trade.asset,
        trade.tradingDate ?? null,
        trade.timeframe,
        trade.direction,
        trade.setup,
        trade.strategyVersion,
        trade.openedAt,
        trade.closedAt,
        trade.rMultiple,
        trade.entry,
        trade.stop,
        trade.target1,
        trade.target2,
        trade.entryHitAt ?? null,
        trade.partialHitAt ?? null,
        trade.exitAt ?? trade.closedAt,
        trade.exitReason ?? null,
        trade.mfePoints,
        trade.maePoints,
        trade.ambiguousIntrabar ? 1 : 0,
        JSON.stringify(trade),
        Date.now(),
        trade.quality ?? null,
        trade.trendStrength ?? null,
        trade.positionVsTrend ?? null,
        trade.pullbackType ?? null,
        trade.impulseStrength ?? null,
        trade.location ?? null,
        trade.triggerCandle ?? null,
        trade.t4NumberInMove ?? null,
        trade.volatilityLevel ?? null,
        trade.stopDistancePoints ?? null,
        trade.resultBrl ?? null,
        trade.costsBrl ?? null,
        trade.slippagePoints ?? null,
        trade.printUrl ?? null,
        trade.analysisText ?? null,
        trade.classifiedAt ?? null,
        trade.dnaId ?? null,
      );
    }
    // Detecção ↔ operação: o DNA registrado no armamento passa a apontar
    // para o trade que nasceu dele. Só preenche vazio — nunca reescreve um
    // vínculo existente para outro trade.
    const link = database.prepare(
      "UPDATE setup_dna SET trade_id=? WHERE id=? AND (trade_id IS NULL OR trade_id=?)",
    );
    for (const trade of record.trades) {
      if (trade.dnaId) link.run(trade.id, trade.dnaId, trade.id);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function saveLastDecision(value: unknown): void {
  db()
    .prepare(
      `
    INSERT INTO app_state(key, payload_json, updated_at) VALUES ('last_decision', ?, ?)
    ON CONFLICT(key) DO UPDATE SET payload_json=excluded.payload_json, updated_at=excluded.updated_at
  `,
    )
    .run(JSON.stringify(value), Date.now());
}

export function upsertMarketEvent(event: MarketEventRecord): void {
  const eventId = event.id ?? event.eventId;
  if (!eventId) throw new Error("Evento sem identificador persistente.");
  db()
    .prepare(
      `
    INSERT INTO market_events(
      id, session_id, segment_id, timestamp, market_time, type, direction, price,
      source, model_version, technique_version, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json
  `,
    )
    .run(
      eventId,
      event.sessionId ?? null,
      event.segmentId ?? null,
      event.timestamp,
      event.marketTime ?? null,
      event.type,
      event.direction ?? null,
      event.price ?? null,
      event.source ?? null,
      event.modelVersion ?? null,
      event.techniqueVersion ?? null,
      JSON.stringify(event),
      Date.now(),
    );
}

export function getProductionTechnique(): TechniqueRecord | null {
  const row = db()
    .prepare(
      "SELECT version, status, rules_json, created_at, promoted_at FROM techniques WHERE status='PRODUCTION' ORDER BY promoted_at DESC, created_at DESC LIMIT 1",
    )
    .get() as
    | {
        version: string;
        status: "PRODUCTION";
        rules_json: string;
        created_at: number;
        promoted_at: number | null;
      }
    | undefined;
  if (!row) return null;
  return {
    version: row.version,
    status: row.status,
    rules: parse<Record<string, unknown>>(row.rules_json),
    createdAt: row.created_at,
    promotedAt: row.promoted_at,
  };
}

export function listTechniqueCandidates(): TechniqueCandidateRecord[] {
  const rows = db()
    .prepare(
      "SELECT id, version, base_version, hypothesis, status, rules_json, created_at, updated_at FROM technique_candidates ORDER BY created_at DESC LIMIT 500",
    )
    .all() as Array<{
    id: string;
    version: string;
    base_version: string;
    hypothesis: string;
    status: TechniqueCandidateRecord["status"];
    rules_json: string;
    created_at: number;
    updated_at: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    version: row.version,
    baseVersion: row.base_version,
    hypothesis: row.hypothesis,
    status: row.status,
    rules: parse<Record<string, unknown>>(row.rules_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/**
 * CONGELAMENTO VERIFICÁVEL NA LEITURA (auditoria sênior, B7).
 *
 * O hash gravado com a candidata T4.2 só vale alguma coisa se ALGUÉM o
 * recalcular: esta função lê o registro REAL do banco e delega a conta a
 * `conferirCongelamentoT42` (adulteração do gravado + deriva do código).
 * Consumidores: a listagem de candidatas (GET), a promoção e o portão de
 * dataset (OOS não abre sem `ok:true`).
 */
export function verifyT42Freeze(): VereditoDoCongelamento {
  const row = db()
    .prepare("SELECT rules_json FROM technique_candidates WHERE id=?")
    .get(T42_CANDIDATE_ID) as { rules_json: string } | undefined;
  if (!row) {
    return conferirCongelamentoT42(null);
  }
  return conferirCongelamentoT42(parse<Record<string, unknown>>(row.rules_json));
}

/**
 * Os meses que a candidata T4.2 declarou como VISTOS no congelamento —
 * lidos do REGISTRO, nunca redigitados (B9: datasetSeen deixa de ser
 * escrita morta e passa a alimentar o gate de abertura de dataset).
 */
export function t42DatasetSeen(): string[] {
  const row = db()
    .prepare("SELECT rules_json FROM technique_candidates WHERE id=?")
    .get(T42_CANDIDATE_ID) as { rules_json: string } | undefined;
  if (!row) return [];
  const rules = parse<Record<string, unknown>>(row.rules_json);
  const seen = rules?.["datasetSeen"];
  return Array.isArray(seen) ? seen.filter((item): item is string => typeof item === "string") : [];
}

export function upsertTechniqueCandidate(record: TechniqueCandidateRecord): void {
  db()
    .prepare(
      `
    INSERT INTO technique_candidates(id, version, base_version, hypothesis, status, rules_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      version=excluded.version, base_version=excluded.base_version, hypothesis=excluded.hypothesis,
      status=excluded.status, rules_json=excluded.rules_json, updated_at=excluded.updated_at
  `,
    )
    .run(
      record.id,
      record.version,
      record.baseVersion,
      record.hypothesis,
      record.status,
      JSON.stringify(record.rules),
      record.createdAt,
      record.updatedAt,
    );
}

export function promoteTechniqueCandidate(candidateId: string): TechniqueRecord {
  const database = db();
  const candidate = database
    .prepare(
      "SELECT id, version, status, rules_json, created_at FROM technique_candidates WHERE id=?",
    )
    .get(candidateId) as
    | {
        id: string;
        version: string;
        status: TechniqueCandidateRecord["status"];
        rules_json: string;
        created_at: number;
      }
    | undefined;
  if (!candidate) throw new Error("Técnica candidata não encontrada.");
  if (candidate.status !== "VALIDATED") {
    throw new Error("Somente uma candidata VALIDATED pode ser promovida.");
  }
  /*
   * PROMOÇÃO SÓ COM CONGELAMENTO VERIFICADO (B7) — o molde é o portão de
   * NEW_SETUP_04: recalcular o hash antes de qualquer promoção. Para a T4.2,
   * o registro gravado é conferido contra adulteração E contra deriva do
   * código; divergência é bloqueio explícito, nunca warning.
   */
  if (candidate.id === T42_CANDIDATE_ID) {
    const congelamento = verifyT42Freeze();
    if (!congelamento.ok) {
      throw new Error(
        `Promoção BLOQUEADA — congelamento T4.2 não verificado: ${congelamento.motivo}`,
      );
    }
  }
  const now = Date.now();
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("UPDATE techniques SET status='ARCHIVED' WHERE status='PRODUCTION'").run();
    database
      .prepare(
        `
      INSERT INTO techniques(version, status, rules_json, created_at, promoted_at)
      VALUES (?, 'PRODUCTION', ?, ?, ?)
      ON CONFLICT(version) DO UPDATE SET status='PRODUCTION', rules_json=excluded.rules_json, promoted_at=excluded.promoted_at
    `,
      )
      .run(candidate.version, candidate.rules_json, candidate.created_at, now);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return getProductionTechnique()!;
}

export function listDailyLearningReports(): DailyLearningReport[] {
  return payloadRows<DailyLearningReport>(
    "SELECT payload_json FROM daily_learning_reports ORDER BY created_at DESC LIMIT 500",
  );
}

export function runDailyLearning(
  tradingDate: string,
  baseVersion = STRATEGY_VERSION,
): DailyLearningReport {
  if (!tradingDate?.trim()) throw new Error("tradingDate é obrigatório para o aprendizado diário.");
  const records = payloadRows<BacktestRecord>(
    "SELECT payload_json FROM backtest_runs ORDER BY created_at ASC LIMIT 2000",
  );
  const trades = records.flatMap((record) => record.trades ?? []);
  const { report, candidate } = learnFromDay({ tradingDate, baseVersion, trades });
  if (candidate) {
    upsertTechniqueCandidate(candidate);
    // Toda candidata é uma HIPÓTESE TESTADA e entra no denominador da
    // exigência anti-overfitting — mesmo que nunca chegue a VALIDATED.
    // Testar vinte variações e mostrar só a melhor deixa dezenove registros.
    insertLabExperiment({
      id: `exp_${candidate.id}`,
      baseVersion: candidate.baseVersion,
      candidateId: candidate.id,
      hypothesis: candidate.hypothesis,
      variation: candidate.rules,
      datasetId: null,
      createdAt: candidate.createdAt,
    });
  }
  db()
    .prepare(
      `
    INSERT INTO daily_learning_reports(id, trading_date, base_version, payload_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json, updated_at=excluded.updated_at
  `,
    )
    .run(
      report.id,
      report.tradingDate,
      report.baseVersion,
      JSON.stringify(report),
      report.createdAt,
      Date.now(),
    );
  return report;
}

export function saveReplayBatch(input: {
  tradingSessions: TradingSessionRecord[];
  segments: SegmentRecord[];
  marketEvents: MarketEventRecord[];
  backtest: BacktestRecord | null;
  replaySession: ReplayRecordingRecord;
}): void {
  // TRANSAÇÃO ÚNICA: ou o lote inteiro entra (pregões → trechos →
  // trades/backtest → resumo da gravação), ou nada entra. Uma falha no meio
  // não pode deixar estado parcial referenciando registros ausentes.
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const record of input.tradingSessions) upsertTradingSession(record);
    for (const record of input.segments) upsertSegment(record);
    for (const event of input.marketEvents) upsertMarketEvent(event);
    if (input.backtest) upsertBacktest(input.backtest);
    upsertReplaySession(input.replaySession);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/** Handle compartilhado do banco para os repositórios auxiliares. */
export function getDatabase(): DatabaseSync {
  return db();
}

/** Diretório oficial de dados (gravações, backups do admin, sqlite). */
export function getDataDir(): string {
  return dataDir();
}

export function databaseInfo(): { path: string; schemaVersion: number } {
  db();
  return { path: dbPath(), schemaVersion: SCHEMA_VERSION };
}

// Type-only assertion keeps the persisted trade shape coupled to the domain.
const _tradeShapeCheck: BacktestTrade | null = null;
void _tradeShapeCheck;

/**
 * Fecha o SQLite singleton para testes/reabertura controlada.
 * Zera também o estrangulamento da retenção de imagens: sem isso, um teste
 * herdaria o relógio do teste anterior e a varredura ficaria muda por uma hora.
 */
export function resetTradingRepositoryForTests(): void {
  singleton?.close();
  singleton = null;
  lastPrintSweepAt = 0;
  /*
   * Desliga também a autorização por ativo. Sem isso o cache de `assets.ts`
   * sobreviveria ao fechamento do banco e um "reinício" simulado continuaria
   * afirmando uma permissão que ninguém releu — o teste ficaria verde por
   * memória residual, não por persistência.
   */
  setAssetValidationStore(null);
}

/* ------------------------------------------------------------------------ *
 * DNA DE SETUPS, EXPERIMENTOS E DATASETS
 * ------------------------------------------------------------------------ */

/**
 * Registra uma detecção. IMUTÁVEL de propósito: o DNA é classificado antes do
 * desfecho e nunca reescrito — reclassificar sabendo o resultado é viés
 * retrospectivo. Reanalisar produz um id NOVO; o único campo que muda depois
 * é o vínculo com o trade, por `linkDnaToTrade`/`upsertBacktest`.
 */
export function insertSetupDna(record: SetupDna): void {
  /*
   * `OR IGNORE` só pode significar "esta detecção já foi registrada" — e é
   * por isso que a existência é checada ANTES. Sem isso, uma violação de NOT
   * NULL viraria no-op silencioso: o endpoint responderia `ok: true` e a
   * detecção sumiria sem erro nenhum. Registro perdido em silêncio é pior que
   * erro: a estatística de "quantas apareceram" fica errada sem sintoma.
   */
  const existing = db().prepare("SELECT 1 FROM setup_dna WHERE id = ?").get(record.id);
  if (existing) return;
  db()
    .prepare(
      `
    INSERT INTO setup_dna(
      id, origin, source_id, print_id, trade_id, asset, timeframe, direction,
      detected_at, trading_date, hour, technique_version,
      grade, trend, position, pullback, pullback_depth, pullback_bars,
      impulse_points, impulse_r, location, location_detail, trigger_candle,
      movement_ordinal, volatility, volatility_ratio, stop_distance_points,
      rr_available, entry, stop, targets_json, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      record.id,
      record.origin,
      record.sourceId,
      record.printId,
      record.tradeId,
      record.asset,
      record.timeframe,
      record.direction,
      record.detectedAt,
      record.tradingDate,
      record.hour,
      record.techniqueVersion,
      record.grade,
      record.trend,
      record.position,
      record.pullback,
      record.pullbackDepth,
      record.pullbackBars,
      record.impulsePoints,
      record.impulseR,
      record.location,
      record.locationDetail,
      record.triggerCandle,
      record.movementOrdinal,
      record.volatility,
      record.volatilityRatio,
      record.stopDistancePoints,
      record.rrAvailable,
      record.entry,
      record.stop,
      JSON.stringify(record.targets),
      JSON.stringify(record),
      Date.now(),
    );
}

export function linkDnaToTrade(dnaId: string, tradeId: string): boolean {
  const result = db()
    .prepare("UPDATE setup_dna SET trade_id=? WHERE id=? AND (trade_id IS NULL OR trade_id=?)")
    .run(tradeId, dnaId, tradeId);
  return Number(result.changes) > 0;
}

export interface DnaFilters {
  from?: string;
  to?: string;
  asset?: string;
}

function dnaWhere(filters: DnaFilters, alias: string): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.from) {
    clauses.push(`${alias}.trading_date >= ?`);
    params.push(filters.from);
  }
  if (filters.to) {
    clauses.push(`${alias}.trading_date <= ?`);
    params.push(filters.to);
  }
  if (filters.asset) {
    clauses.push(`${alias}.asset = ?`);
    params.push(filters.asset);
  }
  return { sql: clauses.length ? `AND ${clauses.join(" AND ")}` : "", params };
}

export function listSetupDna(filters: DnaFilters = {}): SetupDna[] {
  const where = dnaWhere(filters, "d");
  return db()
    .prepare(
      `SELECT payload_json, trade_id FROM setup_dna d WHERE 1=1 ${where.sql} ORDER BY detected_at ASC LIMIT 20000`,
    )
    .all(...(where.params as never[]))
    .map((row) => {
      const dna = parse<SetupDna>((row as { payload_json: string }).payload_json);
      // O vínculo pode ter chegado depois do INSERT do payload.
      return { ...dna, tradeId: (row as { trade_id: string | null }).trade_id };
    });
}

/**
 * Sintetiza o DNA a partir das colunas do trade quando não há registro próprio.
 *
 * Campo ausente vira NAO_IDENTIFICADO/null — nunca um valor substantivo. Um
 * default como "A_FAVOR" afirmaria que o setup estava a favor da tendência sem
 * que ninguém tenha medido isso, e essa afirmação entraria nas tabelas
 * segmentadas indistinguível de uma medida real.
 */
function dnaFromTradeRecord(trade: BacktestTrade): SetupDna {
  return {
    id: trade.dnaId ?? `dna_trade_${trade.id}`,
    origin: trade.origin === "LIVE" ? "LIVE" : "REPLAY",
    sourceId: trade.sourceCaptureId,
    asset: trade.asset,
    timeframe: trade.timeframe,
    direction: trade.direction,
    detectedAt: trade.classifiedAt ?? trade.signalAt ?? trade.openedAt,
    tradingDate: trade.tradingDate ?? null,
    hour: trade.hour ?? null,
    techniqueVersion: trade.productionTechniqueVersion ?? trade.strategyVersion,
    // Trade sem nota registrada não é "DESCARTADA" — é não classificado. O
    // filtro de órfãos exige quality IS NOT NULL, então na prática este ramo
    // não é alcançado; o default permanece honesto de qualquer forma.
    grade: trade.quality ?? "DESCARTADA",
    trend: trade.trendStrength ?? "NAO_IDENTIFICADO",
    position: trade.positionVsTrend ?? "NAO_IDENTIFICADO",
    pullback: trade.pullbackType ?? "NAO_IDENTIFICADO",
    pullbackDepth: null,
    pullbackBars: null,
    impulsePoints: null,
    impulseR: trade.impulseStrength ?? null,
    location: trade.location ?? "NAO_IDENTIFICADO",
    locationDetail: trade.poiKind ?? null,
    triggerCandle: trade.triggerCandle ?? "NAO_IDENTIFICADO",
    movementOrdinal: (trade.t4NumberInMove as 1 | 2 | 3 | 4 | undefined) ?? null,
    volatility: trade.volatilityLevel ?? null,
    volatilityRatio: null,
    stopDistancePoints: trade.stopDistancePoints ?? Math.abs(trade.entry - trade.stop),
    rrAvailable: trade.riskReward,
    entry: trade.entry,
    stop: trade.stop,
    targets: [trade.target1, trade.target2],
    printId: null,
    tradeId: trade.id,
  };
}

function outcomeFromTrade(dna: SetupDna, trade: BacktestTrade | null): DnaOutcome {
  /*
   * PARCIAL REALIZADA PROVA A ORDEM INTRA-TRADE.
   *
   * `partialHitAt` só existe quando o preço tocou a parcial, e o tracker só
   * move o stop DEPOIS disso — então todo patamar até a parcial ocorreu antes
   * do stop. É o que permite à comparação de saídas parar de contar alvos
   * curtos como stop em operações que comprovadamente passaram por eles.
   */
  const risco =
    trade !== null && Number.isFinite(trade.entry) && Number.isFinite(trade.stop)
      ? Math.abs(trade.entry - trade.stop)
      : 0;
  const partialReachedR =
    trade?.partialHitAt != null && risco > 0
      ? Number((Math.abs(trade.target1 - trade.entry) / risco).toFixed(3))
      : null;

  return {
    dna,
    rMultiple: trade?.rMultiple ?? null,
    mfeR: trade?.mfeR ?? null,
    maeR: trade?.maeR ?? null,
    // Custo em R só quando alguém o converteu DE VERDADE — e agora alguém
    // converte: `createBacktestTrade` liquida no fechamento e grava `costR`
    // no payload (BLOCO 5). Trade antigo sem o campo segue null — custo
    // desconhecido nunca vira zero, e a expectância líquida só cobre o que
    // foi medido (dnaStats declara a cobertura em `costsCovered`).
    costR: trade?.costR ?? null,
    resultMoney: trade?.resultBrl ?? null,
    partialReachedR,
  };
}

/**
 * A matriz completa para a estatística segmentada: toda detecção registrada,
 * casada com o desfecho quando ele existe — MAIS os trades com DNA que não
 * têm registro de detecção próprio (extração tardia, sem janela congelada).
 */
export function listDnaOutcomes(filters: DnaFilters = {}): DnaOutcome[] {
  const database = db();
  const whereDna = dnaWhere(filters, "d");
  const detections = database
    .prepare(
      `
    SELECT d.payload_json AS dna_json, d.trade_id AS linked_trade, t.payload_json AS trade_json
    FROM setup_dna d LEFT JOIN trades t ON t.id = d.trade_id
    WHERE 1=1 ${whereDna.sql}
    ORDER BY d.detected_at ASC LIMIT 20000
  `,
    )
    .all(...(whereDna.params as never[]))
    .map((row) => {
      const r = row as { dna_json: string; linked_trade: string | null; trade_json: string | null };
      const dna = { ...parse<SetupDna>(r.dna_json), tradeId: r.linked_trade };
      const trade = r.trade_json === null ? null : parse<BacktestTrade>(r.trade_json);
      return outcomeFromTrade(dna, trade);
    });

  const whereTrade = dnaWhere(filters, "t");
  const orphanTrades = database
    .prepare(
      `
    SELECT t.payload_json AS trade_json
    FROM trades t
    WHERE t.quality IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM setup_dna d WHERE d.trade_id = t.id)
      ${whereTrade.sql.replace("t.asset", "t.symbol")}
    ORDER BY t.opened_at ASC LIMIT 20000
  `,
    )
    .all(...(whereTrade.params as never[]))
    .map((row) => {
      const trade = parse<BacktestTrade>((row as { trade_json: string }).trade_json);
      return outcomeFromTrade(dnaFromTradeRecord(trade), trade);
    });

  return [...detections, ...orphanTrades];
}

export interface LabExperimentRecord {
  id: string;
  baseVersion: string;
  candidateId: string | null;
  hypothesis: string;
  /** Regra adicionada/removida + motivo — o rastro exigido pelo Laboratório. */
  variation: unknown;
  datasetId: string | null;
  createdAt: number;
}

export function insertLabExperiment(record: LabExperimentRecord): void {
  db()
    .prepare(
      `
    INSERT OR IGNORE INTO lab_experiments(id, base_version, candidate_id, hypothesis, variation_json, dataset_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      record.id,
      record.baseVersion,
      record.candidateId,
      record.hypothesis,
      JSON.stringify(record.variation ?? {}),
      record.datasetId,
      record.createdAt,
    );
}

/** Quantas variações já foram testadas sobre esta base — o denominador da
 * exigência anti-overfitting: mais hipóteses, validação mais dura. */
export function countLabExperiments(baseVersion: string): number {
  const row = db()
    .prepare("SELECT COUNT(*) AS total FROM lab_experiments WHERE base_version = ?")
    .get(baseVersion) as { total: number } | undefined;
  return Number(row?.total ?? 0);
}

export function listLabExperiments(baseVersion?: string): LabExperimentRecord[] {
  const rows = baseVersion
    ? db()
        .prepare("SELECT * FROM lab_experiments WHERE base_version = ? ORDER BY created_at ASC")
        .all(baseVersion)
    : db().prepare("SELECT * FROM lab_experiments ORDER BY created_at ASC").all();
  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: String(r["id"]),
      baseVersion: String(r["base_version"]),
      candidateId: r["candidate_id"] === null ? null : String(r["candidate_id"]),
      hypothesis: String(r["hypothesis"]),
      variation: parse(r["variation_json"]),
      datasetId: r["dataset_id"] === null ? null : String(r["dataset_id"]),
      createdAt: Number(r["created_at"]),
    };
  });
}

export interface DatasetRecord {
  id: string;
  name: string;
  kind: "TREINO" | "VALIDACAO" | "OOS";
  startDate: string;
  endDate: string;
  tradeCount: number;
  frozen: boolean;
  createdAt: number;
}

/** Dataset congelado é imutável: o recorte usado numa validação não pode
 * mudar depois — mudar o dataset a posteriori invalida a validação. */
export function upsertDataset(record: DatasetRecord): void {
  const existing = db().prepare("SELECT frozen FROM datasets WHERE id = ?").get(record.id) as
    { frozen: number } | undefined;
  if (existing?.frozen === 1) {
    throw new Error(`Dataset ${record.id} está congelado — recorte usado em validação não muda.`);
  }
  db()
    .prepare(
      `
    INSERT INTO datasets(id, name, kind, start_date, end_date, trade_count, frozen, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, kind=excluded.kind, start_date=excluded.start_date,
      end_date=excluded.end_date, trade_count=excluded.trade_count, frozen=excluded.frozen
  `,
    )
    .run(
      record.id,
      record.name,
      record.kind,
      record.startDate,
      record.endDate,
      record.tradeCount,
      record.frozen ? 1 : 0,
      record.createdAt,
    );
}

export function listDatasets(): DatasetRecord[] {
  return db()
    .prepare("SELECT * FROM datasets ORDER BY start_date ASC")
    .all()
    .map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: String(r["id"]),
        name: String(r["name"]),
        kind: String(r["kind"]) as DatasetRecord["kind"],
        startDate: String(r["start_date"]),
        endDate: String(r["end_date"]),
        tradeCount: Number(r["trade_count"]),
        frozen: Number(r["frozen"]) === 1,
        createdAt: Number(r["created_at"]),
      };
    });
}

/* ------------------------------------------------------------------------ *
 * MEMÓRIA T4: prints persistidos, vereditos e casos para similaridade
 * ------------------------------------------------------------------------ */

export interface PrintRecordInput {
  id: string;
  sessionId: string | null;
  asset: string;
  timeframe: string | null;
  capturedAt: number;
  status: string;
  direction: string;
  confidence: number;
  currentPrice: number | null;
  dnaId: string | null;
  captureCode: string | null;
  /** Análise validada SEM a imagem — a imagem vai para o disco. */
  analysis: unknown;
  /** Data URL da imagem; gravada em DATA_DIR/prints/{id}.jpg. */
  imageDataUrl?: string | null;
  /**
   * Metadados dos 2 passes do auto-crop (§13): motivo do 2º passe, escolha e
   * score de cada leitura. SÓ metadado — o print continua sendo UM registro e
   * UMA análise; o passe não entra duas vezes no aprendizado.
   */
  passes?: unknown;
  /**
   * Reparos declarados pela validação DESTA leitura.
   *
   * Lista vazia é resposta legítima ("nada precisou de reparo") e é gravada
   * como `[]`; ausente vira NULL. A diferença importa: `[]` afirma que a
   * validação rodou e não achou nada; NULL diz que ninguém contou.
   */
  repairs?: string[] | null;
  /** Previsão com critério pré-definido, quando existir. */
  prediction: {
    entry: number | null;
    stop: number;
    target: number;
  } | null;
}

/** Grava a imagem fora do banco e devolve o path — ou null, com o motivo no log. */
function writePrintImage(id: string, dataUrl: string | null | undefined): string | null {
  if (!dataUrl) return null;
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  try {
    const dir = join(dataDir(), "prints");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${id}.jpg`);
    writeFileSync(path, Buffer.from(dataUrl.slice(comma + 1), "base64"));
    return path;
  } catch (problem) {
    // Falha de disco não derruba a memória estruturada: o caso fica sem
    // imagem e o motivo fica no log do servidor.
    console.error("print image write failed", problem);
    return null;
  }
}

export function savePrintRecord(record: PrintRecordInput): void {
  const savedAt = Date.now();
  const imagePath = writePrintImage(record.id, record.imageDataUrl);
  db()
    .prepare(
      `
    INSERT OR IGNORE INTO prints(
      id, session_id, asset, timeframe, captured_at, image_path, status,
      direction, confidence, current_price, dna_id, capture_code,
      analysis_json, passes_json, repairs_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      record.id,
      record.sessionId,
      record.asset,
      record.timeframe,
      record.capturedAt,
      imagePath,
      record.status,
      record.direction,
      record.confidence,
      record.currentPrice,
      record.dnaId,
      record.captureCode,
      JSON.stringify(record.analysis),
      // Ausência declarada: print de UM passe grava NULL, nunca "{}" — um
      // objeto vazio afirmaria que houve metadado e ele veio sem nada dentro.
      record.passes === undefined || record.passes === null ? null : JSON.stringify(record.passes),
      // `[]` e NULL dizem coisas diferentes — ver o comentário da coluna.
      record.repairs === undefined || record.repairs === null
        ? null
        : JSON.stringify(record.repairs),
      savedAt,
    );

  // Previsão SÓ com critério completo pré-definido (direção + stop + alvo).
  // Sem critério não há o que verificar depois — e critério definido depois
  // do resultado é viés retrospectivo.
  if (record.prediction && (record.direction === "COMPRA" || record.direction === "VENDA")) {
    db()
      .prepare(
        `
      INSERT OR IGNORE INTO print_predictions(
        print_id, asset, direction, predicted_at, entry, stop, target,
        price_at_prediction, dna_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        record.id,
        record.asset,
        record.direction,
        record.capturedAt,
        record.prediction.entry,
        record.prediction.stop,
        record.prediction.target,
        record.currentPrice,
        record.dnaId,
      );
  }

  maybeSweepPrintImages(savedAt);
}

/* ------------------------------------------------------------------------ *
 * RETENÇÃO DAS IMAGENS DE PRINT
 *
 * A captura automática grava um .jpg por MINUTO: uma sessão de 6h deixa ~360
 * arquivos e o disco da VPS cresce para sempre. O que expira é o BITMAP e
 * SOMENTE ele — a linha de `prints`, o `analysis_json`, as previsões e o DNA
 * são a memória que alimenta similaridade e veredito, e ficam para sempre.
 *
 * Quando o arquivo sai, `image_path` vira NULL: caminho apontando para arquivo
 * inexistente seria mentira no banco. NULL é a AFIRMAÇÃO "a imagem expirou".
 * ------------------------------------------------------------------------ */

/** Janela padrão quando `PRINT_IMAGE_RETENTION_DAYS` não está declarada. */
const DEFAULT_PRINT_IMAGE_RETENTION_DAYS = 7;
const DAY_IN_MS = 86_400_000;

/** Intervalo mínimo entre varreduras disparadas por gravação de print. */
const PRINT_SWEEP_INTERVAL_MS = 3_600_000;

/** Instante da última varredura; 0 significa "ainda não varreu neste processo". */
let lastPrintSweepAt = 0;

/**
 * Dias de retenção declarados no ambiente.
 * <= 0 ou valor não numérico DESLIGA a limpeza (retenção infinita): diante de
 * uma configuração que não dá para ler, o lado seguro é NÃO apagar imagem —
 * arquivo apagado por engano não volta.
 */
function printImageRetentionDays(): number {
  const raw = process.env["PRINT_IMAGE_RETENTION_DAYS"]?.trim();
  if (!raw) return DEFAULT_PRINT_IMAGE_RETENTION_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 0;
  return parsed;
}

export interface PrintRetentionResult {
  /** Instante-limite: imagem anterior a ele expira. 0 quando a limpeza está desligada. */
  cutoff: number;
  removedFiles: number;
  freedBytes: number;
  clearedRows: number;
  orphanFiles: number;
  /** Imagens vencidas MANTIDAS por serem prova de caso ainda em aberto. */
  keptAsEvidence: number;
  skipped: "DESLIGADA" | null;
}

/**
 * A GUARDA DA PROVA: imagem vinculada a caso EM ABERTO não é lixo, é evidência.
 *
 * Um setup ABERTO e uma previsão PENDENTE ainda vão receber veredito — e o
 * operador vai querer ver o print que originou o caso quando o resultado
 * chegar. Apagar o bitmap antes do desfecho destrói a única prova visual de uma
 * decisão que ainda está sendo julgada. A janela de retenção só se aplica ao
 * que JÁ fechou.
 *
 * O filtro é o MESMO nas três consultas (contagem, UPDATE e SELECT dos
 * arquivos): se divergissem, o banco diria NULL enquanto o arquivo continuasse
 * no disco — ou pior, o arquivo sairia com a linha intacta.
 */
const EVIDENCE_GUARD_SQL = `
  AND id NOT IN (SELECT print_id FROM setups WHERE outcome='ABERTO' AND print_id IS NOT NULL)
  AND id NOT IN (SELECT print_id FROM print_predictions WHERE verdict='PENDENTE')
`;

/** ENOENT sem `as any`: arquivo já ausente é estado esperado, não falha. */
function isMissingFile(problem: unknown): boolean {
  return problem instanceof Error && "code" in problem && problem.code === "ENOENT";
}

/**
 * Apaga as imagens fora da janela e declara NULL no lugar do caminho.
 * Falha de I/O em um arquivo não derruba a varredura — o motivo vai para o log
 * e a limpeza segue, como em `writePrintImage`.
 */
export function sweepPrintImages(now = Date.now()): PrintRetentionResult {
  const days = printImageRetentionDays();
  if (days <= 0) {
    return {
      cutoff: 0,
      removedFiles: 0,
      freedBytes: 0,
      clearedRows: 0,
      orphanFiles: 0,
      keptAsEvidence: 0,
      skipped: "DESLIGADA",
    };
  }

  const cutoff = now - days * DAY_IN_MS;
  const database = db();
  const expired = database
    .prepare(
      `SELECT image_path FROM prints
       WHERE image_path IS NOT NULL AND captured_at < ? ${EVIDENCE_GUARD_SQL}`,
    )
    .all(cutoff) as Array<{ image_path: string }>;

  // Contado ANTES do UPDATE: depois dele a diferença some, e o número que o
  // operador precisa ver é justamente "quantas eu NÃO apaguei, e por quê".
  const kept = database
    .prepare(
      `SELECT COUNT(*) AS total FROM prints
       WHERE image_path IS NOT NULL AND captured_at < ?
         AND (
           id IN (SELECT print_id FROM setups WHERE outcome='ABERTO' AND print_id IS NOT NULL)
           OR id IN (SELECT print_id FROM print_predictions WHERE verdict='PENDENTE')
         )`,
    )
    .get(cutoff) as { total: number } | undefined;
  const keptAsEvidence = Number(kept?.total ?? 0);

  /*
   * O banco é atualizado em UM lote e o disco só depois do COMMIT. A ordem
   * inversa (apagar arquivo e então commitar) deixaria linha apontando para
   * arquivo removido se o COMMIT falhasse — exatamente a mentira que a coluna
   * NULL existe para evitar. O resíduo desta ordem é arquivo órfão, e órfão a
   * própria varredura recolhe na passada seguinte.
   */
  database.exec("BEGIN IMMEDIATE");
  let clearedRows = 0;
  try {
    const update = database
      .prepare(
        `UPDATE prints SET image_path=NULL
         WHERE image_path IS NOT NULL AND captured_at < ? ${EVIDENCE_GUARD_SQL}`,
      )
      .run(cutoff);
    clearedRows = Number(update.changes);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  let removedFiles = 0;
  let freedBytes = 0;
  for (const row of expired) {
    try {
      const size = statSync(row.image_path).size;
      unlinkSync(row.image_path);
      removedFiles += 1;
      freedBytes += size;
    } catch (problem) {
      // Arquivo já ausente conta como linha limpa, não como arquivo removido.
      if (!isMissingFile(problem))
        console.error("print image unlink failed", row.image_path, problem);
    }
  }

  // Órfão é contado à parte de `removedFiles`: um vem de linha viva que
  // expirou, o outro de arquivo que linha nenhuma reivindica. Só os bytes,
  // que são a mesma coisa no disco, somam junto.
  const orphans = sweepOrphanPrintFiles(database, cutoff);
  freedBytes += orphans.freedBytes;

  // UMA linha de log, e só quando houve remoção: varredura silenciosa esconde
  // perda de dado, varredura falante a cada hora vira ruído no log da VPS.
  if (removedFiles > 0 || orphans.files > 0) {
    console.info(
      `[retenção de prints] ${removedFiles} imagens + ${orphans.files} órfãos removidos, ${freedBytes} bytes liberados, ${clearedRows} análises preservadas com image_path NULL, ${keptAsEvidence} imagens mantidas como prova de caso em aberto`,
    );
  }

  return {
    cutoff,
    removedFiles,
    freedBytes,
    clearedRows,
    orphanFiles: orphans.files,
    keptAsEvidence,
    skipped: null,
  };
}

/**
 * Arquivos em DATA_DIR/prints que nenhuma linha referencia — resto de gravação
 * interrompida ou de unlink que falhou antes. O corte por mtime é proteção:
 * um arquivo recém-escrito cuja linha ainda não foi gravada NÃO é órfão.
 */
function sweepOrphanPrintFiles(
  database: DatabaseSync,
  cutoff: number,
): { files: number; freedBytes: number } {
  const dir = join(dataDir(), "prints");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (problem) {
    // Diretório inexistente é o estado normal antes do primeiro print.
    if (!isMissingFile(problem)) console.error("print dir read failed", dir, problem);
    return { files: 0, freedBytes: 0 };
  }

  const referenced = new Set(
    (
      database
        .prepare("SELECT image_path FROM prints WHERE image_path IS NOT NULL")
        .all() as Array<{
        image_path: string;
      }>
    ).map((row) => resolve(row.image_path)),
  );

  let files = 0;
  let freedBytes = 0;
  for (const entry of entries) {
    const path = join(dir, entry);
    if (referenced.has(resolve(path))) continue;
    try {
      const info = statSync(path);
      if (!info.isFile() || info.mtimeMs >= cutoff) continue;
      unlinkSync(path);
      files += 1;
      freedBytes += info.size;
    } catch (problem) {
      if (!isMissingFile(problem)) console.error("orphan print unlink failed", path, problem);
    }
  }
  return { files, freedBytes };
}

/**
 * Varredura ESTRANGULADA: no máximo uma por hora.
 * Não roda a cada print porque listar o diretório a cada 60s é I/O desperdiçado
 * — a janela é de dias, um atraso de uma hora não muda nada no disco.
 * Não roda em `migrate()` porque migração é ESQUEMA: misturar apagar dado do
 * usuário com abertura do banco faria toda inicialização (inclusive um teste ou
 * um script de leitura) destruir imagem sem ninguém ter pedido.
 */
function maybeSweepPrintImages(now: number): void {
  if (now - lastPrintSweepAt < PRINT_SWEEP_INTERVAL_MS) return;
  // Marca ANTES de varrer: falha na varredura não pode virar retentativa a
  // cada print salvo.
  lastPrintSweepAt = now;
  try {
    sweepPrintImages(now);
  } catch (problem) {
    // Faxina de disco nunca derruba a gravação do print — a análise é o ativo.
    console.error("print retention sweep failed", problem);
  }
}

/**
 * Varre as previsões PENDENTES do ativo contra as observações de preço dos
 * prints (etiqueta lida a cada 60s). Roda a cada print salvo — o aprendizado
 * fecha sozinho, sem intervenção manual.
 */
export function sweepPredictionOutcomes(asset: string, now = Date.now()): number {
  const database = db();
  const pending = database
    .prepare(
      "SELECT print_id, asset, direction, predicted_at, entry, stop, target, price_at_prediction FROM print_predictions WHERE asset=? AND verdict='PENDENTE'",
    )
    .all(asset) as Array<{
    print_id: string;
    asset: string;
    direction: "COMPRA" | "VENDA";
    predicted_at: number;
    entry: number | null;
    stop: number | null;
    target: number | null;
    price_at_prediction: number | null;
  }>;
  if (pending.length === 0) return 0;

  const observations = (
    database
      .prepare(
        // AS OBSERVAÇÕES MAIS RECENTES — não as mais antigas. Era ASC: passados
        // 5.000 prints do ativo a janela congelava no passado e nenhuma
        // observação nova chegava aqui, então setups e previsões abertos
        // paravam de fechar como WIN/LOSS em silêncio. O teto continua (é
        // memória), mas agora corta o passado. A ordem cronológica é
        // restaurada em memória logo abaixo, porque quem avalia depende dela.
        "SELECT captured_at, current_price FROM prints WHERE asset=? AND current_price IS NOT NULL ORDER BY captured_at DESC LIMIT 5000",
      )
      .all(asset) as Array<{ captured_at: number; current_price: number }>
  )
    .map((row) => ({ at: row.captured_at, price: row.current_price }))
    .reverse();

  const update = database.prepare(
    "UPDATE print_predictions SET verdict=?, ambiguous=?, detail=?, resolved_at=? WHERE print_id=?",
  );
  let resolved = 0;
  for (const row of pending) {
    const outcome = evaluatePrediction(
      {
        printId: row.print_id,
        asset: row.asset,
        direction: row.direction,
        predictedAt: row.predicted_at,
        entry: row.entry,
        stop: row.stop,
        target: row.target,
        priceAtPrediction: row.price_at_prediction,
      },
      observations,
      now,
    );
    if (outcome.verdict !== "PENDENTE") {
      update.run(
        outcome.verdict,
        outcome.ambiguous ? 1 : 0,
        outcome.detail,
        outcome.resolvedAt,
        row.print_id,
      );
      resolved += 1;
    }
  }
  return resolved;
}

/* ------------------------------------------------------------------------ *
 * SETUPS PERSISTENTES: o ciclo fecha no servidor, não no navegador
 *
 * A máquina de setup (`@/lib/print/setupTracker`) roda no cliente e morre com a
 * aba. Aqui o setup ganha corpo: sobrevive ao restart do backend (é isto que
 * permite RESTAURAR o setup ativo), fecha sozinho contra as etiquetas de preço
 * dos prints e entrega o resultado à memória UMA única vez.
 * ------------------------------------------------------------------------ */

export interface SetupRecordInput {
  setupId: string;
  asset: string;
  timeframe: string | null;
  direction: "COMPRA" | "VENDA";
  stage: string;
  entry: number | null;
  stop: number | null;
  target: number | null;
  entryZoneMin: number | null;
  entryZoneMax: number | null;
  /** null enquanto o setup não foi confirmado — nunca 0 disfarçado. */
  confirmedAt: number | null;
  createdAt: number;
  expiresAt: number | null;
  dnaId: string | null;
  printId: string | null;

  /*
   * §32/§34 — O ESTADO QUE PRECISA ATRAVESSAR O REINÍCIO.
   *
   * Sem isto no banco, um F5 no meio de um rompimento faz a máquina esquecer
   * que já houve fechamento além do gatilho — e o candle seguinte, que era a
   * PROVA, volta a ser tratado como o primeiro fechamento. A oportunidade
   * some sem sintoma nenhum.
   */
  triggerLevel: number | null;
  triggerVersion: number;
  triggerHistory: TriggerVersion[];
  /** Estado do rompimento como o `breakout.ts` o descreve. Null = nenhum. */
  breakout: BreakoutState | null;
  /** CONFIRMED **e** RISK_APPROVED, gravado para auditoria do desfecho. */
  operationReleased: boolean;
}

export interface SetupRow extends SetupRecordInput {
  updatedAt: number;
  outcome: SetupOutcome;
  outcomeAt: number | null;
  outcomeReason: string | null;
  ambiguous: boolean;
  learned: boolean;
}

interface SetupDbRow {
  setup_id: string;
  asset: string;
  timeframe: string | null;
  direction: string;
  stage: string;
  entry: number | null;
  stop: number | null;
  target: number | null;
  entry_zone_min: number | null;
  entry_zone_max: number | null;
  confirmed_at: number | null;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  outcome: string;
  outcome_at: number | null;
  outcome_reason: string | null;
  ambiguous: number;
  dna_id: string | null;
  print_id: string | null;
  learned: number;
  trigger_level: number | null;
  trigger_version: number | null;
  trigger_history_json: string | null;
  breakout_json: string | null;
  operation_released: number | null;
}

function toSetupRow(row: SetupDbRow): SetupRow {
  return {
    setupId: row.setup_id,
    asset: row.asset,
    timeframe: row.timeframe,
    direction: row.direction === "VENDA" ? "VENDA" : "COMPRA",
    stage: row.stage,
    entry: row.entry,
    stop: row.stop,
    target: row.target,
    entryZoneMin: row.entry_zone_min,
    entryZoneMax: row.entry_zone_max,
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    outcome: row.outcome as SetupOutcome,
    outcomeAt: row.outcome_at,
    outcomeReason: row.outcome_reason,
    ambiguous: row.ambiguous === 1,
    dnaId: row.dna_id,
    printId: row.print_id,
    learned: row.learned === 1,
    triggerLevel: row.trigger_level,
    /*
     * Coluna nova em banco antigo volta null antes de o ALTER rodar, e depois
     * dele volta o DEFAULT. 1 é a primeira versão do gatilho — nunca 0, que
     * significaria "gatilho não versionado" e não existe neste domínio.
     */
    triggerVersion: row.trigger_version ?? 1,
    triggerHistory: parseOuVazio<TriggerVersion[]>(row.trigger_history_json, []),
    breakout: parseOuVazio<BreakoutState | null>(row.breakout_json, null),
    operationReleased: row.operation_released === 1,
  };
}

/**
 * JSON do banco de volta a objeto, sem derrubar a leitura.
 *
 * Uma linha com JSON corrompido (escrita interrompida, edição manual) não pode
 * derrubar `listOpenSetups` inteiro e apagar a tela do operador. O valor de
 * reserva é sempre o CONSERVADOR — lista vazia, rompimento nenhum —, que é a
 * mesma coisa que a coluna diria se nunca tivesse sido preenchida.
 */
function parseOuVazio<T>(raw: string | null, reserva: T): T {
  if (raw === null || raw === "") return reserva;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return reserva;
  }
}

const SETUP_COLUMNS =
  "setup_id, asset, timeframe, direction, stage, entry, stop, target, entry_zone_min, " +
  "entry_zone_max, confirmed_at, created_at, updated_at, expires_at, outcome, outcome_at, " +
  "outcome_reason, ambiguous, dna_id, print_id, learned, trigger_level, trigger_version, " +
  "trigger_history_json, breakout_json, operation_released";

/**
 * Grava/atualiza o setup vindo do cliente. Idempotente por `setup_id`.
 *
 * SETUP FECHADO NÃO REABRE. O cliente continua enviando o setup a cada print e
 * a visão dele pode estar velha: o navegador ainda mostra CONFIRMADO enquanto a
 * varredura do servidor já fechou como LOSS. Por isso o `DO UPDATE` carrega
 * `WHERE setups.outcome='ABERTO'` — a guarda mora no WHERE, não numa checagem
 * anterior que uma segunda requisição concorrente atravessaria. E o desfecho
 * (outcome/outcome_at/outcome_reason/ambiguous/learned) NUNCA é escrito por
 * aqui: quem julga é a varredura, com as observações de preço na mão.
 *
 * `frozen: true` é REPARO DECLARADO — a escrita foi recusada e o chamador
 * recebe o motivo em vez de acreditar que gravou.
 */
export function upsertSetup(
  record: SetupRecordInput,
  now = Date.now(),
): { outcome: SetupOutcome; frozen: boolean } {
  const database = db();
  database
    .prepare(
      `
    INSERT INTO setups(
      setup_id, asset, timeframe, direction, stage, entry, stop, target,
      entry_zone_min, entry_zone_max, confirmed_at, created_at, updated_at, expires_at,
      dna_id, print_id,
      trigger_level, trigger_version, trigger_history_json, breakout_json, operation_released
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(setup_id) DO UPDATE SET
      asset=excluded.asset, timeframe=excluded.timeframe, direction=excluded.direction,
      stage=excluded.stage, entry=excluded.entry, stop=excluded.stop, target=excluded.target,
      entry_zone_min=excluded.entry_zone_min, entry_zone_max=excluded.entry_zone_max,
      confirmed_at=excluded.confirmed_at, expires_at=excluded.expires_at,
      dna_id=excluded.dna_id, print_id=excluded.print_id, updated_at=excluded.updated_at,
      trigger_level=excluded.trigger_level,
      /*
       * §9 — A VERSÃO DO GATILHO SÓ ANDA PARA FRENTE.
       *
       * O cliente reenvia o setup a cada print, e uma aba atrasada pode chegar
       * depois de uma mais nova. Sem o MAX, ela rebaixaria a versão e o
       * histórico do gatilho passaria a contradizer o número em vigor.
       */
      trigger_version=MAX(setups.trigger_version, excluded.trigger_version),
      trigger_history_json=excluded.trigger_history_json,
      breakout_json=excluded.breakout_json,
      operation_released=excluded.operation_released
    WHERE setups.outcome='ABERTO'
  `,
    )
    .run(
      record.setupId,
      record.asset,
      record.timeframe,
      record.direction,
      record.stage,
      record.entry,
      record.stop,
      record.target,
      record.entryZoneMin,
      record.entryZoneMax,
      record.confirmedAt,
      record.createdAt,
      now,
      record.expiresAt,
      record.dnaId,
      record.printId,
      record.triggerLevel,
      record.triggerVersion,
      // Histórico e rompimento viajam como JSON: são objetos do domínio, e o
      // banco guarda o que a máquina produziu, sem redesenhar o formato.
      JSON.stringify(record.triggerHistory),
      record.breakout === null ? null : JSON.stringify(record.breakout),
      // SQLite não tem booleano: 1/0, com a conversão dita aqui e desfeita em
      // `toSetupRow`. Gravar `true` viraria a string "true" e voltaria truthy
      // para sempre — inclusive para o `false`.
      record.operationReleased ? 1 : 0,
    );

  const stored = database
    .prepare("SELECT outcome FROM setups WHERE setup_id=?")
    .get(record.setupId) as { outcome: string } | undefined;
  const outcome = (stored?.outcome ?? "ABERTO") as SetupOutcome;
  return { outcome, frozen: outcome !== "ABERTO" };
}

/** Os setups ainda em curso — é por aqui que a tela restaura o setup ativo. */
export function listOpenSetups(asset?: string): SetupRow[] {
  return listSetups(asset, true);
}

export function listSetups(asset?: string, onlyOpen = false): SetupRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (asset) {
    clauses.push("asset=?");
    params.push(asset);
  }
  if (onlyOpen) clauses.push("outcome='ABERTO'");
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return (
    db()
      .prepare(`SELECT ${SETUP_COLUMNS} FROM setups ${where} ORDER BY created_at DESC LIMIT 2000`)
      .all(...(params as never[])) as unknown as SetupDbRow[]
  ).map(toSetupRow);
}

/**
 * Fecha os setups que já têm desfecho, usando as observações de preço que JÁ
 * EXISTEM (`prints.current_price` — a MESMA fonte de `sweepPredictionOutcomes`;
 * uma segunda fonte de preço criaria dois vereditos discordantes para o mesmo
 * instante).
 *
 * SÓ VARRE `outcome='ABERTO'` E a escrita repete a guarda no próprio WHERE:
 * setup fechado nunca reabre e nunca é contado duas vezes, mesmo que duas
 * varreduras rodem no mesmo instante.
 */
export function sweepSetupOutcomes(asset: string, now = Date.now()): number {
  const database = db();
  const abertos = database
    .prepare(`SELECT ${SETUP_COLUMNS} FROM setups WHERE asset=? AND outcome='ABERTO'`)
    .all(asset) as unknown as SetupDbRow[];
  if (abertos.length === 0) return 0;

  const observations = (
    database
      .prepare(
        // AS OBSERVAÇÕES MAIS RECENTES — não as mais antigas. Era ASC: passados
        // 5.000 prints do ativo a janela congelava no passado e nenhuma
        // observação nova chegava aqui, então setups e previsões abertos
        // paravam de fechar como WIN/LOSS em silêncio. O teto continua (é
        // memória), mas agora corta o passado. A ordem cronológica é
        // restaurada em memória logo abaixo, porque quem avalia depende dela.
        "SELECT captured_at, current_price FROM prints WHERE asset=? AND current_price IS NOT NULL ORDER BY captured_at DESC LIMIT 5000",
      )
      .all(asset) as Array<{ captured_at: number; current_price: number }>
  )
    .map((row) => ({ at: row.captured_at, price: row.current_price }))
    .reverse();

  const update = database.prepare(
    `UPDATE setups SET outcome=?, outcome_at=?, outcome_reason=?, ambiguous=?, updated_at=?
     WHERE setup_id=? AND outcome='ABERTO'`,
  );

  let resolved = 0;
  for (const row of abertos) {
    const verdict = verdictFor(row, observations, now);
    if (verdict === null) continue;
    const changes = Number(
      update.run(
        verdict.outcome,
        verdict.at,
        verdict.reason,
        verdict.ambiguous ? 1 : 0,
        now,
        row.setup_id,
      ).changes,
    );
    // Zero mudanças = outra varredura fechou este setup primeiro. Não conta:
    // contar aqui inflaria o número de desfechos sem existir desfecho novo.
    if (changes > 0) resolved += 1;
  }
  return resolved;
}

/**
 * O desfecho de UMA linha, ou null quando ela segue aberta.
 *
 * Três situações distintas, cada uma dita com o seu motivo — nenhuma delas
 * empurrada para dentro de `evaluateSetup` com número inventado:
 *  - NÃO CONFIRMADO: não tem entrada, logo não tem WIN nem LOSS. Passado o
 *    prazo, fecha EXPIRADO; sem isso um setup abandonado (aba fechada, backend
 *    reiniciado) ficaria ABERTO para sempre, travando a retenção de imagem.
 *  - CONFIRMADO SEM STOP/ALVO numéricos: não há critério pré-definido — fecha
 *    INVALIDADO, porque EXPIRADO afirmaria que o mercado não alcançou algo que
 *    nunca foi declarado.
 *  - CONFIRMADO com critério: quem julga é o módulo puro e testado.
 */
function verdictFor(
  row: SetupDbRow,
  observations: Array<{ at: number; price: number }>,
  now: number,
): { outcome: SetupOutcome; at: number | null; reason: string; ambiguous: boolean } | null {
  /*
   * ROMPIMENTO FALHO FECHA NA HORA, E NUNCA COMO TRADE (§2).
   *
   * Sem esta linha o setup ficaria ABERTO até o prazo vencer e sairia como
   * EXPIRADO — indistinguível de uma aba fechada no meio do pregão. Ele fecha
   * como INVALIDADO com o motivo por escrito: não houve entrada, então não há
   * WIN nem LOSS a contar (o placar só soma WIN+LOSS), e o evento continua no
   * banco para aprendizado. `confirmed_at` é conferido junto porque um setup
   * que JÁ confirmou não volta atrás por causa de um estágio enviado depois.
   */
  if (row.stage === "BREAKOUT_FAILED" && row.confirmed_at === null) {
    return {
      outcome: "INVALIDADO",
      at: row.updated_at,
      reason: "rompimento falhou — o nível foi devolvido antes da sustentação; não houve entrada",
      ambiguous: false,
    };
  }

  if (row.confirmed_at === null) {
    const deadline =
      row.expires_at !== null && row.expires_at > row.created_at ? row.expires_at : null;
    if (deadline === null || now <= deadline) return null;
    return {
      outcome: "EXPIRADO",
      at: deadline,
      reason: "expirou sem confirmação — nunca houve entrada para medir",
      ambiguous: false,
    };
  }

  if (row.stop === null || row.target === null) {
    return {
      outcome: "INVALIDADO",
      at: row.confirmed_at,
      reason: "setup confirmado sem stop/alvo numéricos — sem critério pré-definido, não ensina",
      ambiguous: false,
    };
  }

  const verdict = evaluateSetup(
    {
      direction: row.direction === "VENDA" ? "VENDA" : "COMPRA",
      entry: row.entry,
      stop: row.stop,
      target: row.target,
      confirmedAt: row.confirmed_at,
      expiresAt: row.expires_at ?? 0,
    },
    observations,
    now,
  );
  return verdict.outcome === "ABERTO" ? null : verdict;
}

/** WIN/LOSS ensinam; EXPIRADO e INVALIDADO entram como contexto e ficam FORA
 * da taxa (a memória já trata NEUTRO/INVALIDADO assim). O vocabulário é o
 * MESMO das previsões de print — duas escalas de veredito na mesma memória
 * produziriam duas taxas de acerto para a mesma pergunta. */
const SETUP_OUTCOME_TO_VERDICT: Record<string, string> = {
  WIN: "ACERTOU",
  LOSS: "ERROU",
  EXPIRADO: "NEUTRO",
  INVALIDADO: "INVALIDADO",
};

export interface SetupLearningResult {
  /** Setups fechados que entraram na memória nesta passada. */
  applied: number;
  /** Fechados sem DNA: não têm como ser recuperados por similaridade. */
  withoutDna: number;
}

/**
 * Entrega à memória o resultado dos setups fechados — UMA vez cada.
 *
 * O caminho é o que já existe (DNA → `listMemoryCases` → `queryMemory`): o
 * setup fechado vira caso pelo seu `dna_id`, exatamente como a previsão de
 * print. NÃO existe um segundo mecanismo de aprendizado, e não pode existir:
 * duas contabilidades da mesma evidência dariam duas taxas históricas
 * diferentes para o mesmo setup.
 *
 * A TRAVA: `learned` decide quem a memória enxerga (`listMemoryCases` filtra
 * por `learned=1`), e a marcação acontece na MESMA transação em que o caso é
 * incorporado, com `WHERE learned=0` — rodar duas vezes aplica zero na segunda.
 * Sem isso, um setup contaria como dois casos e a taxa histórica ficaria
 * dobrada em cima de uma única operação real.
 */
export function learnFromClosedSetups(asset: string, now = Date.now()): SetupLearningResult {
  const database = db();
  const fechados = database
    .prepare(
      "SELECT setup_id, dna_id FROM setups WHERE asset=? AND outcome!='ABERTO' AND learned=0",
    )
    .all(asset) as Array<{ setup_id: string; dna_id: string | null }>;
  if (fechados.length === 0) return { applied: 0, withoutDna: 0 };

  const mark = database.prepare(
    "UPDATE setups SET learned=1, updated_at=? WHERE setup_id=? AND learned=0",
  );

  let applied = 0;
  let withoutDna = 0;
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const row of fechados) {
      const changes = Number(mark.run(now, row.setup_id).changes);
      if (changes === 0) continue;
      if (row.dna_id === null) withoutDna += 1;
      else applied += 1;
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return { applied, withoutDna };
}

export interface SetupStats {
  total: number;
  open: number;
  wins: number;
  losses: number;
  expired: number;
  invalidated: number;
  /** Denominador da taxa: só WIN e LOSS provam alguma coisa. */
  decided: number;
  /** null quando nada foi decidido — nunca 0%, que afirmaria derrota total. */
  winRate: number | null;
  sufficient: boolean;
  note: string;
}

/**
 * Placar dos setups do ativo, com a GUARDA DE AMOSTRA MÍNIMA da casa: abaixo de
 * `MIN_EVIDENCE_SAMPLE` a leitura é exibida e a conclusão é NEGADA por escrito.
 * Três vitórias em quatro setups são 75% e não significam nada; sem a frase, o
 * número vira decisão de operação.
 */
export function setupStats(asset?: string): SetupStats {
  const rows = listSetups(asset);
  const count = (outcome: SetupOutcome): number =>
    rows.filter((row) => row.outcome === outcome).length;

  const wins = count("WIN");
  const losses = count("LOSS");
  const decided = wins + losses;
  const sufficient = decided >= MIN_EVIDENCE_SAMPLE;
  return {
    total: rows.length,
    open: count("ABERTO"),
    wins,
    losses,
    expired: count("EXPIRADO"),
    invalidated: count("INVALIDADO"),
    decided,
    winRate: decided === 0 ? null : Number(((wins / decided) * 100).toFixed(1)),
    sufficient,
    note:
      decided === 0
        ? "nenhum setup decidido (WIN/LOSS) ainda — sem taxa a declarar"
        : sufficient
          ? `amostra suficiente (${decided}/${MIN_EVIDENCE_SAMPLE} setups decididos)`
          : `amostra insuficiente (${decided}/${MIN_EVIDENCE_SAMPLE}) — leitura exibida, conclusão NÃO autorizada`,
  };
}

/**
 * Casos da memória: previsões COM veredito, casadas com o DNA da detecção.
 * Erros nunca são filtrados — são tão memória quanto os acertos.
 */
export function listMemoryCases(asset?: string): MemoryCase[] {
  const rows = (
    asset
      ? db()
          .prepare(
            `SELECT p.print_id, p.verdict, p.ambiguous, p.resolved_at, d.payload_json
             FROM print_predictions p JOIN setup_dna d ON d.id = p.dna_id
             WHERE p.verdict != 'PENDENTE' AND p.asset = ? ORDER BY p.predicted_at DESC LIMIT 2000`,
          )
          .all(asset)
      : db()
          .prepare(
            `SELECT p.print_id, p.verdict, p.ambiguous, p.resolved_at, d.payload_json
             FROM print_predictions p JOIN setup_dna d ON d.id = p.dna_id
             WHERE p.verdict != 'PENDENTE' ORDER BY p.predicted_at DESC LIMIT 2000`,
          )
          .all()
  ) as Array<{
    print_id: string;
    verdict: string;
    ambiguous: number;
    resolved_at: number | null;
    payload_json: string;
  }>;
  return [
    ...rows.map((row) => ({
      dna: parse<SetupDna>(row.payload_json),
      verdict: row.verdict as MemoryCase["verdict"],
      ambiguous: row.ambiguous === 1,
      printId: row.print_id,
      resolvedAt: row.resolved_at,
    })),
    ...closedSetupCases(asset),
  ];
}

/**
 * Setups FECHADOS já entregues à memória — a outra metade dos casos.
 *
 * Duas restrições vivem nesta consulta:
 *  1. `learned=1`: só entra o que `learnFromClosedSetups` já incorporou. É o
 *     que faz da coluna uma trava de verdade, e não um enfeite — enquanto ela
 *     for 0, o desfecho existe no banco mas a memória não o conta.
 *  2. o print do setup NÃO pode já ter virado caso pela previsão. O mesmo print
 *     alimentaria a taxa histórica duas vezes, dobrando a evidência de UMA
 *     decisão real. Na dúvida a previsão manda: ela é o caminho antigo e o
 *     histórico já gravado não pode mudar de significado.
 */
function closedSetupCases(asset?: string): MemoryCase[] {
  const clauses = [
    "s.outcome != 'ABERTO'",
    "s.learned = 1",
    "NOT EXISTS (SELECT 1 FROM print_predictions p WHERE p.print_id = s.print_id AND p.verdict != 'PENDENTE')",
  ];
  const params: unknown[] = [];
  if (asset) {
    clauses.push("s.asset = ?");
    params.push(asset);
  }
  const rows = db()
    .prepare(
      `SELECT s.setup_id, s.print_id, s.outcome, s.ambiguous, s.outcome_at, d.payload_json
       FROM setups s JOIN setup_dna d ON d.id = s.dna_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY s.created_at DESC LIMIT 2000`,
    )
    .all(...(params as never[])) as Array<{
    setup_id: string;
    print_id: string | null;
    outcome: string;
    ambiguous: number;
    outcome_at: number | null;
    payload_json: string;
  }>;
  return rows.map((row) => ({
    dna: parse<SetupDna>(row.payload_json),
    verdict: (SETUP_OUTCOME_TO_VERDICT[row.outcome] ?? "INVALIDADO") as MemoryCase["verdict"],
    ambiguous: row.ambiguous === 1,
    // Sem print vinculado o caso ainda tem identidade: a do próprio setup.
    printId: row.print_id ?? row.setup_id,
    resolvedAt: row.outcome_at,
  }));
}

/** DNA de uma detecção pelo id — a memória consulta o caso ATUAL por aqui. */
export function getSetupDna(id: string): SetupDna | null {
  const row = db().prepare("SELECT payload_json, trade_id FROM setup_dna WHERE id=?").get(id) as
    { payload_json: string; trade_id: string | null } | undefined;
  if (!row) return null;
  return { ...parse<SetupDna>(row.payload_json), tradeId: row.trade_id };
}

/* ------------------------------------------------------------------------ *
 * §24 — VENCEDORES × PERDEDORES: hipóteses candidatas geradas da memória
 * ------------------------------------------------------------------------ */

/**
 * Compara os casos resolvidos da memória e transforma fatores que
 * sobre-representam PERDAS em hipóteses CANDIDATAS do Laboratório.
 *
 * O caminho é o único permitido pela regra do operador: memória → hipótese →
 * candidata DISCOVERED → backtest → OOS → walk-forward. NUNCA um filtro
 * aplicado direto na T4 — a candidata nasce, conta como experimento (sobe a
 * régua anti-overfitting) e morre no Laboratório se não provar.
 */
export function generateHypothesesFromMemory(
  baseVersion: string,
  now = Date.now(),
): {
  created: number;
  factors: Array<{ dimension: string; value: string; lift: number }>;
} {
  const cases = listMemoryCases();
  const outcomes: DnaOutcome[] = cases
    .filter((c) => c.verdict === "ACERTOU" || c.verdict === "ERROU")
    .map((c) => ({
      dna: c.dna,
      rMultiple: c.verdict === "ACERTOU" ? 1 : -1,
      mfeR: null,
      maeR: null,
      costR: null,
      resultMoney: null,
    }));
  const factors = lossFactorTableForMemory(outcomes);

  let created = 0;
  for (const factor of factors.slice(0, 3)) {
    const id = `cand_mem_${factor.dimension}_${factor.value}`.toLowerCase();
    const exists = db().prepare("SELECT 1 FROM technique_candidates WHERE id=?").get(id);
    if (exists) continue;
    const hypothesis =
      `Memória: ${factor.dimension}=${factor.value} sobre-representa perdas ` +
      `(lift ${factor.lift.toFixed(2)}). Hipótese: exigir confirmação adicional nesse contexto.`;
    upsertTechniqueCandidate({
      id,
      version: `${baseVersion}-mem-${created + 1}`,
      baseVersion,
      hypothesis,
      status: "DISCOVERED",
      rules: {
        source: "memoria_vencedores_perdedores",
        factor: { dimension: factor.dimension, value: factor.value, lift: factor.lift },
      },
      createdAt: now,
      updatedAt: now,
    });
    insertLabExperiment({
      id: `exp_${id}`,
      baseVersion,
      candidateId: id,
      hypothesis,
      variation: { factor },
      datasetId: null,
      createdAt: now,
    });
    created += 1;
  }
  return {
    created,
    factors: factors.map((f) => ({ dimension: f.dimension, value: f.value, lift: f.lift })),
  };
}

/** lossFactorTable da lib, aplicada aos casos da memória (import local). */
function lossFactorTableForMemory(outcomes: DnaOutcome[]) {
  return lossFactorTable(outcomes, 3);
}

/* ------------------------------------------------------------------------ *
 * T4 AUTO RESEARCH: candles importados e execuções de pesquisa
 * ------------------------------------------------------------------------ */

export function saveImportedCandles(datasetId: string, candles: Candle[]): number {
  const database = db();
  const insert = database.prepare(
    "INSERT OR IGNORE INTO imported_candles(dataset_id, t, o, h, l, c, v) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  database.exec("BEGIN IMMEDIATE");
  try {
    let saved = 0;
    for (const candle of candles) {
      const result = insert.run(
        datasetId,
        candle.t,
        candle.o,
        candle.h,
        candle.l,
        candle.c,
        candle.v,
      );
      saved += Number(result.changes);
    }
    database.exec("COMMIT");
    return saved;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Candles de um dataset importado, do MAIS RECENTE para trás.
 *
 * O teto existia com `ORDER BY t ASC LIMIT 30000`: um CSV de seis meses era
 * importado inteiro e a pesquisa lia só os 30.000 candles MAIS ANTIGOS. O
 * corte "fora da amostra = últimos 15% do período" passava a cair no MEIO do
 * dataset, e o resultado era atribuído ao período inteiro sem nenhum aviso.
 *
 * Agora o recorte é sempre a ponta recente — o lado que interessa para decidir
 * se a técnica funciona HOJE — e o truncamento deixou de ser silencioso:
 * `importedCandleCount` permite ao chamador declarar o corte.
 */
export function loadImportedCandles(datasetId: string, limit = 30_000): Candle[] {
  const recentes = db()
    .prepare(
      "SELECT t, o, h, l, c, v FROM imported_candles WHERE dataset_id=? ORDER BY t DESC LIMIT ?",
    )
    .all(datasetId, limit) as unknown as Candle[];
  // A ordem cronológica é obrigatória para o motor: ele decide candle a candle.
  return recentes.reverse();
}

/** Quantos candles o dataset REALMENTE tem — para detectar truncamento. */
export function importedCandleCount(datasetId: string): number {
  const row = db()
    .prepare("SELECT count(*) AS n FROM imported_candles WHERE dataset_id=?")
    .get(datasetId) as { n: number } | undefined;
  return row === undefined ? 0 : Number(row.n);
}

export function saveResearchRun(run: {
  id: string;
  datasetId: string;
  asset: string;
  techniqueVersion: string;
  metrics: unknown;
  status: string;
}): void {
  db()
    .prepare(
      `
    INSERT INTO research_runs(id, dataset_id, asset, technique_version, created_at, metrics_json, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET metrics_json=excluded.metrics_json, status=excluded.status
  `,
    )
    .run(
      run.id,
      run.datasetId,
      run.asset,
      run.techniqueVersion,
      Date.now(),
      JSON.stringify(run.metrics),
      run.status,
    );
}

/* ------------------------------------------------------------------------ *
 * AUTORIZAÇÃO DE PRODUÇÃO POR ATIVO
 *
 * A permissão de liberar sinal real morava num Map em src/lib/t4/assets.ts:
 * reiniciar o servidor devolvia o ativo ao estado semeado. O que este bloco
 * acrescenta é a trilha persistente — e SÓ ela: quem decide se o ativo pode
 * operar continua sendo `validatedForProduction`, comparando a versão gravada
 * com a versão de produção. É essa comparação que impede a autorização
 * persistida de virar permissão eterna.
 * ------------------------------------------------------------------------ */

function assetAuthorizationFrom(row: unknown): AssetAuthorization {
  const r = row as Record<string, unknown>;
  const techniqueVersion = r["technique_version"];
  const evidenceRef = r["evidence_ref"];
  const revokedAt = r["revoked_at"];
  return {
    symbol: String(r["symbol"]),
    status: String(r["status"]) as AssetValidation,
    techniqueVersion: techniqueVersion == null ? null : String(techniqueVersion),
    evidenceRef: evidenceRef == null ? null : String(evidenceRef),
    grantedAt: Number(r["granted_at"]),
    grantedBy: String(r["granted_by"]),
    revokedAt: revokedAt == null ? null : Number(revokedAt),
  };
}

/**
 * Acrescenta um evento de autorização à trilha do ativo.
 *
 * O evento anterior é ENCERRADO (`revoked_at`), não apagado, e as duas escritas
 * vão na mesma transação: uma falha no meio deixaria o ativo com duas
 * autorizações vigentes — ou com nenhuma, revogando por acidente uma permissão
 * que ninguém mandou revogar.
 */
export function recordAssetAuthorization(authorization: AssetAuthorization): void {
  const symbol = authorization.symbol.trim().toUpperCase();
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare("UPDATE asset_authorizations SET revoked_at=? WHERE symbol=? AND revoked_at IS NULL")
      .run(authorization.grantedAt, symbol);
    database
      .prepare(
        `
      INSERT INTO asset_authorizations(
        symbol, status, technique_version, evidence_ref, granted_at, granted_by, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL)
    `,
      )
      .run(
        symbol,
        authorization.status,
        authorization.techniqueVersion,
        authorization.evidenceRef,
        authorization.grantedAt,
        authorization.grantedBy,
      );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/** Autorizações vigentes — no máximo uma por ativo. */
export function listActiveAssetAuthorizations(): AssetAuthorization[] {
  return db()
    .prepare("SELECT * FROM asset_authorizations WHERE revoked_at IS NULL ORDER BY symbol")
    .all()
    .map(assetAuthorizationFrom);
}

/**
 * Trilha completa, do mais recente ao mais antigo. É o que responde "quem
 * liberou o WIN, quando, contra qual evidência, e quando isso caiu".
 */
export function listAssetAuthorizationTrail(asset?: string): AssetAuthorization[] {
  const symbol = asset?.trim().toUpperCase();
  const sql = symbol
    ? "SELECT * FROM asset_authorizations WHERE symbol=? ORDER BY granted_at DESC, id DESC"
    : "SELECT * FROM asset_authorizations ORDER BY granted_at DESC, id DESC";
  const statement = db().prepare(sql);
  const rows = symbol ? statement.all(symbol) : statement.all();
  return rows.map(assetAuthorizationFrom);
}

/** Implementação SQLite da porta declarada em `src/lib/t4/assets.ts`. */
export function sqliteAssetValidationStore(): AssetValidationStore {
  return {
    readActive: () => listActiveAssetAuthorizations(),
    append: (authorization) => recordAssetAuthorization(authorization),
  };
}

/**
 * Liga a autorização por ativo ao SQLite.
 *
 * Chamada por `db()` na abertura do banco — ou seja, só no servidor. Fica
 * exportada para que teste (e um bootstrap futuro) possam religar a camada sobre
 * o MESMO banco, que é como se simula um reinício de verdade.
 */
export function bindAssetValidationStore(): void {
  setAssetValidationStore(sqliteAssetValidationStore());
}

export function listResearchRuns(): Array<{
  id: string;
  datasetId: string;
  asset: string;
  techniqueVersion: string;
  createdAt: number;
  metrics: unknown;
  status: string;
}> {
  return db()
    .prepare("SELECT * FROM research_runs ORDER BY created_at DESC LIMIT 50")
    .all()
    .map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: String(r["id"]),
        datasetId: String(r["dataset_id"]),
        asset: String(r["asset"]),
        techniqueVersion: String(r["technique_version"]),
        createdAt: Number(r["created_at"]),
        metrics: parse(r["metrics_json"]),
        status: String(r["status"]),
      };
    });
}

/* ------------------------------------------------------------------------ *
 * VALIDAÇÕES OPENAI — histórico idempotente por captura
 * ------------------------------------------------------------------------ */

export interface AiValidationRecord {
  imageHash: string;
  captureId: string;
  candleTime: number;
  t4DecisionJson: string;
  lunaJson: string | null;
  terraJson: string | null;
  latencyMs: number;
  tokens: number;
  costUsd: number | null;
  status: string;
}

/**
 * Grava UMA validação. `INSERT OR IGNORE` na chave (imageHash, candleTime):
 * reprocessar o mesmo print não sobrescreve o histórico — a primeira resposta
 * da IA para aquela captura é a que fica, e é a que o Sol audita.
 * Devolve true quando a linha é NOVA; false quando já existia.
 */
export function saveAiValidation(record: AiValidationRecord): boolean {
  const result = db()
    .prepare(
      `INSERT OR IGNORE INTO ai_validations(
        image_hash, capture_id, candle_time, t4_decision_json, luna_json, terra_json,
        latency_ms, tokens, cost_usd, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.imageHash,
      record.captureId,
      record.candleTime,
      record.t4DecisionJson,
      record.lunaJson,
      record.terraJson,
      record.latencyMs,
      record.tokens,
      record.costUsd,
      record.status,
      Date.now(),
    );
  return Number(result.changes) > 0;
}

export function listAiValidations(limit = 200): Array<AiValidationRecord & { createdAt: number }> {
  const rows = db()
    .prepare(
      `SELECT image_hash, capture_id, candle_time, t4_decision_json, luna_json, terra_json,
              latency_ms, tokens, cost_usd, status, created_at
       FROM ai_validations ORDER BY candle_time DESC LIMIT ?`,
    )
    .all(Math.max(1, Math.min(2_000, limit))) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    imageHash: r["image_hash"] as string,
    captureId: r["capture_id"] as string,
    candleTime: r["candle_time"] as number,
    t4DecisionJson: r["t4_decision_json"] as string,
    lunaJson: (r["luna_json"] as string | null) ?? null,
    terraJson: (r["terra_json"] as string | null) ?? null,
    latencyMs: r["latency_ms"] as number,
    tokens: r["tokens"] as number,
    costUsd: (r["cost_usd"] as number | null) ?? null,
    status: r["status"] as string,
    createdAt: r["created_at"] as number,
  }));
}
