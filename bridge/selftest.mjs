#!/usr/bin/env node
/**
 * Teste de integração da bridge — sobe, conecta, publica e confere.
 *
 * O que este teste prova: handshake WebSocket, entrega de tick, sequência,
 * heartbeat, medição de drift e recusa de dado inválido.
 *
 * O que este teste NÃO prova: que o Profit está publicando. O símbolo usado é
 * `TESTE`, que não resolve para nenhum instrumento operável — nenhum tick daqui
 * pode ser confundido com mercado.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  startBridge,
  normalizeTick,
  parseTimestamp,
  originAllowed,
  buildOriginAllowlist,
} from "./t4-bridge.mjs";

const PORT = 8799;
const TLS_PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const TLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "tls");
const results = [];

/** Certificado local é autoassinado: o teste prova o caminho, não a confiança. */
const INSECURE = { tls: { rejectUnauthorized: false } };

function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function post(body, headers = {}) {
  const response = await fetch(`${BASE}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json() };
}

async function main() {
  if (typeof WebSocket === "undefined") {
    console.error("Este teste precisa de WebSocket global: Node 22+ ou Bun.");
    process.exit(1);
  }

  console.log("\n== unidade: normalização ==");
  check("epoch em segundos vira ms", parseTimestamp(1_760_000_000) === 1_760_000_000_000);
  check("epoch em ms passa intacto", parseTimestamp(1_760_000_000_000) === 1_760_000_000_000);
  check("HH:MM:SS resolve para hoje", typeof parseTimestamp("13:45:12") === "number");
  check("texto inválido é rejeitado", parseTimestamp("banana") === null);
  check("preço zero é recusado", normalizeTick({ symbol: "X", timestamp: 1, price: 0 }).error);
  check("symbol ausente é recusado", normalizeTick({ timestamp: 1, price: 10 }).error);
  check(
    "timestamp no futuro é recusado",
    normalizeTick({ symbol: "X", timestamp: Date.now() + 120_000, price: 10 }).error,
  );
  check(
    "vírgula decimal é aceita",
    normalizeTick({ symbol: "X", timestamp: Date.now(), price: "5,25" }).tick?.price === 5.25,
  );

  console.log("\n== integração: bridge ==");
  const bridge = startBridge({ port: PORT, host: "127.0.0.1", log: () => {} });
  await wait(300);

  const health = await (await fetch(`${BASE}/health`)).json();
  check("health responde", health.ok === true);
  check("produtor começa em WAITING", health.producer === "WAITING", health.producer);

  const received = [];
  let hello = null;
  let heartbeats = 0;
  let pong = null;

  const socket = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const connected = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", () => reject(new Error("WebSocket não conectou")));
    setTimeout(() => reject(new Error("timeout na conexão WebSocket")), 4000);
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.type === "hello") hello = message;
    else if (message.type === "tick") received.push(message.tick);
    else if (message.type === "heartbeat") heartbeats += 1;
    else if (message.type === "pong") pong = message;
  });

  await connected;
  await wait(150);
  check("handshake entrega hello", hello !== null && hello.service === "t4-bridge");
  check("hello traz sessionId", Boolean(hello?.sessionId));

  socket.send(JSON.stringify({ type: "subscribe", symbols: ["TESTE"] }));
  socket.send(JSON.stringify({ type: "ping", clientTime: Date.now() }));
  await wait(200);
  check("pong ecoa clientTime", pong !== null && typeof pong.clientTime === "number");
  check("pong traz serverTime", typeof pong?.serverTime === "number");

  const base = Date.now() - 5_000;
  const lote = await post([
    { symbol: "TESTE", timestamp: base, price: 100, volume: 10, qty: 1 },
    { symbol: "TESTE", timestamp: base + 1_000, price: 101, volume: 15, qty: 5 },
    { symbol: "TESTE", timestamp: base + 2_000, price: 99, volume: 22, qty: 7 },
  ]);
  check("lote aceito", lote.payload.accepted === 3, JSON.stringify(lote.payload));
  await wait(250);

  check("3 ticks chegaram no WebSocket", received.length === 3, `recebidos=${received.length}`);
  check(
    "sequência é monotônica por ativo",
    received.map((t) => t.seq).join(",") === "1,2,3",
    received.map((t) => t.seq).join(","),
  );
  check("preço preservado", received[1]?.price === 101);
  check("qty preservada", received[2]?.qty === 7);

  const invalido = await post({ symbol: "TESTE", timestamp: base, price: -1 });
  check(
    "preço negativo recusado",
    invalido.payload.rejected === 1,
    JSON.stringify(invalido.payload),
  );
  await wait(250);
  check("tick recusado não é entregue", received.length === 3, `recebidos=${received.length}`);

  const semSymbol = await post({ timestamp: base, price: 100 });
  check("symbol ausente recusado", semSymbol.payload.rejected === 1);

  await wait(1_200);
  check("heartbeat chega a cada 1s", heartbeats >= 1, `recebidos=${heartbeats}`);

  const health2 = await (await fetch(`${BASE}/health`)).json();
  check("produtor vira LIVE após ingest", health2.producer === "LIVE", health2.producer);
  check(
    "contadores batem",
    health2.ticksAccepted === 3 && health2.ticksRejected === 2,
    `aceitos=${health2.ticksAccepted} recusados=${health2.ticksRejected}`,
  );
  check(
    "símbolo aparece no health",
    health2.symbols.some((s) => s.symbol === "TESTE"),
  );

  const naoExiste = await fetch(`${BASE}/rota-inexistente`);
  check("rota desconhecida devolve 404", naoExiste.status === 404);

  console.log("\n== unidade: allowlist de origem ==");
  const allowlist = buildOriginAllowlist();
  check("produção é autorizada", originAllowed("https://analisador.dvdswap.com.br", allowlist));
  check("localhost:3000 é autorizado", originAllowed("http://localhost:3000", allowlist));
  check("127.0.0.1:3000 é autorizado", originAllowed("http://127.0.0.1:3000", allowlist));
  check("barra final não muda o veredito", originAllowed("http://localhost:3000/", allowlist));
  check("maiúsculas não mudam o veredito", originAllowed("HTTP://LOCALHOST:3000", allowlist));
  check("site de terceiro é recusado", !originAllowed("https://evil.example.com", allowlist));
  check("outra porta é recusada", !originAllowed("http://localhost:4000", allowlist));
  check(
    "http em produção é recusado (só https)",
    !originAllowed("http://analisador.dvdswap.com.br", allowlist),
  );
  // Navegador SEMPRE manda Origin: ausência identifica cliente nativo.
  check("cliente nativo (sem Origin) é aceito", originAllowed(undefined, allowlist));
  check("Origin vazio é aceito", originAllowed("", allowlist));
  check(
    "origem extra configurada entra",
    originAllowed("https://x.test", buildOriginAllowlist(["https://x.test"])),
  );

  console.log("\n== integração: origem no enlace real ==");
  const upgradeComOrigem = async (origin) => {
    const response = await fetch(`${BASE}/`, {
      headers: {
        origin,
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
      },
    }).catch((error) => ({ status: 0, error: String(error) }));
    return response.status;
  };
  check(
    "upgrade de origem não autorizada é recusado",
    (await upgradeComOrigem("https://evil.example.com")) === 403,
  );

  const ingestBloqueado = await fetch(`${BASE}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example.com" },
    body: JSON.stringify({ symbol: "TESTE", timestamp: Date.now(), price: 1 }),
  });
  check("ingest de origem não autorizada é recusado", ingestBloqueado.status === 403);

  const ingestPermitido = await fetch(`${BASE}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ symbol: "TESTE", timestamp: base + 3_000, price: 102 }),
  });
  check("ingest de origem autorizada passa", ingestPermitido.status === 200);

  console.log("\n== unidade: recusa de bind fora do loopback ==");
  let recusou = false;
  try {
    startBridge({ port: 8797, host: "0.0.0.0", log: () => {} });
  } catch (error) {
    recusou = /loopback/i.test(error.message);
  }
  check("bind em 0.0.0.0 é recusado", recusou);

  let recusouExterno = false;
  try {
    startBridge({ port: 8797, host: "192.168.0.10", log: () => {} });
  } catch (error) {
    recusouExterno = /loopback/i.test(error.message);
  }
  check("bind em IP de rede é recusado", recusouExterno);

  socket.close();
  await wait(200);
  bridge.close();

  // ---------------------------------------------------------------- TLS ----
  console.log("\n== integração: TLS na mesma porta ==");
  const certPath = join(TLS_DIR, "cert.pem");
  const keyPath = join(TLS_DIR, "key.pem");

  if (!existsSync(certPath) || !existsSync(keyPath)) {
    check(
      "certificado presente",
      false,
      "rode bridge/tls/setup-rtd-tls.ps1 antes — sem cert o modo WSS não é testável",
    );
  } else {
    const tlsBridge = startBridge({
      port: TLS_PORT,
      host: "127.0.0.1",
      log: () => {},
      certPath,
      keyPath,
    });
    await wait(400);

    // 1. Texto claro continua funcionando NA MESMA PORTA — é o que mantém o
    //    produtor RTD (Excel/PowerShell) vivo depois de ligar o TLS.
    const claro = await fetch(`http://127.0.0.1:${TLS_PORT}/health`).then((r) => r.json());
    check("HTTP em claro responde na porta TLS", claro.ok === true);
    check("health informa tls ligado", claro.tls === true, JSON.stringify(claro.tls));

    // 2. HTTPS na mesma porta.
    const seguro = await fetch(`https://localhost:${TLS_PORT}/health`, INSECURE)
      .then((r) => r.json())
      .catch((error) => ({ erro: String(error) }));
    check(
      "HTTPS responde na mesma porta",
      seguro.ok === true,
      JSON.stringify(seguro).slice(0, 120),
    );

    // 3. WSS de verdade: handshake + hello + tick.
    let wssHello = null;
    const wssTicks = [];
    const wss = new WebSocket(`wss://localhost:${TLS_PORT}`, INSECURE);
    const wssAberto = await new Promise((resolve) => {
      wss.addEventListener("open", () => resolve(true));
      wss.addEventListener("error", () => resolve(false));
      setTimeout(() => resolve(false), 5000);
    });
    check("WSS abre o enlace", wssAberto);

    if (wssAberto) {
      wss.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.type === "hello") wssHello = message;
        else if (message.type === "tick") wssTicks.push(message.tick);
      });
      await wait(200);
      check("WSS recebe hello", wssHello !== null && wssHello.service === "t4-bridge");

      await fetch(`http://127.0.0.1:${TLS_PORT}/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol: "TESTE", timestamp: Date.now() - 1000, price: 55, qty: 2 }),
      });
      await wait(300);
      check("tick chega pelo enlace TLS", wssTicks.length === 1, `recebidos=${wssTicks.length}`);
      check("preço preservado no TLS", wssTicks[0]?.price === 55);
      wss.close();
    }

    // 4. Origem não autorizada continua recusada sobre TLS.
    const upgradeTlsBloqueado = await fetch(`https://localhost:${TLS_PORT}/`, {
      ...INSECURE,
      headers: {
        origin: "https://evil.example.com",
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
      },
    }).catch(() => ({ status: 0 }));
    check("origem não autorizada é recusada também no TLS", upgradeTlsBloqueado.status === 403);

    await wait(100);
    tlsBridge.close();
  }

  const falhas = results.filter((r) => !r.ok);
  console.log(`\n${results.length - falhas.length}/${results.length} verificações passaram.`);
  if (falhas.length) {
    console.log("FALHAS:");
    for (const f of falhas) console.log(`  - ${f.name}`);
    process.exit(1);
  }
  console.log("Bridge OK.");
  process.exit(0);
}

main().catch((error) => {
  console.error("selftest quebrou:", error);
  process.exit(1);
});
