import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

import { isMeetlyHost, requestHost } from "@/server/meetly/meetlyHost";

/**
 * O site está sendo acessado pelo domínio próprio do Meetly (MEETLY_HOSTS)?
 * Roda no servidor (no SSR, direto; no cliente, só se o root recarregar o
 * loader — o que ele não faz). A raiz usa isso para não montar a casca do
 * NEXUS nem o AnalyzerProvider nesse domínio.
 */
export const getShellMode = createServerFn({ method: "GET" }).handler(async () => {
  const headers = new Headers(getRequestHeaders() as unknown as HeadersInit);
  return { meetlyOnly: isMeetlyHost(requestHost(headers)) };
});
