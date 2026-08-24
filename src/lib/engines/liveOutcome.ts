import {
  FIRST_EXIT_FRACTION,
  PARTIAL_EXIT_FRACTION,
  PROTECT_AFTER_R,
  PROFIT_LOCK_R,
  RUNNER_EXIT_FRACTION,
  RUNNER_TRAIL_START_R,
  SECOND_EXIT_FRACTION,
} from "./strategy";
import { computeMfeMae } from "./financialRisk";
import type { Candle } from "./types";

/**
 * Rastreador causal do desfecho. Por padrão preserva o modo legado de 2 alvos.
 * T4 ativa `threeContractRunner`: 1 contrato em 3R, 1 em 5R e 1 runner.
 */
export type OperationStatus =
  | "AGUARDANDO ENTRADA"
  | "ENTRADA ATINGIDA"
  | "EM OPERAÇÃO"
  | "PARCIAL ATINGIDA"
  | "ALVO 2 ATINGIDO"
  | "RUNNER ATIVO"
  | "RUNNER ENCERRADO"
  | "STOP ATINGIDO"
  | "ALVO ATINGIDO"
  | "EXPIRADA"
  | "ENCERRADA";

export interface LiveOperationResult {
  status: OperationStatus;
  done: boolean;
  filled: boolean;
  result: "GANHO" | "PERDA" | "NEUTRO" | null;
  rMultiple: number | null;
  exit: number | null;
  mfePoints: number | null;
  maePoints: number | null;
  mfeR: number | null;
  maeR: number | null;
  candlesObserved: number;
  detail: string;
  ambiguousIntrabar: boolean;
  exitReason: string | null;
  entryHitAt: number | null;
  partialHitAt: number | null;
  exitAt: number | null;
  protectedStop: number | null;
  runnerActive: boolean;
}

export interface OutcomeTrackerOptions {
  threeContractRunner?: boolean;
  protectAfterR?: number;
  profitLockR?: number;
  runnerTrailStartR?: number;
  runnerLookbackBars?: number;
}

export class LiveOutcomeTracker {
  private filled = false;
  private partialHit = false;
  private secondTargetHit = false;
  private done = false;
  private waited = 0;
  private afterFill: Candle[] = [];
  private ambiguousIntrabar = false;
  private last: LiveOperationResult;
  private readonly stopDistance: number;
  private readonly rr1: number;
  private readonly rr2: number;
  private entryHitAt: number | null = null;
  private partialHitAt: number | null = null;
  private exitAt: number | null = null;
  private dynamicStop: number;
  private protected = false;
  private readonly runnerMode: boolean;
  private readonly protectAfterR: number;
  private readonly profitLockR: number;
  private readonly runnerTrailStartR: number;
  private readonly runnerLookbackBars: number;

  constructor(
    private readonly direction: "COMPRA" | "VENDA",
    private readonly entry: number,
    private readonly stop: number,
    private readonly partial: number,
    private readonly target: number,
    private readonly maxWaitBars = 10,
    options: OutcomeTrackerOptions = {},
  ) {
    this.stopDistance = Math.abs(entry - stop);
    this.rr1 = this.stopDistance > 0 ? Math.abs(partial - entry) / this.stopDistance : 0;
    this.rr2 = this.stopDistance > 0 ? Math.abs(target - entry) / this.stopDistance : 0;
    this.dynamicStop = stop;
    this.runnerMode = options.threeContractRunner === true;
    this.protectAfterR = options.protectAfterR ?? PROTECT_AFTER_R;
    this.profitLockR = options.profitLockR ?? PROFIT_LOCK_R;
    this.runnerTrailStartR = options.runnerTrailStartR ?? RUNNER_TRAIL_START_R;
    this.runnerLookbackBars = Math.max(2, options.runnerLookbackBars ?? 3);
    this.last = this.snapshot(
      "AGUARDANDO ENTRADA",
      null,
      null,
      "Aguardando o preço executar a entrada.",
    );
  }

  current(): LiveOperationResult {
    return this.last;
  }

  /** Alimente somente com candles fechados, em ordem. Stop vence ambiguidade intrabar. */
  push(candle: Candle): LiveOperationResult {
    if (this.done || this.stopDistance <= 0) return this.last;

    let justFilled = false;
    if (!this.filled) {
      this.waited++;
      if (candle.l <= this.entry && this.entry <= candle.h) {
        this.filled = true;
        justFilled = true;
        this.entryHitAt = candle.t;
      } else if (this.waited >= this.maxWaitBars) {
        this.done = true;
        this.exitAt = candle.t;
        this.last = this.snapshot(
          "EXPIRADA",
          "NEUTRO",
          0,
          `Entrada não executada em ${this.maxWaitBars} candles — sinal expirou sem operação.`,
          this.entry,
          "expirada_sem_execucao",
        );
        return this.last;
      } else {
        this.last = this.snapshot(
          "AGUARDANDO ENTRADA",
          null,
          null,
          `Aguardando execução (${this.waited}/${this.maxWaitBars} candles).`,
        );
        return this.last;
      }
    }

    this.afterFill.push(candle);
    const dir = this.direction === "COMPRA" ? 1 : -1;
    const favorableExtreme = dir > 0 ? candle.h : candle.l;
    const favorableR = ((favorableExtreme - this.entry) * dir) / this.stopDistance;

    // Proteção só passa a valer DEPOIS de o mercado ter mostrado 3,5R. Para o
    // mesmo candle em que isso acontece, o stop antigo ainda vence a ambiguidade.
    const stopHit = dir > 0 ? candle.l <= this.dynamicStop : candle.h >= this.dynamicStop;
    const partialTouched = dir > 0 ? candle.h >= this.partial : candle.l <= this.partial;
    const targetTouched = dir > 0 ? candle.h >= this.target : candle.l <= this.target;

    if (stopHit) {
      this.ambiguousIntrabar = targetTouched || partialTouched;
      const stopR = ((this.dynamicStop - this.entry) * dir) / this.stopDistance;
      let r = stopR;
      let detail = "Stop estrutural atingido antes da parcial.";
      if (this.runnerMode) {
        if (this.secondTargetHit) {
          r =
            this.rr1 * FIRST_EXIT_FRACTION +
            this.rr2 * SECOND_EXIT_FRACTION +
            stopR * RUNNER_EXIT_FRACTION;
          detail = "3R e 5R realizados; runner encerrado pelo stop estrutural móvel.";
        } else if (this.partialHit) {
          r =
            this.rr1 * FIRST_EXIT_FRACTION + stopR * (SECOND_EXIT_FRACTION + RUNNER_EXIT_FRACTION);
          detail = this.protected
            ? "Parcial em 3R realizada; dois contratos restantes encerrados na proteção."
            : "Parcial em 3R realizada; dois contratos restantes estopados.";
        }
      } else if (this.partialHit) {
        r = this.rr1 * PARTIAL_EXIT_FRACTION - (1 - PARTIAL_EXIT_FRACTION);
        detail = "Parcial realizada; restante estopado.";
      }
      this.done = true;
      this.exitAt = candle.t;
      this.last = this.snapshot(
        this.runnerMode && this.secondTargetHit ? "RUNNER ENCERRADO" : "STOP ATINGIDO",
        r > 0 ? "GANHO" : "PERDA",
        r,
        detail,
        this.dynamicStop,
        this.runnerMode && this.secondTargetHit ? "runner_stop" : "stop",
      );
      return this.last;
    }

    if (this.runnerMode) {
      // Primeiro contrato: 3R. Segundo: 5R. O runner permanece aberto.
      if (partialTouched && !this.partialHit) {
        this.partialHit = true;
        this.partialHitAt = candle.t;
      }
      if (targetTouched && this.partialHit && !this.secondTargetHit) {
        this.secondTargetHit = true;
      }

      // Proteção entra apenas após sobreviver ao candle que alcançou o limiar.
      if (!this.protected && favorableR >= this.protectAfterR) {
        this.protected = true;
        const lock = this.entry + dir * this.profitLockR * this.stopDistance;
        this.dynamicStop =
          dir > 0 ? Math.max(this.dynamicStop, lock) : Math.min(this.dynamicStop, lock);
      }

      // Após 5R, runner usa pivô dos candles ANTERIORES; nunca o candle atual
      // para criar e executar um trailing stop retroativo.
      if (this.secondTargetHit && favorableR >= this.runnerTrailStartR) {
        const history = this.afterFill.slice(0, -1).slice(-this.runnerLookbackBars);
        if (history.length >= 2) {
          const pivot =
            dir > 0
              ? Math.min(...history.map((bar) => bar.l))
              : Math.max(...history.map((bar) => bar.h));
          this.dynamicStop =
            dir > 0 ? Math.max(this.dynamicStop, pivot) : Math.min(this.dynamicStop, pivot);
        }
      }

      if (this.secondTargetHit) {
        this.last = this.snapshot(
          "RUNNER ATIVO",
          null,
          null,
          `1º contrato realizado em ${this.rr1.toFixed(1)}R, 2º em ${this.rr2.toFixed(1)}R; 3º contrato em runner estrutural.`,
        );
        return this.last;
      }
      if (this.partialHit) {
        this.last = this.snapshot(
          "PARCIAL ATINGIDA",
          null,
          null,
          `1º contrato realizado em ${this.rr1.toFixed(1)}R; aguardando 5R e runner.`,
        );
        return this.last;
      }
    } else {
      if (targetTouched && this.partialHit) {
        const r = this.rr1 * PARTIAL_EXIT_FRACTION + this.rr2 * (1 - PARTIAL_EXIT_FRACTION);
        this.done = true;
        this.exitAt = candle.t;
        this.last = this.snapshot(
          "ALVO ATINGIDO",
          "GANHO",
          r,
          "Parcial e alvo final atingidos.",
          this.target,
          "alvo",
        );
        return this.last;
      }
      if (partialTouched && !this.partialHit) {
        this.partialHit = true;
        this.partialHitAt = candle.t;
        this.last = this.snapshot(
          "PARCIAL ATINGIDA",
          null,
          null,
          "Parcial realizada; restante rumo ao alvo.",
        );
        return this.last;
      }
    }

    this.last = this.snapshot(
      justFilled ? "ENTRADA ATINGIDA" : "EM OPERAÇÃO",
      null,
      null,
      justFilled ? "Entrada executada; operação iniciada." : "Operação em andamento.",
    );
    return this.last;
  }

  private snapshot(
    status: OperationStatus,
    result: LiveOperationResult["result"],
    rMultiple: number | null,
    detail: string,
    exit: number | null = null,
    exitReason: string | null = null,
  ): LiveOperationResult {
    const mfeMae =
      this.afterFill.length > 0
        ? computeMfeMae(this.direction, this.entry, this.afterFill, this.stopDistance)
        : null;
    return {
      status,
      done: this.done,
      filled: this.filled,
      result,
      rMultiple: rMultiple !== null ? Number(rMultiple.toFixed(3)) : null,
      exit,
      mfePoints: mfeMae?.mfePoints ?? null,
      maePoints: mfeMae?.maePoints ?? null,
      mfeR: mfeMae?.mfeR ?? null,
      maeR: mfeMae?.maeR ?? null,
      candlesObserved: this.afterFill.length,
      detail,
      ambiguousIntrabar: this.ambiguousIntrabar,
      exitReason,
      entryHitAt: this.entryHitAt,
      partialHitAt: this.partialHitAt,
      exitAt: this.exitAt,
      protectedStop: this.protected ? this.dynamicStop : null,
      runnerActive: this.runnerMode && this.secondTargetHit && !this.done,
    };
  }
}
