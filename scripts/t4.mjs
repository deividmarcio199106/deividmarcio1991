#!/usr/bin/env node
/**
 * Orquestrador local do T4 — `npm run t4:start | t4:stop | t4:doctor`.
 *
 * Sobe a bridge e o servidor web juntos e só declara PRONTO depois de PROVA:
 * a bridge responde no /health e o site responde no /api/health. Processo
 * iniciado não é evidência de que subiu — é evidência de que foi lançado.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUN_DIR = join(ROOT, ".t4run");
const PID_FILE = join(RUN_DIR, "pids.json");

const BRIDGE_HEALTH = process.env.T4_BRIDGE_HEALTH || "http://127.0.0.1:8765/health";
const WEB_HEALTH = process.env.T4_WEB_HEALTH || "http://localhost:3000/api/health";

function log(message) {
  console.log(`[t4] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probe(url, attempts, intervalMs) {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return { ok: true, body: await response.text() };
    } catch {
      // ainda subindo
    }
    await sleep(intervalMs);
  }
  return { ok: false, body: "" };
}

function savePids(pids) {
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(PID_FILE, JSON.stringify(pids, null, 2));
}

function readPids() {
  if (!existsSync(PID_FILE)) return null;
  try {
    return JSON.parse(readFileSync(PID_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function start() {
  if (readPids()) {
    log("Já existe um t4:start registrado. Rode `npm run t4:stop` antes.");
    process.exitCode = 1;
    return;
  }

  log("Subindo a bridge RTD…");
  const bridge = spawn(process.execPath, [join(ROOT, "bridge", "t4-bridge.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
    detached: false,
  });

  log("Subindo o servidor web…");
  const web = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev"], {
    cwd: ROOT,
    stdio: "inherit",
    detached: false,
    shell: process.platform === "win32",
  });

  savePids({ bridge: bridge.pid, web: web.pid, startedAt: Date.now() });

  const bridgeProbe = await probe(BRIDGE_HEALTH, 10, 500);
  log(
    bridgeProbe.ok
      ? `Bridge respondeu em ${BRIDGE_HEALTH}`
      : `!! Bridge NÃO respondeu em ${BRIDGE_HEALTH}`,
  );

  const webProbe = await probe(WEB_HEALTH, 40, 1000);
  log(webProbe.ok ? `Site respondeu em ${WEB_HEALTH}` : `!! Site NÃO respondeu em ${WEB_HEALTH}`);

  if (bridgeProbe.ok && webProbe.ok) {
    log("PRONTO — os dois responderam de fato.");
    log("Abra http://localhost:3000/operacao-ao-vivo e escolha a fonte RTD.");
    log("Lembre: a bridge fica sem dados até o Profit publicar pelo RTD.");
  } else {
    log("PARCIAL — algum componente não provou estar no ar. Veja as linhas acima.");
    process.exitCode = 1;
  }

  const shutdown = () => {
    bridge.kill();
    web.kill();
    rmSync(PID_FILE, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function stop() {
  const pids = readPids();
  if (!pids) {
    log("Nenhum processo registrado por t4:start.");
    return;
  }
  for (const [name, pid] of Object.entries(pids)) {
    if (name === "startedAt" || typeof pid !== "number") continue;
    try {
      process.kill(pid);
      log(`Encerrado ${name} (pid ${pid}).`);
    } catch {
      log(`${name} (pid ${pid}) já não estava rodando.`);
    }
  }
  rmSync(PID_FILE, { force: true });
}

async function doctor() {
  log("CONFIG CHECK — validando o que precisa existir antes de operar.\n");
  const problems = [];
  const notes = [];

  const major = Number(process.versions.node.split(".")[0]);
  const minor = Number(process.versions.node.split(".")[1]);
  const sqliteOk = major > 22 || (major === 22 && minor >= 5);
  if (sqliteOk) notes.push(`Node ${process.version} — node:sqlite disponível.`);
  else
    problems.push(
      `Node ${process.version} não expõe node:sqlite (exige 22.5+). A persistência não vai funcionar.`,
    );

  for (const file of ["package.json", "bridge/t4-bridge.mjs", "src/server.ts"]) {
    if (existsSync(join(ROOT, file))) notes.push(`${file} presente.`);
    else problems.push(`${file} ausente — projeto incompleto.`);
  }

  const providers = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OLLAMA_BASE_URL"];
  const configured = providers.filter((name) => (process.env[name] ?? "").trim());
  if (configured.length) notes.push(`Provedores de IA configurados: ${configured.join(", ")}.`);
  else
    notes.push(
      "Nenhum provedor de IA configurado — a correção assistida fica indisponível (o T4 não depende dela).",
    );

  const leaked = Object.keys(process.env).filter(
    (name) => name.startsWith("VITE_") && /(KEY|TOKEN|SECRET|PASSWORD|SENHA)/i.test(name),
  );
  if (leaked.length)
    problems.push(`Segredo exposto ao navegador: ${leaked.join(", ")}. Remova o prefixo VITE_.`);
  else notes.push("Nenhum segredo com prefixo VITE_.");

  const bridgeProbe = await probe(BRIDGE_HEALTH, 1, 0);
  if (bridgeProbe.ok) notes.push(`Bridge respondendo em ${BRIDGE_HEALTH}.`);
  else
    notes.push(
      `Bridge não está no ar (${BRIDGE_HEALTH}). Normal se você ainda não rodou t4:start.`,
    );

  const webProbe = await probe(WEB_HEALTH, 1, 0);
  if (webProbe.ok) notes.push(`Site respondendo em ${WEB_HEALTH}.`);
  else notes.push(`Site não está no ar (${WEB_HEALTH}). Normal se você ainda não rodou t4:start.`);

  for (const note of notes) console.log(`  ok   ${note}`);
  for (const problem of problems) console.log(`  FAIL ${problem}`);

  console.log("");
  if (problems.length) {
    log(`${problems.length} problema(s) de configuração. Corrija antes de operar.`);
    process.exitCode = 1;
  } else {
    log("Configuração básica em ordem.");
  }
}

const command = process.argv[2];
if (command === "start") await start();
else if (command === "stop") stop();
else if (command === "doctor") await doctor();
else {
  console.log("Uso: node scripts/t4.mjs <start|stop|doctor>");
  process.exitCode = 1;
}
