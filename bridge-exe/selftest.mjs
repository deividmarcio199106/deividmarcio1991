/**
 * Selftest do T4-Bridge.exe.
 *
 * Sobe o executável de verdade, conecta por WebSocket e verifica o protocolo.
 * Não testa o RTD em si — isso exige Profit aberto e logado, e é reportado
 * como PENDENTE em vez de fingir que passou.
 *
 * Uso: node bridge-exe/selftest.mjs
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const EXE = join(DIR, "T4-Bridge.exe");
const PORT = 8791;
const results = [];

function check(label, ok, detail) {
  results.push({ label, ok });
  console.log(`  ${ok ? "PASS" : "FALHA"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  if (!existsSync(EXE)) {
    console.log("T4-Bridge.exe não existe. Rode bridge-exe\\build.cmd primeiro.");
    process.exit(1);
  }

  // Porta própria para não brigar com uma bridge que o operador já tenha aberto.
  const { writeFileSync, rmSync } = await import("node:fs");
  const ini = join(DIR, "t4-bridge.ini");
  const hadIni = existsSync(ini);
  if (!hadIni) writeFileSync(ini, `port=${PORT}\nsymbol=WINFUT\n`, "utf8");

  const child = spawn(EXE, [], { cwd: DIR, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => (output += String(chunk)));
  child.stderr.on("data", (chunk) => (output += String(chunk)));

  await wait(3000);

  const base = `http://127.0.0.1:${hadIni ? 8765 : PORT}`;

  console.log("\n== HTTP ==");
  let health = null;
  try {
    const response = await fetch(`${base}/health`);
    health = await response.json();
    check("health responde", response.ok);
    check("identifica o executável", health.flavor === "exe", health.flavor);
    check("versão presente", typeof health.version === "string", health.version);
    check("sessionId presente", typeof health.sessionId === "string");
  } catch (error) {
    check("health responde", false, String(error));
  }

  if (health) {
    console.log("\n== estado do Profit ==");
    check(
      "reporta se o Profit está aberto",
      typeof health.profitRunning === "boolean",
      `profitRunning=${health.profitRunning}`,
    );
    if (!health.profitRunning) {
      check(
        "recusa com motivo acionável quando o Profit está fechado",
        typeof health.rtdError === "string" && /Profit/i.test(health.rtdError),
        health.rtdError,
      );
      console.log(
        "  PENDENTE  fluxo de dados do RTD — exige Profit aberto e logado; não é testável aqui",
      );
    } else {
      check("RTD conectado com o Profit aberto", health.rtdConnected === true, health.rtdError);
      check(
        "campos do RTD aceitos",
        health.rtdFieldsOk === true,
        health.rtdConnectError ?? "sem erro",
      );
    }
  }

  console.log("\n== rota desconhecida ==");
  try {
    const response = await fetch(`${base}/nao-existe`);
    check("devolve 404", response.status === 404);
  } catch (error) {
    check("devolve 404", false, String(error));
  }

  console.log("\n== origem ==");
  try {
    const bloqueado = await fetch(`${base}/health`, {
      headers: { origin: "https://evil.example.com" },
    });
    check("origem não autorizada é recusada", bloqueado.status === 403);
  } catch (error) {
    check("origem não autorizada é recusada", false, String(error));
  }
  try {
    const permitido = await fetch(`${base}/health`, {
      headers: { origin: "http://localhost:3000" },
    });
    check("origem autorizada passa", permitido.ok);
    check(
      "CORS ecoa a origem em vez de responder *",
      permitido.headers.get("access-control-allow-origin") === "http://localhost:3000",
      permitido.headers.get("access-control-allow-origin") ?? "ausente",
    );
  } catch (error) {
    check("origem autorizada passa", false, String(error));
  }

  console.log("\n== WebSocket ==");
  const wsUrl = base.replace("http://", "ws://");
  const socket = new WebSocket(wsUrl);
  const messages = [];
  const opened = await new Promise((resolve) => {
    socket.addEventListener("open", () => resolve(true));
    socket.addEventListener("error", () => resolve(false));
    setTimeout(() => resolve(false), 5000);
  });
  check("handshake abre o enlace", opened);

  if (opened) {
    socket.addEventListener("message", (event) => {
      try {
        messages.push(JSON.parse(String(event.data)));
      } catch {
        /* frame não-JSON não deveria existir */
      }
    });

    socket.send(JSON.stringify({ type: "subscribe", symbols: ["WINFUT"] }));
    await wait(500);
    const hello = messages.find((m) => m.type === "hello");
    check("subscribe devolve hello", hello !== undefined);
    check("hello traz sessionId", hello?.sessionId !== undefined);
    check("hello ecoa o símbolo assinado", hello?.symbols?.includes("WINFUT") === true);

    const clientTime = Date.now();
    socket.send(JSON.stringify({ type: "ping", clientTime }));
    await wait(500);
    const pong = messages.find((m) => m.type === "pong");
    check("ping devolve pong", pong !== undefined);
    check("pong ecoa clientTime", pong?.clientTime === clientTime, String(pong?.clientTime));
    check("pong traz serverTime", typeof pong?.serverTime === "number");

    await wait(1500);
    const heartbeat = messages.find((m) => m.type === "heartbeat");
    check("heartbeat chega sozinho", heartbeat !== undefined);
    check("heartbeat informa o produtor", heartbeat?.producer !== undefined, heartbeat?.producer);

    socket.close();
  }

  await wait(300);
  child.kill();
  if (!hadIni) rmSync(ini, { force: true });

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} verificações passaram.`);
  if (passed !== results.length) {
    console.log("\n--- saída do executável ---");
    console.log(output);
  }
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
