import { sanitizeSecrets, sanitizeUnknown } from "@/lib/errors/sanitize";
import { recordError } from "./errorRepository";
import {
  allowedCommands,
  applyChange,
  attachTests,
  getChange,
  listChanges,
  listFiles,
  proposePatch,
  readFileSafe,
  rejectChange,
  revertChange,
  runWhitelistedCommand,
  searchCode,
} from "./adminTools";

/**
 * CLAUDE ADMIN — backend (comando §5–§10).
 *
 * A chave Anthropic vive SOMENTE no .env do servidor (ANTHROPIC_API_KEY) e
 * jamais é enviada ao navegador: o frontend fala com /api/admin/claude/* e o
 * BACKEND fala com a Anthropic. Todas as rotas exigem o token de admin
 * (ADMIN_TOKEN no .env, header x-admin-token) e têm rate-limit.
 *
 * O modelo usa apenas ferramentas internas controladas — nunca shell
 * arbitrário — e NUNCA aplica alteração sozinho: proposePatch registra a
 * proposta; aplicar/rejeitar/reverter são botões do usuário com snapshot
 * automático antes de qualquer escrita.
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_TOOL_ROUNDS = 8;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// --- auth + rate limit -----------------------------------------------------

const rateBuckets = new Map<string, number[]>();

function rateLimited(key: string, maxPerMinute = 20): boolean {
  const now = Date.now();
  // Teto do mapa: um atacante variando chaves não cresce memória sem limite.
  if (rateBuckets.size > 1_000) rateBuckets.clear();
  const bucket = (rateBuckets.get(key) ?? []).filter((at) => now - at < 60_000);
  if (bucket.length >= maxPerMinute) {
    rateBuckets.set(key, bucket);
    return true;
  }
  bucket.push(now);
  rateBuckets.set(key, bucket);
  return false;
}

function checkAdmin(request: Request): Response | null {
  const configured = process.env["ADMIN_TOKEN"]?.trim();
  if (!configured) {
    return json(
      {
        error:
          "Claude Admin desativado: defina ADMIN_TOKEN no .env da VPS para habilitar /claude e /erros como áreas administrativas.",
      },
      503,
    );
  }
  // Rate-limit ANTES de comparar o token: tentativas erradas também contam —
  // sem isso o brute-force do ADMIN_TOKEN seria ilimitado.
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (rateLimited(`admin_${ip}`)) {
    return json({ error: "Rate-limit: aguarde um minuto antes de novas chamadas." }, 429);
  }
  const provided = request.headers.get("x-admin-token")?.trim();
  if (!provided || provided !== configured) {
    return json({ error: "Não autorizado. Informe o token de admin." }, 401);
  }
  return null;
}

// --- Anthropic agentic loop ------------------------------------------------

interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const TOOLS: ToolSpec[] = [
  {
    name: "listFiles",
    description: "Lista arquivos/diretórios do projeto (relativo à raiz permitida).",
    input_schema: {
      type: "object",
      properties: { dir: { type: "string", description: "Diretório relativo, ex.: src/lib" } },
    },
  },
  {
    name: "readFile",
    description: "Lê um arquivo do projeto (conteúdo sanitizado, máx. 512KB).",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "searchCode",
    description: "Busca texto no código do projeto e devolve caminho+linha.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" }, dir: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "proposePatch",
    description:
      "REGISTRA uma proposta de alteração (arquivo completo novo). NÃO aplica: o usuário verá o diff e decidirá aplicar/rejeitar.",
    input_schema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        newContent: { type: "string" },
        description: {
          type: "string",
          description: "problema, causa, alteração e risco — resumidos",
        },
      },
      required: ["filePath", "newContent", "description"],
    },
  },
  {
    name: "runCommand",
    description:
      "Executa SOMENTE um comando da whitelist: test, typecheck, lint, build, 'git diff', 'git status'.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", enum: allowedCommands() } },
      required: ["name"],
    },
  },
];

const SYSTEM_PROMPT = `Você é o Claude Admin do ANALISADOR_T4_VALIDADO, operando DENTRO do próprio analisador.
Regras invioláveis:
- NUNCA modifique silenciosamente a lógica oficial T4.0.0: gates, entrada, stop, RR>=3, 3R, 5R, runner estrutural, anti-lookahead. Mudança estratégica exige nova versão e validação no laboratório — responda isso quando pedirem.
- Você pode corrigir UI, bugs, captura, gravação, performance, APIs, logs, infraestrutura de código e testes.
- Antes de propor alteração, localize a CAUSA RAIZ lendo os arquivos relevantes (readFile/searchCode).
- Use proposePatch com o ARQUIVO COMPLETO novo; explique problema, causa, alteração e risco na descrição. O usuário aprova ou rejeita pelo diff — nunca diga que você já aplicou.
- Não peça nem exiba segredos (.env, chaves, tokens); o conteúdo já chega sanitizado.
- Responda em português, direto e técnico.`;

type AnthropicContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContent[];
}

async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "listFiles":
      return JSON.stringify(listFiles(typeof input.dir === "string" ? input.dir : "."));
    case "readFile":
      return JSON.stringify(readFileSafe(String(input.path ?? "")));
    case "searchCode":
      return JSON.stringify(
        searchCode(String(input.query ?? ""), typeof input.dir === "string" ? input.dir : "src"),
      );
    case "proposePatch": {
      const change = proposePatch({
        filePath: String(input.filePath ?? ""),
        newContent: String(input.newContent ?? ""),
        description: String(input.description ?? ""),
      });
      return JSON.stringify({
        changeId: change.changeId,
        status: change.status,
        files: change.files.map((file) => ({
          path: file.path,
          addedLines: file.addedLines,
          removedLines: file.removedLines,
        })),
        note: "Proposta registrada. O usuário decide aplicar/rejeitar na aba DIFF.",
      });
    }
    case "runCommand":
      return JSON.stringify(await runWhitelistedCommand(String(input.name ?? "")));
    default:
      throw new Error(`Ferramenta desconhecida: ${name}`);
  }
}

async function callAnthropic(
  messages: AnthropicMessage[],
): Promise<{ content: AnthropicContent[]; stopReason: string }> {
  const apiKey = process.env["ANTHROPIC_API_KEY"]?.trim();
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY não configurada no .env da VPS. A chave nunca deve ir ao navegador.",
    );
  }
  const model = process.env["ANTHROPIC_MODEL"]?.trim() || DEFAULT_MODEL;
  const response = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      model,
      max_tokens: 8_000,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    }),
  });
  if (!response.ok) {
    const detail = sanitizeSecrets(await response.text()).slice(0, 500);
    throw new Error(`Anthropic HTTP ${response.status}: ${detail}`);
  }
  const payload = (await response.json()) as {
    content: AnthropicContent[];
    stop_reason: string;
  };
  return { content: payload.content ?? [], stopReason: payload.stop_reason ?? "end_turn" };
}

interface ChatTurnLog {
  role: "assistant" | "tool";
  text?: string;
  tool?: { name: string; input: unknown; output: string; isError: boolean };
}

async function runChat(
  userMessages: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<{
  turns: ChatTurnLog[];
  changes: string[];
}> {
  const messages: AnthropicMessage[] = userMessages.map((message) => ({
    role: message.role,
    content: sanitizeSecrets(message.content).slice(0, 24_000),
  }));
  const turns: ChatTurnLog[] = [];
  const changes: string[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const { content, stopReason } = await callAnthropic(messages);
    const toolUses = content.filter(
      (block): block is Extract<AnthropicContent, { type: "tool_use" }> =>
        block.type === "tool_use",
    );
    for (const block of content) {
      if (block.type === "text" && block.text.trim()) {
        turns.push({ role: "assistant", text: block.text });
      }
    }
    if (toolUses.length === 0 || stopReason !== "tool_use") break;

    messages.push({ role: "assistant", content });
    const results: AnthropicContent[] = [];
    for (const toolUse of toolUses) {
      let output = "";
      let isError = false;
      try {
        output = await executeTool(toolUse.name, toolUse.input ?? {});
        if (toolUse.name === "proposePatch") {
          const parsed = JSON.parse(output) as { changeId?: string };
          if (parsed.changeId) changes.push(parsed.changeId);
        }
      } catch (error) {
        isError = true;
        output = error instanceof Error ? error.message : String(error);
      }
      turns.push({
        role: "tool",
        tool: {
          name: toolUse.name,
          input:
            toolUse.name === "proposePatch"
              ? { filePath: (toolUse.input as { filePath?: string }).filePath }
              : toolUse.input,
          output: output.slice(0, 2_000),
          isError,
        },
      });
      results.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: output.slice(0, 40_000),
        is_error: isError || undefined,
      });
    }
    messages.push({ role: "user", content: results });
  }
  return { turns, changes };
}

// --- HTTP ------------------------------------------------------------------

export async function handleClaudeAdminRequest(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (!path.startsWith("/api/admin/")) return null;

  const denied = checkAdmin(request);
  if (denied) {
    // /status responde sem token para a UI saber se o admin está configurado.
    if (request.method === "GET" && path === "/api/admin/claude/status") {
      const configured = Boolean(process.env["ADMIN_TOKEN"]?.trim());
      const anthropicConfigured = Boolean(process.env["ANTHROPIC_API_KEY"]?.trim());
      return json({
        adminConfigured: configured,
        anthropicConfigured,
        model: process.env["ANTHROPIC_MODEL"]?.trim() || DEFAULT_MODEL,
        commandsEnabled: process.env["CLAUDE_ADMIN_ALLOW_COMMANDS"]?.trim() === "1",
        authorized: false,
      });
    }
    return denied;
  }

  try {
    if (request.method === "GET" && path === "/api/admin/claude/status") {
      return json({
        adminConfigured: true,
        anthropicConfigured: Boolean(process.env["ANTHROPIC_API_KEY"]?.trim()),
        model: process.env["ANTHROPIC_MODEL"]?.trim() || DEFAULT_MODEL,
        commandsEnabled: process.env["CLAUDE_ADMIN_ALLOW_COMMANDS"]?.trim() === "1",
        authorized: true,
      });
    }
    if (request.method === "POST" && path === "/api/admin/claude/chat") {
      const payload = (await request.json()) as {
        messages?: Array<{ role: "user" | "assistant"; content: string }>;
      };
      if (!payload.messages?.length) return json({ error: "messages é obrigatório." }, 400);
      const result = await runChat(payload.messages.slice(-20));
      return json(result);
    }
    if (request.method === "GET" && path === "/api/admin/claude/files") {
      return json({ files: listFiles(url.searchParams.get("dir") ?? ".") });
    }
    if (request.method === "GET" && path === "/api/admin/claude/file") {
      return json(readFileSafe(url.searchParams.get("path") ?? ""));
    }
    if (request.method === "GET" && path === "/api/admin/claude/changes") {
      return json({ changes: listChanges() });
    }
    const changeAction =
      /^\/api\/admin\/claude\/changes\/([^/]+)\/(apply|reject|revert|run-tests)$/.exec(path);
    if (request.method === "POST" && changeAction) {
      const changeId = decodeURIComponent(changeAction[1]!);
      const action = changeAction[2]!;
      if (action === "apply") return json({ ok: true, change: applyChange(changeId) });
      if (action === "reject") return json({ ok: true, change: rejectChange(changeId) });
      if (action === "revert") return json({ ok: true, change: revertChange(changeId) });
      if (action === "run-tests") {
        const results = [] as { name: string; exitCode: number; output: string }[];
        for (const name of ["typecheck", "test"]) {
          try {
            const result = await runWhitelistedCommand(name);
            results.push({
              name,
              exitCode: result.exitCode,
              output: result.output.slice(0, 8_000),
            });
          } catch (error) {
            results.push({
              name,
              exitCode: -1,
              output: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return json({ ok: true, change: attachTests(changeId, results) ?? getChange(changeId) });
      }
    }
    return json({ error: "Endpoint do Claude Admin não encontrado." }, 404);
  } catch (error) {
    recordError({
      severity: "ERROR",
      source: "API",
      route: path,
      message: `Claude Admin: ${error instanceof Error ? error.message : String(error)}`,
      stack: error instanceof Error ? (error.stack ?? null) : null,
      context: sanitizeUnknown({ method: request.method }),
    });
    return json(
      { error: error instanceof Error ? sanitizeSecrets(error.message) : "Falha no Claude Admin." },
      500,
    );
  }
}
