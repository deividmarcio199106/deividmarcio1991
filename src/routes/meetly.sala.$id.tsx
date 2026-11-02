import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, Info } from "lucide-react";

import { useRequireMeetlyUser } from "@/components/meetly/useMeetlySession";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { meetlyApi, MeetlyApiError, meetlyKeys } from "@/lib/meetly/api";
import type { MeetlyMeetingDetail, MeetlyUser } from "@/lib/meetly/types";

export const Route = createFileRoute("/meetly/sala/$id")({
  component: MeetingRoomPage,
  head: () => ({ meta: [{ title: "Videochamada — Meetly" }] }),
});

/**
 * Parâmetros da sala no formato do Jitsi Meet (valores em JSON no fragmento
 * da URL). Repete as opções do JitsiMeetConferenceOptions do app: assunto =
 * título da reunião, nome/e-mail do usuário, áudio e vídeo começam mudos.
 */
function jitsiUrl(meeting: MeetlyMeetingDetail, user: MeetlyUser): string {
  const params: Record<string, unknown> = {
    "config.subject": meeting.title,
    "config.startWithAudioMuted": true,
    "config.startWithVideoMuted": true,
    "config.prejoinPageEnabled": true,
    "userInfo.displayName": user.displayName,
    "userInfo.email": user.email,
  };
  const hash = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(JSON.stringify(value))}`)
    .join("&");
  return `${meeting.joinUrl}#${hash}`;
}

/** JitsiMeetActivity: a videochamada embutida na página. */
function MeetingRoomPage() {
  const { id } = Route.useParams();
  const { user } = useRequireMeetlyUser();

  const meeting = useQuery({
    queryKey: meetlyKeys.meeting(id),
    queryFn: () => meetlyApi.getMeeting(id),
    enabled: Boolean(user),
    retry: (count, error) =>
      !(error instanceof MeetlyApiError && error.status === 404) && count < 2,
  });

  if (meeting.isError) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card px-6 py-12 text-center">
        <p className="font-semibold">Não foi possível abrir a sala</p>
        <p className="text-sm text-muted-foreground">{meeting.error.message}</p>
        <Button asChild variant="outline">
          <Link to="/meetly">
            <ArrowLeft /> Voltar para as reuniões
          </Link>
        </Button>
      </div>
    );
  }

  if (!user || meeting.isPending) {
    return <Skeleton className="h-[calc(100dvh-14rem)] min-h-[420px] w-full rounded-xl" />;
  }

  const url = jitsiUrl(meeting.data, user);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/meetly/reuniao/$id" params={{ id }}>
            <ArrowLeft /> Detalhes
          </Link>
        </Button>
        <h1 className="min-w-0 flex-1 truncate font-display text-lg font-semibold">
          {meeting.data.title}
        </h1>
        <Button asChild variant="outline" size="sm">
          <a href={url} target="_blank" rel="noopener noreferrer">
            <ExternalLink /> Abrir em nova aba
          </a>
        </Button>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-black">
        <iframe
          key={url}
          src={url}
          title={`Videochamada: ${meeting.data.title}`}
          allow="camera; microphone; fullscreen; display-capture; autoplay; clipboard-write"
          allowFullScreen
          className="block h-[calc(100dvh-14rem)] min-h-[420px] w-full border-0"
        />
      </div>

      {meeting.data.jitsiDomain === "meet.jit.si" ? (
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />O servidor público meet.jit.si encerra
          chamadas embutidas em outros sites após alguns minutos e pode pedir login para abrir a
          sala. Para reuniões longas, use “Abrir em nova aba” ou configure um servidor Jitsi próprio
          em MEETLY_JITSI_DOMAIN.
        </p>
      ) : null}
    </div>
  );
}
