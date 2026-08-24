#!/usr/bin/env node
/**
 * T4 BRIDGE — Profit RTD → WebSocket local.
 *
 * A bridge é um repetidor honesto: recebe ticks de um produtor RTD real
 * (planilha Excel com fórmulas RTD do Profit, ou qualquer programa que fale o
 * mesmo contrato HTTP), valida, carimba sequência e repassa por WebSocket.
 *
 * NÃO EXISTE MODO SIMULADO. Não há gerador de tick sintético, nem replay, nem
 * "demo". Se o Profit estiver fechado, a bridge fica sem dados e diz isso — é
 * exatamente esse silêncio que o T4 precisa enxergar para se bloquear.
 *
 * Uso:
 *   node bridge/t4-bridge.mjs [--port 8765] [--host 127.0.0.1] [--token SEGREDO]
 *   bun  bridge/t4-bridge.mjs
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createBridgeHttpServer } from "./lib/httpServer.mjs";
import { createWebSocketHub } from "./lib/wsServer.mjs";

const BRIDGE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Origens autorizadas a abrir WebSocket e a enviar ticks.
 *
 * Sem essa lista, qualquer página que o operador visitasse durante o pregão
 * poderia abrir um WebSocket para 127.0.0.1:8765 e ler o book em tempo real —
 * a política de mesma origem NÃO protege WebSocket. É o ataque conhecido como
 * Cross-Site WebSocket Hijacking.
 *
 * Requisição SEM cabeçalho `Origin` é aceita de propósito: navegador sempre
 * envia Origin, então a ausência identifica cliente nativo (a macro do Excel,
 * o script PowerShell, o selftest). Bloqueá-los quebraria o produtor RTD sem
 * fechar nenhuma brecha de navegador.
 */
const DEFAULT_ORIGINS = [
  "https://analisador.dvdswap.com.br",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

/** A bridge nunca escuta fora do loopback. Ver `--host`. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export const BRIDGE_VERSION = "1.0.0";

const HEARTBEAT_MS = 1_000;
/** Sem ingest por mais que isso, o produtor é declarado parado. */
const PRODUCER_STALE_MS = 10_000;
/** Um tick no futuro além disso é relógio errado, não latência. */
const MAX_FUTURE_SKEW_MS = 60_000;
/** Retenção só para diagnóstico de continuidade; a série real vive no site. */
const RECENT_TICKS_PER_SYMBOL = 20;

function parseArgs(argv) {
  const args = {
    port: 8765,
    host: "127.0.0.1",
    token: "",
    certPath: "",
    keyPath: "",
    extraOrigins: [],
    noTls: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--port" && value) args.port = Number(value);
    else if (key === "--host" && value) args.host = value;
    else if (key === "--token" && value) args.token = value;
    else if (key === "--cert" && value) args.certPath = value;
    else if (key === "--key" && value) args.keyPath = value;
    else if (key === "--origin" && value) args.extraOrigins.push(value);
    else if (key === "--no-tls") args.noTls = true;
  }
  if (process.env.T4_BRIDGE_PORT) args.port = Number(process.env.T4_BRIDGE_PORT);
  if (process.env.T4_BRIDGE_HOST) args.host = process.env.T4_BRIDGE_HOST;
  if (process.env.T4_BRIDGE_TOKEN) args.token = process.env.T4_BRIDGE_TOKEN;
  if (process.env.T4_BRIDGE_CERT) args.certPath = process.env.T4_BRIDGE_CERT;
  if (process.env.T4_BRIDGE_KEY) args.keyPath = process.env.T4_BRIDGE_KEY;
  if (process.env.T4_BRIDGE_ORIGINS) {
    args.extraOrigins.push(...process.env.T4_BRIDGE_ORIGINS.split(",").map((o) => o.trim()));
  }
  if (!Number.isFinite(args.port) || args.port <= 0 || args.port > 65_535) args.port = 8765;
  return args;
}

export function normalizeOrigin(raw) {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\/+$/, "");
}

export function buildOriginAllowlist(extra = []) {
  const list = new Set(DEFAULT_ORIGINS.map(normalizeOrigin));
  for (const origin of extra) {
    const normalized = normalizeOrigin(origin);
    if (normalized) list.add(normalized);
  }
  return list;
}

/**
 * Origem ausente = cliente nativo (permitido). Origem presente e fora da lista
 * = página de terceiro tentando ler o feed (recusado).
 */
export function originAllowed(origin, allowlist) {
  if (origin === undefined || origin === null || origin === "") return true;
  return allowlist.has(normalizeOrigin(origin));
}

/**
 * Carrega o par certificado/chave. Sem TLS a bridge continua funcionando em
 * texto claro — é o modo de desenvolvimento —, mas o site em HTTPS não conecta.
 */
export function loadTlsMaterial({ certPath, keyPath, noTls }, log = () => {}) {
  if (noTls) return null;
  const cert = certPath || join(BRIDGE_DIR, "tls", "cert.pem");
  const key = keyPath || join(BRIDGE_DIR, "tls", "key.pem");
  if (!existsSync(cert) || !existsSync(key)) {
    if (certPath || keyPath) {
      log(`[bridge] AVISO: certificado ou chave não encontrados (${cert} / ${key}).`);
    }
    return null;
  }
  try {
    return { cert: readFileSync(cert), key: readFileSync(key), certPath: cert, keyPath: key };
  } catch (error) {
    log(`[bridge] AVISO: falha ao ler o certificado: ${error.message}`);
    return null;
  }
}

/**
 * Converte o timestamp do produtor em epoch ms.
 *
 * Aceita epoch (ms ou s) e ISO. ISO **sem** fuso é interpretado no fuso local
 * da máquina — que é o fuso do pregão, já que a bridge roda ao lado do Profit.
 */
export function parseTimestamp(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // Abaixo de 10^12 é segundo, não milissegundo (10^12 ms = 2001).
    return raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw);
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return parseTimestamp(Number(trimmed));

  // "13:45:12" ou "13:45" sozinho: hora do pregão no dia corrente local.
  const timeOnly = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,](\d{1,3}))?$/.exec(trimmed);
  if (timeOnly) {
    const now = new Date();
    const date = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      Number(timeOnly[1]),
      Number(timeOnly[2]),
      Number(timeOnly[3] ?? 0),
      Number((timeOnly[4] ?? "0").padEnd(3, "0")),
    );
    return date.getTime();
  }

  const normalized = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteOrNull(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const value = typeof raw === "string" ? Number(raw.replace(",", ".")) : Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Normaliza e valida um tick cru. Retorna `{ tick }` ou `{ error }` — nunca
 * conserta um dado ruim por conta própria.
 */
export function normalizeTick(raw, now = Date.now()) {
  if (!raw || typeof raw !== "object") return { error: "payload não é objeto" };

  const symbol = String(raw.symbol ?? raw.ativo ?? "")
    .trim()
    .toUpperCase();
  if (!symbol) return { error: "symbol ausente" };
  if (symbol.length > 24) return { error: "symbol inválido" };

  const timestamp = parseTimestamp(raw.timestamp ?? raw.time ?? raw.hora);
  if (timestamp === null) return { error: "timestamp ausente ou ilegível" };
  if (timestamp > now + MAX_FUTURE_SKEW_MS) return { error: "timestamp no futuro" };

  const price = finiteOrNull(raw.price ?? raw.preco ?? raw.ultimo);
  if (price === null) return { error: "price ausente" };
  if (price <= 0) return { error: "price não positivo" };

  const bid = finiteOrNull(raw.bid ?? raw.compra);
  const ask = finiteOrNull(raw.ask ?? raw.venda);

  return {
    tick: {
      symbol,
      timestamp,
      price,
      bid: bid !== null && bid > 0 ? bid : null,
      ask: ask !== null && ask > 0 ? ask : null,
      /** Volume ACUMULADO do dia, como o RTD publica. */
      volume: finiteOrNull(raw.volume) ?? null,
      /** Quantidade do negócio individual. */
      qty: finiteOrNull(raw.qty ?? raw.quantidade) ?? null,
      receivedAt: now,
    },
  };
}

export function createBridgeState() {
  return {
    sessionId: randomUUID(),
    startedAt: Date.now(),
    symbols: new Map(),
    ticksAccepted: 0,
    ticksRejected: 0,
    lastIngestAt: null,
    lastRejection: null,
  };
}

export function acceptTick(state, raw, now = Date.now()) {
  const result = normalizeTick(raw, now);
  if (result.error) {
    state.ticksRejected += 1;
    state.lastRejection = { reason: result.error, at: now };
    return { error: result.error };
  }

  const { tick } = result;
  let entry = state.symbols.get(tick.symbol);
  if (!entry) {
    entry = { seq: 0, count: 0, firstAt: now, lastTick: null, recent: [] };
    state.symbols.set(tick.symbol, entry);
  }
  entry.seq += 1;
  entry.count += 1;
  const stamped = { ...tick, seq: entry.seq };
  entry.lastTick = stamped;
  entry.recent.push(stamped);
  if (entry.recent.length > RECENT_TICKS_PER_SYMBOL) entry.recent.shift();

  state.ticksAccepted += 1;
  state.lastIngestAt = now;
  return { tick: stamped };
}

export function producerState(state, now = Date.now()) {
  if (state.lastIngestAt === null) return "WAITING";
  return now - state.lastIngestAt > PRODUCER_STALE_MS ? "STALE" : "LIVE";
}

export function healthPayload(state, connectionCount, now = Date.now(), tlsEnabled = false) {
  return {
    ok: true,
    service: "t4-bridge",
    version: BRIDGE_VERSION,
    /** true quando a bridge aceita wss:// além de ws:// na mesma porta. */
    tls: tlsEnabled,
    sessionId: state.sessionId,
    serverTime: now,
    uptimeMs: now - state.startedAt,
    producer: producerState(state, now),
    lastIngestAt: state.lastIngestAt,
    lastIngestAgeMs: state.lastIngestAt === null ? null : now - state.lastIngestAt,
    ticksAccepted: state.ticksAccepted,
    ticksRejected: state.ticksRejected,
    lastRejection: state.lastRejection,
    clients: connectionCount,
    symbols: [...state.symbols.entries()].map(([symbol, entry]) => ({
      symbol,
      ticks: entry.count,
      seq: entry.seq,
      lastTimestamp: entry.lastTick?.timestamp ?? null,
      lastPrice: entry.lastTick?.price ?? null,
      ageMs: entry.lastTick ? now - entry.lastTick.receivedAt : null,
    })),
  };
}

/**
 * O CORS existe para o painel de diagnóstico do site poder ler `/health`. Ele
 * ecoa a origem autorizada em vez de responder `*`: com `*` qualquer página
 * conseguiria ler o estado do feed do operador.
 */
function jsonHeaders(origin, allowlist) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-headers": "content-type, x-bridge-token",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    vary: "Origin",
  };
  if (origin && allowlist.has(normalizeOrigin(origin))) {
    headers["access-control-allow-origin"] = origin;
  }
  return headers;
}

export function startBridge(options = {}) {
  const {
    port = 8765,
    host = "127.0.0.1",
    token = "",
    log = console.log,
    extraOrigins = [],
    certPath = "",
    keyPath = "",
    noTls = false,
  } = options;

  // Escutar fora do loopback exporia o feed do Profit à rede — e, com
  // encaminhamento de porta, à internet. Não é opção configurável: é recusa.
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `host inválido: ${host}. A bridge só escuta em loopback (127.0.0.1, ::1 ou localhost). ` +
        `Expor o feed à rede não é suportado.`,
    );
  }

  const allowlist = buildOriginAllowlist(extraOrigins);
  const tlsMaterial = loadTlsMaterial({ certPath, keyPath, noTls }, log);
  const state = createBridgeState();

  function wants(connection, symbol) {
    return connection.subscriptions.size === 0 || connection.subscriptions.has(symbol);
  }

  const ws = createWebSocketHub({
    onConnection(connection) {
      connection.sendJson({
        type: "hello",
        service: "t4-bridge",
        version: BRIDGE_VERSION,
        sessionId: state.sessionId,
        serverTime: Date.now(),
        producer: producerState(state),
        symbols: [...state.symbols.entries()].map(([symbol, entry]) => ({
          symbol,
          seq: entry.seq,
          lastTick: entry.lastTick,
        })),
      });
      log(`[bridge] cliente conectado (${ws.connections.size} ativo(s))`);
    },
    onMessage(connection, message) {
      if (!message || typeof message !== "object") return;
      if (message.type === "subscribe") {
        connection.subscriptions.clear();
        const symbols = Array.isArray(message.symbols) ? message.symbols : [];
        for (const symbol of symbols) {
          if (typeof symbol === "string" && symbol.trim()) {
            connection.subscriptions.add(symbol.trim().toUpperCase());
          }
        }
        const entry = [...connection.subscriptions][0]
          ? state.symbols.get([...connection.subscriptions][0])
          : null;
        connection.sendJson({
          type: "subscribed",
          symbols: [...connection.subscriptions],
          serverTime: Date.now(),
          lastTick: entry?.lastTick ?? null,
        });
        return;
      }
      if (message.type === "ping") {
        // clientTime volta intocado: é assim que o site mede drift e latência.
        connection.sendJson({
          type: "pong",
          clientTime: message.clientTime ?? null,
          serverTime: Date.now(),
        });
      }
    },
    onClose() {
      log(`[bridge] cliente desconectado (${ws.connections.size} ativo(s))`);
    },
  });

  const httpServer = createBridgeHttpServer({
    tls: tlsMaterial ? { key: tlsMaterial.key, cert: tlsMaterial.cert } : null,
    onUpgrade: (request, socket, head, secure) => {
      const origin = request.headers.origin;
      if (!originAllowed(origin, allowlist)) {
        log(`[bridge] upgrade recusado: origem não autorizada (${origin})`);
        socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      ws.handleUpgrade(request, socket, head, secure);
    },
    onRequest: (request, respond) => {
      const headers = jsonHeaders(request.headers.origin, allowlist);
      const json = (status, payload) => respond(status, headers, JSON.stringify(payload));

      if (request.method === "OPTIONS") {
        respond(204, headers, "");
        return;
      }

      if (!originAllowed(request.headers.origin, allowlist)) {
        json(403, { ok: false, error: "origem não autorizada" });
        return;
      }

      if (request.path === "/health" || request.path === "/") {
        json(200, healthPayload(state, ws.connections.size, Date.now(), tlsMaterial !== null));
        return;
      }

      if (request.path === "/ingest") {
        if (request.method !== "POST") {
          json(405, { ok: false, error: "use POST" });
          return;
        }
        if (token && request.headers["x-bridge-token"] !== token) {
          json(401, { ok: false, error: "token inválido" });
          return;
        }
        let payload;
        try {
          payload = JSON.parse(request.body);
        } catch (error) {
          json(400, { ok: false, error: `JSON inválido: ${error.message}` });
          return;
        }

        const batch = Array.isArray(payload) ? payload : [payload];
        const accepted = [];
        const errors = [];
        const now = Date.now();
        for (const raw of batch) {
          const result = acceptTick(state, raw, now);
          if (result.error) errors.push(result.error);
          else accepted.push(result.tick);
        }
        for (const tick of accepted) {
          ws.broadcast({ type: "tick", tick }, (connection) => wants(connection, tick.symbol));
        }
        json(errors.length && !accepted.length ? 400 : 200, {
          ok: accepted.length > 0,
          accepted: accepted.length,
          rejected: errors.length,
          errors: errors.slice(0, 10),
        });
        return;
      }

      json(404, { ok: false, error: "rota inexistente" });
    },
  });

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const connection of ws.connections) connection.ping();
    ws.broadcast({
      type: "heartbeat",
      serverTime: now,
      sessionId: state.sessionId,
      producer: producerState(state, now),
      lastIngestAt: state.lastIngestAt,
      ticksAccepted: state.ticksAccepted,
      ticksRejected: state.ticksRejected,
    });
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  // `localhost` no Windows resolve para ::1 antes de 127.0.0.1. Escutar nos
  // dois endereços de loopback evita que `wss://localhost:8765` bata em porta
  // fechada — e continua sem expor nada fora da máquina.
  const bindHosts = host === "::1" ? ["::1"] : ["127.0.0.1", "::1"];

  httpServer.listen(port, bindHosts, (bound) => {
    log(`[bridge] t4-bridge ${BRIDGE_VERSION} — sessão ${state.sessionId}`);
    log(`[bridge] Loopback   ${bound.join(", ")}`);
    if (tlsMaterial) {
      log(`[bridge] WebSocket  wss://localhost:${port}  (site em HTTPS)`);
      log(`[bridge] WebSocket  ws://${host}:${port}      (site em HTTP local)`);
      log(`[bridge] TLS        ${tlsMaterial.certPath}`);
    } else {
      log(`[bridge] WebSocket  ws://${host}:${port}`);
      log(`[bridge] TLS        DESLIGADO — o site em HTTPS não vai conseguir conectar.`);
      log(`[bridge]            Rode: powershell -File bridge/tls/setup-rtd-tls.ps1`);
    }
    log(`[bridge] Ingest     POST http://${host}:${port}/ingest`);
    log(`[bridge] Health     GET  http://${host}:${port}/health`);
    log(`[bridge] Origens    ${[...allowlist].join(", ")}`);
    log(`[bridge] Escutando somente em loopback. Aguardando ticks reais do Profit.`);
  });

  httpServer.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      log(`[bridge] ERRO: porta ${port} já está em uso. Outra bridge está aberta?`);
      process.exitCode = 1;
      return;
    }
    log(`[bridge] ERRO: ${error.message}`);
    process.exitCode = 1;
  });

  return {
    state,
    httpServer,
    ws,
    close() {
      clearInterval(heartbeat);
      ws.closeAll(1001, "bridge encerrando");
      httpServer.close();
    },
  };
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  const bridge = startBridge(args);
  const shutdown = () => {
    bridge.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
