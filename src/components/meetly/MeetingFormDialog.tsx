import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { meetlyApi, meetlyKeys } from "@/lib/meetly/api";
import { isValidDate, isValidTime, MEETLY_LIMITS, todayIso } from "@/lib/meetly/rules";
import type { MeetlyMeetingDetail, MeetlyMeetingInput } from "@/lib/meetly/types";

import { meetlyGradient } from "./MeetlyBrand";

function nextFullHour(): string {
  const hour = (new Date().getHours() + 1) % 24;
  return `${String(hour).padStart(2, "0")}:00`;
}

function emptyInput(date?: string): MeetlyMeetingInput {
  return { title: "", content: "", date: date ?? todayIso(), time: nextFullHour() };
}

type Errors = Partial<Record<keyof MeetlyMeetingInput, string>>;

function validate(input: MeetlyMeetingInput): Errors {
  const errors: Errors = {};
  if (!input.title.trim()) errors.title = "O título é obrigatório!";
  if (!input.content.trim()) errors.content = "A descrição é obrigatória!";
  if (!isValidDate(input.date)) errors.date = "Escolha a data!";
  if (!isValidTime(input.time)) errors.time = "Escolha o horário!";
  return errors;
}

/**
 * Agendar (o bottom sheet "dialog_bottom_navigation" do app) ou editar uma
 * reunião. O link da sala é gerado pelo servidor ao criar e não muda ao editar.
 */
export function MeetingFormDialog({
  open,
  onOpenChange,
  meeting,
  defaultDate,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meeting?: MeetlyMeetingDetail;
  defaultDate?: string;
  onSaved?: (meeting: MeetlyMeetingDetail) => void;
}) {
  const queryClient = useQueryClient();
  const editing = Boolean(meeting);
  const [input, setInput] = useState<MeetlyMeetingInput>(() => emptyInput(defaultDate));
  const [errors, setErrors] = useState<Errors>({});

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setInput(
      meeting
        ? { title: meeting.title, content: meeting.content, date: meeting.date, time: meeting.time }
        : emptyInput(defaultDate),
    );
  }, [open, meeting, defaultDate]);

  const save = useMutation({
    mutationFn: (value: MeetlyMeetingInput) =>
      meeting ? meetlyApi.updateMeeting(meeting.id, value) : meetlyApi.createMeeting(value),
    onSuccess: (saved) => {
      queryClient.setQueryData(meetlyKeys.meeting(saved.id), saved);
      void queryClient.invalidateQueries({ queryKey: meetlyKeys.allMeetings });
      toast.success(editing ? "Reunião atualizada!" : "Reunião agendada com sucesso!");
      onOpenChange(false);
      onSaved?.(saved);
    },
    onError: (error) => toast.error(error.message),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const found = validate(input);
    setErrors(found);
    if (Object.keys(found).length === 0) save.mutate(input);
  }

  function field<K extends keyof MeetlyMeetingInput>(key: K, value: MeetlyMeetingInput[K]) {
    setInput((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Editar reunião" : "Nova reunião"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Altere os dados. O link da sala continua o mesmo."
              : "Um link de videochamada é criado automaticamente."}
          </DialogDescription>
        </DialogHeader>
        <form id="meetly-meeting-form" onSubmit={submit} className="grid gap-4" noValidate>
          <div className="grid gap-1.5">
            <Label htmlFor="meetly-title">Título</Label>
            <Input
              id="meetly-title"
              value={input.title}
              maxLength={MEETLY_LIMITS.titleMax}
              onChange={(e) => field("title", e.target.value)}
              aria-invalid={Boolean(errors.title)}
              autoFocus
            />
            {errors.title ? <p className="text-xs text-destructive">{errors.title}</p> : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="meetly-content">Descrição</Label>
            <Textarea
              id="meetly-content"
              value={input.content}
              rows={4}
              maxLength={MEETLY_LIMITS.contentMax}
              onChange={(e) => field("content", e.target.value)}
              aria-invalid={Boolean(errors.content)}
            />
            {errors.content ? <p className="text-xs text-destructive">{errors.content}</p> : null}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="meetly-date">Data</Label>
              <Input
                id="meetly-date"
                type="date"
                value={input.date}
                onChange={(e) => field("date", e.target.value)}
                aria-invalid={Boolean(errors.date)}
                className="[color-scheme:dark]"
              />
              {errors.date ? <p className="text-xs text-destructive">{errors.date}</p> : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="meetly-time">Horário</Label>
              <Input
                id="meetly-time"
                type="time"
                value={input.time}
                onChange={(e) => field("time", e.target.value)}
                aria-invalid={Boolean(errors.time)}
                className="[color-scheme:dark]"
              />
              {errors.time ? <p className="text-xs text-destructive">{errors.time}</p> : null}
            </div>
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            type="submit"
            form="meetly-meeting-form"
            disabled={save.isPending}
            className={meetlyGradient}
          >
            {save.isPending ? "Salvando…" : editing ? "Salvar" : "Agendar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
