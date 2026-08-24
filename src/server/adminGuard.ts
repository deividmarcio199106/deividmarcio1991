/**
 * PORTÃO ADMINISTRATIVO COMPARTILHADO.
 *
 * A guarda existia dentro de `claudeAdminEndpoints` e protegia só aquelas rotas.
 * Enquanto isso, `POST /api/trading/technique-promote` — que ARQUIVA a técnica de
 * produção e coloca outra no lugar — respondia a qualquer requisição, sem token.
 * A rota que troca a técnica que decide operação real era a menos protegida do
 * servidor.
 *
 * Pior: `POST /api/trading/technique-candidates` também era aberta, e o único
 * requisito da promoção é `status === "VALIDATED"`. Bastava inserir uma candidata
 * já marcada como validada e promovê-la em seguida — dois POST sem credencial
 * nenhuma trocavam a técnica de produção.
 *
 * O portão sai daqui para ser usado pelos dois lados, com o MESMO rate-limit:
 * tentativa errada também conta, senão o brute-force do token é ilimitado.
 */

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 20;
const buckets = new Map<string, number[]>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const bucket = (buckets.get(key) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
  if (bucket.length >= RATE_MAX) {
    buckets.set(key, bucket);
    return true;
  }
  bucket.push(now);
  buckets.set(key, bucket);
  return false;
}

/**
 * Devolve `null` quando autorizado, ou a resposta de recusa.
 *
 * Sem `ADMIN_TOKEN` no ambiente a rota fica DESATIVADA — não aberta. Um token
 * ausente nunca pode significar "pode passar": é exatamente assim que uma
 * proteção some sem ninguém notar num deploy novo.
 */
export function requireAdmin(request: Request): Response | null {
  const configured = process.env["ADMIN_TOKEN"]?.trim();
  if (!configured) {
    return json(
      {
        error:
          "Rota administrativa desativada: defina ADMIN_TOKEN no ambiente do servidor para habilitá-la.",
      },
      503,
    );
  }
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
