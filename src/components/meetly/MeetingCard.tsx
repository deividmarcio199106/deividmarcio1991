import { Link } from "@tanstack/react-router";
import { CalendarDays, Clock, LogOut, Trash2, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMeetingDate } from "@/lib/meetly/format";
import type { MeetlyMeetingSummary } from "@/lib/meetly/types";
import { cn } from "@/lib/utils";

import { ConfirmAction } from "./ConfirmAction";

/** O meeting_item do app: faixa colorida, título, data, horário e participantes. */
export function MeetingCard({
  meeting,
  past,
  onRemove,
}: {
  meeting: MeetlyMeetingSummary;
  past?: boolean;
  onRemove: (meeting: MeetlyMeetingSummary) => void;
}) {
  return (
    <article
      className={cn(
        "group relative flex overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-[#00B7FF]/60",
        past && "opacity-70",
      )}
    >
      <div className="w-1.5 shrink-0" style={{ backgroundColor: meeting.color }} aria-hidden />
      <div className="flex min-w-0 flex-1 items-start gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-base font-semibold text-foreground">
              <Link
                to="/meetly/reuniao/$id"
                params={{ id: meeting.id }}
                className="outline-none after:absolute after:inset-0 after:content-[''] focus-visible:underline"
              >
                {meeting.title}
              </Link>
            </h3>
            {meeting.isHost ? (
              <Badge variant="outline" className="border-[#00B7FF]/50 text-[#00B7FF]">
                Anfitrião
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 line-clamp-1 text-sm text-muted-foreground">{meeting.content}</p>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <CalendarDays className="h-3.5 w-3.5" />
              {formatMeetingDate(meeting.date)}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" />
              {meeting.time}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5" />
              {meeting.attendeeCount}{" "}
              {meeting.attendeeCount === 1 ? "participante" : "participantes"}
            </span>
          </div>
        </div>
        <ConfirmAction
          title={meeting.isHost ? "Excluir reunião?" : "Sair da reunião?"}
          description={
            meeting.isHost
              ? `"${meeting.title}" será excluída para todos os participantes.`
              : `Você deixará de ver "${meeting.title}".`
          }
          confirmLabel={meeting.isHost ? "Excluir" : "Sair"}
          onConfirm={() => onRemove(meeting)}
          trigger={
            <Button
              variant="ghost"
              size="icon"
              className="relative z-10 shrink-0 text-muted-foreground hover:text-destructive"
              aria-label={meeting.isHost ? "Excluir reunião" : "Sair da reunião"}
            >
              {meeting.isHost ? <Trash2 /> : <LogOut />}
            </Button>
          }
        />
      </div>
    </article>
  );
}

/** O shimmer_item_meeting: esqueleto enquanto a lista carrega. */
export function MeetingCardSkeleton() {
  return (
    <div className="flex overflow-hidden rounded-xl border border-border bg-card">
      <Skeleton className="w-1.5 rounded-none" />
      <div className="flex-1 space-y-2 p-4">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-3 w-3/4" />
        <Skeleton className="h-3 w-1/3" />
      </div>
    </div>
  );
}
