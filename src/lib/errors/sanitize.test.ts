import { describe, expect, it } from "vitest";

import { sanitizeSecrets, sanitizeUnknown } from "./sanitize";

describe("sanitização de segredos (comando §3/§18)", () => {
  it("redige chaves de API e bearer tokens", () => {
    const input = "erro chamando sk-ant-abc123def456ghi com Bearer eyJhbGciOiJIUzI1NiJ9.abc.def";
    const output = sanitizeSecrets(input);
    expect(output).not.toContain("sk-ant-abc123def456ghi");
    expect(output).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(output).toContain("[REDACTED_KEY]");
  });

  it("redige headers de autorização e cookies", () => {
    const output = sanitizeSecrets("authorization: Basic dXNlcjpwYXNz\ncookie: session=abc123def");
    expect(output).not.toContain("dXNlcjpwYXNz");
    expect(output).not.toContain("abc123def");
  });

  it("redige campos password/token/apiKey em JSON e query string", () => {
    const output = sanitizeSecrets(
      '{"password":"hunter2","api_key":"xyz987654"} e ?token=abc123&x=1',
    );
    expect(output).not.toContain("hunter2");
    expect(output).not.toContain("xyz987654");
    expect(output).not.toContain("token=abc123");
  });

  it("redige linhas de .env sensíveis", () => {
    const output = sanitizeSecrets("ANTHROPIC_API_KEY=sk-live-9999\nPORT=8081");
    expect(output).toContain("ANTHROPIC_API_KEY=[REDACTED]");
    expect(output).toContain("PORT=8081");
  });

  it("sanitizeUnknown serializa objetos com redação e corta tamanho", () => {
    const output = sanitizeUnknown({ secret: "abc", password: "hunter2" }, 200);
    expect(output).not.toContain("hunter2");
    expect(output.length).toBeLessThanOrEqual(200);
  });
});
