/**
 * DOMÍNIO PRÓPRIO DO MEETLY (ex.: reuniao.dvdswap.com.br).
 *
 * O mesmo processo serve o analisador e o Meetly. Quando a requisição chega
 * por um dos domínios listados em MEETLY_HOSTS, o site vira "só Meetly":
 *  - `/` leva para `/meetly`;
 *  - páginas do analisador levam para `/meetly` (nada da T4 fica exposto
 *    nesse domínio);
 *  - APIs que não são do Meetly respondem 404 (só /api/meetly e /api/health);
 *  - a casca do NEXUS (barra lateral, AnalyzerProvider) não é montada.
 *
 * O Nginx precisa repassar o domínio público: `proxy_set_header Host $host;`.
 */

export function meetlyHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env["MEETLY_HOSTS"] ?? "")
    .split(",")
    .map((host) => normalizeHost(host))
    .filter(Boolean);
}

/** "Reuniao.DvdSwap.com.br:443" → "reuniao.dvdswap.com.br" */
export function normalizeHost(raw: string | null | undefined): string {
  const first = (raw ?? "").split(",")[0]!.trim().toLowerCase();
  return first.replace(/:\d+$/, "").replace(/\.$/, "");
}

/** Domínio público da requisição (X-Forwarded-Host do proxy, senão Host). */
export function requestHost(headers: Headers): string {
  return normalizeHost(headers.get("x-forwarded-host") ?? headers.get("host"));
}

export function isMeetlyHost(host: string, hosts = meetlyHosts()): boolean {
  return hosts.length > 0 && hosts.includes(normalizeHost(host));
}

function isAssetPath(path: string): boolean {
  // Arquivos do build (/assets/...), internos do Start (/_serverFn, /_build...)
  // e qualquer arquivo com extensão (robots.txt, /meetly/logo.png...).
  if (path.startsWith("/assets/") || path.startsWith("/_")) return true;
  const last = path.split("/").pop() ?? "";
  return /\.[a-z0-9]{1,8}$/i.test(last);
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}

/**
 * Filtro aplicado no começo do servidor. Devolve a resposta quando a
 * requisição não deve seguir (redirecionamento ou 404), ou null para seguir.
 */
export function meetlyHostGate(request: Request, hosts = meetlyHosts()): Response | null {
  if (!isMeetlyHost(requestHost(request.headers), hosts)) return null;
  const path = new URL(request.url).pathname;

  if (path === "/api/health" || path === "/api/meetly" || path.startsWith("/api/meetly/")) {
    return null;
  }
  if (path === "/api" || path.startsWith("/api/")) {
    return new Response(JSON.stringify({ error: "Não encontrado." }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  if (path === "/meetly" || path.startsWith("/meetly/") || isAssetPath(path)) return null;
  return redirect("/meetly");
}
