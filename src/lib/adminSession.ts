/**
 * Sessão de admin do NAVEGADOR (comando §18).
 *
 * Guarda o token de admin SOMENTE em memória do módulo — nunca em
 * localStorage/sessionStorage, nunca no bundle. A chave Anthropic jamais chega
 * aqui: ela vive no .env do servidor e todas as chamadas passam pelo backend.
 */

let adminToken: string | null = null;

export function setAdminToken(token: string | null): void {
  adminToken = token?.trim() || null;
}

export function getAdminToken(): string | null {
  return adminToken;
}

export async function adminFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (adminToken) headers.set("x-admin-token", adminToken);
  return fetch(path, { ...init, headers });
}
