/**
 * CONGELA O BASELINE DE MARCO — depois disto, nenhum numero baseline pode ser
 * recalculado em silencio com codigo ou configuracao diferente.
 *
 * O congelamento grava HASHES de tudo que define o resultado:
 *   datasetHash  — a serie varrida (mesmos frames, mesma regua);
 *   motorHash    — os arquivos-fonte que definem a semantica (funil, regua,
 *                  maquina de setup, gate de risco, gestao, tecnica);
 *   runnerHash   — o executor do baseline (config dos dias);
 *   configHash   — a configuracao efetiva, canonica, campo a campo;
 *   baselineHash — os relatorios diarios + agregado;
 *   commitHash   — o commit do repositorio no instante do congelamento.
 *
 * Toda comparacao H1/H2/H1_H2 e obrigada a referenciar estes hashes. Se
 * QUALQUER um divergir no momento do experimento, o experimento e
 * INVALID_COMPARISON e os DOIS lados precisam ser refeitos.
 *
 * Uso: node t4-learning/experiments/congelar-baseline.mjs
 */
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";

const RAIZ = "t4-learning";
// Qual video congelar vem do ambiente — o congelador e um so para a campanha.
const VIDEO = process.env["VIDEO_FREEZE"] ?? "marco";
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const shaArquivo = (p) => sha(readFileSync(p));

/* ------------------------- pre-condicoes de honestidade ------------------- */

// READ_ONLY: um baseline congelado NUNCA e sobrescrito — correcao gera v2.
const saidaCongelada = `${RAIZ}/reports/baseline-${VIDEO}-frozen.json`;
if (existsSync(saidaCongelada)) {
  console.error("ABORTADO: baseline-" + VIDEO + "-frozen.json ja existe e e READ_ONLY.");
  console.error(
    "Correcao posterior deve gerar baseline-" + VIDEO + "-v2-frozen.json — nunca alterar v1.",
  );
  process.exit(1);
}

const agregadoPath = `${RAIZ}/reports/${VIDEO}/agregado.json`;
if (!existsSync(agregadoPath)) {
  console.error("ABORTADO: agregado.json ainda nao existe — o baseline nao terminou.");
  process.exit(1);
}
const sujos = execSync("git status --porcelain -- src/", { encoding: "utf8" })
  .split("\n")
  .filter((l) => l.trim() !== "" && !/\.temp\.test\.ts$/.test(l));
if (sujos.length > 0) {
  console.error("ABORTADO: ha mudancas nao commitadas no motor — o commitHash mentiria:");
  sujos.forEach((l) => console.error("  " + l));
  process.exit(1);
}

/* --------------------------------- hashes --------------------------------- */

const MOTOR = [
  "src/server/video/pregao.ts",
  "src/server/video/leituraLedger.ts",
  "src/server/video/varredura.ts",
  "src/server/video/calibration.ts",
  "src/server/video/frames.ts",
  "src/lib/print/setupTracker.ts",
  "src/lib/t4/riskGate.ts",
  "src/lib/engines/liveOutcome.ts",
  "src/lib/engines/strategy.ts",
  "src/lib/vision/priceScale.ts",
  "src/lib/vision/printAnalysis.ts",
];
const motorHashes = Object.fromEntries(MOTOR.map((p) => [p, shaArquivo(p)]));
const motorHash = sha(Object.values(motorHashes).join("\n"));

const datasetHash = shaArquivo(`${RAIZ}/dataset/${VIDEO}/varredura-mes.json`);
const runnerHash = shaArquivo("src/server/video/dias.temp.test.ts");

const diasArquivos = readdirSync(`${RAIZ}/reports/marco`)
  .filter((f) => /^dia-\d+\.json$/.test(f))
  .sort();
const diasHashes = Object.fromEntries(
  diasArquivos.map((f) => [f, shaArquivo(`${RAIZ}/reports/${VIDEO}/${f}`)]),
);
const baselineHash = sha(Object.values(diasHashes).join("\n") + shaArquivo(agregadoPath));

const commitHash = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();

/* ---------------- proveniencia de inferencia e de decisao ----------------- */

// O ledger inteiro (percepcao congelada) e o proprio artefato; o hash sela.
const ledgerPath = `${RAIZ}/dataset/${VIDEO}/leituras.jsonl`;
const inferenceHash = existsSync(ledgerPath) ? shaArquivo(ledgerPath) : "AUSENTE";

/* ------------------------------ ambiente ---------------------------------- */

const ffmpegVersion = (() => {
  try {
    const bin = execSync(
      "ls -d /c/Users/user/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg*/ffmpeg-*full_build/bin",
      { encoding: "utf8", shell: "bash" },
    )
      .trim()
      .split(/\r?\n/)[0];
    return execSync(`"${bin}/ffmpeg.exe" -version`, { encoding: "utf8" }).split(/\r?\n/)[0];
  } catch {
    return "NAO_MEDIDO";
  }
})();
const lockfileHash = existsSync("package-lock.json") ? shaArquivo("package-lock.json") : "AUSENTE";
const ambiente = {
  nodeVersion: process.version,
  ffmpegVersion,
  lockfileHash,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  seed: "NENHUM — nao ha aleatoriedade no motor; a unica fonte estocastica e o modelo, congelado no ledger",
  ordemDosCandidatos: "deterministica: sequencial por indice de frame, dia a dia em ordem",
};
const environmentHash = sha(JSON.stringify(ambiente));

/* --------------------- dataset de decisao (por candidato) ----------------- */

function linhasDeDecisao(diasJson) {
  const linhas = [];
  for (const d of diasJson) {
    for (const l of d.pregao.leituras ?? []) {
      if (l.frameHash === null) continue; // TRACK nao e decisao de modelo
      linhas.push({
        candidateId: `${VIDEO}|dia${d.resumo.dia}|f${l.indice}`,
        videoId: VIDEO + ".mp4",
        dayId: d.resumo.dia,
        chartTime: `sintetico:${l.segundoNoVideo}s`,
        frameHash: l.frameHash,
        ROIHash: l.frameHash, // o recorte E a ROI — mesma imagem hasheada
        price: l.precoAtual,
        entry: l.entrada,
        stop: l.stop,
        direction: l.direcao,
        confidence: l.confianca,
        estagio: l.estagio,
        leituraOrigem: (l.reparos ?? []).some((x) => x.startsWith("PERCEPÇÃO CONGELADA"))
          ? "LEDGER"
          : "MODELO",
      });
    }
    for (const rec of d.pregao.recusasDeEspaco ?? []) {
      linhas.push({
        candidateId: `${VIDEO}|dia${d.resumo.dia}|recusa@${rec.indice}`,
        videoId: VIDEO + ".mp4",
        dayId: d.resumo.dia,
        chartTime: `sintetico:${rec.segundoNoVideo}s`,
        obstacle: rec.obstaculo,
        entry: rec.entrada,
        stop: rec.stop,
        direction: rec.direcao,
        tipoDoPivo: rec.tipoDoPivo,
        distanciaR: rec.distanciaR,
      });
    }
  }
  return linhas;
}

/* ------------------------- configuracao efetiva --------------------------- */

const config = {
  video: VIDEO + ".mp4",
  varredura: { intervaloSeg: 0.1, intervaloOcrSeg: 30, ativo: "WINFUT" },
  segmentacaoDeDias: { metodo: "gap>=900pts entre vizinhos<=2s, fusao<20s", limiarGap: 900 },
  funil: { janelaDoPivo: 8, proximidadePontos: 250, reanalisarAposFrames: 12, folgaDoEpisodio: 5 },
  pivosPorDia: "recomputados dentro do dia, indices locais — nivel de ontem nao atravessa o gap",
  recorte: { left: 0, top: 82, width: 1340, height: 590 },
  exigirCandleFechado: false,
  gates: {
    rrMinimo: 3,
    espacoMinimoR: 3,
    obstaculo: "pivo MEDIDO mais proximo alem da entrada; leitura do modelo so como ultimo recurso",
    espacoNaoMedido: "recusa o alvo (nunca aprova por ignorancia)",
  },
  gestao: "LiveOutcomeTracker, parcial 3R, alvo final 5R, runner de 3 contratos",
  custoSlippage: "ZERO_DECLARADO — nenhum custo nem slippage modelado; igual para todos os lados",
  regua: "CalibradorDeVideo com quarentena de continuidade; preco da caixa por geometria",
  definicaoDeResultado:
    "classificacao posterior sobre a serie da varredura (um preco por frame, pavios entre frames invisiveis) — GANHO/PERDA/NEUTRO/NAO_EXECUTADA/SEM_DESFECHO",
  vision: { modelo: "qwen3.5:35b", timeoutMs: 180000 },
  relogio: "sintetico declarado: 12 minutos de mercado por segundo de video",
};
const configHash = sha(JSON.stringify(config));

/* ------------------- resumo OFICIAL x CONTRAFACTUAL ---------------------- */

const dias = diasArquivos.map((f) =>
  JSON.parse(readFileSync(`${RAIZ}/reports/${VIDEO}/${f}`, "utf8")),
);
const oficial = {
  dias: dias.length,
  framesTotais: dias.reduce((a, d) => a + d.resumo.funil.framesTotais, 0),
  chamadasDeModelo: dias.reduce((a, d) => a + d.resumo.funil.chamadasDeModelo, 0),
  candidatosFrames: dias.reduce((a, d) => a + d.resumo.funil.candidatosFrames, 0),
  episodios: dias.reduce((a, d) => a + d.resumo.funil.episodios, 0),
  setupsNascidos: dias.reduce((a, d) => a + d.resumo.funil.setupsNascidos, 0),
  aproximacoes: dias.reduce((a, d) => a + d.resumo.aproximacoes, 0),
  confirmacoes: dias.reduce((a, d) => a + d.resumo.confirmacoes, 0),
  operacoes: dias.reduce((a, d) => a + d.resumo.operacoes, 0),
  ganhos: dias.reduce((a, d) => a + d.resumo.ganhos, 0),
  perdas: dias.reduce((a, d) => a + d.resumo.perdas, 0),
  pontos: dias.reduce((a, d) => a + d.resumo.pontos, 0),
  somaR: Number(dias.reduce((a, d) => a + d.resumo.somaR, 0).toFixed(2)),
  recusadasPorEspaco: dias.reduce((a, d) => a + d.resumo.recusadasPorEspaco, 0),
};
const recusas = dias.flatMap((d) => d.pregao.recusasDeEspaco ?? []);
const executadas = recusas.filter((r) =>
  ["GANHO", "PERDA", "NEUTRO"].includes(r.semTrava?.resultado),
);
const contrafactual = {
  aviso: "SIMULACAO — nunca soma com estatistica oficial",
  recusasRegistradas: recusas.length,
  simuladasExecutadas: executadas.length,
  ganhosSimulados: executadas.filter((r) => r.semTrava.resultado === "GANHO").length,
  perdasSimuladas: executadas.filter((r) => r.semTrava.resultado === "PERDA").length,
  somaRSimulada: Number(executadas.reduce((a, r) => a + (r.semTrava.r ?? 0), 0).toFixed(2)),
};

const decisionDataset = linhasDeDecisao(dias);
const decisionDatasetHash = sha(JSON.stringify(decisionDataset));
writeFileSync(
  `${RAIZ}/dataset/${VIDEO}/decision-dataset.json`,
  JSON.stringify(decisionDataset, null, 1),
  "utf8",
);

const congelado = {
  titulo: `BASELINE OFICIAL — CONGELADO (${VIDEO})`,
  dataHora: new Date().toISOString(),
  commitHash,
  motorHash,
  motorHashes,
  datasetHash,
  runnerHash,
  configHash,
  config,
  baselineHash,
  inferenceHash,
  decisionDatasetHash,
  environmentHash,
  ambiente,
  lockfileHash,
  diasHashes,
  OFICIAL_BASELINE: oficial,
  CONTRAFACTUAL: contrafactual,
  regraDeComparacao:
    "H1/H2/H1_H2 devem rodar sobre o MESMO datasetHash, mesmos dias, mesma gestao, mesmo custo, " +
    "mesma regua e mesma definicao de resultado. Qualquer divergencia de motorHash/configHash " +
    "durante um experimento => INVALID_COMPARISON: refazer os dois lados.",
};
writeFileSync(
  `${RAIZ}/reports/baseline-${VIDEO}-frozen.json`,
  JSON.stringify(congelado, null, 1),
  "utf8",
);
console.log("CONGELADO em t4-learning/reports/baseline-" + VIDEO + "-frozen.json");
console.log(`commitHash   ${commitHash}`);
console.log(`motorHash    ${motorHash}`);
console.log(`datasetHash  ${datasetHash}`);
console.log(`configHash   ${configHash}`);
console.log(`baselineHash ${baselineHash}`);
console.log(`inferenceHash ${inferenceHash}`);
console.log(`decisionDatasetHash ${decisionDatasetHash}`);
console.log(`environmentHash ${environmentHash}`);
console.log(`dias         ${diasArquivos.length}`);
