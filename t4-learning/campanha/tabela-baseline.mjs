/**
 * A TABELA DO BASELINE — item 11 do comando da campanha, gerada dos relatorios.
 *
 * Read-only: le reports/<video>/dia-*.json e devolve a tabela diaria
 * (DATA | OPEROU? | TRADES | GAIN | LOSS | PONTOS | R | SPACE_LT_3R | MOTIVO)
 * e o consolidado com PF, expectancy, drawdown e MFE/MAE. O motivo de cada
 * NO_TRADE e o gate DOMINANTE medido naquele dia — nunca "nao houve trade".
 *
 * Uso: node t4-learning/campanha/tabela-baseline.mjs [video]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

const RAIZ = "t4-learning";
const VIDEO = process.argv[2] ?? "marco";
const DIR = `${RAIZ}/reports/${VIDEO}`;

if (!existsSync(DIR)) {
  console.error(`sem relatorios em ${DIR}`);
  process.exit(1);
}
const arquivos = readdirSync(DIR)
  .filter((f) => /^dia-\d+\.json$/.test(f))
  .sort();

/** O gate dominante de um dia sem operacao — numerico, nunca vago. */
function motivoNoTrade(resumo, pregao) {
  if (resumo.estado === "AMBIGUOUS") return "FRONTEIRA_AMBIGUA (trecho isolado)";
  if (resumo.erro) return `ERRO: ${String(resumo.erro).slice(0, 60)}`;
  const f = resumo.funil ?? {};
  if ((f.framesComPreco ?? 0) === 0) return "SEM_PRECO: regua nao calibrou no dia";
  if ((f.candidatosFrames ?? 0) === 0)
    return "SEM_CANDIDATOS: preco nunca chegou perto de nivel conhecido";
  if ((f.setupsNascidos ?? 0) === 0)
    return `SEM_SETUP: ${f.chamadasDeModelo ?? 0} leituras nao viram estrutura operavel`;
  const recusas = pregao?.recusasDeEspaco ?? [];
  if (recusas.length > 0) {
    const max = Math.max(...recusas.map((r) => r.distanciaR ?? 0));
    return `SPACE_LT_3R: ${recusas.length} recusas, melhor espaco ${max.toFixed(1)}R`;
  }
  const pendencias = Object.entries(f.recusas ?? {}).sort((a, b) => b[1] - a[1]);
  if (pendencias.length > 0) return `GATE: ${pendencias[0][0].slice(0, 70)}`;
  return "SETUPS_NAO_ARMARAM: nenhum toque na zona dentro da validade";
}

const linhas = [];
const ops = [];
let setups = 0,
  confirmacoes = 0,
  chamadas = 0,
  recusasEspacoTotal = 0;
const recusasPorGate = {};
let ambiguos = 0,
  falhos = 0;

for (const arq of arquivos) {
  const d = JSON.parse(readFileSync(`${DIR}/${arq}`, "utf8"));
  const r = d.resumo;
  if (r.estado === "AMBIGUOUS") {
    ambiguos++;
    linhas.push({
      dia: r.dia,
      data: r.data ?? "?",
      operou: "AMBIGUO",
      trades: 0,
      gain: 0,
      loss: 0,
      pontos: 0,
      R: 0,
      space: 0,
      motivo: motivoNoTrade(r, d.pregao),
    });
    continue;
  }
  if (r.erro) falhos++;
  setups += r.funil?.setupsNascidos ?? 0;
  confirmacoes += r.confirmacoes ?? 0;
  chamadas += r.funil?.chamadasDeModelo ?? 0;
  recusasEspacoTotal += r.recusasComForense ?? 0;
  for (const [k, v] of Object.entries(r.funil?.recusas ?? {}))
    recusasPorGate[k] = (recusasPorGate[k] ?? 0) + v;
  for (const op of d.pregao?.operacoes ?? []) ops.push({ dia: r.dia, ...op });
  linhas.push({
    dia: r.dia,
    data: r.data ?? "?",
    operou: (r.operacoes ?? 0) > 0 ? "SIM" : "NAO",
    trades: r.operacoes ?? 0,
    gain: r.ganhos ?? 0,
    loss: r.perdas ?? 0,
    pontos: Math.round(r.pontos ?? 0),
    R: Number((r.somaR ?? 0).toFixed(2)),
    space: r.recusasComForense ?? 0,
    motivo: (r.operacoes ?? 0) > 0 ? "-" : motivoNoTrade(r, d.pregao),
  });
}

// Metricas de carteira sobre a sequencia REAL de operacoes.
const fechadas = ops.filter((o) => ["GANHO", "PERDA", "NEUTRO"].includes(o.resultado));
const rs = fechadas.map((o) => o.r ?? 0);
const ganhosR = rs.filter((x) => x > 0).reduce((a, b) => a + b, 0);
const perdasR = Math.abs(rs.filter((x) => x < 0).reduce((a, b) => a + b, 0));
let pico = 0,
  acum = 0,
  dd = 0;
for (const x of rs) {
  acum += x;
  if (acum > pico) pico = acum;
  if (pico - acum > dd) dd = pico - acum;
}
const mediana = (a) => {
  if (a.length === 0) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

const consolidado = {
  video: VIDEO,
  pregoes: linhas.length,
  ambiguos,
  falhos,
  diasOperados: linhas.filter((l) => l.operou === "SIM").length,
  diasSemOperacao: linhas.filter((l) => l.operou === "NAO").length,
  coberturaPct: Number(
    ((100 * linhas.filter((l) => l.operou === "SIM").length) / Math.max(1, linhas.length)).toFixed(
      1,
    ),
  ),
  chamadasDeModelo: chamadas,
  setups,
  confirmacoes,
  trades: fechadas.length,
  ganhos: rs.filter((x) => x > 0).length,
  perdas: rs.filter((x) => x < 0).length,
  winRatePct:
    fechadas.length > 0
      ? Number(((100 * rs.filter((x) => x > 0).length) / fechadas.length).toFixed(1))
      : null,
  pontosLiquidos: Math.round(fechadas.reduce((a, o) => a + (o.pontos ?? 0), 0)),
  somaR: Number(rs.reduce((a, b) => a + b, 0).toFixed(2)),
  profitFactor:
    perdasR > 0 ? Number((ganhosR / perdasR).toFixed(2)) : ganhosR > 0 ? Infinity : null,
  expectancyR:
    fechadas.length > 0
      ? Number((rs.reduce((a, b) => a + b, 0) / fechadas.length).toFixed(3))
      : null,
  maxDrawdownR: Number(dd.toFixed(2)),
  mfeMedianoPts: mediana(
    fechadas.map((o) => o.mfePontos).filter((x) => x !== null && x !== undefined),
  ),
  maeMedianoPts: mediana(
    fechadas.map((o) => o.maePontos).filter((x) => x !== null && x !== undefined),
  ),
  recusasEspaco: recusasEspacoTotal,
  recusasPorGate,
  resultadoBrutoReais: Number(
    (fechadas.reduce((a, o) => a + (o.pontos ?? 0), 0) * 0.2 * 3).toFixed(2),
  ),
  aviso:
    "SIMULACAO SEM CUSTOS — pontos em media ponderada por contrato (pernas 3R/5R/runner); R$ = pontos x 0,20 x 3",
};

/*
 * R$ e SALDO: os pontos do LiveOutcomeTracker ja sao a MEDIA PONDERADA por
 * contrato (parcial 3R, alvo 5R e runner entram no blend), entao
 * R$ = pontos x 0,20 x 3 contratos respeita as pernas. SIMULACAO SEM CUSTOS.
 */
const VALOR_POR_PONTO_POSICAO = 0.2 * 3;
let saldo = 0;
console.log(`\n=== BASELINE ${VIDEO.toUpperCase()} — TABELA DIARIA (SIMULACAO SEM CUSTOS) ===`);
console.log(
  "DIA | DATA | OPEROU | TRADES | GAIN | LOSS | PONTOS | R | R$DIA | SALDO_R$ | SPACE_LT_3R | MOTIVO",
);
for (const l of linhas) {
  const reaisDia = l.pontos * VALOR_POR_PONTO_POSICAO;
  saldo += reaisDia;
  l.reaisDia = Number(reaisDia.toFixed(2));
  l.saldoAcumulado = Number(saldo.toFixed(2));
  console.log(
    `${String(l.dia).padStart(3)} | ${String(l.data).padEnd(7)} | ${l.operou.padEnd(7)} | ${String(l.trades).padStart(2)} | ${String(l.gain).padStart(2)} | ${String(l.loss).padStart(2)} | ${String(l.pontos).padStart(6)} | ${String(l.R).padStart(6)} | ${String(l.reaisDia.toFixed(0)).padStart(6)} | ${String(l.saldoAcumulado.toFixed(0)).padStart(8)} | ${String(l.space).padStart(3)} | ${l.motivo}`,
  );
}
console.log("\n=== CONSOLIDADO ===");
console.log(JSON.stringify(consolidado, null, 1));
writeFileSync(
  `${RAIZ}/reports/${VIDEO}-tabela-baseline.json`,
  JSON.stringify({ linhas, consolidado }, null, 1),
  "utf8",
);
