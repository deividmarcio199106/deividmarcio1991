import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useSyncExternalStore } from "react";

import { meetlyApi, MeetlyApiError, meetlyKeys, MEETLY_UNAUTHORIZED_EVENT } from "@/lib/meetly/api";
import type { MeetlyUser } from "@/lib/meetly/types";

export function isUnauthorized(error: unknown): boolean {
  return error instanceof MeetlyApiError && error.status === 401;
}

/**
 * Sessão do Meetly (GET /api/meetly/me). "Sem login" é um VALOR (null), não um
 * erro: o React Query guarda o último `data` quando um refetch falha, e com o
 * 401 como erro a tela continuava mostrando o usuário anterior — e as telas de
 * login e de lista se redirecionavam uma para a outra sem parar.
 */
export function useMeetlyMe() {
  return useQuery({
    queryKey: meetlyKeys.me,
    queryFn: async (): Promise<MeetlyUser | null> => {
      try {
        return await meetlyApi.me();
      } catch (error) {
        if (isUnauthorized(error)) return null;
        throw error;
      }
    },
    retry: (count) => count < 2,
    staleTime: 60_000,
  });
}

/** Apaga tudo do Meetly em cache e marca "sem sessão". */
export function clearMeetlyCache(queryClient: QueryClient): void {
  queryClient.removeQueries({
    queryKey: ["meetly"],
    predicate: (query) => query.queryKey[1] !== "me",
  });
  queryClient.setQueryData(meetlyKeys.me, null);
}

/** Qualquer 401 vindo da API derruba o cache (ver MEETLY_UNAUTHORIZED_EVENT). */
export function useMeetlySessionGuard(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const onUnauthorized = () => clearMeetlyCache(queryClient);
    window.addEventListener(MEETLY_UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(MEETLY_UNAUTHORIZED_EVENT, onUnauthorized);
  }, [queryClient]);
}

/**
 * Para telas que exigem login: sem sessão, manda para /meetly/entrar
 * (o SplashActivity → LoginActivity do app original).
 */
export function useRequireMeetlyUser(): { user: MeetlyUser | null; loading: boolean } {
  const me = useMeetlyMe();
  const navigate = useNavigate();
  const loggedOut = me.data === null;
  useEffect(() => {
    if (loggedOut) void navigate({ to: "/meetly/entrar", replace: true });
  }, [loggedOut, navigate]);
  return { user: me.data ?? null, loading: me.isPending };
}

function subscribeOnline(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

/** Equivalente web do NoInternet do app: avisa quando a conexão cai. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}
