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

/**
 * Domínio público da requisição: SÓ o Host. O Nginx o define a partir do
 * server_name que atendeu (`proxy_set_header Host $host`), enquanto um
 * X-Forwarded-Host enviado pelo cliente passaria direto e desligaria o filtro.
 */
export function requestHost(headers: Headers): string {
  return normalizeHost(headers.get("host"));
}

export function isMeetlyHost(host: string, hosts = meetlyHosts()): boolean {
  return hosts.length > 0 && hosts.includes(normalizeHost(host));
}

/**
 * Formas do caminho a checar. O TanStack Start decodifica o caminho antes de
 * rotear (%5F vira _, %61 vira a), então checar só o caminho cru deixaria
 * passar /%5FserverFn/... Aqui vale o cru E o decodificado, com // e ../
 * resolvidos: se QUALQUER forma for proibida, é proibido.
 */
export function pathForms(rawPath: string): string[] {
  const forms = new Set<string>();
  const canonical = (path: string) => {
    // eslint-disable-next-line no-control-regex
    const clean = path.replace(/[\u0000-\u001f\u007f\\]/g, "/").replace(/^\/+/, "/");
    try {
      return new URL(clean, "http://meetly.local").pathname;
    } catch {
      return clean;
    }
  };
  forms.add(canonical(rawPath));
  let decoded = rawPath;
  for (let i = 0; i < 3; i++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      next = decoded.replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
        String.fromCharCode(parseInt(hex, 16)),
      );
    }
    if (next === decoded) break;
    decoded = next;
    forms.add(canonical(decoded));
  }
  return [...forms];
}

const STATIC_FILES = new Set(["/robots.txt", "/favicon.ico"]);

function isMeetlyApi(path: string): boolean {
  return path === "/api/health" || path === "/api/meetly" || path.startsWith("/api/meetly/");
}

function isForbidden(path: string): boolean {
  if (isMeetlyApi(path)) return false;
  return (
    path === "/api" ||
    path.startsWith("/api/") ||
    path === "/_serverFn" ||
    path.startsWith("/_serverFn/") ||
    path.toLowerCase().startsWith("/_serverfn")
  );
}

function isAllowedPage(path: string): boolean {
  return (
    path === "/meetly" ||
    path.startsWith("/meetly/") ||
    path.startsWith("/assets/") ||
    STATIC_FILES.has(path) ||
    isMeetlyApi(path)
  );
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
  const forms = pathForms(new URL(request.url).pathname);

  // APIs do analisador e funções de servidor (IA etc.): 404 em qualquer grafia.
  if (forms.some(isForbidden)) {
    return new Response(JSON.stringify({ error: "Não encontrado." }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  // Só segue se TODAS as formas do caminho forem do Meetly.
  if (forms.every(isAllowedPage)) return null;
  return redirect("/meetly");
}
