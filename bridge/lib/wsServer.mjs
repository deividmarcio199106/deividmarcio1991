/**
 * Servidor WebSocket mínimo (RFC 6455) sem dependências externas.
 *
 * A bridge roda na máquina do operador, ao lado do Profit. Um `npm install`
 * a mais é um passo a mais para dar errado no dia do pregão, então o
 * enquadramento é implementado aqui: só o que o T4 usa — texto, ping/pong e
 * close — e nada de extensões negociadas (permessage-deflate é recusado).
 */

import { createHash, randomUUID } from "node:crypto";

const HANDSHAKE_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

/** Um payload maior que isso não é tick de mercado: é defeito ou ataque. */
const MAX_FRAME_BYTES = 1_000_000;

function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

export class WsConnection {
  constructor(socket, id) {
    this.socket = socket;
    this.id = id;
    this.open = true;
    this.subscriptions = new Set();
    this.connectedAt = Date.now();
    this.lastPongAt = Date.now();
    this.messagesSent = 0;
  }

  sendJson(value) {
    return this.sendText(JSON.stringify(value));
  }

  sendText(text) {
    if (!this.open) return false;
    try {
      this.socket.write(encodeFrame(OPCODE.TEXT, Buffer.from(text, "utf8")));
      this.messagesSent += 1;
      return true;
    } catch {
      this.destroy();
      return false;
    }
  }

  ping() {
    if (!this.open) return;
    try {
      this.socket.write(encodeFrame(OPCODE.PING, Buffer.alloc(0)));
    } catch {
      this.destroy();
    }
  }

  close(code = 1000, reason = "") {
    if (!this.open) return;
    const reasonBuffer = Buffer.from(reason, "utf8");
    const payload = Buffer.alloc(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    try {
      this.socket.write(encodeFrame(OPCODE.CLOSE, payload));
    } catch {
      // socket já morto; destroy abaixo resolve
    }
    this.destroy();
  }

  destroy() {
    if (!this.open) return;
    this.open = false;
    try {
      this.socket.destroy();
    } catch {
      // nada a fazer: o socket já foi embora
    }
  }
}

/**
 * Concentrador de conexões WebSocket.
 *
 * Recebe o upgrade já parseado pelo servidor HTTP mínimo (`httpServer.mjs`).
 * `handlers.onMessage` recebe objetos JSON já convertidos; texto inválido é
 * descartado silenciosamente para que um cliente malformado não derrube a
 * bridge no meio do pregão.
 */
export function createWebSocketHub(handlers = {}) {
  const connections = new Set();

  function handleUpgrade(request, socket, head, secure = false) {
    const key = request.headers["sec-websocket-key"];
    const version = request.headers["sec-websocket-version"];
    if (!key || String(version) !== "13") {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }

    const accept = createHash("sha1")
      .update(key + HANDSHAKE_GUID)
      .digest("base64");

    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n",
      ].join("\r\n"),
    );
    socket.setNoDelay(true);

    const connection = new WsConnection(socket, randomUUID());
    connection.secure = secure;
    connection.origin = request.headers.origin ?? null;
    connections.add(connection);

    let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    let fragmentOpcode = null;
    let fragments = [];

    const finish = () => {
      if (!connections.delete(connection)) return;
      connection.open = false;
      handlers.onClose?.(connection);
    };

    socket.on("error", finish);
    socket.on("close", finish);

    // O `head` pode já conter frames completos: o cliente tem permissão de
    // enviar dados junto do upgrade. Processar só no próximo `data` perderia
    // a primeira mensagem em conexões rápidas.
    const drain = () => {
      for (;;) {
        if (buffer.length < 2) return;

        const fin = (buffer[0] & 0x80) !== 0;
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let length = buffer[1] & 0x7f;
        let offset = 2;

        if (length === 126) {
          if (buffer.length < offset + 2) return;
          length = buffer.readUInt16BE(offset);
          offset += 2;
        } else if (length === 127) {
          if (buffer.length < offset + 8) return;
          const big = buffer.readBigUInt64BE(offset);
          if (big > BigInt(MAX_FRAME_BYTES)) {
            connection.close(1009, "frame grande demais");
            return;
          }
          length = Number(big);
          offset += 8;
        }

        if (length > MAX_FRAME_BYTES) {
          connection.close(1009, "frame grande demais");
          return;
        }
        // O RFC obriga o cliente a mascarar; frame sem máscara é cliente quebrado.
        if (!masked) {
          connection.close(1002, "frame do cliente precisa de máscara");
          return;
        }
        if (buffer.length < offset + 4 + length) return;

        const mask = buffer.subarray(offset, offset + 4);
        offset += 4;
        const payload = Buffer.allocUnsafe(length);
        for (let i = 0; i < length; i += 1) payload[i] = buffer[offset + i] ^ mask[i % 4];
        buffer = buffer.subarray(offset + length);

        if (opcode === OPCODE.CLOSE) {
          connection.close(1000, "");
          return;
        }
        if (opcode === OPCODE.PING) {
          try {
            socket.write(encodeFrame(OPCODE.PONG, payload));
          } catch {
            connection.destroy();
          }
          continue;
        }
        if (opcode === OPCODE.PONG) {
          connection.lastPongAt = Date.now();
          continue;
        }

        if (opcode === OPCODE.CONTINUATION) {
          if (fragmentOpcode === null) continue;
          fragments.push(payload);
        } else {
          fragmentOpcode = opcode;
          fragments = [payload];
        }

        if (!fin) continue;

        const complete = Buffer.concat(fragments);
        const completedOpcode = fragmentOpcode;
        fragmentOpcode = null;
        fragments = [];

        if (completedOpcode !== OPCODE.TEXT) continue;
        let parsed;
        try {
          parsed = JSON.parse(complete.toString("utf8"));
        } catch {
          continue;
        }
        handlers.onMessage?.(connection, parsed);
      }
    };

    socket.on("data", (chunk) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      drain();
    });

    handlers.onConnection?.(connection);
    if (buffer.length) drain();
  }

  return {
    connections,
    handleUpgrade,
    broadcast(value, filter) {
      const text = JSON.stringify(value);
      let delivered = 0;
      for (const connection of connections) {
        if (filter && !filter(connection)) continue;
        if (connection.sendText(text)) delivered += 1;
      }
      return delivered;
    },
    closeAll(code, reason) {
      for (const connection of connections) connection.close(code, reason);
    },
  };
}
