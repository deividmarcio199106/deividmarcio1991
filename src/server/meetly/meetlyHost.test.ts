import { describe, expect, it } from "vitest";

import { isMeetlyHost, meetlyHostGate, meetlyHosts, normalizeHost } from "./meetlyHost";

const HOSTS = ["reuniao.dvdswap.com.br"];

function req(path: string, host = "reuniao.dvdswap.com.br", extra: Record<string, string> = {}) {
  return new Request(`http://127.0.0.1:8081${path}`, { headers: { host, ...extra } });
}

describe("domínio próprio do Meetly", () => {
  it("lê MEETLY_HOSTS e normaliza caixa, porta e ponto final", () => {
    expect(meetlyHosts({ MEETLY_HOSTS: " Reuniao.DvdSwap.com.br , outro.com:443 " })).toEqual([
      "reuniao.dvdswap.com.br",
      "outro.com",
    ]);
    expect(meetlyHosts({})).toEqual([]);
    expect(normalizeHost("reuniao.dvdswap.com.br.:443")).toBe("reuniao.dvdswap.com.br");
    expect(isMeetlyHost("REUNIAO.dvdswap.com.br:8443", HOSTS)).toBe(true);
    expect(isMeetlyHost("dvdswap.com.br", HOSTS)).toBe(false);
    expect(isMeetlyHost("reuniao.dvdswap.com.br", [])).toBe(false);
  });

  it("fora do domínio do Meetly não interfere em nada", () => {
    expect(meetlyHostGate(req("/", "analisador.dvdswap.com.br"), HOSTS)).toBeNull();
    expect(meetlyHostGate(req("/api/trading/snapshot", "127.0.0.1:8081"), HOSTS)).toBeNull();
    expect(meetlyHostGate(req("/analisar-print"), [])).toBeNull();
  });

  it("no domínio do Meetly: raiz e páginas do analisador vão para /meetly", () => {
    for (const path of ["/", "/analisar-print", "/saude", "/dna-t4"]) {
      const res = meetlyHostGate(req(path), HOSTS)!;
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/meetly");
    }
  });

  it("no domínio do Meetly: APIs do analisador dão 404; Meetly, health e arquivos passam", async () => {
    const trading = meetlyHostGate(req("/api/trading/snapshot"), HOSTS)!;
    expect(trading.status).toBe(404);
    expect(meetlyHostGate(req("/api/claude/admin"), HOSTS)!.status).toBe(404);
    for (const path of [
      "/api/meetly/me",
      "/api/health",
      "/meetly",
      "/meetly/reuniao/abc",
      "/meetly/logo.png",
      "/assets/index-abc123.js",
      "/_serverFn/xyz",
      "/robots.txt",
    ]) {
      expect(meetlyHostGate(req(path), HOSTS)).toBeNull();
    }
  });

  it("usa o X-Forwarded-Host do proxy quando presente", () => {
    const viaProxy = req("/", "127.0.0.1:8081", { "x-forwarded-host": "reuniao.dvdswap.com.br" });
    expect(meetlyHostGate(viaProxy, HOSTS)!.status).toBe(302);
  });
});
