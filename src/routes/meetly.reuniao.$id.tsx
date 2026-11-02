import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  CalendarDays,
  Clock,
  Copy,
  Crown,
  LogOut,
  Pencil,
  Share2,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  Video,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { ConfirmAction } from "@/components/meetly/ConfirmAction";
import { MeetingFormDialog } from "@/components/meetly/MeetingFormDialog";
import { MeetlyAvatar } from "@/components/meetly/MeetlyAvatar";
import { meetlyGradient } from "@/components/meetly/MeetlyBrand";
import { useRequireMeetlyUser } from "@/components/meetly/useMeetlySession";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { meetlyApi, MeetlyApiError, meetlyKeys } from "@/lib/meetly/api";
import { formatMeetingDate } from "@/lib/meetly/format";
import { isValidEmail, normalizeEmail } from "@/lib/meetly/rules";
import type { MeetlyMeetingDetail, MeetlyParticipant } from "@/lib/meetly/types";

export const Route = createFileRoute("/meetly/reuniao/$id")({
  component: MeetingDetailPage,
  head: () => ({ meta: [{ title: "Reunião — Meetly" }] }),
});

/** MeetingViewDetail: dados da reunião, anfitrião, participantes e "Entrar na reunião". */
function MeetingDetailPage() {
  const { id } = Route.useParams();
  const { user } = useRequireMeetlyUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);

  const meeting = useQuery({
    queryKey: meetlyKeys.meeting(id),
    queryFn: () => meetlyApi.getMeeting(id),
    enabled: Boolean(user),
    refetchInterval: 15_000,
    retry: (count, error) =>
      !(error instanceof MeetlyApiError && error.status === 404) && count < 2,
  });

  const afterChange = (updated: MeetlyMeetingDetail | null) => {
    if (updated) queryClient.setQueryData(meetlyKeys.meeting(id), updated);
    void queryClient.invalidateQueries({ queryKey: meetlyKeys.allMeetings });
  };

  const removeMeeting = useMutation({
    mutationFn: () => meetlyApi.deleteMeeting(id),
    onSuccess: () => {
      toast.success("Reunião excluída.");
      queryClient.removeQueries({ queryKey: meetlyKeys.meeting(id) });
      afterChange(null);
      void navigate({ to: "/meetly" });
    },
    onError: (error) => toast.error(error.message),
  });

  const leave = useMutation({
    mutationFn: () => meetlyApi.removeParticipant(id, user!.id),
    onSuccess: () => {
      toast.success("Você saiu da reunião.");
      queryClient.removeQueries({ queryKey: meetlyKeys.meeting(id) });
      afterChange(null);
      void navigate({ to: "/meetly" });
    },
    onError: (error) => toast.error(error.message),
  });

  if (meeting.isError) {
    const notFound = meeting.error instanceof MeetlyApiError && meeting.error.status === 404;
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card px-6 py-12 text-center">
        <p className="font-semibold">
          {notFound ? "Reunião não encontrada" : "Não foi possível carregar a reunião"}
        </p>
        <p className="text-sm text-muted-foreground">
          {notFound
            ? "Ela pode ter sido excluída, ou você não participa dela."
            : meeting.error.message}
        </p>
        <Button asChild variant="outline">
          <Link to="/meetly">
            <ArrowLeft /> Voltar para as reuniões
          </Link>
        </Button>
      </div>
    );
  }

  if (!user || meeting.isPending) return <DetailSkeleton />;

  const data = meeting.data;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(data.joinUrl);
      toast.success("Link copiado!");
    } catch {
      toast.error("Não foi possível copiar. Link: " + data.joinUrl);
    }
  }

  async function share() {
    const text = `${data.title} — ${formatMeetingDate(data.date)} às ${data.time}`;
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: data.title, text, url: data.joinUrl });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    await copyLink();
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/meetly">
            <ArrowLeft /> Reuniões
          </Link>
        </Button>
      </div>

      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="h-2" style={{ backgroundColor: data.color }} aria-hidden />
        <div className="flex flex-col gap-5 p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h1 className="font-display text-2xl font-bold break-words">{data.title}</h1>
              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <CalendarDays className="h-4 w-4" /> {formatMeetingDate(data.date)}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Clock className="h-4 w-4" /> {data.time}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Users className="h-4 w-4" /> {data.attendeeCount}{" "}
                  {data.attendeeCount === 1 ? "participante" : "participantes"}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Crown className="h-4 w-4" /> Anfitrião: {data.isHost ? "você" : data.hostName}
                </span>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              {data.isHost ? (
                <>
                  <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                    <Pencil /> Editar
                  </Button>
                  <ConfirmAction
                    title="Excluir reunião?"
                    description="A reunião será excluída para todos os participantes."
                    confirmLabel="Excluir"
                    onConfirm={() => removeMeeting.mutate()}
                    trigger={
                      <Button variant="outline" size="sm" className="text-destructive">
                        <Trash2 /> Excluir
                      </Button>
                    }
                  />
                </>
              ) : (
                <ConfirmAction
                  title="Sair da reunião?"
                  description="Você deixará de ver esta reunião. O anfitrião pode convidar você de novo."
                  confirmLabel="Sair"
                  onConfirm={() => leave.mutate()}
                  trigger={
                    <Button variant="outline" size="sm" className="text-destructive">
                      <LogOut /> Sair da reunião
                    </Button>
                  }
                />
              )}
            </div>
          </div>

          <div>
            <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Descrição
            </h2>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed">
              {data.content}
            </p>
          </div>

          <div className="flex flex-col gap-3 rounded-lg border border-[#00B7FF]/30 bg-[#00B7FF]/5 p-4 md:flex-row md:items-center">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#00B7FF]">
                Sala de vídeo
              </p>
              <p className="truncate font-mono text-sm" title={data.joinUrl}>
                {data.joinUrl}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => void copyLink()}>
                <Copy /> Copiar link
              </Button>
              <Button variant="outline" size="sm" onClick={() => void share()}>
                <Share2 /> Compartilhar
              </Button>
              <Button asChild size="sm" className={meetlyGradient}>
                <Link to="/meetly/sala/$id" params={{ id: data.id }}>
                  <Video /> Entrar na reunião
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      <Participants meeting={data} currentUserId={user.id} onChange={afterChange} />

      <MeetingFormDialog
        open={editing}
        onOpenChange={setEditing}
        meeting={data}
        onSaved={(saved) => afterChange(saved)}
      />
    </div>
  );
}

function Participants({
  meeting,
  currentUserId,
  onChange,
}: {
  meeting: MeetlyMeetingDetail;
  currentUserId: string;
  onChange: (meeting: MeetlyMeetingDetail | null) => void;
}) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string>();

  const add = useMutation({
    mutationFn: (value: string) => meetlyApi.addParticipant(meeting.id, value),
    onSuccess: (updated) => {
      toast.success("Participante adicionado!");
      setEmail("");
      onChange(updated);
    },
    onError: (err) => setError(err.message),
  });

  const remove = useMutation({
    mutationFn: (participant: MeetlyParticipant) =>
      meetlyApi.removeParticipant(meeting.id, participant.id),
    onSuccess: (updated, participant) => {
      toast.success(`${participant.displayName} foi removido(a).`);
      onChange(updated);
    },
    onError: (err) => toast.error(err.message),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = normalizeEmail(email);
    if (!isValidEmail(value)) {
      setError("Informe um e-mail válido!");
      return;
    }
    if (meeting.participants.some((p) => p.email === value)) {
      setError("Usuário já participa!");
      return;
    }
    setError(undefined);
    add.mutate(value);
  }

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-display text-lg font-semibold">Participantes</h2>
        <Badge variant="secondary">{meeting.attendeeCount}</Badge>
      </div>

      <form onSubmit={submit} className="mt-4 flex flex-col gap-2 sm:flex-row" noValidate>
        <div className="flex-1">
          <Input
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setError(undefined);
            }}
            placeholder="email@exemplo.com"
            aria-label="E-mail do participante"
            aria-invalid={Boolean(error)}
          />
        </div>
        <Button type="submit" variant="outline" disabled={add.isPending}>
          <UserPlus /> {add.isPending ? "Adicionando…" : "Adicionar"}
        </Button>
      </form>
      {error ? (
        <p className="mt-1.5 text-xs text-destructive">{error}</p>
      ) : (
        <p className="mt-1.5 text-xs text-muted-foreground">
          A pessoa precisa ter uma conta no Meetly.
        </p>
      )}

      <ul className="mt-4 divide-y divide-border">
        {meeting.participants.map((participant) => {
          const isMe = participant.id === currentUserId;
          const canRemove = meeting.isHost && !participant.isHost;
          return (
            <li key={participant.id} className="flex items-center gap-3 py-3">
              <MeetlyAvatar
                name={participant.displayName}
                seed={participant.id}
                imageUrl={participant.imageUrl}
              />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 truncate text-sm font-medium">
                  <span className="truncate">{participant.displayName}</span>
                  {isMe ? <span className="text-xs text-muted-foreground">(você)</span> : null}
                  {participant.isHost ? (
                    <Badge variant="outline" className="border-[#00B7FF]/50 text-[#00B7FF]">
                      Anfitrião
                    </Badge>
                  ) : null}
                </p>
                <p className="truncate text-xs text-muted-foreground">{participant.email}</p>
              </div>
              {canRemove ? (
                <ConfirmAction
                  title="Remover participante?"
                  description={`${participant.displayName} deixará de ver esta reunião.`}
                  confirmLabel="Remover"
                  onConfirm={() => remove.mutate(participant)}
                  trigger={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={`Remover ${participant.displayName}`}
                    >
                      <UserMinus />
                    </Button>
                  }
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-8 w-28" />
      <div className="space-y-4 rounded-xl border border-border bg-card p-5">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
      <div className="space-y-3 rounded-xl border border-border bg-card p-5">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    </div>
  );
}
