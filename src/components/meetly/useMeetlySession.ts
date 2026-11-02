import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useSyncExternalStore } from "react";

import { meetlyApi, MeetlyApiError, meetlyKeys } from "@/lib/meetly/api";
import type { MeetlyUser } from "@/lib/meetly/types";

/** Sessão do Meetly (GET /api/meetly/me). 401 vira `data` indefinido, sem retry. */
export function useMeetlyMe() {
  return useQuery({
    queryKey: meetlyKeys.me,
    queryFn: meetlyApi.me,
    retry: (count, error) =>
      !(error instanceof MeetlyApiError && error.status === 401) && count < 2,
    staleTime: 60_000,
  });
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof MeetlyApiError && error.status === 401;
}

/**
 * Para telas que exigem login: sem sessão, manda para /meetly/entrar
 * (o SplashActivity → LoginActivity do app original).
 */
export function useRequireMeetlyUser(): { user: MeetlyUser | null; loading: boolean } {
  const me = useMeetlyMe();
  const navigate = useNavigate();
  const unauthorized = isUnauthorized(me.error);
  useEffect(() => {
    if (unauthorized) void navigate({ to: "/meetly/entrar", replace: true });
  }, [unauthorized, navigate]);
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
