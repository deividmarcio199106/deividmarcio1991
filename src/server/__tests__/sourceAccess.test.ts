import { describe, expect, it } from "vitest";

import { isAuditableFile, normalizeRequestedPath, readAuditableFile } from "../sourceAccess";

describe("allowlist de leitura de código", () => {
  it("aceita código-fonte do projeto", () => {
    expect(isAuditableFile("src/lib/t4/gates.ts").ok).toBe(true);
    expect(isAuditableFile("scripts/t4.mjs").ok).toBe(true);
  });

  it("recusa .env em qualquer profundidade", () => {
    expect(isAuditableFile("src/.env").ok).toBe(false);
    expect(isAuditableFile("src/config/.env.local").ok).toBe(false);
  });

  it("recusa chaves e credenciais", () => {
    for (const path of [
      "src/server.key",
      "src/id_rsa",
      "src/secrets.ts",
      "src/lib/credentials.ts",
      "src/lib/password.ts",
    ]) {
      expect(isAuditableFile(path).ok).toBe(false);
    }
  });

  it("recusa banco de dados e diretório de dados", () => {
    expect(isAuditableFile("data/analisador.sqlite").ok).toBe(false);
    expect(isAuditableFile("src/analisador.sqlite").ok).toBe(false);
  });

  it("recusa a configuração do atualizador, que carrega host e usuário", () => {
    expect(isAuditableFile("src/updater.config.json").ok).toBe(false);
  });

  it("recusa arquivos fora dos diretórios auditáveis", () => {
    expect(isAuditableFile("package.json").ok).toBe(false);
    expect(isAuditableFile("node_modules/react/index.js").ok).toBe(false);
  });

  it("recusa extensões não auditáveis", () => {
    expect(isAuditableFile("src/logo.png").ok).toBe(false);
  });

  it("rejeita travessia de diretório", () => {
    expect(normalizeRequestedPath("../../etc/passwd")).toBeNull();
    expect(normalizeRequestedPath("src/../../secret.ts")).toBeNull();
    expect(normalizeRequestedPath("/etc/passwd")).toBeNull();
    expect(normalizeRequestedPath("C:/Windows/System32/config")).toBeNull();
  });

  it("normaliza barras do Windows e prefixo ./", () => {
    expect(normalizeRequestedPath("./src\\lib\\utils.ts")).toBe("src/lib/utils.ts");
  });

  it("readAuditableFile recusa antes de tocar no disco", () => {
    const result = readAuditableFile("../../../etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("caminho inválido");
  });
});
