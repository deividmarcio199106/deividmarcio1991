/**
 * Servidor HTTP/1.1 mínimo sobre `node:net`, com TLS opcional na MESMA porta.
 *
 * Por que não `node:http`: o Bun não repassa a escrita no socket entregue pelo
 * evento `upgrade` do `node:http` — o handshake WebSocket é montado, o
 * `socket.write` devolve `true`, e nada chega ao cliente. Sobre `node:net` o
 * comportamento é idêntico em Node e Bun, e a bridge precisa rodar nos dois:
 * é software de máquina de operador, não de servidor controlado.
 *
 * TEXTO CLARO E TLS NA MESMA PORTA
 *
 * A porta 8765 precisa atender dois públicos com exigências opostas:
 *
 *   - o site em https://analisador.dvdswap.com.br, que só pode abrir `wss://`
 *     porque o navegador bloqueia conteúdo misto;
 *   - o produtor RTD (macro do Excel, script PowerShell), que fala HTTP em
 *     texto claro para 127.0.0.1 e não tem como validar certificado.
 *
 * Servir só TLS quebraria o produtor. Servir só texto claro quebraria a
 * produção. Então o primeiro byte decide: `0x16` é um ClientHello TLS,
 * qualquer letra ASCII é um método HTTP.
 *
 * O ramo TLS é encaminhado por pipe para um `tls.createServer` interno em
 * loopback, e NÃO por `new tls.TLSSocket(socket, {isServer:true})`. Esse
 * caminho parece o óbvio e está quebrado no Bun 1.3.14: o objeto é construído
 * sem lançar, o handshake nunca começa, nenhum evento `secure` e NENHUM erro
 * são emitidos, e o cliente só morre por timeout. Verificado experimentalmente:
 * o `_start()` interno do Bun exige `port`/`path`, ou seja, só implementa o
 * lado cliente. Falha silenciosa custa horas; o pipe custa um salto em
 * loopback.
 */

import { createServer as createTcpServer, connect as netConnect } from "node:net";
import { createServer as createTlsServer } from "node:tls";

/** Cabeçalho maior que isso não é requisição legítima. */
const MAX_HEAD_BYTES = 16_384;
const MAX_BODY_BYTES = 4_000_000;
/** Primeiro byte de um ClientHello TLS (content type: handshake). */
const TLS_HANDSHAKE_BYTE = 0x16;

function parseHead(text) {
  const lines = text.split("\r\n");
  const requestLine = lines[0] ?? "";
  const [method, target, version] = requestLine.split(" ");
  if (!method || !target) return null;

  const headers = Object.create(null);
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }

  const queryAt = target.indexOf("?");
  return {
    method: method.toUpperCase(),
    target,
    path: queryAt === -1 ? target : target.slice(0, queryAt),
    query: queryAt === -1 ? "" : target.slice(queryAt + 1),
    version: version ?? "HTTP/1.1",
    headers,
  };
}

const STATUS_TEXT = {
  200: "OK",
  204: "No Content",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  413: "Payload Too Large",
  500: "Internal Server Error",
};

function writeResponse(socket, status, headers, body, keepAlive) {
  const payload = body === null || body === undefined ? Buffer.alloc(0) : Buffer.from(body, "utf8");
  const lines = [`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "OK"}`];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  lines.push(`Content-Length: ${payload.length}`);
  lines.push(`Connection: ${keepAlive ? "keep-alive" : "close"}`);
  lines.push("", "");
  socket.write(Buffer.concat([Buffer.from(lines.join("\r\n"), "latin1"), payload]));
  if (!keepAlive) socket.end();
}

/**
 * @param {object} options
 * @param {(request: object, respond: Function) => void} options.onRequest
 * @param {(request: object, socket: import("node:net").Socket, head: Buffer, secure: boolean) => void} options.onUpgrade
 * @param {{key: Buffer, cert: Buffer} | null} [options.tls] Ativa WSS/HTTPS na mesma porta.
 */
export function createBridgeHttpServer({ onRequest, onUpgrade, tls = null }) {
  /** Trata uma conexão já em texto claro (ou já decifrada pelo TLS interno). */
  function handleConnection(socket, secure) {
    socket.setNoDelay(true);

    let buffer = Buffer.alloc(0);
    let request = null;
    let bodyLength = 0;
    let upgraded = false;

    const fail = (status, message) => {
      writeResponse(
        socket,
        status,
        { "content-type": "text/plain; charset=utf-8" },
        message,
        false,
      );
    };

    socket.on("error", () => socket.destroy());

    socket.on("data", (chunk) => {
      if (upgraded) return;
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);

      for (;;) {
        if (!request) {
          const separator = buffer.indexOf("\r\n\r\n");
          if (separator === -1) {
            if (buffer.length > MAX_HEAD_BYTES) fail(413, "cabeçalho grande demais");
            return;
          }
          const parsed = parseHead(buffer.subarray(0, separator).toString("latin1"));
          if (!parsed) {
            fail(400, "requisição malformada");
            return;
          }
          buffer = buffer.subarray(separator + 4);

          const upgradeHeader = (parsed.headers.upgrade ?? "").toLowerCase();
          if (upgradeHeader === "websocket") {
            upgraded = true;
            const head = buffer;
            buffer = Buffer.alloc(0);
            onUpgrade(parsed, socket, head, secure);
            return;
          }

          bodyLength = Number(parsed.headers["content-length"] ?? 0);
          if (!Number.isFinite(bodyLength) || bodyLength < 0) {
            fail(400, "Content-Length inválido");
            return;
          }
          if (bodyLength > MAX_BODY_BYTES) {
            fail(413, "corpo grande demais");
            return;
          }
          request = parsed;
        }

        if (buffer.length < bodyLength) return;

        const body = buffer.subarray(0, bodyLength).toString("utf8");
        buffer = buffer.subarray(bodyLength);
        const current = request;
        request = null;
        bodyLength = 0;

        // HTTP/1.1 é keep-alive por padrão; só fechamos se o cliente pedir.
        const keepAlive =
          current.version === "HTTP/1.1" &&
          (current.headers.connection ?? "").toLowerCase() !== "close";

        onRequest({ ...current, body, secure }, (status, headers, responseBody) => {
          writeResponse(socket, status, headers, responseBody, keepAlive);
        });

        if (!keepAlive) return;
      }
    });
  }

  // Terminador TLS interno: escuta só em loopback, numa porta efêmera que
  // nunca é anunciada. Quem chega nele já passou pelo sniffing da porta pública.
  let tlsServer = null;
  let tlsPort = 0;
  if (tls) {
    tlsServer = createTlsServer({ key: tls.key, cert: tls.cert }, (socket) =>
      handleConnection(socket, true),
    );
    // Handshake recusado (cliente sem confiar no certificado) não pode derrubar
    // a bridge: é o caso mais comum antes de rodar o setup do certificado.
    tlsServer.on("tlsClientError", () => {});
    tlsServer.on("error", () => {});
  }

  function acceptConnection(socket) {
    if (!tlsServer) {
      handleConnection(socket, false);
      return;
    }

    const onReadable = () => {
      const first = socket.read(1);
      if (first === null) return;
      socket.removeListener("readable", onReadable);
      // O byte volta para a fila e reaparece como um evento `data` separado —
      // por isso o parser acima sempre acumula em vez de olhar chunk a chunk.
      socket.unshift(first);

      if (first[0] !== TLS_HANDSHAKE_BYTE) {
        handleConnection(socket, false);
        return;
      }

      const upstream = netConnect(tlsPort, "127.0.0.1", () => {
        upstream.setNoDelay(true);
        socket.pipe(upstream).pipe(socket);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
    };

    socket.on("readable", onReadable);
    socket.on("error", () => socket.destroy());
  }

  /**
   * Um `net.Server` escuta em UM endereço. Loopback tem dois — 127.0.0.1 e ::1
   * — e no Windows `localhost` resolve para `::1` primeiro. Escutar só no IPv4
   * faria `wss://localhost:8765` bater em porta fechada antes de tentar o IPv4.
   * Por isso: um servidor por endereço de loopback, nunca `0.0.0.0`.
   */
  const servers = [];
  const errorHandlers = [];

  function emitError(error) {
    for (const handler of errorHandlers) handler(error);
  }

  return {
    get servers() {
      return servers;
    },
    get tlsEnabled() {
      return tlsServer !== null;
    },
    listen(port, hosts, callback) {
      const targets = Array.isArray(hosts) ? hosts : [hosts];
      let pending = targets.length;
      const bound = [];

      const startListeners = () => {
        for (const host of targets) {
          const server = createTcpServer(acceptConnection);
          servers.push(server);
          server.on("error", (error) => {
            // Máquina sem IPv6 é comum: falhar ali não pode derrubar a bridge
            // se o IPv4 subiu. Porta ocupada, sim, é erro de verdade.
            if (error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT") {
              pending -= 1;
              if (pending === 0) callback?.(bound);
              return;
            }
            emitError(error);
          });
          server.listen(port, host, () => {
            bound.push(host);
            pending -= 1;
            if (pending === 0) callback?.(bound);
          });
        }
      };

      if (!tlsServer) {
        startListeners();
        return;
      }
      tlsServer.listen(0, "127.0.0.1", () => {
        tlsPort = tlsServer.address().port;
        startListeners();
      });
    },
    on(event, handler) {
      if (event === "error") errorHandlers.push(handler);
    },
    close() {
      for (const server of servers) server.close();
      tlsServer?.close();
    },
  };
}
