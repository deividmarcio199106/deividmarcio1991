/**
 * MODELO DE DIAGNÓSTICO.
 *
 * Regra que governa este arquivo inteiro: **nenhum módulo aparece verde sem
 * prova**. `proven: false` significa "não consegui testar de verdade" e nunca
 * conta como aprovado — vira WARNING ou SKIPPED, jamais PASS silencioso.
 *
 * "Processo iniciado" não é evidência. Evidência é: a bridge respondeu, o
 * WebSocket entregou, o candle fechou, o provedor de IA devolveu 200.
 */

export type CheckStatus = "PASS" | "WARNING" | "FAIL" | "SKIPPED";

export type DiagnosticDomain =
  | "FRONTEND"
  | "BACKEND"
  | "API"
  | "RTD"
  | "BRIDGE"
  | "WEBSOCKET"
  | "FEED"
  | "TIMESTAMP"
  | "PRICE"
  | "CANDLES"
  | "HISTORY"
  | "T4"
  | "IA"
  | "BANCO"
  | "ENV"
  | "BUILD";

export interface CheckResult {
  id: string;
  domain: DiagnosticDomain;
  label: string;
  status: CheckStatus;
  /** O que foi observado de fato, com números quando existirem. */
  observed: string;
  /** Causa raiz quando identificável; null quando o check não consegue saber. */
  cause: string | null;
  file: string | null;
  line: number | null;
  /** O que quebra na prática se isso não for corrigido. */
  impact: string;
  /** Correção recomendada, concreta. */
  fix: string;
  /**
   * true somente quando houve interação real (resposta HTTP, handshake, dado
   * medido). false = o check não pôde provar nada, e isso aparece no relatório.
   */
  proven: boolean;
  durationMs: number;
}

/**
 * Domínios cujo defeito impede operar. FAIL em qualquer um trava o SCORE
 * abaixo de 100, sem exceção e sem arredondamento generoso.
 */
export const CRITICAL_DOMAINS: DiagnosticDomain[] = [
  "RTD",
  "BRIDGE",
  "WEBSOCKET",
  "FEED",
  "TIMESTAMP",
  "PRICE",
  "CANDLES",
  "HISTORY",
  "T4",
  "BACKEND",
];

export interface DiagnosticsReport {
  generatedAt: number;
  durationMs: number;
  checks: CheckResult[];
  score: number;
  verdict: "PASS" | "WARNING" | "FAIL";
  totals: Record<CheckStatus, number>;
  criticalFailures: string[];
  /** Checks que não puderam ser provados — nunca contam como sucesso. */
  unproven: string[];
}

export function isCritical(check: CheckResult): boolean {
  return CRITICAL_DOMAINS.includes(check.domain);
}

/**
 * SCORE 0–100.
 *
 * Um FAIL crítico limita o teto em 60 e um crítico não provado em 90, mesmo que
 * tudo o mais passe: sem prova do caminho de dado, o número não pode sugerir um
 * sistema pronto. 100 exige todo crítico PASS **e** nenhum FAIL em lugar nenhum.
 */
export function scoreOf(checks: CheckResult[]): number {
  if (checks.length === 0) return 0;

  const considered = checks.filter((check) => check.status !== "SKIPPED");
  if (considered.length === 0) return 0;

  const weight = (check: CheckResult) => (isCritical(check) ? 3 : 1);
  const earned = (check: CheckResult) =>
    check.status === "PASS" ? 1 : check.status === "WARNING" ? 0.5 : 0;

  const totalWeight = considered.reduce((sum, check) => sum + weight(check), 0);
  const earnedWeight = considered.reduce((sum, check) => sum + weight(check) * earned(check), 0);
  let score = Math.round((earnedWeight / totalWeight) * 100);

  const criticals = checks.filter(isCritical);
  if (criticals.some((check) => check.status === "FAIL")) score = Math.min(score, 60);
  else if (criticals.some((check) => check.status !== "PASS")) score = Math.min(score, 90);
  if (checks.some((check) => check.status === "FAIL")) score = Math.min(score, 99);

  return Math.max(0, Math.min(100, score));
}

export function summarize(checks: CheckResult[], durationMs: number): DiagnosticsReport {
  const totals: Record<CheckStatus, number> = { PASS: 0, WARNING: 0, FAIL: 0, SKIPPED: 0 };
  for (const check of checks) totals[check.status] += 1;

  const criticalFailures = checks
    .filter((check) => isCritical(check) && check.status === "FAIL")
    .map((check) => check.id);
  const unproven = checks
    .filter((check) => !check.proven && check.status !== "SKIPPED")
    .map((check) => check.id);

  return {
    generatedAt: Date.now(),
    durationMs,
    checks,
    score: scoreOf(checks),
    verdict: totals.FAIL > 0 ? "FAIL" : totals.WARNING > 0 ? "WARNING" : "PASS",
    totals,
    criticalFailures,
    unproven,
  };
}

/** Construtor com padrões que forçam honestidade: sem prova, não é PASS. */
export function check(input: {
  id: string;
  domain: DiagnosticDomain;
  label: string;
  status: CheckStatus;
  observed: string;
  impact: string;
  fix: string;
  proven?: boolean;
  cause?: string | null;
  file?: string | null;
  line?: number | null;
  durationMs?: number;
}): CheckResult {
  const proven = input.proven ?? false;
  return {
    id: input.id,
    domain: input.domain,
    label: input.label,
    // Um PASS sem prova é rebaixado aqui, não na interpretação de quem lê.
    status: input.status === "PASS" && !proven ? "WARNING" : input.status,
    observed:
      input.status === "PASS" && !proven
        ? `${input.observed} (rebaixado: não houve verificação real)`
        : input.observed,
    cause: input.cause ?? null,
    file: input.file ?? null,
    line: input.line ?? null,
    impact: input.impact,
    fix: input.fix,
    proven,
    durationMs: input.durationMs ?? 0,
  };
}
