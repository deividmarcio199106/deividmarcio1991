import { describe, expect, it } from "vitest";

import { guardPath } from "./adminTools";

describe("Claude Admin — path guard (comando §18)", () => {
  it("bloqueia path traversal e diretórios do sistema", () => {
    expect(() => guardPath("../fora")).toThrow(/fora do diretório/i);
    expect(() => guardPath("../../etc/passwd")).toThrow(/fora do diretório/i);
    expect(() => guardPath("/etc/passwd")).toThrow(/fora do diretório|bloqueado/i);
  });

  it("bloqueia .env, .git, node_modules, chaves e credenciais", () => {
    expect(() => guardPath(".env")).toThrow(/bloqueado/i);
    expect(() => guardPath(".env.production")).toThrow(/bloqueado/i);
    expect(() => guardPath(".git/config")).toThrow(/bloqueado/i);
    expect(() => guardPath("node_modules/x/index.js")).toThrow(/bloqueado/i);
    expect(() => guardPath("deploy/id_rsa")).toThrow(/bloqueado/i);
    expect(() => guardPath("certs/server.key")).toThrow(/bloqueado/i);
  });

  it("permite arquivos normais do projeto", () => {
    expect(() => guardPath("src/lib/t4/progress.ts")).not.toThrow();
    expect(() => guardPath("package.json")).not.toThrow();
  });

  it("bloqueia escrita em arquivos gerenciados por ferramenta", () => {
    expect(() => guardPath("package-lock.json", { forWrite: true })).toThrow(/não editável/i);
  });
});
