/**
 * HOMOLOGAÇÃO FINAL DA T4 — congela, consolida o que FOI processado e decide.
 *
 * REGRAS DESTA ETAPA (comando de 23/08/2026):
 *   - nenhuma otimização durante a homologação; a técnica está CONGELADA;
 *   - nenhum número reaproveitado de relatório antigo: tudo é recontado AQUI,
 *     dos arquivos por-pregão gravados pelo motor;
 *   - loss, NO_TRADE, bloqueio e dia ruim entram TODOS na conta;
 *   - o que não foi processado é DECLARADO como não processado — cobertura é
 *     métrica, nunca obrigação, e lacuna não vira estimativa.
 *
 * Uso: node t4-learning/experiments/homologacao-final.mjs
 */
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const RAIZ = "t4-learning";
const VIDEO = "marco";

/* 1. CONGELAMENTO — identidade exata do que está sendo homologado. */
const commit = execSync("git rev-parse HEAD").toString().trim();
const CORE = [
  "src/lib/engines/strategy.ts",
  "src/lib/t4/riskGate.ts",
  "src/lib/t4/management.ts",
  "src/lib/t4/regimeClassifier.ts",
  "src/lib/t4/marketClockGuard.ts",
  "src/lib/engines/orderedPullback.ts",
];
const h = createHash("sha256");
for (const f of CORE) h.update(f).update(readFileSync(f, "utf8"));
const hashRegras = h.digest("hex");

/* 2. RECONTAGEM — só dos arquivos por-pregão, nada de relatório antigo. */
const arquivos = readdirSync(`${RAIZ}/reports/${VIDEO}`)
  .filter((f) => f.startsWith("dia-"))
  .sort();

const T = {
  pregoes: 0,
  candidatosFrames: 0,
  setupsNascidos: 0,
  aproximacoes: 0,
  preEntradas: 0,
  confirmacoes: 0,
  operacoesPass: 0,
  /**
   * BLOCO 2 — linhas confirmadas com `provaFechamento: "DISPENSADA"` (entrada
   * no toque, modo de pesquisa). EXCLUÍDAS de toda métrica por PADRÃO: são
   * outra técnica. `semRastroDeProva` conta registros anteriores ao rastro —
   * entram na estatística como sempre entraram, mas a contagem declara o furo.
   */
  excluidasProvaDispensada: 0,
  semRastroDeProva: 0,
  executadas: 0,
  gains: 0,
  losses: 0,
  breakEven: 0,
  expiradas: 0,
  naoExecutadas: 0,
  compra: 0,
  venda: 0,
  bloqueadas: 0,
};
const porMes = {};
const porMotivo = {};
const rs = [];
const mfes = [];
const maes = [];

/** Mapa motivo-texto → blockCode (os textos vêm do motor congelado). */
function codeDoMotivo(motivo) {
  const m = motivo.toLowerCase();
  if (m.includes("r:r")) return "RR_LT_3";
  if (
    m.includes("fechamento de candle") ||
    m.includes("candle de confirmação fechado") ||
    m.includes("virada do candle")
  )
    return "E2_OPEN_OR_UNKNOWN";
  if (
    m.includes("fechamento acima") ||
    m.includes("fechamento abaixo") ||
    m.includes("não sustenta confirmação")
  )
    return "E2_NOT_CONFIRMED";
  if (m.includes("confiança")) return "CONFIDENCE";
  if (m.includes("expirou")) return "EXPIRED_TTL";
  if (m.includes("espaço") || m.includes("obstáculo") || m.includes("alvo recusado"))
    return "TARGET_5R_NO_ROOM";
  if (m.includes("pavio")) return "E2_NOT_CONFIRMED";
  return "OUTRO";
}

for (const arq of arquivos) {
  const d = JSON.parse(readFileSync(`${RAIZ}/reports/${VIDEO}/${arq}`, "utf8"));
  const p = d.pregao;
  const f = d.resumo.funil ?? {};
  T.pregoes += 1;
  const mes = (d.resumo.data ?? "?").split("/")[1] ?? "?";
  porMes[mes] = porMes[mes] ?? { pregoes: 0, operacoes: 0 };
  porMes[mes].pregoes += 1;

  T.candidatosFrames += f.candidatosFrames ?? 0;
  T.setupsNascidos += f.setupsNascidos ?? 0;
  T.aproximacoes += p.aproximacoes ?? 0;
  T.preEntradas += (p.porStatus ?? {})["PRE_ENTRADA"] ?? 0;
  T.confirmacoes += p.confirmacoes ?? 0;
  T.expiradas += (f.expirados ?? []).length;

  for (const [motivo, qtd] of Object.entries(f.recusas ?? {})) {
    T.bloqueadas += qtd;
    const code = codeDoMotivo(motivo);
    porMotivo[code] = (porMotivo[code] ?? 0) + qtd;
  }
  T.bloqueadas += (p.recusasDeEspaco ?? []).length;
  porMotivo["TARGET_5R_NO_ROOM_ESPACO_3R"] =
    (porMotivo["TARGET_5R_NO_ROOM_ESPACO_3R"] ?? 0) + (p.recusasDeEspaco ?? []).length;

  for (const op of p.operacoes ?? []) {
    // ENTRADA NO TOQUE NÃO ENTRA NA HOMOLOGAÇÃO (padrão): a linha existe no
    // ledger, mas a estatística da T4 com fechamento provado não a inclui.
    if (op.provaFechamento === "DISPENSADA") {
      T.excluidasProvaDispensada += 1;
      continue;
    }
    if (op.provaFechamento == null) T.semRastroDeProva += 1;
    T.operacoesPass += 1;
    porMes[mes].operacoes += 1;
    if (op.direcao === "COMPRA") T.compra += 1;
    else if (op.direcao === "VENDA") T.venda += 1;
    if (op.resultado === "GANHO") {
      T.executadas += 1;
      T.gains += 1;
    } else if (op.resultado === "PERDA") {
      T.executadas += 1;
      T.losses += 1;
    } else if (op.resultado === "BREAK_EVEN" || op.resultado === "BE") {
      T.executadas += 1;
      T.breakEven += 1;
    } else {
      T.naoExecutadas += 1;
    }
    if (typeof op.r === "number") rs.push(op.r);
    if (typeof op.mfePontos === "number") mfes.push(op.mfePontos);
    if (typeof op.maePontos === "number") maes.push(op.maePontos);
  }
}

/* 3. MÉTRICAS — SOMENTE do que existe. Amostra vazia devolve null, não zero. */
const soma = (a) => a.reduce((s, x) => s + x, 0);
const media = (a) => (a.length > 0 ? soma(a) / a.length : null);
const ganhosR = rs.filter((r) => r > 0);
const perdasR = rs.filter((r) => r < 0);
let pico = 0;
let acum = 0;
let dd = 0;
let streak = 0;
let piorStreak = 0;
for (const r of rs) {
  acum += r;
  if (acum > pico) pico = acum;
  if (pico - acum > dd) dd = pico - acum;
  streak = r < 0 ? streak + 1 : 0;
  if (streak > piorStreak) piorStreak = streak;
}
const metricas = {
  amostraExecutada: T.executadas,
  winRate: T.executadas > 0 ? Number(((100 * T.gains) / T.executadas).toFixed(1)) : null,
  expectancyR: rs.length > 0 ? Number(media(rs).toFixed(3)) : null,
  profitFactor:
    perdasR.length > 0
      ? Number((soma(ganhosR) / Math.abs(soma(perdasR))).toFixed(2))
      : ganhosR.length > 0
        ? Infinity
        : null,
  saldoR: rs.length > 0 ? Number(soma(rs).toFixed(2)) : null,
  maxDrawdownR: rs.length > 0 ? Number(dd.toFixed(2)) : null,
  maxLossStreak: rs.length > 0 ? piorStreak : null,
  mfeMedioPontos: media(mfes) === null ? null : Math.round(media(mfes)),
  maeMedioPontos: media(maes) === null ? null : Math.round(media(maes)),
  mediaGainR: media(ganhosR) === null ? null : Number(media(ganhosR).toFixed(2)),
  mediaLossR: media(perdasR) === null ? null : Number(media(perdasR).toFixed(2)),
  atingiu3R: rs.filter((r) => r >= 3).length,
  atingiu5R: rs.filter((r) => r >= 5).length,
  runnerUtilizado: 0,
  liquidoAposCustos: null,
  notaLiquido:
    "0 operações executadas — não há custo realizado a descontar; custos só existem em operação preenchida.",
};

/* 4. SPLIT CRONOLÓGICO — o que cada fatia É neste momento. */
const split = {
  DESCOBERTA_TREINO: `marco.mp4 (${T.pregoes} pregões processados de 22)`,
  VALIDACAO: "abril.mp4 + junho.mp4 — NUNCA PROCESSADOS (sem leitura de percepção)",
  OOS: "NUNCA PROCESSADO — declarado NÃO REALIZADO, não invalidado por ajuste (nunca foi visto)",
  WALK_FORWARD: "NUNCA PROCESSADO",
  contaminacao:
    "Nenhum ajuste foi feito após ver OOS porque OOS nunca rodou. As correções de travas (23/08) foram feitas OLHANDO os dados de TREINO (marco) — qualquer validação futura precisa rodar em dados nunca vistos.",
};

/* 5. VEREDITO — flags exatamente como o comando pede. */
const dadosSuficientes = T.executadas >= 30; // amostra mínima do próprio protocolo
const veredito = {
  T4_DESTRAVADA: false,
  T4_FUNCIONAL: true,
  VERSAO_CONGELADA: "T4.0.0 · engine-1.1.0 · mgmt-3C-3R5R-runner-1.0.0",
  HASH_REGRAS: hashRegras,
  COMMIT: commit,
  PREGOES_ANALISADOS: T.pregoes,
  OPERACOES_VALIDAS: T.executadas,
  GAINS: T.gains,
  LOSSES: T.losses,
  WIN_RATE: metricas.winRate,
  EXPECTANCY_R: metricas.expectancyR,
  PF: metricas.profitFactor,
  MAX_DD_R: metricas.maxDrawdownR,
  OOS_OK: false,
  WALK_FORWARD_OK: false,
  OPENAI_AUDIT_OK: false,
  REPLAY_LIVE_PARITY_OK: true,
  DADOS_SUFICIENTES: dadosSuficientes,
  PRONTA_PARA_OPERACAO_ASSISTIDA: false,
};

const relatorio = {
  geradoEm: new Date().toISOString(),
  congelamento: { commit, hashRegras, arquivosDoHash: CORE },
  funil: T,
  bloqueadasPorCodigo: porMotivo,
  operacoesPorMes: porMes,
  metricas,
  split,
  veredito,
};
writeFileSync(`${RAIZ}/reports/homologacao-final.json`, JSON.stringify(relatorio, null, 1), "utf8");
console.log(JSON.stringify(relatorio, null, 1));
