import type {
  MeetlyMeetingDetail,
  MeetlyMeetingInput,
  MeetlyMeetingSummary,
  MeetlyProfileInput,
  MeetlyUser,
} from "./types";

/** Cliente do /api/meetly usado pelas telas. */

export class MeetlyApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MeetlyApiError";
  }
}

/** Disparado quando a sessão morre no meio do uso (outra aba saiu, senha trocada...). */
export const MEETLY_UNAUTHORIZED_EVENT = "meetly:unauthorized";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/meetly${path}`, {
      method,
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        // Exigido pelo servidor em toda escrita: bloqueia CSRF.
        "x-requested-with": "meetly",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new MeetlyApiError("Sem conexão com o servidor. Verifique sua internet.", 0);
  }
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/auth/") && typeof window !== "undefined") {
      window.dispatchEvent(new Event(MEETLY_UNAUTHORIZED_EVENT));
    }
    throw new MeetlyApiError(payload.error ?? "Algo deu errado. Tente novamente.", response.status);
  }
  return payload as T;
}

export const meetlyApi = {
  me: () => request<{ user: MeetlyUser }>("GET", "/me").then((r) => r.user),
  register: (input: { name: string; email: string; password: string }) =>
    request<{ user: MeetlyUser }>("POST", "/auth/register", input).then((r) => r.user),
  login: (input: { email: string; password: string }) =>
    request<{ user: MeetlyUser }>("POST", "/auth/login", input).then((r) => r.user),
  logout: () => request<{ ok: true }>("POST", "/auth/logout"),
  updateProfile: (input: MeetlyProfileInput) =>
    request<{ user: MeetlyUser }>("PUT", "/me", input).then((r) => r.user),
  changePassword: (input: { currentPassword: string; newPassword: string }) =>
    request<{ ok: true }>("PUT", "/me/password", input),

  listMeetings: (date?: string) =>
    request<{ meetings: MeetlyMeetingSummary[] }>(
      "GET",
      date ? `/meetings?date=${encodeURIComponent(date)}` : "/meetings",
    ).then((r) => r.meetings),
  getMeeting: (id: string) =>
    request<{ meeting: MeetlyMeetingDetail }>("GET", `/meetings/${encodeURIComponent(id)}`).then(
      (r) => r.meeting,
    ),
  createMeeting: (input: MeetlyMeetingInput) =>
    request<{ meeting: MeetlyMeetingDetail }>("POST", "/meetings", input).then((r) => r.meeting),
  updateMeeting: (id: string, input: MeetlyMeetingInput) =>
    request<{ meeting: MeetlyMeetingDetail }>(
      "PUT",
      `/meetings/${encodeURIComponent(id)}`,
      input,
    ).then((r) => r.meeting),
  deleteMeeting: (id: string) =>
    request<{ ok: true }>("DELETE", `/meetings/${encodeURIComponent(id)}`),
  addParticipant: (id: string, email: string) =>
    request<{ meeting: MeetlyMeetingDetail }>(
      "POST",
      `/meetings/${encodeURIComponent(id)}/participants`,
      { email },
    ).then((r) => r.meeting),
  removeParticipant: (id: string, userId: string) =>
    request<{ meeting: MeetlyMeetingDetail | null }>(
      "DELETE",
      `/meetings/${encodeURIComponent(id)}/participants/${encodeURIComponent(userId)}`,
    ).then((r) => r.meeting),
};

export const meetlyKeys = {
  me: ["meetly", "me"] as const,
  meetings: (date?: string) => ["meetly", "meetings", date ?? "all"] as const,
  allMeetings: ["meetly", "meetings"] as const,
  meeting: (id: string) => ["meetly", "meeting", id] as const,
};
