/**
 * O DRIVER DA CAMPANHA — roda sozinho ate acabar, com checkpoint e watchdog.
 *
 * Um processo, uma fila sequencial de itens, cada item com estado persistido
 * atomicamente (PENDING/RUNNING/COMPLETE/FAILED/BLOCKED/AMBIGUOUS), retry com
 * limite e timeout proprio. Um dia ruim NAO derruba a campanha: vira FAILED
 * com motivo e a fila segue. Reiniciar o driver continua do proximo pendente.
 *
 * PORTOES DE PROTECAO (nunca pulados pelo automatico):
 *   - VALIDATION (abril, junho) so destrava com experiments/candidatas-congeladas.json;
 *   - TEST_FINAL (maio, julho, 8) so destrava com experiments/candidata-final-congelada.json;
 *   - nada aqui promove tecnica para producao.
 *
 * Uso: node t4-learning/campanha/rodar.mjs   (na raiz do repo)
 */
import { execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  appendFileSync,
  statSync,
} from "node:fs";

const RAIZ = "t4-learning";
const CAMPANHA = `${RAIZ}/campanha`;
const ESTADO = `${CAMPANHA}/estado.json`;
const LOG = `${CAMPANHA}/driver.log`;
mkdirSync(CAMPANHA, { recursive: true });

const TRAIN = ["marco", "fevereiro", "7", "teste"];
const VALIDATION = ["abril", "junho"];
const AMBIENTE_GPU = {
  AI_PROVIDER: "ollama",
  OLLAMA_BASE_URL: "http://127.0.0.1:11435",
  AI_VISION_MODEL: "qwen3.5:35b",
  AI_MODEL: "qwen3.5:35b",
  AI_TIMEOUT_MS: "180000",
};

const sha = (t) => createHash("sha256").update(t).digest("hex");
const agora = () => new Date().toISOString();
function log(linha) {
  const msg = `${agora()} ${linha}`;
  console.log(msg);
  appendFileSync(LOG, msg + "\n");
}

/* ------------------------------ estado ----------------------------------- */

function lerEstado() {
  if (!existsSync(ESTADO)) return { itens: {} };
  try {
    return JSON.parse(readFileSync(ESTADO, "utf8"));
  } catch {
    return { itens: {} };
  }
}
function gravarEstado(estado) {
  const tmp = `${ESTADO}.tmp`;
  writeFileSync(tmp, JSON.stringify(estado, null, 1), "utf8");
  renameSync(tmp, ESTADO);
}
function marcar(id, valores) {
  const estado = lerEstado();
  estado.itens[id] = { ...(estado.itens[id] ?? {}), ...valores, atualizadoEm: agora() };
  gravarEstado(estado);
}

/* --------------------------- execucao de etapa ---------------------------- */

function rodar(comando, env, timeoutMin) {
  return new Promise((resolver) => {
    const filho = spawn(comando.join(" "), {
      env: { ...process.env, ...env },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let saida = "";
    const acumular = (d) => {
      saida += String(d);
      if (saida.length > 400_000) saida = saida.slice(-200_000);
    };
    filho.stdout.on("data", acumular);
    filho.stderr.on("data", acumular);
    const timer = setTimeout(() => {
      log(`  TIMEOUT ${timeoutMin}min — matando processo`);
      try {
        execSync(`taskkill /pid ${filho.pid} /T /F`, { stdio: "ignore" });
      } catch {}
    }, timeoutMin * 60_000);
    filho.on("close", (codigo) => {
      clearTimeout(timer);
      resolver({ codigo: codigo ?? -1, saida });
    });
  });
}

async function etapa(id, opcoes) {
  const estado = lerEstado().itens[id] ?? { estado: "PENDING", tentativas: 0 };
  if (estado.estado === "COMPLETE") return true;
  if (estado.estado === "FAILED" && estado.tentativas >= 3) return false;
  if (opcoes.pronto !== undefined && opcoes.pronto()) {
    marcar(id, { estado: "COMPLETE", motivo: "artefato ja existia e validou" });
    log(`[${id}] COMPLETE (cache)`);
    return true;
  }
  if (opcoes.bloqueado !== undefined) {
    const motivo = opcoes.bloqueado();
    if (motivo !== null) {
      marcar(id, { estado: "BLOCKED", motivo });
      log(`[${id}] BLOCKED: ${motivo}`);
      return false;
    }
  }
  for (let tentativa = (estado.tentativas ?? 0) + 1; tentativa <= 3; tentativa++) {
    marcar(id, { estado: "RUNNING", tentativas: tentativa });
    log(`[${id}] RUNNING (tentativa ${tentativa})`);
    const r = await rodar(opcoes.comando, opcoes.env ?? {}, opcoes.timeoutMin);
    appendFileSync(`${CAMPANHA}/${id.replace(/[:\/]/g, "_")}.log`, r.saida);
    const ok = r.codigo === 0 && (opcoes.validar === undefined || opcoes.validar());
    if (ok) {
      marcar(id, { estado: "COMPLETE" });
      log(`[${id}] COMPLETE`);
      return true;
    }
    log(`[${id}] tentativa ${tentativa} falhou (codigo ${r.codigo})`);
  }
  marcar(id, { estado: "FAILED", motivo: "3 tentativas esgotadas — ver log do item" });
  log(`[${id}] FAILED — a fila continua`);
  return false;
}

/* ------------------------------ validacoes -------------------------------- */

function datasetCompleto(video) {
  const caminho = `${RAIZ}/dataset/${video}/varredura-mes.json`;
  if (!existsSync(caminho)) return false;
  try {
    const d = JSON.parse(readFileSync(caminho, "utf8"));
    const duracao = {
      marco: 1206.6,
      fevereiro: 561.1,
      7: 114.1,
      teste: 148.9,
      abril: 1182.3,
      junho: 1240.7,
    }[video];
    // Integridade: a extracao precisa ter chegado ao fim REAL do video.
    const esperado = Math.floor((duracao ?? 0) * 10) * 0.95;
    return d.resumo.framesLidos >= esperado && d.resumo.erro === null;
  } catch {
    return false;
  }
}

function fronteirasProntas(video) {
  return existsSync(`${RAIZ}/dataset/${video}/day-boundaries-frozen.json`);
}

function bracoCompleto(video, braco) {
  const sufixo = braco === "BASE" ? "" : `-${braco.toLowerCase()}`;
  const agregado = `${RAIZ}/reports/${video}${sufixo}/agregado.json`;
  if (!existsSync(agregado)) return false;
  try {
    const a = JSON.parse(readFileSync(agregado, "utf8"));
    const fronteiras = JSON.parse(
      readFileSync(`${RAIZ}/dataset/${video}/day-boundaries-frozen.json`, "utf8"),
    );
    return a.dias.length >= fronteiras.dias.length;
  } catch {
    return false;
  }
}

/* ------------------------------ relatorio --------------------------------- */

function relatorio() {
  const resumo = { geradoEm: agora(), estado: lerEstado(), videos: {} };
  for (const video of [...TRAIN, ...VALIDATION, "maio", "julho", "8"]) {
    const v = { bracos: {} };
    for (const braco of ["BASE", "H2", "H1", "H1H2"]) {
      const sufixo = braco === "BASE" ? "" : `-${braco.toLowerCase()}`;
      const caminho = `${RAIZ}/reports/${video}${sufixo}/agregado.json`;
      if (!existsSync(caminho)) continue;
      try {
        const a = JSON.parse(readFileSync(caminho, "utf8"));
        const dias = a.dias.filter((d) => d.funil !== undefined);
        v.bracos[braco] = {
          dias: a.dias.length,
          diasComTrade: dias.filter((d) => d.operacoes > 0).length,
          operacoes: dias.reduce((s, d) => s + (d.operacoes ?? 0), 0),
          ganhos: dias.reduce((s, d) => s + (d.ganhos ?? 0), 0),
          perdas: dias.reduce((s, d) => s + (d.perdas ?? 0), 0),
          somaR: Number(dias.reduce((s, d) => s + (d.somaR ?? 0), 0).toFixed(2)),
          pontos: Number(dias.reduce((s, d) => s + (d.pontos ?? 0), 0).toFixed(0)),
          recusasEspaco: dias.reduce((s, d) => s + (d.recusasComForense ?? 0), 0),
          visionCalls: dias.reduce((s, d) => s + (d.funil?.chamadasDeModelo ?? 0), 0),
        };
      } catch {}
    }
    if (Object.keys(v.bracos).length > 0) resumo.videos[video] = v;
  }
  const tmp = `${CAMPANHA}/campaign-summary.json.tmp`;
  writeFileSync(tmp, JSON.stringify(resumo, null, 1), "utf8");
  renameSync(tmp, `${CAMPANHA}/campaign-summary.json`);
}

/* -------------------------------- a fila ---------------------------------- */

async function main() {
  log("=== CAMPANHA T4 — driver iniciado ===");

  // 0. Espera respeitosa: se um sweep externo do marco esta vivo, aguarda.
  for (let i = 0; i < 90 && !datasetCompleto("marco"); i++) {
    let ffmpegVivo = false;
    try {
      ffmpegVivo = execSync('tasklist /FI "IMAGENAME eq ffmpeg.exe"', {
        encoding: "utf8",
      }).includes("ffmpeg.exe");
    } catch {}
    if (!ffmpegVivo) break;
    if (i % 10 === 0) log("aguardando sweep externo do marco terminar...");
    await new Promise((r) => setTimeout(r, 60_000));
  }

  // 1. VARREDURAS TRAIN — com validacao de integridade (video truncado reroda).
  for (const video of TRAIN) {
    await etapa(`sweep:${video}`, {
      pronto: () => datasetCompleto(video),
      comando: ["npx", "vitest", "run", "src/server/video/mes.temp.test.ts"],
      env: { ...AMBIENTE_GPU, VIDEO_MES: video },
      timeoutMin: 150,
      validar: () => datasetCompleto(video),
    });
  }

  // 2. FRONTEIRAS — congeladas; mesmos cortes para todos os bracos.
  for (const video of TRAIN) {
    if (!datasetCompleto(video)) continue;
    await etapa(`fronteiras:${video}`, {
      pronto: () => fronteirasProntas(video),
      comando: ["npx", "vitest", "run", "src/server/video/fronteiras.temp.test.ts"],
      env: { ...AMBIENTE_GPU, VIDEO_MES: video },
      timeoutMin: 90,
      validar: () => fronteirasProntas(video),
    });
  }

  // 3. BASELINE de todos os dias TRAIN (checkpoint por dia dentro do runner).
  for (const video of TRAIN) {
    if (!fronteirasProntas(video)) continue;
    await etapa(`baseline:${video}`, {
      pronto: () => bracoCompleto(video, "BASE"),
      comando: ["npx", "vitest", "run", "src/server/video/dias.temp.test.ts"],
      env: { ...AMBIENTE_GPU, VIDEO_DIAS: video, BRACO: "BASE" },
      timeoutMin: 420,
      validar: () => bracoCompleto(video, "BASE"),
    });
    relatorio();
  }

  // 4. CONGELAR o baseline de cada video TRAIN concluido.
  for (const video of TRAIN) {
    if (!bracoCompleto(video, "BASE")) continue;
    await etapa(`freeze:${video}`, {
      pronto: () => existsSync(`${RAIZ}/reports/baseline-${video}-frozen.json`),
      comando: ["node", `${RAIZ}/experiments/congelar-baseline.mjs`],
      env: { VIDEO_FREEZE: video },
      timeoutMin: 10,
      validar: () => existsSync(`${RAIZ}/reports/baseline-${video}-frozen.json`),
    });
  }

  // 5-7. H2, depois H1, depois H1H2 — mesma percepcao, cortes congelados.
  for (const braco of ["H2", "H1", "H1H2"]) {
    for (const video of TRAIN) {
      if (!existsSync(`${RAIZ}/reports/baseline-${video}-frozen.json`)) continue;
      await etapa(`${braco.toLowerCase()}:${video}`, {
        pronto: () => bracoCompleto(video, braco),
        comando: ["npx", "vitest", "run", "src/server/video/dias.temp.test.ts"],
        env: { ...AMBIENTE_GPU, VIDEO_DIAS: video, BRACO: braco },
        timeoutMin: 300,
        validar: () => bracoCompleto(video, braco),
      });
      relatorio();
    }
  }

  // 8. RANGE — nova logica operacional: registrada como pendencia ate os
  // resultados de H1/H2 existirem; nao se desenha gestao de range no escuro.
  marcar("range:TRAIN", {
    estado: "BLOCKED",
    motivo:
      "T4_RANGE e logica nova (bordas, rejeicao, gestao propria); sera construida sobre os resultados de H1/H2 — nao antes deles",
  });

  // 8b. PESQUISA — construida sobre os dados; declarada desde ja no estado.
  for (const fase of ["alvos", "gestao", "regimes", "leaderboard", "montecarlo", "tabelas"]) {
    const estadoAtual = lerEstado().itens[`pesquisa:${fase}`];
    if (estadoAtual === undefined || estadoAtual.estado === "BLOCKED") {
      marcar(`pesquisa:${fase}`, {
        estado: "BLOCKED",
        motivo:
          "ferramenta roda sobre baseline+bracos concluidos — construida e disparada quando os dados existirem",
      });
    }
  }

  // 9-10. VALIDATION e TEST_FINAL — portoes que o automatico NUNCA pula.
  for (const video of VALIDATION) {
    await etapa(`validation:${video}`, {
      bloqueado: () =>
        existsSync(`${RAIZ}/experiments/candidatas-congeladas.json`)
          ? null
          : "VALIDATION so abre com candidatas congeladas apos analise do TRAIN (risco de contaminacao)",
      comando: ["npx", "vitest", "run", "src/server/video/mes.temp.test.ts"],
      env: { ...AMBIENTE_GPU, VIDEO_MES: video },
      timeoutMin: 150,
    });
  }
  for (const video of ["maio", "julho", "8"]) {
    // LACRE DE UMA TENTATIVA: os 5 campos precisam existir; reprovou = reprovou.
    let lacreValido = false;
    try {
      const lacre = JSON.parse(
        readFileSync(`${RAIZ}/experiments/candidata-final-congelada.json`, "utf8"),
      );
      lacreValido = [
        "finalCandidateHash",
        "rulesHash",
        "managementHash",
        "datasetHash",
        "timestamp",
      ].every((c) => typeof lacre[c] === "string" && lacre[c].length > 0);
    } catch {}
    marcar(`test_final:${video}`, {
      estado: "BLOCKED",
      motivo: lacreValido
        ? "lacre presente — abertura do TEST_FINAL e decisao explicita, nunca automatica"
        : "TEST_FINAL intocado: exige lacre de UMA tentativa (finalCandidateHash, rulesHash, managementHash, datasetHash, timestamp)",
    });
  }

  relatorio();
  const estado = lerEstado();
  const contagem = {};
  for (const item of Object.values(estado.itens)) {
    contagem[item.estado] = (contagem[item.estado] ?? 0) + 1;
  }
  log(`=== CAMPANHA: fila esgotada — ${JSON.stringify(contagem)} ===`);
  log("Itens BLOCKED tem motivo registrado; nada foi promovido para producao.");
}

main().catch((e) => {
  log(`ERRO FATAL DO DRIVER: ${String(e).slice(0, 400)}`);
  process.exit(1);
});
