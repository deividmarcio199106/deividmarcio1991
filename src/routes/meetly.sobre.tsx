import { createFileRoute } from "@tanstack/react-router";
import { CalendarClock, ExternalLink, ShieldCheck, Users, Video } from "lucide-react";

import { MeetlyLogo } from "@/components/meetly/MeetlyBrand";

export const Route = createFileRoute("/meetly/sobre")({
  component: AboutPage,
  head: () => ({ meta: [{ title: "Sobre — Meetly" }] }),
});

const features = [
  {
    icon: CalendarClock,
    title: "Agende reuniões",
    text: "Título, descrição, data e horário. Cada reunião ganha uma sala de vídeo própria.",
  },
  {
    icon: Users,
    title: "Convide pelo e-mail",
    text: "Adicione ou remova participantes. Todos veem a reunião na própria lista.",
  },
  {
    icon: Video,
    title: "Videochamada no navegador",
    text: "Salas Jitsi Meet com tela cheia, compartilhamento de tela e chat.",
  },
  {
    icon: ShieldCheck,
    title: "Conta protegida",
    text: "Senha com hash scrypt e sessão em cookie HttpOnly; só participantes acessam a reunião.",
  },
];

/** LibraryActivity/DevsActivity: o que é o app e de onde ele veio. */
function AboutPage() {
  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-4 rounded-xl border border-border bg-card p-6 sm:flex-row sm:items-center">
        <MeetlyLogo className="h-16 w-16 rounded-2xl" />
        <div>
          <h1 className="font-display text-2xl font-bold">Sobre o Meetly</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Um app de produtividade para quem vive em reuniões: organize a agenda, crie novas
            reuniões e entre na videochamada no mesmo lugar.
          </p>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        {features.map((feature) => (
          <div key={feature.title} className="rounded-xl border border-border bg-card p-5">
            <feature.icon className="h-6 w-6 text-[#00B7FF]" />
            <h2 className="mt-3 font-semibold">{feature.title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{feature.text}</p>
          </div>
        ))}
      </section>

      <section className="rounded-xl border border-border bg-card p-6 text-sm">
        <h2 className="font-display text-lg font-semibold">Créditos</h2>
        <p className="mt-2 text-muted-foreground">
          Versão web baseada no app Android open source{" "}
          <a
            href="https://github.com/vigneshshettyin/Meetly"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[#00B7FF] hover:underline"
          >
            vigneshshettyin/Meetly <ExternalLink className="h-3 w-3" />
          </a>
          , de Vignesh Shetty e Sriganesh Rao, distribuído sob a licença MIT. Logo e paleta de cores
          vêm do projeto original.
        </p>
        <p className="mt-2 text-muted-foreground">
          Videochamadas por{" "}
          <a
            href="https://jitsi.org/jitsi-meet/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[#00B7FF] hover:underline"
          >
            Jitsi Meet <ExternalLink className="h-3 w-3" />
          </a>
          .
        </p>
      </section>
    </div>
  );
}
