/**
 * A PONTE CLAUDE — um servidor local que imita a API do Ollama e entrega cada
 * leitura de visão ao PRÓPRIO Claude da sessão, via arquivos.
 *
 * POR QUE EXISTE: a GPU vast.ai caiu no meio do baseline (22/08 ~19:47) e o
 * dono mandou "faça com a GPU da Claude". O pipeline não muda uma linha —
 * OLLAMA_BASE_URL aponta para cá; cada POST /api/chat vira um req-N.json na
 * fila, o agente lê a imagem e grava res-N.json, e a resposta volta no formato
 * do Ollama. O ledger continua valendo: a percepção fica registrada com
 * modelo "claude-ponte".
 *
 * Uso: node t4-learning/campanha/ponte-claude.mjs   (porta 11436)
 */
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";

const PORTA = 11436;
const FILA = "t4-learning/campanha/ponte";
mkdirSync(FILA, { recursive: true });
// Limpa pedidos orfaos de execucoes anteriores.
for (const f of existsSync(FILA) ? readdirSync(FILA) : []) {
  try {
    unlinkSync(`${FILA}/${f}`);
  } catch {}
}

let contador = 0;

function esperarResposta(caminho, timeoutMs) {
  return new Promise((resolver) => {
    const inicio = Date.now();
    const intervalo = setInterval(() => {
      if (existsSync(caminho)) {
        clearInterval(intervalo);
        try {
          resolver(JSON.parse(readFileSync(caminho, "utf8")));
        } catch {
          resolver(null);
        }
        return;
      }
      if (Date.now() - inicio > timeoutMs) {
        clearInterval(intervalo);
        resolver(null);
      }
    }, 400);
  });
}

const servidor = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/api/tags") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ models: [{ name: "claude-ponte", model: "claude-ponte" }] }));
    return;
  }
  if (req.method !== "POST" || req.url !== "/api/chat") {
    res.writeHead(404);
    res.end();
    return;
  }
  let corpo = "";
  req.on("data", (c) => (corpo += c));
  req.on("end", async () => {
    let pedido;
    try {
      pedido = JSON.parse(corpo);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const id = ++contador;
    const mensagem = pedido.messages?.[0] ?? {};
    const registro = {
      id,
      criadoEm: new Date().toISOString(),
      format: pedido.format ?? null,
      prompt: mensagem.content ?? "",
      imagens: (mensagem.images ?? []).length,
    };
    // A imagem vai em arquivo proprio para o agente ler direto.
    for (let i = 0; i < (mensagem.images ?? []).length; i++) {
      writeFileSync(`${FILA}/req-${id}-img-${i}.png`, Buffer.from(mensagem.images[i], "base64"));
    }
    writeFileSync(`${FILA}/req-${id}.json`, JSON.stringify(registro, null, 1), "utf8");
    console.log(`[ponte] req-${id} (${registro.imagens} img, prompt ${registro.prompt.length}b)`);
    const resposta = await esperarResposta(`${FILA}/res-${id}.json`, 165_000);
    // Limpeza do pedido atendido (ou expirado).
    for (let i = 0; i < registro.imagens; i++) {
      try {
        unlinkSync(`${FILA}/req-${id}-img-${i}.png`);
      } catch {}
    }
    try {
      unlinkSync(`${FILA}/req-${id}.json`);
    } catch {}
    if (resposta === null) {
      console.log(`[ponte] req-${id} EXPIROU sem resposta do agente`);
      res.writeHead(504, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "ponte sem resposta" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        model: "claude-ponte",
        created_at: new Date().toISOString(),
        message: { role: "assistant", content: resposta.content ?? "" },
        done: true,
      }),
    );
    console.log(`[ponte] req-${id} respondida (${(resposta.content ?? "").length}b)`);
  });
});

servidor.listen(PORTA, "127.0.0.1", () => {
  console.log(`[ponte] Claude atendendo leituras em http://127.0.0.1:${PORTA} — fila em ${FILA}`);
});
