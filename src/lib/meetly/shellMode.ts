import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

import { isMeetlyHost, requestHost } from "@/server/meetly/meetlyHost";

/** Atributo do <html> que leva a decisão do SSR para o navegador. */
export const MEETLY_SHELL_ATTR = "data-meetly-shell";

/**
 * O site está sendo acessado pelo domínio próprio do Meetly (MEETLY_HOSTS)?
 *
 * No servidor decide pelo Host da requisição. No navegador NÃO chama o
 * servidor: lê o atributo que o próprio SSR gravou no <html>. Assim o
 * domínio do Meetly pode bloquear /_serverFn inteiro (as funções de servidor
 * do analisador, como as chamadas de IA, não ficam acessíveis por ele).
 */
export const getShellMode = createIsomorphicFn()
  .server(() => {
    const headers = new Headers(getRequestHeaders() as unknown as HeadersInit);
    return { meetlyOnly: isMeetlyHost(requestHost(headers)) };
  })
  .client(() => ({
    meetlyOnly: document.documentElement.getAttribute(MEETLY_SHELL_ATTR) === "1",
  }));
