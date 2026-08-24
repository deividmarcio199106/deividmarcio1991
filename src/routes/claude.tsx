import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, FileCode2, FolderOpen, GitCompareArrows, Loader2, Send } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { adminFetch, setAdminToken } from "@/lib/adminSession";
import type { AdminChangeRecord } from "@/server/adminTools";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/claude")({
  component: ClaudeAdminPage,
  head: () => ({ meta: [{ title: "Claude Admin — Analisador T4" }] }),
});

interface AdminStatus {
  adminConfigured: boolean;
  anthropicConfigured: boolean;
  model: string;
  commandsEnabled: boolean;
  authorized: boolean;
}

interface ChatEntry {
  role: "user" | "assistant" | "tool";
  text?: string;
  tool?: { name: string; input: unknown; output: string; isError: boolean };
}

type Tab = "arquivos" | "chat" | "diff";

function ClaudeAdminPage() {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [tab, setTab] = useState<Tab>("chat");

  const loadStatus = useCallback(async () => {
    try {
      const response = await adminFetch("/api/admin/claude/status");
      setStatus((await response.json()) as AdminStatus);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => void loadStatus(), [loadStatus]);

  if (!status || !status.authorized) {
    return (
      <Card className="mx-auto mt-10 flex max-w-md flex-col gap-3 p-4">
        <p className="nexus-eyebrow">CLAUDE ADMIN — ÁREA PROTEGIDA</p>
        {!status?.adminConfigured ? (
          <p className="text-xs text-warn">
            Defina ADMIN_TOKEN (e ANTHROPIC_API_KEY/ANTHROPIC_MODEL) no .env da VPS para habilitar
            esta área. A chave Anthropic NUNCA vai ao navegador — todas as chamadas passam pelo
            backend.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Informe o token de admin. Ele fica somente em memória do navegador.
          </p>
        )}
        <Input
          type="password"
          value={tokenInput}
          placeholder="token de admin"
          onChange={(event) => setTokenInput(event.target.value)}
        />
        <Button
          onClick={() => {
            setAdminToken(tokenInput);
            void loadStatus();
          }}
        >
          Entrar
        </Button>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">Claude Admin</h1>
          <p className="text-xs text-muted-foreground">
            Chat com ferramentas controladas · patches com diff, testes e aprovação humana ·
            rollback com snapshot. Claude não altera gates T4 silenciosamente.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <Badge variant="outline" className="font-mono text-[10px]">
            {status.model}
          </Badge>
          <Badge
            variant="outline"
            className={cn(
              "font-mono text-[10px]",
              status.anthropicConfigured ? "border-bull text-bull" : "border-bear text-bear",
            )}
          >
            API {status.anthropicConfigured ? "OK" : "SEM CHAVE"}
          </Badge>
          <Badge variant="outline" className="font-mono text-[10px]">
            COMANDOS {status.commandsEnabled ? "ON" : "OFF"}
          </Badge>
        </div>
      </header>

      <div className="flex gap-1.5">
        <TabButton icon={FolderOpen} active={tab === "arquivos"} onClick={() => setTab("arquivos")}>
          ARQUIVOS
        </TabButton>
        <TabButton icon={Bot} active={tab === "chat"} onClick={() => setTab("chat")}>
          CHAT CLAUDE
        </TabButton>
        <TabButton icon={GitCompareArrows} active={tab === "diff"} onClick={() => setTab("diff")}>
          DIFF
        </TabButton>
      </div>

      {tab === "arquivos" && <FilesTab />}
      {tab === "chat" && <ChatTab onChangesProposed={() => setTab("diff")} />}
      {tab === "diff" && <DiffTab />}
    </div>
  );
}

function TabButton({
  icon: Icon,
  active,
  onClick,
  children,
}: {
  icon: typeof Bot;
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <Button
      size="sm"
      variant={active ? "default" : "outline"}
      className="font-mono text-[11px]"
      onClick={onClick}
    >
      <Icon className="mr-1.5 h-3.5 w-3.5" />
      {children}
    </Button>
  );
}

// ---------------------------------------------------------------------------

function FilesTab() {
  const [dir, setDir] = useState(".");
  const [entries, setEntries] = useState<
    Array<{ path: string; type: "file" | "dir"; size: number }>
  >([]);
  const [file, setFile] = useState<{ path: string; content: string; truncated: boolean } | null>(
    null,
  );

  const loadDir = useCallback(async (target: string) => {
    const response = await adminFetch(`/api/admin/claude/files?dir=${encodeURIComponent(target)}`);
    const payload = (await response.json()) as { files?: typeof entries; error?: string };
    if (payload.error) {
      toast.error(payload.error);
      return;
    }
    setDir(target);
    setEntries(payload.files ?? []);
  }, []);

  useEffect(() => void loadDir("."), [loadDir]);

  const openFile = async (path: string) => {
    const response = await adminFetch(`/api/admin/claude/file?path=${encodeURIComponent(path)}`);
    const payload = (await response.json()) as {
      path: string;
      content: string;
      truncated: boolean;
      error?: string;
    };
    if (payload.error) {
      toast.error(payload.error);
      return;
    }
    setFile(payload);
  };

  return (
    <div className="grid gap-3 lg:grid-cols-[320px_minmax(0,1fr)]">
      <Card className="flex max-h-[70vh] flex-col gap-1 overflow-auto p-3">
        <div className="flex items-center gap-2">
          <p className="nexus-eyebrow">{dir === "." ? "raiz do projeto" : dir}</p>
          {dir !== "." && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-6 px-2 text-[10px]"
              onClick={() => void loadDir(dir.split("/").slice(0, -1).join("/") || ".")}
            >
              ↑ subir
            </Button>
          )}
        </div>
        {entries.map((entry) => (
          <button
            key={entry.path}
            className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-left font-mono text-[11px] hover:bg-accent"
            onClick={() =>
              entry.type === "dir" ? void loadDir(entry.path) : void openFile(entry.path)
            }
          >
            {entry.type === "dir" ? (
              <FolderOpen className="h-3 w-3 shrink-0 text-primary" />
            ) : (
              <FileCode2 className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">{entry.path.split("/").pop()}</span>
            {entry.type === "file" && (
              <span className="ml-auto shrink-0 text-[9px] text-muted-foreground">
                {(entry.size / 1024).toFixed(1)}K
              </span>
            )}
          </button>
        ))}
      </Card>
      <Card className="max-h-[70vh] overflow-auto p-3">
        {file ? (
          <>
            <p className="nexus-eyebrow mb-2">
              {file.path}
              {file.truncated && " (truncado em 512KB)"}
            </p>
            <pre className="whitespace-pre-wrap font-mono text-[11px] leading-snug">
              {file.content}
            </pre>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">Selecione um arquivo para visualizar.</p>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ChatTab({ onChangesProposed }: { onChangesProposed: () => void }) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const prefill = window.sessionStorage.getItem("claude.prefill");
    if (prefill) {
      window.sessionStorage.removeItem("claude.prefill");
      setInput(prefill);
    }
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [entries, busy]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    const nextEntries: ChatEntry[] = [...entries, { role: "user", text }];
    setEntries(nextEntries);
    try {
      const history = nextEntries
        .filter((entry) => entry.role !== "tool" && entry.text)
        .map((entry) => ({ role: entry.role as "user" | "assistant", content: entry.text! }));
      const response = await adminFetch("/api/admin/claude/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: history }),
      });
      const payload = (await response.json()) as {
        turns?: ChatEntry[];
        changes?: string[];
        error?: string;
      };
      if (payload.error) {
        setEntries((previous) => [...previous, { role: "assistant", text: `⚠ ${payload.error}` }]);
      } else {
        setEntries((previous) => [...previous, ...(payload.turns ?? [])]);
        if (payload.changes?.length) {
          toast.success(
            `${payload.changes.length} proposta(s) de alteração registrada(s) — veja a aba DIFF.`,
          );
          onChangesProposed();
        }
      }
    } catch (error) {
      setEntries((previous) => [
        ...previous,
        {
          role: "assistant",
          text: `⚠ Falha na chamada: ${error instanceof Error ? error.message : String(error)}`,
        },
      ]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="flex h-[70vh] flex-col gap-2 p-3">
      <div ref={scrollRef} className="flex-1 space-y-2 overflow-auto pr-1">
        {entries.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Peça: “corrija esse erro”, “abra esse arquivo”, “o Profit está detectado mas a T4 parou
            em 40%, descubra e corrija”, “rode testes”… O Claude investiga com ferramentas
            controladas e propostas de patch aparecem na aba DIFF para você aprovar.
          </p>
        )}
        {entries.map((entry, index) => (
          <div key={index}>
            {entry.role === "tool" && entry.tool ? (
              <div className="rounded border border-border/50 bg-background/60 p-2 font-mono text-[10px]">
                <span
                  className={cn("font-bold", entry.tool.isError ? "text-bear" : "text-primary")}
                >
                  ⚙ {entry.tool.name}
                </span>{" "}
                <span className="text-muted-foreground">{JSON.stringify(entry.tool.input)}</span>
                <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-muted-foreground">
                  {entry.tool.output}
                </pre>
              </div>
            ) : (
              <div
                className={cn(
                  "whitespace-pre-wrap rounded-md p-2 text-xs leading-relaxed",
                  entry.role === "user" ? "ml-8 bg-primary/10" : "mr-8 bg-panel",
                )}
              >
                {entry.text}
              </div>
            )}
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Claude investigando com ferramentas internas…
          </div>
        )}
      </div>
      <div className="flex gap-2">
        <Textarea
          value={input}
          rows={3}
          placeholder="Escreva para o Claude…"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send();
          }}
        />
        <Button disabled={busy || !input.trim()} onClick={() => void send()}>
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function DiffTab() {
  const [changes, setChanges] = useState<AdminChangeRecord[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await adminFetch("/api/admin/claude/changes");
    const payload = (await response.json()) as { changes?: AdminChangeRecord[] };
    setChanges(payload.changes ?? []);
  }, []);

  useEffect(() => void load(), [load]);

  const act = async (changeId: string, action: "apply" | "reject" | "revert" | "run-tests") => {
    setBusy(`${changeId}:${action}`);
    try {
      const response = await adminFetch(
        `/api/admin/claude/changes/${encodeURIComponent(changeId)}/${action}`,
        {
          method: "POST",
        },
      );
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (payload.error) toast.error(payload.error);
      else
        toast.success(
          `Alteração ${action === "apply" ? "aplicada (com snapshot)" : action === "revert" ? "revertida" : action === "reject" ? "rejeitada" : "testada"}.`,
        );
      await load();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {changes.length === 0 && (
        <Card className="p-3 text-xs text-muted-foreground">
          Nenhuma alteração proposta ainda. Propostas do chat aparecem aqui com diff, testes e os
          botões APLICAR / REJEITAR / REVERTER.
        </Card>
      )}
      {changes.map((change) => (
        <Card key={change.changeId} className="flex flex-col gap-2 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className={cn(
                "font-mono text-[10px]",
                change.status === "PROPOSED" && "border-warn text-warn",
                change.status === "APPLIED" && "border-bull text-bull",
                change.status === "REVERTED" && "border-bear text-bear",
              )}
            >
              {change.status}
            </Badge>
            <span className="font-mono text-[10px] text-muted-foreground">{change.changeId}</span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {new Date(change.createdAt).toLocaleString("pt-BR")}
            </span>
            <div className="ml-auto flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[10px]"
                onClick={() => setExpanded(expanded === change.changeId ? null : change.changeId)}
              >
                DIFF
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[10px]"
                disabled={busy !== null}
                onClick={() => void act(change.changeId, "run-tests")}
              >
                RODAR TESTES
              </Button>
              {change.status === "PROPOSED" && (
                <>
                  <Button
                    size="sm"
                    className="h-6 px-2 text-[10px]"
                    disabled={busy !== null}
                    onClick={() => void act(change.changeId, "apply")}
                  >
                    APLICAR
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[10px]"
                    disabled={busy !== null}
                    onClick={() => void act(change.changeId, "reject")}
                  >
                    REJEITAR
                  </Button>
                </>
              )}
              {change.status === "APPLIED" && (
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-6 px-2 text-[10px]"
                  disabled={busy !== null}
                  onClick={() => void act(change.changeId, "revert")}
                >
                  REVERTER
                </Button>
              )}
            </div>
          </div>
          <p className="text-xs">{change.description}</p>
          <div className="flex flex-wrap gap-2 font-mono text-[10px] text-muted-foreground">
            {change.files.map((file) => (
              <span key={file.path}>
                {file.path} <span className="text-bull">+{file.addedLines}</span>{" "}
                <span className="text-bear">−{file.removedLines}</span>
              </span>
            ))}
          </div>
          {change.tests && (
            <div className="rounded border border-border/50 bg-background/60 p-2 font-mono text-[10px]">
              {change.tests.map((test) => (
                <p key={test.name} className={test.exitCode === 0 ? "text-bull" : "text-bear"}>
                  {test.name}: exit {test.exitCode}
                </p>
              ))}
            </div>
          )}
          {expanded === change.changeId &&
            change.files.map((file) => (
              <div key={file.path} className="grid gap-2 lg:grid-cols-2">
                <div>
                  <p className="nexus-eyebrow">ANTES — {file.path}</p>
                  <pre className="max-h-80 overflow-auto rounded bg-background/70 p-2 font-mono text-[10px] leading-snug">
                    {file.before || "(arquivo novo)"}
                  </pre>
                </div>
                <div>
                  <p className="nexus-eyebrow">DEPOIS — {file.path}</p>
                  <pre className="max-h-80 overflow-auto rounded bg-background/70 p-2 font-mono text-[10px] leading-snug">
                    {file.after}
                  </pre>
                </div>
              </div>
            ))}
        </Card>
      ))}
    </div>
  );
}
