import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { CalendarCheck, CalendarX2, Plus, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { MeetingCard, MeetingCardSkeleton } from "@/components/meetly/MeetingCard";
import { MeetingFormDialog } from "@/components/meetly/MeetingFormDialog";
import { meetlyGradient } from "@/components/meetly/MeetlyBrand";
import { useRequireMeetlyUser } from "@/components/meetly/useMeetlySession";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { meetlyApi, meetlyKeys } from "@/lib/meetly/api";
import { formatMeetingDate, meetingStart } from "@/lib/meetly/format";
import { isValidDate, todayIso } from "@/lib/meetly/rules";
import type { MeetlyMeetingSummary } from "@/lib/meetly/types";

type MeetlySearch = { data?: string };

export const Route = createFileRoute("/meetly/")({
  validateSearch: (search: Record<string, unknown>): MeetlySearch => {
    const data = typeof search.data === "string" && isValidDate(search.data) ? search.data : "";
    return data ? { data } : {};
  },
  component: MeetingsPage,
  head: () => ({ meta: [{ title: "Minhas reuniões — Meetly" }] }),
});

/**
 * MainActivity + MeetingFilter: lista das reuniões em que participo, busca por
 * título, filtro por dia ("Reuniões de hoje" / calendário) e "Nova reunião".
 */
function MeetingsPage() {
  const { user } = useRequireMeetlyUser();
  const { data: dateFilter } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);

  const meetings = useQuery({
    queryKey: meetlyKeys.meetings(dateFilter),
    queryFn: () => meetlyApi.listMeetings(dateFilter),
    enabled: Boolean(user),
    // O snapshot listener do Firestore no app: aqui, atualização periódica.
    refetchInterval: 15_000,
  });

  const remove = useMutation({
    mutationFn: async (meeting: MeetlyMeetingSummary) => {
      if (meeting.isHost) await meetlyApi.deleteMeeting(meeting.id);
      else await meetlyApi.removeParticipant(meeting.id, user!.id);
    },
    onSuccess: (_result, meeting) => {
      toast.success(meeting.isHost ? "Reunião excluída." : "Você saiu da reunião.");
      queryClient.removeQueries({ queryKey: meetlyKeys.meeting(meeting.id) });
      void queryClient.invalidateQueries({ queryKey: meetlyKeys.allMeetings });
    },
    onError: (error) => toast.error(error.message),
  });

  const { upcoming, past } = useMemo(() => {
    const term = query.trim().toLocaleLowerCase("pt-BR");
    const list = (meetings.data ?? []).filter(
      (m) => !term || m.title.toLocaleLowerCase("pt-BR").includes(term),
    );
    // Uma reunião continua em "Próximas" até 1 h depois do início.
    const cutoff = Date.now() - 60 * 60 * 1000;
    return {
      upcoming: list.filter((m) => meetingStart(m.date, m.time) >= cutoff),
      past: list.filter((m) => meetingStart(m.date, m.time) < cutoff).reverse(),
    };
  }, [meetings.data, query]);

  const setDate = (data?: string) => void navigate({ search: data ? { data } : {} });
  const today = todayIso();
  const total = (meetings.data ?? []).length;
  const loading = !user || meetings.isPending;

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold">
            {dateFilter === today ? "Reuniões de hoje" : "Minhas reuniões"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {dateFilter
              ? `Mostrando ${formatMeetingDate(dateFilter)}`
              : "Tudo o que você agendou ou para o que foi convidado."}
          </p>
        </div>
        <Button className={meetlyGradient} onClick={() => setCreating(true)} disabled={!user}>
          <Plus /> Nova reunião
        </Button>
      </section>

      <section className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3 md:flex-row md:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar pelo título…"
            aria-label="Buscar reunião pelo título"
            className="pl-8"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="date"
            value={dateFilter ?? ""}
            onChange={(e) => setDate(isValidDate(e.target.value) ? e.target.value : undefined)}
            aria-label="Filtrar por data"
            className="w-auto [color-scheme:dark]"
          />
          <Button
            variant={dateFilter === today ? "secondary" : "outline"}
            onClick={() => setDate(today)}
          >
            <CalendarCheck /> Hoje
          </Button>
          {dateFilter ? (
            <Button variant="ghost" onClick={() => setDate(undefined)}>
              <X /> Limpar filtro
            </Button>
          ) : null}
        </div>
      </section>

      {meetings.isError ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          {meetings.error.message}{" "}
          <button className="underline" onClick={() => void meetings.refetch()}>
            Tentar de novo
          </button>
        </div>
      ) : loading ? (
        <div className="grid gap-3">
          <MeetingCardSkeleton />
          <MeetingCardSkeleton />
          <MeetingCardSkeleton />
        </div>
      ) : upcoming.length === 0 && past.length === 0 ? (
        <EmptyState
          filtered={Boolean(query.trim()) || Boolean(dateFilter)}
          hasAny={total > 0}
          onCreate={() => setCreating(true)}
        />
      ) : (
        <>
          <MeetingSection title="Próximas" meetings={upcoming} onRemove={(m) => remove.mutate(m)} />
          <MeetingSection
            title="Já realizadas"
            meetings={past}
            past
            onRemove={(m) => remove.mutate(m)}
          />
        </>
      )}

      <MeetingFormDialog
        open={creating}
        onOpenChange={setCreating}
        defaultDate={dateFilter && dateFilter >= today ? dateFilter : undefined}
      />
    </div>
  );
}

function MeetingSection({
  title,
  meetings,
  past,
  onRemove,
}: {
  title: string;
  meetings: MeetlyMeetingSummary[];
  past?: boolean;
  onRemove: (meeting: MeetlyMeetingSummary) => void;
}) {
  if (meetings.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {title} · {meetings.length}
      </h2>
      <div className="grid gap-3">
        {meetings.map((meeting) => (
          <MeetingCard key={meeting.id} meeting={meeting} past={past} onRemove={onRemove} />
        ))}
      </div>
    </section>
  );
}

function EmptyState({
  filtered,
  hasAny,
  onCreate,
}: {
  filtered: boolean;
  hasAny: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card/50 px-6 py-12 text-center">
      <CalendarX2 className="h-10 w-10 text-[#00B7FF]" />
      <div>
        <p className="font-semibold">
          {filtered && hasAny ? "Nenhuma reunião encontrada" : "Nenhuma reunião por aqui"}
        </p>
        <p className="text-sm text-muted-foreground">
          {filtered
            ? "Tente outro título ou outra data."
            : "Agende a primeira e convide as pessoas pelo e-mail."}
        </p>
      </div>
      {!filtered ? (
        <Button className={meetlyGradient} onClick={onCreate}>
          <Plus /> Agendar reunião
        </Button>
      ) : null}
    </div>
  );
}
